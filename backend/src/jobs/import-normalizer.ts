import { createHash } from 'crypto';
import { prisma } from '../lib/prisma';

export type ImportItemError = { index: number; reason: string };

export type ImportBatchResult = {
  total: number;
  inserted: number;
  invalid: number;
  skipped: number;
  errors: ImportItemError[];
  hasValidItems: boolean;
};

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function toTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(/[,，;；\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function toDate(input: unknown): Date | null {
  if (!input) return null;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isBilibiliVideoUrl(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    if (host.startsWith('search.')) return false;
    if (!host.endsWith('bilibili.com')) return false;
    return url.pathname.startsWith('/video/');
  } catch {
    return false;
  }
}

export function isNumericId(input: string | null | undefined): boolean {
  if (!input) return false;
  return /^[0-9]+$/.test(input);
}

export function extractCommentIdFromUrl(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    const rootId = url.searchParams.get('comment_root_id');
    if (rootId && isNumericId(rootId)) return rootId;
    const hash = url.hash || '';
    let match = hash.match(/reply(\d+)/);
    if (match && isNumericId(match[1])) return match[1];
    match = hash.match(/comment-(\d+)/);
    if (match && isNumericId(match[1])) return match[1];
  } catch {
    return null;
  }
  return null;
}

function isValidSourceUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (!url.hostname) return false;
    const path = url.pathname?.trim() ?? '';
    return path.length > 1 && path !== '/';
  } catch {
    return false;
  }
}

function isTemplateOrPlaceholderUrl(input: string): boolean {
  const lower = input.toLowerCase();
  return (
    lower.includes('example.com') ||
    lower.includes('localhost') ||
    lower.includes('/demo/') ||
    lower.includes('demo-') ||
    lower.includes('replace_me') ||
    lower.includes('your-url') ||
    lower.includes('{id}') ||
    lower.includes('<id>') ||
    lower.includes('{{')
  );
}

function validateSourceUrlForPlatform(params: {
  platformSlug?: string | null;
  sourceUrl: string;
  contentType: 'post' | 'comment';
  platformContentId?: string | null;
}): string | null {
  const { platformSlug, sourceUrl, contentType, platformContentId } = params;
  if (!isValidSourceUrl(sourceUrl)) {
    return 'sourceUrl must be a direct link to a specific post/comment';
  }
  if (isTemplateOrPlaceholderUrl(sourceUrl)) {
    return 'sourceUrl looks like template/demo placeholder and is not allowed';
  }
  if (platformSlug === 'bilibili' && !isBilibiliVideoUrl(sourceUrl)) {
    return 'bilibili sourceUrl must be a video page, not search results';
  }
  if (contentType === 'comment' && platformContentId && !sourceUrl.includes(platformContentId)) {
    return 'comment sourceUrl must include platformContentId for precise定位';
  }
  if (platformSlug === 'bilibili' && contentType === 'comment' && !isNumericId(platformContentId)) {
    return 'bilibili comment platformContentId must be numeric comment_root_id';
  }
  return null;
}

