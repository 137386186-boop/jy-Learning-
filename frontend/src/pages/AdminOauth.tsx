import { useEffect, useState } from 'react';
import { Card, Button, Space, Typography, message, App, Alert, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { adminFetch, getAdminToken } from '../api/admin';
import { API_BASE } from '../api/base';

const { Title, Paragraph } = Typography;

interface PlatformAuth {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  oauthSupported: boolean;
  authStatus: string;
  authorizedAt: string | null;
}

export function AdminOauthContent() {
  const [zhihuOk, setZhihuOk] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<PlatformAuth[]>([]);
  const [loadingPlatforms, setLoadingPlatforms] = useState(false);
  const hasToken = !!getAdminToken();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('zhihu') === 'ok') {
      setZhihuOk(true);
      message.success('知乎授权成功');
      window.history.replaceState({}, '', '/admin/oauth');
    }
  }, []);

  const loadPlatforms = async () => {
    if (!hasToken) return;
    setLoadingPlatforms(true);
    try {
      const res = await adminFetch(`${API_BASE}/admin/platform-auth`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        setPlatforms(data);
      } else {
        setPlatforms([]);
      }
    } catch {
      setPlatforms([]);
    } finally {
      setLoadingPlatforms(false);
    }
  };

  useEffect(() => {
    if (hasToken) loadPlatforms();
  }, [hasToken, zhihuOk]);

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
      {loadingPlatforms && (
        <Paragraph type="secondary">正在加载平台列表…</Paragraph>
      )}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {platforms.map((p) => {
          const authed = p.authStatus === 'authed';
          return (
            <Card
              key={p.id}
              title={p.name}
              extra={authed ? <Tag color="green">已授权</Tag> : <Tag color="default">未授权</Tag>}
              className="admin-card"
            >
              <p>平台标识：{p.slug}</p>
              {p.oauthSupported ? (
                <Button
                  type="primary"
                  onClick={p.slug === 'zhihu' ? goZhihuOAuth : undefined}
                  loading={loading && p.slug === 'zhihu'}
                  disabled={!hasToken}
                >
                  前往{p.name}授权
                </Button>
              ) : (
                <Paragraph type="secondary">该平台暂不支持 OAuth 自动授权。</Paragraph>
              )}
            </Card>
          );
        })}
        {!loadingPlatforms && platforms.length === 0 && (
          <Paragraph type="secondary">暂无平台数据，请先导入内容或确认平台配置。</Paragraph>
        )}
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
