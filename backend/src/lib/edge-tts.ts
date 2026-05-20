// 微软 Edge TTS 浏览器内置语音的非官方接入。
// 通过 WebSocket 与 speech.platform.bing.com 通信，返回 mp3 二进制。
// 没有官方 API 密钥要求，但请控制频率，避免被限流。
import WebSocket from 'ws';
import { createHash } from 'crypto';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// 微软在 2024 年开始要求 Sec-MS-GEC 时间签名；不带就 403。
// 算法：Windows 文件时间 ticks = (unix秒 + 11644473600) * 1e7，按 5 分钟向下取整后与 token 拼接做 SHA-256 大写。
const WIN_EPOCH = 11644473600n;
const FIVE_MIN_TICKS = 3_000_000_000n; // 5 min * 60 s * 1e7 ticks/s
// 与 rany2/edge-tts 上游保持同步；版本落后会触发 403。
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const CHROMIUM_FULL_VERSION = '143.0.0.0';

// 客户端时钟与服务器时间偏差（秒）。403 时通过 Date 头自愈。
let clockSkewSeconds = 0;

function generateSecMsGec(): string {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000) + clockSkewSeconds);
  const ticks = (nowSeconds + WIN_EPOCH) * 10_000_000n;
  const rounded = ticks - (ticks % FIVE_MIN_TICKS);
  return createHash('sha256')
    .update(`${rounded.toString()}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
}

function adjustClockSkewFromServerDate(serverDateHeader: string | undefined): boolean {
  if (!serverDateHeader) return false;
  const serverMs = Date.parse(serverDateHeader);
  if (Number.isNaN(serverMs)) return false;
  clockSkewSeconds = Math.floor((serverMs - Date.now()) / 1000);
  return true;
}

function buildEndpoint(connectionId: string): string {
  const secMsGec = generateSecMsGec();
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}&ConnectionId=${connectionId}`;
}

export interface EdgeTtsOptions {
  voice?: string; // e.g. zh-CN-YunxiNeural
  rate?: string; // e.g. "+0%", "-10%"
  pitch?: string; // e.g. "+0Hz"
  volume?: string; // e.g. "+0%"
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text: string, opts: Required<EdgeTtsOptions>): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="${opts.voice}"><prosody rate="${opts.rate}" pitch="${opts.pitch}" volume="${opts.volume}">${escapeXml(text)}</prosody></voice></speak>`;
}

function uuid(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function synthesizeEdgeTts(
  text: string,
  options: EdgeTtsOptions = {}
): Promise<Buffer> {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('tts_empty_text');
  if (trimmed.length > 2400) throw new Error('tts_text_too_long');

  const opts: Required<EdgeTtsOptions> = {
    voice: options.voice || 'zh-CN-YunxiNeural',
    rate: options.rate || '-4%',
    pitch: options.pitch || '+0Hz',
    volume: options.volume || '+0%',
  };

  try {
    return await synthOnce(trimmed, opts);
  } catch (err) {
    const e = err as Error & { statusCode?: number; serverDate?: string };
    // 403 通常意味着时间签名过期或客户端时钟漂移。读取服务端 Date 头矫正后重试一次。
    if (e?.statusCode === 403 && adjustClockSkewFromServerDate(e.serverDate)) {
      return synthOnce(trimmed, opts);
    }
    throw err;
  }
}

function synthOnce(
  trimmed: string,
  opts: Required<EdgeTtsOptions>
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const reqId = uuid().replace(/-/g, '').toUpperCase();
    const ws = new WebSocket(buildEndpoint(reqId), {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-WebSocket-Version': '13',
        'User-Agent':
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
      },
    });

    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(err);
    };
    const ok = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(buf);
    };

    const timer = setTimeout(() => fail(new Error('tts_timeout')), 30000);

    // 握手 403/426 等失败时拿到 status + Date 头，便于自愈
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      const statusCode = res.statusCode || 0;
      const serverDate = (res.headers?.date as string | undefined) || undefined;
      const err = new Error(`tts_unexpected_response_${statusCode}`) as Error & {
        statusCode?: number;
        serverDate?: string;
      };
      err.statusCode = statusCode;
      err.serverDate = serverDate;
      res.resume(); // 消费 body 避免 socket 挂起
      fail(err);
    });

    ws.on('open', () => {
      const ts = new Date().toString();
      const configMsg =
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
      ws.send(configMsg);

      const ssmlMsg =
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        buildSsml(trimmed, opts);
      ws.send(ssmlMsg);
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary && Buffer.isBuffer(data)) {
        // Edge TTS 二进制帧前 2 字节是大端头长度，剩下的是头部 + 音频数据
        const buf = data as Buffer;
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        if (buf.length < 2 + headerLen) return;
        const payload = buf.subarray(2 + headerLen);
        if (payload.length > 0) chunks.push(payload);
        return;
      }
      const msg = data.toString();
      if (msg.includes('Path:turn.end')) {
        clearTimeout(timer);
        if (!chunks.length) {
          fail(new Error('tts_empty_audio'));
          return;
        }
        ok(Buffer.concat(chunks));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        if (chunks.length) ok(Buffer.concat(chunks));
        else fail(new Error('tts_closed_without_audio'));
      }
    });
  });
}
