/**
 * 知乎 OAuth 2.0 辅助
 * 授权文档以知乎开放平台当前为准：https://www.zhihu.com/org/signup
 */

const ZHIHU_AUTH_BASE = 'https://www.zhihu.com/oauth';
const ZHIHU_API_BASE = 'https://api.zhihu.com';

export function getZhihuAuthUrl(redirectUri: string, state?: string): string {
  const clientId = process.env.ZHIHU_CLIENT_ID;
  if (!clientId) throw new Error('ZHIHU_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'read:user',
    state: state ?? '',
  });
  return `${ZHIHU_AUTH_BASE}/authorize?${params.toString()}`;
}

export interface ZhihuTokenResult {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeZhihuCode(
  code: string,
  redirectUri: string
): Promise<ZhihuTokenResult> {
  const clientId = process.env.ZHIHU_CLIENT_ID;
  const clientSecret = process.env.ZHIHU_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('ZHIHU OAuth not configured');
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${ZHIHU_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zhihu token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as ZhihuTokenResult;
}

/**
 * 使用 access_token 调用知乎 API（如发评论）
 * 发评论需知乎开放平台授予对应接口权限
 */
export async function zhihuApiGet<T = unknown>(
  path: string,
  accessToken: string
): Promise<T> {
  const res = await fetch(`${ZHIHU_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Zhihu API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function zhihuApiPost<T = unknown>(
  path: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${ZHIHU_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zhihu API error: ${res.status} ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}
