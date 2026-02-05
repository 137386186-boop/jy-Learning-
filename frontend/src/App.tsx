import { Suspense, lazy, useEffect, useState } from 'react';
import { Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'antd';
import { getHealthUrl } from './api/base';

const ContentList = lazy(() => import('./pages/ContentList'));
const ContentDetail = lazy(() => import('./pages/ContentDetail'));
const AdminOauth = lazy(() => import('./pages/AdminOauth'));
const Admin = lazy(() => import('./pages/Admin'));

const { Header, Content } = Layout;

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [healthOk, setHealthOk] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    fetch(getHealthUrl(), { signal: controller.signal })
      .then((r) => setHealthOk(r.ok))
      .catch(() => setHealthOk(false))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const menuItems = [
    { key: '/', label: '内容列表', onClick: () => navigate('/') },
    { key: '/admin', label: '管理后台', onClick: () => navigate('/admin') },
    { key: '/admin/oauth', label: '平台授权', onClick: () => navigate('/admin/oauth') },
  ];

  const selectedKey = location.pathname.startsWith('/admin')
    ? location.pathname === '/admin/oauth'
      ? '/admin/oauth'
      : '/admin'
    : '/';

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="app-brand">
          <strong>聚合学术内容</strong>
          <span>Academic Content Hub</span>
        </div>
        <div className={`status-pill ${healthOk === null ? 'status-idle' : healthOk ? 'status-ok' : 'status-bad'}`}>
          <span className="dot" />
          {healthOk === null ? '检测中' : healthOk ? '服务在线' : '服务异常'}
        </div>
        <div className="app-menu" style={{ flex: 1 }}>
          <Menu
            theme="dark"
            mode="horizontal"
            style={{ flex: 1 }}
            selectedKeys={[selectedKey]}
            items={menuItems}
          />
        </div>
      </Header>
      <Content className="app-content">
        <Suspense
          fallback={<div style={{ padding: 48, textAlign: 'center' }}>页面加载中…</div>}
        >
          <Routes>
            <Route path="/" element={<ContentList />} />
            <Route path="/content/:id" element={<ContentDetail />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/oauth" element={<AdminOauth />} />
            <Route
              path="*"
              element={
                <div style={{ padding: 24 }}>
                  <p>页面不存在</p>
                  <Link to="/">返回首页</Link>
                </div>
              }
            />
          </Routes>
        </Suspense>
      </Content>
    </Layout>
  );
}
