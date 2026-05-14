import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const prisma = new PrismaClient();

function fixFilename(name: string): string | null {
  if (!name) return null;
  try {
    const latinBuf = Buffer.from(name, 'latin1');
    const decoded = latinBuf.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(latinBuf) && decoded !== name) {
      return decoded;
    }
  } catch {}
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[backfill-filename-mojibake] mode=${mode}`);

  const rows = await prisma.appArtifact.findMany({
    select: { id: true, content: true },
  });

  let scanned = 0;
  let needsFix = 0;
  let updated = 0;
  const samples: Array<{ id: string; from: string; to: string }> = [];

  for (const row of rows) {
    scanned++;
    const content = (row.content || {}) as Record<string, unknown>;
    const original = typeof content.fileName === 'string' ? content.fileName : '';
    if (!original) continue;

    const fixed = fixFilename(original);
    if (!fixed) continue;

    needsFix++;
    if (samples.length < 10) {
      samples.push({ id: row.id, from: original, to: fixed });
    }

    if (apply) {
      await prisma.appArtifact.update({
        where: { id: row.id },
        data: { content: { ...content, fileName: fixed } },
      });
      updated++;
    }
  }

  console.log(`scanned=${scanned} needsFix=${needsFix} updated=${updated}`);
  if (samples.length) {
    console.log('Samples:');
    for (const s of samples) {
      console.log(`  ${s.id}: "${s.from}" -> "${s.to}"`);
    }
  }
  if (!apply && needsFix > 0) {
    console.log('Re-run with --apply to persist changes.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
