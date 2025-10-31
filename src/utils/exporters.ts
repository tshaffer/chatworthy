import { ExportNoteMetadata, ExportTurn } from '../types';

// If you bundle with esbuild/webpack, install these deps:
//   npm i turndown turndown-plugin-gfm
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// ---------------- YAML Front Matter (legacy path stays intact) ----------------

function yamlEscape(val: string) {
  // Wrap in double quotes & escape inner quotes/newlines/backslashes
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

  lines.push(`subject: ${yamlEscape((meta as any).subject ?? '')}`);
  lines.push(`topic: ${yamlEscape((meta as any).topic ?? '')}`);

  const summaryVal = (meta as any).summary;
  lines.push(`summary: ${summaryVal === null ? 'null' : yamlEscape(summaryVal ?? '')}`);
  const tagsVal = (meta as any).tags ?? [];
  lines.push(`tags: [${(tagsVal as string[]).map(t => yamlEscape(t)).join(', ')}]`);

  const ag = (meta as any).autoGenerate ?? { summary: true, tags: true };
  lines.push(`autoGenerate:`);
  lines.push(`  summary: ${ag.summary}`);
  lines.push(`  tags: ${ag.tags}`);

  if ((meta as any).noteMode) lines.push(`noteMode: ${yamlEscape((meta as any).noteMode)}`);
  if (typeof (meta as any).turnCount === 'number') lines.push(`turnCount: ${(meta as any).turnCount}`);
  if ((meta as any).splitHints?.length) {
    lines.push(`splitHints: [${(meta as any).splitHints.map((h: string) => yamlEscape(h)).join(', ')}]`);
  }

  if ((meta as any).author) lines.push(`author: ${yamlEscape((meta as any).author)}`);
  if ((meta as any).visibility) lines.push(`visibility: ${yamlEscape((meta as any).visibility)}`);
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

// ---------------- Shared helpers ----------------

function roleLabel(role: ExportTurn['role']): 'Prompt' | 'Response' | 'System' | 'Tool' {
  if (role === 'user') return 'Prompt';
  if (role === 'assistant') return 'Response';
  if (role === 'system') return 'System';
  return 'Tool';
}

function renderFrontMatter(meta: ExportNoteMetadata): string {
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

// ---------------- Turndown (HTML → Markdown) ----------------

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  fence: '```',
  strongDelimiter: '**'
});
td.use(gfm);

