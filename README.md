
# Chatworthy (Dev) — Floating UI, No Popup

Exports the current ChatGPT conversation to Markdown or JSON using a compact floating UI (format dropdown + Export button).

## Install
1. `npm i`
2. `npm run build` (or `npm run watch`)
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder.

## Use
- Open a chat at `https://chatgpt.com/` or `https://chat.openai.com/`.
- Bottom-right: choose **Markdown** or **JSON** from the dropdown → click **Export**.
- Keyboard shortcut **Ctrl/Cmd+Shift+E** exports Markdown directly.

## Notes
- The dropdown remembers your last format using `localStorage`.
- All export work happens locally; files are downloaded via the browser.
- DOM selectors may need tweaks if the ChatGPT UI changes.
