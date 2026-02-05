import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, Button, Input, Select, Typography, Spin, message, App, Space, Alert } from 'antd';
import dayjs from 'dayjs';
import { getAdminToken } from '../api/admin';
import { API_BASE } from '../api/base';

const API = `${API_BASE}/contents`;
const REPLY_API = `${API_BASE}/reply`;
const TEMPLATES_API = `${API_BASE}/reply-templates`;

interface ReplyTemplate {
  id: string;
  title: string;
  content: string;
}

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

export default function ContentDetail() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ContentDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);
  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(TEMPLATES_API, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => setTemplates(Array.isArray(data) ? data : []))
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setTemplates([]);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    const controller = new AbortController();
    fetch(`${API}/${id}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then(setDetail)
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setDetail(null);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id]);

  const copyLink = () => {
    if (!detail?.sourceUrl) return;
    navigator.clipboard.writeText(detail.sourceUrl);
    message.success('已复制链接');
  };

  const sendReply = async () => {
    if (!id || !replyText.trim()) {
      message.warning('请输入回复内容');
      return;
    }
    const token = getAdminToken();
    if (!token) {
      message.warning('请先在管理后台登录');
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
          <Typography.Paragraph type="secondary">
            {detail.authorName}
            {detail.authorId && ` (${detail.authorId})`} ·{' '}
            {dayjs(detail.publishedAt).format('YYYY-MM-DD HH:mm')}
          </Typography.Paragraph>
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
            <a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">
              跳转原平台
            </a>
          </div>
        </Card>

        <Card title="快速回复" style={{ marginTop: 16 }} className="detail-card">
          <Typography.Paragraph type="secondary">
            以已授权的平台账号在该内容下发评论（需先在「平台授权」完成知乎授权）。
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
          {templates.length > 0 && (
            <Space style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary">使用模板：</Typography.Text>
              <Select
                placeholder="选择回复模板"
                allowClear
                style={{ width: 200 }}
                options={templates.map((t) => ({ label: t.title, value: t.id }))}
                onChange={(id) => {
                  const t = templates.find((x) => x.id === id);
                  if (t) setReplyText(t.content);
                }}
              />
            </Space>
          )}
          <Input.TextArea
            rows={4}
            placeholder="输入回复内容"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <Button type="primary" onClick={sendReply} loading={replyLoading}>
            发送回复
          </Button>
        </Card>
      </div>
    </App>
  );
}
