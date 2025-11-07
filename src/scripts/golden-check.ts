// scripts/golden-check.ts
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildMarkdownExportByFormat } from '../utils/exporters';
import type { ExportNoteMetadata, ExportTurn } from '../types';

/*
npx tsx scripts/golden-check.ts \
  /Users/tedshaffer/Documents/ChatGPTExports/chatMonorepo/clean-mold-from-feeder-202511062057 \
  /Users/tedshaffer/Documents/ChatGPTExports/chatMonorepo/chatalog-tiny-turns-joke-202511062056 \
  /Users/tedshaffer/Documents/ChatGPTExports/chatMonorepo/21-day-italy-itinerary-with-puglia-bologna-and-rome-202511062056
*/

function splitFrontMatter(md: string) {
  // --- front matter ---\n ... \n---\n
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/m.exec(md);
  if (!m) return { fm: '', body: md };
  return { fm: m[1], body: m[2] };
}

function parseFrontMatter(md: string): Partial<ExportNoteMetadata> & { chatTitle?: string } {
  const { fm } = splitFrontMatter(md);
  const out: any = {};
  for (const line of fm.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    // strip surrounding quotes if present
    out[k] = v.replace(/^"(.*)"$/, '$1');
  }
  // Chatworthy keeps the Chat Title again as the first H1 in the body
  const { body } = splitFrontMatter(md);
  const h1 = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  if (h1) out.chatTitle = h1;
  return out;
}

function normalizeDynamic(s: string): string {
  return s
    // front-matter dynamic keys
    .replace(/^noteId: .+$/m, 'noteId: NOTE_ID')
    .replace(/^chatId: .+$/m, 'chatId: CHAT_ID')
    .replace(/^pageUrl: .+$/m, 'pageUrl: https://example.com/c/CHAT_ID')
    .replace(/^exportedAt: .+$/m, 'exportedAt: 2000-01-01T00:00:00.000Z')
    // REMOVE meta-row lines entirely (your goldens don't have them)
    .replace(/^Source: .+$/gm, '')
    .replace(/^Exported: .+$/gm, '')
    // collapse any double blank lines left by removals
    .replace(/\n{3,}/g, '\n\n')
    // EOLs + trim
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

function fixedMeta(base: Partial<ExportNoteMetadata>): ExportNoteMetadata {
  return {
    noteId: 'ext-STATIC',
    source: 'chatgpt',
    chatId: 'CHAT_ID',
    chatTitle: base.chatTitle || 'Chat Export',
    pageUrl: 'https://example.com/c/CHAT_ID',
    exportedAt: '2000-01-01T00:00:00.000Z',
    model: undefined,
    subject: base.subject || base.chatTitle,
    topic: base.topic || base.chatTitle,
    summary: null,
    tags: [],
    autoGenerate: { summary: true, tags: true },
    noteMode: 'auto',
    turnCount: undefined,
    splitHints: [],
    author: 'me',
    visibility: 'private',
  };
}

function run(pairBase: string) {
  const turnsPath = resolve(`${pairBase}.turns.json`);
  const mdPath = resolve(`${pairBase}.md`);

  const turns: ExportTurn[] = JSON.parse(readFileSync(turnsPath, 'utf8'));
  const mdGolden = readFileSync(mdPath, 'utf8');

  const fmInfo = parseFrontMatter(mdGolden);
  const meta = fixedMeta(fmInfo);

  const mdFromTurns = buildMarkdownExportByFormat(
    'markdown_pure',
    meta,
    turns,
    {
      title: meta.chatTitle,
      includeFrontMatter: true,
      htmlBodies: [],          // text-only path is fine for parity here
      includeToc: true,
      freeformNotes: '',
      // NEW: match your golden outputs (no meta row)
      // @ts-expect-error includeMetaRow is accepted by your exporter
      includeMetaRow: false
    }
  );

  const A = normalizeDynamic(mdFromTurns);
  const B = normalizeDynamic(mdGolden);

  if (A === B) {
    console.log(`✅ PASS: ${basename(pairBase)}`);
  } else {
    console.error(`❌ FAIL: ${basename(pairBase)} (diff below)\n`);
    // naive diff block (enough for first pass)
    const aLines = A.split('\n');
    const bLines = B.split('\n');
    const max = Math.max(aLines.length, bLines.length);
    for (let i = 0; i < max; i++) {
      if (aLines[i] !== bLines[i]) {
        console.error(`- A[${i + 1}]: ${aLines[i] ?? ''}`);
        console.error(`+ B[${i + 1}]: ${bLines[i] ?? ''}`);
        break;
      }
    }
    process.exitCode = 1;
  }
}

// --- CLI ---
const bases = process.argv.slice(2);
if (!bases.length) {
  console.error('Usage: tsx scripts/golden-check.ts <path/to/base-without-ext> ...');
  console.error('Example: tsx scripts/golden-check.ts /mnt/data/clean-mold-from-feeder-202511062057');
  process.exit(2);
}
for (const b of bases) run(b);
