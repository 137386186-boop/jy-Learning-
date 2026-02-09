export type SourceLinkInput = {
  sourceUrl: string;
  platformSlug?: string | null;
  contentType?: string | null;
  platformContentId?: string | null;
};

export type ResolvedLink = {
  url: string;
  auto: boolean;
  reason?: string;
};

function safeAppendHash(url: URL, hash: string): string {
  if (!hash) return url.toString();
  url.hash = hash.startsWith('#') ? hash : `#${hash}`;
  return url.toString();
}

export function resolveSourceLink(input: SourceLinkInput): ResolvedLink | null {
  const { sourceUrl, platformSlug, contentType, platformContentId } = input;
  if (!sourceUrl) return null;
  if (contentType !== 'comment') {
    return { url: sourceUrl, auto: false };
  }
  if (platformContentId && sourceUrl.includes(platformContentId)) {
    return { url: sourceUrl, auto: false };
  }
  if (!platformContentId) {
    return { url: sourceUrl, auto: false, reason: '缺少 platformContentId' };
  }
  try {
    const url = new URL(sourceUrl);
    if (url.hash) return { url: sourceUrl, auto: false };
    if (platformSlug === 'zhihu') {
      return {
        url: safeAppendHash(url, `comment-${platformContentId}`),
        auto: true,
        reason: '自动定位（知乎）',
      };
    }
    return {
      url: safeAppendHash(url, `comment-${platformContentId}`),
      auto: true,
      reason: '自动定位（通用锚点，可能不准确）',
    };
  } catch {
    return { url: sourceUrl, auto: false };
  }
}
