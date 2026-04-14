import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, List, Select, Space, Tabs, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { APP_API_BASE, appFetch, clearAppToken, getAppToken, setAppToken } from '../api.app';

interface ParentUser {
  id: string;
  username: string;
  displayName: string;
}

interface Child {
  id: string;
  name: string;
  gradeLevel?: string | null;
  birthDate?: string | null;
}

interface TaskItem {
  id: string;
  title: string;
  category: string;
  difficulty: number;
  status: 'draft' | 'active' | 'archived';
  dueDate?: string | null;
  childId?: string | null;
  child?: { id: string; name: string } | null;
}

export default function AppLearning() {
  const [token, setToken] = useState<string | null>(() => getAppToken());
  const [me, setMe] = useState<ParentUser | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState<string | undefined>(undefined);
  const [authMode, setAuthMode] = useState<'register' | 'login'>('register');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const selectedChild = useMemo(
    () => children.find((c) => c.id === selectedChildId) || null,
    [children, selectedChildId]
  );

  const reloadAll = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [meRes, childRes, taskRes] = await Promise.all([
        appFetch(`${APP_API_BASE}/auth/me`),
        appFetch(`${APP_API_BASE}/children`),
        appFetch(`${APP_API_BASE}/tasks`),
      ]);
      const [meData, childData, taskData] = await Promise.all([meRes.json(), childRes.json(), taskRes.json()]);
      if (!meRes.ok) throw new Error(meData.error || '用户信息加载失败');
      if (!childRes.ok) throw new Error(childData.error || '孩子列表加载失败');
      if (!taskRes.ok) throw new Error(taskData.error || '任务列表加载失败');
      setMe(meData);
      setChildren(Array.isArray(childData) ? childData : []);
      setTasks(Array.isArray(taskData) ? taskData : []);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) reloadAll();
  }, [token]);

  const onRegister = async (values: { username: string; password: string }) => {
    setAuthSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || '注册失败');
        return;
      }
      setAppToken(data.token);
      setToken(data.token);
      message.success('注册成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onLogin = async (values: { username: string; password: string }) => {
    setAuthSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || '登录失败');
        return;
      }
      setAppToken(data.token);
      setToken(data.token);
      message.success('登录成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onCreateChild = async (values: { name: string; gradeLevel?: string; birthDate?: string }) => {
    const res = await appFetch(`${APP_API_BASE}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) {
      message.error(data.error || '创建孩子失败');
      return;
    }
    message.success('孩子档案已创建');
    reloadAll();
  };

  const onCreateTask = async (values: {
    title: string;
    category: string;
    difficulty?: number;
    childId?: string;
    dueDate?: string;
  }) => {
    const res = await appFetch(`${APP_API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) {
      message.error(data.error || '创建任务失败');
      return;
    }
    message.success('任务已创建');
    reloadAll();
  };

  if (!token) {
    return (
      <div style={{ minHeight: '70vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Card style={{ width: '100%', maxWidth: 460 }}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="幼升小启蒙 APP"
              description="先注册或登录家长账号，再为孩子创建学习任务。"
            />

            <Tabs
              activeKey={authMode}
              onChange={(key) => setAuthMode(key as 'register' | 'login')}
              items={[
                {
                  key: 'register',
                  label: '注册',
                  children: (
                    <Form layout="vertical" onFinish={onRegister} autoComplete="on">
                      <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                        <Input placeholder="请输入用户名" autoComplete="username" />
                      </Form.Item>
                      <Form.Item
                        label="密码"
                        name="password"
                        rules={[{ required: true, min: 6, message: '密码至少 6 位' }]}
                      >
                        <Input.Password placeholder="请输入密码" autoComplete="new-password" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={authSubmitting} block>
                        注册并进入
                      </Button>
                    </Form>
                  ),
                },
                {
                  key: 'login',
                  label: '登录',
                  children: (
                    <Form layout="vertical" onFinish={onLogin} autoComplete="on">
                      <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                        <Input placeholder="请输入用户名" autoComplete="username" />
                      </Form.Item>
                      <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
                        <Input.Password placeholder="请输入密码" autoComplete="current-password" />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={authSubmitting} block>
                        登录
                      </Button>
                    </Form>
                  ),
                },
              ]}
            />
          </Space>
        </Card>
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card loading={loading} title="家长端总览" extra={<Button onClick={() => { clearAppToken(); setToken(null); setMe(null); }}>退出</Button>}>
        <Typography.Paragraph>
          当前家长：<strong>{me?.displayName || me?.username || '-'}</strong>
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          孩子 {children.length} 人 · 任务 {tasks.length} 条
        </Typography.Paragraph>
      </Card>

      <Card title="创建孩子档案">
        <Form layout="inline" onFinish={onCreateChild}>
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="孩子姓名" />
          </Form.Item>
          <Form.Item name="gradeLevel">
            <Select placeholder="年级阶段" style={{ width: 160 }} options={[
              { label: '学前', value: 'pre_k' },
              { label: '幼儿园', value: 'kindergarten' },
              { label: '幼升小', value: 'primary_prep' },
            ]} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">新增孩子</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="创建学习任务">
        <Form layout="inline" onFinish={onCreateTask}>
          <Form.Item name="title" rules={[{ required: true }]}>
            <Input placeholder="任务标题" />
          </Form.Item>
          <Form.Item name="category" rules={[{ required: true }]}>
            <Select
              placeholder="任务分类"
              style={{ width: 140 }}
              options={[
                { label: '识字', value: 'literacy' },
                { label: '数学', value: 'math' },
                { label: '表达', value: 'expression' },
                { label: '习惯', value: 'habit' },
              ]}
            />
          </Form.Item>
          <Form.Item name="difficulty">
            <Select
              placeholder="难度"
              style={{ width: 120 }}
              options={[
                { label: '1', value: 1 },
                { label: '2', value: 2 },
                { label: '3', value: 3 },
                { label: '4', value: 4 },
                { label: '5', value: 5 },
              ]}
            />
          </Form.Item>
          <Form.Item name="childId">
            <Select
              allowClear
              placeholder="分配给孩子"
              style={{ width: 180 }}
              options={children.map((c) => ({ label: c.name, value: c.id }))}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">新增任务</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="孩子列表">
        <Select
          allowClear
          placeholder="选择孩子查看今日任务入口"
          style={{ width: 260, marginBottom: 12 }}
          value={selectedChildId}
          onChange={(v) => setSelectedChildId(v)}
          options={children.map((c) => ({ label: c.name, value: c.id }))}
        />
        {selectedChild && (
          <Space direction="vertical" size={4}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              进入儿童端：<Link to={`/child/${selectedChild.id}/today`}>{selectedChild.name} 的今日任务</Link>
            </Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              查看报告：<Link to={`/reports/${selectedChild.id}`}>{selectedChild.name} 的学习报告</Link>
            </Typography.Paragraph>
          </Space>
        )}
        <List
          dataSource={children}
          locale={{ emptyText: '暂无孩子档案' }}
          renderItem={(item) => (
            <List.Item>
              <Space>
                <Typography.Text strong>{item.name}</Typography.Text>
                {item.gradeLevel && <Typography.Text type="secondary">{item.gradeLevel}</Typography.Text>}
                {item.birthDate && <Typography.Text type="secondary">{dayjs(item.birthDate).format('YYYY-MM-DD')}</Typography.Text>}
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <Card title="任务列表">
        <List
          dataSource={tasks}
          locale={{ emptyText: '暂无任务' }}
          renderItem={(item) => (
            <List.Item>
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{item.title}</Typography.Text>
                <Typography.Text type="secondary">
                  {item.category} · 难度 {item.difficulty} · {item.status}
                  {item.child?.name ? ` · ${item.child.name}` : ' · 全家可见'}
                  {item.dueDate ? ` · 截止 ${dayjs(item.dueDate).format('YYYY-MM-DD')}` : ''}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}
