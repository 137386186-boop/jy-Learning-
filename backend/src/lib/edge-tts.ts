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
const SEC_MS_GEC_VERSION = '1-130.0.2849.68';

function generateSecMsGec(): string {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const ticks = (nowSeconds + WIN_EPOCH) * 10_000_000n;
  const rounded = ticks - (ticks % FIVE_MIN_TICKS);
  return createHash('sha256')
    .update(`${rounded.toString()}${TRUSTED_CLIENT_TOKEN}`)
    .digest('hex')
    .toUpperCase();
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

  return new Promise<Buffer>((resolve, reject) => {
    const reqId = uuid().replace(/-/g, '').toUpperCase();
    const ws = new WebSocket(buildEndpoint(reqId), {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
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
