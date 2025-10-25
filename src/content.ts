
import type { ChatTurn, ConversationExport } from './types';
import { toMarkdown } from './utils/exporters';

function getTitle(): string {
  const h1 = document.querySelector('h1, header h1, [data-testid="conversation-title"]');
  const title = (h1?.textContent || document.title || 'ChatGPT Conversation').trim();
  return title.replace(/[\n\r]+/g, ' ');
}

function extractTurns(): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const nodes = Array.from(document.querySelectorAll('[data-message-author-role], article[data-testid^="conversation-turn"], [data-testid^="conversation-turn"]')) as HTMLElement[];
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
  const uniq: ChatTurn[] = []; const seen = new Set<string>();
  for (const t of turns) { const key = t.role + '|' + t.text.slice(0, 80); if (!seen.has(key)) { seen.add(key); uniq.push(t); } }
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
  const stamp = [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0'), String(d.getHours()).padStart(2,'0'), String(d.getMinutes()).padStart(2,'0')].join('');
  return `${t || 'chat'}-${stamp}`;
}

function ensureFloatingButton() {
  if (document.getElementById('chatworthy-export-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'chatworthy-export-btn'; btn.textContent = 'Export (MD)';
  btn.title = 'Chatworthy export — click to download Markdown (Shift+Click for JSON)';
  btn.addEventListener('click', (e) => {
    const data = buildExport(); const base = filenameBase();
    if ((e as MouseEvent).shiftKey) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); download(`${base}.json`, blob);
    } else {
      const md = toMarkdown(data); const blob = new Blob([md], { type: 'text/markdown' }); download(`${base}.md`, blob);
    }
  });
  document.documentElement.appendChild(btn);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CHATWORTHY_EXPORT') {
    const data = buildExport(); const base = filenameBase();
    if (msg.format === 'json') {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); download(`${base}.json`, blob);
    } else {
      const md = toMarkdown(data); const blob = new Blob([md], { type: 'text/markdown' }); download(`${base}.md`, blob);
    }
  }
});

ensureFloatingButton();
const obs = new MutationObserver(() => ensureFloatingButton());
obs.observe(document.documentElement, { childList: true, subtree: true });
