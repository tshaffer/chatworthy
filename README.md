# Chatworthy (Dev)

Chrome extension (Manifest V3 + TypeScript) to export current ChatGPT conversation to Markdown/JSON. Dev-only, load unpacked.

## Install
1. `npm i`
2. Add icons to `icons/` (16/48/128 png) or remove from `manifest.json`.
3. Build once: `npm run build` (or `npm run watch`).
4. Go to `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder.

## Use
- Visit `https://chatgpt.com/` (or `https://chat.openai.com/`) on a conversation.
- Click the floating **Export (MD)** button (Shift+Click for JSON), or use the toolbar popup, or press **Ctrl+Shift+E** (Cmd+Shift+E on macOS).
- Files download with a timestamped, slugified title.

## Notes
- The DOM selectors are best-effort; ChatGPT UI changes frequently. If exports are empty or partial, update selectors in `src/content.ts`.
- All exports run locally and save via `chrome.downloads`.
- For PDF, consider Chrome’s built-in “Print to PDF” on the MD file, or implement an offscreen document in MV3.

## Future ideas
- Partial selection export (only highlighted turns)
- Include images / tables faithfully (inline HTML → MD tweaks)
- Per-chat UID detection
- Options: filename template, include roles, date headers, etc.
