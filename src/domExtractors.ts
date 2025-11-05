// chatworthy/domExtractors.ts
export function getChatTitleAndProject(): { chatTitle?: string; projectName?: string } {
  // ---- 1) CHAT TITLE: Prefer the selected item in the left sidebar ----
  const sidebarSelected =
    document.querySelector('nav a[aria-current="page"]') ||
    document.querySelector('nav [data-selected="true"]') ||
    document.querySelector('nav a.bg-token-sidebar-surface-secondary') || // current highlight class
    document.querySelector('nav a[aria-current="true"]');

  const sidebarChatTitle = sidebarSelected?.textContent?.trim() || undefined;

  // ---- 2) HEADER TITLE: Editable title at the top of the conversation ----
  // Chat title sometimes lives as a contenteditable heading/input in the header.
  const headerTitleEl =
    document.querySelector('[data-testid="conversation-title"]') ||
    document.querySelector('header [data-testid="chat-title"]') ||
    document.querySelector('header [contenteditable="true"][role="textbox"]') ||
    document.querySelector('header h1');

  const headerChatTitle = headerTitleEl?.textContent?.trim() || undefined;

  // ---- 3) DOCUMENT TITLE: Often "Fixing imported notes – ChatGPT" ----
  const docTitle = (document.title || '').replace(/\s+[–—-]\s+ChatGPT.*$/i, '').trim() || undefined;

  const chatTitle = sidebarChatTitle || headerChatTitle || docTitle;

  // ---- PROJECT NAME: find the nearest folder/group that contains the selected chat ----
  // Different builds render projects as expandable groups/folders in the sidebar tree.
  let projectName: string | undefined;

  if (sidebarSelected) {
    // Strategy A: walk up to a <ul>/<div role="group"> then look for the preceding sibling label
    const group =
      sidebarSelected.closest('ul')?.previousElementSibling ||
      sidebarSelected.closest('[role="group"]')?.previousElementSibling ||
      sidebarSelected.parentElement?.previousElementSibling;

    // Try common label shapes
    projectName =
      group?.querySelector('h2,h3,button,span,div')?.textContent?.trim() ||
      group?.textContent?.trim() ||
      undefined;

    // Strategy B: explicit folder-ish containers near the selected item
    if (!projectName) {
      const folderHeader =
        sidebarSelected.closest('li,div')?.closest('ul,div')?.previousElementSibling ||
        sidebarSelected.closest('[data-testid="treeitem"]')?.parentElement?.previousElementSibling;

      projectName =
        folderHeader?.querySelector('h2,h3,button,span,div')?.textContent?.trim() ||
        folderHeader?.textContent?.trim() ||
        undefined;
    }

    // Clean up common cruft like trailing “⋯” menus
    if (projectName) projectName = projectName.replace(/[⋯…]\s*$/, '').trim();
  }

  // Strategy C (last resort): some headers show “GPTs” or account sections—ignore those
  if (projectName && /^gpts?$/i.test(projectName)) {
    projectName = undefined;
  }

  return { chatTitle, projectName };
}
