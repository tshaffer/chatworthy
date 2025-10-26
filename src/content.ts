// Mark as a module (good for TS/isolatedModules)
export {};

import type { ChatTurn, ConversationExport } from './types';
import { toMarkdownWithFrontMatter } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  Chatsworthy Content Script (hardened)
 *  - Singleton guard (skip duplicate/iframe injections)
 *  - Idempotent UI creation (#chatworthy-root)
 *  - Burst coalescing via scheduleEnsure()
 *  - MutationObserver throttled + suspended during our own writes
 *  - Self-mutation filtering (ignore changes under our root)
 *  - Emergency kill switch (URL param or localStorage flag)
 * ------------------------------------------------------------
 */

// ---- Config ------------------------------------------------

const ROOT_ID = 'chatsworthy-root';              // stable UI root
const LIST_ID = 'chatworthy-list';
const CONTROLS_ID = 'chatworthy-controls';
const EXPORT_BTN_ID = 'chatworthy-export-btn';

// throttle: minimum ms between observer-driven reflows
const OBSERVER_THROTTLE_MS = 200;

// ---- Singleton + Killswitch -------------------------------

(() => {
  const w = window as any;

  // Emergency off: add ?chatsworthy-disable to URL or set localStorage key
  try {
    const disabled =
      localStorage.getItem('chatsworthy:disable') === '1' ||
      new URLSearchParams(location.search).has('chatsworthy-disable');
    if (disabled) {
      console.warn('[Chatsworthy] Disabled by kill switch');
      return;
    }
  } catch { /* ignore */ }

  // Skip if we already initialized (or if injected in an iframe)
  if (w.__chatsworthy_init__) return;
  w.__chatsworthy_init__ = true;

  if (window.top !== window) {
    // If you need iframes, remove this return
    return;
  }

  init().catch(err => console.error('[Chatsworthy] init failed', err));
})();

// ---- Core --------------------------------------------------

function getTitle(): string {
  const h1 = document.querySelector('h1, header h1, [data-testid="conversation-title"]');
  const title = (h1?.textContent || document.title || 'ChatGPT Conversation').trim();
  return title.replace(/[\n\r]+/g, ' ');
}

function extractTurns(): ChatTurn[] {
  const turns: ChatTurn[] = [];

  const nodes = Array.from(
    document.querySelectorAll(
      '[data-message-author-role], article[data-testid^="conversation-turn"], [data-testid^="conversation-turn"]'
    )
  ) as HTMLElement[];

  const roleFromEl = (el: HTMLElement): ChatTurn['role'] => {
    const r = el.getAttribute('data-message-author-role');
    if (r === 'assistant' || r === 'user' || r === 'system' || r === 'tool') return r as any;
    const txt = el.textContent?.toLowerCase() || '';
    if (txt.includes('assistant')) return 'assistant';
    if (txt.includes('user')) return 'user';
    return 'assistant';
  };

  nodes.forEach(el => {
    const content =
      (el.querySelector('[data-message-content], .markdown.prose, .prose, [data-testid="assistant-response"]') as HTMLElement) ||
      el;
    const html = content.innerHTML || '';
    const text = content.innerText || content.textContent || '';
    const role = roleFromEl(el);
    if (!html.trim() && (role === 'system' || role === 'tool')) return;
    turns.push({ role, html, text });
  });

  // Deduplicate adjacent-ish repeats
  const uniq: ChatTurn[] = [];
  const seen = new Set<string>();
  for (const t of turns) {
    const key = t.role + '|' + (t.text || '').slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(t);
    }
  }
  return uniq;
}

function buildExport(): ConversationExport {
  return {
    title: getTitle(),
    url: location.href,
    exportedAt: new Date().toISOString(),
    turns: extractTurns(),
  };
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function filenameBase(): string {
  const t = getTitle().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
  ].join('');
  return `${t || 'chat'}-${stamp}`;
}

