import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Card, List, Modal, Space, Switch, Tag, Typography, message } from 'antd';
import { APP_API_BASE, appFetch } from '../api.app';

interface TodayTask {
  id: string;
  title: string;
  category: string;
  difficulty: number;
  description?: string | null;
  professionalMedia?: {
    audioUrl?: string | null;
    videoUrl?: string | null;
  };
  progresses?: Array<{
    status: 'not_started' | 'in_progress' | 'submitted' | 'done';
    answerData?: Record<string, unknown> | null;
  }>;
}

interface StatusMeta {
  label: string;
  color: string;
  hint: string;
}

const STATUS_META: Record<'not_started' | 'in_progress' | 'submitted' | 'done', StatusMeta> = {
  not_started: { label: '未开始', color: 'default', hint: '先播放音频或视频开始学习' },
  in_progress: { label: '学习中', color: 'processing', hint: '继续观看/收听，学完后点“完成任务”' },
  submitted: { label: '已提交', color: 'warning', hint: '已提交，可继续复习后点“完成任务”' },
  done: { label: '已完成', color: 'success', hint: '今天这条任务已完成' },
};

const PRAISE_TEXTS = [
  '太棒了，今天又进步了一点点！',
  '完成得很好，你真是学习小达人！',
  '做得真棒，继续保持！',
  '任务完成，给你一颗小星星！',
];

interface TodayResponse {
  child: { id: string; name: string };
  list: TodayTask[];
}

interface VideoPreview {
  taskId: string;
  title: string;
  url: string;
}

interface RewardBurstItem {
  id: string;
  left: number;
  top: number;
  size: number;
  delay: number;
}

async function parseApiResponse(res: Response): Promise<Record<string, unknown> | unknown[]> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    return { error: text.slice(0, 120) || `请求失败（${res.status}）` };
  }
}

function getApiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>).error;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}

function getTaskLearningText(task: TodayTask): string {
  const title = task.title?.trim() || '今天的学习任务';
  const desc = typeof task.description === 'string' ? task.description.trim() : '';
  const cleanedDesc = desc
    .replace(/[，,;；]/g, '。')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedTitle = title.endsWith('。') ? title : `${title}。`;
  const normalizedDesc = cleanedDesc
    ? (cleanedDesc.endsWith('。') ? cleanedDesc : `${cleanedDesc}。`)
    : '';

  const guidance = '请认真听，跟读一遍，学完后点击完成任务。';
  const text = `${normalizedTitle}${normalizedDesc}${guidance}`.trim();
  return text.length > 240 ? `${text.slice(0, 240)}。学完后点击完成任务。` : text;
}

