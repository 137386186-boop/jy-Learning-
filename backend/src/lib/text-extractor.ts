import fs from 'fs';
import path from 'path';

const MAX_TEXT_LENGTH = 6000;

export type ExtractTextSource = 'text' | 'pdf' | 'docx' | 'filename';

export interface ExtractTextResult {
  text: string;
  source: ExtractTextSource;
  truncated: boolean;
}

export interface ExtractTextArgs {
  fileName: string;
  fileUrl: string;
  mimeType?: string | null;
}

function resolveUploadFilePath(fileUrl: string) {
  const relative = fileUrl.replace(/^\/+/, '');
  return path.resolve(process.cwd(), relative);
}

function normalizeAndCap(raw: string) {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const truncated = normalized.length > MAX_TEXT_LENGTH;
  return {
    text: truncated ? normalized.slice(0, MAX_TEXT_LENGTH) : normalized,
    truncated,
  };
}

function isPlainTextLike(mimeType: string, ext: string) {
  return mimeType.startsWith('text/') || ['.txt', '.md', '.markdown', '.csv'].includes(ext);
}

async function readPdfText(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  const mod = await import('pdf-parse');
  const PDFParse = (mod as { PDFParse?: typeof import('pdf-parse').PDFParse }).PDFParse
    || (mod as { default?: { PDFParse: typeof import('pdf-parse').PDFParse } }).default?.PDFParse;
  if (!PDFParse) throw new Error('pdf-parse PDFParse class not found');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function readDocxText(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  const mod = await import('mammoth');
  const extractRawText = (mod as { extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string }> }).extractRawText
    || (mod as { default?: { extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }> } }).default?.extractRawText;
  if (!extractRawText) throw new Error('mammoth extractRawText not found');
  const result = await extractRawText({ buffer: buf });
  return result.value || '';
}

export async function extractTextFromMaterial(args: ExtractTextArgs): Promise<ExtractTextResult> {
  const fileName = args.fileName || '';
  const fileUrl = args.fileUrl || '';
  const mimeType = String(args.mimeType || '').toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  // 不再把文件名当作识别正文 —— 朗读源若为 "IMG_6230" 之类的文件名会与原文无关
  // 解析失败时统一返回空文本，让前端走 "请先完成识别" 的引导
  const fallback: ExtractTextResult = {
    text: '',
    source: 'filename',
    truncated: false,
  };

  if (!fileUrl) return fallback;

  const filePath = resolveUploadFilePath(fileUrl);

  if (isPlainTextLike(mimeType, ext)) {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const { text, truncated } = normalizeAndCap(raw);
      if (text) return { text, source: 'text', truncated };
    } catch (err) {
      console.warn('[text-extractor] read text failed', err);
    }
    return fallback;
  }

  if (ext === '.pdf' || mimeType === 'application/pdf') {
    try {
      const raw = await readPdfText(filePath);
      const { text, truncated } = normalizeAndCap(raw);
      if (text) return { text, source: 'pdf', truncated };
    } catch (err) {
      console.warn('[text-extractor] pdf parse failed', err);
    }
    return fallback;
  }

  if (
    ext === '.docx'
    || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    try {
      const raw = await readDocxText(filePath);
      const { text, truncated } = normalizeAndCap(raw);
      if (text) return { text, source: 'docx', truncated };
    } catch (err) {
      console.warn('[text-extractor] docx parse failed', err);
    }
    return fallback;
  }

  return fallback;
}
