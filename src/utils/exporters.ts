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

  lines.push(`summary: ${meta.summary === null ? 'null' : yamlEscape(meta.summary)}`);
  lines.push(`tags: [${(meta.tags ?? []).map(t => yamlEscape(t)).join(', ')}]`);
  lines.push(`autoGenerate:`);
  lines.push(`  summary: ${meta.autoGenerate.summary}`);
  lines.push(`  tags: ${meta.autoGenerate.tags}`);

  lines.push(`noteMode: ${yamlEscape(meta.noteMode)}`);
  lines.push(`turnCount: ${meta.turnCount}`);
  lines.push(`splitHints: [${meta.splitHints.map(pair => `[${pair[0]}, ${pair[1]}]`).join(', ')}]`);

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

function renderFrontMatter(meta: ExportNoteMetadata): string {
  // Keep YAML front matter — VS Code preview supports it
  // (If you want to drop it entirely, return '' here.)
  const lines: string[] = ['---'];
  const pushIf = (k: string, v: any) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
  };
  pushIf('noteId', meta.noteId);
  pushIf('source', meta.source);
  pushIf('chatId', meta.chatId);
  pushIf('chatTitle', meta.chatTitle);
  pushIf('pageUrl', meta.pageUrl);
  pushIf('exportedAt', meta.exportedAt);
  pushIf('model', meta.model);
  pushIf('subject', meta.subject);
  pushIf('topic', meta.topic);
  pushIf('summary', meta.summary);
  pushIf('tags', meta.tags);
  lines.push('---', '');
  return lines.join('\n');
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

export function buildMarkdownExportByFormat(
  format: ExportFormat,
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  opts?: { title?: string; freeformNotes?: string }
): string {
  // If caller provided a title override, reflect it into meta.chatTitle
  const metaWithTitle: ExportNoteMetadata = opts?.title
    ? { ...meta, chatTitle: opts.title }
    : meta;

  if (format === 'markdown_pure') {
    return toPureMarkdownWithFrontMatter(metaWithTitle, turns, { title: metaWithTitle.chatTitle });
  }

  // ✅ Legacy exporter expects a STRING as the 3rd arg
  return toMarkdownWithFrontMatter(
    metaWithTitle,
    turns,
    opts?.freeformNotes // <-- string | undefined, matches your signature
  );
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

export function toChatGPTLikeHTML(meta: ExportNoteMetadata, turns: ExportTurn[]): string {
  const title = meta.chatTitle || 'Chat Export';
  const metaRows = [
    meta.pageUrl ? `Source: <a href="${esc(meta.pageUrl)}">${esc(meta.pageUrl)}</a>` : '',
    meta.exportedAt ? `Exported: ${esc(meta.exportedAt)}` : '',
    meta.model ? `Model: ${esc(String(meta.model))}` : '',
  ].filter(Boolean).join(' &nbsp;•&nbsp; ');

  const items = turns.map(t => {
    const role = t.role === 'user' ? 'user' : t.role; // only user/assistant typically
    const avatar = role === 'user' ? 'U' : 'A';
    return `
      <article class="cg-turn ${role}">
        <div class="cg-avatar" aria-hidden="true">${avatar}</div>
        <div class="cg-body">
          <div class="cg-role">${role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : role[0].toUpperCase() + role.slice(1)}</div>
          ${renderTextAsHtmlBlocks(t.text || '')}
        </div>
      </article>
    `;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CHATGPT_EMBEDDED_CSS}</style>
<main class="cg-wrap">
  <h1>${esc(title)}</h1>
  ${metaRows ? `<div class="cg-meta">${metaRows}</div>` : ''}
  ${items}
</main>
</html>`;
}

export function filenameSafe(s: string): string {
  return (s || 'chat-export').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'chat-export';
}
