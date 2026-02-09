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
  try {
    const url = new URL(sourceUrl);
    if (platformSlug === 'bilibili') {
      if (contentType === 'comment') {
        const hasRoot = url.searchParams.has('comment_root_id');
        const hasReply = url.hash?.includes('reply');
        if (hasRoot || hasReply) {
          return { url: sourceUrl, auto: false };
        }
        if (!platformContentId) {
          return { url: sourceUrl, auto: false, reason: '缺少 platformContentId' };
        }
        url.searchParams.set('comment_on', '1');
        url.searchParams.set('comment_root_id', platformContentId);
        return {
          url: safeAppendHash(url, `reply${platformContentId}`),
          auto: true,
          reason: '自动定位（B站评论）',
        };
      }
      // post: remove tracking params for cleaner share
      const cleaned = new URL(sourceUrl);
      ['spm_id_from', 'share_tag', 'share_source', 'share_medium'].forEach((k) =>
        cleaned.searchParams.delete(k)
      );
      return {
        url: cleaned.toString(),
        auto: cleaned.toString() !== sourceUrl,
        reason: cleaned.toString() !== sourceUrl ? '已清理跟踪参数' : undefined,
      };
    }
  } catch {
    // fallthrough to generic handling
  }
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
