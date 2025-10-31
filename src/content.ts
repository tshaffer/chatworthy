// Mark as a module (good for TS/isolatedModules)

import type { ExportNoteMetadata, ExportTurn } from './types';
import { buildMarkdownExportByFormat } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  chatworthy Content Script (v2 — Chatalog-ready)
 *  - Floating “Export” UI (collapsible)
 *  - Robust observer for new messages
 *  - Adds a "Pure Markdown" export option (no embedded HTML)
 *  - Relabels "You/ChatGPT" -> "Prompt/Response" and unifies Prompt styling
 *  - Works even when the page lacks data-message-author-role (uses our own tags)
 * ------------------------------------------------------------
 */

// ---- Config ------------------------------------------------

const ROOT_ID = 'chatworthy-root';
const LIST_ID = 'chatworthy-list';
const CONTROLS_ID = 'chatworthy-controls';
const EXPORT_BTN_ID = 'chatworthy-export-btn';
const TOGGLE_BTN_ID = 'chatworthy-toggle-btn';
const ALL_BTN_ID = 'chatworthy-all-btn';
const NONE_BTN_ID = 'chatworthy-none-btn';
const PURE_MD_CHECKBOX_ID = 'chatworthy-pure-md';

const OBSERVER_THROTTLE_MS = 200;
const COLLAPSE_LS_KEY = 'chatworthy:collapsed';
const FORMAT_LS_KEY = 'chatworthy:export-format';

type ExportFormat = 'markdown_html' | 'markdown_pure';

let repairTimer: number | null = null;

function startRepairLoop() {
  if (repairTimer != null) return;
  repairTimer = window.setInterval(() => {
    try {
      ensureFloatingUI();
      // stop once the list exists
      if (document.getElementById(LIST_ID)) {
        clearInterval(repairTimer!);
        repairTimer = null;
      }
    } catch { /* ignore */ }
  }, 1500);
}

// ---- Singleton + Killswitch -------------------------------

