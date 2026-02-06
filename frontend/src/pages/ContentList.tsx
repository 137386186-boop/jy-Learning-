import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, Select, Input, Space, Typography, Spin, Empty, Tag, Row, Col, Pagination, DatePicker, Alert } from 'antd';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { API_BASE } from '../api/base';

const API = `${API_BASE}/contents`;

interface Platform {
  id: string;
  name: string;
  slug: string;
}

interface ContentItem {
  id: string;
  contentType: string;
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

export default function ContentList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const platformId = searchParams.get('platformId') || undefined;
  const contentType = searchParams.get('contentType') || undefined;
  const keyword = searchParams.get('keyword') || '';
  const replied = searchParams.get('replied') || undefined;
  const publishedFrom = searchParams.get('publishedFrom') || undefined;
  const publishedTo = searchParams.get('publishedTo') || undefined;
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [list, setList] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [keywordInput, setKeywordInput] = useState(keyword);
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(() => {
    if (publishedFrom && publishedTo) {
      const start = dayjs(publishedFrom);
      const end = dayjs(publishedTo);
      if (start.isValid() && end.isValid()) return [start, end];
    }
    return null;
  });
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
    const controller = new AbortController();
    fetch(`${API}/platforms`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => setPlatforms(Array.isArray(data) ? data : []))
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setPlatforms([]);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setLoading(true);
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
      .then((r) => r.json())
      .then((data) => {
        setList(data.list ?? []);
        setTotal(data.total ?? 0);
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setList([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [platformId, contentType, replied, publishedFrom, publishedTo, keyword, page]);

  const search = () => {
    updateParams({ keyword: keywordInput.trim(), page: '1' });
  };

  const totalLabel = total ? total.toLocaleString('zh-CN') : '0';
  const platformCount = platforms.length;
  const repliedLabel = replied === 'true' ? '已回复' : replied === 'false' ? '待回复' : '全部';

  return (
    <div>
      <div className="hero">
        <h2 className="hero-title">学术内容聚合平台</h2>
        <p className="hero-subtitle">
          统一查看多平台的学术讨论与问题，支持关键词筛选与快速回复。
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
      <Alert
        type="info"
        showIcon
        message="内容来自各平台公开信息，详情以原平台链接为准。如发现重复，可在管理后台进行数据去重。"
        style={{ marginBottom: 16 }}
      />
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : list.length === 0 ? (
        <Empty description="暂无内容" />
      ) : (
        <Row gutter={[16, 16]} className="content-grid">
          {list.map((item) => (
            <Col xs={24} sm={24} md={12} lg={8} key={item.id}>
              <Card
                size="small"
                title={
                  <Space>
                    <Tag className="pill-tag">{item.platform?.name ?? '-'}</Tag>
                    <Tag className="pill-tag" color={item.contentType === 'comment' ? 'blue' : 'default'}>
                      {item.contentType === 'comment' ? '评论' : '帖子'}
                    </Tag>
                  </Space>
                }
                extra={
                  <Link to={`/content/${item.id}`}>详情</Link>
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
              </Card>
            </Col>
          ))}
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
