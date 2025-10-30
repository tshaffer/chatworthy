// Mark as a module (good for TS/isolatedModules)

import type { ExportNoteMetadata, ExportTurn } from './types';
// Format-aware builder (now supports passing per-turn HTML bodies for Pure MD)
import { buildMarkdownExportByFormat } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  Chatsworthy Content Script (v2 — Chatalog-ready)
 *  - Floating “Export” UI (collapsible)
 *  - Robust observer for new messages
 *  - Adds a "Pure Markdown" export option (no embedded HTML)
 *  - Relabels "You/ChatGPT" -> "Prompt/Response" and unifies Prompt styling
 * ------------------------------------------------------------
 */

// ---- Config ------------------------------------------------

const ROOT_ID = 'chatsworthy-root';
const LIST_ID = 'chatworthy-list';
const CONTROLS_ID = 'chatworthy-controls';
const EXPORT_BTN_ID = 'chatworthy-export-btn';
const TOGGLE_BTN_ID = 'chatworthy-toggle-btn';
const ALL_BTN_ID = 'chatworthy-all-btn';
const NONE_BTN_ID = 'chatworthy-none-btn';
const PURE_MD_CHECKBOX_ID = 'chatworthy-pure-md';

const OBSERVER_THROTTLE_MS = 200;
const COLLAPSE_LS_KEY = 'chatsworthy:collapsed';
const FORMAT_LS_KEY = 'chatsworthy:export-format';

// Local union here so you don't need to change your global types immediately.
type ExportFormat = 'markdown_html' | 'markdown_pure';

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

function getSelectedPromptIndexes(): number[] {
  const root = document.getElementById(ROOT_ID);
  if (!root) return [];
  const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]'));
  return boxes
    .filter(cb => cb.checked)
    .map(cb => Number(cb.dataset.uindex))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * Scrape visible message turns on the page and keep a parallel array of elements.
 */
function getAllMessageEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role]'));
}

function extractTurns(): ExportTurn[] {
  const nodes = getAllMessageEls();
  const turns: ExportTurn[] = [];

  nodes.forEach((el) => {
    const role = (el.getAttribute('data-message-author-role') as 'user' | 'assistant' | 'system' | 'tool') ?? 'assistant';
    const text = (el.textContent ?? '').trim();
    // We keep text for the legacy exporter; Pure MD will use outerHTML bodies
    if (text) {
      turns.push({ role, text });
    } else {
      // Still push an empty message to preserve index alignment with DOM list
      turns.push({ role, text: '' });
    }
  });

  return turns;
}

/**
 * Compute the selected ranges of turns (user turn + following non-user turns until next user).
 * Returns both the ExportTurn[] and a DOM outerHTML[] aligned 1:1 with those turns.
 */
function buildSelectedPayload(): { turns: ExportTurn[]; htmlBodies: string[] } {
  const allTurns = extractTurns();
  const allEls = getAllMessageEls();
  const selectedUserIdxs = getSelectedPromptIndexes();
  if (selectedUserIdxs.length === 0) return { turns: [], htmlBodies: [] };

  const turns: ExportTurn[] = [];
  const htmlBodies: string[] = [];

  for (let i = 0; i < selectedUserIdxs.length; i++) {
    const uIdx = selectedUserIdxs[i];
    const nextU = (i + 1 < selectedUserIdxs.length) ? selectedUserIdxs[i + 1] : allTurns.length;

    // include selected user turn
    if (uIdx >= 0 && uIdx < allTurns.length) {
      turns.push(allTurns[uIdx]);
      htmlBodies.push(allEls[uIdx]?.outerHTML ?? '');
    }

    // include everything after that user turn until the next user turn
    for (let j = uIdx + 1; j < nextU; j++) {
      if (j >= 0 && j < allTurns.length) {
        turns.push(allTurns[j]);
        htmlBodies.push(allEls[j]?.outerHTML ?? '');
      }
    }
  }

  return { turns, htmlBodies };
}

function getSelectionStats(): { total: number; selected: number } {
  const root = document.getElementById(ROOT_ID);
  if (!root) return { total: 0, selected: 0 };
  const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]'));
  const selected = boxes.filter(cb => cb.checked).length;
  return { total: boxes.length, selected };
}