(() => {
  const w = window as any;

  try {
    const disabled =
      localStorage.getItem('chatworthy:disable') === '1' ||
      new URLSearchParams(location.search).has('chatworthy-disable');
    if (disabled) {
      console.warn('[chatworthy] Disabled by kill switch');
      return;
    }
  } catch { /* ignore */ }

  if (w.__chatworthy_init__) return;
  w.__chatworthy_init__ = true;

  if (window.top !== window) return;

  init().catch(err => console.error('[chatworthy] init failed', err));
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

// Remove our injected bits before reading text/HTML
function cloneWithoutInjected(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  // Remove our Prompt/Response labels + any nodes we previously hid
  clone.querySelectorAll('.cw-role-label, [data-cw-hidden="1"]').forEach(n => n.remove());
  return clone;
}

// ---- Message discovery (works with your DOM) ---------------

/**
 * Returns ordered tuples of { el, role } for visible messages,
 * tagging each element with data-cw-role="user|assistant" for stable CSS.
 *
 * Heuristics based on your sample:
 * - User: right-aligned container with bubble having .user-message-bubble-color
 * - Assistant: .markdown.prose blocks (not inside right-aligned user container)
 * - Also supports legacy [data-message-author-role] if present
 */
function getMessageTuples(): Array<{ el: HTMLElement; role: 'user' | 'assistant' }> {
  const out: Array<{ el: HTMLElement; role: 'user' | 'assistant' }> = [];
  const seen = new WeakSet<Element>();

  // Query in DOM order (one pass), then classify each node.
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(
    '.user-message-bubble-color, .markdown.prose, [data-message-author-role]'
  ));

  for (const node of nodes) {
    // Prefer explicit page-side tags if present
    if (node.hasAttribute('data-message-author-role')) {
      const r = (node.getAttribute('data-message-author-role') || '').toLowerCase();
      if ((r === 'user' || r === 'assistant') && !seen.has(node)) {
        seen.add(node);
        node.setAttribute('data-cw-role', r);
        out.push({ el: node, role: r as 'user' | 'assistant' });
        continue;
      }
    }

    // Detect user container (right-aligned bubble)
    if (node.matches('.user-message-bubble-color')) {
      const container = node.closest<HTMLElement>('.items-end, [class*="items-end"]') || node;
      if (!seen.has(container)) {
        seen.add(container);
        container.setAttribute('data-cw-role', 'user');
        out.push({ el: container, role: 'user' });
      }
      continue;
    }

    // Detect assistant markdown (avoid user container)
    if (node.matches('.markdown.prose')) {
      if (node.closest('.items-end, [class*="items-end"]')) continue; // don't misclassify
      if (!seen.has(node)) {
        seen.add(node);
        node.setAttribute('data-cw-role', 'assistant');
        out.push({ el: node, role: 'assistant' });
      }
      continue;
    }
  }

  return out;
}

// ---- Export data building ----------------------------------

function extractTurns(): ExportTurn[] {
  const tuples = getMessageTuples();
  return tuples.map(t => {
    const clean = cloneWithoutInjected(t.el);
    return {
      role: t.role,
      text: (clean.textContent ?? '').trim()
    };
  });
}

/**
 * Build selected payload:
 * - User selects specific user turns; include each selected user turn
 *   plus all following turns until the next user turn.
 */
function buildSelectedPayload(): { turns: ExportTurn[]; htmlBodies: string[] } {
  const tuples = getMessageTuples();
  const allTurns: ExportTurn[] = tuples.map(t => {
    const clean = cloneWithoutInjected(t.el);
    return { role: t.role, text: (clean.textContent ?? '').trim() };
  });
  const allEls: HTMLElement[] = tuples.map(t => t.el);

  const selectedUserIdxs = getSelectedPromptIndexes();
  if (selectedUserIdxs.length === 0) return { turns: [], htmlBodies: [] };

  const turns: ExportTurn[] = [];
  const htmlBodies: string[] = [];

  for (let i = 0; i < selectedUserIdxs.length; i++) {
    const uIdx = selectedUserIdxs[i];
    const nextU = (i + 1 < selectedUserIdxs.length) ? selectedUserIdxs[i + 1] : allTurns.length;

    if (uIdx >= 0 && uIdx < allTurns.length) {
      turns.push(allTurns[uIdx]);
      htmlBodies.push(cloneWithoutInjected(allEls[uIdx]).outerHTML);
    }

    for (let j = uIdx + 1; j < nextU; j++) {
      if (j >= 0 && j < allTurns.length) {
        turns.push(allTurns[j]);
        htmlBodies.push(cloneWithoutInjected(allEls[j]).outerHTML);
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

  if (allBtn) allBtn.disabled = total > 0 && selected === total;
  if (noneBtn) noneBtn.disabled = selected === 0;
  if (expBtn) expBtn.disabled = selected === 0;
}

// ---- Export helpers ---------------------------------------

function generateNoteId(): string {
  try {
    return `ext-${crypto.randomUUID()}`;
  } catch {
    return `ext-${Math.random().toString(36).slice(2)}${Date.now()}`;
  }
}

function getChatIdFromUrl(href: string): string | undefined {
  const match = href.match(/\/c\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

function getInitialExportFormat(): ExportFormat {
  try {
    const raw = localStorage.getItem(FORMAT_LS_KEY);
    if (raw === 'markdown_pure' || raw === 'markdown_html') return raw;
  } catch { /* ignore */ }
  return 'markdown_html';
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
  htmlBodies?: string[]
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
    turnCount: turns.length,
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
      htmlBodies
    }
  );
}

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

// ---- Relabel + typography sync -----------------------------

function hideNativeRoleLabels(container: HTMLElement) {
  const selectors = [
    '[data-testid="author-name"]',
    'header [data-testid]',
    'header span, header div',
    ':scope > header *',
    ':scope > div > span',
    ':scope > div[role="heading"] *',
  ];

  const isRoleWord = (t: string) => {
    const s = t.trim().toLowerCase();
    return s === 'you' || s === 'chatgpt';
  };

  let hidden = 0;

  for (const sel of selectors) {
    container.querySelectorAll<HTMLElement>(sel).forEach(node => {
      const txt = (node.textContent || '').trim();
      if (isRoleWord(txt)) {
        node.style.display = 'none';
        node.setAttribute('data-cw-hidden', '1');
        hidden++;
      }
    });
  }

  if (!hidden) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, null);
    let count = 0;
    while (walker.nextNode() && count < 150) {
      const el = walker.currentNode as HTMLElement;
      const txt = (el.textContent || '').trim();
      if (txt && txt.length <= 16 && isRoleWord(txt)) {
        el.style.display = 'none';
        el.setAttribute('data-cw-hidden', '1');
        hidden++;
        break;
      }
      count++;
    }
  }

  if (!hidden) {
    const prev = container.previousElementSibling as HTMLElement | null;
    if (prev && /header/i.test(prev.tagName)) {
      prev.querySelectorAll<HTMLElement>('span,div,[data-testid]').forEach(node => {
        const txt = (node.textContent || '').trim();
        if ((txt.toLowerCase() === 'you' || txt.toLowerCase() === 'chatgpt')) {
          node.style.display = 'none';
          node.setAttribute('data-cw-hidden', '1');
          hidden++;
        }
      });
    }
  }
}

function syncAssistantTypographyVars() {
  // Prefer a rich content node from our tuples
  const tuples = getMessageTuples();
  const firstAssistant = tuples.find(t => t.role === 'assistant')?.el
    || document.querySelector<HTMLElement>('.markdown.prose')
    || document.querySelector<HTMLElement>('[data-message-author-role="assistant"]');

  if (!firstAssistant) return;

  const cs = getComputedStyle(firstAssistant);
  const root = document.documentElement;

  root.style.setProperty('--cw-assistant-font-family', cs.fontFamily || 'inherit');
  root.style.setProperty('--cw-assistant-font-size', cs.fontSize || 'inherit');
  root.style.setProperty('--cw-assistant-line-height', cs.lineHeight || 'inherit');
  root.style.setProperty('--cw-assistant-font-weight', cs.fontWeight || 'inherit');
  root.style.setProperty('--cw-assistant-color', cs.color || 'inherit');
}

function relabelAndRestyleMessages() {
  syncAssistantTypographyVars();

  const tuples = getMessageTuples();

  for (const { el, role } of tuples) {
    // Try to hide native labels (harmless if none)
    hideNativeRoleLabels(el);

    if (el.hasAttribute('data-cw-processed')) continue;

    // Insert our consistent label
    const header = document.createElement('div');
    header.className = 'cw-role-label';
    header.textContent = role === 'user' ? 'Prompt' : 'Response';
    el.prepend(header);

    if (role === 'user') el.classList.add('cw-unify-to-assistant');
    if (role === 'assistant') el.classList.add('cw-assistant-normalize-suggestions');

    el.setAttribute('data-cw-processed', '1');
  }
}

// ---- Floating UI -------------------------------------------

function ensureFloatingUI() {
  ensureStyles();
  suspendObservers(true);
  try {
    const d = document;

    // 1) Root — create if missing
    let root = d.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = d.createElement('div');
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

      (d.body || d.documentElement).appendChild(root);
      // default collapsed state
      setCollapsed(getInitialCollapsed());
    }

    // 2) Controls — (re)create if missing and (re)wire handlers
    let controls = d.getElementById(CONTROLS_ID) as HTMLDivElement | null;
    if (!controls) {
      controls = d.createElement('div');
      controls.id = CONTROLS_ID;
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.justifyContent = 'flex-end';
      controls.style.gap = '6px';
      controls.style.flexWrap = 'nowrap';
      controls.style.width = '100%';

      const toggleBtn = d.createElement('button');
      toggleBtn.id = TOGGLE_BTN_ID;
      toggleBtn.type = 'button';
      toggleBtn.textContent = (root.getAttribute('data-collapsed') === '1') ? 'Show List' : 'Hide List';
      toggleBtn.style.fontWeight = '600';
      toggleBtn.onclick = () => {
        const isCollapsed = root!.getAttribute('data-collapsed') !== '0';
        setCollapsed(!isCollapsed);
      };

      const btnAll = d.createElement('button');
      btnAll.id = ALL_BTN_ID;
      btnAll.type = 'button';
      btnAll.textContent = 'All';
      btnAll.onclick = () => {
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => (cb.checked = true));
        updateControlsState();
      };

      const btnNone = d.createElement('button');
      btnNone.id = NONE_BTN_ID;
      btnNone.type = 'button';
      btnNone.textContent = 'None';
      btnNone.onclick = () => {
        root!.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-uindex]').forEach(cb => (cb.checked = false));
        updateControlsState();
      };

      const pureLabel = d.createElement('label');
      pureLabel.className = 'chatworthy-toggle';
      pureLabel.htmlFor = PURE_MD_CHECKBOX_ID;

      const pureCb = d.createElement('input');
      pureCb.type = 'checkbox';
      pureCb.id = PURE_MD_CHECKBOX_ID;
      pureCb.checked = (exportFormat === 'markdown_pure');
      pureCb.addEventListener('change', () => {
        setExportFormat(pureCb.checked ? 'markdown_pure' : 'markdown_html');
      });

      const pureSpan = d.createElement('span');
      pureSpan.textContent = 'Pure MD';
      pureLabel.appendChild(pureCb);
      pureLabel.appendChild(pureSpan);

      const exportBtn = d.createElement('button');
      exportBtn.id = EXPORT_BTN_ID;
      exportBtn.type = 'button';
      exportBtn.textContent = 'Export';
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
          console.error('[chatworthy] export failed:', err);
          alert('Export failed — see console for details.');
        }
      };

      controls.appendChild(toggleBtn);
      controls.appendChild(btnAll);
      controls.appendChild(btnNone);
      controls.appendChild(pureLabel);
      controls.appendChild(exportBtn);
      root.appendChild(controls);
    } else {
      // keep toggle label in sync with state
      const toggle = controls.querySelector('#' + TOGGLE_BTN_ID) as HTMLButtonElement | null;
      if (toggle) toggle.textContent = (root.getAttribute('data-collapsed') === '1') ? 'Show List' : 'Hide List';
    }

    // 3) List — (re)create if missing
    let list = d.getElementById(LIST_ID) as HTMLDivElement | null;
    if (!list) {
      list = d.createElement('div');
      list.id = LIST_ID;
      list.style.display = (root.getAttribute('data-collapsed') === '1') ? 'none' : 'block';
      list.style.overflow = 'auto';
      list.style.maxHeight = '50vh';
      list.style.minWidth = '220px';
      list.style.padding = '4px 8px 4px 8px';
      root.appendChild(list);
    }

    // 4) Populate list from page-side roles (robust)
    list.innerHTML = '';
    const allRoleNodes = Array.from(d.querySelectorAll<HTMLElement>('[data-cw-role]'));
    const userNodes = allRoleNodes.filter(n => n.getAttribute('data-cw-role') === 'user');

    for (const node of userNodes) {
      const item = d.createElement('label');
      item.className = 'chatworthy-item';
      item.style.display = 'flex';
      item.style.alignItems = 'flex-start';
      item.style.gap = '6px';
      item.style.margin = '4px 0';

      const cb = d.createElement('input');
      cb.type = 'checkbox';
      const indexInAll = allRoleNodes.indexOf(node);
      cb.dataset.uindex = String(indexInAll);
      cb.addEventListener('change', updateControlsState);

      const span = d.createElement('span');
      span.className = 'chatworthy-item-text';
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.cw-role-label,[data-cw-hidden="1"]').forEach(n => n.remove());
      span.textContent = (clone.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      span.style.lineHeight = '1.2';

      item.appendChild(cb);
      item.appendChild(span);
      list.appendChild(item);
    }

    updateControlsState();
    relabelAndRestyleMessages();
  } finally {
    suspendObservers(false);
  }
}

