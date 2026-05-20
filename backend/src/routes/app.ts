import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { ArtifactType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import redis from '../lib/redis';
import { requireAppParent, signAppParentToken, type AppParentTokenPayload } from '../lib/app-auth';
import { recognizeMaterial } from '../lib/ai-recognition';
import { generateProfessionalMedia, type MediaKind } from '../lib/media-generation';
import { extractTextFromMaterial } from '../lib/text-extractor';
import { synthesizeEdgeTts } from '../lib/edge-tts';

// —— 短信验证码登录配置 ——
const SMS_CODE_TTL_SEC = 5 * 60;
const SMS_RESEND_COOLDOWN_SEC = 60;
const SMS_PROVIDER = String(process.env.APP_SMS_PROVIDER || '').trim().toLowerCase();
const SMS_DEMO_MODE = SMS_PROVIDER === '' || SMS_PROVIDER === 'demo';

function generateSmsCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsViaProvider(_phone: string, _code: string): Promise<{ ok: boolean; reason?: string }> {
  // 留给后续接入：阿里云/腾讯云/Twilio 等。当前只支持 demo 模式。
  if (SMS_DEMO_MODE) return { ok: true };
  return { ok: false, reason: 'sms_provider_not_implemented' };
}

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试' },
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试次数过多，请 10 分钟后再试' },
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// TTS 走免费的 Edge TTS，限频比 writeLimiter 更紧，避免被微软封我们的 IP
const ttsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'tts_rate_limited' },
});

// 长文本朗读：单次请求可能内部分多段调用 Edge TTS，限频放宽，避免连读长篇时触发
const ttsLongLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'tts_rate_limited' },
});

function getParent(req: Request): AppParentTokenPayload | null {
  return (req as Request & { appParent?: AppParentTokenPayload }).appParent || null;
}

function normalizeCategory(input?: string): string | null {
  const value = input?.trim();
  if (!value) return null;
  const aliases: Record<string, string> = {
    literacy: '语文',
    math: '数学',
    english: '英语',
    social: '社会科学',
    expression: '语文',
    habit: '社会科学',
  };
  return aliases[value] || value;
}

const APP_TASK_CATEGORIES = ['语文', '数学', '英语', '社会科学'] as const;
const APP_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'app-library');
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_POLICY_MESSAGE = '密码至少 8 位，且需同时包含字母和数字';
const PHONE_POLICY_MESSAGE = '手机号格式不正确，请输入 11 位手机号';
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function isStrongPassword(value: string): boolean {
  const hasLetter = /[a-zA-Z]/.test(value);
  const hasNumber = /\d/.test(value);
  return value.length >= PASSWORD_MIN_LENGTH && hasLetter && hasNumber;
}

function isValidPhone(value?: string | null): boolean {
  if (!value) return false;
  return /^1\d{10}$/.test(value.trim());
}

function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function createResetToken() {
  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
  return {
    token,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  };
}

