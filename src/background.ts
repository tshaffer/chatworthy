
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'export-chat') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'CHATWORTHY_EXPORT', format: 'md' });
  }
});
