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
    const rawPlatformId = req.query.platformId as string | undefined;
    const rawContentType = req.query.contentType as string | undefined;
    const rawKeyword = req.query.keyword as string | undefined;
    const rawReplied = req.query.replied as string | undefined;
    const rawPublishedFrom = req.query.publishedFrom as string | undefined;
    const rawPublishedTo = req.query.publishedTo as string | undefined;

    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(String(req.query.pageSize), 10) || DEFAULT_PAGE_SIZE)
    );

    const contentType = rawContentType === 'post' || rawContentType === 'comment' ? rawContentType : undefined;
    const replied = rawReplied === 'true' ? true : rawReplied === 'false' ? false : undefined;

    const publishedFromDate = rawPublishedFrom ? new Date(rawPublishedFrom) : null;
    const publishedToDate = rawPublishedTo ? new Date(rawPublishedTo) : null;
    const publishedFrom = publishedFromDate && !Number.isNaN(publishedFromDate.getTime())
      ? publishedFromDate
      : undefined;
    const publishedTo = publishedToDate && !Number.isNaN(publishedToDate.getTime())
      ? publishedToDate
      : undefined;

    const keyword = rawKeyword?.trim() ? rawKeyword.trim() : undefined;

    let platformId: string | undefined;
    if (rawPlatformId) {
      const platform = await prisma.platform.findFirst({
        where: { id: rawPlatformId, enabled: true },
        select: { id: true },
      });
      platformId = platform?.id;
    }

    const where: Record<string, unknown> = {};
    if (platformId) where.platformId = platformId;
    if (contentType) where.contentType = contentType;
    if (typeof replied === 'boolean') where.replied = replied;
    if (publishedFrom || publishedTo) {
      const dateFilter: Record<string, Date> = {};
      if (publishedFrom) dateFilter.gte = publishedFrom;
      if (publishedTo) dateFilter.lte = publishedTo;
      where.publishedAt = dateFilter;
    }
    if (keyword) {
      where.OR = [
        { body: { contains: keyword } },
        { summary: { contains: keyword } },
        { keywordTags: { has: keyword } },
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

    res.json({
      list,
      total,
      page,
      pageSize,
      appliedFilters: {
        platformId,
        contentType,
        replied: typeof replied === 'boolean' ? String(replied) : undefined,
        publishedFrom: publishedFrom?.toISOString(),
        publishedTo: publishedTo?.toISOString(),
        keyword,
        page,
        pageSize,
      },
    });
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