function fixUploadFilename(name: string): string {
  if (!name) return name;
  try {
    const latinBuf = Buffer.from(name, 'latin1');
    const decoded = latinBuf.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(latinBuf)) {
      return decoded;
    }
  } catch {}
  return name;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(APP_UPLOAD_DIR, { recursive: true });
      cb(null, APP_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      file.originalname = fixUploadFilename(file.originalname || '');
      const ext = path.extname(file.originalname || '').slice(0, 20);
      const safeBase = (path.basename(file.originalname || 'material', ext) || 'material').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function toFieldErrors(input: Record<string, string>) {
  return Object.entries(input).map(([field, message]) => ({ field, message }));
}

function badRequest(res: Response, message: string, fieldErrors?: Record<string, string>) {
  res.status(400).json({
    code: 'BAD_REQUEST',
    message,
    fieldErrors: fieldErrors ? toFieldErrors(fieldErrors) : undefined,
  });
}

async function ensureOwnedChild(parentId: string, childId: string) {
  return prisma.appChild.findFirst({ where: { id: childId, parentId } });
}

async function ensureOwnedTask(parentId: string, taskId: string) {
  return prisma.learningTask.findFirst({ where: { id: taskId, parentId } });
}

function parseProgressAnswerData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

router.post('/auth/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password, displayName, phone } = req.body as {
      username?: string;
      password?: string;
      displayName?: string;
      phone?: string;
    };
    const u = username?.trim();
    const p = password?.trim();
    const d = displayName?.trim() || u;
    const normalizedPhone = phone?.trim() || null;
    if (!u || !p) {
      badRequest(res, '请输入用户名和密码', {
        username: '请输入用户名',
        password: '请输入密码',
      });
      return;
    }
    if (!isStrongPassword(p)) {
      badRequest(res, PASSWORD_POLICY_MESSAGE, { password: PASSWORD_POLICY_MESSAGE });
      return;
    }
    if (normalizedPhone && !isValidPhone(normalizedPhone)) {
      badRequest(res, PHONE_POLICY_MESSAGE, { phone: PHONE_POLICY_MESSAGE });
      return;
    }
    const existed = await prisma.appParent.findUnique({ where: { username: u } });
    if (existed) {
      badRequest(res, '用户名已存在，请直接登录或找回密码', { username: '用户名已存在，请直接登录或找回密码' });
      return;
    }
    const passwordHash = await bcrypt.hash(p, 10);
    await prisma.appParent.create({
      data: { username: u, passwordHash, displayName: d || u },
      select: { id: true },
    });
    res.status(201).json({
      ok: true,
      message: normalizedPhone
        ? '注册成功（手机号已保存，短信验证能力待开通）'
        : '注册成功，请使用账号密码登录',
      smsVerificationStatus: normalizedPhone ? 'pending_provider' : 'not_provided',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/auth/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    const u = username?.trim();
    const p = password?.trim();
    if (!u || !p) {
      badRequest(res, '请输入用户名和密码', {
        username: '请输入用户名',
        password: '请输入密码',
      });
      return;
    }
    const parent = await prisma.appParent.findUnique({ where: { username: u } });
    if (!parent) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const ok = await bcrypt.compare(p, parent.passwordHash);
    if (!ok) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const token = signAppParentToken({ id: parent.id, username: parent.username });
    res.json({ token, parent: { id: parent.id, username: parent.username, displayName: parent.displayName } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

// —— 手机号 + 验证码：发送验证码 ——
router.post('/auth/sms/request', authLimiter, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body as { phone?: string };
    const p = (phone || '').trim();
    if (!isValidPhone(p)) {
      badRequest(res, PHONE_POLICY_MESSAGE, { phone: PHONE_POLICY_MESSAGE });
      return;
    }
    const cooldownKey = `app:sms:cooldown:${p}`;
    const onCooldown = await redis.get(cooldownKey);
    if (onCooldown) {
      const ttl = await redis.ttl(cooldownKey);
      res.status(429).json({ error: `请 ${ttl > 0 ? ttl : SMS_RESEND_COOLDOWN_SEC} 秒后再获取验证码` });
      return;
    }
    const code = generateSmsCode();
    await redis.set(`app:sms:code:${p}`, code, 'EX', SMS_CODE_TTL_SEC);
    await redis.set(cooldownKey, '1', 'EX', SMS_RESEND_COOLDOWN_SEC);

    const send = await sendSmsViaProvider(p, code);
    if (!send.ok && !SMS_DEMO_MODE) {
      res.status(500).json({ error: '短信发送失败，请稍后再试' });
      return;
    }
    const body: Record<string, unknown> = {
      ok: true,
      cooldownSeconds: SMS_RESEND_COOLDOWN_SEC,
      ttlSeconds: SMS_CODE_TTL_SEC,
    };
    if (SMS_DEMO_MODE) {
      body.demoMode = true;
      body.demoCode = code;
      body.message = '当前为演示模式：验证码直接显示（生产环境会通过短信发送）';
    }
    res.json(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

// —— 手机号 + 验证码：登录 / 自动注册 ——
router.post('/auth/sms/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { phone, code } = req.body as { phone?: string; code?: string };
    const p = (phone || '').trim();
    const c = (code || '').trim();
    if (!isValidPhone(p)) {
      badRequest(res, PHONE_POLICY_MESSAGE, { phone: PHONE_POLICY_MESSAGE });
      return;
    }
    if (!/^\d{6}$/.test(c)) {
      badRequest(res, '请输入 6 位验证码', { code: '请输入 6 位验证码' });
      return;
    }
    const key = `app:sms:code:${p}`;
    const expected = await redis.get(key);
    if (!expected || expected !== c) {
      res.status(401).json({ error: '验证码错误或已过期' });
      return;
    }
    await redis.del(key);

    let parent = await prisma.appParent.findUnique({ where: { username: p } });
    let isNew = false;
    if (!parent) {
      const randomPwd = crypto.randomBytes(16).toString('hex');
      const passwordHash = await bcrypt.hash(randomPwd, 10);
      parent = await prisma.appParent.create({
        data: {
          username: p,
          passwordHash,
          displayName: `家长${p.slice(-4)}`,
        },
      });
      isNew = true;
    }
    const token = signAppParentToken({ id: parent.id, username: parent.username });
    res.json({
      token,
      isNew,
      parent: { id: parent.id, username: parent.username, displayName: parent.displayName },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

// —— 微信小程序登录预留 ——
router.post('/auth/wechat-mini/login', authLimiter, async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };
  if (!code) {
    res.status(400).json({ error: '缺少 wx.login() 返回的 code' });
    return;
  }
  const appId = process.env.WECHAT_MINI_APPID;
  const secret = process.env.WECHAT_MINI_SECRET;
  if (!appId || !secret) {
    res.status(501).json({
      error: 'wechat_mini_not_configured',
      message: '微信小程序登录尚未配置（请在后端设置 WECHAT_MINI_APPID / WECHAT_MINI_SECRET）',
    });
    return;
  }
  // 实际实现位置：调 https://api.weixin.qq.com/sns/jscode2session 换 openid → 自动注册/登录
  res.status(501).json({ error: 'wechat_mini_login_pending', message: '小程序登录路径已预留，待小程序壳工程接入后实现' });
});

router.post('/auth/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username } = req.body as { username?: string };
    const u = username?.trim();
    if (!u) {
      badRequest(res, '请输入用户名', { username: '请输入用户名' });
      return;
    }

    const parent = await prisma.appParent.findUnique({ where: { username: u } });
    if (!parent) {
      res.json({
        ok: true,
        message: '若账号存在，重置指引已创建',
      });
      return;
    }

    const { token, tokenHash, expiresAt } = createResetToken();
    await prisma.appPasswordResetToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.appPasswordResetToken.create({
      data: {
        parentId: parent.id,
        tokenHash,
        expiresAt,
      },
    });

    res.json({
      ok: true,
      message: '重置口令已生成，请在有效期内完成重置',
      resetToken: token,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/auth/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    const rawToken = token?.trim();
    const nextPassword = password?.trim();
    if (!rawToken || !nextPassword) {
      badRequest(res, '请填写重置口令和新密码', {
        token: '请输入重置口令',
        password: '请输入新密码',
      });
      return;
    }
    if (!isStrongPassword(nextPassword)) {
      badRequest(res, PASSWORD_POLICY_MESSAGE, { password: PASSWORD_POLICY_MESSAGE });
      return;
    }

    const tokenHash = hashResetToken(rawToken);
    const record = await prisma.appPasswordResetToken.findUnique({
      where: { tokenHash },
      include: { parent: true },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: '重置口令无效或已过期，请重新申请' });
      return;
    }

    const passwordHash = await bcrypt.hash(nextPassword, 10);
    await prisma.$transaction([
      prisma.appParent.update({
        where: { id: record.parentId },
        data: { passwordHash },
      }),
      prisma.appPasswordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.appPasswordResetToken.updateMany({
        where: {
          parentId: record.parentId,
          id: { not: record.id },
          usedAt: null,
        },
        data: { usedAt: new Date() },
      }),
    ]);

    res.json({ ok: true, message: '密码已重置，请重新登录' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/auth/me', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parent = await prisma.appParent.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true, displayName: true, createdAt: true },
  });
  if (!parent) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(parent);
});

router.get('/children', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const list = await prisma.appChild.findMany({
    where: { parentId: payload.sub },
    orderBy: { createdAt: 'desc' },
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const startOfWeek = new Date();
  const day = startOfWeek.getDay();
  const diff = day === 0 ? 6 : day - 1;
  startOfWeek.setDate(startOfWeek.getDate() - diff);
  startOfWeek.setHours(0, 0, 0, 0);

  const withStats = await Promise.all(
    list.map(async (child) => {
      const [todayTaskCount, weeklyDoneCount, latestProgress] = await Promise.all([
        prisma.learningTask.count({
          where: {
            parentId: payload.sub,
            childId: child.id,
            status: 'active',
            OR: [{ dueDate: null }, { dueDate: { gte: startOfToday, lte: endOfToday } }],
          },
        }),
        prisma.taskProgress.count({
          where: {
            childId: child.id,
            status: 'done',
            completedAt: { gte: startOfWeek },
          },
        }),
        prisma.taskProgress.findFirst({
          where: { childId: child.id },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }),
      ]);

      return {
        ...child,
        todayTaskCount,
        weeklyDoneCount,
        latestLearningAt: latestProgress?.updatedAt || null,
      };
    })
  );

  res.json(withStats);
});

router.post('/children', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { name, avatarUrl, birthDate, gradeLevel } = req.body as {
      name?: string;
      avatarUrl?: string;
      birthDate?: string;
      gradeLevel?: string;
    };
    const n = name?.trim();
    if (!n) {
      res.status(400).json({ error: '请输入孩子姓名' });
      return;
    }

    const normalizedName = n.replace(/\s+/g, '').toLowerCase();
    const siblings = await prisma.appChild.findMany({
      where: { parentId: payload.sub },
      select: { id: true, name: true },
    });
    const existed = siblings.find((child) => child.name.replace(/\s+/g, '').toLowerCase() === normalizedName);
    if (existed) {
      res.status(409).json({ error: '该孩子档案已存在，请勿重复添加' });
      return;
    }
    const created = await prisma.appChild.create({
      data: {
        parentId: payload.sub,
        name: n,
        avatarUrl: avatarUrl?.trim() || null,
        gradeLevel: gradeLevel?.trim() || null,
        birthDate: birthDate ? new Date(birthDate) : null,
      },
    });
    res.json(created);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      res.status(409).json({ error: '该孩子档案已存在，请勿重复添加' });
      return;
    }
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/children/:id', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, req.params.id);
  if (!child) {
    res.status(404).json({ error: 'Child not found' });
    return;
  }
  res.json(child);
});

router.patch('/children/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const child = await ensureOwnedChild(payload.sub, req.params.id);
    if (!child) {
      res.status(404).json({ error: '未找到孩子档案' });
      return;
    }
    const { name, avatarUrl, birthDate, gradeLevel } = req.body as {
      name?: string;
      avatarUrl?: string;
      birthDate?: string;
      gradeLevel?: string;
    };
    const updated = await prisma.appChild.update({
      where: { id: child.id },
      data: {
        name: name?.trim() || child.name,
        avatarUrl: avatarUrl === undefined ? child.avatarUrl : avatarUrl?.trim() || null,
        gradeLevel: gradeLevel === undefined ? child.gradeLevel : gradeLevel?.trim() || null,
        birthDate: birthDate === undefined ? child.birthDate : birthDate ? new Date(birthDate) : null,
      },
    });
    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.delete('/children/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const child = await ensureOwnedChild(payload.sub, req.params.id);
    if (!child) {
      res.status(404).json({ error: '未找到孩子档案' });
      return;
    }
    await prisma.appChild.delete({ where: { id: child.id } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/tasks', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const childId = (req.query.childId as string | undefined)?.trim();
  const status = (req.query.status as string | undefined)?.trim();
  const where: Record<string, unknown> = { parentId: payload.sub };
  if (childId) where.childId = childId;
  if (status === 'draft' || status === 'active' || status === 'archived') where.status = status;
  const list = await prisma.learningTask.findMany({
    where,
    include: { child: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(list);
});

router.post('/tasks', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { title, description, category, difficulty, childId, dueDate, materialId } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      difficulty?: number;
      childId?: string;
      dueDate?: string;
      materialId?: string;
    };
    const t = title?.trim();
    const normalizedDescription = description?.trim() || '';
    const normalizedMaterialId = materialId?.trim() || null;
    if (!t) {
      badRequest(res, '请填写任务标题', { title: '请填写任务标题' });
      return;
    }
    if (!normalizedDescription && !normalizedMaterialId) {
      badRequest(res, '请补充任务内容（填写任务说明或关联学习资料）', {
        description: '请填写任务说明或关联学习资料',
        materialId: '请填写任务说明或关联学习资料',
      });
      return;
    }

    const normalizedCategory = normalizeCategory(category);
    if (!normalizedCategory) {
      badRequest(res, '请选择任务分类', { category: '请选择任务分类' });
      return;
    }
    if (!APP_TASK_CATEGORIES.includes(normalizedCategory as typeof APP_TASK_CATEGORIES[number])) {
      badRequest(res, '任务分类仅支持：语文、数学、英语、社会科学', {
        category: '任务分类仅支持：语文、数学、英语、社会科学',
      });
      return;
    }

    if (childId) {
      const child = await ensureOwnedChild(payload.sub, childId);
      if (!child) {
        res.status(403).json({ error: '无权限访问该孩子档案' });
        return;
      }
    }

    let linkedMaterialId: string | null = null;
    if (normalizedMaterialId) {
      const linkedMaterial = await prisma.appArtifact.findFirst({
        where: { id: normalizedMaterialId, parentId: payload.sub },
        select: { id: true, childId: true },
      });
      if (!linkedMaterial) {
        badRequest(res, '关联学习资料不存在或无权限访问', { materialId: '关联学习资料不存在或无权限访问' });
        return;
      }
      if (childId && linkedMaterial.childId && linkedMaterial.childId !== childId) {
        badRequest(res, '关联资料与所选孩子不一致，请重新选择', { materialId: '关联资料与所选孩子不一致，请重新选择' });
        return;
      }
      linkedMaterialId = linkedMaterial.id;
    }

    const created = await prisma.learningTask.create({
      data: {
        parentId: payload.sub,
        childId: childId || null,
        title: t,
        description: description?.trim() || null,
        category: normalizedCategory,
        difficulty: Math.max(1, Math.min(3, Number(difficulty) || 1)),
        dueDate: dueDate ? new Date(dueDate) : null,
      },
      include: { child: { select: { id: true, name: true } } },
    });
    if (created.childId) {
      await prisma.taskProgress.upsert({
        where: { taskId_childId: { taskId: created.id, childId: created.childId } },
        update: {},
        create: { taskId: created.id, childId: created.childId },
      });
    }
    if (linkedMaterialId) {
      await prisma.appArtifact.update({
        where: { id: linkedMaterialId },
        data: { taskId: created.id },
      });
    }
    res.json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/tasks/:id', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const task = await prisma.learningTask.findFirst({
    where: { id: req.params.id, parentId: payload.sub },
    include: {
      child: { select: { id: true, name: true } },
      progresses: true,
    },
  });
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

router.patch('/tasks/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const task = await ensureOwnedTask(payload.sub, req.params.id);
    if (!task) {
      res.status(404).json({ error: '未找到学习任务' });
      return;
    }
    const { title, description, category, difficulty, childId, dueDate, status } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      difficulty?: number;
      childId?: string | null;
      dueDate?: string | null;
      status?: 'draft' | 'active' | 'archived';
    };

    let nextChildId = task.childId;
    if (childId !== undefined) {
      if (childId) {
        const child = await ensureOwnedChild(payload.sub, childId);
        if (!child) {
          res.status(403).json({ error: '无权限访问该孩子档案' });
          return;
        }
        nextChildId = child.id;
      } else {
        nextChildId = null;
      }
    }

    const normalizedCategory = category === undefined ? task.category : normalizeCategory(category) || task.category;
    if (!APP_TASK_CATEGORIES.includes(normalizedCategory as typeof APP_TASK_CATEGORIES[number])) {
      badRequest(res, '任务分类仅支持：语文、数学、英语、社会科学', {
        category: '任务分类仅支持：语文、数学、英语、社会科学',
      });
      return;
    }

    const updated = await prisma.learningTask.update({
      where: { id: task.id },
      data: {
        title: title?.trim() || task.title,
        description: description === undefined ? task.description : description?.trim() || null,
        category: normalizedCategory,
        difficulty: difficulty === undefined ? task.difficulty : Math.max(1, Math.min(3, Number(difficulty) || 1)),
        childId: nextChildId,
        dueDate: dueDate === undefined ? task.dueDate : dueDate ? new Date(dueDate) : null,
        status: status || task.status,
      },
      include: { child: { select: { id: true, name: true } } },
    });

    if (updated.childId) {
      await prisma.taskProgress.upsert({
        where: { taskId_childId: { taskId: updated.id, childId: updated.childId } },
        update: {},
        create: { taskId: updated.id, childId: updated.childId },
      });
    }

    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.delete('/tasks/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const task = await ensureOwnedTask(payload.sub, req.params.id);
    if (!task) {
      res.status(404).json({ error: '未找到学习任务' });
      return;
    }
    await prisma.learningTask.delete({ where: { id: task.id } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

function inferSourceType(mimeType: string, fileName: string) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  const ext = path.extname(fileName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return 'audio';
  return 'file';
}

function inferArtifactType(sourceType: string): ArtifactType {
  if (sourceType === 'image') return ArtifactType.image;
  return ArtifactType.summary;
}

function resolveUploadFilePath(fileUrl: string) {
  const relative = fileUrl.replace(/^\/+/, '');
  return path.resolve(process.cwd(), relative);
}

async function detectTextFromMaterialContent(content: Record<string, unknown>): Promise<string> {
  const out = await extractTextFromMaterial({
    fileName: String(content.fileName || ''),
    fileUrl: String(content.fileUrl || ''),
    mimeType: String(content.mimeType || ''),
  });
  return out.text;
}

async function processMaterialRecognition(materialId: string, parentId: string) {
  try {
    const material = await prisma.appArtifact.findFirst({ where: { id: materialId, parentId } });
    if (!material) return;

    const content = (material.content || {}) as Record<string, unknown>;
    const sourceType = String(content.sourceType || 'file');
    const fileName = String(content.fileName || '未命名资料');
    const fileUrl = String(content.fileUrl || '');
    const mimeType = String(content.mimeType || '');

    const recognized = await recognizeMaterial({
      parentId,
      sourceType,
      fileName,
      fileUrl,
      mimeType,
    });

    const previousCost = Number(content.costUsd || 0);
    const isUnsupportedFormat =
      recognized.textSource === 'filename'
      && !mimeType.toLowerCase().startsWith('image/')
      && !mimeType.toLowerCase().startsWith('audio/')
      && !mimeType.toLowerCase().startsWith('video/');
    const effectiveFallbackReason = isUnsupportedFormat
      ? 'text_extraction_unsupported'
      : recognized.fallbackReason;
    const nextContent = {
      ...content,
      status: recognized.status,
      recognitionStatus: recognized.recognitionStatus,
      recognitionResult: recognized.result,
      fallbackReason: effectiveFallbackReason,
      costUsd: Number.isFinite(previousCost) ? previousCost + recognized.costUsd : recognized.costUsd,
      recognizedAt: recognized.result.recognizedAt,
    } as unknown as Prisma.InputJsonValue;

    await prisma.appArtifact.update({
      where: { id: material.id },
      data: { content: nextContent },
    });
  } catch {
    const material = await prisma.appArtifact.findFirst({ where: { id: materialId, parentId } });
    if (!material) return;

    const content = (material.content || {}) as Record<string, unknown>;
    const nextContent = {
      ...content,
      status: 'failed',
      recognitionStatus: 'failed',
      fallbackReason: 'ai_recognition_failed',
    } as unknown as Prisma.InputJsonValue;

    await prisma.appArtifact.update({
      where: { id: material.id },
      data: { content: nextContent },
    });
  }
}

interface GenerateMaterialTaskParams {
  materialId: string;
  parentId: string;
  childId: string | null;
  title?: string;
  category?: string;
  difficulty?: number;
  mediaKind?: MediaKind;
  dueDate?: string | null;
}

async function processMaterialTaskGeneration(params: GenerateMaterialTaskParams) {
  try {
    const material = await prisma.appArtifact.findFirst({ where: { id: params.materialId, parentId: params.parentId } });
    if (!material) return;

    const content = (material.content || {}) as Record<string, unknown>;
    const recognition = ((content.recognitionResult || {}) as Record<string, unknown>);
    const categoryCandidate = normalizeCategory(params.category)
      || normalizeCategory(String(recognition.suggestedCategory || ''))
      || '语文';
    const safeCategory = APP_TASK_CATEGORIES.includes(categoryCandidate as typeof APP_TASK_CATEGORIES[number])
      ? categoryCandidate
      : '语文';
    const safeDifficulty = Math.max(
      1,
      Math.min(3, Number(params.difficulty) || Number(recognition.suggestedDifficulty) || 1)
    );

    const recognitionText = String(recognition.extractedText || '').trim() || await detectTextFromMaterialContent(content);

    const mediaGenerated = await generateProfessionalMedia({
      parentId: params.parentId,
      materialId: material.id,
      title: params.title?.trim() || `${String(content.fileName || '学习资料')}学习任务`,
      sourceType: String(content.sourceType || 'file'),
      fileUrl: String(content.fileUrl || ''),
      recognitionText,
      category: safeCategory,
      difficulty: safeDifficulty,
      mediaKind: params.mediaKind || 'both',
    });

    const parsedDueDate = params.dueDate
      ? (() => {
          const d = new Date(params.dueDate as string);
          return Number.isNaN(d.getTime()) ? null : d;
        })()
      : null;

    const task = await prisma.learningTask.create({
      data: {
        parentId: params.parentId,
        childId: params.childId,
        title: params.title?.trim() || `${String(content.fileName || '学习资料')}学习任务`,
        description: mediaGenerated.script,
        category: safeCategory,
        difficulty: safeDifficulty,
        source: 'library-generated',
        dueDate: parsedDueDate,
      },
      include: { child: { select: { id: true, name: true } } },
    });

    if (task.childId) {
      await prisma.taskProgress.upsert({
        where: { taskId_childId: { taskId: task.id, childId: task.childId } },
        update: {},
        create: { taskId: task.id, childId: task.childId },
      });
    }

    const previousCost = Number(content.costUsd || 0);
    const nextContent = {
      ...content,
      status: 'task_generated',
      mediaStatus: mediaGenerated.mediaStatus,
      mediaOutputs: mediaGenerated.outputs,
      mediaScript: mediaGenerated.script,
      generatedTaskId: task.id,
      generatedAt: new Date().toISOString(),
      fallbackReason: mediaGenerated.fallbackReason || content.fallbackReason || null,
      costUsd: Number.isFinite(previousCost) ? previousCost + mediaGenerated.costUsd : mediaGenerated.costUsd,
    } as unknown as Prisma.InputJsonValue;

    await prisma.appArtifact.update({
      where: { id: material.id },
      data: {
        taskId: task.id,
        childId: params.childId,
        content: nextContent,
      },
    });
  } catch {
    const material = await prisma.appArtifact.findFirst({ where: { id: params.materialId, parentId: params.parentId } });
    if (!material) return;

    const content = (material.content || {}) as Record<string, unknown>;
    const nextContent = {
      ...content,
      status: 'failed',
      mediaStatus: 'failed',
      fallbackReason: String(content.fallbackReason || 'media_generation_failed'),
    } as unknown as Prisma.InputJsonValue;

    await prisma.appArtifact.update({
      where: { id: material.id },
      data: { content: nextContent },
    });
  }
}

router.get('/library/materials', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const materials = await prisma.appArtifact.findMany({
    where: { parentId: payload.sub },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(materials);
});

router.post('/library/materials', requireAppParent, writeLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        badRequest(res, '文件过大，单个文件不能超过 20MB', { file: '文件过大，单个文件不能超过 20MB' });
        return;
      }
      badRequest(res, '上传失败，请检查文件后重试', { file: '上传失败，请检查文件后重试' });
      return;
    }
    next(err);
  });
}, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      badRequest(res, '请先上传资料文件', { file: '请先上传资料文件' });
      return;
    }

    const childId = (req.body?.childId as string | undefined)?.trim() || null;
    if (childId) {
      const child = await ensureOwnedChild(payload.sub, childId);
      if (!child) {
        res.status(403).json({ error: '无权限访问该孩子档案' });
        return;
      }
    }

    const rawScheduled = (req.body?.scheduledDate as string | undefined)?.trim() || '';
    const scheduledDate = /^\d{4}-\d{2}-\d{2}$/.test(rawScheduled) ? rawScheduled : null;

    const sourceType = inferSourceType(file.mimetype || '', file.originalname || file.filename);
    const fileUrl = `/uploads/app-library/${file.filename}`;

    const created = await prisma.appArtifact.create({
      data: {
        parentId: payload.sub,
        childId,
        type: inferArtifactType(sourceType),
        content: {
          sourceType,
          fileName: file.originalname,
          mimeType: file.mimetype || null,
          fileSize: file.size,
          fileUrl,
          scheduledDate,
          status: 'uploaded',
          recognitionResult: null,
        },
      },
    });

    res.json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/library/materials/:id/recognize', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const material = await prisma.appArtifact.findFirst({ where: { id: req.params.id, parentId: payload.sub } });
    if (!material) {
      res.status(404).json({ error: '未找到学习资料' });
      return;
    }

    const content = (material.content || {}) as Record<string, unknown>;
    const recognitionStatus = String(content.recognitionStatus || '');
    const hasRecognitionResult = !!content.recognitionResult && typeof content.recognitionResult === 'object';
    if (hasRecognitionResult && (recognitionStatus === 'completed' || recognitionStatus === 'fallback')) {
      res.json(material);
      return;
    }

    const nextContent = {
      ...content,
      status: 'processing',
      recognitionStatus: 'processing',
      fallbackReason: null,
    } as unknown as Prisma.InputJsonValue;

    const updated = await prisma.appArtifact.update({
      where: { id: material.id },
      data: { content: nextContent },
    });

    void processMaterialRecognition(material.id, payload.sub);
    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/library/materials/:id/generate-task', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const material = await prisma.appArtifact.findFirst({ where: { id: req.params.id, parentId: payload.sub } });
    if (!material) {
      res.status(404).json({ error: '未找到学习资料' });
      return;
    }

    const { childId, title, category, difficulty, mediaKind, dueDate } = req.body as {
      childId?: string;
      title?: string;
      category?: string;
      difficulty?: number;
      mediaKind?: MediaKind;
      dueDate?: string;
    };

    let nextChildId: string | null = material.childId || null;
    if (childId?.trim()) {
      const child = await ensureOwnedChild(payload.sub, childId.trim());
      if (!child) {
        res.status(403).json({ error: '无权限访问该孩子档案' });
        return;
      }
      nextChildId = child.id;
    }

    const content = (material.content || {}) as Record<string, unknown>;
    const existingTaskId = typeof material.taskId === 'string' && material.taskId.trim()
      ? material.taskId.trim()
      : (typeof content.generatedTaskId === 'string' && content.generatedTaskId.trim() ? content.generatedTaskId.trim() : null);
    if (existingTaskId) {
      const existingTask = await prisma.learningTask.findFirst({
        where: { id: existingTaskId, parentId: payload.sub },
        include: { child: { select: { id: true, name: true } } },
      });
      if (existingTask) {
        res.json(existingTask);
        return;
      }
    }

    const normalizedMediaKind: MediaKind = mediaKind === 'audio' || mediaKind === 'video' || mediaKind === 'both'
      ? mediaKind
      : 'both';

    const nextContent = {
      ...content,
      status: 'processing',
      mediaStatus: 'processing',
      mediaKind: normalizedMediaKind,
      fallbackReason: null,
    } as unknown as Prisma.InputJsonValue;

    const updated = await prisma.appArtifact.update({
      where: { id: material.id },
      data: {
        childId: nextChildId,
        content: nextContent,
      },
    });

    void processMaterialTaskGeneration({
      materialId: material.id,
      parentId: payload.sub,
      childId: nextChildId,
      title,
      category,
      difficulty,
      mediaKind: normalizedMediaKind,
      dueDate: dueDate?.trim() || null,
    });

    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.get('/library/materials/:id/status', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const material = await prisma.appArtifact.findFirst({ where: { id: req.params.id, parentId: payload.sub } });
  if (!material) {
    res.status(404).json({ error: '未找到学习资料' });
    return;
  }

  res.json(material);
});

function collectMaterialFilePaths(content: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const main = String(content.fileUrl || '').trim();
  if (main && main.startsWith('/uploads/')) {
    paths.push(resolveUploadFilePath(main));
  }
  const mediaOutputs = Array.isArray(content.mediaOutputs) ? content.mediaOutputs : [];
  for (const item of mediaOutputs) {
    if (!item || typeof item !== 'object') continue;
    const url = String((item as Record<string, unknown>).url || '').trim();
    if (url && url.startsWith('/uploads/')) {
      paths.push(resolveUploadFilePath(url));
    }
  }
  return paths;
}

async function deleteMaterialById(materialId: string, parentId: string) {
  const material = await prisma.appArtifact.findFirst({ where: { id: materialId, parentId } });
  if (!material) return false;
  const content = (material.content || {}) as Record<string, unknown>;
  const filePaths = collectMaterialFilePaths(content);
  await prisma.appArtifact.delete({ where: { id: material.id } });
  for (const p of filePaths) {
    fs.promises.unlink(p).catch(() => undefined);
  }
  return true;
}

router.delete('/library/materials/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const removed = await deleteMaterialById(req.params.id, payload.sub);
    if (!removed) {
      res.status(404).json({ error: '未找到学习资料' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.patch('/library/materials/:id', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const material = await prisma.appArtifact.findFirst({ where: { id: req.params.id, parentId: payload.sub } });
    if (!material) {
      res.status(404).json({ error: '未找到学习资料' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;

    // childId: 传 null 解绑；传 string 校验后绑定；未传保持
    let nextChildId: string | null | undefined = undefined;
    if ('childId' in body) {
      const raw = body.childId;
      if (raw === null || raw === '' || raw === undefined) {
        nextChildId = null;
      } else if (typeof raw === 'string' && raw.trim()) {
        const child = await ensureOwnedChild(payload.sub, raw.trim());
        if (!child) {
          res.status(403).json({ error: '无权限访问该孩子档案' });
          return;
        }
        nextChildId = child.id;
      }
    }

    const content = (material.content || {}) as Record<string, unknown>;
    const nextContent: Record<string, unknown> = { ...content };
    let contentChanged = false;

    if ('scheduledDate' in body) {
      const raw = body.scheduledDate;
      if (raw === null || raw === '' || raw === undefined) {
        nextContent.scheduledDate = null;
        contentChanged = true;
      } else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        nextContent.scheduledDate = raw.trim();
        contentChanged = true;
      }
    }

    if ('completed' in body) {
      const flag = body.completed === true || body.completed === 'true';
      if (flag) {
        nextContent.completedAt = new Date().toISOString();
      } else {
        nextContent.completedAt = null;
      }
      contentChanged = true;
    }

    const updateData: Record<string, unknown> = {};
    if (nextChildId !== undefined) updateData.childId = nextChildId;
    if (contentChanged) updateData.content = nextContent as unknown as Prisma.InputJsonValue;

    if (!Object.keys(updateData).length) {
      res.json(material);
      return;
    }

    const updated = await prisma.appArtifact.update({
      where: { id: material.id },
      data: updateData,
    });

    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/library/materials/cleanup', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const idsRaw = Array.isArray((req.body as Record<string, unknown> | undefined)?.ids)
      ? ((req.body as Record<string, unknown>).ids as unknown[])
      : null;
    const where: Record<string, unknown> = { parentId: payload.sub };
    if (idsRaw && idsRaw.length) {
      const ids = idsRaw.map((v) => String(v || '').trim()).filter((v) => v.length > 0);
      if (!ids.length) {
        res.json({ ok: true, removed: 0 });
        return;
      }
      where.id = { in: ids };
    }
    const targets = await prisma.appArtifact.findMany({ where, select: { id: true, content: true } });
    let removed = 0;
    for (const item of targets) {
      const filePaths = collectMaterialFilePaths((item.content || {}) as Record<string, unknown>);
      await prisma.appArtifact.delete({ where: { id: item.id } }).then(() => {
        removed += 1;
        for (const p of filePaths) {
          fs.promises.unlink(p).catch(() => undefined);
        }
      }).catch(() => undefined);
    }
    res.json({ ok: true, removed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

// 文字转语音：把孩子上传的题目/绘本正文用云希活泼男声读出来，前端会把 mp3 当作旁白
// 混进 MediaRecorder 来生成"有讲解"的学习视频，也可以单独当朗读音频用。
router.post('/tts', requireAppParent, ttsLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const text = String(body.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'tts_empty_text' });
      return;
    }
    if (text.length > 2400) {
      res.status(400).json({ error: 'tts_text_too_long' });
      return;
    }
    const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'zh-CN-YunxiNeural';
    const rate = typeof body.rate === 'string' && body.rate.trim() ? body.rate.trim() : '-4%';
    const buf = await synthesizeEdgeTts(text, { voice, rate });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tts_failed';
    res.status(502).json({ error: msg });
  }
});

// 长文本朗读：服务端按句号切成 ≤2000 字的块顺序合成，再把 mp3 帧拼接成一条音频返回。
// 这样前端可以用单个 <audio> 元素连续播放，避免 Web Speech API 在手机 Chrome 上 15s 截断造成的"断断续续"。
router.post('/tts/long', requireAppParent, ttsLongLimiter, async (req: Request, res: Response) => {
  try {
    const payload = getParent(req);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const text = String(body.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'tts_empty_text' });
      return;
    }
    if (text.length > 8000) {
      res.status(400).json({ error: 'tts_text_too_long' });
      return;
    }
    const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : 'zh-CN-YunxiNeural';
    const rate = typeof body.rate === 'string' && body.rate.trim() ? body.rate.trim() : '-4%';

    const CHUNK_MAX = 2000;
    const chunks: string[] = [];
    const sentences = text.replace(/\r/g, '').split(/(?<=[。！？!?\n])/);
    let buf = '';
    for (const s of sentences) {
      const seg = s.trim();
      if (!seg) continue;
      if (seg.length > CHUNK_MAX) {
        if (buf) { chunks.push(buf); buf = ''; }
        const subs = seg.split(/(?<=[，、,；;])/);
        let sb = '';
        for (const sub of subs) {
          if ((sb + sub).length > CHUNK_MAX) {
            if (sb) chunks.push(sb);
            if (sub.length > CHUNK_MAX) {
              for (let i = 0; i < sub.length; i += CHUNK_MAX) chunks.push(sub.slice(i, i + CHUNK_MAX));
              sb = '';
            } else {
              sb = sub;
            }
          } else {
            sb += sub;
          }
        }
        if (sb) chunks.push(sb);
      } else if ((buf + seg).length > CHUNK_MAX) {
        chunks.push(buf);
        buf = seg;
      } else {
        buf += seg;
      }
    }
    if (buf) chunks.push(buf);
    if (!chunks.length) { res.status(400).json({ error: 'tts_empty_text' }); return; }

    const parts: Buffer[] = [];
    for (const chunk of chunks) {
      const part = await synthesizeEdgeTts(chunk, { voice, rate });
      parts.push(part);
    }
    const merged = Buffer.concat(parts);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Tts-Chunks', String(chunks.length));
    res.send(merged);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tts_failed';
    res.status(502).json({ error: msg });
  }
});

router.get('/progress', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const childId = (req.query.childId as string | undefined)?.trim();
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const progresses = await prisma.taskProgress.findMany({
    where: { childId },
    include: { task: { select: { id: true, title: true, category: true, dueDate: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  const total = progresses.length;
  const done = progresses.filter((p) => p.status === 'done').length;
  const submitted = progresses.filter((p) => p.status === 'submitted').length;
  res.json({ total, done, submitted, completionRate: total > 0 ? done / total : 0, list: progresses });
});

interface WeeklyRankItem {
  childId: string;
  childName: string;
  points: number;
  doneCount: number;
  audioPlayCount: number;
  videoPlayCount: number;
}

interface Trend7dItem {
  date: string;
  label: string;
  doneCount: number;
  learnCount: number;
}

router.get('/reports/:childId', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const child = await ensureOwnedChild(payload.sub, req.params.childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }

  const progresses = await prisma.taskProgress.findMany({
    where: { childId: child.id },
    include: {
      task: {
        select: {
          id: true,
          title: true,
          category: true,
          difficulty: true,
          dueDate: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const total = progresses.length;
  const done = progresses.filter((p) => p.status === 'done').length;
  const submitted = progresses.filter((p) => p.status === 'submitted').length;
  const inProgress = progresses.filter((p) => p.status === 'in_progress').length;
  const scored = progresses.filter((p) => p.score !== null && p.score !== undefined);
  const averageScore = scored.length > 0
    ? scored.reduce((acc, item) => acc + Number(item.score || 0), 0) / scored.length
    : null;

  const mediaStats = progresses.reduce((acc, item) => {
    const data = parseProgressAnswerData(item.answerData);
    acc.audioPlayCount += toNumber(data.audioPlayCount);
    acc.videoPlayCount += toNumber(data.videoPlayCount);
    return acc;
  }, { audioPlayCount: 0, videoPlayCount: 0 });

  const categoryMap = new Map<string, { total: number; done: number }>();
  for (const item of progresses) {
    const category = item.task.category;
    const current = categoryMap.get(category) || { total: 0, done: 0 };
    current.total += 1;
    if (item.status === 'done') current.done += 1;
    categoryMap.set(category, current);
  }

  const categoryStats = Array.from(categoryMap.entries()).map(([category, stat]) => ({
    category,
    total: stat.total,
    done: stat.done,
    completionRate: stat.total > 0 ? stat.done / stat.total : 0,
  }));

  const weekStart = new Date();
  const weekday = weekStart.getDay();
  const weekDiff = weekday === 0 ? 6 : weekday - 1;
  weekStart.setDate(weekStart.getDate() - weekDiff);
  weekStart.setHours(0, 0, 0, 0);

  const weeklyRows = await prisma.taskProgress.findMany({
    where: {
      child: { parentId: payload.sub },
      updatedAt: { gte: weekStart },
    },
    include: {
      child: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const rankMap = new Map<string, WeeklyRankItem>();
  for (const row of weeklyRows) {
    const item = rankMap.get(row.childId) || {
      childId: row.childId,
      childName: row.child.name,
      points: 0,
      doneCount: 0,
      audioPlayCount: 0,
      videoPlayCount: 0,
    };

    if (row.status === 'done') {
      item.doneCount += 1;
      item.points += 3;
    }

    const data = parseProgressAnswerData(row.answerData);
    const audio = toNumber(data.audioPlayCount);
    const video = toNumber(data.videoPlayCount);
    item.audioPlayCount += audio;
    item.videoPlayCount += video;
    item.points += audio + video;

    rankMap.set(row.childId, item);
  }

  const weeklyRanking = Array.from(rankMap.values())
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const trendStart = new Date(dayStart);
  trendStart.setDate(trendStart.getDate() - 6);

  const trendRows = await prisma.taskProgress.findMany({
    where: {
      childId: child.id,
      updatedAt: { gte: trendStart },
    },
    select: {
      status: true,
      updatedAt: true,
      answerData: true,
    },
  });

  const trendMap = new Map<string, { doneCount: number; learnCount: number }>();
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(trendStart);
    day.setDate(trendStart.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    trendMap.set(key, { doneCount: 0, learnCount: 0 });
  }

  for (const row of trendRows) {
    const key = row.updatedAt.toISOString().slice(0, 10);
    const bucket = trendMap.get(key);
    if (!bucket) continue;
    if (row.status === 'done') bucket.doneCount += 1;
    const data = parseProgressAnswerData(row.answerData);
    bucket.learnCount += toNumber(data.audioPlayCount) + toNumber(data.videoPlayCount);
  }

  const trend7d: Trend7dItem[] = Array.from(trendMap.entries()).map(([date, value]) => ({
    date,
    label: `${date.slice(5, 7)}-${date.slice(8, 10)}`,
    doneCount: value.doneCount,
    learnCount: value.learnCount,
  }));

  res.json({
    child: { id: child.id, name: child.name, gradeLevel: child.gradeLevel },
    summary: {
      total,
      done,
      submitted,
      inProgress,
      completionRate: total > 0 ? done / total : 0,
      averageScore,
      audioPlayCount: mediaStats.audioPlayCount,
      videoPlayCount: mediaStats.videoPlayCount,
    },
    categoryStats,
    recent: progresses.slice(0, 20),
    weeklyRanking,
    trend7d,
  });
});

router.get('/child/:childId/today', requireAppParent, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, req.params.childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const list = await prisma.learningTask.findMany({
    where: {
      parentId: payload.sub,
      childId: child.id,
      status: 'active',
      OR: [{ dueDate: null }, { dueDate: { gte: start, lte: end } }],
    },
    include: {
      progresses: { where: { childId: child.id }, take: 1 },
      artifacts: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  });

  const normalizedList = list.map((task) => {
    const latestArtifact = task.artifacts?.[0];
    const content = latestArtifact && typeof latestArtifact.content === 'object' && !Array.isArray(latestArtifact.content)
      ? (latestArtifact.content as Record<string, unknown>)
      : {};
    const mediaOutputs = Array.isArray(content.mediaOutputs) ? content.mediaOutputs : [];
    const audio = mediaOutputs.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'audio');
    const video = mediaOutputs.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'video');

    return {
      ...task,
      professionalMedia: {
        audioUrl: audio && typeof (audio as Record<string, unknown>).url === 'string' ? String((audio as Record<string, unknown>).url) : null,
        videoUrl: video && typeof (video as Record<string, unknown>).url === 'string' ? String((video as Record<string, unknown>).url) : null,
      },
    };
  });

  res.json({ child: { id: child.id, name: child.name }, list: normalizedList });
});

router.post('/tasks/:taskId/start', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId } = req.body as { childId?: string };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const progress = await prisma.taskProgress.upsert({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
    update: { status: 'in_progress' },
    create: { taskId: task.id, childId: child.id, status: 'in_progress' },
  });
  res.json(progress);
});

router.post('/tasks/:taskId/submit', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId, answerData, score } = req.body as { childId?: string; answerData?: unknown; score?: number };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const existing = await prisma.taskProgress.findUnique({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
  });

  const incomingAnswerData = answerData === undefined ? null : parseProgressAnswerData(answerData);
  const mergedAnswerData = answerData === undefined
    ? existing?.answerData
    : {
      ...parseProgressAnswerData(existing?.answerData),
      ...incomingAnswerData,
    };

  if (existing) {
    const progress = await prisma.taskProgress.update({
      where: { id: existing.id },
      data: {
        status: existing.status === 'done' ? 'done' : 'submitted',
        answerData: mergedAnswerData === undefined ? undefined : (mergedAnswerData as object),
        score: score === undefined ? existing.score : Number(score),
        submittedAt: new Date(),
      },
    });
    res.json(progress);
    return;
  }

  const progress = await prisma.taskProgress.create({
    data: {
      taskId: task.id,
      childId: child.id,
      status: 'submitted',
      answerData: mergedAnswerData === undefined ? undefined : (mergedAnswerData as object),
      score: score === undefined ? null : Number(score),
      submittedAt: new Date(),
    },
  });
  res.json(progress);
});

router.post('/tasks/:taskId/complete', requireAppParent, writeLimiter, async (req: Request, res: Response) => {
  const payload = getParent(req);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { childId } = req.body as { childId?: string };
  if (!childId) {
    res.status(400).json({ error: 'childId required' });
    return;
  }
  const child = await ensureOwnedChild(payload.sub, childId);
  if (!child) {
    res.status(403).json({ error: 'Forbidden child' });
    return;
  }
  const task = await ensureOwnedTask(payload.sub, req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const progress = await prisma.taskProgress.upsert({
    where: { taskId_childId: { taskId: task.id, childId: child.id } },
    update: { status: 'done', completedAt: new Date() },
    create: { taskId: task.id, childId: child.id, status: 'done', completedAt: new Date() },
  });
  res.json(progress);
});

export default router;
