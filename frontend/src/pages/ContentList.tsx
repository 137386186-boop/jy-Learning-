import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Select, Input, Space, Typography, Spin, Empty, Tag, Row, Col, Pagination, DatePicker, Alert, Button, message } from 'antd';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { API_BASE } from '../api/base';
import { resolveSourceLink } from '../utils/links';

const API = `${API_BASE}/contents`;

interface Platform {
  id: string;
  name: string;
  slug: string;
}

interface ContentItem {
  id: string;
  contentType: string;
  platformContentId?: string | null;
  authorName: string;
  body: string;
  summary: string | null;
  publishedAt: string;
  sourceUrl: string;
  keywordTags: string[];
  likeCount: number | null;
  commentCount: number | null;
  replied: boolean;
  platform: { id: string; name: string; slug: string };
}

const PAGE_SIZE = 20;
const CONTENT_TYPES = new Set(['post', 'comment']);
const REPLIED_TYPES = new Set(['true', 'false']);

type RepliedFilter = 'true' | 'false';
type ContentTypeFilter = 'post' | 'comment';

interface AppliedFilters {
  platformId?: string;
  contentType?: ContentTypeFilter;
  replied?: RepliedFilter;
  publishedFrom?: string;
  publishedTo?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}

interface ContentListResponse {
  list?: ContentItem[];
  total?: number;
  page?: number;
  pageSize?: number;
  appliedFilters?: AppliedFilters;
}

interface NormalizedQuery {
  platformId?: string;
  contentType?: ContentTypeFilter;
  keyword?: string;
  replied?: RepliedFilter;
  publishedFrom?: string;
  publishedTo?: string;
  page: number;
}

export function normalizeContentListQuery(params: URLSearchParams): NormalizedQuery {
  const rawPlatformId = params.get('platformId')?.trim();
  const rawContentType = params.get('contentType')?.trim();
  const rawKeyword = params.get('keyword')?.trim();
  const rawReplied = params.get('replied')?.trim();
  const rawPublishedFrom = params.get('publishedFrom')?.trim();
  const rawPublishedTo = params.get('publishedTo')?.trim();
  const parsedPage = parseInt(params.get('page') || '1', 10);

  const normalized: NormalizedQuery = {
    page: Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1,
  };

  if (rawPlatformId) normalized.platformId = rawPlatformId;
  if (rawContentType && CONTENT_TYPES.has(rawContentType)) normalized.contentType = rawContentType as ContentTypeFilter;
  if (rawKeyword) normalized.keyword = rawKeyword;
  if (rawReplied && REPLIED_TYPES.has(rawReplied)) normalized.replied = rawReplied as RepliedFilter;

  if (rawPublishedFrom) {
    const dt = dayjs(rawPublishedFrom);
    if (dt.isValid()) normalized.publishedFrom = dt.toISOString();
  }
  if (rawPublishedTo) {
    const dt = dayjs(rawPublishedTo);
    if (dt.isValid()) normalized.publishedTo = dt.toISOString();
  }

  return normalized;
}

export function toContentListSearchParams(query: NormalizedQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.platformId) params.set('platformId', query.platformId);
  if (query.contentType) params.set('contentType', query.contentType);
  if (query.replied) params.set('replied', query.replied);
  if (query.publishedFrom) params.set('publishedFrom', query.publishedFrom);
  if (query.publishedTo) params.set('publishedTo', query.publishedTo);
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.page > 1) params.set('page', String(query.page));
  return params;
}

