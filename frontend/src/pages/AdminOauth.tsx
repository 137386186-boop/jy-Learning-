import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Typography, message, App, Alert, Tag, Row, Col } from 'antd';
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
  oauthConfigured?: boolean;
  oauthConfigError?: string | null;
  authStatus: string;
  authState?: 'authed' | 'unauthed' | 'unsupported';
  authorizedAt: string | null;
}

export function AdminOauthContent() {
  const [zhihuOk, setZhihuOk] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<PlatformAuth[]>([]);
  const platformGrid = useMemo(() => {
    const supported = platforms.filter((p) => p.oauthSupported);
    const unsupported = platforms.filter((p) => !p.oauthSupported);
    return [...supported, ...unsupported];
  }, [platforms]);
  const [loadingPlatforms, setLoadingPlatforms] = useState(false);
  const hasToken = !!getAdminToken();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('zhihu') === 'ok') {
      setZhihuOk(true);
      message.success('知乎授权成功');
      params.delete('zhihu');
      const q = params.toString();
      window.history.replaceState({}, '', q ? `/admin?${q}` : '/admin');
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
      <div className="admin-platform-grid">
        <Row gutter={[16, 16]}>
          {platformGrid.map((p) => {
          const state = p.authState ?? (p.oauthSupported ? (p.authStatus === 'authed' ? 'authed' : 'unauthed') : 'unsupported');
          const authed = state === 'authed';
          const unsupported = state === 'unsupported';
          const misconfigured = p.oauthSupported && p.oauthConfigured === false;
          return (
            <Col xs={24} md={12} xl={8} key={p.id}>
              <Card
                title={p.name}
                extra={
                  authed ? <Tag color="green">已授权</Tag>
                    : unsupported ? <Tag color="default">暂不支持 OAuth</Tag>
                      : misconfigured ? <Tag color="red">未配置</Tag>
                        : <Tag color="orange">未授权</Tag>
                }
                className="admin-card"
              >
                <p>平台标识：{p.slug}</p>
                {misconfigured && p.oauthConfigError && (
                  <Alert
                    type="error"
                    showIcon
                    message={p.oauthConfigError}
                    style={{ marginBottom: 12 }}
                  />
                )}
                {p.oauthSupported ? (
                  <Button
                    type="primary"
                    onClick={p.slug === 'zhihu' ? goZhihuOAuth : undefined}
                    loading={loading && p.slug === 'zhihu'}
                    disabled={!hasToken || misconfigured}
                    block
                  >
                    前往{p.name}授权
                  </Button>
                ) : (
                  <Paragraph type="secondary">该平台暂不支持 OAuth 自动授权。</Paragraph>
                )}
              </Card>
            </Col>
          );
          })}
        </Row>
      </div>
      {!loadingPlatforms && platforms.length === 0 && (
        <Paragraph type="secondary">暂无平台数据，请先导入内容或确认平台配置。</Paragraph>
      )}
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
