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

interface WeeklyRankItem {
  childId: string;
  childName: string;
  points: number;
  doneCount: number;
  audioPlayCount: number;
  videoPlayCount: number;
}

interface Trend7dItem {
  date: string;
  label: string;
  doneCount: number;
  learnCount: number;
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
    audioPlayCount: number;
    videoPlayCount: number;
  };
  categoryStats: CategoryStat[];
  recent: ReportTaskItem[];
  weeklyRanking: WeeklyRankItem[];
  trend7d: Trend7dItem[];
}

function getGrowthLevel(summary?: ReportResponse['summary'] | null) {
  const done = summary?.done || 0;
  const media = (summary?.audioPlayCount || 0) + (summary?.videoPlayCount || 0);
  const points = done * 3 + media;
  if (points >= 40) return { level: '启明星', medal: '金牌勋章', color: '#faad14' };
  if (points >= 20) return { level: '小达人', medal: '银牌勋章', color: '#8c8c8c' };
  return { level: '进步苗苗', medal: '成长勋章', color: '#52c41a' };
}

function getRankStyle(index: number) {
  if (index === 0) return { badge: 'TOP1', color: '#faad14', bg: '#fff7e6' };
  if (index === 1) return { badge: 'TOP2', color: '#8c8c8c', bg: '#fafafa' };
  if (index === 2) return { badge: 'TOP3', color: '#d48806', bg: '#fffbe6' };
  return { badge: `NO.${index + 1}`, color: '#1677ff', bg: '#f0f5ff' };
}

export default function AppReports() {
  const { childId } = useParams<{ childId: string }>();
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [errorTip, setErrorTip] = useState('');
  const growth = getGrowthLevel(report?.summary);

  useEffect(() => {
    const fetchReport = async () => {
      if (!childId) return;
      setLoading(true);
      setErrorTip('');
      try {
        const res = await appFetch(`${APP_API_BASE}/reports/${childId}`);
        const data = await res.json();
        if (!res.ok) {
          const rawError = typeof data?.error === 'string' ? data.error : '';
          const msg = rawError || '报告加载失败';
          if (res.status === 403 || res.status === 404) {
            setErrorTip('孩子不存在或无权限查看该报告');
            message.error('孩子不存在或无权限查看该报告');
          } else {
            setErrorTip(msg);
            message.error(msg);
          }
          setReport(null);
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
        message="学习报告"
        description="按孩子查看任务完成率、分类进度与最近提交情况。"
      />

      {errorTip ? (
        <Alert
          showIcon
          type="warning"
          message={errorTip}
          action={<Link to="/">返回家长端</Link>}
        />
      ) : null}

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
          <Statistic title="音频学习次数" value={report?.summary.audioPlayCount || 0} />
          <Statistic title="视频学习次数" value={report?.summary.videoPlayCount || 0} />
          <Statistic
            title="平均得分"
            value={report?.summary.averageScore === null || report?.summary.averageScore === undefined
              ? '未评分'
              : Number(report.summary.averageScore).toFixed(1)}
          />
        </Space>
        <div style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">总体完成率</Typography.Text>
          <Progress percent={Math.round((report?.summary.completionRate || 0) * 100)} />
        </div>
      </Card>

      <Card title="成长勋章" loading={loading}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text strong style={{ fontSize: 20, color: growth.color }}>
            {growth.medal}
          </Typography.Text>
          <Typography.Text>当前等级：{growth.level}</Typography.Text>
          <Typography.Text type="secondary">
            规则：完成任务×3分 + 音频/视频学习×1分
          </Typography.Text>
        </Space>
      </Card>

      <Card title="本周学习榜单" loading={loading}>
        <List
          dataSource={report?.weeklyRanking || []}
          locale={{ emptyText: '本周暂无学习数据' }}
          renderItem={(item, index) => {
            const style = getRankStyle(index);
            const maxPoints = Math.max(1, report?.weeklyRanking?.[0]?.points || 1);
            const ratio = Math.min(100, Math.round((item.points / maxPoints) * 100));
            return (
              <List.Item style={{ background: style.bg, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong style={{ color: style.color }}>
                      {style.badge} · {item.childName}
                    </Typography.Text>
                    <Typography.Text strong>{item.points} 分</Typography.Text>
                  </Space>
                  <Progress percent={ratio} showInfo={false} strokeColor={style.color} />
                  <Typography.Text type="secondary">
                    完成 {item.doneCount} 次，音频 {item.audioPlayCount}，视频 {item.videoPlayCount}
                  </Typography.Text>
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>

      <Card title="近7天学习趋势" loading={loading}>
        <List
          dataSource={report?.trend7d || []}
          locale={{ emptyText: '暂无趋势数据' }}
          renderItem={(item) => {
            const peak = Math.max(1, ...(report?.trend7d || []).map((x) => x.doneCount * 3 + x.learnCount));
            const score = item.doneCount * 3 + item.learnCount;
            const ratio = Math.min(100, Math.round((score / peak) * 100));
            return (
              <List.Item>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong>{item.label}</Typography.Text>
                    <Typography.Text type="secondary">
                      完成 {item.doneCount} 次 · 学习 {item.learnCount} 次
                    </Typography.Text>
                  </Space>
                  <Progress percent={ratio} showInfo={false} strokeColor="#13c2c2" />
                </Space>
              </List.Item>
            );
          }}
        />
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
