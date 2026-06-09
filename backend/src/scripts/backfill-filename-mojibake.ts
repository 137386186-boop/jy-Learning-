import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { extractTextFromMaterial } from '../lib/text-extractor';

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

const MOJIBAKE_HINT = /[ÃÂÐÑØæçðñþäåèéêëìíîïòóôõöùúûüÿ¥»]/;

function fixMojibakeText(text: string): string | null {
  if (!text || !MOJIBAKE_HINT.test(text)) return null;
  try {
    const latinBuf = Buffer.from(text, 'latin1');
    const decoded = latinBuf.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(latinBuf) && decoded !== text && !MOJIBAKE_HINT.test(decoded)) {
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
    const recognition = (content.recognitionResult && typeof content.recognitionResult === 'object')
      ? (content.recognitionResult as Record<string, unknown>)
      : null;
    const extractedText = recognition && typeof recognition.extractedText === 'string'
      ? recognition.extractedText
      : '';

    const fixedName = original ? fixFilename(original) : null;
    let fixedText = extractedText ? fixMojibakeText(extractedText) : null;

    // Stronger fallback: re-extract from the source file when stored text still
    // looks mojibaked after the byte-translation attempt.
    if (!fixedText && extractedText && MOJIBAKE_HINT.test(extractedText)) {
      const fileUrl = typeof content.fileUrl === 'string' ? content.fileUrl : '';
      const mimeType = typeof content.mimeType === 'string' ? content.mimeType : '';
      const fileName = fixedName || (typeof content.fileName === 'string' ? content.fileName : '');
      if (fileUrl) {
        try {
          const out = await extractTextFromMaterial({ fileName, fileUrl, mimeType });
          if (out.text && !MOJIBAKE_HINT.test(out.text)) {
            fixedText = out.text;
          }
        } catch (e) {
          console.warn(`[reextract] failed for ${row.id}:`, (e as Error).message);
        }
      }
    }

    if (!fixedName && !fixedText) continue;

    needsFix++;
    if (samples.length < 10) {
      samples.push({
        id: row.id,
        from: fixedName ? original : `[text]${extractedText.slice(0, 30)}`,
        to: fixedName || `[text]${(fixedText || '').slice(0, 30)}`,
      });
    }

    if (apply) {
      const nextContent: Record<string, unknown> = { ...content };
      if (fixedName) nextContent.fileName = fixedName;
      if (fixedText && recognition) {
        nextContent.recognitionResult = { ...recognition, extractedText: fixedText };
      }
      await prisma.appArtifact.update({
        where: { id: row.id },
        data: { content: nextContent as Prisma.InputJsonValue },
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
