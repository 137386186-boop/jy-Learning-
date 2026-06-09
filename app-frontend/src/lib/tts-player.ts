import { APP_API_BASE, appFetch } from '../api.app';

export interface TtsPlayerOptions {
  text: string;
  rate?: string;
  playbackRate?: number;
  onStart?: (segmentIdx: number, totalSegments: number) => void;
  onSegment?: (segmentIdx: number, totalSegments: number) => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onSegmentSkip?: (segmentIdx: number, reason: string) => void;
}

export interface TtsPlayerHandle {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setPlaybackRate: (rate: number) => void;
}

const SEGMENT_MAX = 200;

function splitIntoSegments(content: string): string[] {
  const sentences = content
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const segments: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (s.length > SEGMENT_MAX) {
      if (buf) { segments.push(buf); buf = ''; }
      const subs = s.split(/(?<=[，、,])/);
      let sb = '';
      for (const sub of subs) {
        if ((sb + sub).length > SEGMENT_MAX) {
          if (sb) segments.push(sb);
          if (sub.length > SEGMENT_MAX) {
            for (let i = 0; i < sub.length; i += SEGMENT_MAX) segments.push(sub.slice(i, i + SEGMENT_MAX));
            sb = '';
          } else {
            sb = sub;
          }
        } else {
          sb += sub;
        }
      }
      if (sb) segments.push(sb);
    } else if ((buf + s).length > SEGMENT_MAX) {
      if (buf) segments.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) segments.push(buf);
  if (!segments.length) segments.push(content);
  return segments;
}

function describeError(errCode: string, status: number): string {
  const isUpstream403 = /403/.test(errCode) || /Unexpected server response/i.test(errCode);
  if (errCode === 'tts_rate_limited') return '朗读请求过于频繁，请稍后再试';
  if (errCode === 'tts_text_too_long') return '段落过长，已跳过';
  if (errCode === 'tts_empty_text') return '段落为空，已跳过';
  if (isUpstream403 || status === 502 || status === 403) {
    return `语音服务暂时不可用（HTTP ${status}${errCode ? ' / ' + errCode : ''}）`;
  }
  return errCode || `HTTP ${status}`;
}

/**
 * Segment-streaming TTS player. Mirrors AppLearning.onPlayMaterialAudio:
 * 切句、合并 ≤200 字、复用同一个 <audio> 元素切 src（消除段间咔哒）、
 * 每段独立 /tts、并发预取后 2 段。专治移动端 SpeechSynthesis 15s 截断和
 * /tts/long 的 mp3 帧拼接 click。
 */
export function startTtsPlayer(opts: TtsPlayerOptions): TtsPlayerHandle {
  const content = (opts.text || '').trim();
  if (!content) {
    opts.onError?.('empty');
    return { pause: () => {}, resume: () => {}, stop: () => {}, setPlaybackRate: () => {} };
  }
  const segments = splitIntoSegments(content);
  const rate = opts.rate ?? '-4%';

  type Slot = { url: string; fetching: boolean; failed: boolean; failedCode?: string };
  const slots: Slot[] = segments.map(() => ({ url: '', fetching: false, failed: false }));

  let stopped = false;
  let currentRate = opts.playbackRate ?? 1;
  const sharedAudio = new Audio();
  sharedAudio.preload = 'auto';
  sharedAudio.playbackRate = currentRate;

  const revokeSlot = (i: number) => {
    const s = slots[i];
    if (s?.url) {
      try { URL.revokeObjectURL(s.url); } catch { /* ignore */ }
      s.url = '';
    }
  };

  const teardown = () => {
    try { sharedAudio.pause(); } catch { /* ignore */ }
    sharedAudio.onended = null;
    sharedAudio.onerror = null;
    try { sharedAudio.removeAttribute('src'); sharedAudio.load(); } catch { /* ignore */ }
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    teardown();
    for (let i = 0; i < slots.length; i++) revokeSlot(i);
  };

  const fetchSegment = async (idx: number): Promise<void> => {
    if (idx < 0 || idx >= segments.length) return;
    const slot = slots[idx];
    if (!slot || slot.url || slot.fetching || slot.failed) return;
    slot.fetching = true;
    try {
      const resp = await appFetch(`${APP_API_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: segments[idx], rate }),
      });
      if (stopped) return;
      if (!resp.ok) {
        let errCode = '';
        try { const j = await resp.json(); errCode = String(j?.error || ''); } catch { /* ignore */ }
        slot.failed = true;
        slot.failedCode = describeError(errCode, resp.status);
        return;
      }
      const blob = await resp.blob();
      if (stopped) return;
      slot.url = URL.createObjectURL(blob);
    } catch (err) {
      if (stopped) return;
      slot.failed = true;
      slot.failedCode = err instanceof Error ? err.message : String(err);
    } finally {
      slot.fetching = false;
    }
  };

  const waitForSlot = async (idx: number): Promise<Slot | null> => {
    if (idx < 0 || idx >= segments.length) return null;
    void fetchSegment(idx);
    void fetchSegment(idx + 1);
    void fetchSegment(idx + 2);
    const start = Date.now();
    while (!stopped) {
      const slot = slots[idx];
      if (slot.url || slot.failed) return slot;
      if (Date.now() - start > 30000) {
        slot.failed = true;
        slot.failedCode = '合成超时';
        return slot;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    return null;
  };

  const playSegment = async (idx: number): Promise<void> => {
    if (stopped) return;
    if (idx >= segments.length) {
      cleanup();
      opts.onEnded?.();
      return;
    }
    opts.onSegment?.(idx, segments.length);
    const slot = await waitForSlot(idx);
    if (stopped || !slot) return;
    if (slot.failed || !slot.url) {
      if (slot.failedCode) opts.onSegmentSkip?.(idx, slot.failedCode);
      revokeSlot(idx);
      void playSegment(idx + 1);
      return;
    }
    sharedAudio.onerror = () => {
      opts.onSegmentSkip?.(idx, 'play_failed');
      revokeSlot(idx);
      void playSegment(idx + 1);
    };
    sharedAudio.onended = () => {
      revokeSlot(idx);
      void playSegment(idx + 1);
    };
    sharedAudio.src = slot.url;
    sharedAudio.playbackRate = currentRate;
    try {
      await sharedAudio.play();
      if (idx === 0) opts.onStart?.(0, segments.length);
    } catch (err) {
      if (stopped) return;
      opts.onError?.(err instanceof Error ? err.message : String(err));
      cleanup();
    }
  };

  void playSegment(0);

  return {
    pause: () => { try { sharedAudio.pause(); } catch { /* ignore */ } },
    resume: () => { try { sharedAudio.play().catch(() => {}); } catch { /* ignore */ } },
    stop: () => { cleanup(); },
    setPlaybackRate: (r: number) => {
      currentRate = Math.max(0.5, Math.min(2.0, r));
      sharedAudio.playbackRate = currentRate;
    },
  };
}
