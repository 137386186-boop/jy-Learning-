type DispatchBiliReplyParams = {
  oid: string;
  message: string;
  type?: number;
  root?: string;
  parent?: string;
};

type BiliViewByBvidResponse = {
  code?: number;
  message?: string;
  data?: { aid?: number | string };
};

const BILI_API_BASE = 'https://api.bilibili.com';

function getBilibiliCookieOrThrow(): string {
  const raw = process.env.BILIBILI_COOKIE || '';
  const normalized = raw
    .replace(/[\r\n\t]+/g, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ')
    .trim();

  if (!normalized) throw new Error('BILIBILI_COOKIE not configured');
  return normalized;
}

function extractBiliCsrf(cookie: string): string {
  const match = cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
  if (!match?.[1]) throw new Error('bili_jct not found in BILIBILI_COOKIE');
  return decodeURIComponent(match[1]);
}

function buildBiliHeaders(cookie: string): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Cookie: cookie,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
}

async function bilibiliApiPostForm<T = unknown>(
  path: string,
  form: URLSearchParams
): Promise<T> {
  const cookie = getBilibiliCookieOrThrow();
  const res = await fetch(`${BILI_API_BASE}${path}`, {
    method: 'POST',
    headers: buildBiliHeaders(cookie),
    body: form.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bilibili API error: ${res.status} ${text}`);
  }

  const data = text ? JSON.parse(text) : {};
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(`Bilibili API business error: ${data.code} ${data.message || ''}`.trim());
  }

  return data as T;
}

async function bilibiliApiGetJson<T = unknown>(path: string): Promise<T> {
  const cookie = getBilibiliCookieOrThrow();
  const res = await fetch(`${BILI_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      ...buildBiliHeaders(cookie),
      'Content-Type': 'application/json; charset=UTF-8',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bilibili API error: ${res.status} ${text}`);
  }

  const data = text ? JSON.parse(text) : {};
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(`Bilibili API business error: ${data.code} ${data.message || ''}`.trim());
  }

  return data as T;
}

async function resolveAidFromBvidIfNeeded(inputOid: string): Promise<string> {
  const oid = String(inputOid || '').trim();
  if (/^[0-9]+$/.test(oid)) return oid;

  const bvidMatch = oid.match(/^(BV[0-9A-Za-z]+)$/i);
  if (!bvidMatch) return oid;

  const bvid = bvidMatch[1];
  const view = await bilibiliApiGetJson<BiliViewByBvidResponse>(
    `/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  );
  const aid = view?.data?.aid;
  if (!aid) {
    throw new Error('Bilibili API business error: unable_to_resolve_aid_from_bvid');
  }
  return String(aid);
}

export async function dispatchBiliReply(params: DispatchBiliReplyParams): Promise<{ rpid?: string }> {
  const cookie = getBilibiliCookieOrThrow();
  const csrf = extractBiliCsrf(cookie);
  const type = Number(params.type || 1);
  const oid = await resolveAidFromBvidIfNeeded(params.oid);

  const form = new URLSearchParams();
  form.set('oid', oid);
  form.set('type', String(type));
  form.set('message', params.message);
  form.set('csrf', csrf);
  form.set('csrf_token', csrf);
  form.set('plat', '1');

  if (params.root) form.set('root', String(params.root));
  if (params.parent) form.set('parent', String(params.parent));

  const data = await bilibiliApiPostForm<{ data?: { rpid_str?: string; rpid?: number | string } }>(
    '/x/v2/reply/add',
    form
  );

  const rpid = data?.data?.rpid_str || (data?.data?.rpid ? String(data.data.rpid) : undefined);
  return { rpid };
}
