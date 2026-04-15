import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, List, Select, Space, Tabs, Tag, Typography, Popconfirm, message } from 'antd';
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
  todayTaskCount?: number;
  weeklyDoneCount?: number;
  latestLearningAt?: string | null;
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

interface MaterialItem {
  id: string;
  childId?: string | null;
  taskId?: string | null;
  createdAt: string;
  content?: unknown;
}

function parseMaterialContent(raw: unknown) {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const recognition = data.recognitionResult && typeof data.recognitionResult === 'object'
    ? (data.recognitionResult as Record<string, unknown>)
    : null;
  return {
    fileName: String(data.fileName || '未命名资料'),
    sourceType: String(data.sourceType || 'file'),
    status: String(data.status || 'uploaded'),
    fileUrl: String(data.fileUrl || ''),
    recognitionText: recognition ? String(recognition.extractedText || '') : '',
    recognitionCategory: recognition ? String(recognition.suggestedCategory || '') : '',
  };
}

const TASK_STATUS_META: Record<TaskItem['status'], { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'processing' },
  archived: { label: '已归档', color: 'default' },
};

function getDifficultyLabel(level: number) {
  if (level === 1) return '入门';
  if (level === 2) return '基础';
  return '提升';
}

function getMaterialStatusMeta(status: string) {
  if (status === 'recognized') return { label: '已识别', color: 'processing' as const };
  if (status === 'task_generated') return { label: '已生成任务', color: 'success' as const };
  if (status === 'failed') return { label: '处理失败', color: 'error' as const };
  return { label: '待处理', color: 'default' as const };
}

async function parseApiResponse(res: Response): Promise<Record<string, unknown> | unknown[]> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    throw new Error('服务暂时不可用，请稍后重试');
  }
}

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  }
  return fallback;
}

