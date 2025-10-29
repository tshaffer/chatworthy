import { ExportNoteMetadata, ExportTurn } from '../types';

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

function toMarkdownWithFrontMatter(
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

// --- Common small helpers ----------------------------------------------------

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
function toPureMarkdownChatStyle(
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
``
  // Ensure trailing newline for nicer diffs
  if (out[out.length - 1] !== '') out.push('');
  return out.join('\n');
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