function ensureStyles() {
  const STYLE_ID = 'chatworthy-styles';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Floating UI buttons */
    #${ROOT_ID} button {
      padding: 4px 8px;
      border: 1px solid rgba(0,0,0,0.2);
      border-radius: 6px;
      background: white;
      font-size: 12px;
      line-height: 1.2;
    }
    #${ROOT_ID} button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      filter: grayscale(100%);
    }
    #${ROOT_ID} .chatworthy-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
      margin-left: 4px;
      white-space: nowrap;
    }
    #${ROOT_ID} .chatworthy-toggle input {
      transform: translateY(0.5px);
    }
    #${ROOT_ID} label.chatworthy-item input[type="checkbox"] {
      margin-left: 2px;
    }

    /* Injected role label (Prompt/Response) styled like assistant label */
    [data-cw-role] > .cw-role-label {
      font-family: var(--cw-assistant-font-family, inherit) !important;
      font-size: var(--cw-assistant-font-size, inherit) !important;
      line-height: var(--cw-assistant-line-height, 1.2) !important;
      font-weight: 600 !important;
      color: var(--cw-assistant-color, rgba(0,0,0,0.75)) !important;
      margin-bottom: 6px !important;
    }

    /* Entire Prompt (user) body uses assistant typography */
    [data-cw-role="user"].cw-unify-to-assistant,
    [data-cw-role="user"].cw-unify-to-assistant * {
      font-family: var(--cw-assistant-font-family, inherit) !important;
      font-size: var(--cw-assistant-font-size, inherit) !important;
      line-height: var(--cw-assistant-line-height, inherit) !important;
      color: var(--cw-assistant-color, inherit) !important;
      font-weight: var(--cw-assistant-font-weight, inherit) !important;
    }

    /* Suggestion chips in Responses also match assistant typography */
    [data-cw-role="assistant"].cw-assistant-normalize-suggestions button,
    [data-cw-role="assistant"].cw-assistant-normalize-suggestions a[role="button"],
    [data-cw-role="assistant"].cw-assistant-normalize-suggestions [data-testid*="suggestion"] {
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

function suspendObservers(v: boolean) { observersSuspended = v; }

function makeObserver(): MutationObserver {
  return new MutationObserver((mutationList) => {
    if (observersSuspended) return;

    const root = document.getElementById(ROOT_ID);
    if (root) {
      for (const m of mutationList) {
        const target = m.target as Node;
        if (root.contains(target)) return; // ignore our own UI mutations
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
    console.warn('[chatworthy] Host not allowed; skipping init:', host);
    return;
  }

  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
    );
  }

  console.log('[chatworthy] content script active');
  startObserving();
  scheduleEnsure();
  startRepairLoop();
}
