import path from 'path';
import { promises as fs } from 'fs';
import { PlatformAdapter, SyncCollectInput, SyncCollectResult } from './types';

async function collectFromLatestOutput(_input: SyncCollectInput): Promise<SyncCollectResult> {
  const outPath = process.env.SYNC_INPUT_JSON?.trim();
  if (!outPath) {
    return { items: [], reason: 'SYNC_INPUT_JSON not configured' };
  }
  const absolute = path.isAbsolute(outPath) ? outPath : path.resolve(process.cwd(), outPath);
  const raw = await fs.readFile(absolute, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return { items: [], reason: 'SYNC_INPUT_JSON is not an array' };
  }
  const items = parsed.filter((item) => item && item.platformSlug === 'bilibili');
  return { items };
}

const bilibili: PlatformAdapter = {
  slug: 'bilibili',
  collect: collectFromLatestOutput,
};

export default bilibili;
