import type { ConversationExport } from '../types';

function escapeMd(s: string) {
  return s.replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;'));
}

export function toMarkdown(data: ConversationExport): string {
  const lines: string[] = [];
  lines.push(`# ${escapeMd(data.title || 'Chat Export')}`);
  lines.push(`_Source_: ${data.url}`);
  lines.push(`_Exported_: ${new Date(data.exportedAt).toLocaleString()}`);
  lines.push('');

  data.turns.forEach((t, idx) => {
    const who = t.role.toUpperCase();
    lines.push(`---\n**${who} ${idx + 1}**`);

    // Best-effort: convert simple HTML blocks to MD; keep code blocks intact
    // For a dev tool, keep it simple and rely on ChatGPT page formatting using code fences already inline
    const html = t.html
      .replaceAll('<br>', '\n')
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `\n\n\n\`\`\`\n${code}\n\`\`\`\n\n`)
      .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
      .replace(/<\/(p|div|li)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    lines.push(html);
    lines.push('');
  });

  return lines.join('\n');
}

export function toJson(data: ConversationExport): string {
  return JSON.stringify(data, null, 2);
}
