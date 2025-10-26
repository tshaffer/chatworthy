import type { ConversationExport } from '../types';

function escapeYaml(str: string) { return String(str).replace(/"/g, '\"'); }
function escapeMd(s: string) { return s.replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;')); }

export function toMarkdownWithFrontMatter(data: ConversationExport, selectedPromptIndexes: number[]): string {
  const fmLines: string[] = [];
  fmLines.push('---');
  fmLines.push(`title: "${escapeYaml(data.title || 'Chat Export')}"`);
  fmLines.push(`url: "${escapeYaml(data.url)}"`);
  fmLines.push(`exportedAt: "${escapeYaml(data.exportedAt)}"`);
  fmLines.push(`selectionCount: ${selectedPromptIndexes.length}`);
  fmLines.push('selectedPrompts:');
  selectedPromptIndexes.forEach(i => fmLines.push(`  - ${i}`));
  fmLines.push('---');

  const body: string[] = [];
  body.push(`# ${escapeMd(data.title || 'Chat Export')}`);
  body.push(`_Source_: ${data.url}`);
  body.push(`_Exported_: ${new Date(data.exportedAt).toLocaleString()}`);
  body.push('');

  selectedPromptIndexes.forEach((uIdx, selIdx) => {
    const user = data.turns[uIdx];
    if (!user) return;
    body.push('---');
    body.push(`## Prompt ${selIdx + 1}`);
    const userMd = (user.html || user.text || '')
      .replaceAll('<br>', '\n')
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `\n\n\n\`\`\`\n${code}\n\`\`\`\n\n`)
      .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
      .replace(/<\/(p|div|li)>/g, '\n')
      .replace(/<[^>]+>/g, '').trim();
    body.push(userMd); body.push('');

    const assistant = data.turns.slice(uIdx + 1).find(t => t.role === 'assistant');
    if (assistant) {
      body.push('### Assistant');
      const aMd = (assistant.html || assistant.text || '')
        .replaceAll('<br>', '\n')
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (_m, code) => `\n\n\n\`\`\`\n${code}\n\`\`\`\n\n`)
        .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
        .replace(/<\/(p|div|li)>/g, '\n')
        .replace(/<[^>]+>/g, '').trim();
      body.push(aMd); body.push('');
    }
  });

  return fmLines.join('\n') + '\n\n' + body.join('\n');
}
