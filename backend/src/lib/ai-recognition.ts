import fs from 'fs';
import path from 'path';
import { checkAndRecordBudget } from './cost-guardrails';

export interface RecognitionInput {
  parentId: string;
  fileName: string;
  fileUrl: string;
  sourceType: string;
  mimeType?: string | null;
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
}

function isAiRecognitionEnabled(): boolean {
  const global = String(process.env.APP_AI_ENABLED || 'false').toLowerCase() === 'true';
  const local = String(process.env.APP_AI_DEEP_RECOGNITION_ENABLED || 'false').toLowerCase() === 'true';
  return global && local;
}

function detectTextFromFilename(fileName: string) {
  const base = path.basename(fileName, path.extname(fileName));
  return base.replace(/[_-]+/g, ' ').trim();
}

function resolveUploadFilePath(fileUrl: string) {
  const relative = fileUrl.replace(/^\/+/, '');
  return path.resolve(process.cwd(), relative);
}

function detectTextFromMaterialContent(fileName: string, fileUrl: string, mimeType?: string | null) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  if (!fileUrl) return detectTextFromFilename(fileName);

  const canReadAsText = mime.startsWith('text/') || ['.txt', '.md', '.markdown', '.csv'].includes(ext);
  if (!canReadAsText) return detectTextFromFilename(fileName);

  try {
    const raw = fs.readFileSync(resolveUploadFilePath(fileUrl), 'utf-8');
    const normalized = raw.replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.slice(0, 2400);
  } catch {
    // ignore fallback
  }

  return detectTextFromFilename(fileName);
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

function buildFallbackResult(input: RecognitionInput): RecognitionResult {
  const extractedText = detectTextFromMaterialContent(input.fileName, input.fileUrl, input.mimeType);
  return {
    sourceType: input.sourceType,
    extractedText,
    suggestedCategory: inferCategory(input.sourceType, extractedText),
    suggestedDifficulty: inferDifficulty(extractedText),
    recognizedAt: new Date().toISOString(),
    provider: 'rule',
    model: 'local-rule-v1',
    confidence: 0.65,
    keywords: extractKeywords(extractedText),
  };
}

function buildMockAiResult(input: RecognitionInput): RecognitionResult {
  const raw = detectTextFromMaterialContent(input.fileName, input.fileUrl, input.mimeType);
  const extractedText = raw.length > 1200 ? raw.slice(0, 1200) : raw;
  return {
    sourceType: input.sourceType,
    extractedText,
    suggestedCategory: inferCategory(input.sourceType, extractedText),
    suggestedDifficulty: inferDifficulty(extractedText),
    recognizedAt: new Date().toISOString(),
    provider: 'mock-ai',
    model: process.env.APP_AI_RECOGNITION_MODEL || 'mock-deep-recognition-v1',
    confidence: 0.84,
    keywords: extractKeywords(extractedText),
  };
}

export async function recognizeMaterial(input: RecognitionInput): Promise<RecognitionOutput> {
  if (!isAiRecognitionEnabled()) {
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: buildFallbackResult(input),
      fallbackReason: 'ai_recognition_disabled',
      costUsd: 0,
    };
  }

  const estimatedCostUsd = 0.02;
  const budget = await checkAndRecordBudget('recognition', {
    parentId: input.parentId,
    estimatedCostUsd,
  });

  if (!budget.allowed) {
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: buildFallbackResult(input),
      fallbackReason: budget.reason || 'budget_guardrail_blocked',
      costUsd: 0,
    };
  }

  try {
    return {
      status: 'recognized',
      recognitionStatus: 'completed',
      result: buildMockAiResult(input),
      fallbackReason: null,
      costUsd: estimatedCostUsd,
    };
  } catch {
    return {
      status: 'fallback_recognized',
      recognitionStatus: 'fallback',
      result: buildFallbackResult(input),
      fallbackReason: 'ai_recognition_failed',
      costUsd: 0,
    };
  }
}
