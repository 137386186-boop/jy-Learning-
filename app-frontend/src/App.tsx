import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

const AppLearning = lazy(() => import('./pages/AppLearning'));
const AppChildToday = lazy(() => import('./pages/AppChildToday'));
const AppReports = lazy(() => import('./pages/AppReports'));

export default function App() {
  return (
    <Suspense fallback={<div className="app-suspense-fallback">页面加载中…</div>}>
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
