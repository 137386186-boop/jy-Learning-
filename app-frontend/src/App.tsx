import { Suspense, lazy, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Modal } from 'antd';

const AppLearning = lazy(() => import('./pages/AppLearning'));
const AppChildToday = lazy(() => import('./pages/AppChildToday'));
const AppReports = lazy(() => import('./pages/AppReports'));

function UnauthorizedListener() {
  const navigate = useNavigate();
  const shownRef = useRef(false);

  useEffect(() => {
    const handler = () => {
      if (shownRef.current) return;
      shownRef.current = true;
      Modal.confirm({
        title: '会话已过期',
        content: '登录状态已失效，请重新登录后继续操作。',
        okText: '去登录',
        cancelText: '稍后',
        centered: true,
        onOk: () => {
          shownRef.current = false;
          navigate('/', { replace: true });
        },
        onCancel: () => {
          shownRef.current = false;
        },
      });
    };
    window.addEventListener('app:unauthorized', handler);
    return () => window.removeEventListener('app:unauthorized', handler);
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <Suspense fallback={<div className="app-suspense-fallback">页面加载中…</div>}>
      <UnauthorizedListener />
      <Routes>
        <Route path="/" element={<AppLearning />} />
        <Route path="/children" element={<AppLearning />} />
        <Route path="/tasks" element={<AppLearning />} />
        <Route path="/reports/:childId" element={<AppReports />} />
        <Route path="/child/:childId" element={<AppChildToday />} />
        <Route path="/child/:childId/today" element={<AppChildToday />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
