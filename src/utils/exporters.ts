import { ExportNoteMetadata, ExportTurn, ExportFormat } from '../types';

function yamlEscape(val: string) {
  // Keep simple: wrap in double quotes & escape inner quotes/newlines
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function toYAML(meta: ExportNoteMetadata): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`noteId: ${yamlEscape(meta.noteId)}`);
  lines.push(`source: ${yamlEscape(meta.source)}`);
  if (meta.chatId) lines.push(`chatId: ${yamlEscape(meta.chatId)}`);
  if (meta.chatTitle) lines.push(`chatTitle: ${yamlEscape(meta.chatTitle)}`);
  lines.push(`pageUrl: ${yamlEscape(meta.pageUrl)}`);
  lines.push(`exportedAt: ${yamlEscape(meta.exportedAt)}`);
  if (meta.model) lines.push(`model: ${yamlEscape(meta.model)}`);

  lines.push(`subject: ${yamlEscape(meta.subject ?? '')}`);
  lines.push(`topic: ${yamlEscape(meta.topic ?? '')}`);

  lines.push(`summary: ${meta.summary === null ? 'null' : yamlEscape(meta.summary ?? '')}`);
  lines.push(`tags: [${(meta.tags ?? []).map(t => yamlEscape(t)).join(', ')}]`);
  lines.push(`autoGenerate:`);
  const ag = meta.autoGenerate ?? { summary: true, tags: true };
  lines.push(`autoGenerate:`);
  lines.push(`  summary: ${ag.summary}`);
  lines.push(`  tags: ${ag.tags}`);

  if (meta.noteMode) lines.push(`noteMode: ${yamlEscape(meta.noteMode)}`);
  if (typeof meta.turnCount === 'number') lines.push(`turnCount: ${meta.turnCount}`);
  if (meta.splitHints?.length) {
    lines.push(`splitHints: [${meta.splitHints.map(h => yamlEscape(h)).join(', ')}]`);
  }

  if (meta.author) lines.push(`author: ${yamlEscape(meta.author)}`);
  if (meta.visibility) lines.push(`visibility: ${yamlEscape(meta.visibility)}`);
  lines.push('---');
  return lines.join('\n');
}

