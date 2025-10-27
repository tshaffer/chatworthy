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
