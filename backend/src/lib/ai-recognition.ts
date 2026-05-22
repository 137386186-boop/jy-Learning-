import { checkAndRecordBudget } from './cost-guardrails';
import { extractTextFromMaterial, type ExtractTextSource } from './text-extractor';

export interface RecognitionInput {
  parentId: string;
  fileName: string;
  fileUrl: string;
  sourceType: string;
  mimeType?: string | null;
  // 客户端已经做过的 OCR 正文（图片场景：识别图里被黄色框出来的正文）
  // 若提供且非空，识别阶段会优先采用它，避免把文件名当成正文
  clientOcrText?: string | null;
}

export interface RecognitionResult {
  sourceType: string;
  extractedText: string;
  suggestedCategory: string;
  suggestedDifficulty: number;
  recognizedAt: string;
  provider: 'rule' | 'mock-ai';
  model: string;
  confidence: number;
  keywords: string[];
}

export interface RecognitionOutput {
  status: 'recognized' | 'fallback_recognized';
  recognitionStatus: 'completed' | 'fallback';
  result: RecognitionResult;
  fallbackReason: string | null;
  costUsd: number;
  textSource: ExtractTextSource;
}

function isAiRecognitionEnabled(): boolean {
  const global = String(process.env.APP_AI_ENABLED || 'false').toLowerCase() === 'true';
  const local = String(process.env.APP_AI_DEEP_RECOGNITION_ENABLED || 'false').toLowerCase() === 'true';
  return global && local;
}

async function detectTextFromMaterialContent(
  fileName: string,
  fileUrl: string,
  mimeType?: string | null,
): Promise<{ text: string; source: ExtractTextSource }> {
  const out = await extractTextFromMaterial({ fileName, fileUrl, mimeType });
  return { text: out.text, source: out.source };
}

function inferCategory(sourceType: string, text: string) {
  const normalized = text.toLowerCase();
  if (sourceType === 'audio') return '英语';
  if (sourceType === 'video') return '社会科学';
  if (/[0-9一二三四五六七八九十+\-*/=几多少]/.test(normalized)) return '数学';
  if (/[a-z]{3,}/.test(normalized)) return '英语';
  if (/[历史|地理|科学|自然|社会]/.test(text)) return '社会科学';
  return '语文';
}

function inferDifficulty(text: string) {
  const len = text.length;
  if (len > 700) return 3;
  if (len > 240) return 2;
  return 1;
}

function extractKeywords(text: string): string[] {
  const cleaned = text
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
  if (!cleaned) return [];
  const chunks = cleaned.split(' ').filter(Boolean);
  const top = chunks
    .filter((x) => x.length >= 2)
    .slice(0, 8)
    .map((x) => x.slice(0, 10));
  return Array.from(new Set(top));
}

function pickClientOcr(input: RecognitionInput): string {
  if (input.sourceType !== 'image') return '';
  const raw = typeof input.clientOcrText === 'string' ? input.clientOcrText.trim() : '';
  return raw;
}

async function resolveExtractedText(
  input: RecognitionInput,
): Promise<{ text: string; source: ExtractTextSource }> {
  const clientOcr = pickClientOcr(input);
  if (clientOcr) {
    // 客户端 OCR 命中：直接当作正文使用，跳过文件名兜底
    return { text: clientOcr, source: 'text' };
  }
  return detectTextFromMaterialContent(input.fileName, input.fileUrl, input.mimeType);
}

async function buildFallbackResult(
  input: RecognitionInput,
): Promise<{ result: RecognitionResult; textSource: ExtractTextSource }> {
  const { text: extractedText, source } = await resolveExtractedText(input);
  return {
    result: {
      sourceType: input.sourceType,
      extractedText,
      suggestedCategory: inferCategory(input.sourceType, extractedText),
      suggestedDifficulty: inferDifficulty(extractedText),
      recognizedAt: new Date().toISOString(),
      provider: 'rule',
      model: 'local-rule-v1',
      confidence: 0.65,
      keywords: extractKeywords(extractedText),
    },
    textSource: source,
  };
}

async function buildMockAiResult(
  input: RecognitionInput,
): Promise<{ result: RecognitionResult; textSource: ExtractTextSource }> {
  const { text: raw, source } = await resolveExtractedText(input);
  const extractedText = raw.length > 1200 ? raw.slice(0, 1200) : raw;
  return {
    result: {
      sourceType: input.sourceType,
      extractedText,
      suggestedCategory: inferCategory(input.sourceType, extractedText),
      suggestedDifficulty: inferDifficulty(extractedText),
      recognizedAt: new Date().toISOString(),
      provider: 'mock-ai',
      model: process.env.APP_AI_RECOGNITION_MODEL || 'mock-deep-recognition-v1',
      confidence: 0.84,
      keywords: extractKeywords(extractedText),
    },
    textSource: source,
  };
}

export async function recognizeMaterial(input: RecognitionInput): Promise<RecognitionOutput> {
  if (!isAiRecognitionEnabled()) {
    const built = await buildFallbackResult(input);
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: built.result,
      fallbackReason: 'ai_recognition_disabled',
      costUsd: 0,
      textSource: built.textSource,
    };
  }

  const estimatedCostUsd = 0.02;
  const budget = await checkAndRecordBudget('recognition', {
    parentId: input.parentId,
    estimatedCostUsd,
  });

  if (!budget.allowed) {
    const built = await buildFallbackResult(input);
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: built.result,
      fallbackReason: budget.reason || 'budget_guardrail_blocked',
      costUsd: 0,
      textSource: built.textSource,
    };
  }

  try {
    const built = await buildMockAiResult(input);
    return {
      status: 'recognized',
      recognitionStatus: 'completed',
      result: built.result,
      fallbackReason: null,
      costUsd: estimatedCostUsd,
      textSource: built.textSource,
    };
  } catch {
    const built = await buildFallbackResult(input);
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: built.result,
      fallbackReason: 'ai_recognition_failed',
      costUsd: 0,
      textSource: built.textSource,
    };
  }
}
