import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Checkbox, Form, Input, List, Progress, Select, Slider, Space, Tabs, Tag, Typography, Popconfirm, message } from 'antd';
import type { FormInstance } from 'antd';
import dayjs from 'dayjs';
import { APP_API_BASE, appFetch, appUpload, clearAppToken, getAppToken, setAppToken } from '../api.app';
import { recognizeImageText, isLikelyImage, sanitizeOcrText } from '../lib/ocr';

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

class MediaGenerateNeedsFallbackError extends Error {
  reason: 'timeout' | 'cancel';
  constructor(reason: 'timeout' | 'cancel') {
    super(reason === 'cancel' ? '已跳过等待，将切换到本地生成' : '专业生成超时，将切换到本地生成');
    this.reason = reason;
  }
}

function resolveAssetUrl(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${APP_API_BASE.replace('/api/app', '')}${value.startsWith('/') ? '' : '/'}${value}`;
}

const MOJIBAKE_HINT = /[ÃÂÐÑØæçðñþäåèéêëìíîïòóôõöùúûüÿ¥»¢£¤¦§¨©ª«¬®¯°±²³´µ¶·¸¹º¼½¾¿]/;

function rescueMojibake(input: string): string {
  if (!input) return input;
  if (typeof TextDecoder === 'undefined') return input;
  if (!MOJIBAKE_HINT.test(input)) return input;

  const bytes = new Uint8Array(Array.from(input).map((char) => char.charCodeAt(0) & 0xff));
  const utf8Decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!utf8Decoded) return input;

  return MOJIBAKE_HINT.test(utf8Decoded) ? input : utf8Decoded;
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

  return rescueMojibake(decodedUri);
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
    recognitionText: recognition ? rescueMojibake(String(recognition.extractedText || '')) : '',
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
  switch (reason) {
    case 'text_extraction_unsupported':
      return '这种文件格式我们暂时还读不出文字，可以试试用拍照/截图上传，或粘贴文字';
    default:
      return '';
  }
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
  const [authMode, setAuthMode] = useState<'sms' | 'login' | 'register'>('sms');
  const [loginAssistMode, setLoginAssistMode] = useState<'none' | 'forgot' | 'reset'>('none');
  const [smsPhone, setSmsPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsCooldown, setSmsCooldown] = useState(0);
  const [smsCooldownEndMs, setSmsCooldownEndMs] = useState<number | null>(null);
  const [smsSending, setSmsSending] = useState(false);
  const [smsLoggingIn, setSmsLoggingIn] = useState(false);
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
  const [mediaStage, setMediaStage] = useState<{ materialId: string; kind: 'audio' | 'video'; phase: 'recognize' | 'generate' | 'render'; startedAt: number } | null>(null);
  const [, setMediaStageTick] = useState(0);
  useEffect(() => {
    if (!mediaStage) return;
    const t = window.setInterval(() => setMediaStageTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [mediaStage]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadChildId, setUploadChildId] = useState<string | undefined>(undefined);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>('');
  const uploadAbortRef = useRef<(() => void) | null>(null);
  const [directMediaTitle, setDirectMediaTitle] = useState('家庭学习音视频');
  const [directMediaText, setDirectMediaText] = useState('');
  const [deletingMaterialId, setDeletingMaterialId] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStage, setOcrStage] = useState<string>('');
  const [ocrPercent, setOcrPercent] = useState(0);
  const [ocrPreview, setOcrPreview] = useState<{ file: File; text: string; thumbUrl: string; title: string } | null>(null);
  const [ocrTextRevealed, setOcrTextRevealed] = useState(false);

  // —— 朗读文本（Web Speech TTS）播放器状态 ——
  type TtsState = {
    materialId: string;
    segmentIdx: number;
    totalSegments: number;
    totalChars: number;
    charsBefore: number[];
    isPaused: boolean;
  };
  type TtsCtrl = {
    pause: () => void;
    resume: () => void;
    stop: () => void;
    seekToSegment: (idx: number) => void;
    setRate: (rate: number) => void;
  };
  const [ttsState, setTtsState] = useState<TtsState | null>(null);
  const [ttsRate, setTtsRate] = useState<number>(0.75);
  const ttsRateRef = useRef<number>(0.75);
  const ttsCtrlRef = useRef<TtsCtrl | null>(null);
  const mediaFallbackRequestedRef = useRef<{ materialId: string; kind: 'audio' | 'video' } | null>(null);

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

  // —— 倒计时（基于结束时间戳，防止页面/标签切换造成漂移）——
  useEffect(() => {
    if (!smsCooldownEndMs) return;
    const tick = () => {
      const remain = Math.max(0, Math.ceil((smsCooldownEndMs - Date.now()) / 1000));
      setSmsCooldown(remain);
      if (remain <= 0) setSmsCooldownEndMs(null);
    };
    tick();
    const t = window.setInterval(tick, 500);
    return () => window.clearInterval(t);
  }, [smsCooldownEndMs]);

  const onRequestSmsCode = async () => {
    const phone = smsPhone.trim();
    if (!/^1\d{10}$/.test(phone)) {
      message.warning('请输入 11 位手机号');
      return;
    }
    setSmsSending(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/sms/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '获取验证码失败', res.status));
        return;
      }
      const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const cd = typeof obj.cooldownSeconds === 'number' ? obj.cooldownSeconds : 60;
      setSmsCooldownEndMs(Date.now() + cd * 1000);
      setSmsCooldown(cd);
      if (obj.demoMode && typeof obj.demoCode === 'string') {
        setSmsCode(obj.demoCode);
        message.success(`📩 演示验证码：${obj.demoCode}（已自动填入）`);
      } else {
        message.success('验证码已发送，请查收短信');
      }
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setSmsSending(false);
    }
  };

  const onSmsLogin = async () => {
    const phone = smsPhone.trim();
    const code = smsCode.trim();
    if (!/^1\d{10}$/.test(phone)) {
      message.warning('请输入 11 位手机号');
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      message.warning('请输入 6 位验证码');
      return;
    }
    setSmsLoggingIn(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/sms/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '登录失败', res.status));
        return;
      }
      const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const tokenValue = typeof obj.token === 'string' ? obj.token : '';
      if (!tokenValue) {
        message.error('登录失败');
        return;
      }
      setAppToken(tokenValue);
      setToken(tokenValue);
      setSmsPhone('');
      setSmsCode('');
      message.success(obj.isNew ? '欢迎加入！已为您自动创建账号' : '登录成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setSmsLoggingIn(false);
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
    intervalMs = 1200,
    shouldCancel?: () => boolean
  ): Promise<MaterialItem> => {
    for (let i = 0; i < maxAttempts; i += 1) {
      if (shouldCancel?.()) {
        if (type === 'generate') throw new MediaGenerateNeedsFallbackError('cancel');
        throw new Error('已取消');
      }

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

    if (type === 'generate') throw new MediaGenerateNeedsFallbackError('timeout');
    throw new Error('识别处理中，请稍后刷新查看结果');
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
    let stageTimer: number | null = null;
    const stopPhaseTimer = () => {
      if (stageTimer !== null) { window.clearInterval(stageTimer); stageTimer = null; }
    };
    const startPhaseTimer = (basePercent: number, capPercent: number, prefix: string) => {
      stopPhaseTimer();
      const startedAt = Date.now();
      setUploadPercent(basePercent);
      setUploadStage(`${prefix}（已用 0s）`);
      stageTimer = window.setInterval(() => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        const span = capPercent - basePercent;
        const grow = Math.min(span, Math.round(span * (1 - Math.exp(-sec / 25))));
        setUploadPercent(basePercent + grow);
        setUploadStage(`${prefix}（已用 ${sec}s）`);
      }, 1000);
    };
    try {
      const formData = new FormData();
      formData.append('file', fileToUpload);
      // 单孩家庭：未选时默认绑定唯一孩子
      const effectiveChildId = uploadChildId || (children.length === 1 ? children[0].id : undefined);
      if (effectiveChildId) formData.append('childId', effectiveChildId);
      if (uploadScheduledDate && /^\d{4}-\d{2}-\d{2}$/.test(uploadScheduledDate)) {
        formData.append('scheduledDate', uploadScheduledDate);
      }

      const uploadHandle = appUpload(
        `${APP_API_BASE}/library/materials`,
        formData,
        (percent) => {
          setUploadPercent(percent);
          if (percent < 30) setUploadStage('📤 正在传输到云端…');
          else if (percent < 70) setUploadStage('🚀 文件飞奔中…');
          else setUploadStage('🧠 即将进入 AI 大脑…');
        }
      );
      uploadAbortRef.current = uploadHandle.abort;
      const uploadRes = await uploadHandle.promise;

      if (!uploadRes.ok) {
        setUploadStage('');
        setUploadPercent(0);
        message.error(getApiErrorMessage(uploadRes.data, '上传失败', uploadRes.status));
        return;
      }

      const uploaded = uploadRes.data && typeof uploadRes.data === 'object' ? (uploadRes.data as Record<string, unknown>) : null;
      const uploadedMaterialId = uploaded && typeof uploaded.id === 'string' ? uploaded.id : null;
      // 自动后续流程时，上传完成只占进度条 35%；纯上传场景一次性给 100%
      setUploadPercent(autoGenerateTask && uploadedMaterialId ? 35 : 100);

      if (autoGenerateTask && uploadedMaterialId) {
        startPhaseTimer(40, 60, '🔍 AI 正在阅读资料内容…');
        const recognizeRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/recognize`, {
          method: 'POST',
        });
        const recognizeData = await parseApiResponse(recognizeRes);
        if (!recognizeRes.ok) {
          stopPhaseTimer();
          message.error(getApiErrorMessage(recognizeData, '上传成功，但自动识别失败', recognizeRes.status));
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'recognize');
        stopPhaseTimer();

        startPhaseTimer(65, 95, '🎬 AI 正在生成音视频…');
        const generateRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/generate-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const generateData = await parseApiResponse(generateRes);
        if (!generateRes.ok) {
          stopPhaseTimer();
          message.error(getApiErrorMessage(generateData, '上传成功，但自动生成任务失败', generateRes.status));
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'generate');
        stopPhaseTimer();
        setUploadPercent(100);
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
      document.querySelectorAll<HTMLInputElement>('input[type="file"][data-role="material-upload"]').forEach((fi) => { fi.value = ''; });
      await reloadAll();
    } catch (e) {
      if (e instanceof Error && e.message === 'aborted') {
        message.info('已取消上传');
      } else {
        message.error(e instanceof Error ? e.message : '上传失败，请稍后重试');
        await reloadAll();
      }
    } finally {
      stopPhaseTimer();
      uploadAbortRef.current = null;
      setUploading(false);
      window.setTimeout(() => {
        setUploadPercent(0);
        setUploadStage('');
      }, 1500);
    }
  };

  // 拍照/相册选完图片后：客户端 OCR → 在当前 tab 内展示识别卡片（不切 tab）
  const onPickImageForOcr = async (file: File) => {
    if (!isLikelyImage(file)) {
      setUploadFile(file); // 非图片走原上传流程
      return;
    }
    // 撤销旧的预览 URL
    if (ocrPreview?.thumbUrl) {
      try { URL.revokeObjectURL(ocrPreview.thumbUrl); } catch { /* ignore */ }
    }
    setOcrPreview(null);
    setOcrTextRevealed(false);
    setOcrBusy(true);
    setOcrPercent(2);
    setOcrStage('📦 正在准备识别模型…');
    try {
      const text = await recognizeImageText(file, (p) => {
        setOcrPercent(p.percent);
        if (p.stage === 'loading_model') setOcrStage('📦 正在加载识别模型（首次较慢）…');
        else if (p.stage === 'recognizing') setOcrStage('🔍 AI 正在识别图片文字…');
        else setOcrStage('✅ 识别完成');
      });
      const cleaned = sanitizeOcrText(text || '');
      const baseTitle = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '拍照学习';
      const thumbUrl = URL.createObjectURL(file);
      setOcrPreview({ file, text: cleaned, thumbUrl, title: baseTitle });
      if (!cleaned) {
        message.warning('图片里没有识别到清晰文字（可能是插画/手写），请在下方文本框手动输入要朗读的内容');
      } else {
        message.success(`✅ 识别到 ${cleaned.length} 个字，请检查并编辑后再生成音视频`);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '识别失败，请稍后重试');
    } finally {
      setOcrBusy(false);
      window.setTimeout(() => {
        setOcrPercent(0);
        setOcrStage('');
      }, 1500);
    }
  };

  const onClearOcrPreview = () => {
    if (ocrPreview?.thumbUrl) {
      try { URL.revokeObjectURL(ocrPreview.thumbUrl); } catch { /* ignore */ }
    }
    setOcrPreview(null);
    setOcrTextRevealed(false);
    document.querySelectorAll<HTMLInputElement>('input[type="file"][data-role="material-upload"]').forEach((fi) => { fi.value = ''; });
  };

  // 把当前 OCR 文本保存到作品库（轻量保存，不触发后端 AI 识别/生成）
  const onSaveOcrToLibrary = async () => {
    if (!ocrPreview) return;
    const txt = ocrPreview.text.trim();
    if (!txt) {
      message.warning('请先输入或识别文字内容');
      return;
    }
    const safeTitle = (ocrPreview.title || '拍照学习').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'photo';
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const txtFile = new File([blob], `${safeTitle}.txt`, { type: 'text/plain' });
    // 用 autoGenerateTask=false：只保存文本，不再展示"正在生成音视频"。
    // 用户在作品库列表里可单独点"朗读 / 生成视频"。
    await onUploadMaterial(false, txtFile);
    onClearOcrPreview();
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
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setTtsState(null);
    try {
      const res = await appFetch(`${APP_API_BASE}/library/materials/${materialId}`, {
        method: 'DELETE',
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '删除资料失败', res.status));
        return;
      }
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
    setMediaStage({ materialId, kind, phase: 'recognize', startedAt: Date.now() });
    mediaFallbackRequestedRef.current = null;
    const isCancelled = () => {
      const req = mediaFallbackRequestedRef.current;
      return !!req && req.materialId === materialId && req.kind === kind;
    };
    try {
      await triggerMaterialRecognize(materialId);
      await pollMaterialUntilDone(materialId, 'recognize');

      setMediaStage({ materialId, kind, phase: 'generate', startedAt: Date.now() });
      await triggerMaterialTaskGeneration(materialId, {
        mediaKind: kind,
        titlePrefix: kind === 'audio' ? '音频生成' : '视频生成',
      });

      let fallbackReason: 'timeout' | 'cancel' | null = null;
      try {
        await pollMaterialUntilDone(materialId, 'generate', 21, 1200, isCancelled);
      } catch (err) {
        if (err instanceof MediaGenerateNeedsFallbackError) {
          fallbackReason = err.reason;
        } else {
          throw err;
        }
      }

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
          if (fallbackReason === 'timeout') {
            message.info('专业生成超时，已切换为本地朗读');
          } else if (fallbackReason === 'cancel') {
            message.info('已跳过等待，切换为本地朗读');
          }
          await onPlayMaterialAudio(materialId, parsed.recognitionText);
          return;
        }
        if (fallbackReason) {
          message.error('专业生成超时，且未获得可朗读文本');
        } else {
          message.warning('暂未获得音频地址，请稍后重试');
        }
        return;
      }

      if (parsed.videoUrl) {
        setExpandedVideoMaterialId(materialId);
        message.success('视频已生成，可直接在线播放');
        return;
      }
      if (parsed.recognitionText) {
        if (fallbackReason === 'timeout') {
          message.info('专业生成超时，已切换为本地生成');
        } else if (fallbackReason === 'cancel') {
          message.info('已跳过等待，切换为本地生成');
        }
        setMediaStage({ materialId, kind, phase: 'render', startedAt: Date.now() });
        const localVideoUrl = await onGenerateMaterialVideo(materialId, parsed.fileName, parsed.recognitionText, 'landscape');
        if (localVideoUrl) {
          setExpandedVideoMaterialId(materialId);
          return;
        }
      }
      if (fallbackReason) {
        message.error('专业生成超时，且未获得可用文本，无法本地生成');
      } else {
        message.warning('暂未获得视频地址，请稍后重试');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : kind === 'audio' ? '音频生成失败，请稍后重试' : '视频生成失败，请稍后重试');
      await reloadAll();
    } finally {
      mediaFallbackRequestedRef.current = null;
      setMaterialBusyId(null);
      setMaterialAction(null);
      setMediaStage(null);
    }
  };

  const onPlayMaterialAudio = async (materialId: string, text: string) => {
    // 朗读前再次清洗，过滤旧素材里的 OCR 乱码，避免出现"读出一堆乱码"的尴尬
    const sanitized = sanitizeOcrText(text);
    const content = (sanitized || text).trim();
    if (!content) {
      message.warning('请先完成识别，拿到文本后再生成音频');
      return;
    }

    // 先停掉上一轮朗读
    const prevCancel = (window as unknown as { __jyLastTtsCancel?: () => void }).__jyLastTtsCancel;
    if (typeof prevCancel === 'function') {
      try { prevCancel(); } catch { /* ignore */ }
    }
    ttsCtrlRef.current = null;
    setTtsState(null);

    // 分段：仅用于进度条 / 跳转滑块，真正的音频是一段完整 mp3
    const SEGMENT_MAX = 60;
    const segments = content
      .replace(/\r/g, '')
      .split(/(?<=[。！？!?；;\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .flatMap((s) => {
        if (s.length <= SEGMENT_MAX) return [s];
        const parts: string[] = [];
        const subs = s.split(/(?<=[，、,])/);
        let buf = '';
        for (const sub of subs) {
          if ((buf + sub).length > SEGMENT_MAX) {
            if (buf) parts.push(buf);
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
    const charsBefore: number[] = [];
    {
      let acc = 0;
      for (const s of segments) {
        charsBefore.push(acc);
        acc += s.length;
      }
    }
    const totalChars = content.length;

    const key = `speak-${materialId}`;
    message.loading({ content: `🔊 正在合成语音，全文约 ${totalChars} 字…`, key, duration: 0 });

    let stopped = false;
    let audio: HTMLAudioElement | null = null;
    let audioUrl = '';

    const cleanup = (silent: boolean) => {
      stopped = true;
      if (audio) {
        try { audio.pause(); } catch { /* ignore */ }
        audio.onended = null;
        audio.onerror = null;
        audio.ontimeupdate = null;
        audio.onpause = null;
        audio.onplay = null;
        audio.onloadedmetadata = null;
        try { audio.src = ''; audio.load(); } catch { /* ignore */ }
        audio = null;
      }
      if (audioUrl) {
        try { URL.revokeObjectURL(audioUrl); } catch { /* ignore */ }
        audioUrl = '';
      }
      if (!silent) message.destroy(key);
      setTtsState(null);
      ttsCtrlRef.current = null;
    };

    try {
      const resp = await appFetch(`${APP_API_BASE}/tts/long`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content, rate: '-4%' }),
      });
      if (stopped) return;
      if (!resp.ok) {
        let errCode = '';
        try { const j = await resp.json(); errCode = String(j?.error || ''); } catch { /* ignore */ }
        message.destroy(key);
        const isUpstream403 = /403/.test(errCode) || /Unexpected server response/i.test(errCode);
        if (errCode === 'tts_rate_limited') {
          message.error({ content: '朗读请求过于频繁，请稍后再试', duration: 6 });
        } else if (errCode === 'tts_text_too_long') {
          message.error({ content: '文本过长，无法朗读（最多 8000 字）', duration: 6 });
        } else if (isUpstream403 || resp.status === 502 || resp.status === 403) {
          message.error({
            content: `朗读失败：语音服务暂时不可用（HTTP ${resp.status}${errCode ? ' / ' + errCode : ''}）。请稍后重试。`,
            duration: 8,
          });
        } else {
          message.error({
            content: `朗读失败：${errCode || `HTTP ${resp.status}`}`,
            duration: 6,
          });
        }
        cleanup(true);
        return;
      }
      const blob = await resp.blob();
      if (stopped) return;
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      audio.preload = 'auto';
      audio.playbackRate = ttsRateRef.current;

      const computeSegmentIdx = (cur: number, dur: number): number => {
        if (!dur || Number.isNaN(dur) || dur <= 0) return 0;
        const ratio = Math.min(1, Math.max(0, cur / dur));
        const charsPlayed = Math.floor(ratio * totalChars);
        for (let i = segments.length - 1; i >= 0; i--) {
          if (charsPlayed >= charsBefore[i]) return i;
        }
        return 0;
      };

      const publishState = () => {
        if (stopped || !audio) return;
        const dur = audio.duration;
        const cur = audio.currentTime;
        setTtsState({
          materialId,
          segmentIdx: computeSegmentIdx(cur, dur),
          totalSegments: segments.length,
          totalChars,
          charsBefore,
          isPaused: audio.paused,
        });
      };

      audio.onloadedmetadata = publishState;
      audio.ontimeupdate = publishState;
      audio.onplay = publishState;
      audio.onpause = publishState;
      audio.onended = () => {
        message.success({ content: '✅ 朗读完成', key });
        cleanup(true);
      };
      audio.onerror = () => {
        message.error({ content: '朗读播放失败', key });
        cleanup(true);
      };

      const ctrl: TtsCtrl = {
        pause: () => { try { audio?.pause(); } catch { /* ignore */ } },
        resume: () => { try { audio?.play().catch(() => {}); } catch { /* ignore */ } },
        stop: () => { cleanup(false); },
        seekToSegment: (target: number) => {
          if (!audio) return;
          const idx = Math.max(0, Math.min(segments.length - 1, Math.floor(target)));
          const dur = audio.duration;
          if (!dur || Number.isNaN(dur) || dur <= 0) return;
          const charRatio = charsBefore[idx] / Math.max(1, totalChars);
          try { audio.currentTime = Math.min(dur - 0.05, Math.max(0, charRatio * dur)); } catch { /* ignore */ }
          if (audio.paused) { try { audio.play().catch(() => {}); } catch { /* ignore */ } }
        },
        setRate: (rate: number) => {
          const clamped = Math.max(0.5, Math.min(2.0, rate));
          ttsRateRef.current = clamped;
          if (audio) audio.playbackRate = clamped;
        },
      };
      ttsCtrlRef.current = ctrl;

      message.destroy(key);
      setTtsState({
        materialId,
        segmentIdx: 0,
        totalSegments: segments.length,
        totalChars,
        charsBefore,
        isPaused: false,
      });
      try {
        await audio.play();
      } catch (err) {
        message.error('朗读启动失败：' + (err instanceof Error ? err.message : String(err)));
        cleanup(true);
        return;
      }

      (window as unknown as { __jyLastTtsCancel?: () => void }).__jyLastTtsCancel = () => {
        cleanup(true);
      };
    } catch (err) {
      message.destroy(key);
      message.error('朗读失败：' + (err instanceof Error ? err.message : String(err)));
      cleanup(true);
    }
  };

  const onGenerateMaterialVideo = async (
    materialId: string,
    title: string,
    text: string,
    orientation: 'landscape' | 'portrait'
  ): Promise<string | null> => {
    // 防御性二次清洗：旧素材里如果残留 OCR 乱码，也不会被绘到画面/字幕上
    const sanitized = sanitizeOcrText(text);
    const content = (sanitized || text).trim();
    if (!content) {
      message.warning('请先完成识别，拿到文本后再生成视频');
      return null;
    }
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      message.error('当前浏览器不支持视频生成');
      return null;
    }

    // iOS 摇一摇会触发"撤销操作"系统弹窗，一旦点了撤销当前正在录制的视频流就会被打断。
    // 关闭键盘 + 让所有可撤销的文本输入失去焦点，可以最大程度减少弹窗的概率。
    try {
      const active = document.activeElement as (HTMLElement & { blur?: () => void }) | null;
      active?.blur?.();
    } catch { /* ignore */ }

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
    // 1) 先按换行 / 中文句末标点 / 中文逗号 / 顿号 / 2+ 空白 分句
    let pieces = content
      .replace(/\r/g, '')
      .split(/[\n。！？!?；;，,、]+|\s{2,}/);
    // 2) 数学/口诀类（含 2 个以上 "X=Y" 表达式）按空白二次切分，让每条算式一幕
    pieces = pieces.flatMap((p) => {
      const s = p.trim();
      if (!s) return [];
      const eqMatches = s.match(/\S+[=＝]\S+/g);
      if (eqMatches && eqMatches.length >= 2) {
        return s.split(/\s+/).filter((x) => x.length > 0);
      }
      return [s];
    });
    // 3) 单幕仍过长（> 28 字符）的，按长度切成 22 字符的小段
    pieces = pieces.flatMap((p) => {
      if (p.length <= 28) return [p];
      const chunks: string[] = [];
      for (let i = 0; i < p.length; i += 22) chunks.push(p.slice(i, i + 22));
      return chunks;
    });
    const rawScenes = pieces
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 14);
    // 4) 全部空兜底：直接按长度切
    const scenes = rawScenes.length > 0
      ? rawScenes
      : (() => {
          const t = content.replace(/\s+/g, ' ').trim();
          if (!t) return ['小朋友，一起来学习吧'];
          const out: string[] = [];
          for (let i = 0; i < Math.min(t.length, 14 * 22); i += 22) out.push(t.slice(i, i + 22));
          return out;
        })();
    const rawDurations = scenes.map((s) => Math.max(2400, Math.min(6800, s.length * 220)));
    const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
    const targetTotal = Math.min(58000, Math.max(9000, rawTotal));
    const durScale = targetTotal / rawTotal;
    let sceneDurations = rawDurations.map((d) => Math.round(d * durScale));
    let sceneStarts: number[] = [];
    {
      let acc = 0;
      for (const d of sceneDurations) {
        sceneStarts.push(acc);
        acc += d;
      }
    }
    let durationMs = sceneStarts[sceneStarts.length - 1] + sceneDurations[sceneDurations.length - 1];

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

    const preferredTypes = [
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';

    message.loading({ content: `🎬 正在生成${isPortrait ? '竖屏' : '横屏'}视频，请保持手机平稳、不要摇晃…`, key: `video-${videoKey}` });

    // 先把朗读 mp3 拿到手；TTS 失败也允许继续，但只有 BGM，没有旁白
    let narrationArrayBuf: ArrayBuffer | null = null;
    try {
      const ttsRes = await appFetch(`${APP_API_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content.slice(0, 2400) }),
      });
      if (ttsRes.ok) {
        narrationArrayBuf = await ttsRes.arrayBuffer();
      } else {
        let detail = '';
        try {
          const j = await ttsRes.json();
          detail = j?.error ? `（${j.error}）` : '';
        } catch { /* ignore */ }
        message.warning(`旁白合成失败${detail}，视频将仅含背景音乐`);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      message.warning(`旁白合成失败${m ? `（${m}）` : ''}，视频将仅含背景音乐`);
    }

    let audioContext: AudioContext | null = null;
    try {
      const videoStream = canvas.captureStream(24);
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const masterGain = audioContext.createGain();
      // 背景音乐压到很低，把听觉焦点让给字幕/朗读
      masterGain.gain.value = 0.012;
      masterGain.connect(destination);

      // 解码旁白 mp3 并接入到 destination；narration 独立 gain，远大于 BGM
      let narrationBuffer: AudioBuffer | null = null;
      let narrationSource: AudioBufferSourceNode | null = null;
      if (narrationArrayBuf && narrationArrayBuf.byteLength > 0) {
        try {
          narrationBuffer = await audioContext.decodeAudioData(narrationArrayBuf.slice(0));
        } catch {
          narrationBuffer = null;
        }
      }

      // 如果旁白比当前时长更长，按比例放大每幕时长，确保旁白完整播完才停录
      if (narrationBuffer) {
        const narrationDurationMs = Math.ceil(narrationBuffer.duration * 1000);
        const needed = narrationDurationMs + 800;
        if (needed > durationMs) {
          const scale = needed / durationMs;
          sceneDurations = sceneDurations.map((d) => Math.round(d * scale));
          sceneStarts = [];
          let acc = 0;
          for (const d of sceneDurations) {
            sceneStarts.push(acc);
            acc += d;
          }
          durationMs = sceneStarts[sceneStarts.length - 1] + sceneDurations[sceneDurations.length - 1];
        }
        const narrationGain = audioContext.createGain();
        narrationGain.gain.value = 1.0;
        narrationGain.connect(destination);
        narrationSource = audioContext.createBufferSource();
        narrationSource.buffer = narrationBuffer;
        narrationSource.connect(narrationGain);
      }

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
        // 切场景的"叮"音也压低，避免盖住朗读
        g.gain.linearRampToValueAtTime(0.45, startTime + 0.04);
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

      // 关键词 → 道具 emoji 映射（用于让漂浮道具贴合当前场景文本）
      const keywordEmoji: Array<[string, string]> = [
        ['苹果', '🍎'], ['橘子', '🍊'], ['橙', '🍊'], ['香蕉', '🍌'], ['葡萄', '🍇'],
        ['西瓜', '🍉'], ['草莓', '🍓'], ['梨', '🍐'], ['桃', '🍑'], ['菠萝', '🍍'],
        ['太阳', '☀️'], ['月亮', '🌙'], ['月', '🌙'], ['星星', '⭐'], ['星', '⭐'],
        ['云', '☁️'], ['雨', '🌧'], ['雪', '❄️'], ['冰', '🧊'], ['火', '🔥'],
        ['雷', '⚡'], ['电', '⚡'], ['风', '💨'], ['彩虹', '🌈'],
        ['花', '🌸'], ['草', '🌿'], ['树', '🌳'], ['叶', '🍃'], ['玫瑰', '🌹'],
        ['鸟', '🐦'], ['鱼', '🐟'], ['猫', '🐱'], ['狗', '🐶'], ['鸡', '🐔'],
        ['鸭', '🦆'], ['兔', '🐰'], ['熊', '🐻'], ['虎', '🐯'], ['狮', '🦁'],
        ['马', '🐴'], ['牛', '🐮'], ['羊', '🐑'], ['猪', '🐷'], ['蛇', '🐍'],
        ['蝴蝶', '🦋'], ['蜜蜂', '🐝'], ['蚂蚁', '🐜'], ['青蛙', '🐸'],
        ['书', '📚'], ['本', '📖'], ['笔', '✏️'], ['画', '🎨'], ['音乐', '🎵'],
        ['歌', '🎶'], ['琴', '🎹'], ['鼓', '🥁'],
        ['加', '➕'], ['减', '➖'], ['乘', '✖️'], ['除', '➗'], ['等于', '🟰'],
        ['数', '🔢'],
        ['车', '🚗'], ['船', '⛵'], ['飞机', '✈️'], ['火箭', '🚀'], ['自行车', '🚲'],
        ['球', '⚽'], ['气球', '🎈'], ['礼物', '🎁'], ['蛋糕', '🍰'], ['糖', '🍬'],
        ['爱', '❤️'], ['心', '💖'], ['家', '🏠'], ['学校', '🏫'],
        ['水', '💧'], ['山', '⛰'], ['河', '🌊'], ['海', '🌊'],
      ];
      const scenePropsArr: string[][] = scenes.map((s) => {
        const text = String(s || '');
        const matched: string[] = [];
        for (const [kw, em] of keywordEmoji) {
          if (text.includes(kw) && !matched.includes(em)) matched.push(em);
          if (matched.length >= 6) break;
        }
        return matched;
      });

      // 场景类型识别：根据文字命中关键词归类，未命中则 normal
      type SceneFx = { kind: 'count' | 'sound' | 'visual' | 'normal'; digits: string[] };
      const countKws = ['数一数', '数数', '几个', '多少', '加', '减', '乘', '除', '一共', '总共'];
      const soundKws = ['听', '音乐', '唱', '歌', '声', '朗读', '念', '读一读'];
      const visualKws = ['看', '画', '颜色', '形状', '圆', '方形', '三角'];
      const sceneFxArr: SceneFx[] = scenes.map((s) => {
        const text = String(s || '');
        const digits: string[] = [];
        const dm = text.match(/\d+/g);
        if (dm) digits.push(...dm.slice(0, 6));
        if (countKws.some((k) => text.includes(k)) || digits.length >= 2) {
          return { kind: 'count', digits };
        }
        if (soundKws.some((k) => text.includes(k))) return { kind: 'sound', digits };
        if (visualKws.some((k) => text.includes(k))) return { kind: 'visual', digits };
        return { kind: 'normal', digits };
      });

      const startedAt = Date.now();
      let raf = 0;
      let frameCounter = 0;

      const draw = () => {
        const elapsed = Date.now() - startedAt;
        frameCounter += 1;
        try {

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
        // 优先用当前场景文字匹配到的关键词道具；没匹配到则回退到通用 propPool
        const matchedProps = scenePropsArr[sceneIdx] || [];
        const propsForScene = matchedProps.length > 0 ? matchedProps : propPool;
        ctx.font = `${isPortrait ? 28 : 34}px sans-serif`;
        ctx.globalAlpha = 0.85;
        for (let i = 0; i < 10; i += 1) {
          const e = propsForScene[(i + sceneIdx * 3) % propsForScene.length];
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
          // 呼吸（非说话者主要靠这个起伏）
          const breathe = Math.sin(t * 2.2 + (isSpeaker ? 0 : Math.PI)) * (isSpeaker ? 3 : 4);
          // 蹦跳：说话者用 |sin|^1.7 形成跳起-落地节奏（仅向上偏移）
          const bouncePhase = t * 2.4;
          const bounce = isSpeaker ? -Math.pow(Math.abs(Math.sin(bouncePhase)), 1.7) * 26 : 0;
          // 张口：仅说话的角色嘴部张合（垂直缩放）
          const speakMouth = isSpeaker ? 1 + Math.abs(Math.sin(t * 11)) * 0.08 : 1;
          // 眨眼：周期性短促垂直 squash，两个角色相位错开
          const blinkPeriod = 3.4;
          const blinkOffset = isSpeaker ? 0 : 1.5;
          const blinkCycle = ((t + blinkOffset) % blinkPeriod) / blinkPeriod;
          const blinkActive = blinkCycle > 0.94;
          const blinkScaleY = blinkActive
            ? 1 - Math.sin(((blinkCycle - 0.94) / 0.06) * Math.PI) * 0.2
            : 1;
          // 摇晃
          const sway = Math.sin(t * 1.8 + (isSpeaker ? 0 : Math.PI / 2)) * (isSpeaker ? 8 : 3);
          // 非说话者点头
          const nodAngle = !isSpeaker ? Math.sin(t * 3.2) * 0.07 : 0;

          // 影子：蹦跳时按高度缩小、变淡
          const heightRatio = isSpeaker ? Math.abs(bounce) / 26 : 0;
          const shadowK = 1 - heightRatio * 0.35;
          ctx.fillStyle = `rgba(0,0,0,${0.22 - heightRatio * 0.08})`;
          ctx.beginPath();
          ctx.ellipse(
            x,
            groundLine + charSize * 0.42,
            charSize * 0.34 * shadowK,
            charSize * 0.08 * shadowK,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();

          ctx.save();
          ctx.translate(x + sway, groundLine + breathe + bounce);
          if (nodAngle !== 0) ctx.rotate(nodAngle);
          if (flip) ctx.scale(-1, 1);
          ctx.scale(1, speakMouth * blinkScaleY);
          ctx.font = `${charSize}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText(emoji, 0, 0);
          ctx.restore();
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'start';

          if (isSpeaker) {
            // 说话者头顶小音符
            ctx.globalAlpha = 0.7 + Math.sin(t * 4) * 0.3;
            ctx.font = `${isPortrait ? 28 : 34}px sans-serif`;
            ctx.fillText(
              '🎵',
              x + charSize * 0.35,
              groundLine + breathe + bounce - charSize * 0.55 + Math.sin(t * 3) * 4,
            );
            ctx.globalAlpha = 1;
          } else {
            // 非说话者鼓掌：周期闪现 👏，让 listener 看起来在认真听
            const clapCycle = (t * 1.6) % (Math.PI * 2);
            const clapAlpha = Math.max(0, Math.sin(clapCycle));
            if (clapAlpha > 0.15) {
              ctx.globalAlpha = Math.min(1, clapAlpha * 1.1);
              ctx.font = `${isPortrait ? 30 : 36}px sans-serif`;
              const handX = x + (flip ? -1 : 1) * charSize * 0.34;
              const handY = groundLine + breathe + charSize * 0.08 + Math.sin(t * 8) * 2;
              ctx.fillText('👏', handX, handY);
              ctx.globalAlpha = 1;
            }
          }
        };
        drawChar(charA, charAX, speakerIsA, false);
        drawChar(charB, charBX, !speakerIsA, true);

        // 5.1 主角道具：关键词命中时，让一个大 emoji 绕着说话者公转，强化"在讲这个"
        if (matchedProps.length > 0) {
          const heroEmoji = matchedProps[0];
          const heroSpeakerX = speakerIsA ? charAX : charBX;
          const orbitRadius = charSize * 0.55;
          const orbitAngle = t * 1.4;
          const heroX = heroSpeakerX + Math.cos(orbitAngle) * orbitRadius;
          const heroY =
            groundLine - charSize * 0.1 + Math.sin(orbitAngle) * orbitRadius * 0.45;
          ctx.save();
          ctx.translate(heroX, heroY);
          ctx.rotate(Math.sin(t * 2.5) * 0.25);
          ctx.font = `${isPortrait ? 72 : 88}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText(heroEmoji, 0, 0);
          ctx.restore();
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'start';
        }

        // 6. 对白气泡（指向当前说话者）
        const speakerX = speakerIsA ? charAX : charBX;
        const bubbleW = isPortrait ? canvas.width - 80 : canvas.width * 0.62;
        const bubbleH = isPortrait ? 240 : 220;
        const bubbleX = (canvas.width - bubbleW) / 2;
        // 切场时气泡从下方滑入（前 18% 进度做缓动）
        const bubbleSlideP = Math.min(1, sceneProgress / 0.18);
        const bubbleSlideEase = 1 - Math.pow(1 - bubbleSlideP, 3);
        const bubbleSlideOffset = (1 - bubbleSlideEase) * 36;
        const bubbleY = (isPortrait ? canvas.height * 0.18 : canvas.height * 0.2) + bubbleSlideOffset;

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

        // 气泡内文本（逐字显现）—— 前缀加上说话角色 emoji，营造一问一答的演绎感
        const speakerEmoji = speakerIsA ? charA : charB;
        const rawSentence = scenes[sceneIdx] || '';
        const isQuestion = sceneIdx % 2 === 0;
        const sentence = `${speakerEmoji}${isQuestion ? '问' : '答'}：${rawSentence}`;
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
        ctx.fillText(`第 ${sceneIdx + 1} / ${scenes.length} 幕`, isPortrait ? 40 : 70, canvas.height - 46);

        ctx.fillStyle = '#8c8c8c';
        ctx.font = `${isPortrait ? 18 : 22}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillText('✨ AI 动画演绎 · 边看边学', canvas.width - (isPortrait ? 260 : 320), canvas.height - 46);

        // 7.1 字幕进度条（最底部）
        const barH = isPortrait ? 8 : 10;
        const barY = canvas.height - barH;
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.fillRect(0, barY, canvas.width, barH);
        const progress = Math.min(1, elapsed / durationMs);
        ctx.fillStyle = theme.accent;
        ctx.fillRect(0, barY, canvas.width * progress, barH);
        // 章节刻度
        for (let i = 1; i < scenes.length; i += 1) {
          const tx = canvas.width * (sceneStarts[i] / durationMs);
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(tx - 1, barY, 2, barH);
        }

        // 7.5 场景类型特效层（count / sound / visual / normal）
        const fx = sceneFxArr[sceneIdx];
        if (fx && fx.kind !== 'normal') {
          ctx.save();
          if (fx.kind === 'count') {
            // 数字飞入：每个数字从顶部带旋转下落，scene 前 60% 内全部就位
            const digitsToShow = fx.digits.length > 0 ? fx.digits : ['1', '2', '3'];
            ctx.font = `bold ${isPortrait ? 96 : 128}px "PingFang SC", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const slot = canvas.width / (digitsToShow.length + 1);
            const targetY = canvas.height * 0.42;
            for (let i = 0; i < digitsToShow.length; i += 1) {
              const delay = i * 0.08;
              const localP = Math.min(1, Math.max(0, (sceneProgress - delay) / 0.4));
              if (localP <= 0) continue;
              const ease = 1 - Math.pow(1 - localP, 3);
              const x = slot * (i + 1);
              const startY = -120;
              const y = startY + (targetY - startY) * ease;
              const rot = (1 - ease) * Math.PI * 1.2;
              const bounce = localP < 0.95 ? 0 : Math.sin((localP - 0.95) * 20) * 8;
              ctx.save();
              ctx.translate(x, y - bounce);
              ctx.rotate(rot);
              ctx.fillStyle = theme.accent;
              ctx.globalAlpha = 0.18;
              ctx.fillText(digitsToShow[i], 4, 6);
              ctx.globalAlpha = 0.92;
              ctx.fillStyle = '#ffffff';
              ctx.fillText(digitsToShow[i], 0, 0);
              ctx.restore();
            }
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
          } else if (fx.kind === 'sound') {
            // 音符雨：🎵 / 🎶 从顶部落下，循环
            const notes = ['🎵', '🎶', '🎼', '🎤'];
            ctx.font = `${isPortrait ? 42 : 54}px sans-serif`;
            ctx.textBaseline = 'middle';
            for (let i = 0; i < 14; i += 1) {
              const phase = (t * 0.35 + i * 0.31) % 1;
              const x = ((i * 211) % (canvas.width - 60)) + 30;
              const y = phase * (canvas.height + 80) - 40;
              const sway = Math.sin(t * 1.4 + i) * 18;
              ctx.globalAlpha = 0.35 + 0.45 * Math.sin(phase * Math.PI);
              ctx.fillText(notes[i % notes.length], x + sway, y);
            }
            ctx.globalAlpha = 1;
            ctx.textBaseline = 'alphabetic';
          } else if (fx.kind === 'visual') {
            // 闪光圈：scene 中心同心圆 pulse
            const cx = canvas.width / 2;
            const cy = canvas.height * 0.45;
            for (let i = 0; i < 3; i += 1) {
              const phase = (t * 0.8 + i * 0.33) % 1;
              const radius = phase * (isPortrait ? 260 : 340);
              ctx.beginPath();
              ctx.arc(cx, cy, radius, 0, Math.PI * 2);
              ctx.strokeStyle = theme.accent;
              ctx.globalAlpha = (1 - phase) * 0.45;
              ctx.lineWidth = isPortrait ? 5 : 7;
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1;
          }
          ctx.restore();
        }

        // 8. 场景过渡：进入时用本场景主题色淡入；退出时渐隐到下场景主题色（ease-out / ease-in，避免硬切白闪）
        if (sceneProgress < 0.12) {
          const fadeP = sceneProgress / 0.12;
          const ease = 1 - Math.pow(1 - fadeP, 2);
          ctx.globalAlpha = (1 - ease) * 0.85;
          ctx.fillStyle = theme.bg1;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        } else if (sceneProgress > 0.88 && sceneIdx < scenes.length - 1) {
          const fadeP = (sceneProgress - 0.88) / 0.12;
          const ease = Math.pow(fadeP, 2);
          const nextTheme = themes[(sceneIdx + 1) % themes.length];
          ctx.globalAlpha = ease * 0.85;
          ctx.fillStyle = nextTheme.bg1;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }

        // 9. 开场幕布（前 900ms）：红色幕布从中间向两侧拉开
        const curtainMs = 900;
        if (elapsed < curtainMs) {
          const cp = elapsed / curtainMs;
          const half = (canvas.width / 2) * (1 - cp);
          const curtainGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
          curtainGrad.addColorStop(0, '#c0392b');
          curtainGrad.addColorStop(1, '#7b1f15');
          ctx.fillStyle = curtainGrad;
          ctx.fillRect(0, 0, half, canvas.height);
          ctx.fillRect(canvas.width - half, 0, half, canvas.height);
          // 幕布边缘竖条褶皱
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          for (let s = 0; s < 6; s += 1) {
            const sx = (half / 6) * s;
            ctx.fillRect(sx, 0, 2, canvas.height);
            ctx.fillRect(canvas.width - sx - 2, 0, 2, canvas.height);
          }
          // 顶部金色挂杆
          ctx.fillStyle = '#d4a017';
          ctx.fillRect(0, 0, canvas.width, isPortrait ? 16 : 22);
          // 开场标题居中
          if (cp < 0.7) {
            ctx.globalAlpha = 1 - cp / 0.7;
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${isPortrait ? 56 : 72}px "PingFang SC", "Microsoft YaHei", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🎬 开演啦！', canvas.width / 2, canvas.height / 2);
            ctx.textAlign = 'start';
            ctx.textBaseline = 'alphabetic';
            ctx.globalAlpha = 1;
          }
        }

        // 10. 结尾"再见"（最后 1500ms）：半透明遮罩 + 居中大字 + 挥手 emoji
        const farewellMs = 1500;
        if (elapsed > durationMs - farewellMs) {
          const fp = Math.min(1, (elapsed - (durationMs - farewellMs)) / farewellMs);
          ctx.fillStyle = `rgba(255,255,255,${0.55 * fp})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const popScale = 0.6 + Math.min(1, fp * 3) * 0.4;
          const waveAngle = Math.sin(t * 8) * 0.25;
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.scale(popScale, popScale);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `${isPortrait ? 120 : 160}px sans-serif`;
          ctx.save();
          ctx.rotate(waveAngle);
          ctx.fillText('👋', 0, -isPortrait ? -30 : -40);
          ctx.restore();
          ctx.fillStyle = theme.accent;
          ctx.font = `bold ${isPortrait ? 64 : 84}px "PingFang SC", "Microsoft YaHei", sans-serif`;
          ctx.fillText('小朋友再见！', 0, isPortrait ? 90 : 110);
          ctx.restore();
          ctx.textAlign = 'start';
          ctx.textBaseline = 'alphabetic';
        }

        if (elapsed < durationMs) raf = requestAnimationFrame(draw);
        } catch { /* 单帧绘制异常不应中断录制循环 */ }
      };

      await new Promise<void>((resolve, reject) => {
        let stopWatchdog = 0;
        let hardWatchdog = 0;
        const cleanup = () => {
          window.clearTimeout(stopWatchdog);
          window.clearTimeout(hardWatchdog);
          cancelAnimationFrame(raf);
          mixedStream.getTracks().forEach((track) => track.stop());
        };
        recorder.onerror = () => {
          cleanup();
          reject(new Error('video_recorder_error'));
        };
        recorder.onstop = () => {
          cleanup();
          resolve();
        };
        try {
          recorder.start(200);
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error('video_recorder_start_failed'));
          return;
        }
        // 录制一启动就开始播放旁白；留 0.15s 给 MediaRecorder 抓首帧，避免吞掉开头
        if (narrationSource && audioContext) {
          try {
            narrationSource.start(audioContext.currentTime + 0.15);
          } catch { /* ignore */ }
        }
        draw();
        stopWatchdog = window.setTimeout(() => {
          cancelAnimationFrame(raf);
          try {
            if (recorder.state !== 'inactive') recorder.stop();
          } catch {
            /* ignore */
          }
        }, durationMs);
        hardWatchdog = window.setTimeout(() => {
          cleanup();
          try {
            if (recorder.state !== 'inactive') recorder.stop();
          } catch {
            /* ignore */
          }
          reject(new Error('video_recorder_timeout'));
        }, durationMs + 15000);
      });

      const blob = new Blob(chunks, { type: mimeType || 'video/mp4' });
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      const hint =
        reason === 'video_recorder_timeout'
          ? '本地渲染超时，已自动中止。建议改用音频，或在 WiFi 环境重试。'
          : reason === 'video_recorder_start_failed'
            ? '当前浏览器不支持本地视频录制，请改用音频，或换浏览器重试。'
            : '视频生成失败，请稍后重试或改用音频';
      message.error({ content: hint, key: `video-${videoKey}` });
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
              description="输入手机号即可登录，未注册会自动创建账号。首次访问服务启动可能需要 10-30 秒。"
            />

            <Tabs
              activeKey={authMode}
              onChange={(key) => {
                setAuthMode(key as 'sms' | 'register' | 'login');
                setLoginAssistMode('none');
              }}
              items={[
                {
                  key: 'sms',
                  label: '📱 手机号登录',
                  children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Alert
                        type="error"
                        showIcon
                        banner
                        message="⚠️ 测试 / 演示模式"
                        description="当前未接入真实短信服务，点「获取验证码」会把验证码直接显示在屏幕上并自动填入。生产环境会通过短信真实下发。"
                      />
                      <Input
                        size="large"
                        placeholder="请输入 11 位手机号"
                        value={smsPhone}
                        onChange={(e) => setSmsPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                        maxLength={11}
                        autoComplete="tel"
                        prefix={<span style={{ fontSize: 18 }}>📱</span>}
                      />
                      <Space.Compact style={{ width: '100%' }}>
                        <Input
                          size="large"
                          placeholder="6 位验证码"
                          value={smsCode}
                          onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          maxLength={6}
                          autoComplete="one-time-code"
                          prefix={<span style={{ fontSize: 18 }}>🔑</span>}
                        />
                        <Button
                          size="large"
                          onClick={onRequestSmsCode}
                          disabled={smsCooldown > 0 || smsSending || !/^1\d{10}$/.test(smsPhone)}
                          loading={smsSending}
                          style={{ minWidth: 116 }}
                        >
                          {smsCooldown > 0 ? `${smsCooldown}s 后重发` : '获取验证码'}
                        </Button>
                      </Space.Compact>
                      <Button
                        type="primary"
                        size="large"
                        block
                        onClick={onSmsLogin}
                        loading={smsLoggingIn}
                        disabled={!/^1\d{10}$/.test(smsPhone) || !/^\d{6}$/.test(smsCode)}
                      >
                        登录 / 注册
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        未注册手机号将自动创建账号，无需密码。
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  key: 'login',
                  label: '账号密码',
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

          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap align="center" size={10} className="upload-row">
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
            </Space>

            <div className="unified-section">
              <div className="unified-section-title">📤 拍照 / 选文件</div>
              <div className="upload-pick-grid">
                      <label className="file-pick-btn camera">
                        <span className="file-pick-emoji">📷</span>
                        <span className="file-pick-label">拍照</span>
                        <span className="file-pick-sub">拍课本/绘本</span>
                        <input
                          type="file"
                          data-role="material-upload"
                          accept="image/*"
                          capture="environment"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void onPickImageForOcr(f);
                          }}
                        />
                      </label>
                      <label className="file-pick-btn album">
                        <span className="file-pick-emoji">🖼️</span>
                        <span className="file-pick-label">相册</span>
                        <span className="file-pick-sub">从手机相册</span>
                        <input
                          type="file"
                          data-role="material-upload"
                          accept="image/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void onPickImageForOcr(f);
                          }}
                        />
                      </label>
                      <label className="file-pick-btn other">
                        <span className="file-pick-emoji">📄</span>
                        <span className="file-pick-label">其他</span>
                        <span className="file-pick-sub">PDF/音视频/文档</span>
                        <input
                          type="file"
                          data-role="material-upload"
                          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.markdown,.csv"
                          onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                        />
                      </label>
                    </div>
                    {(ocrBusy || ocrStage) && (
                      <div className="upload-progress-box">
                        <Progress
                          percent={ocrPercent}
                          status={ocrPercent >= 100 ? 'success' : 'active'}
                          strokeColor={{ from: '#fa8c16', to: '#722ed1' }}
                        />
                        <div className="upload-stage-text">{ocrStage || '正在识别…'}</div>
                      </div>
                    )}

                    {ocrPreview && (() => {
                      const isAudioBusy = materialBusyId === 'ocr-preview' && materialAction === 'audio';
                      const isVideoBusy = materialBusyId === 'ocr-preview' && materialAction === 'video';
                      const hasText = !!ocrPreview.text.trim();
                      return (
                        <div className="ocr-preview-card">
                          <div className="ocr-preview-head">
                            <img src={ocrPreview.thumbUrl} alt="拍摄预览" className="ocr-preview-thumb" />
                            <div className="ocr-preview-meta">
                              <Input
                                size="small"
                                value={ocrPreview.title}
                                onChange={(e) => setOcrPreview({ ...ocrPreview, title: e.target.value })}
                                maxLength={40}
                                placeholder="作品名称"
                              />
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                ✅ 已识别 {ocrPreview.text.length} 字，可直接生成音频或视频
                              </Typography.Text>
                            </div>
                            <Button size="small" type="text" onClick={onClearOcrPreview}>✕</Button>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <Button
                              size="small"
                              type="link"
                              style={{ paddingLeft: 0 }}
                              onClick={() => setOcrTextRevealed((v) => !v)}
                            >
                              {ocrTextRevealed ? '收起识别文本' : '查看/编辑识别文本'}
                            </Button>
                          </div>
                          {ocrTextRevealed && (
                            <Input.TextArea
                              value={ocrPreview.text}
                              onChange={(e) => setOcrPreview({ ...ocrPreview, text: e.target.value })}
                              autoSize={{ minRows: 3, maxRows: 8 }}
                              maxLength={2400}
                              showCount
                              placeholder="识别结果（可编辑）"
                            />
                          )}
                          <div style={{ marginTop: 8, fontSize: 12, color: '#8c8c8c', lineHeight: 1.6 }}>
                            👉 先点 <b>朗读</b> 或 <b>生成视频</b> 听听/看看效果，满意后再点 <b>保存</b> 收进作品库；保存只存文字，不会再次生成音视频。
                          </div>
                          <Space wrap size={8} style={{ marginTop: 8 }}>
                            <Button
                              type="primary"
                              icon={<span>🎙️</span>}
                              disabled={!hasText || isAudioBusy}
                              loading={isAudioBusy}
                              onClick={() => {
                                setMaterialBusyId('ocr-preview');
                                setMaterialAction('audio');
                                void Promise.resolve(onPlayMaterialAudio('ocr-preview', ocrPreview.text)).finally(() => {
                                  setMaterialBusyId(null);
                                  setMaterialAction(null);
                                });
                              }}
                            >朗读这段文字</Button>
                            <Button
                              icon={<span>🎬</span>}
                              disabled={!hasText || isVideoBusy}
                              loading={isVideoBusy}
                              onClick={async () => {
                                setMaterialBusyId('ocr-preview');
                                setMaterialAction('video');
                                try {
                                  await onGenerateMaterialVideo('ocr-preview', ocrPreview.title || '拍照学习', ocrPreview.text, 'landscape');
                                } finally {
                                  setMaterialBusyId(null);
                                  setMaterialAction(null);
                                }
                              }}
                            >生成学习视频</Button>
                            <Button
                              type="text"
                              icon={<span>💾</span>}
                              loading={uploading}
                              disabled={!hasText || uploading}
                              onClick={onSaveOcrToLibrary}
                            >仅保存文字到作品库</Button>
                          </Space>

                          {ttsState?.materialId === 'ocr-preview' && (
                            <div className="media-frame audio-frame" style={{ padding: 12, marginTop: 10 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <Typography.Text strong>🔊 正在朗读 {ttsState.isPaused ? '（已暂停）' : ''}</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  第 {ttsState.segmentIdx + 1} / {ttsState.totalSegments} 段 · 约 {ttsState.totalChars} 字
                                </Typography.Text>
                              </div>
                              <Slider
                                min={0}
                                max={Math.max(0, ttsState.totalSegments - 1)}
                                step={1}
                                value={ttsState.segmentIdx}
                                tooltip={{
                                  formatter: (val) => {
                                    const v = typeof val === 'number' ? val : 0;
                                    const ch = ttsState.charsBefore[v] ?? 0;
                                    const pct = ttsState.totalChars ? Math.round((ch / ttsState.totalChars) * 100) : 0;
                                    return `第 ${v + 1} 段 · ${pct}%`;
                                  },
                                }}
                                onChange={(val) => {
                                  ttsCtrlRef.current?.seekToSegment(typeof val === 'number' ? val : 0);
                                }}
                              />
                              <Space wrap size={8} style={{ marginTop: 6 }}>
                                {ttsState.isPaused ? (
                                  <Button size="small" type="primary" onClick={() => ttsCtrlRef.current?.resume()}>▶️ 继续</Button>
                                ) : (
                                  <Button size="small" onClick={() => ttsCtrlRef.current?.pause()}>⏸ 暂停</Button>
                                )}
                                <Button size="small" onClick={() => ttsCtrlRef.current?.stop()}>⏹ 停止</Button>
                                <span style={{ fontSize: 12, color: '#8c8c8c' }}>速度</span>
                                <Select
                                  size="small"
                                  value={ttsRate}
                                  style={{ width: 96 }}
                                  getPopupContainer={(trigger) => trigger.parentElement || document.body}
                                  onChange={(v) => {
                                    setTtsRate(v);
                                    ttsCtrlRef.current?.setRate(v);
                                  }}
                                  options={[
                                    { label: '0.5×', value: 0.5 },
                                    { label: '0.75×', value: 0.75 },
                                    { label: '1×', value: 1 },
                                    { label: '1.25×', value: 1.25 },
                                    { label: '1.5×', value: 1.5 },
                                    { label: '2×', value: 2 },
                                  ]}
                                />
                              </Space>
                            </div>
                          )}

                          {expandedVideoMaterialId === 'ocr-preview' && generatedVideoUrls['ocr-preview'] && (
                            <div className="media-frame video-frame" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
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
                                controlsList="nodownload"
                                preload="metadata"
                                playsInline
                                autoPlay
                                src={generatedVideoUrls['ocr-preview']}
                                style={{ width: '100%', borderRadius: 10, background: '#000' }}
                                ref={(el) => {
                                  if (el) {
                                    el.setAttribute('webkit-playsinline', 'true');
                                    el.setAttribute('x5-playsinline', 'true');
                                    el.setAttribute('x5-video-player-type', 'h5');
                                  }
                                }}
                              />
                              <Button
                                size="small"
                                block
                                onClick={() => setExpandedVideoMaterialId(null)}
                              >
                                ← 返回
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {uploadFile && (
                      <Space wrap align="center" size={10} className="upload-row">
                        <Tag color="blue" closable onClose={(e) => {
                          e.preventDefault();
                          setUploadFile(null);
                          document.querySelectorAll<HTMLInputElement>('input[type="file"][data-role="material-upload"]').forEach((fi) => { fi.value = ''; });
                        }}>
                          {uploadFile.name}
                        </Tag>
                        <Button
                          type="primary"
                          className="hero-cta"
                          onClick={() => onUploadMaterial(false)}
                          loading={uploading}
                          disabled={uploading || !uploadFile}
                        >
                          ⬆️ 上传到作品库
                        </Button>
                      </Space>
                    )}
                  </div>

                  <div className="library-divider">
                    <span className="library-divider-line" />
                    <span className="library-divider-label">📝 或者直接粘贴文字</span>
                    <span className="library-divider-line" />
                  </div>

                  <div className="unified-section">
                    <div className="unified-section-title">📝 粘贴文本</div>
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
                      {(() => {
                      const text = directMediaText.trim();
                      const hasText = !!text;
                      const isAudioBusy = materialBusyId === 'paste-preview' && materialAction === 'audio';
                      const isVideoBusy = materialBusyId === 'paste-preview' && materialAction === 'video';
                      return (
                        <Space wrap size={8}>
                          <Button
                            type="primary"
                            icon={<span>🎙️</span>}
                            disabled={!hasText || isAudioBusy}
                            loading={isAudioBusy}
                            onClick={() => {
                              setMaterialBusyId('paste-preview');
                              setMaterialAction('audio');
                              void Promise.resolve(onPlayMaterialAudio('paste-preview', text)).finally(() => {
                                setMaterialBusyId(null);
                                setMaterialAction(null);
                              });
                            }}
                          >生成并朗读音频</Button>
                          <Button
                            icon={<span>🎬</span>}
                            disabled={!hasText || isVideoBusy}
                            loading={isVideoBusy}
                            onClick={async () => {
                              setMaterialBusyId('paste-preview');
                              setMaterialAction('video');
                              try {
                                await onGenerateMaterialVideo('paste-preview', directMediaTitle.trim() || '粘贴文本', text, 'landscape');
                              } finally {
                                setMaterialBusyId(null);
                                setMaterialAction(null);
                              }
                            }}
                          >生成视频</Button>
                          <Button
                            icon={<span>💾</span>}
                            loading={uploading}
                            disabled={!hasText || uploading}
                            onClick={() => {
                              const titleRaw = directMediaTitle.trim() || '粘贴文本';
                              const safeTitle = titleRaw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'paste';
                              const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                              const file = new File([blob], `${safeTitle}.txt`, { type: 'text/plain' });
                              void onUploadMaterial(true, file).then(() => {
                                setDirectMediaText('');
                                setDirectMediaTitle('家庭学习音视频');
                              });
                            }}
                          >保存到作品库</Button>
                        </Space>
                      );
                    })()}

                    {ttsState?.materialId === 'paste-preview' && (
                      <div className="media-frame audio-frame" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <Typography.Text strong>🔊 正在朗读 {ttsState.isPaused ? '（已暂停）' : ''}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            第 {ttsState.segmentIdx + 1} / {ttsState.totalSegments} 段 · 约 {ttsState.totalChars} 字
                          </Typography.Text>
                        </div>
                        <Slider
                          min={0}
                          max={Math.max(0, ttsState.totalSegments - 1)}
                          step={1}
                          value={ttsState.segmentIdx}
                          tooltip={{
                            formatter: (val) => {
                              const v = typeof val === 'number' ? val : 0;
                              const ch = ttsState.charsBefore[v] ?? 0;
                              const pct = ttsState.totalChars ? Math.round((ch / ttsState.totalChars) * 100) : 0;
                              return `第 ${v + 1} 段 · ${pct}%`;
                            },
                          }}
                          onChange={(val) => {
                            ttsCtrlRef.current?.seekToSegment(typeof val === 'number' ? val : 0);
                          }}
                        />
                        <Space wrap size={8} style={{ marginTop: 6 }}>
                          {ttsState.isPaused ? (
                            <Button size="small" type="primary" onClick={() => ttsCtrlRef.current?.resume()}>▶️ 继续</Button>
                          ) : (
                            <Button size="small" onClick={() => ttsCtrlRef.current?.pause()}>⏸ 暂停</Button>
                          )}
                          <Button size="small" onClick={() => ttsCtrlRef.current?.stop()}>⏹ 停止</Button>
                          <span style={{ fontSize: 12, color: '#8c8c8c' }}>速度</span>
                          <Select
                            size="small"
                            value={ttsRate}
                            style={{ width: 96 }}
                            getPopupContainer={(trigger) => trigger.parentElement || document.body}
                            onChange={(v) => {
                              setTtsRate(v);
                              ttsCtrlRef.current?.setRate(v);
                            }}
                            options={[
                              { label: '0.5×', value: 0.5 },
                              { label: '0.75×', value: 0.75 },
                              { label: '1×', value: 1 },
                              { label: '1.25×', value: 1.25 },
                              { label: '1.5×', value: 1.5 },
                              { label: '2×', value: 2 },
                            ]}
                          />
                        </Space>
                      </div>
                    )}

                    {expandedVideoMaterialId === 'paste-preview' && generatedVideoUrls['paste-preview'] && (
                      <div className="media-frame video-frame" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                          controlsList="nodownload"
                          preload="metadata"
                          playsInline
                          autoPlay
                          src={generatedVideoUrls['paste-preview']}
                          style={{ width: '100%', borderRadius: 10, background: '#000' }}
                          ref={(el) => {
                            if (el) {
                              el.setAttribute('webkit-playsinline', 'true');
                              el.setAttribute('x5-playsinline', 'true');
                              el.setAttribute('x5-video-player-type', 'h5');
                            }
                          }}
                        />
                        <Button
                          size="small"
                          block
                          onClick={() => setExpandedVideoMaterialId(null)}
                        >
                          ← 返回
                        </Button>
                      </div>
                    )}
                    </Space>
                  </div>
          </Space>

          {(uploading || uploadStage) && (
            <div className="upload-progress-box">
              <Progress
                percent={uploadPercent}
                status={uploadPercent >= 100 ? 'success' : 'active'}
                strokeColor={{ from: '#1677ff', to: '#9254de' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                <div className="upload-stage-text" style={{ marginTop: 0 }}>{uploadStage || '处理中…'}</div>
                {uploading && uploadPercent < 100 && uploadAbortRef.current ? (
                  <Button size="small" danger onClick={() => uploadAbortRef.current?.()}>
                    取消上传
                  </Button>
                ) : null}
              </div>
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
              const resolvedAudioUrl = parsed.audioUrl ? resolveAssetUrl(parsed.audioUrl) : '';
              const resolvedVideoUrl = parsed.videoUrl ? resolveAssetUrl(parsed.videoUrl) : '';
              const localVideoUrl = generatedVideoUrls[item.id] || '';
              const playableVideoUrl = resolvedVideoUrl || localVideoUrl;
              const isGeneratingAudio = materialBusyId === item.id && materialAction === 'audio';
              const isGeneratingVideo = materialBusyId === item.id && materialAction === 'video';
              const stageForItem = mediaStage && mediaStage.materialId === item.id ? mediaStage : null;
              const stageElapsedSec = stageForItem ? Math.max(0, Math.floor((Date.now() - stageForItem.startedAt) / 1000)) : 0;
              const videoStagePhrase = stageForItem && stageForItem.kind === 'video'
                ? (stageForItem.phase === 'recognize' ? '识别字幕中'
                  : stageForItem.phase === 'generate' ? '生成视频中'
                  : '本地渲染中')
                : null;
              const audioStagePhrase = stageForItem && stageForItem.kind === 'audio'
                ? (stageForItem.phase === 'recognize' ? '识别字幕中'
                  : stageForItem.phase === 'generate' ? '合成音频中'
                  : '本地朗读中')
                : null;
              const hasFallbackAudio = parsed.mediaStatus === 'fallback' && !resolvedAudioUrl && !!parsed.recognitionText;
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
              return (
                <List.Item className="list-item-soft material-list-item">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <div className="material-header-row">
                      <Space wrap size={8}>
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

                    {!!parsed.fallbackReason && (() => {
                      const text = getFallbackReasonText(parsed.fallbackReason);
                      if (!text) return null;
                      const tone = parsed.fallbackReason === 'text_extraction_unsupported' ? 'warning' : 'secondary';
                      return <Typography.Text type={tone}>{text}</Typography.Text>;
                    })()}

                    {audioReady && showAudioPlayer && (
                      <div className="media-frame audio-frame" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
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
                          controlsList="nodownload"
                          preload="metadata"
                          autoPlay={expandedAudioMaterialId === item.id}
                          src={resolvedAudioUrl}
                          style={{ width: '100%' }}
                        />
                        <Button
                          size="small"
                          block
                          onClick={() => setExpandedAudioMaterialId(null)}
                        >
                          ← 返回
                        </Button>
                      </div>
                    )}

                    {ttsState?.materialId === item.id && (
                      <div className="media-frame audio-frame" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <Typography.Text strong>🔊 正在朗读 {ttsState.isPaused ? '（已暂停）' : ''}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            第 {ttsState.segmentIdx + 1} / {ttsState.totalSegments} 段 · 约 {ttsState.totalChars} 字
                          </Typography.Text>
                        </div>
                        <Slider
                          min={0}
                          max={Math.max(0, ttsState.totalSegments - 1)}
                          step={1}
                          value={ttsState.segmentIdx}
                          tooltip={{
                            formatter: (val) => {
                              const v = typeof val === 'number' ? val : 0;
                              const ch = ttsState.charsBefore[v] ?? 0;
                              const pct = ttsState.totalChars ? Math.round((ch / ttsState.totalChars) * 100) : 0;
                              return `第 ${v + 1} 段 · ${pct}%`;
                            },
                          }}
                          onChange={(val) => {
                            ttsCtrlRef.current?.seekToSegment(typeof val === 'number' ? val : 0);
                          }}
                        />
                        <Space wrap size={8} style={{ marginTop: 6 }}>
                          {ttsState.isPaused ? (
                            <Button size="small" type="primary" onClick={() => ttsCtrlRef.current?.resume()}>▶️ 继续</Button>
                          ) : (
                            <Button size="small" onClick={() => ttsCtrlRef.current?.pause()}>⏸ 暂停</Button>
                          )}
                          <Button size="small" onClick={() => ttsCtrlRef.current?.stop()}>⏹ 停止</Button>
                          <span style={{ fontSize: 12, color: '#8c8c8c' }}>速度</span>
                          <Select
                            size="small"
                            value={ttsRate}
                            style={{ width: 96 }}
                            getPopupContainer={(trigger) => trigger.parentElement || document.body}
                            onChange={(v) => {
                              setTtsRate(v);
                              ttsCtrlRef.current?.setRate(v);
                            }}
                            options={[
                              { label: '0.5×', value: 0.5 },
                              { label: '0.75×', value: 0.75 },
                              { label: '1×', value: 1 },
                              { label: '1.25×', value: 1.25 },
                              { label: '1.5×', value: 1.5 },
                              { label: '2×', value: 2 },
                            ]}
                          />
                        </Space>
                      </div>
                    )}

                    {videoReady && showVideoPlayer && (
                      <div className="media-frame video-frame" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                          controlsList="nodownload"
                          preload="metadata"
                          playsInline
                          autoPlay={expandedVideoMaterialId === item.id}
                          src={playableVideoUrl}
                          style={{ width: '100%', borderRadius: 10, background: '#000' }}
                          ref={(el) => {
                            if (el) {
                              el.setAttribute('webkit-playsinline', 'true');
                              el.setAttribute('x5-playsinline', 'true');
                              el.setAttribute('x5-video-player-type', 'h5');
                            }
                          }}
                        />
                        <Button
                          size="small"
                          block
                          onClick={() => setExpandedVideoMaterialId(null)}
                        >
                          ← 返回
                        </Button>
                      </div>
                    )}

                    <Space wrap size={8} className="material-action-row">
                      <Button
                        size="small"
                        type={audioReady ? 'default' : 'primary'}
                        loading={isGeneratingAudio}
                        disabled={isGeneratingAudio}
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
                        {isGeneratingAudio
                          ? `${audioStagePhrase ?? '🎙️ 准备中'}… ${stageElapsedSec}s`
                          : audioReady
                            ? (showAudioPlayer ? '⏸ 收起' : '▶️ 播放音频')
                            : (hasFallbackAudio ? '🔊 朗读文本' : '🎙️ 生成音频')}
                      </Button>
                      <Button
                        size="small"
                        type={videoReady ? 'default' : 'primary'}
                        loading={isGeneratingVideo}
                        disabled={isGeneratingVideo}
                        onClick={() => {
                          if (videoReady) {
                            setExpandedVideoMaterialId((prev) => (prev === item.id ? null : item.id));
                            return;
                          }
                          void onGenerateMaterialProduct(item.id, 'video');
                        }}
                      >
                        {isGeneratingVideo
                          ? `${videoStagePhrase ?? '🎬 准备中'}… ${stageElapsedSec}s`
                          : videoReady
                            ? (showVideoPlayer ? '⏸ 收起' : '▶️ 播放视频')
                            : '🎬 生成视频'}
                      </Button>
                      {stageForItem && stageForItem.phase === 'generate' && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => {
                            mediaFallbackRequestedRef.current = { materialId: item.id, kind: stageForItem.kind };
                            message.info('已请求跳过等待，正在切到本地生成…');
                          }}
                        >
                          ⏭ 跳过等待，本地生成
                        </Button>
                      )}
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
