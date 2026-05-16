// 客户端中文 OCR：懒加载 tesseract.js，避免影响首屏体积
// 使用方式：const text = await recognizeImageText(file, onProgress)

let workerPromise: Promise<{ worker: unknown; recognize: (file: File | Blob) => Promise<string> }> | null = null;

export interface OcrProgress {
  stage: 'preprocess' | 'loading_model' | 'recognizing' | 'done';
  percent: number; // 0..100
}

// 把过大的手机相册图片缩到合理尺寸 + 灰度化，极大降低识别耗时并提高中文识别准确率
const MAX_EDGE = 1600;

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
    const longest = Math.max(w0, h0);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    // 灰度 + 轻度对比度增强，对手机拍摄的文档/课本特别有效
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
