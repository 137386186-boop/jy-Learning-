export type SyncCollectInput = {
  keywords: string[];
  perKeyword: number;
};

export type SyncCollectItem = {
  platformSlug: string;
  contentType: 'post' | 'comment';
  platformContentId?: string | null;
  authorName: string;
  body: string;
  summary?: string;
  sourceUrl: string;
  publishedAt: string;
  keywordTags: string[];
  likeCount?: number | null;
  commentCount?: number | null;
};

export type SyncCollectResult = {
  items: SyncCollectItem[];
  reason?: string;
};

export type PlatformAdapter = {
  slug: string;
  collect: (input: SyncCollectInput) => Promise<SyncCollectResult>;
};
