// 客户端中文 OCR：懒加载 tesseract.js，避免影响首屏体积
// 使用方式：const text = await recognizeImageText(file, onProgress)

let workerPromise: Promise<{ worker: unknown; recognize: (file: File | Blob) => Promise<string> }> | null = null;

export interface OcrProgress {
  stage: 'preprocess' | 'loading_model' | 'recognizing' | 'done';
  percent: number; // 0..100
}

// 把过大的手机相册图片缩到合理尺寸 + 灰度化，极大降低识别耗时并提高中文识别准确率
const MAX_EDGE = 1600;

// 在整张图里找鲜亮黄色高亮（边框或填色）的最小外接矩形
// 用户的典型场景：课本/绘本上正文被标黄圈起来；OCR 只想读圈内的字
function detectYellowBoundingBox(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const W = canvas.width;
  const H = canvas.height;
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, W, H); } catch { return null; }
  const px = data.data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  // 大图采样步长，避免阻塞主线程
  const step = Math.max(1, Math.round(Math.min(W, H) / 800));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const idx = (y * W + x) * 4;
      const r = px[idx];
      const g = px[idx + 1];
      const b = px[idx + 2];
      // 鲜亮黄：红绿都高、蓝低、红绿接近
      if (r > 200 && g > 170 && b < 140 && r - b > 80 && Math.abs(r - g) < 60) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || count < 40) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  // 太小（零散噪声）或几乎占满整图（误判）都跳过
  if (w < W * 0.15 || h < H * 0.1) return null;
  if (w > W * 0.97 && h > H * 0.97) return null;
  // 向内收一点像素，避免把黄色边框本身带进 OCR
  const inset = Math.round(Math.min(w, h) * 0.02);
  return {
    x: Math.max(0, minX + inset),
    y: Math.max(0, minY + inset),
    w: Math.max(1, w - inset * 2),
    h: Math.max(1, h - inset * 2),
  };
}

async function preprocessImage(file: File | Blob): Promise<Blob> {
  if (typeof window === 'undefined') return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image load failed'));
      im.src = url;
    });
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return file;

    // Step 1：原尺寸画一遍，用来找黄色高亮区域
    const detectCanvas = document.createElement('canvas');
    detectCanvas.width = w0;
    detectCanvas.height = h0;
    const detectCtx = detectCanvas.getContext('2d');
    if (!detectCtx) return file;
    detectCtx.drawImage(img, 0, 0, w0, h0);

    const bbox = detectYellowBoundingBox(detectCanvas);
    const srcX = bbox?.x ?? 0;
    const srcY = bbox?.y ?? 0;
    const srcW = bbox?.w ?? w0;
    const srcH = bbox?.h ?? h0;

    // Step 2：把目标区域缩放到 MAX_EDGE 之内
    const longest = Math.max(srcW, srcH);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(detectCanvas, srcX, srcY, srcW, srcH, 0, 0, w, h);

    // Step 3：灰度 + 轻度对比度增强，对手机拍摄的文档/课本特别有效
    try {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        // 简单 S 曲线增强对比度
        const v = y < 128 ? Math.max(0, y - 12) : Math.min(255, y + 12);
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      ctx.putImageData(data, 0, 0);
    } catch {
      // ignore preprocessing failure, use raw resized canvas
    }
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
    });
    if (!blob) return file;
    return blob;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function getWorker(onProgress?: (p: OcrProgress) => void) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    onProgress?.({ stage: 'loading_model', percent: 5 });
    const mod = await import('tesseract.js');
    const createWorker = (mod as unknown as { createWorker: (lang?: string | string[], oem?: number, opts?: Record<string, unknown>) => Promise<unknown> }).createWorker;
    // 加载中文简体 + 英文（封面/标签常混排）
    const worker = await createWorker(['chi_sim', 'eng'], 1, {
      logger: (m: { status?: string; progress?: number }) => {
        if (!onProgress) return;
        const p = typeof m.progress === 'number' ? m.progress : 0;
        if (m.status === 'recognizing text') {
          onProgress({ stage: 'recognizing', percent: 60 + Math.round(p * 35) });
        } else {
          onProgress({ stage: 'loading_model', percent: 10 + Math.round(p * 45) });
        }
      },
    });
    const recognize = async (file: File | Blob): Promise<string> => {
      const url = URL.createObjectURL(file);
      try {
        const res = await (worker as { recognize: (img: string) => Promise<{ data: { text: string } }> }).recognize(url);
        return res?.data?.text || '';
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    return { worker, recognize };
  })();
  return workerPromise;
}

export async function recognizeImageText(
  file: File | Blob,
  onProgress?: (p: OcrProgress) => void
): Promise<string> {
  onProgress?.({ stage: 'preprocess', percent: 2 });
  const prepared = await preprocessImage(file);
  const { recognize } = await getWorker(onProgress);
  onProgress?.({ stage: 'recognizing', percent: 60 });
  const raw = await recognize(prepared);
  onProgress?.({ stage: 'done', percent: 100 });
  // 简单清洗：合并多余空白、去掉孤立标点散行
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function isLikelyImage(file: File | Blob | null | undefined): boolean {
  if (!file) return false;
  const type = (file as File).type || '';
  return type.startsWith('image/');
}

// 过滤 OCR 乱码：拍课本/题卡时 Tesseract 经常返回大量非中文非英文的"噪声字符"
// 策略：按行评估，单行中"有效字符"（中文/英文/数字/常见标点）占比 < 60% 或有效字符 < 2 时丢弃
const VALID_CHAR_RE = /[一-鿿㐀-䶿A-Za-z0-9\s，。？！、：；""''《》（）()【】\-+=×÷./%]/;

function lineSignalRatio(line: string): { ratio: number; valid: number } {
  const trimmed = line.trim();
  if (!trimmed) return { ratio: 0, valid: 0 };
  let valid = 0;
  for (const ch of trimmed) {
    if (VALID_CHAR_RE.test(ch)) valid += 1;
  }
  return { ratio: valid / trimmed.length, valid };
}

const CJK_RE = /[一-鿿]/;

// 行首是英文/字母数字"小尾巴"（页码 / 水印 / 章节英文标题）时剥掉。
// 仅当首段是纯字母/空白/常见分隔符时剥离；保留 "5. 这是第五题" 这种中文式序号
const LEADING_ASCII_HEAD_RE = /^[A-Za-z][A-Za-z0-9\s.,\-:;'"·•_/()]*(?=[一-鿿])/;

export function sanitizeOcrText(raw: string): string {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const { ratio, valid } = lineSignalRatio(line);
    if (ratio >= 0.6 && valid >= 2) kept.push(line.trim());
  }
  // 中文上下文优先：拍课本/绘本时，页码 / 英文水印 / 版权页几乎都不含中文。
  // 如果识别结果整体有中文，就把不含中文的行视为噪声丢掉；
  // 再把"行首夹带英文水印 / 章节英文小标题"剥掉，
  // 避免 Yunxi 中文音色把这些 ASCII 字母按拼音念一遍，造成"前面一段听不懂"。
  const hasAnyChinese = kept.some((line) => CJK_RE.test(line));
  const filtered = hasAnyChinese
    ? kept
        .filter((line) => CJK_RE.test(line))
        .map((line) => line.replace(LEADING_ASCII_HEAD_RE, '').trim())
        .filter(Boolean)
    : kept;
  const out = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 整体再检查一次：如果全文有效中文/英文字符过少（<4），视为无识别结果
  let totalValid = 0;
  for (const ch of out) if (VALID_CHAR_RE.test(ch)) totalValid += 1;
  if (totalValid < 4) return '';
  return out;
}