function updateControlsState() {
  const { total, selected } = getSelectionStats();

  const allBtn = document.getElementById(ALL_BTN_ID) as HTMLButtonElement | null;
  const noneBtn = document.getElementById(NONE_BTN_ID) as HTMLButtonElement | null;
  const expBtn = document.getElementById(EXPORT_BTN_ID) as HTMLButtonElement | null;

  // Disable "All" when all are already selected (and there is at least one)
  if (allBtn) allBtn.disabled = total > 0 && selected === total;

  // Disable "None" when none are selected
  if (noneBtn) noneBtn.disabled = selected === 0;

  // Disable "Export" when none are selected
  if (expBtn) expBtn.disabled = selected === 0;
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

// ---- Export Format State -----------------------------------

function getInitialExportFormat(): ExportFormat {
  try {
    const raw = localStorage.getItem(FORMAT_LS_KEY);
    if (raw === 'markdown_pure' || raw === 'markdown_html') return raw;
  } catch { /* ignore */ }
  return 'markdown_html'; // default to current behavior
}

let exportFormat: ExportFormat = getInitialExportFormat();

function setExportFormat(fmt: ExportFormat) {
  exportFormat = fmt;
  try { localStorage.setItem(FORMAT_LS_KEY, fmt); } catch { /* ignore */ }
}

function buildExportFromTurns(
  turns: ExportTurn[],
  subject = '',
  topic = '',
  notes = '',
  htmlBodies?: string[] // 1:1 with turns (only used for Pure MD)
): string {
  const meta = {
    noteId: generateNoteId(),
    source: 'chatgpt',
    chatId: getChatIdFromUrl(location.href),
    chatTitle: getTitle(),
    pageUrl: location.href,
    exportedAt: new Date().toISOString(),
    model: undefined,

    subject,
    topic,

    summary: null,
    tags: [],
    autoGenerate: { summary: true, tags: true },

    noteMode: 'auto',
    turnCount: turns.length,   // reflect filtered export, not full page
    splitHints: [],

    author: 'me',
    visibility: 'private',
  } satisfies ExportNoteMetadata;

  return buildMarkdownExportByFormat(
    exportFormat,
    meta,
    turns,
    {
      title: meta.chatTitle,
      freeformNotes: notes,
      includeFrontMatter: true,
      htmlBodies // used by Pure MD path
    }
  );
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

// ---- Prompt/Response relabel + typography sync -------------
// Strategy:
// 1) Detect an assistant message to learn its computed typography.
// 2) Store those values as CSS variables on <html> so we can reuse them globally.
// 3) For each user message:
//    - Inject a standardized label "Prompt" (and "Response" for assistant).
//    - Apply a class that forces the entire Prompt block to use the assistant typography.
// 4) For assistant suggestion chips/buttons at the end of a Response, apply the same typography.
function hideNativeRoleLabels(container: HTMLElement) {
  // Try a few robust selectors ChatGPT commonly uses for the role header.
  const candidates = [
    '[data-testid="author-name"]',
    'header span, header div',
    ':scope > div > span', // shallow spans often used in the header
  ];
  for (const sel of candidates) {
    container.querySelectorAll<HTMLElement>(sel).forEach(node => {
      const txt = (node.textContent || '').trim().toLowerCase();
      if (txt === 'you' || txt === 'chatgpt') {
        node.style.display = 'none';
        node.setAttribute('data-cw-hidden', '1');
      }
    });
  }
}

function syncAssistantTypographyVars() {
  // Prefer a rich content child inside the first assistant message
  const assistantEl =
    document.querySelector<HTMLElement>('[data-message-author-role="assistant"] .markdown') ||
    document.querySelector<HTMLElement>('[data-message-author-role="assistant"]');
  if (!assistantEl) return;

  const cs = getComputedStyle(assistantEl);
  const root = document.documentElement;

  root.style.setProperty('--cw-assistant-font-family', cs.fontFamily || 'inherit');
  root.style.setProperty('--cw-assistant-font-size', cs.fontSize || 'inherit');
  root.style.setProperty('--cw-assistant-line-height', cs.lineHeight || 'inherit');
  root.style.setProperty('--cw-assistant-font-weight', cs.fontWeight || 'inherit');
  root.style.setProperty('--cw-assistant-color', cs.color || 'inherit');
}

function relabelAndRestyleMessages() {
  syncAssistantTypographyVars();

  const messages = getAllMessageEls();

  for (const el of messages) {
    if (el.hasAttribute('data-cw-processed')) continue;

    // Hide the native "You/ChatGPT" label if present
    hideNativeRoleLabels(el);

    const role = el.getAttribute('data-message-author-role');
    const isUser = role === 'user';
    const isAssistant = role === 'assistant';

    // Insert our consistent label
    const header = document.createElement('div');
    header.className = 'cw-role-label';
    header.textContent = isUser ? 'Prompt' : (isAssistant ? 'Response' : (role || 'Message'));
    el.prepend(header);

    // Unify entire Prompt body to assistant typography
    if (isUser) el.classList.add('cw-unify-to-assistant');

    // Normalize assistant suggestions
    if (isAssistant) el.classList.add('cw-assistant-normalize-suggestions');

    el.setAttribute('data-cw-processed', '1');
  }
}

// ---- Floating UI -------------------------------------------

function ensureFloatingUI() {
  ensureStyles();
  suspendObservers(true);
  try {
    // Create root once
    let root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;

      // Layout & position
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
      root.style.maxWidth = '420px';

      (document.body || document.documentElement).appendChild(root);

      // Controls (row)
      const controls = document.createElement('div');
      controls.id = CONTROLS_ID;
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.justifyContent = 'flex-end'; // right-justify buttons
      controls.style.gap = '6px';
      controls.style.flexWrap = 'nowrap';         // single line
      controls.style.width = '100%';

      const toggleBtn = document.createElement('button');
      toggleBtn.id = TOGGLE_BTN_ID;
      toggleBtn.type = 'button';
      toggleBtn.textContent = 'Show List';
      toggleBtn.style.fontWeight = '600';

      const btnAll = document.createElement('button');
      btnAll.id = ALL_BTN_ID;
      btnAll.type = 'button';
      btnAll.textContent = 'All';

      const btnNone = document.createElement('button');
      btnNone.id = NONE_BTN_ID;
      btnNone.type = 'button';
      btnNone.textContent = 'None';

      // Pure Markdown checkbox (persists via localStorage)
      const pureLabel = document.createElement('label');
      pureLabel.className = 'chatworthy-toggle';
      pureLabel.htmlFor = PURE_MD_CHECKBOX_ID;

      const pureCb = document.createElement('input');
      pureCb.type = 'checkbox';
      pureCb.id = PURE_MD_CHECKBOX_ID;
      pureCb.checked = (exportFormat === 'markdown_pure');
      pureCb.addEventListener('change', () => {
        setExportFormat(pureCb.checked ? 'markdown_pure' : 'markdown_html');
      });

      const pureSpan = document.createElement('span');
      pureSpan.textContent = 'Pure MD';

      pureLabel.appendChild(pureCb);
      pureLabel.appendChild(pureSpan);

      const exportBtn = document.createElement('button');
      exportBtn.id = EXPORT_BTN_ID;
      exportBtn.type = 'button';
      exportBtn.textContent = 'Export';

      controls.appendChild(toggleBtn);
      controls.appendChild(btnAll);
      controls.appendChild(btnNone);
      controls.appendChild(pureLabel);
      controls.appendChild(exportBtn);

      // List (below controls)
      const list = document.createElement('div');
      list.id = LIST_ID;
      list.style.display = 'none';               // collapsed by default
      list.style.overflow = 'auto';
      list.style.maxHeight = '50vh';
      list.style.minWidth = '220px';
      list.style.padding = '4px 8px 4px 8px'; // room for focus ring on the left

      root.appendChild(controls);
      root.appendChild(list);

      // Wire up controls
      toggleBtn.onclick = () => {
        const isCollapsed = root!.getAttribute('data-collapsed') !== '0';
        setCollapsed(!isCollapsed);
      };

      btnAll.onclick = () => {
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => (cb.checked = true));
        updateControlsState();
      };

      btnNone.onclick = () => {
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => (cb.checked = false));
        updateControlsState();
      };

      exportBtn.onclick = () => {
        try {
          const { turns, htmlBodies } = buildSelectedPayload();
          if (turns.length === 0) {
            alert('Select at least one prompt to export.');
            return;
          }
          const md = buildExportFromTurns(turns, '', '', '', htmlBodies);
          downloadExport(`${filenameBase()}.md`, md);
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
      cb.addEventListener('change', updateControlsState);

      const span = document.createElement('span');
      span.className = 'chatworthy-item-text';
      span.textContent = summarizePromptText((turns[uIdx] as any).text || '');
      span.style.lineHeight = '1.2';

      item.appendChild(cb);
      item.appendChild(span);
      listEl.appendChild(item);
    }

    updateControlsState();

    // Apply relabel + restyle after UI settles
    relabelAndRestyleMessages();

  } finally {
    suspendObservers(false);
  }
}

function ensureStyles() {
  const STYLE_ID = 'chatsworthy-styles';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* Our injected label matches assistant label styling */
[data-message-author-role] > .cw-role-label {
  font-family: var(--cw-assistant-font-family, inherit) !important;
  font-size: var(--cw-assistant-font-size, inherit) !important;
  line-height: var(--cw-assistant-line-height, 1.2) !important;
  font-weight: 600 !important;
  color: var(--cw-assistant-color, rgba(0,0,0,0.75)) !important;
  margin-bottom: 6px !important;
}

/* Entire Prompt (user) body uses assistant typography */
[data-message-author-role="user"].cw-unify-to-assistant,
[data-message-author-role="user"].cw-unify-to-assistant * {
  font-family: var(--cw-assistant-font-family, inherit) !important;
  font-size: var(--cw-assistant-font-size, inherit) !important;
  line-height: var(--cw-assistant-line-height, inherit) !important;
  color: var(--cw-assistant-color, inherit) !important;
  font-weight: var(--cw-assistant-font-weight, inherit) !important;
}

/* Suggestion chips in Responses also match */
[data-message-author-role="assistant"].cw-assistant-normalize-suggestions button,
[data-message-author-role="assistant"].cw-assistant-normalize-suggestions a[role="button"],
[data-message-author-role="assistant"].cw-assistant-normalize-suggestions [data-testid*="suggestion"] {
  font-family: var(--cw-assistant-font-family, inherit) !important;
  font-size: var(--cw-assistant-font-size, inherit) !important;
  line-height: var(--cw-assistant-line-height, inherit) !important;
  color: var(--cw-assistant-color, inherit) !important;
  font-weight: var(--cw-assistant-font-weight, inherit) !important;
}
  `;
  (document.head || document.documentElement).appendChild(style);
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
      // Also keep our relabel/restyle current as the DOM evolves
      relabelAndRestyleMessages();
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
