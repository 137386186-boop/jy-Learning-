import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAdmin, signAdminToken } from '../lib/admin-auth';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const importLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function toTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(/[,，;；\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function toDate(input: unknown): Date | null {
  if (!input) return null;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** POST /api/admin/login — 管理员登录，返回 token */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'username and password required' });
      return;
    }
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = signAdminToken({ id: admin.id, username: admin.username });
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/admin/me — 当前管理员信息 */
router.get('/me', requireAdmin, async (req: Request, res: Response) => {
  const payload = (req as Request & { admin?: { sub: string; username: string } }).admin;
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ id: payload.sub, username: payload.username });
});

/** GET /api/admin/stats — 管理后台统计 */
router.get('/stats', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [contentCount, platformCount, repliedCount, templateCount] = await Promise.all([
      prisma.content.count(),
      prisma.platform.count({ where: { enabled: true } }),
      prisma.content.count({ where: { replied: true } }),
      prisma.replyTemplate.count(),
    ]);
    res.json({
      contentCount,
      platformCount,
      repliedCount,
      templateCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/reply-templates — 新建回复模板 */
router.post('/reply-templates', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { title, content } = req.body as { title?: string; content?: string };
    if (!title || !content) {
      res.status(400).json({ error: 'title and content required' });
      return;
    }
    const created = await prisma.replyTemplate.create({
      data: { title: title.trim(), content: content.trim() },
      select: { id: true, title: true, content: true },
    });
    res.json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** PUT /api/admin/reply-templates/:id — 更新回复模板 */
router.put('/reply-templates/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { title, content } = req.body as { title?: string; content?: string };
    if (!title || !content) {
      res.status(400).json({ error: 'title and content required' });
      return;
    }
    const updated = await prisma.replyTemplate.update({
      where: { id },
      data: { title: title.trim(), content: content.trim() },
      select: { id: true, title: true, content: true },
    });
    res.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** DELETE /api/admin/reply-templates/:id — 删除回复模板 */
router.delete('/reply-templates/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    await prisma.replyTemplate.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/contents/import — 批量导入内容 */
router.post('/contents/import', requireAdmin, importLimiter, async (req: Request, res: Response) => {
  try {
    const { items } = req.body as { items?: unknown[] };
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'items must be a non-empty array' });
      return;
    }

    const slugs = Array.from(
      new Set(
        items
          .map((it) => (it && typeof it === 'object' ? (it as any).platformSlug : null))
          .filter((v) => typeof v === 'string' && v.trim())
          .map((v: string) => v.trim())
      )
    );

    const platformMap = new Map<string, string>();
    if (slugs.length > 0) {
      const exist = await prisma.platform.findMany({ where: { slug: { in: slugs } } });
      exist.forEach((p) => platformMap.set(p.slug, p.id));
      const missing = slugs.filter((s) => !platformMap.has(s));
      for (const slug of missing) {
        const created = await prisma.platform.create({
          data: { slug, name: slug },
          select: { id: true, slug: true },
        });
        platformMap.set(created.slug, created.id);
      }
    }

    const normalized: {
      platformId: string;
      contentType: 'post' | 'comment';
      platformContentId?: string | null;
      authorName: string;
      authorId?: string | null;
      authorAvatar?: string | null;
      body: string;
      bodyMd5: string;
      publishedAt: Date;
      sourceUrl: string;
      keywordTags: string[];
      likeCount?: number | null;
      commentCount?: number | null;
      summary?: string | null;
    }[] = [];

    const errors: { index: number; reason: string }[] = [];

    items.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') {
        errors.push({ index, reason: 'invalid item' });
        return;
      }
      const it = raw as any;
      const platformId = it.platformId || (it.platformSlug ? platformMap.get(String(it.platformSlug)) : null);
      if (!platformId) {
        errors.push({ index, reason: 'platformId or platformSlug required' });
        return;
      }
      const body = String(it.body || '').trim();
      const authorName = String(it.authorName || '').trim();
      const sourceUrl = String(it.sourceUrl || '').trim();
      const publishedAt = toDate(it.publishedAt);
      if (!body || !authorName || !sourceUrl || !publishedAt) {
        errors.push({ index, reason: 'authorName, body, sourceUrl, publishedAt required' });
        return;
      }
      const contentType = it.contentType === 'comment' ? 'comment' : 'post';
      const likeCount =
        it.likeCount == null || Number.isNaN(Number(it.likeCount)) ? null : Number(it.likeCount);
      const commentCount =
        it.commentCount == null || Number.isNaN(Number(it.commentCount)) ? null : Number(it.commentCount);
      normalized.push({
        platformId,
        contentType,
        platformContentId: it.platformContentId ? String(it.platformContentId) : null,
        authorName,
        authorId: it.authorId ? String(it.authorId) : null,
        authorAvatar: it.authorAvatar ? String(it.authorAvatar) : null,
        body,
        bodyMd5: md5(body),
        publishedAt,
        sourceUrl,
        keywordTags: toTags(it.keywordTags),
        likeCount,
        commentCount,
        summary: it.summary ? String(it.summary) : body.slice(0, 120),
      });
    });

    if (normalized.length === 0) {
      res.status(400).json({ error: 'no valid items', errors });
      return;
    }

    const result = await prisma.content.createMany({
      data: normalized,
      skipDuplicates: true,
    });

    res.json({
      ok: true,
      total: items.length,
      inserted: result.count,
      invalid: errors.length,
      errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

export default router;
