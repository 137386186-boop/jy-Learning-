import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Checkbox, Form, Input, List, Progress, Select, Space, Tabs, Tag, Typography, Popconfirm, message } from 'antd';
import type { FormInstance } from 'antd';
import dayjs from 'dayjs';
import { APP_API_BASE, appFetch, appUpload, clearAppToken, getAppToken, setAppToken } from '../api.app';

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

function resolveAssetUrl(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${APP_API_BASE.replace('/api/app', '')}${value.startsWith('/') ? '' : '/'}${value}`;
}

function decodeFileName(raw: unknown) {
  const value = String(raw || '').trim();
  if (!value) return '未命名资料';

  let decodedUri = value;
  try {
    const candidate = decodeURIComponent(value).trim();
    if (candidate) decodedUri = candidate;
  } catch {
    decodedUri = value;
  }

  if (typeof TextDecoder === 'undefined') return decodedUri;

  const bytes = new Uint8Array(Array.from(decodedUri).map((char) => char.charCodeAt(0) & 0xff));
  const utf8Decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (!utf8Decoded) return decodedUri;

  const mojibakeHint = /[ÃÂÐÑØæçðñþ]/;
  return mojibakeHint.test(decodedUri) && !mojibakeHint.test(utf8Decoded) ? utf8Decoded : decodedUri;
}

function parseMaterialContent(raw: unknown) {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const recognition = data.recognitionResult && typeof data.recognitionResult === 'object'
    ? (data.recognitionResult as Record<string, unknown>)
    : null;
  const mediaOutputs = Array.isArray(data.mediaOutputs) ? data.mediaOutputs : [];
  const audioOutput = mediaOutputs.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'audio');
  const videoOutput = mediaOutputs.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'video');

  return {
    fileName: decodeFileName(data.fileName),
    sourceType: String(data.sourceType || 'file'),
    status: String(data.status || 'uploaded'),
    recognitionStatus: String(data.recognitionStatus || ''),
    mediaStatus: String(data.mediaStatus || ''),
    fallbackReason: String(data.fallbackReason || ''),
    costUsd: Number(data.costUsd || 0),
    fileUrl: String(data.fileUrl || ''),
    recognitionText: recognition ? String(recognition.extractedText || '') : '',
    recognitionCategory: recognition ? String(recognition.suggestedCategory || '') : '',
    recognitionProvider: recognition ? String(recognition.provider || '') : '',
    audioUrl: audioOutput && typeof (audioOutput as Record<string, unknown>).url === 'string'
      ? String((audioOutput as Record<string, unknown>).url)
      : '',
    videoUrl: videoOutput && typeof (videoOutput as Record<string, unknown>).url === 'string'
      ? String((videoOutput as Record<string, unknown>).url)
      : '',
  };
}

const TASK_STATUS_META: Record<TaskItem['status'], { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '进行中', color: 'processing' },
  archived: { label: '已归档', color: 'default' },
};

const GRADE_LEVEL_LABEL: Record<string, string> = {
  pre_k: '学前',
  kindergarten: '幼儿园',
  primary_prep: '幼升小',
};

function getGradeLevelLabel(value?: string | null) {
  if (!value) return '';
  return GRADE_LEVEL_LABEL[value] || value;
}

function getDifficultyLabel(level: number) {
  if (level === 1) return '入门';
  if (level === 2) return '基础';
  return '提升';
}

function getMaterialStatusMeta(status: string) {
  if (status === 'processing') return { label: '处理中', color: 'processing' as const };
  if (status === 'recognized') return { label: '已识别', color: 'processing' as const };
  if (status === 'fallback_recognized') return { label: '已识别(回退)', color: 'gold' as const };
  if (status === 'task_generated') return { label: '已生成任务', color: 'success' as const };
  if (status === 'failed') return { label: '处理失败', color: 'error' as const };
  return { label: '待处理', color: 'default' as const };
}

function getAiStageMeta(recognitionStatus: string, mediaStatus: string) {
  if (recognitionStatus === 'processing' || mediaStatus === 'processing') {
    return { label: 'AI处理中', color: 'processing' as const };
  }
  if (recognitionStatus === 'completed' && mediaStatus === 'completed') {
    return { label: 'AI深度识别+专业媒体已完成', color: 'success' as const };
  }
  if (recognitionStatus === 'fallback' || mediaStatus === 'fallback') {
    return { label: 'AI回退到本地模式', color: 'warning' as const };
  }
  if (recognitionStatus === 'completed') {
    return { label: 'AI识别完成', color: 'processing' as const };
  }
  return null;
}

function getFallbackReasonText(reason: string) {
  if (!reason) return '';
  if (reason === 'ai_recognition_disabled') return 'AI识别未开启';
  if (reason === 'media_generation_disabled') return '专业媒体生成未开启';
  if (reason === 'daily_budget_exceeded') return '超出日预算，自动回退';
  if (reason === 'monthly_budget_exceeded') return '超出月预算，自动回退';
  if (reason === 'daily_request_limit_exceeded') return '超出日请求上限，自动回退';
  if (reason === 'single_artifact_cost_exceeded') return '单资料预算超限，自动回退';
  if (reason === 'guardrail_unavailable') return '预算护栏服务不可用，自动回退';
  if (reason === 'ai_recognition_failed') return 'AI识别失败，自动回退';
  if (reason === 'media_generation_failed') return '专业媒体生成失败，自动回退';
  return reason;
}

const PASSWORD_RULE_REGEX = /^(?=.*[a-zA-Z])(?=.*\d).{8,}$/;
const PASSWORD_RULE_TEXT = '密码至少 8 位，且需同时包含字母和数字';

function getPasswordRuleChecks(password: string) {
  const value = String(password || '');
  return {
    minLength: value.length >= 8,
    hasLetter: /[a-zA-Z]/.test(value),
    hasNumber: /\d/.test(value),
  };
}

function renderPasswordRuleHint(password: string) {
  const checks = getPasswordRuleChecks(password);
  return (
    <Space size={8} wrap>
      <Tag color={checks.minLength ? 'success' : 'default'}>至少 8 位</Tag>
      <Tag color={checks.hasLetter ? 'success' : 'default'}>包含字母</Tag>
      <Tag color={checks.hasNumber ? 'success' : 'default'}>包含数字</Tag>
    </Space>
  );
}

function applyFieldErrors(form: FormInstance, data: unknown) {
  if (!data || typeof data !== 'object') return;
  const fieldErrors = (data as Record<string, unknown>).fieldErrors;
  if (!Array.isArray(fieldErrors)) return;

  const mapped = fieldErrors
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const field = typeof row.field === 'string' ? row.field.trim() : '';
      const msg = typeof row.message === 'string' ? row.message.trim() : '';
      if (!field || !msg) return null;
      return { name: field, errors: [msg] };
    })
    .filter((item): item is { name: string; errors: string[] } => !!item);

  if (mapped.length) {
    form.setFields(mapped);
  }
}

function isRecognitionLikelyTruncated(text: string) {
  return text.length >= 1100;
}

async function parseApiResponse(res: Response): Promise<Record<string, unknown> | unknown[]> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    const plain = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return {
      message: plain || `服务返回异常（${res.status}）`,
      statusCode: res.status,
    };
  }
}

function getApiErrorMessage(data: unknown, fallback: string, statusCode?: number): string {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.fieldErrors) && obj.fieldErrors.length > 0) {
      const first = obj.fieldErrors[0];
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).message === 'string') {
        const fieldMessage = String((first as Record<string, unknown>).message).trim();
        if (fieldMessage) return fieldMessage;
      }
    }
    if (typeof obj.error === 'string' && obj.error.trim()) return obj.error;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
  }

  if (statusCode === 413) return '文件过大，请压缩后重试（单文件不超过 20MB）';
  if (statusCode === 415) return '文件格式不支持，请更换后重试';
  if (statusCode && statusCode >= 500) return '服务暂时繁忙，请稍后重试';

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
  const [loginAssistMode, setLoginAssistMode] = useState<'none' | 'forgot' | 'reset'>('none');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [latestResetToken, setLatestResetToken] = useState('');
  const [childSubmitting, setChildSubmitting] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [speakingMaterialId, setSpeakingMaterialId] = useState<string | null>(null);
  const [videoMaterialId, setVideoMaterialId] = useState<string | null>(null);
  const [deletingChildId, setDeletingChildId] = useState<string | null>(null);
  const [materialBusyId, setMaterialBusyId] = useState<string | null>(null);
  const [materialAction, setMaterialAction] = useState<'recognize' | 'generate' | 'audio' | 'video' | null>(null);
  const [expandedAudioMaterialId, setExpandedAudioMaterialId] = useState<string | null>(null);
  const [expandedVideoMaterialId, setExpandedVideoMaterialId] = useState<string | null>(null);
  const [generatedVideoUrls, setGeneratedVideoUrls] = useState<Record<string, string>>({});
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadChildId, setUploadChildId] = useState<string | undefined>(undefined);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>('');
  const [directMediaTitle, setDirectMediaTitle] = useState('家庭学习音视频');
  const [directMediaText, setDirectMediaText] = useState('');
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [deletingMaterialId, setDeletingMaterialId] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  const [loginForm] = Form.useForm();
  const [forgotForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [childForm] = Form.useForm();
  const [taskForm] = Form.useForm();

  const registerPassword = Form.useWatch('password', registerForm) || '';
  const resetPassword = Form.useWatch('password', resetForm) || '';

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
        throw new Error(getApiErrorMessage(meData, '用户信息加载失败', meRes.status));
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
          errors.push(getApiErrorMessage(childData, '孩子列表加载失败', childRes.status));
        }
      } catch {
        errors.push('孩子列表服务暂时不可用，请稍后重试');
      }

      try {
        const taskData = await parseApiResponse(taskRes);
        if (taskRes.ok) {
          setTasks(Array.isArray(taskData) ? (taskData as TaskItem[]) : []);
        } else {
          errors.push(getApiErrorMessage(taskData, '任务列表加载失败', taskRes.status));
        }
      } catch {
        errors.push('任务列表服务暂时不可用，请稍后重试');
      }

      try {
        const materialData = await parseApiResponse(materialRes);
        if (materialRes.ok) {
          setMaterials(Array.isArray(materialData) ? (materialData as MaterialItem[]) : []);
        } else {
          errors.push(getApiErrorMessage(materialData, '资料库加载失败', materialRes.status));
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

  const onRegister = async (values: { username: string; password: string; confirmPassword?: string; phone?: string }) => {
    registerForm.setFields([
      { name: 'username', errors: [] },
      { name: 'password', errors: [] },
      { name: 'confirmPassword', errors: [] },
      { name: 'phone', errors: [] },
    ]);
    const payload = {
      username: values.username,
      password: values.password,
      phone: values.phone?.trim() || undefined,
    };
    setAuthSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        applyFieldErrors(registerForm, data);
        message.error(getApiErrorMessage(data, '注册失败', res.status));
        return;
      }
      message.success(
        getApiErrorMessage(
          data,
          '注册成功，请返回登录页登录',
          res.status
        )
      );
      registerForm.resetFields();
      setAuthMode('login');
      setLoginAssistMode('none');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onLogin = async (values: { username: string; password: string }) => {
    loginForm.setFields([
      { name: 'username', errors: [] },
      { name: 'password', errors: [] },
    ]);
    setAuthSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        applyFieldErrors(loginForm, data);
        message.error(getApiErrorMessage(data, '登录失败', res.status));
        return;
      }
      const tokenValue = data && typeof data === 'object' ? (data as Record<string, unknown>).token : undefined;
      if (typeof tokenValue !== 'string' || !tokenValue) {
        message.error('登录失败');
        return;
      }
      setAppToken(tokenValue);
      setToken(tokenValue);
      loginForm.resetFields();
      message.success('登录成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onForgotPassword = async (values: { username: string }) => {
    forgotForm.setFields([{ name: 'username', errors: [] }]);
    setForgotSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        applyFieldErrors(forgotForm, data);
        message.error(getApiErrorMessage(data, '重置口令申请失败', res.status));
        return;
      }

      const tokenValue = data && typeof data === 'object'
        ? String((data as Record<string, unknown>).resetToken || '').trim()
        : '';
      setLatestResetToken(tokenValue);
      forgotForm.resetFields();
      message.success(getApiErrorMessage(data, '如账号存在，重置口令已生成', res.status));
      setAuthMode('login');
      setLoginAssistMode('reset');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setForgotSubmitting(false);
    }
  };

  const onResetPassword = async (values: { token: string; password: string; confirmPassword?: string }) => {
    resetForm.setFields([
      { name: 'token', errors: [] },
      { name: 'password', errors: [] },
      { name: 'confirmPassword', errors: [] },
    ]);
    const payload = {
      token: values.token,
      password: values.password,
    };
    setResetSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        applyFieldErrors(resetForm, data);
        message.error(getApiErrorMessage(data, '密码重置失败', res.status));
        return;
      }
      message.success(getApiErrorMessage(data, '密码已重置，请登录', res.status));
      setLatestResetToken('');
      resetForm.resetFields();
      setAuthMode('login');
      setLoginAssistMode('none');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setResetSubmitting(false);
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
        message.error(getApiErrorMessage(data, '创建孩子失败', res.status));
        return;
      }
      message.success('孩子档案已创建');
      childForm.resetFields();
      await reloadAll();
    } catch {
      message.error('创建孩子失败，请稍后重试');
    } finally {
      setChildSubmitting(false);
    }
  };

  const onCreateTask = async (values: {
    title: string;
    description?: string;
    materialId?: string;
    category: string;
    difficulty?: number;
    childId?: string;
    dueDate?: string;
  }) => {
    taskForm.setFields([
      { name: 'title', errors: [] },
      { name: 'description', errors: [] },
      { name: 'materialId', errors: [] },
      { name: 'category', errors: [] },
    ]);
    const payload = {
      ...values,
      description: values.description?.trim() || undefined,
      materialId: values.materialId?.trim() || undefined,
    };
    setTaskSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        applyFieldErrors(taskForm, data);
        message.error(getApiErrorMessage(data, '创建任务失败', res.status));
        return;
      }
      message.success('任务已创建');
      taskForm.resetFields();
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
        message.error(getApiErrorMessage(data, '删除孩子失败', res.status));
        return;
      }
      message.success('孩子档案已删除');
      await reloadAll();
    } finally {
      setDeletingChildId(null);
    }
  };

  const wait = (ms: number) => new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

  const fetchMaterialStatus = async (materialId: string): Promise<MaterialItem> => {
    const statusRes = await appFetch(`${APP_API_BASE}/library/materials/${materialId}/status`);
    const statusData = await parseApiResponse(statusRes);
    if (!statusRes.ok || !statusData || typeof statusData !== 'object' || Array.isArray(statusData)) {
      throw new Error(getApiErrorMessage(statusData, '资料状态查询失败', statusRes.status));
    }
    return statusData as unknown as MaterialItem;
  };

  const pollMaterialUntilDone = async (
    materialId: string,
    type: 'recognize' | 'generate',
    maxAttempts = 40,
    intervalMs = 1200
  ): Promise<MaterialItem> => {
    for (let i = 0; i < maxAttempts; i += 1) {
      const latest = await fetchMaterialStatus(materialId);
      const parsed = parseMaterialContent(latest.content);

      if (parsed.status === 'failed') {
        throw new Error(
          getFallbackReasonText(parsed.fallbackReason) || (type === 'recognize' ? '识别失败' : '生成任务失败')
        );
      }

      if (type === 'recognize') {
        const done = parsed.recognitionStatus === 'completed' || parsed.recognitionStatus === 'fallback';
        if (done || !!parsed.recognitionText) return latest;
      } else {
        const done = parsed.status === 'task_generated' || !!latest.taskId;
        if (done) return latest;
      }

      await wait(intervalMs);
    }

    throw new Error(type === 'recognize' ? '识别处理中，请稍后刷新查看结果' : '任务生成处理中，请稍后刷新查看结果');
  };

  const triggerCelebration = () => {
    setCelebrate(true);
    window.setTimeout(() => setCelebrate(false), 2400);
  };

  const onUploadMaterial = async (autoGenerateTask?: boolean) => {
    if (!uploadFile) {
      message.warning('请先选择要上传的文件');
      return;
    }
    setUploading(true);
    setUploadPercent(0);
    setUploadStage('📤 正在上传文件…');
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      if (uploadChildId) formData.append('childId', uploadChildId);

      const uploadRes = await appUpload(
        `${APP_API_BASE}/library/materials`,
        formData,
        (percent) => {
          setUploadPercent(percent);
          if (percent < 30) setUploadStage('📤 正在传输到云端…');
          else if (percent < 70) setUploadStage('🚀 文件飞奔中…');
          else setUploadStage('🧠 即将进入 AI 大脑…');
        }
      );

      if (!uploadRes.ok) {
        setUploadStage('');
        setUploadPercent(0);
        message.error(getApiErrorMessage(uploadRes.data, '上传失败', uploadRes.status));
        return;
      }

      setUploadPercent(100);
      const uploaded = uploadRes.data && typeof uploadRes.data === 'object' ? (uploadRes.data as Record<string, unknown>) : null;
      const uploadedMaterialId = uploaded && typeof uploaded.id === 'string' ? uploaded.id : null;

      if (autoGenerateTask && uploadedMaterialId) {
        setUploadStage('🔍 AI 正在阅读资料内容…');
        const recognizeRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/recognize`, {
          method: 'POST',
        });
        const recognizeData = await parseApiResponse(recognizeRes);
        if (!recognizeRes.ok) {
          message.error(getApiErrorMessage(recognizeData, '上传成功，但自动识别失败', recognizeRes.status));
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'recognize');

        setUploadStage('🎬 AI 正在生成音视频…');
        const generateRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/generate-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const generateData = await parseApiResponse(generateRes);
        if (!generateRes.ok) {
          message.error(getApiErrorMessage(generateData, '上传成功，但自动生成任务失败', generateRes.status));
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'generate');
        setUploadStage('🎉 生成完成！');
        message.success('上传成功，已自动识别并生成');
        if (uploadedMaterialId) {
          setExpandedAudioMaterialId(uploadedMaterialId);
          setExpandedVideoMaterialId(uploadedMaterialId);
        }
        triggerCelebration();
      } else {
        setUploadStage('✅ 上传成功');
        message.success('资料已加入资料库');
      }

      setUploadFile(null);
      setUploadChildId(undefined);
      const fileInput = document.querySelector<HTMLInputElement>('input[type="file"][data-role="material-upload"]');
      if (fileInput) fileInput.value = '';
      await reloadAll();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '上传失败，请稍后重试');
      await reloadAll();
    } finally {
      setUploading(false);
      window.setTimeout(() => {
        setUploadPercent(0);
        setUploadStage('');
      }, 1500);
    }
  };

  const onDeleteMaterial = async (materialId: string) => {
    setDeletingMaterialId(materialId);
    try {
      const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}`, {
        method: 'DELETE',
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '删除资料失败', res.status));
        return;
      }
      setSelectedMaterialIds((prev) => prev.filter((id) => id !== materialId));
      message.success('已删除');
      await reloadAll();
    } catch {
      message.error('删除失败，请稍后重试');
    } finally {
      setDeletingMaterialId(null);
    }
  };

  const onCleanupMaterials = async (ids?: string[]) => {
    setCleanupBusy(true);
    try {
      const payload = ids && ids.length ? { ids } : {};
      const res = await appFetch(`${APP_API_BASE}/library/materials/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '清理失败', res.status));
        return;
      }
      const removed = data && typeof data === 'object' ? Number((data as Record<string, unknown>).removed || 0) : 0;
      message.success(removed > 0 ? `已清理 ${removed} 条资料` : '没有需要清理的资料');
      setSelectedMaterialIds([]);
      await reloadAll();
    } catch {
      message.error('清理失败，请稍后重试');
    } finally {
      setCleanupBusy(false);
    }
  };

  const triggerMaterialRecognize = async (materialId: string) => {
    const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}/recognize`, {
      method: 'POST',
    });
    const data = await parseApiResponse(res);
    if (!res.ok) {
      throw new Error(getApiErrorMessage(data, '识别失败', res.status));
    }
  };

  const triggerMaterialTaskGeneration = async (
    materialId: string,
    payload: Record<string, unknown>
  ) => {
    const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}/generate-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await parseApiResponse(res);
    if (!res.ok) {
      throw new Error(getApiErrorMessage(data, '生成任务失败', res.status));
    }
  };

  const onGenerateMaterialProduct = async (materialId: string, kind: 'audio' | 'video') => {
    setMaterialBusyId(materialId);
    setMaterialAction(kind);
    try {
      await triggerMaterialRecognize(materialId);
      await pollMaterialUntilDone(materialId, 'recognize');

      await triggerMaterialTaskGeneration(materialId, {
        mediaKind: kind,
        titlePrefix: kind === 'audio' ? '音频生成' : '视频生成',
      });
      await pollMaterialUntilDone(materialId, 'generate');

      const latest = await fetchMaterialStatus(materialId);
      const parsed = parseMaterialContent(latest.content);
      await reloadAll();

      if (kind === 'audio') {
        if (parsed.audioUrl) {
          setExpandedAudioMaterialId(materialId);
          message.success('音频已生成，可直接在线播放');
          return;
        }
        if (parsed.recognitionText) {
          await onPlayMaterialAudio(materialId, parsed.recognitionText);
          return;
        }
        message.warning('暂未获得音频地址，请稍后重试');
        return;
      }

      if (parsed.videoUrl) {
        setExpandedVideoMaterialId(materialId);
        message.success('视频已生成，可直接在线播放');
        return;
      }
      if (parsed.recognitionText) {
        const localVideoUrl = await onGenerateMaterialVideo(materialId, parsed.fileName, parsed.recognitionText, 'landscape');
        if (localVideoUrl) {
          setExpandedVideoMaterialId(materialId);
          return;
        }
      }
      message.warning('暂未获得视频地址，请稍后重试');
    } catch (e) {
      message.error(e instanceof Error ? e.message : kind === 'audio' ? '音频生成失败，请稍后重试' : '视频生成失败，请稍后重试');
      await reloadAll();
    } finally {
      setMaterialBusyId(null);
      setMaterialAction(null);
    }
  };

  const onPlayMaterialAudio = async (materialId: string, text: string) => {
    const content = text.trim();
    if (!content) {
      message.warning('请先完成识别，拿到文本后再生成音频');
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      message.error('当前浏览器不支持语音播放');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.95;
    utterance.pitch = 1;

    setSpeakingMaterialId(materialId);
    message.loading({ content: '正在生成并播放音频…', key: `speak-${materialId}` });

    utterance.onend = () => {
      setSpeakingMaterialId(null);
      message.success({ content: '音频播放完成', key: `speak-${materialId}` });
    };
    utterance.onerror = () => {
      setSpeakingMaterialId(null);
      message.error({ content: '音频生成失败，请重试', key: `speak-${materialId}` });
    };

    window.speechSynthesis.speak(utterance);
  };

  const onGenerateMaterialVideo = async (
    materialId: string,
    title: string,
    text: string,
    orientation: 'landscape' | 'portrait'
  ): Promise<string | null> => {
    const content = text.trim();
    if (!content) {
      message.warning('请先完成识别，拿到文本后再生成视频');
      return null;
    }
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      message.error('当前浏览器不支持视频生成');
      return null;
    }

    const isPortrait = orientation === 'portrait';
    const videoKey = `${materialId}-${orientation}`;
    const canvas = document.createElement('canvas');
    canvas.width = isPortrait ? 720 : 1280;
    canvas.height = isPortrait ? 1280 : 720;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') {
      message.error('当前设备不支持视频导出');
      return null;
    }

    const maxCharsPerLine = isPortrait ? 14 : 22;
    const lines = content
      .replace(/\r/g, '')
      .split(/\n+/)
      .flatMap((line) => {
        const value = line.trim();
        if (!value) return [];
        const parts: string[] = [];
        for (let i = 0; i < value.length; i += maxCharsPerLine) {
          parts.push(value.slice(i, i + maxCharsPerLine));
        }
        return parts;
      })
      .slice(0, 36);

    const preferredTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';

    setVideoMaterialId(videoKey);
    message.loading({ content: `正在生成${isPortrait ? '竖屏' : '横屏'}视频，请稍候…`, key: `video-${videoKey}` });

    let audioContext: AudioContext | null = null;
    try {
      const videoStream = canvas.captureStream(24);
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const masterGain = audioContext.createGain();
      masterGain.gain.value = 0.03;
      masterGain.connect(destination);

      const durationMs = Math.min(28000, Math.max(10000, lines.length * 850));
      const beatMs = 600;
      const notePattern = [392, 523.25, 659.25, 523.25];
      for (let i = 0; i * beatMs < durationMs + 1200; i += 1) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.type = i % 8 < 4 ? 'sine' : 'triangle';
        oscillator.frequency.value = notePattern[i % notePattern.length];
        gainNode.gain.value = 0;
        oscillator.connect(gainNode);
        gainNode.connect(masterGain);

        const startTime = audioContext.currentTime + (i * beatMs) / 1000;
        const endTime = startTime + 0.46;
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(1, startTime + 0.08);
        gainNode.gain.linearRampToValueAtTime(0.01, endTime);
        oscillator.start(startTime);
        oscillator.stop(endTime + 0.02);
      }

      const mixedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);

      const recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      const startedAt = Date.now();
      const totalChars = Math.max(1, lines.join('').length);
      let raf = 0;

      const draw = () => {
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(1, elapsed / durationMs);
        const activeChar = Math.floor(progress * totalChars);

        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#e6f4ff');
        gradient.addColorStop(0.5, '#fff7e6');
        gradient.addColorStop(1, '#f6ffed');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#1d39c4';
        ctx.font = `bold ${isPortrait ? 40 : 58}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText('幼升小启蒙课堂', isPortrait ? 50 : 90, isPortrait ? 90 : 120);

        ctx.fillStyle = '#262626';
        ctx.font = `${isPortrait ? 30 : 42}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText(title || '学习资料', isPortrait ? 50 : 90, isPortrait ? 145 : 190);

        let consumed = 0;
        let currentLineIndex = 0;
        for (let i = 0; i < lines.length; i += 1) {
          const next = consumed + lines[i].length;
          if (activeChar <= next) {
            currentLineIndex = i;
            break;
          }
          consumed = next;
        }

        const visibleCount = isPortrait ? 9 : 7;
        const startIndex = Math.max(0, Math.min(currentLineIndex - 2, lines.length - visibleCount));
        const visibleLines = lines.slice(startIndex, startIndex + visibleCount);

        ctx.font = `${isPortrait ? 34 : 38}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        visibleLines.forEach((line, idx) => {
          const actualIndex = startIndex + idx;
          const y = (isPortrait ? 250 : 290) + idx * (isPortrait ? 80 : 58);
          ctx.fillStyle = '#434343';
          ctx.fillText(line, isPortrait ? 60 : 100, y);

          if (actualIndex === currentLineIndex) {
            const progressInLine = Math.max(0, Math.min(line.length, activeChar - consumed));
            const highlighted = line.slice(0, progressInLine);
            ctx.fillStyle = '#0958d9';
            ctx.fillText(highlighted, isPortrait ? 60 : 100, y);
          }
        });

        const barX = isPortrait ? 50 : 90;
        const barY = isPortrait ? 1180 : 650;
        const barW = isPortrait ? 620 : 1100;
        const barH = 14;
        ctx.fillStyle = '#d9d9d9';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = '#1677ff';
        ctx.fillRect(barX, barY, barW * progress, barH);

        ctx.fillStyle = '#8c8c8c';
        ctx.font = `${isPortrait ? 20 : 26}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText('AI自动生成 · 可用于家庭跟读练习', isPortrait ? 50 : 90, isPortrait ? 1230 : 690);

        if (elapsed < durationMs) raf = requestAnimationFrame(draw);
      };

      await new Promise<void>((resolve, reject) => {
        recorder.onerror = () => reject(new Error('video_recorder_error'));
        recorder.onstop = () => resolve();
        recorder.start(200);
        draw();
        window.setTimeout(() => {
          cancelAnimationFrame(raf);
          if (recorder.state !== 'inactive') recorder.stop();
          mixedStream.getTracks().forEach((track) => track.stop());
        }, durationMs);
      });

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      if (materialId === 'direct-text') {
        setGeneratedVideoUrls((prev) => ({
          ...prev,
          [`direct-text-${orientation}`]: url,
        }));
      } else {
        setGeneratedVideoUrls((prev) => ({
          ...prev,
          [materialId]: url,
        }));
        setExpandedVideoMaterialId(materialId);
      }
      triggerCelebration();

      message.success({ content: `${isPortrait ? '竖屏' : '横屏'}视频生成完成，可直接在线播放`, key: `video-${videoKey}` });
      return url;
    } catch {
      message.error({ content: '视频生成失败，请稍后重试', key: `video-${videoKey}` });
      return null;
    } finally {
      if (audioContext) {
        await audioContext.close().catch(() => undefined);
      }
      setVideoMaterialId(null);
    }
  };

  if (!token) {
    return (
      <div className="auth-shell">
        <Card className="auth-card">
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="幼升小启蒙 APP"
              description="先注册或登录家长账号，再为孩子创建学习任务。首次访问服务启动可能需要 10-30 秒。"
            />

            <Tabs
              activeKey={authMode}
              onChange={(key) => {
                setAuthMode(key as 'register' | 'login');
                setLoginAssistMode('none');
              }}
              items={[
                {
                  key: 'login',
                  label: '登录',
                  children: (
                    <Space direction="vertical" size={10} style={{ width: '100%' }}>
                      <Form form={loginForm} layout="vertical" onFinish={onLogin} autoComplete="on">
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

                      {loginAssistMode === 'none' && (
                        <Button type="link" style={{ paddingInline: 0 }} onClick={() => setLoginAssistMode('forgot')}>
                          忘记密码？
                        </Button>
                      )}

                      {loginAssistMode === 'forgot' && (
                        <Card size="small" title="找回密码" className="auth-assist-card">
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Typography.Text type="secondary">输入用户名后可生成一次性重置口令（有效期 30 分钟）。</Typography.Text>
                            <Form form={forgotForm} layout="vertical" onFinish={onForgotPassword} autoComplete="off">
                              <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                                <Input placeholder="请输入用户名" autoComplete="username" />
                              </Form.Item>
                              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                                <Button htmlType="submit" loading={forgotSubmitting} type="primary">申请重置口令</Button>
                                <Button onClick={() => setLoginAssistMode('reset')}>我已有口令</Button>
                              </Space>
                            </Form>
                          </Space>
                        </Card>
                      )}

                      {loginAssistMode === 'reset' && (
                        <Card size="small" title="重置密码" className="auth-assist-card">
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            {latestResetToken && (
                              <Alert
                                type="success"
                                showIcon
                                message="已生成重置口令"
                                description={<Typography.Text copyable>{latestResetToken}</Typography.Text>}
                              />
                            )}
                            <Form form={resetForm} layout="vertical" onFinish={onResetPassword} autoComplete="off">
                              <Form.Item label="重置口令" name="token" rules={[{ required: true, message: '请输入重置口令' }]}>
                                <Input placeholder="请输入重置口令" />
                              </Form.Item>
                              <Form.Item
                                label="新密码"
                                name="password"
                                rules={[
                                  { required: true, message: '请输入新密码' },
                                  { pattern: PASSWORD_RULE_REGEX, message: PASSWORD_RULE_TEXT },
                                ]}
                              >
                                <Input.Password placeholder="请输入新密码" autoComplete="new-password" />
                              </Form.Item>
                              <Typography.Text type="secondary">密码强度校验</Typography.Text>
                              {renderPasswordRuleHint(resetPassword)}
                              <Form.Item
                                label="确认新密码"
                                name="confirmPassword"
                                dependencies={['password']}
                                rules={[
                                  { required: true, message: '请再次输入新密码' },
                                  ({ getFieldValue }) => ({
                                    validator(_, value) {
                                      if (!value || getFieldValue('password') === value) {
                                        return Promise.resolve();
                                      }
                                      return Promise.reject(new Error('两次输入的密码不一致'));
                                    },
                                  }),
                                ]}
                              >
                                <Input.Password placeholder="请再次输入新密码" autoComplete="new-password" />
                              </Form.Item>
                              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                                <Button htmlType="submit" loading={resetSubmitting} type="primary">提交重置</Button>
                                <Button onClick={() => setLoginAssistMode('forgot')}>返回申请口令</Button>
                              </Space>
                            </Form>
                          </Space>
                        </Card>
                      )}
                    </Space>
                  ),
                },
                {
                  key: 'register',
                  label: '注册',
                  children: (
                    <Form form={registerForm} layout="vertical" onFinish={onRegister} autoComplete="on">
                      <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                        <Input placeholder="请输入用户名" autoComplete="username" />
                      </Form.Item>
                      <Form.Item
                        label="密码"
                        name="password"
                        rules={[
                          { required: true, message: '请输入密码' },
                          { pattern: PASSWORD_RULE_REGEX, message: PASSWORD_RULE_TEXT },
                        ]}
                      >
                        <Input.Password placeholder="请输入密码" autoComplete="new-password" />
                      </Form.Item>
                      <Typography.Text type="secondary">密码强度校验</Typography.Text>
                      {renderPasswordRuleHint(registerPassword)}
                      <Form.Item
                        label="确认密码"
                        name="confirmPassword"
                        dependencies={['password']}
                        rules={[
                          { required: true, message: '请再次输入密码' },
                          ({ getFieldValue }) => ({
                            validator(_, value) {
                              if (!value || getFieldValue('password') === value) {
                                return Promise.resolve();
                              }
                              return Promise.reject(new Error('两次输入的密码不一致'));
                            },
                          }),
                        ]}
                      >
                        <Input.Password placeholder="请再次输入密码" autoComplete="new-password" />
                      </Form.Item>
                      <Form.Item
                        label="手机号（选填）"
                        name="phone"
                        rules={[
                          {
                            validator(_, value) {
                              const phone = String(value || '').trim();
                              if (!phone || /^1\d{10}$/.test(phone)) {
                                return Promise.resolve();
                              }
                              return Promise.reject(new Error('手机号格式不正确，请输入 11 位手机号'));
                            },
                          },
                        ]}
                        extra="短信验证能力将按配置逐步开启，当前注册后会提示状态。"
                      >
                        <Input placeholder="请输入 11 位手机号" autoComplete="tel" maxLength={11} />
                      </Form.Item>
                      <Button type="primary" htmlType="submit" loading={authSubmitting} block>
                        注册
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
    <div className="app-page-shell app-learning-shell">
      {celebrate && (
        <div className="celebrate-overlay" aria-hidden="true">
          {Array.from({ length: 24 }).map((_, i) => (
            <span key={i} className={`confetti confetti-${i % 6}`} style={{ left: `${(i * 4.2) % 100}%`, animationDelay: `${(i % 8) * 0.05}s` }}>
              {['🎉', '✨', '🎊', '⭐', '🌟', '💫'][i % 6]}
            </span>
          ))}
        </div>
      )}
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        loading={loading}
        className="app-main-card"
        title={<Typography.Text strong style={{ fontSize: 18 }}>家长学习中心</Typography.Text>}
        extra={<Button onClick={() => { clearAppToken(); setToken(null); setMe(null); }}>退出</Button>}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            当前家长：<strong>{me?.displayName || me?.username || '未命名家长'}</strong>
          </Typography.Paragraph>
          <div className="stats-grid">
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">孩子数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{children.length}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">任务总数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{tasks.length}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">今日任务</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{totalTodayTaskCount}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">本周完成</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{totalWeeklyDoneCount}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">资料总数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{materials.length}</Typography.Title>
            </Card>
          </div>
          {children.length === 0 && tasks.length === 0 ? (
            <Alert
              showIcon
              type="info"
              message="还没有学习数据，先从这三步开始"
              description="先新增孩子档案，再创建任务，最后进入“今日任务”开始学习。"
            />
          ) : null}
        </Space>
      </Card>

      <Card title="孩子档案管理" className="app-section-card section-children">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="inline" form={childForm} onFinish={onCreateChild}>
            <Form.Item name="name" rules={[{ required: true, message: '请输入孩子姓名' }]}>
              <Input placeholder="孩子姓名" />
            </Form.Item>
            <Form.Item name="gradeLevel">
              <Select
                placeholder="年级阶段"
                style={{ width: 160 }}
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
                options={[
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
              <List.Item className="list-item-soft"
                actions={[
                  <Link key="today" to={`/child/${item.id}/today`}>今日任务</Link>,
                  <Link key="report" to={`/reports/${item.id}`}>学习报告</Link>,
                  <Popconfirm
                    key="delete"
                    title="确认删除该孩子档案？"
                    description="此操作不可恢复：该孩子的任务与学习进度会一起删除。"
                    okText="确认删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    overlayClassName="danger-popconfirm"
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
                    {item.gradeLevel && <Tag className="grade-tag">{getGradeLevelLabel(item.gradeLevel)}</Tag>}
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

      <Card title="学习任务管理" className="app-section-card section-tasks">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="inline" form={taskForm} onFinish={onCreateTask}>
            <Form.Item name="title" rules={[{ required: true, message: '请输入任务标题' }]}>
              <Input placeholder="任务标题" />
            </Form.Item>
            <Form.Item
              name="description"
              rules={[
                {
                  validator(_, value) {
                    const materialId = String(taskForm.getFieldValue('materialId') || '').trim();
                    const description = String(value || '').trim();
                    if (description || materialId) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('请填写任务说明或关联学习资料'));
                  },
                },
              ]}
            >
              <Input placeholder="任务说明（与资料二选一）" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item
              name="materialId"
              dependencies={['description']}
              rules={[
                {
                  validator(_, value) {
                    const materialId = String(value || '').trim();
                    const description = String(taskForm.getFieldValue('description') || '').trim();
                    if (description || materialId) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('请填写任务说明或关联学习资料'));
                  },
                },
              ]}
            >
              <Select
                allowClear
                showSearch
                placeholder="关联学习资料（与说明二选一）"
                style={{ width: 240 }}
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
                options={materials.map((m) => {
                  const parsed = parseMaterialContent(m.content);
                  return {
                    label: parsed.fileName,
                    value: m.id,
                  };
                })}
              />
            </Form.Item>
            <Form.Item name="category" rules={[{ required: true, message: '请选择任务分类' }]}>
              <Select
                placeholder="任务分类"
                style={{ width: 140 }}
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
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
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
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
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
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
                <List.Item className="list-item-soft">
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

      <Card
        title={
          <Space>
            <span className="hero-emoji" role="img" aria-label="magic">🪄</span>
            <span>文本直出音视频（免上传）</span>
          </Space>
        }
        className="app-section-card section-direct"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div className="hero-banner hero-banner-purple">
            <div className="hero-banner-title">📝 粘贴文字 → 🎧 听 → 🎬 看</div>
            <div className="hero-banner-sub">把任何一段文字变成会朗读的音频和动画字幕视频，孩子立马愿意看</div>
          </div>
          <Input
            value={directMediaTitle}
            onChange={(e) => setDirectMediaTitle(e.target.value)}
            placeholder="给你的作品起个名字～"
            maxLength={40}
          />
          <Input.TextArea
            value={directMediaText}
            onChange={(e) => setDirectMediaText(e.target.value)}
            placeholder="把要朗读的故事 / 课文 / 知识点粘贴到这里…"
            autoSize={{ minRows: 4, maxRows: 10 }}
            maxLength={2400}
            showCount
          />
          <Space wrap>
            <Button
              type="primary"
              onClick={() => onPlayMaterialAudio('direct-text', directMediaText)}
              loading={speakingMaterialId === 'direct-text'}
              disabled={!directMediaText.trim()}
            >
              🎙️ 朗读这段文字
            </Button>
            <Button
              onClick={() => onGenerateMaterialVideo('direct-text', directMediaTitle, directMediaText, 'landscape')}
              loading={videoMaterialId === 'direct-text-landscape'}
              disabled={!directMediaText.trim()}
            >
              🖥️ 横屏视频
            </Button>
            <Button
              onClick={() => onGenerateMaterialVideo('direct-text', directMediaTitle, directMediaText, 'portrait')}
              loading={videoMaterialId === 'direct-text-portrait'}
              disabled={!directMediaText.trim()}
            >
              📱 竖屏视频
            </Button>
          </Space>
          {(generatedVideoUrls['direct-text-landscape'] || generatedVideoUrls['direct-text-portrait']) && (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {generatedVideoUrls['direct-text-landscape'] && (
                <div className="media-frame video-frame">
                  <Typography.Text type="secondary">🖥️ 横屏视频</Typography.Text>
                  <video
                    controls
                    autoPlay
                    src={generatedVideoUrls['direct-text-landscape']}
                    style={{ width: '100%', borderRadius: 10, background: '#000' }}
                  />
                </div>
              )}
              {generatedVideoUrls['direct-text-portrait'] && (
                <div className="media-frame video-frame">
                  <Typography.Text type="secondary">📱 竖屏视频</Typography.Text>
                  <video
                    controls
                    autoPlay
                    src={generatedVideoUrls['direct-text-portrait']}
                    style={{ width: '100%', maxWidth: 360, borderRadius: 10, background: '#000' }}
                  />
                </div>
              )}
            </Space>
          )}
        </Space>
      </Card>

      <Card
        title={
          <Space>
            <span className="hero-emoji" role="img" aria-label="library">📚</span>
            <span>资料库 · 一键上传秒变音视频</span>
          </Space>
        }
        className="app-section-card section-materials hero-card"
        extra={
          materials.length > 0 ? (
            <Space>
              {selectedMaterialIds.length > 0 && (
                <Popconfirm
                  title={`确认删除已选 ${selectedMaterialIds.length} 条资料？`}
                  description="将连同生成的音视频一起删除，不可恢复。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onCleanupMaterials(selectedMaterialIds)}
                >
                  <Button danger size="small" loading={cleanupBusy}>批量删除 ({selectedMaterialIds.length})</Button>
                </Popconfirm>
              )}
              <Popconfirm
                title="确认清空全部资料？"
                description="将删除所有上传的资料及其生成的音视频，不可恢复。"
                okText="确认清空"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onCleanupMaterials()}
              >
                <Button danger type="text" size="small" loading={cleanupBusy}>🧹 清空全部</Button>
              </Popconfirm>
            </Space>
          ) : null
        }
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div className="hero-banner">
            <div className="hero-banner-title">🎙️ 上传任何文本，秒变会读会演的音视频</div>
            <div className="hero-banner-sub">📄 文档 · 🖼️ 图片 · 📃 PDF · 📝 文本 都行，AI 帮你读出来、演出来</div>
          </div>
          <Space wrap align="center" size={10} className="upload-row">
            <label className="file-pick-btn">
              <span>📎 选择文件</span>
              <input
                type="file"
                data-role="material-upload"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.markdown,.csv"
              />
            </label>
            {uploadFile && (
              <Tag color="blue" closable onClose={(e) => {
                e.preventDefault();
                setUploadFile(null);
                const fi = document.querySelector<HTMLInputElement>('input[type="file"][data-role="material-upload"]');
                if (fi) fi.value = '';
              }}>
                {uploadFile.name}
              </Tag>
            )}
            <Select
              allowClear
              placeholder="可选：绑定孩子"
              style={{ width: 180 }}
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
              value={uploadChildId}
              onChange={(v) => setUploadChildId(v)}
              options={children.map((c) => ({ label: c.name, value: c.id }))}
            />
            <Button onClick={() => onUploadMaterial(false)} loading={uploading} disabled={uploading || !uploadFile}>仅上传</Button>
            <Button type="primary" size="large" className="hero-cta" onClick={() => onUploadMaterial(true)} loading={uploading} disabled={uploading || !uploadFile}>
              ✨ 一键生成音视频
            </Button>
          </Space>

          {(uploading || uploadStage) && (
            <div className="upload-progress-box">
              <Progress
                percent={uploadPercent}
                status={uploadPercent >= 100 ? 'success' : 'active'}
                strokeColor={{ from: '#1677ff', to: '#9254de' }}
              />
              <div className="upload-stage-text">{uploadStage || '处理中…'}</div>
            </div>
          )}

          <List
            dataSource={materials}
            locale={{
              emptyText: (
                <div className="empty-state">
                  <div className="empty-state-emoji">🎈</div>
                  <div className="empty-state-title">资料库还空空的</div>
                  <div className="empty-state-sub">挑一份文档或图片，AI 帮你变成会读会演的音视频～</div>
                </div>
              ),
            }}
            renderItem={(item) => {
              const parsed = parseMaterialContent(item.content);
              const materialStatus = getMaterialStatusMeta(parsed.status);
              const fileHref = parsed.fileUrl ? resolveAssetUrl(parsed.fileUrl) : '';
              const resolvedAudioUrl = parsed.audioUrl ? resolveAssetUrl(parsed.audioUrl) : '';
              const resolvedVideoUrl = parsed.videoUrl ? resolveAssetUrl(parsed.videoUrl) : '';
              const localVideoUrl = generatedVideoUrls[item.id] || '';
              const playableVideoUrl = resolvedVideoUrl || localVideoUrl;
              const isGeneratingAudio = materialBusyId === item.id && materialAction === 'audio';
              const isGeneratingVideo = materialBusyId === item.id && materialAction === 'video';
              const isAnyGenerating = materialBusyId === item.id;
              const hasFallbackAudio = parsed.mediaStatus === 'fallback' && !resolvedAudioUrl && !!parsed.recognitionText;
              const hasFallbackVideo = parsed.mediaStatus === 'fallback' && !playableVideoUrl;
              const audioReady = !!resolvedAudioUrl;
              const videoReady = !!playableVideoUrl;
              const showAudioPlayer = audioReady && expandedAudioMaterialId === item.id;
              const showVideoPlayer = videoReady && expandedVideoMaterialId === item.id;
              const lowerName = parsed.fileName.toLowerCase();
              const sourceEmoji = parsed.sourceType === 'image' ? '🖼️'
                : parsed.sourceType === 'video' ? '🎬'
                : parsed.sourceType === 'audio' ? '🎧'
                : lowerName.endsWith('.pdf') ? '📕'
                : /\.(doc|docx|ppt|pptx|xls|xlsx)$/.test(lowerName) ? '📄'
                : /\.(txt|md|markdown|csv)$/.test(lowerName) ? '📝'
                : '📦';
              const isSelected = selectedMaterialIds.includes(item.id);
              return (
                <List.Item className="list-item-soft material-list-item">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <div className="material-header-row">
                      <Space wrap size={8}>
                        <Checkbox
                          checked={isSelected}
                          onChange={(e) => {
                            setSelectedMaterialIds((prev) =>
                              e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)
                            );
                          }}
                        />
                        <span className="material-emoji">{sourceEmoji}</span>
                        <Typography.Text strong>{parsed.fileName}</Typography.Text>
                        <Tag color={materialStatus.color}>{materialStatus.label}</Tag>
                        {audioReady && <Tag color="purple">🎧 音频就绪</Tag>}
                        {videoReady && <Tag color="magenta">🎬 视频就绪</Tag>}
                        {(() => {
                          const aiMeta = getAiStageMeta(parsed.recognitionStatus, parsed.mediaStatus);
                          return aiMeta ? <Tag color={aiMeta.color}>{aiMeta.label}</Tag> : null;
                        })()}
                        {item.childId ? <Tag color="blue">已绑定孩子</Tag> : null}
                        {isRecognitionLikelyTruncated(parsed.recognitionText) && <Tag color="gold">识别内容已截断</Tag>}
                      </Space>
                      <Popconfirm
                        title="确认删除该资料？"
                        description="将连同生成的音视频一起删除，不可恢复。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDeleteMaterial(item.id)}
                      >
                        <Button
                          danger
                          type="text"
                          size="small"
                          loading={deletingMaterialId === item.id}
                          disabled={deletingMaterialId !== null && deletingMaterialId !== item.id}
                        >
                          🗑️ 删除
                        </Button>
                      </Popconfirm>
                    </div>

                    <div className="material-meta-row">
                      <Typography.Text type="secondary">⏱️ {dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Typography.Text>
                    </div>

                    {!!parsed.fallbackReason && (
                      <Typography.Text type="warning">回退说明：{getFallbackReasonText(parsed.fallbackReason)}</Typography.Text>
                    )}

                    {hasFallbackVideo && (
                      <Typography.Text type="secondary">
                        暂无法生成专业视频{parsed.fallbackReason ? `（${getFallbackReasonText(parsed.fallbackReason)}）` : ''}
                      </Typography.Text>
                    )}

                    {audioReady && showAudioPlayer && (
                      <div className="media-frame audio-frame">
                        <audio
                          controls
                          autoPlay={expandedAudioMaterialId === item.id}
                          src={resolvedAudioUrl}
                          style={{ width: '100%' }}
                        />
                      </div>
                    )}

                    {videoReady && showVideoPlayer && (
                      <div className="media-frame video-frame">
                        <video
                          controls
                          autoPlay={expandedVideoMaterialId === item.id}
                          src={playableVideoUrl}
                          style={{ width: '100%', borderRadius: 10, background: '#000' }}
                        />
                      </div>
                    )}

                    <Space wrap size={8} className="material-action-row">
                      {!!fileHref && (
                        <Typography.Link href={fileHref} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                          查看原文件
                        </Typography.Link>
                      )}
                      <Button
                        size="small"
                        type={audioReady ? 'default' : 'primary'}
                        loading={isGeneratingAudio}
                        disabled={isAnyGenerating}
                        onClick={() => {
                          if (audioReady) {
                            setExpandedAudioMaterialId((prev) => (prev === item.id ? null : item.id));
                            return;
                          }
                          if (hasFallbackAudio) {
                            void onPlayMaterialAudio(item.id, parsed.recognitionText);
                            return;
                          }
                          void onGenerateMaterialProduct(item.id, 'audio');
                        }}
                      >
                        {audioReady
                          ? (showAudioPlayer ? '⏸ 收起' : '▶️ 播放音频')
                          : (hasFallbackAudio ? '🔊 朗读文本' : '🎙️ 生成音频')}
                      </Button>
                      <Button
                        size="small"
                        type={videoReady ? 'default' : 'primary'}
                        loading={isGeneratingVideo}
                        disabled={isAnyGenerating}
                        onClick={() => {
                          if (videoReady) {
                            setExpandedVideoMaterialId((prev) => (prev === item.id ? null : item.id));
                            return;
                          }
                          void onGenerateMaterialProduct(item.id, 'video');
                        }}
                      >
                        {videoReady
                          ? (showVideoPlayer ? '⏸ 收起' : '▶️ 播放视频')
                          : '🎬 生成视频'}
                      </Button>
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Space>
      </Card>
    </Space>
  </div>
  );
}
