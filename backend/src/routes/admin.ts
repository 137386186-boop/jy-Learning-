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

function isValidSourceUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (!url.hostname) return false;
    const path = url.pathname?.trim() ?? '';
    return path.length > 1 && path !== '/';
  } catch {
    return false;
  }
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
    const [contentCount, platformCount, repliedCount] = await Promise.all([
      prisma.content.count(),
      prisma.platform.count({ where: { enabled: true } }),
      prisma.content.count({ where: { replied: true } }),
    ]);
    res.json({
      contentCount,
      platformCount,
      repliedCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/admin/platform-auth — 平台授权状态列表 */
router.get('/platform-auth', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const platforms = await prisma.platform.findMany({
      where: { enabled: true },
      orderBy: { name: 'asc' },
      include: {
        auth: {
          select: { status: true, authorizedAt: true },
        },
      },
    });
    const oauthSupported = new Set(['zhihu']);
    res.json(
      platforms.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        enabled: p.enabled,
        oauthSupported: oauthSupported.has(p.slug),
        authStatus: p.auth?.status ?? 'unauthed',
        authorizedAt: p.auth?.authorizedAt ?? null,
      }))
    );
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
      index: number;
      data: {
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
      };
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
      if (!isValidSourceUrl(sourceUrl)) {
        errors.push({ index, reason: 'sourceUrl must be a direct link to a specific post/comment' });
        return;
      }
      const contentType = it.contentType === 'comment' ? 'comment' : 'post';
      const platformContentId = it.platformContentId ? String(it.platformContentId) : null;
      if (contentType === 'comment' && platformContentId && !sourceUrl.includes(platformContentId)) {
        errors.push({ index, reason: 'comment sourceUrl must include platformContentId for precise定位' });
        return;
      }
      const likeCount =
        it.likeCount == null || Number.isNaN(Number(it.likeCount)) ? null : Number(it.likeCount);
      const commentCount =
        it.commentCount == null || Number.isNaN(Number(it.commentCount)) ? null : Number(it.commentCount);
      normalized.push({
        index,
        data: {
          platformId,
          contentType,
          platformContentId,
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
        },
      });
    });

    if (normalized.length === 0) {
      res.status(400).json({ error: 'no valid items', errors });
      return;
    }

    const platformIds = Array.from(new Set(normalized.map((n) => n.data.platformId)));
    const platformContentIds = Array.from(
      new Set(normalized.map((n) => n.data.platformContentId).filter((v): v is string => !!v))
    );
    const sourceUrls = Array.from(new Set(normalized.map((n) => n.data.sourceUrl).filter(Boolean)));

    const existingKeys = new Set<string>();
    if (platformContentIds.length > 0) {
      const existByPlatformContentId = await prisma.content.findMany({
        where: {
          platformId: { in: platformIds },
          platformContentId: { in: platformContentIds },
        },
        select: { platformId: true, platformContentId: true },
      });
      existByPlatformContentId.forEach((e) => {
        if (e.platformContentId) existingKeys.add(`pcid:${e.platformId}:${e.platformContentId}`);
      });
    }
    if (sourceUrls.length > 0) {
      const existBySourceUrl = await prisma.content.findMany({
        where: {
          platformId: { in: platformIds },
          sourceUrl: { in: sourceUrls },
        },
        select: { platformId: true, sourceUrl: true },
      });
      existBySourceUrl.forEach((e) => {
        existingKeys.add(`url:${e.platformId}:${e.sourceUrl}`);
      });
    }

    const incomingKeys = new Set<string>();
    const filtered = normalized.filter((n) => {
      const keyByContentId = n.data.platformContentId
        ? `pcid:${n.data.platformId}:${n.data.platformContentId}`
        : null;
      const keyByUrl = `url:${n.data.platformId}:${n.data.sourceUrl}`;
      const isDup = (keyByContentId && existingKeys.has(keyByContentId)) || existingKeys.has(keyByUrl);
      const isIncomingDup =
        (keyByContentId && incomingKeys.has(keyByContentId)) || incomingKeys.has(keyByUrl);
      if (isDup) {
        errors.push({ index: n.index, reason: 'duplicate (platformContentId/sourceUrl)' });
        return false;
      }
      if (isIncomingDup) {
        errors.push({ index: n.index, reason: 'duplicate inside import batch' });
        return false;
      }
      if (keyByContentId) incomingKeys.add(keyByContentId);
      incomingKeys.add(keyByUrl);
      return true;
    });

    const result = await prisma.content.createMany({
      data: filtered.map((n) => n.data),
      skipDuplicates: true,
    });

    res.json({
      ok: true,
      total: items.length,
      inserted: result.count,
      invalid: errors.length,
      skipped: normalized.length - filtered.length,
      errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/contents/deduplicate — 删除重复内容（按 platformContentId/sourceUrl） */
router.post('/contents/deduplicate', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { dryRun } = (req.body || {}) as { dryRun?: boolean };
    const [row] = await prisma.$queryRaw<
      { duplicates: bigint }[]
    >`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY platform_id, COALESCE(platform_content_id, source_url)
                 ORDER BY published_at DESC, created_at DESC
               ) AS rn
        FROM "Content"
      )
      SELECT COUNT(*)::bigint AS duplicates FROM ranked WHERE rn > 1
    `;
    const duplicates = Number(row?.duplicates ?? 0);
    if (dryRun) {
      res.json({ ok: true, duplicates });
      return;
    }
    const deleted = await prisma.$executeRaw`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY platform_id, COALESCE(platform_content_id, source_url)
                 ORDER BY published_at DESC, created_at DESC
               ) AS rn
        FROM "Content"
      )
      DELETE FROM "Content" WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `;
    res.json({ ok: true, duplicates, deleted: Number(deleted) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

export default router;