function getPraiseText(taskId: string): string {
  let hash = 0;
  for (let i = 0; i < taskId.length; i += 1) {
    hash = (hash * 31 + taskId.charCodeAt(i)) % 100000;
  }
  return PRAISE_TEXTS[hash % PRAISE_TEXTS.length];
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const list = normalized
    .split(/(?<=[。！？!?])/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : [normalized];
}

function getTaskStickerCount(task: TodayTask): number {
  const data = task.progresses?.[0]?.answerData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
  const audio = Number((data as Record<string, unknown>).audioPlayCount || 0);
  const video = Number((data as Record<string, unknown>).videoPlayCount || 0);
  const doneBonus = task.progresses?.[0]?.status === 'done' ? 2 : 0;
  return Math.max(0, audio + video + doneBonus);
}

function getTodayCombo(list: TodayTask[] | undefined): number {
  if (!list?.length) return 0;
  return list.reduce((acc, task) => {
    const data = task.progresses?.[0]?.answerData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return acc;
    const audio = Number((data as Record<string, unknown>).audioPlayCount || 0);
    const video = Number((data as Record<string, unknown>).videoPlayCount || 0);
    return acc + Math.max(0, audio + video);
  }, 0);
}

function getComboHint(combo: number): string {
  if (combo >= 12) return `🔥 超级连击 ${combo} 次，今天状态拉满！`;
  if (combo >= 6) return `⭐ 连击 ${combo} 次，保持这个节奏！`;
  if (combo >= 3) return `👏 连击 ${combo} 次，继续加油！`;
  return '';
}

function resolveMediaUrl(url: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${APP_API_BASE.replace('/api/app', '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

export default function AppChildToday() {
  const { childId } = useParams<{ childId: string }>();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TodayResponse | null>(null);
  const [errorTip, setErrorTip] = useState('');
  const [lastActionHint, setLastActionHint] = useState('');
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [speakingTaskId, setSpeakingTaskId] = useState<string | null>(null);
  const [videoTaskId, setVideoTaskId] = useState<string | null>(null);
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [rewardText, setRewardText] = useState('');
  const [rewardBursts, setRewardBursts] = useState<RewardBurstItem[]>([]);
  const [celebrateSoundEnabled, setCelebrateSoundEnabled] = useState(true);
  const rewardTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (videoPreview?.url?.startsWith('blob:')) URL.revokeObjectURL(videoPreview.url);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (rewardTimerRef.current) {
        window.clearTimeout(rewardTimerRef.current);
      }
    };
  }, [videoPreview]);

  const replaceVideoPreview = (next: VideoPreview | null) => {
    setVideoPreview((prev) => {
      if (prev?.url?.startsWith('blob:')) URL.revokeObjectURL(prev.url);
      return next;
    });
  };

  const reload = async () => {
    if (!childId) return;
    setLoading(true);
    setErrorTip('');
    try {
      const res = await appFetch(`${APP_API_BASE}/child/${childId}/today`);
      const json = await parseApiResponse(res);
      if (!res.ok) {
        const msg = json && typeof json === 'object' && typeof (json as Record<string, unknown>).error === 'string'
          ? String((json as Record<string, unknown>).error)
          : '加载失败';
        if (res.status === 403 || res.status === 404) {
          const denied = '孩子不存在或无权限查看今日任务';
          setErrorTip(denied);
          message.error(denied);
        } else {
          setErrorTip(msg);
          message.error(msg);
        }
        setData(null);
        return;
      }
      setData((json && typeof json === 'object' ? json : null) as TodayResponse | null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, [childId]);

  const showReward = (text: string) => {
    setRewardText(text);
    setRewardVisible(true);
    setRewardBursts(
      Array.from({ length: 10 }).map((_, idx) => ({
        id: `${Date.now()}-${idx}`,
        left: 12 + Math.random() * 76,
        top: 8 + Math.random() * 70,
        size: 12 + Math.random() * 14,
        delay: Math.random() * 260,
      }))
    );

    if (celebrateSoundEnabled && typeof window !== 'undefined') {
      try {
        const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
        if (Ctx) {
          const ctx = new Ctx();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = 784;
          osc.connect(gain);
          gain.connect(ctx.destination);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.26);
          osc.start();
          osc.stop(ctx.currentTime + 0.28);
        }
      } catch {
        // ignore audio failures
      }
    }

    if (rewardTimerRef.current) window.clearTimeout(rewardTimerRef.current);
    rewardTimerRef.current = window.setTimeout(() => {
      setRewardVisible(false);
    }, 2000);
  };

  const postTaskAction = async (taskId: string, action: 'start' | 'complete', silent?: boolean) => {
    if (!childId) return false;
    if (!silent && action === 'complete') {
      setCompletingTaskId(taskId);
      message.loading({ content: '正在完成任务…', key: 'child-action' });
    }

    try {
      const res = await appFetch(`${APP_API_BASE}/tasks/${taskId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId }),
      });
      const json = await parseApiResponse(res);
      if (!res.ok) {
        const errorMsg = json && typeof json === 'object' && typeof (json as Record<string, unknown>).error === 'string'
          ? String((json as Record<string, unknown>).error)
          : '操作失败';
        if (!silent) message.error({ content: errorMsg, key: 'child-action' });
        setLastActionHint(`操作失败：${errorMsg}`);
        return false;
      }
      await reload();

      if (action === 'start') {
        setLastActionHint('已进入学习状态，正在播放内容。');
      } else {
        const doneHint = getPraiseText(taskId);
        setLastActionHint(doneHint);
        showReward(doneHint);
        if (!silent) message.success({ content: doneHint, key: 'child-action' });
      }
      return true;
    } catch {
      if (!silent) message.error({ content: '网络异常，请稍后重试', key: 'child-action' });
      setLastActionHint('网络异常，请稍后重试。');
      return false;
    } finally {
      if (!silent && action === 'complete') setCompletingTaskId(null);
    }
  };

  const ensureStarted = async (task: TodayTask) => {
    const status = task.progresses?.[0]?.status || 'not_started';
    if (status === 'not_started') {
      return postTaskAction(task.id, 'start', true);
    }
    return true;
  };

  const reportLearningEvent = async (task: TodayTask, kind: 'audio' | 'video') => {
    if (!childId) return;
    try {
      const base = task.progresses?.[0]?.answerData && typeof task.progresses?.[0]?.answerData === 'object' && !Array.isArray(task.progresses?.[0]?.answerData)
        ? (task.progresses?.[0]?.answerData as Record<string, unknown>)
        : {};
      const nextAudio = Number(base.audioPlayCount || 0) + (kind === 'audio' ? 1 : 0);
      const nextVideo = Number(base.videoPlayCount || 0) + (kind === 'video' ? 1 : 0);

      const res = await appFetch(`${APP_API_BASE}/tasks/${task.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          childId,
          answerData: {
            ...base,
            audioPlayCount: nextAudio,
            videoPlayCount: nextVideo,
            lastLearnedBy: kind,
            lastLearnedAt: new Date().toISOString(),
          },
        }),
      });
      if (!res.ok) {
        const data = await parseApiResponse(res);
        setLastActionHint(`学习记录保存失败：${getApiErrorMessage(data, '请稍后重试')}`);
        return;
      }
      await reload();
    } catch {
      // no-op: learning playback should not be blocked by analytics failures
    }
  };

  const onPlayAudio = async (task: TodayTask) => {
    const professionalAudioUrl = resolveMediaUrl(String(task.professionalMedia?.audioUrl || ''));
    const ok = await ensureStarted(task);
    if (!ok) return;

    if (professionalAudioUrl) {
      setSpeakingTaskId(task.id);
      message.loading({ content: '正在播放专业音频…', key: `child-audio-${task.id}` });
      try {
        const audio = new Audio(professionalAudioUrl);
        audio.onended = () => {
          setSpeakingTaskId(null);
          void reportLearningEvent(task, 'audio');
          const praise = getPraiseText(task.id);
          setLastActionHint(praise);
          message.success({ content: `${praise}（专业音频）`, key: `child-audio-${task.id}` });
        };
        audio.onerror = () => {
          setSpeakingTaskId(null);
          message.error({ content: '专业音频播放失败，已切换本地语音', key: `child-audio-${task.id}` });
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(getTaskLearningText(task));
            utterance.lang = 'zh-CN';
            utterance.rate = 0.93;
            utterance.pitch = 1;
            utterance.onend = () => {
              void reportLearningEvent(task, 'audio');
              const praise = getPraiseText(task.id);
              setLastActionHint(praise);
              message.success({ content: praise, key: `child-audio-${task.id}` });
            };
            window.speechSynthesis.speak(utterance);
          }
        };
        await audio.play();
        return;
      } catch {
        setSpeakingTaskId(null);
        message.error({ content: '专业音频暂不可自动播放，已切换本地语音', key: `child-audio-${task.id}` });
      }
    }

    const text = getTaskLearningText(task);
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      message.error('当前浏览器不支持音频播放');
      return;
    }

    setSpeakingTaskId(task.id);
    message.loading({ content: '正在播放学习音频…', key: `child-audio-${task.id}` });

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.93;
    utterance.pitch = 1;

    utterance.onend = () => {
      setSpeakingTaskId(null);
      void reportLearningEvent(task, 'audio');
      const praise = getPraiseText(task.id);
      setLastActionHint(praise);
      message.success({ content: praise, key: `child-audio-${task.id}` });
    };
    utterance.onerror = () => {
      setSpeakingTaskId(null);
      message.error({ content: '音频播放失败，请重试', key: `child-audio-${task.id}` });
    };

    window.speechSynthesis.speak(utterance);
  };

  const onPlayVideo = async (task: TodayTask) => {
    const professionalVideoUrl = resolveMediaUrl(String(task.professionalMedia?.videoUrl || ''));
    const ok = await ensureStarted(task);
    if (!ok) return;

    if (professionalVideoUrl) {
      replaceVideoPreview({ taskId: task.id, title: `${task.title}（专业视频）`, url: professionalVideoUrl });
      void reportLearningEvent(task, 'video');
      const praise = getPraiseText(task.id);
      setLastActionHint(`${praise}（优先播放专业视频）`);
      message.success({ content: `${praise}（专业视频）`, key: `child-video-${task.id}` });
      return;
    }

    const text = getTaskLearningText(task);
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      message.error('当前浏览器不支持视频播放');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') {
      message.error('当前设备不支持视频生成');
      return;
    }

    setVideoTaskId(task.id);
    message.loading({ content: '正在生成学习视频…', key: `child-video-${task.id}` });

    try {
      const sentences = splitSentences(text);
      const lines = sentences
        .flatMap((sentence) => {
          const value = sentence.trim();
          if (!value) return [];
          const parts: string[] = [];
          for (let i = 0; i < value.length; i += 17) {
            parts.push(value.slice(i, i + 17));
          }
          return parts;
        })
        .slice(0, 30);

      const durationMs = Math.min(22000, Math.max(10000, sentences.length * 2400));
      const sentenceDuration = Math.max(1300, Math.floor(durationMs / Math.max(1, sentences.length)));
      const totalChars = Math.max(1, lines.join('').length);
      const stream = canvas.captureStream(24);
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      const startedAt = Date.now();
      let raf = 0;
      const draw = () => {
        const elapsed = Date.now() - startedAt;
        const progress = Math.min(1, elapsed / durationMs);
        const activeChar = Math.floor(progress * totalChars);
        const activeSentenceIndex = Math.min(sentences.length - 1, Math.floor(elapsed / sentenceDuration));

        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#e6f7ff');
        gradient.addColorStop(0.45, '#f9f0ff');
        gradient.addColorStop(1, '#fffbe6');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const bounce = Math.sin((elapsed / 1000) * Math.PI * 1.4) * 5;
        ctx.fillStyle = '#722ed1';
        ctx.font = 'bold 52px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText('启蒙动画课堂', 56, 86 + bounce);

        ctx.fillStyle = '#262626';
        ctx.font = 'bold 40px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(task.title || '学习任务', 56, 150);

        ctx.fillStyle = '#1677ff';
        ctx.font = 'bold 30px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText('跟着读一读：', 56, 205);

        const visibleCount = 6;
        const lineStart = Math.max(0, Math.min(activeSentenceIndex, Math.max(0, lines.length - visibleCount)));
        const visibleLines = lines.slice(lineStart, lineStart + visibleCount);

        ctx.font = 'bold 42px "PingFang SC", "Microsoft YaHei", sans-serif';
        let consumed = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length, 0);
        visibleLines.forEach((line, idx) => {
          const y = 275 + idx * 50;
          const isActive = idx === 0;
          ctx.fillStyle = isActive ? '#531dab' : '#434343';
          ctx.fillText(line, 64, y);

          const next = consumed + line.length;
          if (activeChar > consumed) {
            const inLine = Math.max(0, Math.min(line.length, activeChar - consumed));
            const highlighted = line.slice(0, inLine);
            ctx.fillStyle = '#fa8c16';
            ctx.fillText(highlighted, 64, y);
          }
          consumed = next;
        });

        ctx.fillStyle = '#d9d9d9';
        ctx.fillRect(56, 486, 848, 14);
        ctx.fillStyle = '#13c2c2';
        ctx.fillRect(56, 486, 848 * progress, 14);

        ctx.fillStyle = '#8c8c8c';
        ctx.font = '26px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillText(`第 ${activeSentenceIndex + 1} / ${Math.max(1, sentences.length)} 句`, 56, 530);

        if (elapsed < durationMs) raf = requestAnimationFrame(draw);
      };

      await new Promise<void>((resolve, reject) => {
        recorder.onerror = () => reject(new Error('video_record_error'));
        recorder.onstop = () => resolve();
        recorder.start(200);
        draw();
        window.setTimeout(() => {
          cancelAnimationFrame(raf);
          if (recorder.state !== 'inactive') recorder.stop();
          stream.getTracks().forEach((track) => track.stop());
        }, durationMs);
      });

      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      replaceVideoPreview({ taskId: task.id, title: task.title, url });
      void reportLearningEvent(task, 'video');
      const praise = getPraiseText(task.id);
      setLastActionHint(praise);
      message.success({ content: `${praise}（视频已自动播放）`, key: `child-video-${task.id}` });
      window.setTimeout(() => {
        replaceVideoPreview(null);
      }, 25000);
    } catch {
      message.error({ content: '视频生成失败，请重试', key: `child-video-${task.id}` });
    } finally {
      setVideoTaskId(null);
    }
  };

  const todayCombo = getTodayCombo(data?.list);
  const comboHint = getComboHint(todayCombo);

  return (
    <div className="app-page-shell child-today-shell">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          showIcon
          type="info"
          message="儿童端今日任务"
          description={
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {errorTip ? (
                <Typography.Text type="danger">{errorTip}</Typography.Text>
              ) : (
                <Typography.Text>
                  {lastActionHint || '点“听音频”或“看视频”开始学习，学完后点“完成任务”。'}
                </Typography.Text>
              )}
              {comboHint ? <Typography.Text strong style={{ color: '#d46b08' }}>{comboHint}</Typography.Text> : null}
            </Space>
          }
        />

        <Card size="small" className="child-status-card">
          <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
            <Typography.Text>庆祝音效</Typography.Text>
            <Switch checked={celebrateSoundEnabled} onChange={setCelebrateSoundEnabled} checkedChildren="开" unCheckedChildren="关" />
          </Space>
        </Card>

        <Modal
          open={rewardVisible}
          footer={null}
          closable={false}
          centered
          width={360}
          onCancel={() => setRewardVisible(false)}
        >
          <style>{`
            @keyframes reward-pop {
              0% { transform: scale(0.4) translateY(18px); opacity: 0; }
              25% { opacity: 1; }
              100% { transform: scale(1.15) translateY(-22px); opacity: 0; }
            }
          `}</style>
          <Space direction="vertical" align="center" style={{ width: '100%', padding: '12px 0', position: 'relative' }}>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                background: 'linear-gradient(180deg, #ffd666 0%, #faad14 100%)',
                boxShadow: '0 8px 18px rgba(250, 173, 20, 0.35)',
              }}
            />
            {rewardBursts.map((dot) => (
              <span
                key={dot.id}
                style={{
                  position: 'absolute',
                  left: `${dot.left}%`,
                  top: `${dot.top}%`,
                  width: dot.size,
                  height: dot.size,
                  borderRadius: '50%',
                  background: '#ffd666',
                  animation: `reward-pop 920ms ease-out ${dot.delay}ms forwards`,
                  pointerEvents: 'none',
                }}
              />
            ))}
            <Typography.Title level={3} style={{ margin: 0 }}>任务完成</Typography.Title>
            <Typography.Text style={{ fontSize: 18 }}>{rewardText || '你真棒！'}</Typography.Text>
          </Space>
        </Modal>

        {videoPreview && (
          <Card
            className="app-child-card"
            title={`正在播放：${videoPreview.title || '学习视频'}`}
            extra={<Button size="small" onClick={() => replaceVideoPreview(null)}>关闭视频</Button>}
            bodyStyle={{ background: '#f6ffed' }}
          >
            <video
              src={videoPreview.url}
              controls
              autoPlay
              onEnded={() => {
                const praise = getPraiseText(videoPreview.taskId);
                setLastActionHint(praise);
                message.success(praise);
                replaceVideoPreview(null);
              }}
              style={{ width: '100%', maxHeight: 420, borderRadius: 12, background: '#000' }}
            />
          </Card>
        )}

        <Card
          className="app-child-card child-status-card"
          title={data ? `${data.child.name} 的今日任务` : '今日任务'}
          loading={loading}
          bodyStyle={{ background: '#fffdf7' }}
        >
          <List
            className="child-task-list"
            dataSource={data?.list || []}
            locale={{ emptyText: '今天暂无任务' }}
            renderItem={(item) => {
              const status = item.progresses?.[0]?.status || 'not_started';
              const statusMeta = STATUS_META[status as keyof typeof STATUS_META] || STATUS_META.not_started;
              return (
                <List.Item>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <Space wrap>
                      <Typography.Text strong className="child-task-title">{item.title}</Typography.Text>
                      <Tag color="blue" style={{ fontSize: 14, padding: '2px 8px' }}>{item.category}</Tag>
                      <Tag style={{ fontSize: 14, padding: '2px 8px' }}>{`难度 ${item.difficulty}`}</Tag>
                      <Tag color={statusMeta.color} style={{ fontSize: 14, padding: '2px 8px' }}>{statusMeta.label}</Tag>
                    </Space>

                    <Space wrap size={8}>
                      <Typography.Text style={{ fontSize: 16 }}>今日贴纸：</Typography.Text>
                      {Array.from({ length: Math.max(1, Math.min(8, getTaskStickerCount(item) || 1)) }).map((_, idx) => (
                        <span
                          key={`${item.id}-sticker-${idx}`}
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            display: 'inline-block',
                            border: '2px solid #d9d9d9',
                            background: idx < getTaskStickerCount(item) ? '#ffd666' : '#f5f5f5',
                          }}
                        />
                      ))}
                      <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                        {getTaskStickerCount(item) > 0 ? `已收集 ${getTaskStickerCount(item)} 枚` : '播放音频/视频即可解锁贴纸'}
                      </Typography.Text>
                    </Space>

                    <Typography.Text type="secondary" style={{ fontSize: 16 }}>
                      当前建议：{statusMeta.hint}
                    </Typography.Text>

                    <Space wrap size={12}>
                      <Button
                        key="audio"
                        size="large"
                        className="child-action-btn"
                        loading={speakingTaskId === item.id}
                        disabled={videoTaskId === item.id || completingTaskId === item.id}
                        onClick={() => onPlayAudio(item)}
                      >
                        听音频
                      </Button>
                      <Button
                        key="video"
                        type="primary"
                        ghost
                        size="large"
                        className="child-action-btn"
                        loading={videoTaskId === item.id}
                        disabled={speakingTaskId === item.id || completingTaskId === item.id}
                        onClick={() => onPlayVideo(item)}
                      >
                        看视频
                      </Button>
                      <Button
                        key="done"
                        type="primary"
                        size="large"
                        className="child-action-btn primary"
                        loading={completingTaskId === item.id}
                        disabled={status === 'done' || speakingTaskId === item.id || videoTaskId === item.id}
                        onClick={() => postTaskAction(item.id, 'complete')}
                      >
                        完成任务
                      </Button>
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      </Space>
    </div>
  );
}
