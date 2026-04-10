import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Card, List, Space, Typography, message } from 'antd';
import { APP_API_BASE, appFetch } from '../api/app';

interface TodayTask {
  id: string;
  title: string;
  category: string;
  difficulty: number;
  progresses?: Array<{ status: 'not_started' | 'in_progress' | 'submitted' | 'done' }>;
}

interface TodayResponse {
  child: { id: string; name: string };
  list: TodayTask[];
}

export default function AppChildToday() {
  const { childId } = useParams<{ childId: string }>();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TodayResponse | null>(null);

  const reload = async () => {
    if (!childId) return;
    setLoading(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/child/${childId}/today`);
      const json = await res.json();
      if (!res.ok) {
        message.error(json.error || '加载失败');
        return;
      }
      setData(json);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [childId]);

  const submitAction = async (taskId: string, action: 'start' | 'submit' | 'complete') => {
    if (!childId) return;
    const body = action === 'submit'
      ? { childId, answerData: { note: 'child submit from MVP page' } }
      : { childId };
    const res = await appFetch(`${APP_API_BASE}/tasks/${taskId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      message.error(json.error || '操作失败');
      return;
    }
    message.success('操作成功');
    reload();
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert showIcon type="info" message="儿童端今日任务（MVP）" description="可直接执行开始、提交、完成动作。" />
      <Card title={data ? `${data.child.name} 的今日任务` : '今日任务'} loading={loading}>
        <List
          dataSource={data?.list || []}
          locale={{ emptyText: '今天暂无任务' }}
          renderItem={(item) => {
            const status = item.progresses?.[0]?.status || 'not_started';
            return (
              <List.Item
                actions={[
                  <Button key="start" onClick={() => submitAction(item.id, 'start')}>开始</Button>,
                  <Button key="submit" onClick={() => submitAction(item.id, 'submit')}>提交</Button>,
                  <Button key="done" type="primary" onClick={() => submitAction(item.id, 'complete')}>完成</Button>,
                ]}
              >
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{item.title}</Typography.Text>
                  <Typography.Text type="secondary">
                    {item.category} · 难度 {item.difficulty} · 当前状态 {status}
                  </Typography.Text>
                </Space>
              </List.Item>
            );
          }}
        />
      </Card>
    </Space>
  );
}