export default function AppLearning() {
  const [token, setToken] = useState<string | null>(() => getAppToken());
  const [me, setMe] = useState<ParentUser | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'register' | 'login'>('login');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [childSubmitting, setChildSubmitting] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingChildId, setDeletingChildId] = useState<string | null>(null);
  const [materialBusyId, setMaterialBusyId] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadChildId, setUploadChildId] = useState<string | undefined>(undefined);

  const totalTodayTaskCount = useMemo(
    () => children.reduce((sum, child) => sum + (child.todayTaskCount ?? 0), 0),
    [children]
  );
  const totalWeeklyDoneCount = useMemo(
    () => children.reduce((sum, child) => sum + (child.weeklyDoneCount ?? 0), 0),
    [children]
  );

  const reloadAll = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const meRes = await appFetch(`${APP_API_BASE}/auth/me`);
      const meData = await parseApiResponse(meRes);
      if (!meRes.ok) {
        throw new Error(getApiErrorMessage(meData, '用户信息加载失败'));
      }
      setMe((meData && typeof meData === 'object' ? meData : null) as ParentUser | null);

      const [childRes, taskRes, materialRes] = await Promise.all([
        appFetch(`${APP_API_BASE}/children`),
        appFetch(`${APP_API_BASE}/tasks`),
        appFetch(`${APP_API_BASE}/library/materials`),
      ]);

      const errors: string[] = [];

      try {
        const childData = await parseApiResponse(childRes);
        if (childRes.ok) {
          setChildren(Array.isArray(childData) ? (childData as Child[]) : []);
        } else {
          errors.push(getApiErrorMessage(childData, '孩子列表加载失败'));
        }
      } catch {
        errors.push('孩子列表服务暂时不可用，请稍后重试');
      }

      try {
        const taskData = await parseApiResponse(taskRes);
        if (taskRes.ok) {
          setTasks(Array.isArray(taskData) ? (taskData as TaskItem[]) : []);
        } else {
          errors.push(getApiErrorMessage(taskData, '任务列表加载失败'));
        }
      } catch {
        errors.push('任务列表服务暂时不可用，请稍后重试');
      }

      try {
        const materialData = await parseApiResponse(materialRes);
        if (materialRes.ok) {
          setMaterials(Array.isArray(materialData) ? (materialData as MaterialItem[]) : []);
        } else {
          errors.push(getApiErrorMessage(materialData, '资料库加载失败'));
        }
      } catch {
        errors.push('资料库服务暂时不可用，请稍后重试');
      }

      if (errors.length) {
        message.warning(errors[0]);
      }
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
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '注册失败'));
        return;
      }
      const tokenValue = data && typeof data === 'object' ? (data as Record<string, unknown>).token : undefined;
      if (typeof tokenValue !== 'string' || !tokenValue) {
        message.error('注册失败');
        return;
      }
      setAppToken(tokenValue);
      setToken(tokenValue);
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
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '登录失败'));
        return;
      }
      const tokenValue = data && typeof data === 'object' ? (data as Record<string, unknown>).token : undefined;
      if (typeof tokenValue !== 'string' || !tokenValue) {
        message.error('登录失败');
        return;
      }
      setAppToken(tokenValue);
      setToken(tokenValue);
      message.success('登录成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onCreateChild = async (values: { name: string; gradeLevel?: string; birthDate?: string }) => {
    const normalizedName = values.name?.trim();
    if (!normalizedName) {
      message.warning('请输入孩子姓名');
      return;
    }
    const existedLocal = children.some(
      (c) => c.name.trim().toLowerCase() === normalizedName.toLowerCase()
    );
    if (existedLocal) {
      message.warning('该孩子档案已存在，请勿重复添加');
      return;
    }

    setChildSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, name: normalizedName }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '创建孩子失败'));
        return;
      }
      message.success('孩子档案已创建');
      await reloadAll();
    } catch {
      message.error('创建孩子失败，请稍后重试');
    } finally {
      setChildSubmitting(false);
    }
  };

  const onCreateTask = async (values: {
    title: string;
    category: string;
    difficulty?: number;
    childId?: string;
    dueDate?: string;
  }) => {
    setTaskSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '创建任务失败'));
        return;
      }
      message.success('任务已创建');
      await reloadAll();
    } catch {
      message.error('创建任务失败，请稍后重试');
    } finally {
      setTaskSubmitting(false);
    }
  };

  const onDeleteChild = async (childId: string) => {
    setDeletingChildId(childId);
    try {
      const res = await appFetch(`${APP_API_BASE}/children/${childId}`, {
        method: 'DELETE',
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '删除孩子失败'));
        return;
      }
      message.success('孩子档案已删除');
      await reloadAll();
    } finally {
      setDeletingChildId(null);
    }
  };

  const onUploadMaterial = async () => {
    if (!uploadFile) {
      message.warning('请先选择要上传的文件');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      if (uploadChildId) formData.append('childId', uploadChildId);
      const res = await appFetch(`${APP_API_BASE}/library/materials`, {
        method: 'POST',
        body: formData,
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '上传失败'));
        return;
      }
      message.success('资料上传成功');
      setUploadFile(null);
      setUploadChildId(undefined);
      await reloadAll();
    } catch {
      message.error('上传失败，请稍后重试');
    } finally {
      setUploading(false);
    }
  };

  const onRecognizeMaterial = async (materialId: string) => {
    setMaterialBusyId(materialId);
    try {
      const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}/recognize`, {
        method: 'POST',
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '识别失败'));
        return;
      }
      message.success('识别完成');
      await reloadAll();
    } finally {
      setMaterialBusyId(null);
    }
  };

  const onGenerateTask = async (materialId: string) => {
    setMaterialBusyId(materialId);
    try {
      const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}/generate-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '生成任务失败'));
        return;
      }
      message.success('已从资料生成学习任务');
      await reloadAll();
    } finally {
      setMaterialBusyId(null);
    }
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            当前家长：<strong>{me?.displayName || me?.username || '-'}</strong>
          </Typography.Paragraph>
          <Space wrap size={12}>
            <Card size="small" style={{ minWidth: 140 }}>
              <Typography.Text type="secondary">孩子数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{children.length}</Typography.Title>
            </Card>
            <Card size="small" style={{ minWidth: 140 }}>
              <Typography.Text type="secondary">任务总数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{tasks.length}</Typography.Title>
            </Card>
            <Card size="small" style={{ minWidth: 140 }}>
              <Typography.Text type="secondary">今日任务</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{totalTodayTaskCount}</Typography.Title>
            </Card>
            <Card size="small" style={{ minWidth: 140 }}>
              <Typography.Text type="secondary">本周完成</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{totalWeeklyDoneCount}</Typography.Title>
            </Card>
            <Card size="small" style={{ minWidth: 140 }}>
              <Typography.Text type="secondary">资料总数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{materials.length}</Typography.Title>
            </Card>
          </Space>
        </Space>
      </Card>

      <Card title="孩子档案管理">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="inline" onFinish={onCreateChild}>
            <Form.Item name="name" rules={[{ required: true, message: '请输入孩子姓名' }]}>
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
              <Button type="primary" htmlType="submit" loading={childSubmitting} disabled={childSubmitting}>新增孩子</Button>
            </Form.Item>
          </Form>

          <List
            dataSource={children}
            locale={{ emptyText: '暂无孩子档案' }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Link key="today" to={`/child/${item.id}/today`}>今日任务</Link>,
                  <Link key="report" to={`/reports/${item.id}`}>学习报告</Link>,
                  <Popconfirm
                    key="delete"
                    title="确认删除孩子档案？"
                    description="删除后不可恢复，该孩子任务进度也会被移除。"
                    okText="确认删除"
                    cancelText="取消"
                    onConfirm={() => onDeleteChild(item.id)}
                  >
                    <Button
                      danger
                      type="text"
                      size="small"
                      loading={deletingChildId === item.id}
                      disabled={deletingChildId !== null && deletingChildId !== item.id}
                    >
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap>
                    <Typography.Text strong>{item.name}</Typography.Text>
                    {item.gradeLevel && <Tag color="blue">{item.gradeLevel}</Tag>}
                    {item.birthDate && <Typography.Text type="secondary">{dayjs(item.birthDate).format('YYYY-MM-DD')}</Typography.Text>}
                  </Space>
                  <Space size={8} wrap>
                    <Tag color={((item.todayTaskCount ?? 0) > 0 ? 'orange' : 'default')}>今日任务 {(item.todayTaskCount ?? 0)} 条</Tag>
                    <Tag color={((item.weeklyDoneCount ?? 0) > 0 ? 'green' : 'default')}>本周完成 {(item.weeklyDoneCount ?? 0)} 条</Tag>
                    <Tag>
                      最近学习 {item.latestLearningAt ? dayjs(item.latestLearningAt).format('MM-DD HH:mm') : '暂无'}
                    </Tag>
                  </Space>
                </Space>
              </List.Item>
            )}
          />
        </Space>
      </Card>

      <Card title="学习任务管理">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="inline" onFinish={onCreateTask}>
            <Form.Item name="title" rules={[{ required: true, message: '请输入任务标题' }]}>
              <Input placeholder="任务标题" />
            </Form.Item>
            <Form.Item name="category" rules={[{ required: true, message: '请选择任务分类' }]}>
              <Select
                placeholder="任务分类"
                style={{ width: 140 }}
                options={[
                  { label: '语文', value: '语文' },
                  { label: '数学', value: '数学' },
                  { label: '英语', value: '英语' },
                  { label: '社会科学', value: '社会科学' },
                ]}
              />
            </Form.Item>
            <Form.Item name="difficulty">
              <Select
                placeholder="难度"
                style={{ width: 160 }}
                options={[
                  { label: '入门', value: 1 },
                  { label: '基础', value: 2 },
                  { label: '提升', value: 3 },
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
              <Button type="primary" htmlType="submit" loading={taskSubmitting} disabled={taskSubmitting}>新增任务</Button>
            </Form.Item>
          </Form>

          <List
            dataSource={tasks}
            locale={{ emptyText: '暂无任务' }}
            renderItem={(item) => {
              const statusMeta = TASK_STATUS_META[item.status];
              return (
                <List.Item>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space wrap>
                      <Typography.Text strong>{item.title}</Typography.Text>
                      <Tag color="blue">{item.category}</Tag>
                      <Tag>{getDifficultyLabel(item.difficulty)}</Tag>
                      <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
                      {item.child?.name ? <Tag color="green">{item.child.name}</Tag> : <Tag>全家可见</Tag>}
                      {item.dueDate && <Tag color="orange">截止 {dayjs(item.dueDate).format('MM-DD')}</Tag>}
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Space>
      </Card>

      <Card title="共享资料库（上传→识别→生成任务）">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap>
            <input
              type="file"
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx"
            />
            <Select
              allowClear
              placeholder="可选：绑定孩子"
              style={{ width: 180 }}
              value={uploadChildId}
              onChange={(v) => setUploadChildId(v)}
              options={children.map((c) => ({ label: c.name, value: c.id }))}
            />
            <Button type="primary" onClick={onUploadMaterial} loading={uploading} disabled={uploading}>上传资料</Button>
          </Space>

          <List
            dataSource={materials}
            locale={{ emptyText: '暂无共享资料' }}
            renderItem={(item) => {
              const parsed = parseMaterialContent(item.content);
              const materialStatus = getMaterialStatusMeta(parsed.status);
              const canGenerate = parsed.status === 'recognized' || !!parsed.recognitionText;
              return (
                <List.Item
                  actions={[
                    <Button
                      key="recognize"
                      size="small"
                      loading={materialBusyId === item.id}
                      onClick={() => onRecognizeMaterial(item.id)}
                    >
                      识别
                    </Button>,
                    <Button
                      key="gen"
                      size="small"
                      type="primary"
                      disabled={!canGenerate}
                      loading={materialBusyId === item.id}
                      onClick={() => onGenerateTask(item.id)}
                    >
                      生成任务
                    </Button>,
                  ]}
                >
                  <Space direction="vertical" size={4}>
                    <Space wrap>
                      <Typography.Text strong>{parsed.fileName}</Typography.Text>
                      <Tag color={materialStatus.color}>{materialStatus.label}</Tag>
                      <Tag>{parsed.sourceType}</Tag>
                      {item.childId ? <Tag color="blue">已绑定孩子</Tag> : <Tag>未绑定孩子</Tag>}
                    </Space>
                    <Typography.Text type="secondary">
                      上传时间：{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}
                    </Typography.Text>
                    {parsed.recognitionText && (
                      <Typography.Text type="secondary">
                        识别结果：{parsed.recognitionText}
                        {parsed.recognitionCategory ? `（推荐分类：${parsed.recognitionCategory}）` : ''}
                      </Typography.Text>
                    )}
                    {!!parsed.fileUrl && (
                      <Typography.Link href={`${APP_API_BASE.replace('/api/app', '')}${parsed.fileUrl}`} target="_blank">
                        查看文件
                      </Typography.Link>
                    )}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Space>
      </Card>
    </Space>
  );
}
