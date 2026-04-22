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
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadChildId, setUploadChildId] = useState<string | undefined>(undefined);
  const [directMediaTitle, setDirectMediaTitle] = useState('家庭学习音视频');
  const [directMediaText, setDirectMediaText] = useState('');

  const [childForm] = Form.useForm();

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
      setAuthMode('login');
      setLoginAssistMode('none');
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
      message.success('登录成功');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const onForgotPassword = async (values: { username: string }) => {
    setForgotSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '重置口令申请失败', res.status));
        return;
      }

      const tokenValue = data && typeof data === 'object'
        ? String((data as Record<string, unknown>).resetToken || '').trim()
        : '';
      setLatestResetToken(tokenValue);
      message.success(getApiErrorMessage(data, '如账号存在，重置口令已生成', res.status));
      setAuthMode('login');
      setLoginAssistMode('reset');
    } catch {
      message.error('网络异常，请稍后重试');
    } finally {
      setForgotSubmitting(false);
    }
  };

  const onResetPassword = async (values: { token: string; password: string }) => {
    setResetSubmitting(true);
    try {
      const res = await appFetch(`${APP_API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await parseApiResponse(res);
      if (!res.ok) {
        message.error(getApiErrorMessage(data, '密码重置失败', res.status));
        return;
      }
      message.success(getApiErrorMessage(data, '密码已重置，请登录', res.status));
      setLatestResetToken('');
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
        message.error(getApiErrorMessage(data, '创建任务失败', res.status));
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

  const onUploadMaterial = async (autoGenerateTask?: boolean) => {
    if (!uploadFile) {
      message.warning('请先选择要上传的文件');
      return;
    }
    setUploading(true);
    message.loading({ content: '资料上传中…', key: 'material-upload' });
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
        message.error({ content: getApiErrorMessage(data, '上传失败', res.status), key: 'material-upload' });
        return;
      }

      const uploaded = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
      const uploadedMaterialId = uploaded && typeof uploaded.id === 'string' ? uploaded.id : null;

      if (autoGenerateTask && uploadedMaterialId) {
        message.loading({ content: '上传成功，正在自动识别并生成任务…', key: 'material-upload' });
        const recognizeRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/recognize`, {
          method: 'POST',
        });
        const recognizeData = await parseApiResponse(recognizeRes);
        if (!recognizeRes.ok) {
          message.error({ content: getApiErrorMessage(recognizeData, '上传成功，但自动识别失败', recognizeRes.status), key: 'material-upload' });
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'recognize');

        const generateRes = await appFetch(`${APP_API_BASE}/library/materials/${uploadedMaterialId}/generate-task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const generateData = await parseApiResponse(generateRes);
        if (!generateRes.ok) {
          message.error({ content: getApiErrorMessage(generateData, '上传成功，但自动生成任务失败', generateRes.status), key: 'material-upload' });
          await reloadAll();
          return;
        }

        await pollMaterialUntilDone(uploadedMaterialId, 'generate');
        message.success({ content: '上传成功，已自动识别并生成任务', key: 'material-upload' });
      } else {
        message.success({ content: '资料上传成功，已进入资料库', key: 'material-upload' });
      }

      setUploadFile(null);
      setUploadChildId(undefined);
      await reloadAll();
    } catch (e) {
      message.error({ content: e instanceof Error ? e.message : '上传失败，请稍后重试', key: 'material-upload' });
      await reloadAll();
    } finally {
      setUploading(false);
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
          window.open(resolveAssetUrl(parsed.audioUrl), '_blank', 'noopener,noreferrer');
          message.success('音频已生成，可在线查看');
          return;
        }
        if (parsed.recognitionText) {
          await onPlayMaterialAudio(materialId, parsed.recognitionText);
          return;
        }
        message.success('音频生成完成，请刷新后查看');
        return;
      }

      if (parsed.videoUrl) {
        window.open(resolveAssetUrl(parsed.videoUrl), '_blank', 'noopener,noreferrer');
        message.success('视频已生成，可在线查看');
        return;
      }
      if (parsed.recognitionText) {
        await onGenerateMaterialVideo(materialId, parsed.fileName, parsed.recognitionText, 'landscape');
        return;
      }
      message.success('视频生成完成，请刷新后查看');
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
  ) => {
    const content = text.trim();
    if (!content) {
      message.warning('请先完成识别，拿到文本后再生成视频');
      return;
    }
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      message.error('当前浏览器不支持视频生成');
      return;
    }

    const isPortrait = orientation === 'portrait';
    const videoKey = `${materialId}-${orientation}`;
    const canvas = document.createElement('canvas');
    canvas.width = isPortrait ? 720 : 1280;
    canvas.height = isPortrait ? 1280 : 720;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') {
      message.error('当前设备不支持视频导出');
      return;
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
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(title || '学习资料').replace(/\s+/g, '_')}-${isPortrait ? '竖屏' : '横屏'}学习视频.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      message.success({ content: `${isPortrait ? '竖屏' : '横屏'}视频生成完成，已开始下载`, key: `video-${videoKey}` });
    } catch {
      message.error({ content: '视频生成失败，请稍后重试', key: `video-${videoKey}` });
    } finally {
      if (audioContext) {
        await audioContext.close().catch(() => undefined);
      }
      setVideoMaterialId(null);
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

                      {loginAssistMode === 'none' && (
                        <Button type="link" style={{ paddingInline: 0 }} onClick={() => setLoginAssistMode('forgot')}>
                          忘记密码？
                        </Button>
                      )}

                      {loginAssistMode === 'forgot' && (
                        <Card size="small" title="找回密码" style={{ background: '#fafafa' }}>
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            <Typography.Text type="secondary">输入用户名后可生成一次性重置口令（有效期 30 分钟）。</Typography.Text>
                            <Form layout="vertical" onFinish={onForgotPassword} autoComplete="off">
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
                        <Card size="small" title="重置密码" style={{ background: '#fafafa' }}>
                          <Space direction="vertical" size={8} style={{ width: '100%' }}>
                            {latestResetToken && (
                              <Alert
                                type="success"
                                showIcon
                                message="已生成重置口令"
                                description={<Typography.Text copyable>{latestResetToken}</Typography.Text>}
                              />
                            )}
                            <Form layout="vertical" onFinish={onResetPassword} autoComplete="off">
                              <Form.Item label="重置口令" name="token" rules={[{ required: true, message: '请输入重置口令' }]}>
                                <Input placeholder="请输入重置口令" />
                              </Form.Item>
                              <Form.Item
                                label="新密码"
                                name="password"
                                rules={[
                                  { required: true, message: '请输入新密码' },
                                  { pattern: /^(?=.*[a-zA-Z])(?=.*\d).{8,}$/, message: '密码至少 8 位，且需同时包含字母和数字' },
                                ]}
                              >
                                <Input.Password placeholder="请输入新密码" autoComplete="new-password" />
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
                    <Form layout="vertical" onFinish={onRegister} autoComplete="on">
                      <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                        <Input placeholder="请输入用户名" autoComplete="username" />
                      </Form.Item>
                      <Form.Item
                        label="密码"
                        name="password"
                        rules={[
                          { required: true, message: '请输入密码' },
                          { pattern: /^(?=.*[a-zA-Z])(?=.*\d).{8,}$/, message: '密码至少 8 位，且需同时包含字母和数字' },
                        ]}
                      >
                        <Input.Password placeholder="请输入密码" autoComplete="new-password" />
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
    <div className="app-learning-shell" style={{
      background: 'linear-gradient(180deg, #f0f7ff 0%, #f7faff 45%, #ffffff 100%)',
      borderRadius: 20,
      padding: 16,
    }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        loading={loading}
        title={<Typography.Text strong style={{ fontSize: 18, color: '#1d39c4' }}>家长学习中心</Typography.Text>}
        extra={<Button onClick={() => { clearAppToken(); setToken(null); setMe(null); }}>退出</Button>}
        style={{ borderRadius: 16, borderColor: '#adc6ff' }}
        bodyStyle={{ background: '#f9fbff' }}
      >        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            当前家长：<strong>{me?.displayName || me?.username || '未命名家长'}</strong>
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

      <Card title="孩子档案管理" style={{ borderRadius: 16, borderColor: '#b7eb8f' }} bodyStyle={{ background: '#fcfff6' }}>
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
              <List.Item
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

      <Card title="学习任务管理" style={{ borderRadius: 16, borderColor: '#ffd591' }} bodyStyle={{ background: '#fffaf3' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Form layout="inline" onFinish={onCreateTask}>
            <Form.Item name="title" rules={[{ required: true, message: '请输入任务标题' }]}>
              <Input placeholder="任务标题" />
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

      <Card title="文本直出音视频（免上传）" style={{ borderRadius: 16, borderColor: '#d3adf7' }} bodyStyle={{ background: '#fcf5ff' }}>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="success"
            message="直接粘贴文本，一键生成音频/视频"
            description="适合临时练习，不依赖文件上传。"
          />
          <Input
            value={directMediaTitle}
            onChange={(e) => setDirectMediaTitle(e.target.value)}
            placeholder="请输入标题（用于视频文件名）"
            maxLength={40}
          />
          <Input.TextArea
            value={directMediaText}
            onChange={(e) => setDirectMediaText(e.target.value)}
            placeholder="请粘贴要朗读或生成视频的文本"
            autoSize={{ minRows: 4, maxRows: 10 }}
            maxLength={2400}
            showCount
          />
          <Space wrap>
            <Button
              onClick={() => onPlayMaterialAudio('direct-text', directMediaText)}
              loading={speakingMaterialId === 'direct-text'}
            >
              生成音频
            </Button>
            <Button
              onClick={() => onGenerateMaterialVideo('direct-text', directMediaTitle, directMediaText, 'landscape')}
              loading={videoMaterialId === 'direct-text-landscape'}
            >
              生成横屏视频
            </Button>
            <Button
              onClick={() => onGenerateMaterialVideo('direct-text', directMediaTitle, directMediaText, 'portrait')}
              loading={videoMaterialId === 'direct-text-portrait'}
            >
              生成竖屏视频
            </Button>
          </Space>
        </Space>
      </Card>

      <Card title="共享资料库（上传→生成音频/视频）" style={{ borderRadius: 16, borderColor: '#91d5ff' }} bodyStyle={{ background: '#f2fbff' }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="info"
            message="支持图片/视频/音频/PDF/Office/文本上传"
            description="上传后可在线查看、下载，并可一键生成音频或视频。"
          />
          <Space wrap>
            <input
              type="file"
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.markdown,.csv"
            />
            <Select
              allowClear
              placeholder="可选：绑定孩子"
              style={{ width: 180 }}
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
              value={uploadChildId}
              onChange={(v) => setUploadChildId(v)}
              options={children.map((c) => ({ label: c.name, value: c.id }))}
            />
            <Button type="primary" onClick={() => onUploadMaterial(false)} loading={uploading} disabled={uploading}>上传资料</Button>
            <Button onClick={() => onUploadMaterial(true)} loading={uploading} disabled={uploading}>一键上传并生成任务</Button>
          </Space>

          <List
            dataSource={materials}
            locale={{ emptyText: '暂无共享资料' }}
            renderItem={(item) => {
              const parsed = parseMaterialContent(item.content);
              const materialStatus = getMaterialStatusMeta(parsed.status);
              const fileHref = parsed.fileUrl ? resolveAssetUrl(parsed.fileUrl) : '';
              const isGeneratingAudio = materialBusyId === item.id && materialAction === 'audio';
              const isGeneratingVideo = materialBusyId === item.id && materialAction === 'video';
              const isAnyGenerating = materialBusyId === item.id;
              return (
                <List.Item className="material-list-item">
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <div className="material-header-row">
                      <Space wrap size={6}>
                        <Typography.Text strong>{parsed.fileName}</Typography.Text>
                        <Tag color={materialStatus.color}>{materialStatus.label}</Tag>
                        <Tag>{parsed.sourceType}</Tag>
                        {(() => {
                          const aiMeta = getAiStageMeta(parsed.recognitionStatus, parsed.mediaStatus);
                          return aiMeta ? <Tag color={aiMeta.color}>{aiMeta.label}</Tag> : null;
                        })()}
                        {item.childId ? <Tag color="blue">已绑定孩子</Tag> : <Tag>未绑定孩子</Tag>}
                        {isRecognitionLikelyTruncated(parsed.recognitionText) && <Tag color="gold">识别内容已截断</Tag>}
                      </Space>
                    </div>

                    <div className="material-meta-row">
                      <Typography.Text type="secondary">上传时间：{dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}</Typography.Text>
                    </div>

                    {!!parsed.fallbackReason && (
                      <Typography.Text type="warning">回退说明：{getFallbackReasonText(parsed.fallbackReason)}</Typography.Text>
                    )}

                    {parsed.costUsd > 0 && (
                      <Typography.Text type="secondary">本资料AI成本：${parsed.costUsd.toFixed(3)}</Typography.Text>
                    )}

                    {(parsed.audioUrl || parsed.videoUrl) && (
                      <Space wrap size={8}>
                        {parsed.audioUrl ? (
                          <Typography.Link href={resolveAssetUrl(parsed.audioUrl)} target="_blank">
                            打开专业音频
                          </Typography.Link>
                        ) : null}
                        {parsed.videoUrl ? (
                          <Typography.Link href={resolveAssetUrl(parsed.videoUrl)} target="_blank">
                            打开专业视频
                          </Typography.Link>
                        ) : null}
                      </Space>
                    )}

                    <Space wrap size={8} className="material-action-row">
                      {!!fileHref && (
                        <>
                          <Typography.Link href={fileHref} target="_blank" rel="noopener noreferrer">
                            查看文件
                          </Typography.Link>
                          <Typography.Link href={fileHref} download>
                            下载文件
                          </Typography.Link>
                        </>
                      )}
                      <Button
                        size="small"
                        type="primary"
                        loading={isGeneratingAudio}
                        disabled={isAnyGenerating}
                        onClick={() => onGenerateMaterialProduct(item.id, 'audio')}
                      >
                        生成音频
                      </Button>
                      <Button
                        size="small"
                        loading={isGeneratingVideo}
                        disabled={isAnyGenerating}
                        onClick={() => onGenerateMaterialProduct(item.id, 'video')}
                      >
                        生成视频
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