// Preserve fenced code blocks with language
td.addRule('fencedCodeWithLang', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    (node as HTMLElement).firstElementChild?.nodeName === 'CODE',
  replacement: (_content, node) => {
    const codeEl = (node as HTMLElement).querySelector('code')!;
    const cls = codeEl.getAttribute('class') || '';
    const match = cls.match(/language-([\w+#-]+)/i);
    const lang = match ? match[1] : '';
    const code = codeEl.textContent || '';
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }
});

// Inline code (avoid wrapping PRE > CODE)
td.addRule('inlineCode', {
  filter: (node) =>
    node.nodeName === 'CODE' &&
    node.parentElement?.nodeName !== 'PRE',
  replacement: (content) => '`' + content + '`'
});

// KaTeX math → Markdown math
td.addRule('katexMath', {
  filter: (node) => {
    if (node.nodeType !== 1) return false;
    const el = node as Element;
    return el.classList.contains('katex') || el.classList.contains('katex-display');
  },
  replacement: (_content, node) => {
    const el = node as Element;
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    const tex = ann?.textContent || '';
    const isBlock = el.classList.contains('katex-display');
    return isBlock ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
  }
});

// Images
td.addRule('images', {
  filter: 'img',
  replacement: (_content, node) => {
    const img = node as HTMLImageElement;
    const alt = img.alt?.trim() || 'image';
    const src = img.src || '';
    if (!src) return `![${alt}]`;
    return `![${alt}](${src})`;
  }
});

// Tighter blockquotes (avoid extra blank lines)
td.addRule('blockquoteTight', {
  filter: 'blockquote',
  replacement: (content) =>
    '\n' + content.split('\n').map(l => (l ? '> ' + l : '>')).join('\n') + '\n'
});

// Cleanup
function tidyMarkdown(md: string) {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '');
}

function htmlToMarkdown(html: string): string {
  // Work on a detached element so we can strip UI chrome if we want
  const container = document.createElement('div');
  container.innerHTML = html;

  // Strip common chrome
  container.querySelectorAll('button,svg,nav,[data-testid="toolbar"]').forEach(n => n.remove());

  const md = td.turndown(container.innerHTML);
  return tidyMarkdown(md);
}

// ---------------- Pure Markdown (uses HTML bodies) ----------------

function toPureMarkdownChatStyleFromHtml(
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  htmlBodies: string[], // 1:1 with turns
  opts?: {
    title?: string;
    includeFrontMatter?: boolean;
    includeMetaRow?: boolean;
    hrBetween?: boolean;
    freeformNotes?: string;
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

  const blocks = turns.map((t, i) => {
    const label = roleLabel(t.role);
    const bodyMd = htmlToMarkdown(htmlBodies[i] || ''); // ← use converted HTML
    const body = (bodyMd || t.text || '').replace(/\r\n/g, '\n').trimEnd();
    return `**${label}:**  \n${body}`;
  });

  out.push(blocks.join(sep));

  if (freeformNotes && freeformNotes.trim()) {
    out.push('', '## Notes', '', freeformNotes.trim(), '');
  }

  if (out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}

// ---------------- Format-aware builder ----------------

/**
 * Chooses between:
 * - 'markdown_pure'  => ChatGPT Exporter–style Markdown using per-turn HTML bodies
 * - 'markdown_html'  => your existing YAML + transcript block (legacy)
 */
export function buildMarkdownExportByFormat(
  format: 'markdown_html' | 'markdown_pure',
  meta: ExportNoteMetadata,
  turns: ExportTurn[],
  opts?: {
    title?: string;
    freeformNotes?: string;
    includeFrontMatter?: boolean;
    htmlBodies?: string[]; // required for Pure MD
  }
): string {
  const metaWithTitle: ExportNoteMetadata = opts?.title
    ? { ...meta, chatTitle: opts.title }
    : meta;

  if (format === 'markdown_pure') {
    const htmlBodies = opts?.htmlBodies ?? [];
    // Fallback: if not provided, degrade gracefully to text-only (old behavior)
    if (!htmlBodies.length || htmlBodies.length !== turns.length) {
      // Degrade to text-only Pure style
      const sep = '\n---\n\n';
      const head = (opts?.includeFrontMatter ?? true) ? renderFrontMatter(metaWithTitle) : '';
      const title = metaWithTitle.chatTitle || 'Chat Export';
      const metaLines = [
        head,
        `# ${title}`,
        '',
        metaWithTitle.pageUrl ? `Source: ${metaWithTitle.pageUrl}` : '',
        metaWithTitle.exportedAt ? `Exported: ${metaWithTitle.exportedAt}` : '',
        ''
      ].filter(Boolean).join('\n');

      const blocks = turns.map((t) => {
        const label = roleLabel(t.role);
        const body = (t.text || '').replace(/\r\n/g, '\n').trimEnd();
        return `**${label}:**  \n${body}`;
      });

      const body = blocks.join(sep);
      const notes = opts?.freeformNotes?.trim() ? `\n\n## Notes\n\n${opts.freeformNotes.trim()}\n` : '';
      return `${metaLines}${body}${notes}${body.endsWith('\n') ? '' : '\n'}`;
    }

    return toPureMarkdownChatStyleFromHtml(
      metaWithTitle,
      turns,
      htmlBodies,
      {
        title: metaWithTitle.chatTitle,
        includeFrontMatter: opts?.includeFrontMatter ?? true,
        includeMetaRow: true,
        hrBetween: true,
        freeformNotes: opts?.freeformNotes,
      }
    );
  }

  // Legacy exporter
  return toMarkdownWithFrontMatter(metaWithTitle, turns, opts?.freeformNotes);
}
