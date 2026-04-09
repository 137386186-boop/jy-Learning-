import { createHash } from 'crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

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

type BiliNavResponse = {
  code?: number;
  message?: string;
  data?: {
    wbi_img?: {
      img_url?: string;
      sub_url?: string;
    };
  };
};

type BrowserFetchResult = {
  ok: boolean;
  status: number;
  text: string;
};

const BILI_API_BASE = 'https://api.bilibili.com';
const BILI_SEND_MODE = (process.env.BILI_SEND_MODE || 'browser').toLowerCase();

const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let browserSession: { browser: Browser; context: BrowserContext; page: Page } | null = null;
let browserSessionPromise: Promise<{ browser: Browser; context: BrowserContext; page: Page }> | null = null;

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

function sanitizeWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

function getWbiMixinKey(imgKey: string, subKey: string): string {
  const origin = `${imgKey}${subKey}`;
  return WBI_MIXIN_KEY_ENC_TAB.map((i) => origin[i] || '').join('').slice(0, 32);
}

function getFileStem(url?: string): string {
  if (!url) return '';
  const clean = url.split('?')[0] || '';
  const last = clean.split('/').pop() || '';
  return last.replace(/\.[^.]+$/, '');
}

async function getWbiSignedFormFields(baseFields: Record<string, string>): Promise<{ w_rid: string; wts: string }> {
  const nav = await bilibiliApiGetJson<BiliNavResponse>('/x/web-interface/nav');
  const imgKey = getFileStem(nav?.data?.wbi_img?.img_url);
  const subKey = getFileStem(nav?.data?.wbi_img?.sub_url);
  if (!imgKey || !subKey) {
    throw new Error('Bilibili API business error: unable_to_get_wbi_keys');
  }

  const mixinKey = getWbiMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000).toString();
  const query = new URLSearchParams();

  Object.entries({ ...baseFields, wts })
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([k, v]) => {
      query.set(k, sanitizeWbiValue(String(v ?? '')));
    });

  const wRid = createHash('md5').update(`${query.toString()}${mixinKey}`).digest('hex');
  return { w_rid: wRid, wts };
}

function parseCookieHeaderToContextCookies(cookieHeader: string) {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: '.bilibili.com',
        path: '/',
        secure: true,
      };
    })
    .filter(Boolean) as Array<{ name: string; value: string; domain: string; path: string; secure: boolean }>;
}

function getBrowserTimeoutMs(): number {
  const parsed = Number(process.env.BILI_BROWSER_TIMEOUT_MS || 8000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}

function shouldReuseBrowser(): boolean {
  return (process.env.BILI_BROWSER_REUSE || '1') !== '0';
}

async function createBrowserSession() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  return { browser, context, page };
}

async function closeReusableBrowserSession() {
  if (!browserSession) return;
  const current = browserSession;
  browserSession = null;
  await current.context.close().catch(() => {});
  await current.browser.close().catch(() => {});
}

async function getReusableBrowserSession() {
  if (browserSession) return browserSession;
  if (!browserSessionPromise) {
    browserSessionPromise = createBrowserSession()
      .then((session) => {
        browserSession = session;
        return session;
      })
      .finally(() => {
        browserSessionPromise = null;
      });
  }
  return browserSessionPromise;
}

async function withBrowserPage<T>(cookie: string, run: (page: Page) => Promise<T>): Promise<T> {
  if (shouldReuseBrowser()) {
    const session = await getReusableBrowserSession();
    await session.context.clearCookies();
    await session.context.addCookies(parseCookieHeaderToContextCookies(cookie));
    return run(session.page);
  }

  const session = await createBrowserSession();
  try {
    await session.context.clearCookies();
    await session.context.addCookies(parseCookieHeaderToContextCookies(cookie));
    return await run(session.page);
  } finally {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }
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

function buildReplyFormFields(input: { csrf: string; message: string; oid: string; parent?: string; root?: string; type: number }) {
  return {
    csrf: input.csrf,
    csrf_token: input.csrf,
    gaia_source: 'main_web',
    message: input.message,
    oid: input.oid,
    parent: input.parent ? String(input.parent) : '0',
    plat: '1',
    root: input.root ? String(input.root) : '0',
    statistics: '{"appId":1,"platform":3,"version":""}',
    type: String(input.type),
    at_name_to_mid: '{}',
    b_wet: '7',
    dm_cover_img_str: '',
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    dm_img_list: '[]',
    dm_img_str: '',
  };
}

function parseReplyResult(text: string): { rpid?: string } {
  const data = text ? JSON.parse(text) : {};
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new Error(`Bilibili API business error: ${data.code} ${data.message || ''}`.trim());
  }
  const rpid = data?.data?.rpid_str || (data?.data?.rpid ? String(data.data.rpid) : undefined);
  return { rpid };
}

async function dispatchViaHttp(params: DispatchBiliReplyParams): Promise<{ rpid?: string }> {
  const cookie = getBilibiliCookieOrThrow();
  const csrf = extractBiliCsrf(cookie);
  const type = Number(params.type || 1);
  const oid = await resolveAidFromBvidIfNeeded(params.oid);
  const baseFields = buildReplyFormFields({
    csrf,
    message: params.message,
    oid,
    parent: params.parent,
    root: params.root,
    type,
  });

  const { w_rid, wts } = await getWbiSignedFormFields(baseFields);
  const form = new URLSearchParams();
  Object.entries({ ...baseFields, w_rid, wts }).forEach(([k, v]) => form.set(k, v));

  const data = await bilibiliApiPostForm<{ data?: { rpid_str?: string; rpid?: number | string } }>(
    '/x/v2/reply/add',
    form
  );
  const rpid = data?.data?.rpid_str || (data?.data?.rpid ? String(data.data.rpid) : undefined);
  return { rpid };
}

async function dispatchViaBrowserContext(params: DispatchBiliReplyParams): Promise<{ rpid?: string }> {
  const cookie = getBilibiliCookieOrThrow();
  const csrf = extractBiliCsrf(cookie);
  const type = Number(params.type || 1);
  const oid = await resolveAidFromBvidIfNeeded(params.oid);
  const baseFields = buildReplyFormFields({
    csrf,
    message: params.message,
    oid,
    parent: params.parent,
    root: params.root,
    type,
  });

  const { w_rid, wts } = await getWbiSignedFormFields(baseFields);
  const formBody = new URLSearchParams({ ...baseFields, w_rid, wts }).toString();
  const timeoutMs = getBrowserTimeoutMs();

  const runOnce = async () => {
    const result = await withBrowserPage(cookie, async (page) => {
      return page.evaluate(
        async ({ body, timeout }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          try {
            const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              },
              body,
              signal: controller.signal,
            });
            const text = await res.text();
            return { ok: res.ok, status: res.status, text } as BrowserFetchResult;
          } finally {
            clearTimeout(timer);
          }
        },
        { body: formBody, timeout: timeoutMs }
      );
    });

    if (!result.ok) {
      throw new Error(`Bilibili API error: ${result.status} ${result.text}`);
    }

    return parseReplyResult(result.text);
  };

  return runOnce();
}

export async function dispatchBiliReply(params: DispatchBiliReplyParams): Promise<{ rpid?: string }> {
  if (BILI_SEND_MODE === 'http') {
    return dispatchViaHttp(params);
  }
  return dispatchViaBrowserContext(params);
}
