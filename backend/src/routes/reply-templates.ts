import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

/** GET /api/reply-templates — 回复模板列表（快速回复选用） */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await prisma.replyTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, content: true },
    });
    res.json(list);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: msg });
  }
});

export default router;
