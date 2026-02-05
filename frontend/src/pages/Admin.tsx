import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Divider, Form, Input, message, Space, Spin, Tabs, Typography, Alert, Radio, Upload } from 'antd';
import { AdminOauthContent } from './AdminOauth';
import { adminFetch, clearAdminToken, getAdminToken, setAdminToken } from '../api/admin';
import { API_BASE } from '../api/base';

const { Title, Paragraph, Text } = Typography;

interface AdminUser {
  id: string;
  username: string;
}

interface AdminStats {
  contentCount: number;
  platformCount: number;
  repliedCount: number;
  templateCount: number;
}

interface ReplyTemplate {
  id: string;
  title: string;
  content: string;
}

function TemplatesPanel() {
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reply-templates`);
      const data = await res.json();
      setTemplates(Array.isArray(data) ? data : []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveTemplate = async (tpl: ReplyTemplate) => {
    setSavingId(tpl.id);
    try {
      const res = await adminFetch(`${API_BASE}/admin/reply-templates/${tpl.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: tpl.title, content: tpl.content }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || '保存失败');
        return;
      }
      setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? data : t)));
      message.success('已保存');
    } finally {
      setSavingId(null);
    }
  };

  const deleteTemplate = async (id: string) => {
    if (!window.confirm('确认删除该模板吗？')) return;
    const res = await adminFetch(`${API_BASE}/admin/reply-templates/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      message.error(data.error || '删除失败');
      return;
    }
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    message.success('已删除');
  };

  const createTemplate = async () => {
    if (!newTitle.trim() || !newContent.trim()) {
      message.warning('请输入标题和内容');
      return;
    }
    const res = await adminFetch(`${API_BASE}/admin/reply-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), content: newContent.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      message.error(data.error || '创建失败');
      return;
    }
    setTemplates((prev) => [data, ...prev]);
    setNewTitle('');
    setNewContent('');
    message.success('已创建');
  };

  return (
    <div>
      <Card title="新增模板" style={{ marginBottom: 16 }} className="admin-card">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Input
            placeholder="模板标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Input.TextArea
            placeholder="模板内容"
            rows={3}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <Button type="primary" onClick={createTemplate}>
            创建模板
          </Button>
        </Space>
      </Card>

      <Card title="已有模板" className="admin-card">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : templates.length === 0 ? (
          <Paragraph type="secondary">暂无模板</Paragraph>
        ) : (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {templates.map((tpl) => (
              <Card key={tpl.id} size="small" title={`模板：${tpl.title}`} className="admin-card">
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <Input
                    value={tpl.title}
                    onChange={(e) =>
                      setTemplates((prev) =>
                        prev.map((t) => (t.id === tpl.id ? { ...t, title: e.target.value } : t))
                      )
                    }
                  />
                  <Input.TextArea
                    rows={3}
                    value={tpl.content}
                    onChange={(e) =>
                      setTemplates((prev) =>
                        prev.map((t) => (t.id === tpl.id ? { ...t, content: e.target.value } : t))
                      )
                    }
                  />
                  <Space>
                    <Button
                      type="primary"
                      onClick={() => saveTemplate(tpl)}
                      loading={savingId === tpl.id}
                    >
                      保存
                    </Button>
                    <Button danger onClick={() => deleteTemplate(tpl.id)}>
                      删除
                    </Button>
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>
    </div>
  );
}

function ImportPanel() {
  const sample = useMemo(
    () =>
      JSON.stringify(
        [
          {
            platformSlug: 'zhihu',
            contentType: 'post',
            authorName: '示例用户',
            body: '这是一条示例内容，可替换为真实采集数据。',
            sourceUrl: 'https://www.zhihu.com/question/123456',
            publishedAt: '2026-02-05T08:00:00Z',
            keywordTags: ['学术', '投稿'],
            likeCount: 12,
            commentCount: 3,
            summary: '这是一条示例内容，可替换为真实采集数据。',
          },
        ],
        null,
        2
      ),
    []
  );
  const csvSample = useMemo(
    () =>
      'platformSlug,contentType,authorName,body,sourceUrl,publishedAt,keywordTags,likeCount,commentCount,summary\n' +
      'zhihu,post,示例用户,这是一条示例内容,https://www.zhihu.com/question/123456,2026-02-05T08:00:00Z,"学术;投稿",12,3,示例摘要\n',
    []
  );
  const [text, setText] = useState(sample);
  const [mode, setMode] = useState<'json' | 'csv'>('json');
  const [loading, setLoading] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ total: number; valid: number; errors: string[] }>({
    total: 0,
    valid: 0,
    errors: [],
  });

  const parseCsv = (input: string): string[][] => {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      const next = input[i + 1];
      if (char === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === ',' && !inQuotes) {
        row.push(field);
        field = '';
        continue;
      }
      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && next === '\n') i += 1;
        row.push(field);
        field = '';
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
        continue;
      }
      field += char;
    }
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  };

  const parseCsvToItems = (input: string): unknown[] => {
    const rows = parseCsv(input);
    if (rows.length === 0) return [];
    const header = rows[0].map((h) => h.trim());
    if (header.length === 0) return [];
    const items: Record<string, unknown>[] = [];
    rows.slice(1).forEach((r) => {
      if (!r || r.every((c) => !c || !c.trim())) return;
      const item: Record<string, unknown> = {};
      header.forEach((h, idx) => {
        if (!h) return;
        const raw = r[idx] ?? '';
        const value = String(raw).trim();
        if (!value) return;
        if (h === 'keywordTags') {
          item[h] = value.split(/[,，;；]/).map((t) => t.trim()).filter(Boolean);
        } else {
          item[h] = value;
        }
      });
      items.push(item);
    });
    return items;
  };

  const validateItems = (items: unknown): { total: number; valid: number; errors: string[] } => {
    if (!Array.isArray(items)) {
      return { total: 0, valid: 0, errors: ['导入数据必须是 JSON 数组'] };
    }
    const errors: string[] = [];
    let valid = 0;
    items.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object') {
        errors.push(`第 ${index + 1} 条：必须是对象`);
        return;
      }
      const item = raw as Record<string, unknown>;
      const hasPlatform = !!item.platformSlug || !!item.platformId;
      const required = ['authorName', 'body', 'sourceUrl', 'publishedAt'];
      const missing = required.filter((k) => !item[k]);
      if (!hasPlatform) missing.push('platformSlug/platformId');
      if (missing.length > 0) {
        errors.push(`第 ${index + 1} 条：缺少 ${missing.join(', ')}`);
        return;
      }
      valid += 1;
    });
    return { total: items.length, valid, errors: errors.slice(0, 6) };
  };

  useEffect(() => {
    try {
      const parsed = mode === 'json' ? JSON.parse(text) : parseCsvToItems(text);
      if (mode === 'csv' && parsed.length === 0) {
        setParseError('CSV 解析失败或为空，请检查格式');
        setValidation({ total: 0, valid: 0, errors: [] });
        return;
      }
      setParseError(null);
      setValidation(validateItems(parsed));
    } catch {
      setParseError(mode === 'json' ? 'JSON 解析失败，请检查格式' : 'CSV 解析失败，请检查格式');
      setValidation({ total: 0, valid: 0, errors: [] });
    }
  }, [text, mode]);

  const downloadFile = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadJsonTemplate = () => {
    downloadFile('import-template.json', sample, 'application/json');
  };

  const downloadCsvTemplate = () => {
    downloadFile('import-template.csv', csvSample, 'text/csv');
  };

  const handleFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) setMode('csv');
    if (name.endsWith('.json')) setMode('json');
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result || ''));
    };
    reader.readAsText(file, 'utf-8');
    return false;
  };

  const doImport = async () => {
    let items: unknown;
    try {
      items = mode === 'json' ? JSON.parse(text) : parseCsvToItems(text);
    } catch {
      message.error(mode === 'json' ? 'JSON 解析失败，请检查格式' : 'CSV 解析失败，请检查格式');
      return;
    }
    if (!Array.isArray(items)) {
      message.error('导入数据需要是数组');
      return;
    }
    setLoading(true);
    try {
      const res = await adminFetch(`${API_BASE}/admin/contents/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || '导入失败');
        return;
      }
      message.success(`导入完成：新增 ${data.inserted} 条，非法 ${data.invalid} 条`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="批量导入内容" className="admin-card">
      <Paragraph type="secondary">
        支持 JSON 或 CSV 导入，字段包含 platformSlug、contentType、authorName、body、sourceUrl、publishedAt 等。
      </Paragraph>
      <Radio.Group
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        style={{ marginBottom: 12 }}
      >
        <Radio.Button value="json">JSON</Radio.Button>
        <Radio.Button value="csv">CSV</Radio.Button>
      </Radio.Group>
      <div className="import-actions">
        <Button onClick={downloadJsonTemplate}>下载 JSON 模板</Button>
        <Button onClick={downloadCsvTemplate}>下载 CSV 模板</Button>
        <Upload
          accept=".json,.csv"
          showUploadList={false}
          beforeUpload={handleFile}
        >
          <Button>上传文件</Button>
        </Upload>
        <Button onClick={() => setText(mode === 'json' ? sample : csvSample)}>填入示例</Button>
      </div>
      {parseError && (
        <Alert
          type="error"
          message={parseError}
          showIcon
          style={{ marginTop: 12 }}
        />
      )}
      {!parseError && validation.total > 0 && (
        <Alert
          type={validation.errors.length ? 'warning' : 'success'}
          message={`检测到 ${validation.total} 条数据，可导入 ${validation.valid} 条`}
          description={
            validation.errors.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null
          }
          showIcon
          style={{ marginTop: 12 }}
        />
      )}
      <Input.TextArea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      <Space style={{ marginTop: 12 }}>
        <Button type="primary" onClick={doImport} loading={loading}>
          开始导入
        </Button>
      </Space>
    </Card>
  );
}

export default function Admin() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [checking, setChecking] = useState(true);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      setChecking(false);
      return;
    }
    adminFetch(`${API_BASE}/admin/me`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setAdmin(data))
      .catch(() => {
        clearAdminToken();
        setAdmin(null);
      })
      .finally(() => setChecking(false));
  }, []);

  const login = async (values: { username: string; password: string }) => {
    setLoggingIn(true);
    try {
      const res = await fetch(`${API_BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.error || '登录失败');
        return;
      }
      setAdmin(data.admin);
      setAdminToken(data.token);
      message.success('登录成功');
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = () => {
    clearAdminToken();
    setAdmin(null);
    setStats(null);
    message.info('已退出');
  };

  useEffect(() => {
    if (!admin) return;
    adminFetch(`${API_BASE}/admin/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setStats(data);
      })
      .catch(() => setStats(null));
  }, [admin]);

  if (checking) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!admin) {
    return (
      <div>
        <div className="hero">
          <h2 className="hero-title">管理后台</h2>
          <p className="hero-subtitle">登录后可进行平台授权、模板管理与内容导入。</p>
        </div>
        <Card style={{ maxWidth: 360 }} className="admin-card">
          <Form layout="vertical" onFinish={login}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={loggingIn} block>
              登录
            </Button>
          </Form>
        </Card>
        <Paragraph type="secondary" style={{ marginTop: 12 }}>
          初始账号在数据库 seed 中创建，用户名为 <Text code>admin</Text>。
        </Paragraph>
      </div>
    );
  }

  return (
    <div>
      <Space align="baseline" style={{ marginBottom: 16 }}>
        <Title level={3} style={{ marginBottom: 0 }}>
          管理后台
        </Title>
        <Text type="secondary">你好，{admin.username}</Text>
        <Button size="small" onClick={logout}>
          退出登录
        </Button>
      </Space>
      {stats && (
        <div className="stat-strip">
          <div className="stat-card">
            <span className="stat-label">内容总量</span>
            <strong className="stat-value">{stats.contentCount.toLocaleString('zh-CN')}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">已接入平台</span>
            <strong className="stat-value">{stats.platformCount}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">已回复内容</span>
            <strong className="stat-value">{stats.repliedCount}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">回复模板</span>
            <strong className="stat-value">{stats.templateCount}</strong>
          </div>
        </div>
      )}
      <Divider />
      <Tabs
        className="admin-tabs"
        items={[
          {
            key: 'oauth',
            label: '平台授权',
            children: <AdminOauthContent />,
          },
          {
            key: 'templates',
            label: '回复模板',
            children: <TemplatesPanel />,
          },
          {
            key: 'import',
            label: '内容导入',
            children: <ImportPanel />,
          },
        ]}
      />
    </div>
  );
}
