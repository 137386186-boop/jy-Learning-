import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Card, List, Progress, Space, Statistic, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { APP_API_BASE, appFetch } from '../api.app';

interface ReportTaskItem {
  id: string;
  status: 'not_started' | 'in_progress' | 'submitted' | 'done';
  score?: number | null;
  submittedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  task: {
    id: string;
    title: string;
    category: string;
    difficulty: number;
    dueDate?: string | null;
  };
}

interface CategoryStat {
  category: string;
  total: number;
  done: number;
  completionRate: number;
}

interface ReportResponse {
  child: {
    id: string;
    name: string;
    gradeLevel?: string | null;
  };
  summary: {
    total: number;
    done: number;
    submitted: number;
    inProgress: number;
    completionRate: number;
    averageScore: number | null;
  };
  categoryStats: CategoryStat[];
  recent: ReportTaskItem[];
}

export default function AppReports() {
  const { childId } = useParams<{ childId: string }>();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ReportResponse | null>(null);

  useEffect(() => {
    const fetchReport = async () => {
      if (!childId) return;
      setLoading(true);
      try {
        const res = await appFetch(`${APP_API_BASE}/reports/${childId}`);
        const data = await res.json();
        if (!res.ok) {
          message.error(data.error || '报告加载失败');
          return;
        }
        setReport(data);
      } finally {
        setLoading(false);
      }
    };

    fetchReport();
  }, [childId]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        showIcon
        type="info"
        message="学习报告（MVP）"
        description="按孩子查看任务完成率、分类进度与最近提交情况。"
      />

      <Card
        loading={loading}
        title={report ? `${report.child.name} 的学习报告` : '学习报告'}
        extra={<Link to="/">返回家长端</Link>}
      >
        <Space size={24} wrap>
          <Statistic title="总任务数" value={report?.summary.total || 0} />
          <Statistic title="已完成" value={report?.summary.done || 0} />
          <Statistic title="已提交" value={report?.summary.submitted || 0} />
          <Statistic title="进行中" value={report?.summary.inProgress || 0} />
          <Statistic
            title="平均得分"
            value={report?.summary.averageScore === null || report?.summary.averageScore === undefined
              ? '-'
              : Number(report.summary.averageScore).toFixed(1)}
          />
        </Space>
        <div style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">总体完成率</Typography.Text>
          <Progress percent={Math.round((report?.summary.completionRate || 0) * 100)} />
        </div>
      </Card>

      <Card title="分类完成情况" loading={loading}>
        <List
          dataSource={report?.categoryStats || []}
          locale={{ emptyText: '暂无分类数据' }}
          renderItem={(item) => (
            <List.Item>
              <Space direction="vertical" style={{ width: '100%' }} size={4}>
                <Typography.Text strong>{item.category}</Typography.Text>
                <Typography.Text type="secondary">
                  {item.done}/{item.total} 已完成
                </Typography.Text>
                <Progress percent={Math.round(item.completionRate * 100)} size="small" />
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <Card title="最近任务进展" loading={loading}>
        <List
          dataSource={report?.recent || []}
          locale={{ emptyText: '暂无任务进展' }}
          renderItem={(item) => (
            <List.Item>
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{item.task.title}</Typography.Text>
                <Typography.Text type="secondary">
                  {item.task.category} · 难度 {item.task.difficulty} · 状态 {item.status}
                  {item.score !== null && item.score !== undefined ? ` · 得分 ${item.score}` : ''}
                </Typography.Text>
                <Typography.Text type="secondary">
                  更新时间：{dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm')}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}
