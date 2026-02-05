import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import {
  getZhihuAuthUrl,
  exchangeZhihuCode,
  type ZhihuTokenResult,
} from '../lib/zhihu-oauth';
import { requireAdmin } from '../lib/admin-auth';

const router = Router();
const oauthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const ZHIHU_SLUG = 'zhihu';

function getCallbackUrl(req: Request, path: string): string {
  const host = req.get('host') ?? 'localhost:3001';
  const proto = req.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}${path}`;
}

/** state 格式: random.redirectUriBase64，回调时解析出 redirect_uri */
function encodeState(redirectUri: string): string {
  const nonce = randomBytes(12).toString('hex');
  const b64 = Buffer.from(redirectUri, 'utf8').toString('base64url');
  return `${nonce}.${b64}`;
}

function decodeState(state: string): string | null {
  const dot = state.indexOf('.');
  if (dot === -1) return null;
  try {
    return Buffer.from(state.slice(dot + 1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** GET /api/oauth/zhihu/url — 返回知乎授权页 URL（供前端 location.href，避免整页跳到 /api 导致白屏） */
router.get('/zhihu/url', requireAdmin, oauthLimiter, (req: Request, res: Response) => {
  try {
    const callbackPath = '/api/oauth/zhihu/callback';
    const redirectUri = getCallbackUrl(req, callbackPath);
    const state = encodeState(redirectUri);
    const url = getZhihuAuthUrl(redirectUri, state);
    res.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OAuth config error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/oauth/zhihu — 直接 302 跳转到知乎授权页；浏览器直连时返回 HTML 跳转页避免白屏 */
router.get('/zhihu', requireAdmin, oauthLimiter, (req: Request, res: Response) => {
  try {
    const callbackPath = '/api/oauth/zhihu/callback';
    const redirectUri = getCallbackUrl(req, callbackPath);
    const state = encodeState(redirectUri);
    const url = getZhihuAuthUrl(redirectUri, state);
    const accept = (req.get('accept') || '').toLowerCase();
    if (accept.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${encodeURI(url)}"><title>跳转中</title></head><body><p>正在跳转到知乎授权…</p><p><a href="${url.replace(/"/g, '&quot;')}">若未自动跳转请点击此处</a></p></body></html>`
      );
      return;
    }
    res.redirect(302, url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OAuth config error';
    res.status(500).json({ error: msg });
  }
});

/** GET /api/oauth/zhihu/callback — 知乎回调，存 token 并更新 PlatformAuth */
router.get('/zhihu/callback', async (req: Request, res: Response) => {
  const { code, state: queryState } = req.query as { code?: string; state?: string };
  const redirectUri = queryState ? decodeState(queryState) : null;
  if (!code || !redirectUri) {
    res.status(400).send('Invalid callback: missing code or state');
    return;
  }
  try {
    const token: ZhihuTokenResult = await exchangeZhihuCode(code, redirectUri);
    const platform = await prisma.platform.findFirst({ where: { slug: ZHIHU_SLUG } });
    if (!platform) {
      res.status(500).send('Platform zhihu not found in database');
      return;
    }
    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;
    await prisma.platformAuth.upsert({
      where: { platformId: platform.id },
      create: {
        platformId: platform.id,
        status: 'authed',
        authorizedAt: new Date(),
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt,
      },
      update: {
        status: 'authed',
        authorizedAt: new Date(),
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresAt,
      },
    });
    const frontOrigin =
      process.env.FRONTEND_ORIGIN ||
      (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',')[0].trim() : '') ||
      'http://localhost:3000';
    res.redirect(`${frontOrigin}/admin/oauth?zhihu=ok`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Token exchange failed';
    res.status(500).send(`OAuth error: ${msg}`);
  }
});

export default router;
