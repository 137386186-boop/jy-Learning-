import { Navigate, Route, Routes } from 'react-router-dom';
import AppLearning from './pages/AppLearning';
import AppChildToday from './pages/AppChildToday';
import AppReports from './pages/AppReports';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLearning />} />
      <Route path="/children" element={<AppLearning />} />
      <Route path="/tasks" element={<AppLearning />} />
      <Route path="/reports/:childId" element={<AppReports />} />
      <Route path="/child/:childId" element={<AppChildToday />} />
      <Route path="/child/:childId/today" element={<AppChildToday />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
