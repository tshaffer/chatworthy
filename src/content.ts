// Mark as a module (good for TS/isolatedModules)
export { };

import type { ExportNoteMetadata, ExportTurn } from './types';
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

  // Skip iframes unless you need them
  if (window.top !== window) return;

  // Defer into init with guards
  init().catch(err => console.error('[Chatsworthy] init failed', err));
})();

// ---- Core --------------------------------------------------

function getTitle(): string {
  const h1 = document.querySelector('h1, header h1, [data-testid="conversation-title"]');
  const title = (h1?.textContent || document.title || 'ChatGPT Conversation').trim();
  return title.replace(/[\n\r]+/g, ' ');
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
        // Minimal: export the full conversation in the new Chatalog-ready format.
        // If you later want subject/topic/notes, pass them here.
        downloadExport();
      };

      // Update list efficiently
      // const data = buildExport();
      // const promptIndexes: number[] = [];
      // data.turns.forEach((t, i) => {
      //   if (t.role === 'user') promptIndexes.push(i);
      // });
      // Populate the list from extracted turns (UI is optional; export ignores selection).
      const turns = extractTurns();
      const promptIndexes: number[] = [];
      turns.forEach((t, i) => {
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
        // span.textContent = summarizePromptText(data.turns[uIdx].html || data.turns[uIdx].text || '');
        span.textContent = summarizePromptText((turns[uIdx] as any).text || '');

        item.appendChild(cb);
        item.appendChild(span);
        listEl.appendChild(item);
      }
    }
  } finally {
    suspendObservers(false);
  }
}

// ---- Observer: throttled + self-filtering ------------------

// ---- Observer: throttled + self-filtering ------------------

// Keep a nullable handle
let mo: MutationObserver | null = null;
let observersSuspended = false;

function suspendObservers(v: boolean) {
  observersSuspended = v;
}

let lastObserverRun = 0;

function makeObserver(): MutationObserver {
  // Type-safe creation inside a function
  return new MutationObserver((mutationList) => {
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
}

function startObserving() {
  // Hard guards: only in page contexts with a DOM
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    console.warn('[Chatsworthy] No DOM available; skipping observer');
    return;
  }
  if (typeof MutationObserver === 'undefined') {
    console.warn('[Chatsworthy] MutationObserver not available; skipping observer');
    return;
  }

  // Scope to body first, fall back to documentElement
  const target = document.body || document.documentElement;
  if (!target) {
    console.warn('[Chatsworthy] No observation target; skipping observer');
    return;
  }

  // Create once
  if (!mo) mo = makeObserver();

  // Defensive: disconnect before re-observe (in case of re-init)
  try { mo.disconnect(); } catch { }

  mo.observe(target, {
    childList: true,
    subtree: true,
    attributes: false,
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
  // Only run on intended hosts (extra safety)
  const host = location.host || '';
  if (!/^(chatgpt\.com|chat\.openai\.com)$/i.test(host)) {
    console.warn('[Chatsworthy] Host not allowed; skipping init:', host);
    return;
  }

  // Wait for a usable DOM before touching it
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  console.log('[Chatsworthy] content script active');
  startObserving();
  scheduleEnsure(); // initial render
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
 * Works for both chat.openai.com/c/<id> and chatgpt.com/c/<id>.
 */
function getChatIdFromUrl(href: string): string | undefined {
  const match = href.match(/\/c\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

/**
 * Utility: scrape visible message turns on the page.
 * Assumes ChatGPT DOM elements have [data-message-author-role].
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
 * ✅ New export builder — replaces old ConversationExport.
 * Builds full metadata and markdown content for Chatalog ingestion.
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

  // Build Markdown text with YAML front matter
  const markdown = toMarkdownWithFrontMatter(meta, turns, notes);
  return markdown;
}

/**
 * Example trigger: build and download a Markdown export
 */
function downloadExport(subject = '', topic = '', notes = '') {
  const markdown = buildExport(subject, topic, notes);
  const fileName = `${document.title.replace(/[^\w\-]+/g, '_').slice(0, 80)}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: fileName,
    saveAs: true,
  });
}
