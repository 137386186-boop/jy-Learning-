import { useEffect, useState } from 'react';
import { Card, Button, Space, Typography, message, App, Alert } from 'antd';
import { Link } from 'react-router-dom';
import { adminFetch, getAdminToken } from '../api/admin';
import { API_BASE } from '../api/base';

const { Title, Paragraph } = Typography;

export function AdminOauthContent() {
  const [zhihuOk, setZhihuOk] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasToken = !!getAdminToken();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('zhihu') === 'ok') {
      setZhihuOk(true);
      message.success('知乎授权成功');
      window.history.replaceState({}, '', '/admin/oauth');
    }
  }, []);

  const goZhihuOAuth = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await adminFetch(`${API_BASE}/oauth/zhihu/url`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '获取授权链接失败');
        return;
      }
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError('未返回授权链接');
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '24px 0', minHeight: 280 }}>
      <Title level={3}>平台 OAuth 授权</Title>
      <Paragraph type="secondary">
        完成授权后，可在内容详情页使用「快速回复」以该平台账号发评论。
      </Paragraph>
      {!hasToken && (
        <Alert
          type="warning"
          message="请先登录管理员账号后再进行授权"
          showIcon
          style={{ marginBottom: 16 }}
          action={<Link to="/admin">去登录</Link>}
        />
      )}
      {error && (
        <Paragraph type="danger" style={{ marginBottom: 16 }}>
          {error}
        </Paragraph>
      )}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card title="知乎" extra={zhihuOk ? <span style={{ color: '#52c41a' }}>已授权</span> : null} className="admin-card">
          <p>用于在知乎回答/评论下快速回复。</p>
          <Button type="primary" onClick={goZhihuOAuth} loading={loading} disabled={!hasToken}>
            前往知乎授权
          </Button>
        </Card>
      </Space>
      <div style={{ marginTop: 24 }}>
        <Link to="/">返回首页</Link>
      </div>
    </div>
  );
}

export default function AdminOauth() {
  return (
    <App>
      <AdminOauthContent />
    </App>
  );
}
