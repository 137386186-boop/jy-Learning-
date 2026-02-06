import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** GET /api/contents/platforms — 平台列表（筛选用） */
router.get('/platforms', async (_req: Request, res: Response) => {
  try {
    const list = await prisma.platform.findMany({
      where: { enabled: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, iconUrl: true },
    });
    res.json(list);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/contents — 内容列表，支持 platformId、contentType、keyword、分页 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const platformId = req.query.platformId as string | undefined;
    const contentType = req.query.contentType as string | undefined;
    const keyword = req.query.keyword as string | undefined;
    const replied = req.query.replied as string | undefined;
    const publishedFrom = req.query.publishedFrom as string | undefined;
    const publishedTo = req.query.publishedTo as string | undefined;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(String(req.query.pageSize), 10) || DEFAULT_PAGE_SIZE)
    );
    const where: Record<string, unknown> = {};
    if (platformId) where.platformId = platformId;
    if (contentType === 'post' || contentType === 'comment') where.contentType = contentType;
    if (replied === 'true') where.replied = true;
    if (replied === 'false') where.replied = false;
    if (publishedFrom || publishedTo) {
      const gte = publishedFrom ? new Date(publishedFrom) : null;
      const lte = publishedTo ? new Date(publishedTo) : null;
      const dateFilter: Record<string, Date> = {};
      if (gte && !Number.isNaN(gte.getTime())) dateFilter.gte = gte;
      if (lte && !Number.isNaN(lte.getTime())) dateFilter.lte = lte;
      if (Object.keys(dateFilter).length > 0) where.publishedAt = dateFilter;
    }
    if (keyword && keyword.trim()) {
      const k = keyword.trim();
      where.OR = [
        { body: { contains: k } },
        { summary: { contains: k } },
        { keywordTags: { has: k } },
      ];
    }
    const [list, total] = await Promise.all([
      prisma.content.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          platform: { select: { id: true, name: true, slug: true } },
        },
      }),
      prisma.content.count({ where }),
    ]);
    res.json({ list, total, page, pageSize });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/contents/:id — 单条内容详情 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const content = await prisma.content.findUnique({
      where: { id },
      include: {
        platform: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!content) {
      res.status(404).json({ error: 'Content not found' });
      return;
    }
    res.json(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

export default router;
