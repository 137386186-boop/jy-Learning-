import redis from './redis';

type GuardrailStage = 'recognition' | 'media';

type BudgetScope = {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  requestsPerParentPerDay: number | null;
  maxCostPerArtifactUsd: number | null;
};

export interface BudgetCheckInput {
  parentId: string;
  estimatedCostUsd: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  spentDailyUsd: number;
  spentMonthlyUsd: number;
  requestCountToday: number;
  estimatedCostUsd: number;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function getBudgetScope(): BudgetScope {
  return {
    dailyUsd: parsePositiveNumber(process.env.APP_AI_BUDGET_DAILY_USD) ?? 2,
    monthlyUsd: parsePositiveNumber(process.env.APP_AI_BUDGET_MONTHLY_USD) ?? 20,
    requestsPerParentPerDay: parsePositiveNumber(process.env.APP_AI_MAX_REQUESTS_PER_PARENT_PER_DAY) ?? 40,
    maxCostPerArtifactUsd: parsePositiveNumber(process.env.APP_AI_MAX_COST_PER_ARTIFACT_USD) ?? 0.5,
  };
}

function getDateKeys(now = new Date()) {
  const iso = now.toISOString();
  return {
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
  };
}

function getCostKey(stage: GuardrailStage, dayOrMonth: string, bucket: 'daily' | 'monthly') {
  return `app:ai:budget:${stage}:${bucket}:${dayOrMonth}`;
}

function getRequestKey(day: string) {
  return `app:ai:budget:requests:daily:${day}`;
}

function toSafeNumber(value: string | null): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export async function checkAndRecordBudget(
  stage: GuardrailStage,
  input: BudgetCheckInput
): Promise<BudgetCheckResult> {
  const estimatedCostUsd = Math.max(0, Number(input.estimatedCostUsd) || 0);
  const scope = getBudgetScope();

  if (scope.maxCostPerArtifactUsd !== null && estimatedCostUsd > scope.maxCostPerArtifactUsd) {
    return {
      allowed: false,
      reason: 'single_artifact_cost_exceeded',
      spentDailyUsd: 0,
      spentMonthlyUsd: 0,
      requestCountToday: 0,
      estimatedCostUsd,
    };
  }

  const { day, month } = getDateKeys();
  const dailyKey = getCostKey(stage, day, 'daily');
  const monthlyKey = getCostKey(stage, month, 'monthly');
  const requestKey = getRequestKey(day);

  try {
    const [dailyRaw, monthlyRaw, requestRaw] = await Promise.all([
      redis.hget(dailyKey, input.parentId),
      redis.hget(monthlyKey, input.parentId),
      redis.hget(requestKey, input.parentId),
    ]);

    const spentDailyUsd = toSafeNumber(dailyRaw);
    const spentMonthlyUsd = toSafeNumber(monthlyRaw);
    const requestCountToday = toSafeNumber(requestRaw);

    if (scope.requestsPerParentPerDay !== null && requestCountToday + 1 > scope.requestsPerParentPerDay) {
      return {
        allowed: false,
        reason: 'daily_request_limit_exceeded',
        spentDailyUsd,
        spentMonthlyUsd,
        requestCountToday,
        estimatedCostUsd,
      };
    }

    if (scope.dailyUsd !== null && spentDailyUsd + estimatedCostUsd > scope.dailyUsd) {
      return {
        allowed: false,
        reason: 'daily_budget_exceeded',
        spentDailyUsd,
        spentMonthlyUsd,
        requestCountToday,
        estimatedCostUsd,
      };
    }

    if (scope.monthlyUsd !== null && spentMonthlyUsd + estimatedCostUsd > scope.monthlyUsd) {
      return {
        allowed: false,
        reason: 'monthly_budget_exceeded',
        spentDailyUsd,
        spentMonthlyUsd,
        requestCountToday,
        estimatedCostUsd,
      };
    }

    const pipeline = redis.pipeline();
    pipeline.hincrbyfloat(dailyKey, input.parentId, estimatedCostUsd);
    pipeline.expire(dailyKey, 60 * 60 * 24 * 8);
    pipeline.hincrbyfloat(monthlyKey, input.parentId, estimatedCostUsd);
    pipeline.expire(monthlyKey, 60 * 60 * 24 * 45);
    pipeline.hincrby(requestKey, input.parentId, 1);
    pipeline.expire(requestKey, 60 * 60 * 24 * 8);
    await pipeline.exec();

    return {
      allowed: true,
      spentDailyUsd: spentDailyUsd + estimatedCostUsd,
      spentMonthlyUsd: spentMonthlyUsd + estimatedCostUsd,
      requestCountToday: requestCountToday + 1,
      estimatedCostUsd,
    };
  } catch {
    return {
      allowed: false,
      reason: 'guardrail_unavailable',
      spentDailyUsd: 0,
      spentMonthlyUsd: 0,
      requestCountToday: 0,
      estimatedCostUsd,
    };
  }
}
