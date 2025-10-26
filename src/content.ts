import type { ChatTurn, ConversationExport } from './types';
import { toMarkdownWithFrontMatter } from './utils/exporters';

function getTitle(): string {
  const h1 = document.querySelector('h1, header h1, [data-testid="conversation-title"]');
  const title = (h1?.textContent || document.title || 'ChatGPT Conversation').trim();
  return title.replace(/[\n\r]+/g, ' ');
}

function extractTurns(): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const nodes = Array.from(document.querySelectorAll(
    '[data-message-author-role], article[data-testid^="conversation-turn"], [data-testid^="conversation-turn"]'
  )) as HTMLElement[];

  const roleFromEl = (el: HTMLElement): ChatTurn['role'] => {
    const roleAttr = el.getAttribute('data-message-author-role');
    if (roleAttr === 'assistant' || roleAttr === 'user' || roleAttr === 'system' || roleAttr === 'tool') return roleAttr;
    const txt = el.textContent?.toLowerCase() || '';
    if (txt.includes('assistant')) return 'assistant';
    if (txt.includes('user')) return 'user';
    return 'assistant';
  };

  nodes.forEach((el) => {
    const content = (el.querySelector('[data-message-content], .markdown.prose, .prose, [data-testid="assistant-response"]') as HTMLElement) || el;
    const html = content.innerHTML || '';
    const text = content.innerText || content.textContent || '';
    const role = roleFromEl(el);
    if (!html.trim() && (role === 'system' || role === 'tool')) return;
    turns.push({ role, html, text });
  });

  // de-dupe
  const uniq: ChatTurn[] = [];
  const seen = new Set<string>();
  for (const t of turns) {
    const key = t.role + '|' + (t.text || '').slice(0, 80);
    if (!seen.has(key)) { seen.add(key); uniq.push(t); }
  }
  return uniq;
}

function buildExport(): ConversationExport {
  return { title: getTitle(), url: location.href, exportedAt: new Date().toISOString(), turns: extractTurns() };
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
}

function filenameBase(): string {
  const t = getTitle().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const d = new Date();
  const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0')].join('');
  return `${t || 'chat'}-${stamp}`;
}

function summarizePromptText(htmlOrText: string, max = 60): string {
  const text = (htmlOrText || '')
    .replaceAll('<br>', '\n')
    .replace(/<\/(p|div|li)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function ensureFloatingUI() {
  const existing = document.getElementById('chatworthy-ui');
  const data = buildExport();

  // collect indexes of user prompts
  const promptIndexes: number[] = [];
  data.turns.forEach((t, i) => { if (t.role === 'user') promptIndexes.push(i); });

  if (!existing) {
    const wrap = document.createElement('div');
    wrap.id = 'chatworthy-ui';

    const list = document.createElement('div');
    list.id = 'chatworthy-list';

    // controls
    const controls = document.createElement('div'); controls.id = 'chatworthy-controls';
    const btnAll = document.createElement('button'); btnAll.textContent = 'All'; btnAll.title = 'Select all prompts';
    const btnNone = document.createElement('button'); btnNone.textContent = 'None'; btnNone.title = 'Clear selection';
    const exportBtn = document.createElement('button'); exportBtn.id = 'chatworthy-export-btn'; exportBtn.textContent = 'Export';
    exportBtn.title = 'Export selected prompts as Markdown with front matter';

    controls.appendChild(btnAll);
    controls.appendChild(btnNone);
    controls.appendChild(exportBtn);

    wrap.appendChild(list);
    wrap.appendChild(controls);
    document.documentElement.appendChild(wrap);

    btnAll.addEventListener('click', () => {
      wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => { cb.checked = true; });
    });
    btnNone.addEventListener('click', () => {
      wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => { cb.checked = false; });
    });
    exportBtn.addEventListener('click', () => {
      const selected: number[] = [];
      wrap.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => {
        if (cb.checked) selected.push(parseInt(cb.getAttribute('data-uindex') || '0', 10));
      });
      const md = toMarkdownWithFrontMatter(data, selected);
      const blob = new Blob([md], { type: 'text/markdown' });
      download(`${filenameBase()}.md`, blob);
    });
  }

  // (Re)render prompt list
  const list = document.getElementById('chatworthy-list')!;
  list.innerHTML = '';
  promptIndexes.forEach((uIdx) => {
    const item = document.createElement('label');
    item.className = 'chatworthy-item';

    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.setAttribute('data-uindex', String(uIdx));

    const span = document.createElement('span'); span.className = 'chatworthy-item-text';
    span.textContent = summarizePromptText(data.turns[uIdx].html || data.turns[uIdx].text || '');

    item.appendChild(cb);
    item.appendChild(span);
    list.appendChild(item);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CHATWORTHY_EXPORT') {
    const data = buildExport();
    const wrap = document.getElementById('chatworthy-ui');
    const selected: number[] = [];
    wrap?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => {
      if (cb.checked) selected.push(parseInt(cb.getAttribute('data-uindex') || '0', 10));
    });
    const md = toMarkdownWithFrontMatter(data, selected);
    const blob = new Blob([md], { type: 'text/markdown' });
    download(`${filenameBase()}.md`, blob);
  }
});

ensureFloatingUI();
const obs = new MutationObserver(() => ensureFloatingUI());
obs.observe(document.documentElement, { childList: true, subtree: true });
