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
