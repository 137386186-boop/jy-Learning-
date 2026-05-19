// 微软 Edge TTS 浏览器内置语音的非官方接入。
// 通过 WebSocket 与 speech.platform.bing.com 通信，返回 mp3 二进制。
// 没有官方 API 密钥要求，但请控制频率，避免被限流。
import WebSocket from 'ws';

const ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

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
    const ws = new WebSocket(ENDPOINT, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
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
