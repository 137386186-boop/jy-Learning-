import { checkAndRecordBudget } from './cost-guardrails';

export interface MediaGenerationInput {
  parentId: string;
  materialId: string;
  title: string;
  sourceType: string;
  fileUrl?: string | null;
  recognitionText: string;
  category: string;
  difficulty: number;
}

export interface MediaOutputItem {
  kind: 'audio' | 'video';
  url: string;
  format: string;
  durationSec: number;
  provider: 'native-source' | 'mock-ai';
}

export interface MediaGenerationOutput {
  mediaStatus: 'completed' | 'fallback';
  outputs: MediaOutputItem[];
  script: string;
  fallbackReason: string | null;
  costUsd: number;
}

function isMediaGenerationEnabled(): boolean {
  const global = String(process.env.APP_AI_ENABLED || 'false').toLowerCase() === 'true';
  const local = String(process.env.APP_AI_MEDIA_GEN_ENABLED || 'false').toLowerCase() === 'true';
  return global && local;
}

function buildLearningScript(input: MediaGenerationInput): string {
  const text = input.recognitionText.trim();
  const title = input.title.trim() || '学习任务';
  const category = input.category || '语文';
  const level = input.difficulty >= 3 ? '提升' : input.difficulty === 2 ? '基础' : '入门';

  const core = text ? text.slice(0, 360) : `${title}，请认真学习并完成练习。`;
  return [
    `主题：${title}`,
    `学科：${category}`,
    `难度：${level}`,
    `讲解：${core}`,
    '提示：先听后读，再尝试复述一遍。',
  ].join('\n');
}

function buildFallbackOutputs(input: MediaGenerationInput): MediaOutputItem[] {
  const outputs: MediaOutputItem[] = [];
  const fileUrl = (input.fileUrl || '').trim();
  if (!fileUrl) return outputs;

  if (input.sourceType === 'audio') {
    outputs.push({
      kind: 'audio',
      url: fileUrl,
      format: 'source-audio',
      durationSec: 30,
      provider: 'native-source',
    });
  }

  if (input.sourceType === 'video') {
    outputs.push({
      kind: 'video',
      url: fileUrl,
      format: 'source-video',
      durationSec: 45,
      provider: 'native-source',
    });
  }

  return outputs;
}

function buildMockAiOutputs(input: MediaGenerationInput): MediaOutputItem[] {
  const outputs = buildFallbackOutputs(input);
  if (outputs.length) {
    return outputs.map((item) => ({ ...item, provider: 'mock-ai' }));
  }
  return [];
}

export async function generateProfessionalMedia(
  input: MediaGenerationInput
): Promise<MediaGenerationOutput> {
  const script = buildLearningScript(input);
  if (!isMediaGenerationEnabled()) {
    return {
      mediaStatus: 'fallback',
      outputs: buildFallbackOutputs(input),
      script,
      fallbackReason: 'media_generation_disabled',
      costUsd: 0,
    };
  }

  const estimatedCostUsd = 0.05;
  const budget = await checkAndRecordBudget('media', {
    parentId: input.parentId,
    estimatedCostUsd,
  });

  if (!budget.allowed) {
    return {
      mediaStatus: 'fallback',
      outputs: buildFallbackOutputs(input),
      script,
      fallbackReason: budget.reason || 'media_budget_guardrail_blocked',
      costUsd: 0,
    };
  }

  try {
    return {
      mediaStatus: 'completed',
      outputs: buildMockAiOutputs(input),
      script,
      fallbackReason: null,
      costUsd: estimatedCostUsd,
    };
  } catch {
    return {
      mediaStatus: 'fallback',
      outputs: buildFallbackOutputs(input),
      script,
      fallbackReason: 'media_generation_failed',
      costUsd: 0,
    };
  }
}
