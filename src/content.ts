// Mark as a module (good for TS/isolatedModules)

import { getChatTitleAndProject } from './domExtractors';
import type { ExportNoteMetadata, ExportTurn } from './types';
import { buildMarkdownExportByFormat } from './utils/exporters';

/**
 * ------------------------------------------------------------
 *  chatworthy Content Script (v2 — Chatalog-ready)
 *  - Floating “Export” UI (collapsible)
 *  - Robust observer for new messages
 *  - Adds a "Pure Markdown" export option (no embedded HTML)
 *  - Relabels "You/ChatGPT" -> "Prompt/Response"
 *  - Works even when the page lacks data-message-author-role (uses our own tags)
 *  - NEW: Click an item in the list to scroll to that Prompt
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

  const pickRoot = (n: HTMLElement): HTMLElement =>
    n.closest<HTMLElement>('[data-testid="conversation-turn"]')
    || n.closest<HTMLElement>('[data-message-id]')
    || n.closest<HTMLElement>('article, li, section')
    || n;

  const roleOf = (root: HTMLElement): 'user' | 'assistant' => {
    const attrNode = root.matches('[data-message-author-role]')
      ? root
      : root.querySelector<HTMLElement>('[data-message-author-role]');
    const raw = (attrNode?.getAttribute('data-message-author-role') || '').toLowerCase();
    if (raw === 'user' || raw === 'assistant') return raw as 'user' | 'assistant';
    if (root.querySelector('.user-message-bubble-color')) return 'user';
    if (root.matches('.items-end, [class*="items-end"]') || root.querySelector('.items-end, [class*="items-end"]')) {
      return 'user';
    }
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

  // Safety net sweep
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

// ---- Build selected payload --------------------------------

function buildSelectedPayload(): { turns: ExportTurn[]; htmlBodies: string[] } {
  const tuples = getMessageTuples();
  const allEls: HTMLElement[] = tuples.map(t => t.el);
  const allTurns: ExportTurn[] = tuples.map(t => {
    const clean = cloneWithoutInjected(t.el);
    return { role: t.role, text: (clean.textContent ?? '').trim() };
  });

  const raw = getSelectedPromptIndexes();
  let selected = raw
    .map(n => typeof n === 'string' ? parseInt(n, 10) : Number(n))
    .filter(n => Number.isFinite(n))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b);

  selected = selected.filter(idx => idx >= 0 && idx < allTurns.length && allTurns[idx].role === 'user');

  if (selected.length === 0) return { turns: [], htmlBodies: [] };

  const turns: ExportTurn[] = [];
  const htmlBodies: string[] = [];

  for (let i = 0; i < selected.length; i++) {
    const uIdx = selected[i];
    const nextCut = (i + 1 < selected.length) ? selected[i + 1] : allTurns.length;
    const start = Math.max(0, Math.min(uIdx, allTurns.length));
    const end = Math.max(start + 1, Math.min(nextCut, allTurns.length));

    for (let j = start; j < end; j++) {
      const el = allEls[j];
      const cleanEl = cloneWithoutInjected(el);
      turns.push(allTurns[j]);
      htmlBodies.push(cleanEl.outerHTML);
    }
  }

  console.log(JSON.stringify(turns, null, 2));

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

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTopic(chatTitle?: string, subject?: string): string | undefined {
  if (!chatTitle) return undefined;
  if (!subject) return chatTitle.trim();

  // Match "<subject> –/—/-/: " at the start (handles spaces).
  const re = new RegExp(
    `^\\s*${escapeRegex(subject)}\\s*(?:–|—|-|:)\\s*`,
    'iu' // i = case-insensitive, u = unicode
  );

  const stripped = chatTitle.replace(re, '').trim();
  return stripped || chatTitle.trim();
}

function getSubjectTopicAndChatTitle() {
  const { chatTitle, projectName } = getChatTitleAndProject();

  const subject = (projectName || (chatTitle?.split(/ - |:|–|—/)[0]?.trim() ?? '')).trim() || '';
  const topic = normalizeTopic(chatTitle, subject) || 'Untitled Conversation';

  console.log('subject', subject);
  console.log('topic', topic);
  console.log('chatTitle', chatTitle);

  return {
    subject,
    topic,
    chatTitle,
  };
}

function buildExportFromTurns(
  turns: ExportTurn[],
  htmlBodies?: string[]
): string {

  const { subject, topic, chatTitle } = getSubjectTopicAndChatTitle();

  const meta = {
    noteId: generateNoteId(),
    source: 'chatgpt',
    chatId: getChatIdFromUrl(location.href),
    chatTitle,
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
      freeformNotes: '',
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

// ---- Relabel -----------------------------------------------

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

function relabelAndRestyleMessages() {
  const tuples = getMessageTuples();

  for (const { el, role } of tuples) {
    hideNativeRoleLabels(el);

    // Insert our label once
    let label = el.querySelector(':scope > .cw-role-label') as HTMLDivElement | null;
    if (!label) {
      label = document.createElement('div');
      label.className = 'cw-role-label';
      label.textContent = role === 'user' ? 'Prompt' : 'Response';
      el.prepend(label);
    }

    el.setAttribute('data-cw-processed', '1');
  }
}

// ---- Jump-to-turn helpers ----------------------------------

// Find the nearest ancestor that actually scrolls (overflow-y: auto/scroll and scrollHeight > clientHeight)
function findScrollContainer(start: HTMLElement | null): HTMLElement {
  let el: HTMLElement | null = start;
  while (el) {
    const cs = getComputedStyle(el);
    const canScroll =
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight;
    if (canScroll) return el;
    el = el.parentElement;
  }
  // Fallback to the document scroller
  return (document.scrollingElement || document.documentElement) as HTMLElement;
}

// Try to detect a fixed/sticky header inside the same scroll container
function getLocalHeaderOffset(scrollEl: HTMLElement): number {
  const rect = scrollEl.getBoundingClientRect();
  const headerCandidates = Array.from(scrollEl.querySelectorAll<HTMLElement>('*')).filter(n => {
    const cs = getComputedStyle(n);
    if (!(cs.position === 'fixed' || cs.position === 'sticky')) return false;
    const r = n.getBoundingClientRect();
    // Treat as a top header if it “hugs” the container’s top edge
    return r.top <= rect.top + 8 && r.height >= 40 && r.height <= 140;
  });
  const h = headerCandidates.reduce((m, n) => Math.max(m, n.getBoundingClientRect().height), 0);
  return (h || 80) + 12; // default safety headroom
}

// Visual ping
function highlightPrompt(el: HTMLElement) {
  el.classList.add('cw-jump-highlight');
  setTimeout(() => el.classList.remove('cw-jump-highlight'), 1200);
}

// Scroll inside the right container (not window)
function scrollPromptIntoViewByIndex(tupleIndex: number) {
  const tuples = getMessageTuples();
  const t = tuples[tupleIndex];
  if (!t || t.role !== 'user') return;

  const el = t.el as HTMLElement;
  const scroller = findScrollContainer(el);

  const elRect = el.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();

  const offset = getLocalHeaderOffset(scroller);
  const current = scroller.scrollTop;
  const targetY = current + (elRect.top - scRect.top) - offset;

  scroller.scrollTo({ top: Math.max(targetY, 0), behavior: 'smooth' });
  highlightPrompt(el);
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
          const md = buildExportFromTurns(turns, htmlBodies);
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

    // 4) Populate list from tuples
    list.innerHTML = '';
    const tuples = getMessageTuples();

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
        const item = d.createElement('div');               // use <div>, not <label>
        item.className = 'chatworthy-item';
        item.style.display = 'flex';
        item.style.alignItems = 'flex-start';
        item.style.gap = '6px';
        item.style.margin = '4px 0';
        item.style.cursor = 'pointer';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;

        const cb = d.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.uindex = String(idx);
        cb.addEventListener('change', updateControlsState);
        // Prevent row click from firing when clicking the checkbox itself
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('keydown', (e) => e.stopPropagation());

        const span = d.createElement('span');
        span.className = 'chatworthy-item-text';
        const clone = node.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.cw-role-label,[data-cw-hidden="1"]').forEach(n => n.remove());
        span.textContent = (clone.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        span.style.lineHeight = '1.2';

        // Guarded handlers: clicking row scrolls; clicking checkbox only toggles
        item.addEventListener('click', (e) => {
          const target = e.target as HTMLElement;
          if (target.tagName.toLowerCase() === 'input') return; // clicked the checkbox
          scrollPromptIntoViewByIndex(idx);
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            scrollPromptIntoViewByIndex(idx);
          }
        });

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

  /* Row + checkbox cursors */
  #${ROOT_ID} .chatworthy-item { cursor: pointer; }
  #${ROOT_ID} .chatworthy-item input[type="checkbox"] { cursor: pointer; margin-left: 2px; }

  /* Label spacing on turns */
  [data-cw-role] > .cw-role-label {
    display:block !important;
    margin: 0 0 6px 0 !important;
    font-weight:600 !important;
  }

  /* Subtle “jump” highlight on the scrolled-to Prompt */
  @keyframes cwJumpFlash {
    0%   { box-shadow: 0 0 0 2px rgba(59,130,246,.35), inset 0 0 0 9999px rgba(59,130,246,.08); }
    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0),      inset 0 0 0 0 rgba(59,130,246,0); }
  }
  [data-cw-role="user"].cw-jump-highlight {
    animation: cwJumpFlash 1100ms ease-out 1;
    border-radius: 10px;
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
