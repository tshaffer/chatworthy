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
  // Mask front-matter fields that vary
  s = s
    .replace(/^noteId: .+$/m, 'noteId: NOTE_ID')
    .replace(/^chatId: .+$/m, 'chatId: CHAT_ID')
    .replace(/^pageUrl: .+$/m, 'pageUrl: https://example.com/c/CHAT_ID')
    .replace(/^exportedAt: .+$/m, 'exportedAt: 2000-01-01T00:00:00.000Z');

  // Remove meta rows in body
  s = s
    .replace(/^Source:\s.*$/gm, '')
    .replace(/^Exported:\s.*$/gm, '');

  // Remove the TOC heading (keep items)
  s = s.replace(/^\s*##\s+Table of Contents\s*$(?:\r?\n)?/gmi, '');

  // Remove explicit anchor lines like <a id="p-1"></a>
  s = s.replace(/^\s*<a id="p-\d+"><\/a>\s*$(?:\r?\n)?/gm, '');

  // Remove horizontal rules of common forms (---, ***, ___ with optional spacing)
  s = s.replace(/^\s*(?:[-*_]\s*){3,}\s*$(?:\r?\n)?/gm, '');

  // If that removal left blank lines before the first numbered item, collapse them
  s = s.replace(/\n+(?=\d+\.\s+\[)/g, '\n');

  // Normalize headings by stripping leading ATX hashes (so "### Foo" == "Foo")
  s = s.replace(/^#{1,6}\s+/gm, '');

  // TOC lines sometimes have accidental double spaces inside; collapse on any numbered-item line
  s = s.replace(/^\d+\.\s+\[.*$/gm, (m) => m.replace(/\s{2,}/g, ' '));

  // General whitespace/EOL cleanup
  return s
    .replace(/\n{3,}/g, '\n\n')
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
      htmlBodies: [],        // ← run the text-only path (Node-safe)
      includeToc: true,
      freeformNotes: ''
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
    const ctx = 3;
    for (let i = 0; i < max; i++) {
      if (aLines[i] !== bLines[i]) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(max, i + ctx + 1);
        console.error('--- A (generated) ---');
        for (let k = start; k < end; k++) console.error(`[${k + 1}] ${aLines[k] ?? ''}`);
        console.error('--- B (golden) ------');
        for (let k = start; k < end; k++) console.error(`[${k + 1}] ${bLines[k] ?? ''}`);
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
