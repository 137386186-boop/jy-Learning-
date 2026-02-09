import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_KEYWORDS = [
  'SCI',
  '论文',
  '专利',
  '投稿',
  '发表论文',
  '发表期刊',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const map = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith('--')) continue;
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
    map.set(key.replace(/^--/, ''), value);
  }
  const keywords = (map.get('keywords') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const platforms = (map.get('platforms') || 'bilibili,zhihu')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const perKeyword = Number(map.get('perKeyword') || 100);
  const commentsPerPost = Number(map.get('commentsPerPost') || 5);
  const out = map.get('out') || path.resolve(process.cwd(), 'output.json');
  const headful = map.get('headful') === 'true';
  return {
    keywords: keywords.length ? keywords : DEFAULT_KEYWORDS,
    platforms,
    perKeyword: Number.isFinite(perKeyword) ? perKeyword : 100,
    commentsPerPost: Number.isFinite(commentsPerPost) ? commentsPerPost : 5,
    out,
    headful,
  };
}

function stripHtml(input = '') {
  return input.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function uniquePush(items, seen, key, data) {
  if (seen.has(key)) return;
  seen.add(key);
  items.push(data);
}

async function fetchJson(url, options = {}) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    ...(options.headers || {}),
  };
  if (options.request) {
    const res = await options.request.get(url, { headers });
    if (!res.ok()) throw new Error(`Request failed: ${res.status()}`);
    return res.json();
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function collectBilibili(keyword, perKeyword, commentsPerPost, items, seen, biliClient) {
  let page = 1;
  let collected = 0;
  while (collected < perKeyword) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
      keyword
    )}&page=${page}&page_size=20`;
    const data = await fetchJson(url, biliClient ? { request: biliClient.request, headers: biliClient.headers } : {});
    const result = data?.data?.result || [];
    if (!Array.isArray(result) || result.length === 0) break;
    for (const r of result) {
      if (collected >= perKeyword) break;
      const bvid = r.bvid;
      const aid = r.aid;
      const title = stripHtml(r.title || r.description || '');
      const author = r.author || 'B站用户';
      const pub = r.pubdate ? new Date(r.pubdate * 1000).toISOString() : new Date().toISOString();
      const sourceUrl = `https://www.bilibili.com/video/${bvid}`;
      uniquePush(
        items,
        seen,
        `bilibili:post:${bvid}`,
        {
          platformSlug: 'bilibili',
          contentType: 'post',
          platformContentId: bvid,
          authorName: author,
          body: title || stripHtml(r.description || ''),
          summary: title || stripHtml(r.description || ''),
          sourceUrl,
          publishedAt: pub,
          keywordTags: [keyword],
          likeCount: r.like ?? null,
          commentCount: r.review ?? null,
        }
      );
      collected += 1;

      if (commentsPerPost > 0 && aid) {
        const replyUrl = `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=${commentsPerPost}`;
        try {
          const replyData = await fetchJson(
            replyUrl,
            biliClient ? { request: biliClient.request, headers: biliClient.headers } : {}
          );
          const replies = replyData?.data?.replies || [];
          if (Array.isArray(replies)) {
            for (const reply of replies) {
              const rpid = reply.rpid;
              if (!rpid) continue;
              const message = reply.content?.message || '';
              const uname = reply.member?.uname || 'B站用户';
              const ctime = reply.ctime ? new Date(reply.ctime * 1000).toISOString() : new Date().toISOString();
              const commentUrl = `${sourceUrl}?comment_on=1&comment_root_id=${rpid}#reply${rpid}`;
              uniquePush(
                items,
                seen,
                `bilibili:comment:${rpid}`,
                {
                  platformSlug: 'bilibili',
                  contentType: 'comment',
                  platformContentId: String(rpid),
                  authorName: uname,
                  body: message,
                  summary: message.slice(0, 120),
                  sourceUrl: commentUrl,
                  publishedAt: ctime,
                  keywordTags: [keyword],
                  likeCount: reply.like ?? null,
                  commentCount: reply.reply_count ?? null,
                }
              );
            }
          }
        } catch {
          // ignore comment fetch failures
        }
      }
    }
    page += 1;
  }
}

async function autoScroll(page, limit = 6) {
  for (let i = 0; i < limit; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
  }
}

async function collectZhihu(keyword, perKeyword, items, seen, browser) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`, {
    waitUntil: 'domcontentloaded',
  });
  await autoScroll(page, 8);
  const results = await page.$$eval('a[href*="zhihu.com/question"]', (els) =>
    els
      .map((el) => ({
        href: el.getAttribute('href') || '',
        text: (el.textContent || '').trim(),
      }))
      .filter((r) => r.href)
  );
  let collected = 0;
  for (const r of results) {
    if (collected >= perKeyword) break;
    const href = r.href.startsWith('http') ? r.href : `https://www.zhihu.com${r.href}`;
    const clean = href.split('?')[0];
    const answerMatch = clean.match(/\/answer\/(\d+)/);
    const questionMatch = clean.match(/\/question\/(\d+)/);
    const platformContentId = answerMatch?.[1] || questionMatch?.[1];
    if (!platformContentId) continue;
    const title = r.text || `知乎内容 ${platformContentId}`;
    uniquePush(
      items,
      seen,
      `zhihu:post:${platformContentId}`,
      {
        platformSlug: 'zhihu',
        contentType: 'post',
        platformContentId,
        authorName: '知乎用户',
        body: title,
        summary: title.slice(0, 120),
        sourceUrl: clean,
        publishedAt: new Date().toISOString(),
        keywordTags: [keyword],
      }
    );
    collected += 1;
  }
  await page.close();
}

async function main() {
  const { keywords, platforms, perKeyword, commentsPerPost, out, headful } = parseArgs();
  const items = [];
  const seen = new Set();
  const useZhihu = platforms.includes('zhihu');
  const useBilibili = platforms.includes('bilibili');
  const launchOptions = { headless: !headful };
  if (process.env.USE_SYSTEM_CHROME === '1') {
    launchOptions.channel = 'chrome';
  }
  const browser = useZhihu || useBilibili ? await chromium.launch(launchOptions) : null;
  let biliClient = null;

  try {
    if (useBilibili && browser) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded' });
      const cookieHeader = process.env.BILIBILI_COOKIE || '';
      biliClient = {
        request: context.request,
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
      };
      await page.close();
    }
    for (const keyword of keywords) {
      if (useBilibili) {
        await collectBilibili(keyword, perKeyword, commentsPerPost, items, seen, biliClient);
      }
      if (useZhihu && browser) {
        await collectZhihu(keyword, perKeyword, items, seen, browser);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  fs.writeFileSync(out, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`Collected ${items.length} items -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