function summarizePromptText(s: string, max = 60): string {
  const t = (s || '')
    .replaceAll('<br>', '\n')
    .replace(/<\/(p|div|li)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ---- UI: idempotent ensure + minimal updates ---------------

/**
 * Ensures the floating UI exists (idempotent) and updates the list.
 * Wrapped with observer suspension to avoid self-trigger loops.
 */
function ensureFloatingUI() {
  suspendObservers(true);
  try {
    // Create root once
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.style.position = 'fixed';
      root.style.right = '16px';
      root.style.bottom = '16px';
      root.style.zIndex = '2147483647';

      // Prefer body to minimize layout thrash on html element
      (document.body || document.documentElement).appendChild(root);

      // Build inner structure once
      const list = document.createElement('div');
      list.id = LIST_ID;

      const controls = document.createElement('div');
      controls.id = CONTROLS_ID;

      const btnAll = document.createElement('button');
      btnAll.textContent = 'All';

      const btnNone = document.createElement('button');
      btnNone.textContent = 'None';

      const exportBtn = document.createElement('button');
      exportBtn.id = EXPORT_BTN_ID;
      exportBtn.textContent = 'Export';

      controls.appendChild(btnAll);
      controls.appendChild(btnNone);
      controls.appendChild(exportBtn);

      root.appendChild(list);
      root.appendChild(controls);

      // Wire up control handlers (stable references)
      btnAll.onclick = () => root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = true));
      btnNone.onclick = () => root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = false));
      exportBtn.onclick = () => {
        const data = buildExport();
        const sel: number[] = [];
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
          if (cb.checked) sel.push(parseInt(cb.dataset.uindex || '0', 10));
        });
        const md = toMarkdownWithFrontMatter(data, sel);
        const blob = new Blob([md], { type: 'text/markdown' });
        download(`${filenameBase()}.md`, blob);
      };
    }

    // Update list efficiently
    const data = buildExport();
    const promptIndexes: number[] = [];
    data.turns.forEach((t, i) => {
      if (t.role === 'user') promptIndexes.push(i);
    });

    const listEl = document.getElementById(LIST_ID)!;

    // Clear & rebuild items (cheap DOM, but done while observer is suspended)
    listEl.innerHTML = '';
    for (const uIdx of promptIndexes) {
      const item = document.createElement('label');
      item.className = 'chatworthy-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.uindex = String(uIdx);

      const span = document.createElement('span');
      span.className = 'chatworthy-item-text';
      span.textContent = summarizePromptText(data.turns[uIdx].html || data.turns[uIdx].text || '');

      item.appendChild(cb);
      item.appendChild(span);
      listEl.appendChild(item);
    }
  } finally {
    suspendObservers(false);
  }
}

// ---- Observer: throttled + self-filtering ------------------

let observersSuspended = false;
function suspendObservers(v: boolean) {
  observersSuspended = v;
}

let lastObserverRun = 0;
const mo = new MutationObserver(mutationList => {
  if (observersSuspended) return;

  // Ignore any mutations under our own root to avoid self-trigger loops
  const root = document.getElementById(ROOT_ID);
  if (root) {
    for (const m of mutationList) {
      const target = m.target as Node;
      if (root.contains(target)) {
        return; // skip this batch entirely
      }
    }
  }

  // Throttle observer-driven updates
  const now = performance.now();
  if (now - lastObserverRun < OBSERVER_THROTTLE_MS) return;
  lastObserverRun = now;

  scheduleEnsure();
});

function startObserving() {
  const target = document.body || document.documentElement;
  mo.observe(target, {
    childList: true,
    subtree: true,
    attributes: false, // keep false unless you truly need attribute changes
  });
}

// ---- Burst coalescing --------------------------------------

let scheduled = false;
function scheduleEnsure() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    // If requestIdleCallback is unavailable, just run now
    const run = () => {
      scheduled = false;
      ensureFloatingUI();
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(run, { timeout: 1500 });
    } else {
      run();
    }
  });
}

// ---- Init --------------------------------------------------

async function init() {
  console.log('[Chatsworthy] content script active');
  startObserving();
  scheduleEnsure(); // initial render
}
