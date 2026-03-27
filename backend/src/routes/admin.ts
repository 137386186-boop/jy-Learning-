import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { requireAdmin, signAdminToken } from '../lib/admin-auth';
import { importContentsBatch, extractCommentIdFromUrl, isNumericId } from '../jobs/import-normalizer';

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
    const zhihuOAuthConfigured = !!process.env.ZHIHU_CLIENT_ID && !!process.env.ZHIHU_CLIENT_SECRET;
    res.json(
      platforms.map((p) => {
        const supported = oauthSupported.has(p.slug);
        const authed = supported && p.auth?.status === 'authed';
        const authState = supported ? (authed ? 'authed' : 'unauthed') : 'unsupported';
        const oauthConfigured = p.slug === 'zhihu' ? zhihuOAuthConfigured : false;
        const oauthConfigError =
          p.slug === 'zhihu' && !zhihuOAuthConfigured
            ? '未配置 ZHIHU_CLIENT_ID / ZHIHU_CLIENT_SECRET'
            : null;
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          enabled: p.enabled,
          oauthSupported: supported,
          oauthConfigured,
          oauthConfigError,
          authStatus: authState,
          authState,
          authorizedAt: authed ? p.auth?.authorizedAt ?? null : null,
        };
      })
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

/** GET /api/admin/contents/quality — 数据质量报告 */
router.get('/contents/quality', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [summaryRows, platformRows] = await Promise.all([
      prisma.$queryRaw<
        {
          total: bigint;
          duplicates: bigint;
          commentMissingId: bigint;
          commentLinkUnmatched: bigint;
          bilibiliSearchLinks: bigint;
          demoContents: bigint;
          badTemplateLinks: bigint;
        }[]
      >`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY platform_id, COALESCE(platform_content_id, source_url)
                 ORDER BY published_at DESC, created_at DESC
               ) AS rn
        FROM "Content"
      )
      SELECT
        (SELECT COUNT(*) FROM "Content")::bigint AS total,
        (SELECT COUNT(*) FROM ranked WHERE rn > 1)::bigint AS duplicates,
        (SELECT COUNT(*) FROM "Content"
          WHERE content_type = 'comment'
            AND (platform_content_id IS NULL OR platform_content_id = '')
        )::bigint AS commentMissingId,
        (SELECT COUNT(*) FROM "Content"
          WHERE content_type = 'comment'
            AND platform_content_id IS NOT NULL
            AND platform_content_id <> ''
            AND source_url NOT LIKE '%' || platform_content_id || '%'
        )::bigint AS commentLinkUnmatched,
        (SELECT COUNT(*) FROM "Content" c
          JOIN "Platform" p ON p.id = c.platform_id
          WHERE p.slug = 'bilibili'
            AND c.source_url LIKE '%search.bilibili.com/%'
        )::bigint AS bilibiliSearchLinks,
        (SELECT COUNT(*) FROM "Content"
          WHERE source_url LIKE '%/demo/%'
             OR source_url LIKE '%demo-%'
             OR platform_content_id LIKE 'demo%'
        )::bigint AS demoContents,
        (SELECT COUNT(*) FROM "Content"
          WHERE LOWER(source_url) LIKE '%example.com%'
             OR LOWER(source_url) LIKE '%localhost%'
             OR LOWER(source_url) LIKE '%/demo/%'
             OR LOWER(source_url) LIKE '%demo-%'
             OR LOWER(source_url) LIKE '%replace_me%'
             OR LOWER(source_url) LIKE '%your-url%'
             OR source_url LIKE '%{id}%'
             OR source_url LIKE '%<id>%'
             OR source_url LIKE '%{{%'
        )::bigint AS badTemplateLinks
    `,
      prisma.$queryRaw<
        {
          platformId: string;
          platformSlug: string;
          platformName: string;
          total: bigint;
          badTemplateLinks: bigint;
        }[]
      >`
      SELECT
        p.id AS "platformId",
        p.slug AS "platformSlug",
        p.name AS "platformName",
        COUNT(*)::bigint AS total,
        SUM(
          CASE WHEN LOWER(c.source_url) LIKE '%example.com%'
                 OR LOWER(c.source_url) LIKE '%localhost%'
                 OR LOWER(c.source_url) LIKE '%/demo/%'
                 OR LOWER(c.source_url) LIKE '%demo-%'
                 OR LOWER(c.source_url) LIKE '%replace_me%'
                 OR LOWER(c.source_url) LIKE '%your-url%'
                 OR c.source_url LIKE '%{id}%'
                 OR c.source_url LIKE '%<id>%'
                 OR c.source_url LIKE '%{{%'
               THEN 1 ELSE 0 END
        )::bigint AS "badTemplateLinks"
      FROM "Content" c
      JOIN "Platform" p ON p.id = c.platform_id
      GROUP BY p.id, p.slug, p.name
      ORDER BY total DESC
    `,
    ]);

    const data = summaryRows?.[0] ?? {
      total: BigInt(0),
      duplicates: BigInt(0),
      commentMissingId: BigInt(0),
      commentLinkUnmatched: BigInt(0),
      bilibiliSearchLinks: BigInt(0),
      demoContents: BigInt(0),
      badTemplateLinks: BigInt(0),
    };

    res.json({
      total: Number(data.total ?? 0),
      duplicates: Number(data.duplicates ?? 0),
      commentMissingId: Number(data.commentMissingId ?? 0),
      commentLinkUnmatched: Number(data.commentLinkUnmatched ?? 0),
      bilibiliSearchLinks: Number(data.bilibiliSearchLinks ?? 0),
      demoContents: Number(data.demoContents ?? 0),
      badTemplateLinks: Number(data.badTemplateLinks ?? 0),
      platformDistribution: (platformRows || []).map((row) => ({
        platformId: row.platformId,
        platformSlug: row.platformSlug,
        platformName: row.platformName,
        total: Number(row.total ?? 0),
        badTemplateLinks: Number(row.badTemplateLinks ?? 0),
      })),
    });
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

    const importResult = await importContentsBatch(items);
    if (!importResult.hasValidItems) {
      res.status(400).json({ error: 'no valid items', errors: importResult.errors });
      return;
    }

    res.json({
      ok: true,
      total: importResult.total,
      inserted: importResult.inserted,
      invalid: importResult.invalid,
      skipped: importResult.skipped,
      errors: importResult.errors,
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

/** POST /api/admin/contents/repair-comment-ids — 从链接修复评论ID */
router.post('/contents/repair-comment-ids', requireAdmin, async (req: Request, res: Response) => {
  try {
    const limitRaw = (req.body as { limit?: number })?.limit;
    const limit = Math.min(2000, Math.max(1, Number(limitRaw) || 500));
    const candidates = await prisma.content.findMany({
      where: {
        contentType: 'comment',
      },
      select: { id: true, sourceUrl: true, platformContentId: true },
      take: limit,
    });
    let updated = 0;
    for (const item of candidates) {
      if (item.platformContentId && isNumericId(item.platformContentId)) continue;
      const extracted = extractCommentIdFromUrl(item.sourceUrl);
      if (!extracted) continue;
      await prisma.content.update({
        where: { id: item.id },
        data: { platformContentId: extracted },
      });
      updated += 1;
    }
    res.json({ ok: true, checked: candidates.length, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/contents/cleanup-bilibili-search — 清理B站搜索链接 */
router.post('/contents/cleanup-bilibili-search', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Content"
      WHERE platform_id IN (SELECT id FROM "Platform" WHERE slug = 'bilibili')
        AND source_url LIKE '%search.bilibili.com/%'
    `;
    res.json({ ok: true, deleted: Number(deleted) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** POST /api/admin/contents/cleanup-demo — 清理示例数据 */
router.post('/contents/cleanup-demo', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Content"
      WHERE source_url LIKE '%/demo/%'
         OR source_url LIKE '%demo-%'
         OR platform_content_id LIKE 'demo%'
    `;
    res.json({ ok: true, deleted: Number(deleted) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

export default router;
