import { useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { Card, Button, Input, Typography, Spin, message, App, Alert } from 'antd';
import dayjs from 'dayjs';
import { adminFetch, getAdminToken } from '../api/admin';
import { API_BASE } from '../api/base';
import { resolveSourceLink } from '../utils/links';

const API = `${API_BASE}/contents`;
const REPLY_API = `${API_BASE}/reply`;

interface ContentDetailType {
  id: string;
  contentType: string;
  platformContentId: string | null;
  authorName: string;
  authorId: string | null;
  body: string;
  summary: string | null;
  publishedAt: string;
  sourceUrl: string;
  keywordTags: string[];
  likeCount: number | null;
  commentCount: number | null;
  replied: boolean;
  repliedAt: string | null;
  platform: { id: string; name: string; slug: string };
}

type ContentListStateItem = Partial<ContentDetailType> & {
  id: string;
  contentType: string;
  authorName: string;
  body: string;
  publishedAt: string;
  sourceUrl: string;
  platform: { id: string; name: string; slug: string };
};

interface PlatformAuthInfo {
  id: string;
  name: string;
  slug: string;
  oauthSupported: boolean;
  authStatus: string;
  authorizedAt: string | null;
}

export default function ContentDetail() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const listState = (location.state as { item?: ContentListStateItem } | null)?.item;
  const [detail, setDetail] = useState<ContentDetailType | null>(
    listState ? (listState as ContentDetailType) : null
  );
  const [loading, setLoading] = useState(!listState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);
  const [platformAuth, setPlatformAuth] = useState<PlatformAuthInfo | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoadError(null);
    if (!detail) setLoading(true);
    const controller = new AbortController();
    fetch(`${API}/${id}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then(setDetail)
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        if (!detail) setDetail(null);
        setLoadError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!detail || !getAdminToken()) {
      setPlatformAuth(null);
      return;
    }
    adminFetch(`${API_BASE}/admin/platform-auth`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!Array.isArray(data)) {
          setPlatformAuth(null);
          return;
        }
        const matched = data.find(
          (p: PlatformAuthInfo) => p.id === detail.platform?.id || p.slug === detail.platform?.slug
        );
        setPlatformAuth(matched || null);
      })
      .catch(() => setPlatformAuth(null));
  }, [detail]);

  const copyLink = () => {
    if (!detail?.sourceUrl) return;
    navigator.clipboard.writeText(detail.sourceUrl);
    message.success('已复制链接');
  };

  const sendReply = async () => {
    const canReply =
      platformAuth?.oauthSupported && platformAuth?.authStatus === 'authed';
    if (!id || !replyText.trim()) {
      message.warning('请输入回复内容');
      return;
    }
    const token = getAdminToken();
    if (!token) {
      message.warning('请先在管理后台登录');
      return;
    }
    if (!canReply) {
      message.warning('当前平台未完成授权或暂不支持自动回复');
      return;
    }
    setReplyLoading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      headers.Authorization = `Bearer ${token}`;
      const res = await fetch(REPLY_API, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ contentId: id, text: replyText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || data.detail || '发送失败');
        return;
      }
      message.success('回复已发送');
      setReplyText('');
      setDetail((d) => (d ? { ...d, replied: true, repliedAt: new Date().toISOString() } : null));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '网络错误');
    } finally {
      setReplyLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={{ padding: 24 }}>
        <Typography.Text type="secondary">内容不存在</Typography.Text>
        <div style={{ marginTop: 16 }}>
          <Link to="/">返回列表</Link>
        </div>
      </div>
    );
  }

  const isComment = detail.contentType === 'comment';
  const commentId = detail.platformContentId || '';
  const resolved = resolveSourceLink({
    sourceUrl: detail.sourceUrl,
    platformSlug: detail.platform?.slug,
    contentType: detail.contentType,
    platformContentId: detail.platformContentId,
  });
  const hasCommentAnchor = isComment && commentId && detail.sourceUrl?.includes(commentId);
  const linkToUse = resolved?.url || detail.sourceUrl;

  return (
    <App>
      <div>
        <Link to="/">← 返回列表</Link>
        <Card
          style={{ marginTop: 16 }}
          className="detail-card"
          title={
            <span>
              {detail.platform?.name} · {detail.contentType === 'comment' ? '评论' : '帖子'}
            </span>
          }
          extra={
            <Button type="link" onClick={copyLink}>
              复制链接
            </Button>
          }
        >
          {loadError && (
            <Alert
              type="warning"
              message="内容加载较慢，已先展示列表预览数据"
              description="可以稍后刷新重试"
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}
          <Typography.Paragraph type="secondary">
            {detail.authorName}
            {detail.authorId && ` (${detail.authorId})`} ·{' '}
            {dayjs(detail.publishedAt).format('YYYY-MM-DD HH:mm')}
          </Typography.Paragraph>
          {detail.platformContentId && (
            <Typography.Paragraph type="secondary">
              平台内容 ID：{detail.platformContentId}
            </Typography.Paragraph>
          )}
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
            {detail.body}
          </Typography.Paragraph>
          {detail.keywordTags?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {detail.keywordTags.map((t) => (
                <Typography.Text key={t} style={{ marginRight: 8 }}>
                  #{t}
                </Typography.Text>
              ))}
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            {detail.likeCount != null && (
              <Typography.Text type="secondary">赞 {detail.likeCount}</Typography.Text>
            )}
            {detail.commentCount != null && (
              <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                评 {detail.commentCount}
              </Typography.Text>
            )}
            {detail.replied && (
              <Typography.Text type="success" style={{ marginLeft: 12 }}>
                已回复
                {detail.repliedAt && ` · ${dayjs(detail.repliedAt).format('YYYY-MM-DD HH:mm')}`}
              </Typography.Text>
            )}
          </div>
          <div style={{ marginTop: 16 }}>
            <a href={linkToUse} target="_blank" rel="noopener noreferrer">
              {resolved?.auto ? '跳转定位链接' : '跳转原平台'}
            </a>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              {detail.sourceUrl}
            </Typography.Text>
            {resolved?.auto && (
              <Button
                size="small"
                style={{ marginLeft: 12 }}
                onClick={() => {
                  navigator.clipboard.writeText(linkToUse);
                  message.success('已复制定位链接');
                }}
              >
                复制定位链接
              </Button>
            )}
          </div>
          {isComment && !hasCommentAnchor && (
            <Alert
              type="warning"
              message="该评论链接未包含评论定位参数，建议导入时提供精确评论链接。"
              showIcon
              style={{ marginTop: 12 }}
            />
          )}
        </Card>

        <Card title="快速回复" style={{ marginTop: 16 }} className="detail-card">
          <Typography.Paragraph type="secondary">
            将以 {detail.platform?.name} 的授权账号身份回复该内容。
          </Typography.Paragraph>
          {!getAdminToken() && (
            <Alert
              type="warning"
              message="当前未登录管理员账号，请先进入管理后台登录"
              showIcon
              style={{ marginBottom: 12 }}
              action={<Link to="/admin">去登录</Link>}
            />
          )}
          {getAdminToken() && platformAuth && !platformAuth.oauthSupported && (
            <Alert
              type="info"
              message={`该平台暂不支持自动回复（${detail.platform?.name}）`}
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}
          {getAdminToken() && platformAuth?.oauthSupported && platformAuth.authStatus !== 'authed' && (
            <Alert
              type="warning"
              message={`尚未完成 ${detail.platform?.name} 授权，无法自动回复`}
              showIcon
              style={{ marginBottom: 12 }}
              action={<Link to="/admin/oauth">去授权</Link>}
            />
          )}
          <Input.TextArea
            rows={4}
            placeholder="输入回复内容"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <Button
            type="primary"
            onClick={sendReply}
            loading={replyLoading}
            disabled={!platformAuth || !platformAuth.oauthSupported || platformAuth.authStatus !== 'authed'}
          >
            发送回复
          </Button>
        </Card>
      </div>
    </App>
  );
}
