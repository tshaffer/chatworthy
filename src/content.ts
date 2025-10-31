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
  // Expose for quick console debugging
  (window as any).cw_getMessageTuples = getMessageTuples;

  // Paste once near other singletons:
  (window as any).cw_debugTuples = () => {
    const t = getMessageTuples();
    const users = t.filter(x => x.role === 'user').length;
    const asst = t.filter(x => x.role === 'assistant').length;
    console.log(`[chatworthy] tuples: ${t.length} (user=${users}, assistant=${asst})`);
    console.log(t.map((x, i) => ({ i, role: x.role, text: (x.el.textContent || '').trim().slice(0, 60) })));
  };

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
  const chosen: Array<{ el: HTMLElement; role: 'user' | 'assistant' }> = [];
  const seen = new Set<HTMLElement>();

  // Prefer full "turn" containers; fall back to nodes that carry the role attribute.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>([
    '[data-testid="conversation-turn"]',
    '[data-message-id]',
    '[data-message-author-role]'
  ].join(',')));

  // Pick a stable root for a candidate node.
  const pickRoot = (n: HTMLElement): HTMLElement =>
    n.closest<HTMLElement>('[data-testid="conversation-turn"]')
    || n.closest<HTMLElement>('[data-message-id]')
    || n.closest<HTMLElement>('article, li, section')
    || n;

  // Decide role from attributes/content inside a root.
  const roleOf = (root: HTMLElement): 'user' | 'assistant' => {
    // 1) Explicit attribute wins.
    const attrNode = root.matches('[data-message-author-role]')
      ? root
      : root.querySelector<HTMLElement>('[data-message-author-role]');
    const raw = (attrNode?.getAttribute('data-message-author-role') || '').toLowerCase();
    if (raw === 'user' || raw === 'assistant') return raw as 'user' | 'assistant';

    // 2) Common UI clues.
    if (root.querySelector('.user-message-bubble-color')) return 'user';

    // 3) Fallback: if there’s a right-aligned container, assume user.
    if (root.matches('.items-end, [class*="items-end"]') || root.querySelector('.items-end, [class*="items-end"]')) {
      return 'user';
    }

    // 4) Default to assistant.
    return 'assistant';
  };

  for (const node of candidates) {
    const root = pickRoot(node);
    if (seen.has(root)) continue;
    seen.add(root);

    const role = roleOf(root);
    root.setAttribute('data-cw-role', role);

    if (!root.hasAttribute('data-cw-msgid')) {
      root.setAttribute('data-cw-msgid', String(chosen.length));
    }
    chosen.push({ el: root, role });
  }

  // As a safety net: if we somehow found no assistant nodes but there are visible assistant blocks,
  // sweep for rich content containers not inside user turns.
  if (!chosen.some(c => c.role === 'assistant')) {
    const extras = Array.from(document.querySelectorAll<HTMLElement>('.markdown, .prose, [data-testid="markdown"]'));
    for (const md of extras) {
      const inUser = md.closest('[data-cw-role="user"], .items-end, [class*="items-end"]');
      if (inUser) continue;
      const root = pickRoot(md);
      if (seen.has(root)) continue;
      seen.add(root);
      root.setAttribute('data-cw-role', 'assistant');
      if (!root.hasAttribute('data-cw-msgid')) {
        root.setAttribute('data-cw-msgid', String(chosen.length));
      }
      chosen.push({ el: root, role: 'assistant' });
    }
  }

  return chosen;
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
  // Canonical list of message roots in visual order
  const tuples = getMessageTuples(); // [{ el: HTMLElement, role: 'user'|'assistant' }]
  const allEls: HTMLElement[] = tuples.map(t => t.el);
  const allTurns: ExportTurn[] = tuples.map(t => {
    const clean = cloneWithoutInjected(t.el);
    return { role: t.role, text: (clean.textContent ?? '').trim() };
  });

  // Selected indices come from user checkboxes whose data-uindex === data-cw-msgid (overall tuple index)
  const raw = getSelectedPromptIndexes(); // string[] | number[] depending on your impl
  let selected = raw
    .map(n => typeof n === 'string' ? parseInt(n, 10) : Number(n))
    .filter(n => Number.isFinite(n))
    .filter((n, i, arr) => arr.indexOf(n) === i) // de-dupe
    .sort((a, b) => a - b);

  // Keep only valid, in-range indices that point to a USER turn (defensive)
  selected = selected.filter(idx => idx >= 0 && idx < allTurns.length && allTurns[idx].role === 'user');

  if (selected.length === 0) return { turns: [], htmlBodies: [] };

  const turns: ExportTurn[] = [];
  const htmlBodies: string[] = [];

  // For each selected user index, include that user turn and all following turns
  // up to (but not including) the next selected user index (or the end).
  for (let i = 0; i < selected.length; i++) {
    const uIdx = selected[i];
    const nextCut = (i + 1 < selected.length) ? selected[i + 1] : allTurns.length;

    // Guard against accidental inversion (shouldn't happen after sort, but be safe)
    const start = Math.max(0, Math.min(uIdx, allTurns.length));
    const end = Math.max(start + 1, Math.min(nextCut, allTurns.length));

    for (let j = start; j < end; j++) {
      // Clone without our injected UI and grab HTML/text
      const el = allEls[j];
      const cleanEl = cloneWithoutInjected(el);
      turns.push(allTurns[j]);
      htmlBodies.push(cleanEl.outerHTML);
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
  // Prefer a deep text node inside assistant prose for accurate computed styles
  const probe =
    document.querySelector<HTMLElement>('.markdown.prose p, .markdown.prose li, .markdown.prose') ||
    document.querySelector<HTMLElement>('[data-message-author-role="assistant"]') ||
    document.querySelector<HTMLElement>('[data-cw-role="assistant"]');

  if (!probe) return;

  const cs = getComputedStyle(probe);
  const root = document.documentElement;

  // Capture the full set we’ll mirror
  root.style.setProperty('--cw-assistant-font-family', cs.fontFamily || 'inherit');
  root.style.setProperty('--cw-assistant-font-size', cs.fontSize || 'inherit');
  root.style.setProperty('--cw-assistant-line-height', cs.lineHeight || '1.5');
  root.style.setProperty('--cw-assistant-font-weight', cs.fontWeight || '400');
  root.style.setProperty('--cw-assistant-color', cs.color || 'inherit');
}

function relabelAndRestyleMessages() {
  syncAssistantTypographyVars();

  const tuples = getMessageTuples();
  for (const { el, role } of tuples) {
    // Hide native labels if present
    hideNativeRoleLabels(el);

    // Add/refresh our normalization classes every pass
    // if (role === 'user') el.classList.add('cw-unify-to-assistant');
    // if (role === 'assistant') el.classList.add('cw-assistant-normalize-suggestions');
    if (role === 'user') {
      el.classList.add('cw-unify-to-assistant');
      forcePromptTypography(el); // 🔥 hard-pin Prompt body appearance
    } else {
      el.classList.add('cw-assistant-normalize-suggestions');
    }

    // Inject a single label at the top (once)
    if (!el.querySelector(':scope > .cw-role-label')) {
      // Insert our consistent label
      // Insert our consistent label
      const header = document.createElement('div');
      header.className = 'cw-role-label';
      header.textContent = role === 'user' ? 'Prompt' : 'Response';

      // 🔧 Inline + !important to beat utility classes
      const setImp = (prop: string, val: string) => header.style.setProperty(prop, val, 'important');
      setImp('font-family', 'var(--cw-assistant-font-family)');
      setImp('font-size', 'var(--cw-assistant-font-size)');
      setImp('line-height', 'var(--cw-assistant-line-height)');
      setImp('font-weight', '600'); // label semibold
      setImp('color', 'var(--cw-assistant-color)');
      setImp('margin-bottom', '6px');

      el.prepend(header);
    }
  }
}

function forcePromptTypography(root: HTMLElement) {
  const setImp = (prop: string, val: string) => root.style.setProperty(prop, val, 'important');

  // Apply on the user message container so it inherits down
  setImp('font-family', 'var(--cw-assistant-font-family)');
  setImp('font-size', 'var(--cw-assistant-font-size)');
  setImp('line-height', 'var(--cw-assistant-line-height)');
  setImp('color', 'var(--cw-assistant-color)');
  setImp('font-weight', 'var(--cw-assistant-font-weight)');

  // Belt & suspenders: ensure deeply nested text nodes inherit too
  // (skip code/pre to preserve monospace)
  root.querySelectorAll<HTMLElement>('*:not(code):not(pre)').forEach(node => {
    node.style.setProperty('font-family', 'var(--cw-assistant-font-family)', 'important');
    node.style.setProperty('font-size', 'var(--cw-assistant-font-size)', 'important');
    node.style.setProperty('line-height', 'var(--cw-assistant-line-height)', 'important');
    node.style.setProperty('color', 'var(--cw-assistant-color)', 'important');
    node.style.setProperty('font-weight', 'var(--cw-assistant-font-weight)', 'important');
  });
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

    // 🔑 Make sure roles/labels are in place BEFORE we build the list
    relabelAndRestyleMessages();

    // 4) Populate list from tuples (don’t depend on [data-cw-role] being there yet)
    list.innerHTML = '';
    const tuples = getMessageTuples(); // [{ el, role }]
    const allEls = tuples.map(t => t.el);

    const userTuples: Array<{ idx: number; el: HTMLElement }> = [];
    tuples.forEach((t, idx) => {
      if (t.role === 'user') userTuples.push({ idx, el: t.el });
    });

    if (userTuples.length === 0) {
      const empty = d.createElement('div');
      empty.textContent = 'No prompts detected yet.';
      empty.style.opacity = '0.7';
      empty.style.fontSize = '12px';
      list.appendChild(empty);
    } else {
      for (const { idx, el: node } of userTuples) {
        const item = d.createElement('label');
        item.className = 'chatworthy-item';
        item.style.display = 'flex';
        item.style.alignItems = 'flex-start';
        item.style.gap = '6px';
        item.style.margin = '4px 0';

        const cb = d.createElement('input');
        cb.type = 'checkbox';
        // Use the overall tuple index so buildSelectedPayload lines up
        cb.dataset.uindex = String(idx);
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
  #${ROOT_ID} .chatworthy-toggle input { transform: translateY(0.5px); }
  #${ROOT_ID} label.chatworthy-item input[type="checkbox"] { margin-left: 2px; }

  /* Label: we also set inline styles now, but keep this as a fallback */
  [data-cw-role] > .cw-role-label {
    font-family: var(--cw-assistant-font-family) !important;
    font-size: var(--cw-assistant-font-size) !important;
    line-height: var(--cw-assistant-line-height) !important;
    font-weight: 600 !important;
    color: var(--cw-assistant-color) !important;
    margin-bottom: 6px !important;
  }

  /* Prompt (user) body → mirror assistant typography with high specificity */
  html body [data-cw-role="user"].cw-unify-to-assistant,
  html body [data-cw-role="user"].cw-unify-to-assistant *:not(code):not(pre) {
    font-family: var(--cw-assistant-font-family) !important;
    font-size: var(--cw-assistant-font-size) !important;
    line-height: var(--cw-assistant-line-height) !important;
    color: var(--cw-assistant-color) !important;
    font-weight: var(--cw-assistant-font-weight) !important;
  }

  /* Normalize suggestion chips INSIDE an assistant turn */
  html body [data-cw-role="assistant"].cw-assistant-normalize-suggestions
    :is(button, a[role="button"], [data-testid*="suggest"], [data-testid*="quick-reply"], [class*="suggest"]) {
    font-family: var(--cw-assistant-font-family) !important;
    font-size: var(--cw-assistant-font-size) !important;
    line-height: var(--cw-assistant-line-height) !important;
    color: var(--cw-assistant-color) !important;
    font-weight: var(--cw-assistant-font-weight) !important;
  }

  /* Fallback: if the site renders suggestion chips just outside the assistant node */
  html body :is([data-testid*="suggest"], [data-testid*="quick-reply"], [class*="suggestion"]) {
    font-family: var(--cw-assistant-font-family) !important;
    font-size: var(--cw-assistant-font-size) !important;
    line-height: var(--cw-assistant-line-height) !important;
    color: var(--cw-assistant-color) !important;
    font-weight: var(--cw-assistant-font-weight) !important;
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
