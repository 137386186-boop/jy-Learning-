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
    scheduledDate: typeof data.scheduledDate === 'string' ? data.scheduledDate : '',
    completedAt: typeof data.completedAt === 'string' ? data.completedAt : '',
  };
}

const GRADE_LEVEL_LABEL: Record<string, string> = {
  pre_k: '学前',
  kindergarten: '幼儿园',
  primary_prep: '幼升小',
};

function getGradeLevelLabel(value?: string | null) {
  if (!value) return '';
  return GRADE_LEVEL_LABEL[value] || value;
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
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'register' | 'login'>('login');
  const [loginAssistMode, setLoginAssistMode] = useState<'none' | 'forgot' | 'reset'>('none');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [latestResetToken, setLatestResetToken] = useState('');
  const [childSubmitting, setChildSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
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
  const [createMode, setCreateMode] = useState<'upload' | 'paste'>('upload');

  // —— 日历看板 & 安排日期相关 ——
  const todayStr = dayjs().format('YYYY-MM-DD');
  const computeWeekStart = (anchor: dayjs.Dayjs) => {
    const day = anchor.day(); // 0=Sun..6=Sat
    return anchor.subtract(day === 0 ? 6 : day - 1, 'day').format('YYYY-MM-DD');
  };
  const [uploadScheduledDate, setUploadScheduledDate] = useState<string>(todayStr);
  const [boardWeekStart, setBoardWeekStart] = useState<string>(() => computeWeekStart(dayjs()));
  const [boardChildFilter, setBoardChildFilter] = useState<string | undefined>(undefined);
  const [scheduleBusyId, setScheduleBusyId] = useState<string | null>(null);
  const [completeBusyId, setCompleteBusyId] = useState<string | null>(null);
  const [showChildForm, setShowChildForm] = useState(false);

  const [loginForm] = Form.useForm();
  const [forgotForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [childForm] = Form.useForm();

  const registerPassword = Form.useWatch('password', registerForm) || '';
  const resetPassword = Form.useWatch('password', resetForm) || '';

  // —— 基于 materials.scheduledDate/completedAt 重新计算统计（取代已废弃的 LearningTask 统计）——
  const materialStats = useMemo(() => {
    const today = dayjs().format('YYYY-MM-DD');
    const day0 = dayjs();
    const day = day0.day();
    const weekStart = day0.subtract(day === 0 ? 6 : day - 1, 'day').format('YYYY-MM-DD');
    const weekEnd = dayjs(weekStart).add(6, 'day').format('YYYY-MM-DD');

    let totalScheduled = 0;
    let totalCompleted = 0;
    let todayCount = 0;
    let weekDone = 0;
    const perChildToday = new Map<string, number>();
    const perChildWeekDone = new Map<string, number>();

    for (const m of materials) {
      const parsed = parseMaterialContent(m.content);
      const sd = parsed.scheduledDate;
      const cd = parsed.completedAt;
      if (sd) {
        totalScheduled += 1;
        if (sd === today) {
          todayCount += 1;
          if (m.childId) perChildToday.set(m.childId, (perChildToday.get(m.childId) || 0) + 1);
        }
        if (sd >= weekStart && sd <= weekEnd) {
          if (cd) {
            weekDone += 1;
            if (m.childId) perChildWeekDone.set(m.childId, (perChildWeekDone.get(m.childId) || 0) + 1);
          }
        }
      }
      if (cd) totalCompleted += 1;
    }

    return { totalScheduled, totalCompleted, todayCount, weekDone, perChildToday, perChildWeekDone };
  }, [materials]);

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

      const [childRes, materialRes] = await Promise.all([
        appFetch(`${APP_API_BASE}/children`),
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

  const onUploadMaterial = async (autoGenerateTask?: boolean, fileOverride?: File) => {
    const fileToUpload = fileOverride || uploadFile;
    if (!fileToUpload) {
      message.warning('请先选择要上传的文件');
      return;
    }
    setUploading(true);
    setUploadPercent(0);
    setUploadStage('📤 正在上传文件…');
    try {
      const formData = new FormData();
      formData.append('file', fileToUpload);
      // 单孩家庭：未选时默认绑定唯一孩子
      const effectiveChildId = uploadChildId || (children.length === 1 ? children[0].id : undefined);
      if (effectiveChildId) formData.append('childId', effectiveChildId);
      if (uploadScheduledDate && /^\d{4}-\d{2}-\d{2}$/.test(uploadScheduledDate)) {
        formData.append('scheduledDate', uploadScheduledDate);
      }

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

  const onUpdateMaterial = async (
    materialId: string,
    patch: { scheduledDate?: string | null; childId?: string | null; completed?: boolean },
    busyKind: 'schedule' | 'complete' = 'schedule'
  ) => {
    if (busyKind === 'schedule') setScheduleBusyId(materialId);
    if (busyKind === 'complete') setCompleteBusyId(materialId);
    try {
      const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '更新失败', res.status));
        return false;
      }
      // 本地立即合并，避免等 reload
      setMaterials((prev) => prev.map((m) => (m.id === materialId ? (data as unknown as MaterialItem) : m)));
      return true;
    } catch {
      message.error('更新失败，请稍后重试');
      return false;
    } finally {
      if (busyKind === 'schedule') setScheduleBusyId(null);
      if (busyKind === 'complete') setCompleteBusyId(null);
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

    // 先停掉上一轮朗读（如果有），并标记其 stopped，避免遗留回调把新一轮打断
    const prevCancel = (window as unknown as { __jyLastTtsCancel?: () => void }).__jyLastTtsCancel;
    if (typeof prevCancel === 'function') {
      try { prevCancel(); } catch { /* ignore */ }
    }
    window.speechSynthesis.cancel();

    // 预热 voices：Chrome 首次冷启动若 voices 未就绪，speak 会静默失败
    const ensureVoicesReady = async () => {
      const list = window.speechSynthesis.getVoices();
      if (list && list.length) return;
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const timer = window.setInterval(() => {
          if (window.speechSynthesis.getVoices().length || Date.now() - start > 1500) {
            window.clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    };
    await ensureVoicesReady();

    // 选一个中文 voice（如无则让浏览器自行选）
    const voices = window.speechSynthesis.getVoices();
    const zhVoice =
      voices.find((v) => /zh(-|_)?CN/i.test(v.lang)) ||
      voices.find((v) => /^zh/i.test(v.lang)) ||
      null;

    // 分段：先按句号/问号/分号/换行切，再把长句限制在 60 字内（控制单段时长 < 12s，远低于 Chrome 15s 截断阈值）
    const SEGMENT_MAX = 60;
    const segments = content
      .replace(/\r/g, '')
      .split(/(?<=[。！？!?；;\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .flatMap((s) => {
        if (s.length <= SEGMENT_MAX) return [s];
        const parts: string[] = [];
        // 优先在逗号/顿号切
        const subs = s.split(/(?<=[，、,])/);
        let buf = '';
        for (const sub of subs) {
          if ((buf + sub).length > SEGMENT_MAX) {
            if (buf) parts.push(buf);
            // 单子句仍过长则硬切
            if (sub.length > SEGMENT_MAX) {
              for (let i = 0; i < sub.length; i += SEGMENT_MAX) parts.push(sub.slice(i, i + SEGMENT_MAX));
              buf = '';
            } else {
              buf = sub;
            }
          } else {
            buf += sub;
          }
        }
        if (buf) parts.push(buf);
        return parts;
      });

    if (!segments.length) segments.push(content);

    message.loading({ content: `🔊 正在朗读，全文约 ${content.length} 字（共 ${segments.length} 段）…`, key: `speak-${materialId}` });

    let idx = 0;
    let stopped = false;
    let advanced = false;
    let watchdog: number | null = null;
    const clearWatchdog = () => {
      if (watchdog !== null) {
        window.clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const advance = (delayMs: number) => {
      if (advanced) return;
      advanced = true;
      clearWatchdog();
      idx += 1;
      window.setTimeout(speakNext, delayMs);
    };

    function speakNext() {
      if (stopped) return;
      if (idx >= segments.length) {
        message.success({ content: `✅ 朗读完成（共 ${segments.length} 段）`, key: `speak-${materialId}` });
        return;
      }
      advanced = false;
      const segText = segments[idx];
      const u = new SpeechSynthesisUtterance(segText);
      u.lang = 'zh-CN';
      if (zhVoice) u.voice = zhVoice;
      u.rate = 0.95;
      u.pitch = 1;
      u.onend = () => advance(80);
      u.onerror = (e) => {
        // 关键 fix：interrupted / canceled 不再视作"用户停止"。
        // 用户停止走显式 __jyLastTtsCancel → stopped=true 路径；其余一律继续下一段。
        if (stopped) return;
        // 留点时间让引擎复位，避免连环 interrupted
        advance(e?.error === 'interrupted' || e?.error === 'canceled' ? 300 : 200);
      };

      // Watchdog：单段最多给 30s，超过则强制推进，防止 onend/onerror 都不来卡死
      const estimatedMs = Math.max(8000, segText.length * 220);
      watchdog = window.setTimeout(() => {
        if (stopped) return;
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
        advance(200);
      }, Math.min(estimatedMs + 5000, 30000));

      try {
        window.speechSynthesis.speak(u);
      } catch {
        advance(200);
      }
    }

    speakNext();

    (window as unknown as { __jyLastTtsCancel?: () => void }).__jyLastTtsCancel = () => {
      stopped = true;
      clearWatchdog();
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    };
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

    // ---- 分镜：按句拆分场景 ----
    const rawScenes = content
      .replace(/\r/g, '')
      .split(/[\n。！？!?；;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 14);
    const scenes = rawScenes.length > 0 ? rawScenes : [content.slice(0, 80)];
    const rawDurations = scenes.map((s) => Math.max(2400, Math.min(6800, s.length * 220)));
    const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
    const targetTotal = Math.min(58000, Math.max(9000, rawTotal));
    const durScale = targetTotal / rawTotal;
    const sceneDurations = rawDurations.map((d) => Math.round(d * durScale));
    const sceneStarts: number[] = [];
    {
      let acc = 0;
      for (const d of sceneDurations) {
        sceneStarts.push(acc);
        acc += d;
      }
    }
    const durationMs = sceneStarts[sceneStarts.length - 1] + sceneDurations[sceneDurations.length - 1];

    // ---- 双角色 ----
    const animals = ['🦊', '🐱', '🐻', '🐯', '🐼', '🐰', '🐨', '🦁', '🐧', '🐸', '🐵', '🐶'];
    const pickIdx = Math.floor(Math.random() * animals.length);
    const charA = animals[pickIdx];
    let charB = animals[(pickIdx + 3 + Math.floor(Math.random() * 5)) % animals.length];
    if (charB === charA) charB = animals[(pickIdx + 1) % animals.length];

    const propPool = ['📚', '🍎', '🌙', '⭐', '🎈', '🌈', '🎵', '💡', '🌸', '🍀', '🎁', '🚀', '✏️', '🎨', '🌟', '❤️', '☀️', '🌳', '⛵', '🏆'];
    const themes = [
      { bg1: '#a6d9ff', bg2: '#d6efff', ground: '#7cc28b', accent: '#1d6fff', soft: 'rgba(22,119,255,0.18)' },
      { bg1: '#ffd6e7', bg2: '#fff0f6', ground: '#ffb38a', accent: '#eb2f96', soft: 'rgba(255,133,162,0.2)' },
      { bg1: '#ffe2a8', bg2: '#fff7d6', ground: '#9bd07a', accent: '#fa8c16', soft: 'rgba(250,140,22,0.2)' },
      { bg1: '#d3b3ff', bg2: '#f0e1ff', ground: '#9fb6ff', accent: '#722ed1', soft: 'rgba(114,46,209,0.22)' },
      { bg1: '#a8eddc', bg2: '#e8fffb', ground: '#8bd5a8', accent: '#13c2c2', soft: 'rgba(19,194,194,0.2)' },
      { bg1: '#ffd4d4', bg2: '#fff0f0', ground: '#ffb38a', accent: '#ff4d4f', soft: 'rgba(255,77,79,0.2)' },
    ];

    const roundRect = (cx: number, cy: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(cx + r, cy);
      ctx.lineTo(cx + w - r, cy);
      ctx.quadraticCurveTo(cx + w, cy, cx + w, cy + r);
      ctx.lineTo(cx + w, cy + h - r);
      ctx.quadraticCurveTo(cx + w, cy + h, cx + w - r, cy + h);
      ctx.lineTo(cx + r, cy + h);
      ctx.quadraticCurveTo(cx, cy + h, cx, cy + h - r);
      ctx.lineTo(cx, cy + r);
      ctx.quadraticCurveTo(cx, cy, cx + r, cy);
      ctx.closePath();
    };

    const preferredTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';

    message.loading({ content: `🎬 正在演绎成${isPortrait ? '竖屏' : '横屏'}视频…`, key: `video-${videoKey}` });

    let audioContext: AudioContext | null = null;
    try {
      const videoStream = canvas.captureStream(24);
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const masterGain = audioContext.createGain();
      masterGain.gain.value = 0.045;
      masterGain.connect(destination);

      // 轻柔背景旋律（更缓慢，营造氛围感）
      const beatMs = 720;
      const melody = [523.25, 659.25, 784.0, 659.25, 587.33, 523.25, 440.0, 523.25];
      for (let i = 0; i * beatMs < durationMs + 1500; i += 1) {
        const osc = audioContext.createOscillator();
        const g = audioContext.createGain();
        osc.type = i % 4 < 2 ? 'sine' : 'triangle';
        osc.frequency.value = melody[i % melody.length];
        g.gain.value = 0;
        osc.connect(g);
        g.connect(masterGain);
        const startTime = audioContext.currentTime + (i * beatMs) / 1000;
        const endTime = startTime + 0.55;
        g.gain.setValueAtTime(0, startTime);
        g.gain.linearRampToValueAtTime(0.9, startTime + 0.1);
        g.gain.linearRampToValueAtTime(0.01, endTime);
        osc.start(startTime);
        osc.stop(endTime + 0.05);
      }
      // 场景切换"叮"音
      for (let s = 0; s < sceneStarts.length; s += 1) {
        const osc = audioContext.createOscillator();
        const g = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1318.5;
        g.gain.value = 0;
        osc.connect(g);
        g.connect(masterGain);
        const startTime = audioContext.currentTime + sceneStarts[s] / 1000;
        const endTime = startTime + 0.35;
        g.gain.setValueAtTime(0, startTime);
        g.gain.linearRampToValueAtTime(1.6, startTime + 0.04);
        g.gain.linearRampToValueAtTime(0.01, endTime);
        osc.start(startTime);
        osc.stop(endTime + 0.02);
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
      let raf = 0;

      const draw = () => {
        const elapsed = Date.now() - startedAt;

        // 当前场景
        let sceneIdx = scenes.length - 1;
        for (let i = 0; i < scenes.length; i += 1) {
          if (elapsed < sceneStarts[i] + sceneDurations[i]) {
            sceneIdx = i;
            break;
          }
        }
        const sceneElapsed = elapsed - sceneStarts[sceneIdx];
        const sceneDur = sceneDurations[sceneIdx];
        const sceneProgress = Math.max(0, Math.min(1, sceneElapsed / sceneDur));
        const theme = themes[sceneIdx % themes.length];
        const t = elapsed / 1000;

        // 1. 天空背景径向渐变（上半部天空，下半部草地，营造舞台感）
        const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        skyGrad.addColorStop(0, theme.bg1);
        skyGrad.addColorStop(0.7, theme.bg2);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 1.1 远处太阳/月亮（缓慢飘动）
        const sunX = canvas.width - (isPortrait ? 110 : 160) + Math.sin(t * 0.3) * 14;
        const sunY = (isPortrait ? 180 : 160) + Math.cos(t * 0.3) * 8;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.arc(sunX, sunY, isPortrait ? 50 : 64, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(sunX, sunY, isPortrait ? 32 : 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // 1.2 远山（多层）
        const hillBaseY = canvas.height * (isPortrait ? 0.62 : 0.58);
        for (let h = 0; h < 3; h += 1) {
          ctx.fillStyle = h === 0 ? 'rgba(255,255,255,0.28)' : h === 1 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.12)';
          ctx.beginPath();
          ctx.moveTo(0, hillBaseY + h * 18);
          const peaks = 5 + h;
          for (let p = 0; p <= peaks; p += 1) {
            const px = (canvas.width / peaks) * p;
            const py = hillBaseY + h * 18 - (40 + h * 12) * Math.abs(Math.sin(p * 1.3 + h * 0.7));
            ctx.lineTo(px, py);
          }
          ctx.lineTo(canvas.width, canvas.height);
          ctx.lineTo(0, canvas.height);
          ctx.closePath();
          ctx.fill();
        }

        // 1.3 草地舞台
        const groundY = canvas.height * (isPortrait ? 0.72 : 0.7);
        const groundGrad = ctx.createLinearGradient(0, groundY, 0, canvas.height);
        groundGrad.addColorStop(0, theme.ground);
        groundGrad.addColorStop(1, theme.bg2);
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);
        // 草地花朵
        ctx.font = `${isPortrait ? 22 : 26}px sans-serif`;
        for (let f = 0; f < 8; f += 1) {
          const fx = ((f * 173 + sceneIdx * 37) % (canvas.width - 60)) + 30;
          const fy = groundY + 24 + ((f * 53) % (canvas.height - groundY - 60));
          ctx.fillText(f % 3 === 0 ? '🌼' : f % 3 === 1 ? '🌸' : '🍀', fx, fy);
        }

        // 2. 漂浮道具（云朵 + 道具 emoji）
        ctx.font = `${isPortrait ? 28 : 34}px sans-serif`;
        ctx.globalAlpha = 0.85;
        for (let i = 0; i < 10; i += 1) {
          const e = propPool[(i + sceneIdx * 3) % propPool.length];
          const baseX = ((i * 157) % (canvas.width - 80)) + 40;
          const baseY = ((i * 197) % (groundY - 200)) + 130;
          const px = baseX + Math.sin(t * 0.6 + i * 0.9) * 22;
          const py = baseY + Math.cos(t * 0.5 + i * 0.7) * 14;
          ctx.fillText(e, px, py);
        }
        // 云朵
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        for (let c = 0; c < 3; c += 1) {
          const cx = ((t * 18 + c * 360) % (canvas.width + 200)) - 100;
          const cy = 60 + c * 50 + Math.sin(t * 0.4 + c) * 6;
          ctx.beginPath();
          ctx.arc(cx, cy, 28, 0, Math.PI * 2);
          ctx.arc(cx + 26, cy + 4, 22, 0, Math.PI * 2);
          ctx.arc(cx - 24, cy + 6, 20, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 3. 顶部标题
        ctx.fillStyle = theme.accent;
        ctx.font = `bold ${isPortrait ? 30 : 38}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        const titleY = isPortrait ? 70 : 90;
        const shownTitle = `🎬 ${title || '学习时间'}`;
        ctx.fillText(shownTitle, isPortrait ? 40 : 70, titleY);

        // 4. 章节圆点（右上）
        const dotGap = 18;
        const totalDotsW = (scenes.length - 1) * dotGap;
        const dotStartX = canvas.width - 40 - totalDotsW;
        for (let i = 0; i < scenes.length; i += 1) {
          const isActive = i === sceneIdx;
          const isPast = i < sceneIdx;
          ctx.fillStyle = isActive ? theme.accent : isPast ? theme.accent : 'rgba(0,0,0,0.18)';
          ctx.globalAlpha = isActive ? 1 : isPast ? 0.55 : 1;
          ctx.beginPath();
          ctx.arc(dotStartX + i * dotGap, titleY - 10, isActive ? 9 : 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 5. 双角色：左侧 charA、右侧 charB，按场景轮流"说话"
        const charSize = isPortrait ? 180 : 210;
        const groundLine = groundY + (isPortrait ? 36 : 48);
        const charAX = isPortrait ? canvas.width * 0.26 : canvas.width * 0.22;
        const charBX = isPortrait ? canvas.width * 0.74 : canvas.width * 0.78;
        const speakerIsA = sceneIdx % 2 === 0;
        const drawChar = (emoji: string, x: number, isSpeaker: boolean, flip: boolean) => {
          const breathe = Math.sin(t * 2.2 + (isSpeaker ? 0 : Math.PI)) * (isSpeaker ? 8 : 4);
          // 张口：仅说话的角色嘴部张合（垂直缩放）
          const speakMouth = isSpeaker ? 1 + Math.abs(Math.sin(t * 11)) * 0.08 : 1;
          // 轻微左右晃动（说话者更明显）
          const sway = Math.sin(t * 1.8 + (isSpeaker ? 0 : Math.PI / 2)) * (isSpeaker ? 8 : 3);
          // 影子
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.beginPath();
          ctx.ellipse(x, groundLine + charSize * 0.42, charSize * 0.34, charSize * 0.08, 0, 0, Math.PI * 2);
          ctx.fill();

          ctx.save();
          ctx.translate(x + sway, groundLine + breathe);
          if (flip) ctx.scale(-1, 1);
          ctx.scale(1, speakMouth);
          ctx.font = `${charSize}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText(emoji, 0, 0);
          ctx.restore();
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'start';

          // 说话者头顶小音符
          if (isSpeaker) {
            ctx.globalAlpha = 0.7 + Math.sin(t * 4) * 0.3;
            ctx.font = `${isPortrait ? 28 : 34}px sans-serif`;
            ctx.fillText('🎵', x + charSize * 0.35, groundLine + breathe - charSize * 0.55 + Math.sin(t * 3) * 4);
            ctx.globalAlpha = 1;
          }
        };
        drawChar(charA, charAX, speakerIsA, false);
        drawChar(charB, charBX, !speakerIsA, true);

        // 6. 对白气泡（指向当前说话者）
        const speakerX = speakerIsA ? charAX : charBX;
        const bubbleW = isPortrait ? canvas.width - 80 : canvas.width * 0.62;
        const bubbleH = isPortrait ? 240 : 220;
        const bubbleX = (canvas.width - bubbleW) / 2;
        const bubbleY = isPortrait ? canvas.height * 0.18 : canvas.height * 0.2;

        // 气泡阴影
        ctx.shadowColor = theme.soft;
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 8;
        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 28);
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 3;
        roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 28);
        ctx.stroke();

        // 气泡指向说话者的三角
        const tailBaseX = Math.max(bubbleX + 40, Math.min(bubbleX + bubbleW - 40, speakerX));
        const tailDirL = tailBaseX - 22;
        const tailDirR = tailBaseX + 22;
        const tailTipY = bubbleY + bubbleH + 30;
        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        ctx.beginPath();
        ctx.moveTo(tailDirL, bubbleY + bubbleH);
        ctx.lineTo(tailBaseX, tailTipY);
        ctx.lineTo(tailDirR, bubbleY + bubbleH);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = theme.accent;
        ctx.beginPath();
        ctx.moveTo(tailDirL, bubbleY + bubbleH);
        ctx.lineTo(tailBaseX, tailTipY);
        ctx.lineTo(tailDirR, bubbleY + bubbleH);
        ctx.stroke();
        // 用白色盖住气泡下边在三角内的那一段，让连接更平滑
        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        ctx.fillRect(tailDirL + 1, bubbleY + bubbleH - 2, tailDirR - tailDirL - 2, 4);

        // 气泡内文本（逐字显现）
        const sentence = scenes[sceneIdx] || '';
        const maxCharsPerLine = isPortrait ? 13 : 18;
        const wrapped: string[] = [];
        for (let i = 0; i < sentence.length; i += maxCharsPerLine) {
          wrapped.push(sentence.slice(i, i + maxCharsPerLine));
        }
        const reveal = Math.min(1, sceneProgress * 1.6);
        const charsToShow = Math.ceil(sentence.length * reveal);
        const fontSize = isPortrait ? 32 : 38;
        ctx.font = `bold ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillStyle = '#262626';
        let shown = 0;
        let lineY = bubbleY + 60;
        for (const line of wrapped) {
          if (shown >= charsToShow) break;
          const lineCharCount = Math.min(line.length, charsToShow - shown);
          const piece = line.slice(0, lineCharCount);
          ctx.fillText(piece, bubbleX + 30, lineY);
          shown += lineCharCount;
          lineY += fontSize + 14;
          if (lineY > bubbleY + bubbleH - 24) break;
        }

        // 7. 底部章节序号 + 提示
        ctx.fillStyle = theme.accent;
        ctx.font = `bold ${isPortrait ? 24 : 28}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText(`第 ${sceneIdx + 1} / ${scenes.length} 幕`, isPortrait ? 40 : 70, canvas.height - 36);

        ctx.fillStyle = '#8c8c8c';
        ctx.font = `${isPortrait ? 18 : 22}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText('✨ AI 动画演绎 · 边看边学', canvas.width - (isPortrait ? 260 : 320), canvas.height - 36);

        // 8. 场景过渡淡入淡出
        if (sceneProgress < 0.07) {
          ctx.fillStyle = `rgba(255,255,255,${1 - sceneProgress / 0.07})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (sceneProgress > 0.93 && sceneIdx < scenes.length - 1) {
          ctx.fillStyle = `rgba(255,255,255,${(sceneProgress - 0.93) / 0.07})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

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
              <Typography.Text type="secondary">资料总数</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{materials.length}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">今日待学</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{materialStats.todayCount}</Typography.Title>
            </Card>
            <Card size="small" className="metric-card">
              <Typography.Text type="secondary">本周完成</Typography.Text>
              <Typography.Title level={4} style={{ margin: 0 }}>{materialStats.weekDone}</Typography.Title>
            </Card>
          </div>
          {children.length === 0 && materials.length === 0 ? (
            <Alert
              showIcon
              type="info"
              message="还没有学习数据，从这两步开始"
              description="① 添加我的孩子（一张卡片即可） ② 在下方音视频工坊上传文档/粘贴文本，安排到某一天，就会出现在「📅 本周学习计划」对应的日期里。"
            />
          ) : null}
        </Space>
      </Card>

      {/* —— 我的孩子（精简版）—— */}
      <Card title="👶 我的孩子" className="app-section-card section-children">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {children.length === 0 || showChildForm ? (
            <Form
              layout="inline"
              form={childForm}
              onFinish={async (values) => {
                await onCreateChild(values);
                setShowChildForm(false);
              }}
            >
              <Form.Item name="name" rules={[{ required: true, message: '请输入孩子姓名' }]}>
                <Input placeholder="孩子姓名" style={{ width: 160 }} />
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
                  ]}
                />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={childSubmitting}
                  disabled={childSubmitting}
                >
                  {children.length === 0 ? '保存' : '添加'}
                </Button>
                {children.length > 0 && (
                  <Button style={{ marginLeft: 8 }} onClick={() => setShowChildForm(false)}>取消</Button>
                )}
              </Form.Item>
            </Form>
          ) : null}

          {children.length > 0 && (
            <Space wrap size={10}>
              {children.map((item) => (
                <Card
                  key={item.id}
                  size="small"
                  className="list-item-soft"
                  style={{ minWidth: 240 }}
                  bodyStyle={{ padding: 12 }}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space wrap>
                      <Typography.Text strong style={{ fontSize: 16 }}>👶 {item.name}</Typography.Text>
                      {item.gradeLevel && <Tag className="grade-tag">{getGradeLevelLabel(item.gradeLevel)}</Tag>}
                    </Space>
                    <Space size={8} wrap>
                      {(() => {
                        const t = materialStats.perChildToday.get(item.id) || 0;
                        const w = materialStats.perChildWeekDone.get(item.id) || 0;
                        return (
                          <>
                            <Tag color={t > 0 ? 'orange' : 'default'}>今日 {t} 条</Tag>
                            <Tag color={w > 0 ? 'green' : 'default'}>本周完成 {w}</Tag>
                          </>
                        );
                      })()}
                    </Space>
                    <Space size={4} wrap>
                      <Link to={`/child/${item.id}/today`}>今日</Link>
                      <Typography.Text type="secondary">·</Typography.Text>
                      <Link to={`/reports/${item.id}`}>报告</Link>
                      <Typography.Text type="secondary">·</Typography.Text>
                      <Popconfirm
                        title="删除该孩子？"
                        description="对应的任务与进度也会一并删除"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        overlayClassName="danger-popconfirm"
                        onConfirm={() => onDeleteChild(item.id)}
                      >
                        <Button
                          danger
                          type="link"
                          size="small"
                          style={{ padding: 0 }}
                          loading={deletingChildId === item.id}
                        >
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  </Space>
                </Card>
              ))}
              {!showChildForm && children.length < 5 && (
                <Button type="dashed" onClick={() => { childForm.resetFields(); setShowChildForm(true); }}>+ 再加一位</Button>
              )}
            </Space>
          )}
        </Space>
      </Card>

      {/* —— 本周学习计划（日历看板）—— */}
      {(() => {
        const weekStart = dayjs(boardWeekStart);
        const days = Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day'));
        const isThisWeek = boardWeekStart === computeWeekStart(dayjs());
        const childOptions = [{ label: '全部孩子', value: '' }, ...children.map((c) => ({ label: c.name, value: c.id }))];

        const filteredMaterials = materials.filter((m) => {
          if (boardChildFilter && m.childId !== boardChildFilter) return false;
          return true;
        });

        const materialsByDay = new Map<string, MaterialItem[]>();
        const unscheduled: MaterialItem[] = [];
        for (const m of filteredMaterials) {
          const parsed = parseMaterialContent(m.content);
          const d = parsed.scheduledDate;
          if (!d) {
            unscheduled.push(m);
            continue;
          }
          if (!materialsByDay.has(d)) materialsByDay.set(d, []);
          materialsByDay.get(d)!.push(m);
        }

        const weeklyDoneCount = days.reduce((sum, day) => {
          const list = materialsByDay.get(day.format('YYYY-MM-DD')) || [];
          return sum + list.filter((m) => !!parseMaterialContent(m.content).completedAt).length;
        }, 0);
        const weeklyTotalCount = days.reduce((sum, day) => sum + (materialsByDay.get(day.format('YYYY-MM-DD'))?.length || 0), 0);

        return (
          <Card
            title={(
              <Space>
                <span>📅 本周学习计划</span>
                <Tag color="blue">已完成 {weeklyDoneCount} / {weeklyTotalCount}</Tag>
              </Space>
            )}
            className="app-section-card section-tasks"
            extra={(
              <Space wrap>
                <Select
                  size="small"
                  value={boardChildFilter || ''}
                  onChange={(v) => setBoardChildFilter(v || undefined)}
                  options={childOptions}
                  style={{ width: 140 }}
                  getPopupContainer={(trigger) => trigger.parentElement || document.body}
                />
                <Button size="small" onClick={() => setBoardWeekStart(dayjs(boardWeekStart).subtract(7, 'day').format('YYYY-MM-DD'))}>← 上周</Button>
                <Button size="small" type={isThisWeek ? 'primary' : 'default'} onClick={() => setBoardWeekStart(computeWeekStart(dayjs()))}>本周</Button>
                <Button size="small" onClick={() => setBoardWeekStart(dayjs(boardWeekStart).add(7, 'day').format('YYYY-MM-DD'))}>下周 →</Button>
              </Space>
            )}
          >
            <div className="calendar-board">
              {days.map((day) => {
                const key = day.format('YYYY-MM-DD');
                const list = materialsByDay.get(key) || [];
                const isToday = key === todayStr;
                const weekdayLabel = ['一', '二', '三', '四', '五', '六', '日'][day.day() === 0 ? 6 : day.day() - 1];
                return (
                  <div key={key} className={`calendar-cell${isToday ? ' is-today' : ''}`}>
                    <div className="calendar-cell-head">
                      <span className="calendar-cell-weekday">周{weekdayLabel}</span>
                      <span className="calendar-cell-date">{day.format('MM-DD')}</span>
                      {isToday && <Tag color="processing" style={{ marginLeft: 4 }}>今日</Tag>}
                    </div>
                    <div className="calendar-cell-body">
                      {list.length === 0 ? (
                        <div className="calendar-cell-empty">—</div>
                      ) : (
                        list.map((m) => {
                          const parsed = parseMaterialContent(m.content);
                          const done = !!parsed.completedAt;
                          const childName = children.find((c) => c.id === m.childId)?.name || '';
                          const kindIcon = parsed.audioUrl ? '🎧' : parsed.videoUrl ? '🎬' : parsed.sourceType === 'image' ? '🖼️' : parsed.sourceType === 'audio' ? '🎵' : parsed.sourceType === 'video' ? '📹' : '📄';
                          return (
                            <div key={m.id} className={`calendar-item${done ? ' is-done' : ''}`}>
                              <Checkbox
                                checked={done}
                                disabled={completeBusyId === m.id}
                                onChange={(e) => onUpdateMaterial(m.id, { completed: e.target.checked }, 'complete')}
                              />
                              <span className="calendar-item-icon">{kindIcon}</span>
                              <span className="calendar-item-title" title={parsed.fileName}>{parsed.fileName}</span>
                              {childName && <Tag color="green" style={{ marginLeft: 2 }}>{childName}</Tag>}
                              <Button
                                type="text"
                                size="small"
                                style={{ marginLeft: 'auto', padding: '0 4px' }}
                                onClick={() => onUpdateMaterial(m.id, { scheduledDate: null })}
                                loading={scheduleBusyId === m.id}
                                title="移出日历"
                              >✕</Button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {unscheduled.length > 0 && (
              <div className="unscheduled-bar">
                <Typography.Text type="secondary" style={{ marginRight: 8 }}>📦 未安排日期（{unscheduled.length}）：</Typography.Text>
                <Space wrap size={6}>
                  {unscheduled.slice(0, 8).map((m) => {
                    const parsed = parseMaterialContent(m.content);
                    return (
                      <Tag
                        key={m.id}
                        color="orange"
                        style={{ cursor: 'pointer' }}
                        onClick={() => onUpdateMaterial(m.id, { scheduledDate: todayStr })}
                        title="点击：安排到今天"
                      >
                        {parsed.fileName} → 安排到今天
                      </Tag>
                    );
                  })}
                  {unscheduled.length > 8 && <Typography.Text type="secondary">…+{unscheduled.length - 8}</Typography.Text>}
                </Space>
              </div>
            )}
          </Card>
        );
      })()}

      <Card
        title={
          <Space>
            <span className="hero-emoji" role="img" aria-label="studio">🎬</span>
            <span>音视频创作工坊</span>
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
            <div className="hero-banner-title">🎙️ 上传文件 或 📝 粘贴文本，都能秒变会演的音视频</div>
            <div className="hero-banner-sub">两种方式生成的作品都会自动进入下方"作品库"，统一管理</div>
          </div>

          <Tabs
            activeKey={createMode}
            onChange={(k) => setCreateMode(k as 'upload' | 'paste')}
            className="creator-tabs"
            items={[
              {
                key: 'upload',
                label: '📤 上传文件',
                children: (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
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
                      {children.length > 1 ? (
                        <Select
                          allowClear
                          placeholder="绑定孩子"
                          style={{ width: 160 }}
                          getPopupContainer={(trigger) => trigger.parentElement || document.body}
                          value={uploadChildId}
                          onChange={(v) => setUploadChildId(v)}
                          options={children.map((c) => ({ label: c.name, value: c.id }))}
                        />
                      ) : children.length === 1 ? (
                        <Tag color="blue" style={{ padding: '4px 8px' }}>👶 {children[0].name}</Tag>
                      ) : null}
                      <Input
                        type="date"
                        value={uploadScheduledDate}
                        onChange={(e) => setUploadScheduledDate(e.target.value)}
                        style={{ width: 160 }}
                        prefix={<span>📅</span>}
                      />
                      <Button onClick={() => onUploadMaterial(false)} loading={uploading} disabled={uploading || !uploadFile}>仅上传</Button>
                      <Button type="primary" size="large" className="hero-cta" onClick={() => onUploadMaterial(true)} loading={uploading} disabled={uploading || !uploadFile}>
                        ✨ 一键生成音视频
                      </Button>
                    </Space>
                  </Space>
                ),
              },
              {
                key: 'paste',
                label: '📝 粘贴文本',
                children: (
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Input
                      value={directMediaTitle}
                      onChange={(e) => setDirectMediaTitle(e.target.value)}
                      placeholder="给作品起个名字（用于作品库识别）"
                      maxLength={40}
                    />
                    <Input.TextArea
                      value={directMediaText}
                      onChange={(e) => setDirectMediaText(e.target.value)}
                      placeholder="把要朗读 / 演绎的故事 / 课文 / 知识点粘贴到这里…"
                      autoSize={{ minRows: 4, maxRows: 10 }}
                      maxLength={2400}
                      showCount
                    />
                    <Space wrap align="center" size={10}>
                      {children.length > 1 ? (
                        <Select
                          allowClear
                          placeholder="绑定孩子"
                          style={{ width: 160 }}
                          getPopupContainer={(trigger) => trigger.parentElement || document.body}
                          value={uploadChildId}
                          onChange={(v) => setUploadChildId(v)}
                          options={children.map((c) => ({ label: c.name, value: c.id }))}
                        />
                      ) : children.length === 1 ? (
                        <Tag color="blue" style={{ padding: '4px 8px' }}>👶 {children[0].name}</Tag>
                      ) : null}
                      <Input
                        type="date"
                        value={uploadScheduledDate}
                        onChange={(e) => setUploadScheduledDate(e.target.value)}
                        style={{ width: 160 }}
                        prefix={<span>📅</span>}
                      />
                      <Button
                        type="primary"
                        size="large"
                        className="hero-cta"
                        loading={uploading}
                        disabled={uploading || !directMediaText.trim()}
                        onClick={() => {
                          const text = directMediaText.trim();
                          if (!text) return;
                          const titleRaw = directMediaTitle.trim() || '粘贴文本';
                          const safeTitle = titleRaw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'paste';
                          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                          const file = new File([blob], `${safeTitle}.txt`, { type: 'text/plain' });
                          void onUploadMaterial(true, file).then(() => {
                            setDirectMediaText('');
                            setDirectMediaTitle('家庭学习音视频');
                          });
                        }}
                      >
                        ✨ 一键生成音视频
                      </Button>
                    </Space>
                  </Space>
                ),
              },
            ]}
          />

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

          <div className="library-divider">
            <span className="library-divider-line" />
            <span className="library-divider-label">🎁 作品库</span>
            <span className="library-divider-line" />
          </div>

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
                        {parsed.scheduledDate && <Tag color="geekblue">📅 {dayjs(parsed.scheduledDate).format('MM-DD')}</Tag>}
                        {parsed.completedAt && <Tag color="success">✅ 已完成</Tag>}
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

                    <Space wrap size={8} className="material-org-row">
                      <span style={{ fontSize: 12, color: '#8c8c8c' }}>📅 安排到</span>
                      <Input
                        type="date"
                        size="small"
                        style={{ width: 150 }}
                        value={parsed.scheduledDate || ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          void onUpdateMaterial(item.id, { scheduledDate: v || null });
                        }}
                      />
                      <span style={{ fontSize: 12, color: '#8c8c8c', marginLeft: 4 }}>👶 孩子</span>
                      <Select
                        size="small"
                        allowClear
                        placeholder="未绑定"
                        style={{ width: 140 }}
                        getPopupContainer={(trigger) => trigger.parentElement || document.body}
                        value={item.childId || undefined}
                        onChange={(v) => onUpdateMaterial(item.id, { childId: v || null })}
                        options={children.map((c) => ({ label: c.name, value: c.id }))}
                      />
                      <Checkbox
                        checked={!!parsed.completedAt}
                        disabled={completeBusyId === item.id}
                        onChange={(e) => onUpdateMaterial(item.id, { completed: e.target.checked }, 'complete')}
                      >
                        已完成
                      </Checkbox>
                    </Space>

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
                        <Button
                          className="media-close-btn"
                          shape="circle"
                          size="small"
                          onClick={() => setExpandedAudioMaterialId(null)}
                          aria-label="收起音频"
                        >
                          ✕
                        </Button>
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
                        <Button
                          className="media-close-btn"
                          shape="circle"
                          size="small"
                          onClick={() => setExpandedVideoMaterialId(null)}
                          aria-label="收起视频"
                        >
                          ✕
                        </Button>
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
