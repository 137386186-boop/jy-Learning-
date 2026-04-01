import bilibiliAdapter from './platform-adapters/bilibili';
import zhihuAdapter from './platform-adapters/zhihu';
import { PlatformAdapter, SyncCollectItem } from './platform-adapters/types';
import { importContentsBatch } from './import-normalizer';
import { prisma } from '../lib/prisma';

function parseList(input: string | undefined, fallback: string[]): string[] {
  const raw = (input || '').trim();
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toPositiveInt(input: string | undefined, fallback: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getAdaptersBySlug(): Map<string, PlatformAdapter> {
  return new Map<string, PlatformAdapter>([
    [bilibiliAdapter.slug, bilibiliAdapter],
    [zhihuAdapter.slug, zhihuAdapter],
  ]);
}

type PlatformRunSummary = {
  platformSlug: string;
  status: 'success' | 'skipped' | 'failed';
  reason: string;
  fetched: number;
  inserted: number;
  invalid: number;
  skipped: number;
};

export async function runSyncNow(): Promise<{ ok: boolean; summaries: PlatformRunSummary[] }> {
  const platformSlugs = parseList(process.env.SYNC_PLATFORMS, ['bilibili', 'zhihu']);
  const keywords = parseList(process.env.SYNC_KEYWORDS, ['SCI', '论文', '专利', '投稿', '发表论文', '发表期刊']);
  const perKeyword = toPositiveInt(process.env.SYNC_PER_KEYWORD, 40);

  const adapterMap = getAdaptersBySlug();
  const summaries: PlatformRunSummary[] = [];

  for (const slug of platformSlugs) {
    const adapter = adapterMap.get(slug);
    if (!adapter) {
      const reason = `adapter_not_found:${slug}`;
      summaries.push({
        platformSlug: slug,
        status: 'skipped',
        reason,
        fetched: 0,
        inserted: 0,
        invalid: 0,
        skipped: 0,
      });
      continue;
    }

    const platform = await prisma.platform.findUnique({ where: { slug } });
    if (!platform) {
      const reason = 'platform_not_seeded';
      summaries.push({
        platformSlug: slug,
        status: 'failed',
        reason,
        fetched: 0,
        inserted: 0,
        invalid: 0,
        skipped: 0,
      });
      continue;
    }

    try {
      const collectResult = await adapter.collect({ keywords, perKeyword });
      const items = (collectResult.items || []) as SyncCollectItem[];
      const fetched = items.length;

      if (items.length === 0) {
        const reason = collectResult.reason || 'no_items_collected';
        await prisma.crawlLog.create({
          data: {
            platformId: platform.id,
            status: 'skipped',
            reason,
            itemCount: 0,
          },
        });
        summaries.push({
          platformSlug: slug,
          status: 'skipped',
          reason,
          fetched: 0,
          inserted: 0,
          invalid: 0,
          skipped: 0,
        });
        continue;
      }

      const importResult = await importContentsBatch(items);
      const reason = `fetched=${fetched},inserted=${importResult.inserted},invalid=${importResult.invalid},skipped=${importResult.skipped}`;

      await prisma.crawlLog.create({
        data: {
          platformId: platform.id,
          status: 'success',
          reason,
          itemCount: importResult.inserted,
        },
      });

      summaries.push({
        platformSlug: slug,
        status: 'success',
        reason,
        fetched,
        inserted: importResult.inserted,
        invalid: importResult.invalid,
        skipped: importResult.skipped,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'sync_failed';
      await prisma.crawlLog.create({
        data: {
          platformId: platform.id,
          status: 'failed',
          reason,
          itemCount: 0,
        },
      });
      summaries.push({
        platformSlug: slug,
        status: 'failed',
        reason,
        fetched: 0,
        inserted: 0,
        invalid: 0,
        skipped: 0,
      });
    }
  }

  return { ok: summaries.every((s) => s.status !== 'failed'), summaries };
}