export async function importContentsBatch(items: unknown[]): Promise<ImportBatchResult> {
  const slugs = Array.from(
    new Set(
      items
        .map((it) => (it && typeof it === 'object' ? (it as any).platformSlug : null))
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v: string) => v.trim())
    )
  );

  const platformMap = new Map<string, string>();
  if (slugs.length > 0) {
    const exist = await prisma.platform.findMany({ where: { slug: { in: slugs } } });
    exist.forEach((p) => platformMap.set(p.slug, p.id));
    const missing = slugs.filter((s) => !platformMap.has(s));
    for (const slug of missing) {
      const created = await prisma.platform.create({
        data: { slug, name: slug },
        select: { id: true, slug: true },
      });
      platformMap.set(created.slug, created.id);
    }
  }

  const normalized: {
    index: number;
    data: {
      platformId: string;
      contentType: 'post' | 'comment';
      platformContentId?: string | null;
      authorName: string;
      authorId?: string | null;
      authorAvatar?: string | null;
      body: string;
      bodyMd5: string;
      publishedAt: Date;
      sourceUrl: string;
      keywordTags: string[];
      likeCount?: number | null;
      commentCount?: number | null;
      summary?: string | null;
    };
  }[] = [];

  const errors: ImportItemError[] = [];

  items.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      errors.push({ index, reason: 'invalid item' });
      return;
    }
    const it = raw as any;
    const platformSlug = it.platformSlug ? String(it.platformSlug).trim() : null;
    const platformId = it.platformId || (it.platformSlug ? platformMap.get(String(it.platformSlug)) : null);
    if (!platformId) {
      errors.push({ index, reason: 'platformId or platformSlug required' });
      return;
    }
    const body = String(it.body || '').trim();
    const authorName = String(it.authorName || '').trim();
    const sourceUrl = String(it.sourceUrl || '').trim();
    const publishedAt = toDate(it.publishedAt);
    if (!body || !authorName || !sourceUrl || !publishedAt) {
      errors.push({ index, reason: 'authorName, body, sourceUrl, publishedAt required' });
      return;
    }
    const contentType = it.contentType === 'comment' ? 'comment' : 'post';
    let platformContentId = it.platformContentId ? String(it.platformContentId) : null;
    if (contentType === 'comment' && !platformContentId) {
      const extracted = extractCommentIdFromUrl(sourceUrl);
      if (extracted) platformContentId = extracted;
    }
    const urlError = validateSourceUrlForPlatform({
      platformSlug,
      sourceUrl,
      contentType,
      platformContentId,
    });
    if (urlError) {
      errors.push({ index, reason: urlError });
      return;
    }
    const likeCount =
      it.likeCount == null || Number.isNaN(Number(it.likeCount)) ? null : Number(it.likeCount);
    const commentCount =
      it.commentCount == null || Number.isNaN(Number(it.commentCount)) ? null : Number(it.commentCount);
    normalized.push({
      index,
      data: {
        platformId,
        contentType,
        platformContentId,
        authorName,
        authorId: it.authorId ? String(it.authorId) : null,
        authorAvatar: it.authorAvatar ? String(it.authorAvatar) : null,
        body,
        bodyMd5: md5(body),
        publishedAt,
        sourceUrl,
        keywordTags: toTags(it.keywordTags),
        likeCount,
        commentCount,
        summary: it.summary ? String(it.summary) : body.slice(0, 120),
      },
    });
  });

  if (normalized.length === 0) {
    return {
      total: items.length,
      inserted: 0,
      invalid: errors.length,
      skipped: 0,
      errors,
      hasValidItems: false,
    };
  }

  const platformIds = Array.from(new Set(normalized.map((n) => n.data.platformId)));
  const platformContentIds = Array.from(
    new Set(normalized.map((n) => n.data.platformContentId).filter((v): v is string => !!v))
  );
  const sourceUrls = Array.from(new Set(normalized.map((n) => n.data.sourceUrl).filter(Boolean)));

  const existingKeys = new Set<string>();
  if (platformContentIds.length > 0) {
    const existByPlatformContentId = await prisma.content.findMany({
      where: {
        platformId: { in: platformIds },
        platformContentId: { in: platformContentIds },
      },
      select: { platformId: true, platformContentId: true },
    });
    existByPlatformContentId.forEach((e) => {
      if (e.platformContentId) existingKeys.add(`pcid:${e.platformId}:${e.platformContentId}`);
    });
  }
  if (sourceUrls.length > 0) {
    const existBySourceUrl = await prisma.content.findMany({
      where: {
        platformId: { in: platformIds },
        sourceUrl: { in: sourceUrls },
      },
      select: { platformId: true, sourceUrl: true },
    });
    existBySourceUrl.forEach((e) => {
      existingKeys.add(`url:${e.platformId}:${e.sourceUrl}`);
    });
  }

  const incomingKeys = new Set<string>();
  const filtered = normalized.filter((n) => {
    const keyByContentId = n.data.platformContentId
      ? `pcid:${n.data.platformId}:${n.data.platformContentId}`
      : null;
    const keyByUrl = `url:${n.data.platformId}:${n.data.sourceUrl}`;
    const isDup = (keyByContentId && existingKeys.has(keyByContentId)) || existingKeys.has(keyByUrl);
    const isIncomingDup =
      (keyByContentId && incomingKeys.has(keyByContentId)) || incomingKeys.has(keyByUrl);
    if (isDup) {
      errors.push({ index: n.index, reason: 'duplicate (platformContentId/sourceUrl)' });
      return false;
    }
    if (isIncomingDup) {
      errors.push({ index: n.index, reason: 'duplicate inside import batch' });
      return false;
    }
    if (keyByContentId) incomingKeys.add(keyByContentId);
    incomingKeys.add(keyByUrl);
    return true;
  });

  const result = await prisma.content.createMany({
    data: filtered.map((n) => n.data),
    skipDuplicates: true,
  });

  return {
    total: items.length,
    inserted: result.count,
    invalid: errors.length,
    skipped: normalized.length - filtered.length,
    errors,
    hasValidItems: true,
  };
}
