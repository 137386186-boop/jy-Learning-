import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { zhihuApiPost } from '../lib/zhihu-oauth';
import { requireAdmin } from '../lib/admin-auth';

const router = Router();
const ZHIHU_SLUG = 'zhihu';

const replyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/reply
 * Body: { contentId: string, text: string }
 * 使用已授权的平台账号对对应内容进行快速回复（发评论）
 */
router.post('/', requireAdmin, replyLimiter, async (req: Request, res: Response) => {
  const { contentId, text } = req.body as { contentId?: string; text?: string };
  if (!contentId || !text || typeof text !== 'string') {
    res.status(400).json({ error: 'contentId and text required' });
    return;
  }
  const content = await prisma.content.findUnique({
    where: { id: contentId },
    include: { platform: { include: { auth: true } } },
  });
  if (!content) {
    res.status(404).json({ error: 'Content not found' });
    return;
  }
  const platform = content.platform;
  const auth = platform.auth;
  if (!auth?.accessToken) {
    res.status(403).json({
      error: 'Platform not authorized',
      platform: platform.slug,
      hint: 'Complete OAuth in admin / OAuth page first',
    });
    return;
  }
  if (platform.slug === ZHIHU_SLUG) {
    try {
      // 知乎发评论接口以开放平台文档为准，此处为示例路径
      const targetType = content.contentType === 'comment' ? 'comment' : 'answer';
      const targetId = content.platformContentId ?? content.id;
      await zhihuApiPost(
        `/comments`,
        auth.accessToken,
        { content: text, target_type: targetType, target_id: targetId }
      );
      await prisma.content.update({
        where: { id: contentId },
        data: { replied: true, repliedAt: new Date() },
      });
      res.json({ ok: true, message: 'Reply sent' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Zhihu API error';
      res.status(502).json({ error: 'Reply failed', detail: msg });
    }
    return;
  }
  res.status(501).json({ error: 'Reply not implemented for this platform', platform: platform.slug });
});

export default router;
