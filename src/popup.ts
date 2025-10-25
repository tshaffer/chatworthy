async function sendExport(format: 'md' | 'json') {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'CHATWORTHY_EXPORT', format });
}

document.getElementById('export-md')?.addEventListener('click', () => sendExport('md'));
document.getElementById('export-json')?.addEventListener('click', () => sendExport('json'));