export default function ContentList() {
  const [searchParams, setSearchParams] = useSearchParams();

  const normalized = normalizeContentListQuery(searchParams);
  const platformId = normalized.platformId;
  const contentType = normalized.contentType;
  const keyword = normalized.keyword || '';
  const replied = normalized.replied;
  const publishedFrom = normalized.publishedFrom;
  const publishedTo = normalized.publishedTo;
  const page = normalized.page;

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [list, setList] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [keywordInput, setKeywordInput] = useState(keyword);
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(() => {
    if (publishedFrom && publishedTo) {
      const start = dayjs(publishedFrom);
      const end = dayjs(publishedTo);
      if (start.isValid() && end.isValid()) return [start, end];
    }
    return null;
  });
  const [platformsReady, setPlatformsReady] = useState(false);
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const updateParams = useCallback((updates: Record<string, string | undefined>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(updates).forEach(([k, v]) => {
        if (v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      });
      if (next.get('page') === '1') next.delete('page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const canonicalQuery = toContentListSearchParams(normalized).toString();
    const currentQuery = searchParams.toString();
    if (currentQuery !== canonicalQuery) {
      setSearchParams(new URLSearchParams(canonicalQuery), { replace: true });
      setFilterNotice('已自动修正无效筛选参数');
    }
  }, [platformId, contentType, replied, publishedFrom, publishedTo, keyword, page, searchParams, setSearchParams]);

  useEffect(() => {
    setKeywordInput(keyword);
  }, [keyword]);

  useEffect(() => {
    if (publishedFrom && publishedTo) {
      const start = dayjs(publishedFrom);
      const end = dayjs(publishedTo);
      if (start.isValid() && end.isValid()) {
        setRange([start, end]);
        return;
      }
    }
    setRange(null);
  }, [publishedFrom, publishedTo]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/platforms`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`加载平台失败（${r.status}）`);
        return r.json();
      })
      .then((data) => {
        const nextPlatforms = Array.isArray(data) ? data : [];
        setPlatforms(nextPlatforms);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setPlatforms([]);
      })
      .finally(() => setPlatformsReady(true));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!platformsReady || !platformId) return;
    const exists = platforms.some((p) => p.id === platformId);
    if (exists) return;
    updateParams({ platformId: undefined, page: '1' });
    setFilterNotice('检测到无效平台参数，已自动移除');
  }, [platformId, platforms, platformsReady, updateParams]);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (platformId) params.set('platformId', platformId);
    if (contentType) params.set('contentType', contentType);
    if (replied) params.set('replied', replied);
    if (publishedFrom) params.set('publishedFrom', publishedFrom);
    if (publishedTo) params.set('publishedTo', publishedTo);
    if (keyword) params.set('keyword', keyword);
    params.set('page', String(page));
    params.set('pageSize', String(PAGE_SIZE));

    fetch(`${API}?${params}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`列表加载失败（${r.status}）`);
        return r.json();
      })
      .then((data: ContentListResponse) => {
        const applied = data.appliedFilters;
        const nextList = Array.isArray(data.list) ? data.list : [];
        const nextTotal = typeof data.total === 'number' ? data.total : 0;

        setList(nextList);
        setTotal(nextTotal);
        setHasLoadedOnce(true);

        if (applied) {
          const expectedNormalized: NormalizedQuery = {
            platformId: applied.platformId,
            contentType: applied.contentType,
            replied: applied.replied,
            publishedFrom: applied.publishedFrom,
            publishedTo: applied.publishedTo,
            keyword: applied.keyword,
            page: Math.max(1, applied.page || 1),
          };
          const currentNormalized: NormalizedQuery = {
            platformId,
            contentType,
            replied,
            publishedFrom,
            publishedTo,
            keyword: keyword || undefined,
            page,
          };
          const expected = toContentListSearchParams(expectedNormalized);
          const current = toContentListSearchParams(currentNormalized);
          if (expected.toString() !== current.toString()) {
            setSearchParams(expected, { replace: true });
            setFilterNotice('筛选参数已按系统规则自动校正');
          }
        }

        if (nextTotal > 0) {
          const maxPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
          if (page > maxPage) {
            updateParams({ page: String(maxPage) });
            setFilterNotice('当前页超出范围，已自动跳转到最后一页');
          }
        }
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setHasLoadedOnce(true);
        setLoadError(e instanceof Error ? e.message : '加载失败，请稍后重试');
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [platformId, contentType, replied, publishedFrom, publishedTo, keyword, page, refreshTick, normalized, setSearchParams, updateParams]);

  const search = () => {
    updateParams({ keyword: keywordInput.trim(), page: '1' });
  };

  const totalLabel = total ? total.toLocaleString('zh-CN') : '0';
  const platformCount = platforms.length;
  const repliedLabel = replied === 'true' ? '已回复' : replied === 'false' ? '待回复' : '全部';
  const copyLink = (url: string) => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    message.success('已复制链接');
  };

  return (
    <div>
      <div className="hero">
        <h2 className="hero-title">学术同路人</h2>
        <p className="hero-subtitle">
          聚合多平台学术讨论与问答，支持精准筛选、快速定位与高效回复。
        </p>
        <div className="hero-stats">
          <div className="stat-card">
            <span className="stat-label">内容总量</span>
            <strong className="stat-value">{totalLabel}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">接入平台</span>
            <strong className="stat-value">{platformCount}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">类型筛选</span>
            <strong className="stat-value">
              {contentType ? (contentType === 'comment' ? '评论' : '帖子') : '全部'}
            </strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">回复状态</span>
            <strong className="stat-value">{repliedLabel}</strong>
          </div>
        </div>
      </div>
      <div className="filter-panel">
        <Space wrap>
        <Select
          placeholder="平台"
          allowClear
          style={{ width: 120 }}
          value={platformId}
          onChange={(v) => updateParams({ platformId: v, page: '1' })}
          options={platforms.map((p) => ({ label: p.name, value: p.id }))}
        />
        <Select
          placeholder="类型"
          allowClear
          style={{ width: 100 }}
          value={contentType}
          onChange={(v) => updateParams({ contentType: v, page: '1' })}
          options={[
            { label: '帖子', value: 'post' },
            { label: '评论', value: 'comment' },
          ]}
        />
        <Select
          placeholder="回复"
          allowClear
          style={{ width: 120 }}
          value={replied}
          onChange={(v) => updateParams({ replied: v, page: '1' })}
          options={[
            { label: '已回复', value: 'true' },
            { label: '待回复', value: 'false' },
          ]}
        />
        <DatePicker.RangePicker
          value={range as [dayjs.Dayjs, dayjs.Dayjs] | null}
          onChange={(values) => {
            if (!values || values.length !== 2 || !values[0] || !values[1]) {
              updateParams({ publishedFrom: undefined, publishedTo: undefined, page: '1' });
              return;
            }
            const start = values[0].startOf('day').toISOString();
            const end = values[1].endOf('day').toISOString();
            updateParams({ publishedFrom: start, publishedTo: end, page: '1' });
          }}
          allowClear
          placeholder={['开始日期', '结束日期']}
        />
        <Input.Search
          placeholder="关键词"
          style={{ width: 200 }}
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onSearch={search}
          allowClear
        />
        </Space>
      </div>
      {filterNotice && (
        <Alert
          type="warning"
          showIcon
          closable
          message={filterNotice}
          onClose={() => setFilterNotice(null)}
          style={{ marginBottom: 16 }}
        />
      )}
      <Alert
        type="info"
        showIcon
        message="内容来自各平台公开信息，详情以原平台链接为准。如发现重复，可在管理后台进行数据去重。"
        style={{ marginBottom: 16 }}
      />
      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={
            <Button size="small" onClick={() => setRefreshTick((v) => v + 1)}>
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      {(loading && !hasLoadedOnce) ? (
        <div style={{ textAlign: 'center', padding: 48, minHeight: 220 }}>
          <Spin size="large" />
        </div>
      ) : list.length === 0 ? (
        <Empty description="暂无内容" />
      ) : (
        <Row gutter={[16, 16]} className="content-grid">
          {list.map((item) => {
            const isComment = item.contentType === 'comment';
            const resolved = resolveSourceLink({
              sourceUrl: item.sourceUrl,
              platformSlug: item.platform?.slug,
              contentType: item.contentType,
              platformContentId: item.platformContentId,
            });
            const hasPreciseLink =
              !isComment ||
              (item.platformContentId && item.sourceUrl?.includes(item.platformContentId));
            const fallbackCommentLink =
              item.platform?.slug === 'bilibili' &&
              isComment &&
              !resolved?.auto &&
              item.platformContentId &&
              /^BV[0-9A-Za-z]+$/.test(item.platformContentId)
                ? `https://www.bilibili.com/video/${item.platformContentId}`
                : null;
            const linkLabel = resolved?.auto ? '定位链接' : '原文';
            return (
              <Col xs={24} sm={24} md={12} lg={8} key={item.id}>
                <Card
                  size="small"
                  title={
                    <Space>
                      <Tag className="pill-tag">{item.platform?.name ?? '-'}</Tag>
                      <Tag className="pill-tag" color={item.contentType === 'comment' ? 'blue' : 'default'}>
                        {item.contentType === 'comment' ? '评论' : '帖子'}
                      </Tag>
                      {!hasPreciseLink && (
                        <Tag color="orange">链接待补全</Tag>
                      )}
                    </Space>
                  }
                  extra={
                    <Link to={`/content/${item.id}`} state={{ item }}>详情</Link>
                  }
                >
                  <div style={{ marginBottom: 8 }}>
                    <Typography.Text type="secondary">{item.authorName}</Typography.Text>
                    <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                      {dayjs(item.publishedAt).format('YYYY-MM-DD HH:mm')}
                    </Typography.Text>
                  </div>
                  <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ marginBottom: 8 }}>
                    {item.summary || item.body}
                  </Typography.Paragraph>
                  {item.keywordTags?.length > 0 && (
                    <Space wrap size="small">
                      {item.keywordTags.slice(0, 5).map((t) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </Space>
                  )}
                  <div style={{ marginTop: 8 }}>
                    {item.likeCount != null && (
                      <Typography.Text type="secondary">赞 {item.likeCount}</Typography.Text>
                    )}
                    {item.commentCount != null && (
                      <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                        评 {item.commentCount}
                      </Typography.Text>
                    )}
                    {item.replied ? (
                      <Tag color="green" style={{ marginLeft: 8 }}>
                        已回复
                      </Tag>
                    ) : (
                      <Tag color="orange" style={{ marginLeft: 8 }}>
                        待回复
                      </Tag>
                    )}
                  </div>
                <div style={{ marginTop: 12 }}>
                  <Space size="small">
                    <a href={resolved?.url || item.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {linkLabel}
                    </a>
                    <Button size="small" onClick={() => copyLink(resolved?.url || item.sourceUrl)}>
                      复制链接
                    </Button>
                    {fallbackCommentLink && (
                      <a href={fallbackCommentLink} target="_blank" rel="noopener noreferrer">
                        回到视频
                      </a>
                    )}
                  </Space>
                  {resolved?.auto && (
                    <Tag color="blue" style={{ marginLeft: 8 }}>
                      自动定位
                    </Tag>
                  )}
                  {resolved?.reason && !resolved.auto && (
                    <Tag color="red" style={{ marginLeft: 8 }}>
                      {resolved.reason}
                    </Tag>
                  )}
                </div>
              </Card>
            </Col>
          );
          })}
        </Row>
      )}
      {total > 0 && (
        <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center' }}>
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            showSizeChanger={false}
            showTotal={(t) => `共 ${t} 条`}
            onChange={(p) => updateParams({ page: String(p) })}
          />
        </div>
      )}
    </div>
  );
}
