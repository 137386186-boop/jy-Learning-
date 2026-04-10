import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Link, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { Layout, Menu } from 'antd';
import { getHealthUrl } from './api/base';

const ContentList = lazy(() => import('./pages/ContentList'));
const ContentDetail = lazy(() => import('./pages/ContentDetail'));
const Admin = lazy(() => import('./pages/Admin'));
const AppLearning = lazy(() => import('./pages/AppLearning'));
const AppChildToday = lazy(() => import('./pages/AppChildToday'));
const AppReports = lazy(() => import('./pages/AppReports'));

const { Header, Content } = Layout;

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const controller = new AbortController();
    fetch(getHealthUrl(), { signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const menuItems = [
    { key: '/', label: '内容列表', onClick: () => navigate('/') },
    { key: '/app', label: '启蒙APP', onClick: () => navigate('/app') },
    { key: '/admin', label: '管理后台', onClick: () => navigate('/admin') },
  ];

  const selectedKey = location.pathname.startsWith('/admin')
    ? '/admin'
    : location.pathname.startsWith('/app')
      ? '/app'
      : '/';

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="app-brand">
          <strong>学术同路人</strong>
          <span>Academic Peers Network</span>
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
            <Route path="/index.html" element={<Navigate to="/" replace />} />
            <Route path="/content/:id" element={<ContentDetail />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/app" element={<AppLearning />} />
            <Route path="/app/children" element={<AppLearning />} />
            <Route path="/app/tasks" element={<AppLearning />} />
            <Route path="/app/reports/:childId" element={<AppReports />} />
            <Route path="/app/child/:childId" element={<AppChildToday />} />
            <Route path="/app/child/:childId/today" element={<AppChildToday />} />
            <Route path="/admin/oauth" element={<Navigate to="/admin?tab=oauth" replace />} />
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