export function toMarkdownWithFrontMatter(
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  freeformNotes?: string
): string {
  const frontMatter = toYAML(meta);

  const turnsBlock = [
    ':::turns',
    ...turns.map(t => {
      const r = `- role: ${t.role}`;
      const time = t.time ? `\n  time: "${t.time}"` : '';
      // Ensure text is single-line safe YAML-like; importer will handle \n
      const text = `\n  text: "${t.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      return r + time + text;
    }),
    ':::end-turns',
  ].join('\n');

  const notesSection = freeformNotes?.trim()
    ? `\n\n## Notes\n${freeformNotes.trim()}\n`
    : '\n';

  return `${frontMatter}\n\n# Transcript\n\n${turnsBlock}${notesSection}`;
}

// Basic role → label mapping for headings
const ROLE_LABEL: Record<ExportTurn['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

function renderTurnPureMarkdown(t: ExportTurn, idx: number): string {
  // Example layout (very “VS Code markdown friendly”):
  // ### 1 · User  (2025-10-29 14:03)
  // <turn text>

  const parts: string[] = [];
  const headingLabel = `${idx + 1} · ${ROLE_LABEL[t.role]}` + (t.time ? `  (${t.time})` : '');
  parts.push(`### ${headingLabel}`, '');

  // Turn text is already plain text. Just place it.
  // If you want subtle quoting, you could prefix each paragraph with `> `, but
  // the “plain block” style is closest to how old Chatworthy looked.
  parts.push(t.text.trim(), '');
  return parts.join('\n');
}

/**
 * NEW: Pure Markdown exporter (no embedded HTML, no CSS classes)
 */
export function toPureMarkdownWithFrontMatter(
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  opts?: { title?: string }
): string {
  const chunks: string[] = [];

  // YAML
  chunks.push(renderFrontMatter(meta));

  // Optional H1 title
  const title = opts?.title || meta.chatTitle || 'Chat Export';
  chunks.push(`# ${title}`, '');

  // Source + URL row (optional)
  if (meta.pageUrl) {
    chunks.push(`Source: ${meta.pageUrl}`, '');
  }

  // Render each turn as a Markdown section
  turns.forEach((t, i) => {
    chunks.push(renderTurnPureMarkdown(t, i));
    // Horizontal rule between turns (nice in VS Code)
    if (i < turns.length - 1) chunks.push('---', '');
  });

  return chunks.join('\n');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// very small parser: supports paragraphs + ``` code fences
function renderTextAsHtmlBlocks(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inCode = false;
  let fenceLang = '';

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        fenceLang = fence[1] || '';
        html += `<pre class="cg-code"><code${fenceLang ? ` data-lang="${esc(fenceLang)}"` : ''}>`;
      } else {
        inCode = false;
        fenceLang = '';
        html += `</code></pre>`;
      }
      continue;
    }
    if (inCode) {
      html += esc(line) + '\n';
    } else if (line.trim() === '') {
      html += '<div class="cg-spacer"></div>';
    } else {
      html += `<p>${esc(line)}</p>`;
    }
  }
  if (inCode) html += `</code></pre>`;
  return html;
}

const CHATGPT_EMBEDDED_CSS = `
:root{
  --bg:#ffffff;
  --fg:#111827;
  --muted:#6b7280;
  --bubble-user:#f0f9ff;
  --bubble-assistant:#f7f7f8;
  --border:#e5e7eb;
  --code-bg:#0b1020;
  --code-fg:#e5eef7;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0b0e14;
    --fg:#eaedf1;
    --muted:#a3aab5;
    --bubble-user:#0f172a;
    --bubble-assistant:#111827;
    --border:#252b36;
    --code-bg:#0e1428;
    --code-fg:#e5eef7;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
a{color:inherit}
h1{font-size:20px;margin:0 0 12px 0}
main.cg-wrap{max-width:840px;margin:32px auto;padding:0 16px 56px}
.cg-meta{font-size:12px;color:var(--muted);margin-bottom:16px}
.cg-turn{display:flex;gap:12px;margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--bubble-assistant)}
.cg-turn.user{background:var(--bubble-user)}
.cg-avatar{flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);color:var(--muted);font-size:12px}
.cg-role{font-weight:600;margin-bottom:6px}
.cg-body p{margin:6px 0}
.cg-spacer{height:6px}
pre.cg-code{background:var(--code-bg);color:var(--code-fg);padding:12px;border-radius:10px;overflow:auto}
pre.cg-code code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12.5px}
hr{border:none;border-top:1px solid var(--border);margin:24px 0}
`;

// --- Common small helpers ----------------------------------------------------

export function filenameSafe(s: string): string {
  return (s || 'chat-export').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'chat-export';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function roleLabel(role: ExportTurn['role']): 'You' | 'ChatGPT' | 'System' | 'Tool' {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'ChatGPT';
  if (role === 'system') return 'System';
  return 'Tool';
}

function renderFrontMatter(meta: ExportNoteMetadata): string {
  // Keep or drop keys as you prefer; VS Code/GitHub ignore YAML visually.
  const kv: Record<string, any> = {
    noteId: meta.noteId,
    source: meta.source,
    chatId: meta.chatId,
    chatTitle: meta.chatTitle,
    pageUrl: meta.pageUrl,
    exportedAt: meta.exportedAt,
    model: meta.model,
    subject: (meta as any).subject,
    topic: (meta as any).topic,
    summary: (meta as any).summary,
    tags: (meta as any).tags,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

// --- 1) Pure Markdown (ChatGPT Exporter–style) -------------------------------

/**
 * Produces Markdown that looks like the ChatGPT Exporter extension:
 *
 * # <title>
 *
 * **You:**␠␠
 * <message>
 *
 * ---
 *
 * **ChatGPT:**␠␠
 * <message>
 *
 * (two spaces at the end of the label line force a <br> line-break in MD)
 */
export function toPureMarkdownChatStyle(
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  opts?: {
    title?: string;
    includeFrontMatter?: boolean;  // default true
    includeMetaRow?: boolean;      // default true (Source/ExportedAt)
    hrBetween?: boolean;           // default true
    freeformNotes?: string;        // optional "## Notes" at end
  }
): string {
  const {
    title = meta.chatTitle || 'Chat Export',
    includeFrontMatter = true,
    includeMetaRow = true,
    hrBetween = true,
    freeformNotes,
  } = opts || {};

  const out: string[] = [];
  if (includeFrontMatter) out.push(renderFrontMatter(meta));

  out.push(`# ${title}`, '');

  if (includeMetaRow) {
    if (meta.pageUrl) out.push(`Source: ${meta.pageUrl}`);
    if (meta.exportedAt) out.push(`Exported: ${meta.exportedAt}`);
    out.push('');
  }

  const sep = hrBetween ? '\n---\n\n' : '\n\n';

  const blocks = turns.map((t) => {
    const label = roleLabel(t.role);
    const body = (t.text || '').replace(/\r\n/g, '\n').trimEnd();
    // Two trailing spaces before newline force a line break in Markdown
    return `**${label}:**  \n${body}`;
  });

  out.push(blocks.join(sep));

  if (freeformNotes && freeformNotes.trim()) {
    out.push('', '## Notes', '', freeformNotes.trim(), '');
  }

  // Ensure trailing newline for nicer diffs
  if (out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}

// --- 2) ChatGPT-like HTML (bubble UI) ----------------------------------------
// Keep your improved HTML exporter here. If you already added one, you can keep
// it as-is. This version is the “v2” we discussed.

export function toChatGPTLikeHTML(meta: ExportNoteMetadata, turns: ExportTurn[]): string {
  const CHATGPT_EMBEDDED_CSS = `
:root{
  --bg:#fff; --fg:#111827; --muted:#6b7280;
  --assistant:#f7f7f8; --user:#e6f4ff; --border:#e5e7eb;
  --code-bg:#0b1020; --code-fg:#e5eef7; --bubble-shadow:0 1px 2px rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark){
:root{
  --bg:#0b0e14; --fg:#e8ecf1; --muted:#9aa3ad;
  --assistant:#111827; --user:#0f172a; --border:#252b36;
  --code-bg:#0e1428; --code-fg:#e5eef7; --bubble-shadow:0 1px 2px rgba(0,0,0,.5);
}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
a{color:inherit;text-decoration:underline}
img{max-width:100%;border-radius:8px}
main.cg-wrap{max-width:840px;margin:32px auto 56px;padding:0 16px}
h1{font-size:20px;margin:0 0 12px 0}
.cg-meta{font-size:12px;color:var(--muted);margin-bottom:16px}
.cg-turn{display:flex;gap:12px;margin:14px 0}
.cg-bubble{flex:1;border:1px solid var(--border);border-radius:14px;padding:12px 14px;background:var(--assistant);box-shadow:var(--bubble-shadow)}
.cg-turn.user .cg-bubble{background:var(--user)}
.cg-avatar{flex:0 0 28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);color:var(--muted);font-size:12px}
.cg-role{font-weight:600;margin:0 0 6px 0;font-size:13px;color:var(--muted)}
blockquote{border-left:3px solid var(--border);padding-left:10px;margin:8px 0;color:var(--fg)}
ul,ol{padding-left:22px;margin:8px 0}
pre.cg-code{background:var(--code-bg);color:var(--code-fg);padding:12px;border-radius:10px;overflow:auto;margin:0}
pre.cg-code code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12.5px}
.cg-inline{background:rgba(127,127,127,.15);border-radius:4px;padding:.1em .35em}
hr{border:none;border-top:1px solid var(--border);margin:20px 0}
`;

  function renderMessageBody(md: string): string {
    // ultra-light renderer: keep paragraphs & code fences intact
    const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inCode = false;
    for (const line of lines) {
      const fence = /^```/.test(line);
      if (fence) {
        html += inCode ? '</code></pre>' : '<pre class="cg-code"><code>';
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        html += escHtml(line) + '\n';
      } else if (line.trim() === '') {
        html += '<div style="height:8px"></div>';
      } else {
        html += `<p>${escHtml(line)}</p>`;
      }
    }
    if (inCode) html += '</code></pre>';
    return html;
  }

  const title = meta.chatTitle || 'Chat Export';
  const metaRow = [
    meta.pageUrl ? `Source: <a href="${escHtml(meta.pageUrl)}">${escHtml(meta.pageUrl)}</a>` : '',
    meta.exportedAt ? `Exported: ${escHtml(meta.exportedAt)}` : '',
    meta.model ? `Model: ${escHtml(String(meta.model))}` : ''
  ].filter(Boolean).join(' &nbsp;•&nbsp; ');

  const items = turns.map((t) => {
    const role = t.role === 'user' ? 'user' : 'assistant';
    const avatar = role === 'user' ? 'U' : 'A';
    return `
      <section class="cg-turn ${role}">
        <div class="cg-avatar" aria-hidden="true">${avatar}</div>
        <div class="cg-bubble">
          <div class="cg-role">${role === 'user' ? 'You' : 'ChatGPT'}</div>
          ${renderMessageBody(t.text || '')}
        </div>
      </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>${CHATGPT_EMBEDDED_CSS}</style>
<main class="cg-wrap">
  <h1>${escHtml(title)}</h1>
  ${metaRow ? `<div class="cg-meta">${metaRow}</div>` : ''}
  ${items}
</main>
</html>`;
}

// --- 3) Format-aware builder (keeps your legacy exporter intact) --------------

/**
 * Chooses between:
 * - 'markdown_pure'  => toPureMarkdownChatStyle (this file)
 * - 'markdown_html'  => your existing toMarkdownWithFrontMatter(meta, turns, freeformNotes)
 */
export function buildMarkdownExportByFormat(
  format: 'markdown_html' | 'markdown_pure',
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  opts?: { title?: string; freeformNotes?: string; includeFrontMatter?: boolean }
): string {
  const metaWithTitle: ExportNoteMetadata = opts?.title
    ? { ...meta, chatTitle: opts.title }
    : meta;

  if (format === 'markdown_pure') {
    return toPureMarkdownChatStyle(metaWithTitle, turns, {
      title: metaWithTitle.chatTitle,
      includeFrontMatter: opts?.includeFrontMatter ?? true,
      includeMetaRow: true,
      hrBetween: true,
      freeformNotes: opts?.freeformNotes,
    });
  }

  // ✅ Legacy exporter expects a STRING as the 3rd arg (freeform notes)
  //    Keep your original implementation unmodified.
  return toMarkdownWithFrontMatter(metaWithTitle, turns, opts?.freeformNotes);
}
