import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { ArtifactType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAppParent, signAppParentToken, type AppParentTokenPayload } from '../lib/app-auth';
import { recognizeMaterial } from '../lib/ai-recognition';
import { generateProfessionalMedia } from '../lib/media-generation';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
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
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(APP_UPLOAD_DIR, { recursive: true });
      cb(null, APP_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
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
    const { username, password, displayName } = req.body as {
      username?: string;
      password?: string;
      displayName?: string;
    };
    const u = username?.trim();
    const p = password?.trim();
    const d = displayName?.trim() || u;
    if (!u || !p) {
      res.status(400).json({ error: '请输入用户名和密码' });
      return;
    }
    if (p.length < 6) {
      res.status(400).json({ error: '密码长度至少 6 位' });
      return;
    }
    const existed = await prisma.appParent.findUnique({ where: { username: u } });
    if (existed) {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }
    const passwordHash = await bcrypt.hash(p, 10);
    const parent = await prisma.appParent.create({
      data: { username: u, passwordHash, displayName: d || u },
      select: { id: true, username: true, displayName: true },
    });
    const token = signAppParentToken({ id: parent.id, username: parent.username });
    res.json({ token, parent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

router.post('/auth/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    const u = username?.trim();
    const p = password?.trim();
    if (!u || !p) {
      res.status(400).json({ error: '请输入用户名和密码' });
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
    const { title, description, category, difficulty, childId, dueDate } = req.body as {
      title?: string;
      description?: string;
      category?: string;
      difficulty?: number;
      childId?: string;
      dueDate?: string;
    };
    const t = title?.trim();
    if (!t) {
      badRequest(res, '请填写任务标题', { title: '请填写任务标题' });
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

function detectTextFromFilename(fileName: string) {
  const base = path.basename(fileName, path.extname(fileName));
  return base.replace(/[_-]+/g, ' ').trim();
}

function resolveUploadFilePath(fileUrl: string) {
  const relative = fileUrl.replace(/^\/+/, '');
  return path.resolve(process.cwd(), relative);
}

function detectTextFromMaterialContent(content: Record<string, unknown>) {
  const fileName = String(content.fileName || '');
  const fileUrl = String(content.fileUrl || '');
  const mimeType = String(content.mimeType || '').toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  if (!fileUrl) return detectTextFromFilename(fileName);

  const canReadAsText = mimeType.startsWith('text/') || ['.txt', '.md', '.markdown', '.csv'].includes(ext);
  if (!canReadAsText) return detectTextFromFilename(fileName);

  try {
    const raw = fs.readFileSync(resolveUploadFilePath(fileUrl), 'utf-8');
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.slice(0, 1200);
  } catch {
    // ignore fallback
  }

  return detectTextFromFilename(fileName);
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
    const nextContent = {
      ...content,
      status: recognized.status,
      recognitionStatus: recognized.recognitionStatus,
      recognitionResult: recognized.result,
      fallbackReason: recognized.fallbackReason,
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

    const mediaGenerated = await generateProfessionalMedia({
      parentId: params.parentId,
      materialId: material.id,
      title: params.title?.trim() || `${String(content.fileName || '学习资料')}学习任务`,
      sourceType: String(content.sourceType || 'file'),
      fileUrl: String(content.fileUrl || ''),
      recognitionText: String(recognition.extractedText || ''),
      category: safeCategory,
      difficulty: safeDifficulty,
    });

    const task = await prisma.learningTask.create({
      data: {
        parentId: params.parentId,
        childId: params.childId,
        title: params.title?.trim() || `${String(content.fileName || '学习资料')}学习任务`,
        description: mediaGenerated.script,
        category: safeCategory,
        difficulty: safeDifficulty,
        source: 'library-generated',
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

    const { childId, title, category, difficulty } = req.body as {
      childId?: string;
      title?: string;
      category?: string;
      difficulty?: number;
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

    const nextContent = {
      ...content,
      status: 'processing',
      mediaStatus: 'processing',
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
