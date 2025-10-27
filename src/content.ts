// Mark as a module (good for TS/isolatedModules)
export { };

import type { ConversationExport, ExportNoteMetadata, ExportTurn } from './types';
import { toMarkdownWithFrontMatter } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  Chatsworthy Content Script (v2 — Chatalog-ready)
 *  - Floating “Export” UI
 *  - Robust observer for new messages
 *  - New buildExport + downloadExport (YAML front matter + transcript)
 * ------------------------------------------------------------
 */

// ---- Config ------------------------------------------------

const ROOT_ID = 'chatsworthy-root';
const LIST_ID = 'chatworthy-list';
const CONTROLS_ID = 'chatworthy-controls';
const EXPORT_BTN_ID = 'chatworthy-export-btn';

const OBSERVER_THROTTLE_MS = 200;

// ---- Singleton + Killswitch -------------------------------

(() => {
  const w = window as any;

  // Emergency off
  try {
    const disabled =
      localStorage.getItem('chatsworthy:disable') === '1' ||
      new URLSearchParams(location.search).has('chatsworthy-disable');
    if (disabled) {
      console.warn('[Chatsworthy] Disabled by kill switch');
      return;
    }
  } catch { }

  // Singleton guard
  if (w.__chatsworthy_init__) return;
  w.__chatsworthy_init__ = true;

  // Skip iframes
  if (window.top !== window) return;

  init().catch(err => console.error('[Chatsworthy] init failed', err));
})();

// ---- Helpers -----------------------------------------------

function getTitle(): string {
  const h1 = document.querySelector('h1, header h1, [data-testid="conversation-title"]');
  const title = (h1?.textContent || document.title || 'ChatGPT Conversation').trim();
  return title.replace(/[\n\r]+/g, ' ');
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

/**
 * Utility: safe UUID
 */
function generateNoteId(): string {
  try {
    return `ext-${crypto.randomUUID()}`;
  } catch {
    return `ext-${Math.random().toString(36).slice(2)}${Date.now()}`;
  }
}

/**
 * Utility: extract chat ID from the current ChatGPT URL.
 */
function getChatIdFromUrl(href: string): string | undefined {
  const match = href.match(/\/c\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

/**
 * Utility: scrape visible message turns on the page.
 */
function extractTurns(): ExportTurn[] {
  const nodes = document.querySelectorAll('[data-message-author-role]');
  const turns: ExportTurn[] = [];

  nodes.forEach((el) => {
    const role = (el.getAttribute('data-message-author-role') as 'user' | 'assistant') ?? 'assistant';
    const text = (el.textContent ?? '').trim();
    if (text) {
      turns.push({ role, text });
    }
  });

  return turns;
}

/**
 * ✅ New export builder — builds full metadata and markdown content
 */
function buildExport(subject = '', topic = '', notes = ''): string {
  const turns = extractTurns();

  const meta: ExportNoteMetadata = {
    noteId: generateNoteId(),
    source: 'chatgpt',
    chatId: getChatIdFromUrl(location.href),
    chatTitle: document.title,
    pageUrl: location.href,
    exportedAt: new Date().toISOString(),
    model: undefined, // optional, could be scraped if visible

    subject,
    topic,

    summary: null,
    tags: [],
    autoGenerate: { summary: true, tags: true },

    noteMode: 'auto',
    turnCount: turns.length,
    splitHints: [],

    author: 'me',
    visibility: 'private',
  };

  return toMarkdownWithFrontMatter(meta, turns, notes);
}

/**
 * Downloads the built markdown file
 */
export function downloadExport(filename: string, data: string | Blob) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Give the download a moment to start before revoking
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

// ---- Floating UI -------------------------------------------

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
      root.style.background = 'rgba(255,255,255,0.9)';
      root.style.padding = '8px';
      root.style.borderRadius = '8px';
      root.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';

      (document.body || document.documentElement).appendChild(root);

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

      // Wire up controls
      btnAll.onclick = () =>
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = true));
      btnNone.onclick = () =>
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = false));

      exportBtn.onclick = () => {
        // Single-click export — full conversation
        downloadExport();
      };
    }

    // Update list
    const turns = extractTurns();
    const promptIndexes: number[] = [];
    turns.forEach((t, i) => {
      if (t.role === 'user') promptIndexes.push(i);
    });

    const listEl = document.getElementById(LIST_ID)!;
    listEl.innerHTML = '';

    for (const uIdx of promptIndexes) {
      const item = document.createElement('label');
      item.className = 'chatworthy-item';
      item.style.display = 'block';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.uindex = String(uIdx);

      const span = document.createElement('span');
      span.className = 'chatworthy-item-text';
      span.textContent = summarizePromptText((turns[uIdx] as any).text || '');

      item.appendChild(cb);
      item.appendChild(span);
      listEl.appendChild(item);
    }
  } finally {
    suspendObservers(false);
  }
}

// ---- Observer + scheduling ---------------------------------

let mo: MutationObserver | null = null;
let observersSuspended = false;
let lastObserverRun = 0;
let scheduled = false;

function suspendObservers(v: boolean) {
  observersSuspended = v;
}

function makeObserver(): MutationObserver {
  return new MutationObserver((mutationList) => {
    if (observersSuspended) return;

    const root = document.getElementById(ROOT_ID);
    if (root) {
      for (const m of mutationList) {
        const target = m.target as Node;
        if (root.contains(target)) return;
      }
    }

    const now = performance.now();
    if (now - lastObserverRun < OBSERVER_THROTTLE_MS) return;
    lastObserverRun = now;

    scheduleEnsure();
  });
}

function startObserving() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof MutationObserver === 'undefined') return;

  const target = document.body || document.documentElement;
  if (!target) return;

  if (!mo) mo = makeObserver();
  try { mo.disconnect(); } catch { }
  mo.observe(target, { childList: true, subtree: true });
}

function scheduleEnsure() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
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
  const host = location.host || '';
  if (!/^(chatgpt\.com|chat\.openai\.com)$/i.test(host)) {
    console.warn('[Chatsworthy] Host not allowed; skipping init:', host);
    return;
  }

  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    );
  }

  console.log('[Chatsworthy] content script active');
  startObserving();
  scheduleEnsure();
}

