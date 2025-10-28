// Mark as a module (good for TS/isolatedModules)

import type { ExportNoteMetadata, ExportTurn } from './types';
import { toMarkdownWithFrontMatter } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  Chatsworthy Content Script (v2 — Chatalog-ready)
 *  - Floating “Export” UI (collapsible)
 *  - Robust observer for new messages
 *  - New buildExport + downloadExport (YAML front matter + transcript)
 * ------------------------------------------------------------
 */

// ---- Config ------------------------------------------------

const ROOT_ID = 'chatsworthy-root';
const LIST_ID = 'chatworthy-list';
const CONTROLS_ID = 'chatworthy-controls';
const EXPORT_BTN_ID = 'chatworthy-export-btn';
const TOGGLE_BTN_ID = 'chatworthy-toggle-btn';

const OBSERVER_THROTTLE_MS = 200;
const COLLAPSE_LS_KEY = 'chatsworthy:collapsed';

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
  } catch { /* ignore */ }

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

const meta = {
  noteId: generateNoteId(),
  source: 'chatgpt',
  chatId: getChatIdFromUrl(location.href),
  chatTitle: document.title,
  pageUrl: location.href,
  exportedAt: new Date().toISOString(),
  model: undefined,

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
} satisfies ExportNoteMetadata;

  return toMarkdownWithFrontMatter(meta, turns, notes);
}

/**
 * Downloads the built markdown file
 */
function downloadExport(filename: string, data: string | Blob) {
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

// ---- Collapsed state helpers -------------------------------

function getInitialCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(COLLAPSE_LS_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch { /* ignore */ }
  // Default: collapsed
  return true;
}

function setCollapsed(v: boolean) {
  try { localStorage.setItem(COLLAPSE_LS_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  const root = document.getElementById(ROOT_ID);
  const listEl = document.getElementById(LIST_ID) as HTMLDivElement | null;
  const toggleBtn = document.getElementById(TOGGLE_BTN_ID) as HTMLButtonElement | null;

  if (root) root.setAttribute('data-collapsed', v ? '1' : '0');
  if (listEl) listEl.style.display = v ? 'none' : 'block';
  if (toggleBtn) toggleBtn.textContent = v ? 'Show List' : 'Hide List';
}

// ---- Floating UI -------------------------------------------

function ensureFloatingUI() {
  suspendObservers(true);
  try {
    // Create root once
    let root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;

      // Layout & position: upper-right, offset from top by 80px; list grows downward under controls
      root.style.position = 'fixed';
      root.style.right = '16px';
      root.style.top = '80px';
      root.style.zIndex = '2147483647';
      root.style.background = 'rgba(255,255,255,0.95)';
      root.style.padding = '8px';
      root.style.borderRadius = '8px';
      root.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
      root.style.display = 'flex';
      root.style.flexDirection = 'column';
      root.style.gap = '8px';
      root.style.maxWidth = '340px';

      (document.body || document.documentElement).appendChild(root);

      // Controls (row)
      const controls = document.createElement('div');
      controls.id = CONTROLS_ID;
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.gap = '6px';
      controls.style.flexWrap = 'wrap';

      const toggleBtn = document.createElement('button');
      toggleBtn.id = TOGGLE_BTN_ID;
      toggleBtn.type = 'button';
      toggleBtn.textContent = 'Show List';
      toggleBtn.style.fontWeight = '600';

      const btnAll = document.createElement('button');
      btnAll.type = 'button';
      btnAll.textContent = 'All';

      const btnNone = document.createElement('button');
      btnNone.type = 'button';
      btnNone.textContent = 'None';

      const exportBtn = document.createElement('button');
      exportBtn.id = EXPORT_BTN_ID;
      exportBtn.type = 'button';
      exportBtn.textContent = 'Export';

      controls.appendChild(toggleBtn);
      controls.appendChild(btnAll);
      controls.appendChild(btnNone);
      controls.appendChild(exportBtn);

      // List (below controls; grows downward)
      const list = document.createElement('div');
      list.id = LIST_ID;
      list.style.display = 'none';               // collapsed by default
      list.style.overflow = 'auto';
      list.style.maxHeight = '50vh';
      list.style.minWidth = '220px';

      // Add into root in order: controls, then list
      root.appendChild(controls);
      root.appendChild(list);

      // Wire up controls
      toggleBtn.onclick = () => {
        const isCollapsed = root!.getAttribute('data-collapsed') !== '0';
        setCollapsed(!isCollapsed);
      };

      btnAll.onclick = () =>
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = true));

      btnNone.onclick = () =>
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => (cb.checked = false));

      exportBtn.onclick = () => {
        try {
          const md = buildExport();                  // builds meta + turns -> markdown
          downloadExport(`${filenameBase()}.md`, md); // pass filename + content
        } catch (err) {
          console.error('[Chatsworthy] export failed:', err);
          alert('Export failed — see console for details.');
        }
      };

      // Initialize collapsed/expanded state
      setCollapsed(getInitialCollapsed());
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
      item.style.display = 'flex';
      item.style.alignItems = 'flex-start';
      item.style.gap = '6px';
      item.style.margin = '4px 0';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.uindex = String(uIdx);

      const span = document.createElement('span');
      span.className = 'chatworthy-item-text';
      span.textContent = summarizePromptText((turns[uIdx] as any).text || '');
      span.style.lineHeight = '1.2';

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
  try { mo.disconnect(); } catch { /* ignore */ }
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
