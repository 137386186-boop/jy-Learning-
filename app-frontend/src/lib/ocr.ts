// 客户端中文 OCR：懒加载 tesseract.js，避免影响首屏体积
// 使用方式：const text = await recognizeImageText(file, onProgress)

let workerPromise: Promise<{ worker: unknown; recognize: (file: File | Blob) => Promise<string> }> | null = null;

export interface OcrProgress {
  stage: 'loading_model' | 'recognizing' | 'done';
  percent: number; // 0..100
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
  const { recognize } = await getWorker(onProgress);
  onProgress?.({ stage: 'recognizing', percent: 60 });
  const raw = await recognize(file);
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
