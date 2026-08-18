# Privacy Policy — YouTube Dual Subtitle

_Last updated: 2026-08-18 (corrected the dual-subtitles toggle key, which is now user-configurable — default `G`, not `C`)_

YouTube Dual Subtitle ("the Extension") is a Chrome extension that overlays dual-language subtitles (source + translation) on YouTube videos. This policy explains what data the Extension touches, where it goes, and what control you have.

## 1. Data we collect

The Extension does **not** collect, transmit, or sell any personal information for analytics, advertising, profiling, or any third-party purpose. There is no telemetry, no user account, no tracking pixel.

The Extension processes the following data **locally on your device** to perform its function:

| Data | Purpose | Stored where | Sent where |
|---|---|---|---|
| Your settings (languages, display mode, styles, subtitle position) | Persist your preferences across sessions and devices | `chrome.storage.sync` (your Google account, encrypted by Chrome) | Not sent to any third-party server |
| Subtitle (caption) text from YouTube videos you watch | Translate to your chosen target language for display | RAM during playback; translated text cached in your browser's IndexedDB | See "External services" below |
| Translation cache | Avoid re-translating the same video | IndexedDB (your local browser, auto-pruned at 30 days or 200 entries) | Not sent to any third-party server |
| Gemini API key (only if you choose the Gemini backend) | Authenticate your own Google AI Studio key for translation | `chrome.storage.local` (this device only, NOT synced to your Google account) | Sent only to Google's Gemini API as your `x-goog-api-key` header |
| Mindlogic API key + Gateway base URL (only if you choose the Mindlogic Gateway backend) | Authenticate your own school/organization-issued gateway key for translation | `chrome.storage.local` (key) / `chrome.storage.sync` (base URL, not sensitive) — this device only for the key, NOT synced to your Google account | Sent only to the Gateway base URL you enter in Options (your organization's own domain, e.g. `https://factchat-cloud.mindlogic.ai/`) as the `Authorization: Bearer` header |
| Last translation backend used (which backend, when) | Show "최근 번역: X · N분 전" in the popup so you can see whether your preferred backend or a fallback handled the latest translation | `chrome.storage.local` (this device only) | Not sent to any third-party server |
| Text you select or type when using "Explain" / "Ask a question" (💡/❓ buttons, or the `Alt+Q` shortcut) | Get an AI explanation or answer from your chosen backend (Gemini or Mindlogic Gateway) | RAM only, not persisted beyond the on-screen panel (closing the tab or the panel discards it) | See "AI Explain / Ask a question" below |
| Notion integration token + database ID (only if you use the 📝 Notion export button) | Save an explanation/answer as a page in your own Notion database | Token: `chrome.storage.local` (this device only) / Database ID: `chrome.storage.sync` | Sent only to `https://api.notion.com` with your token as the `Authorization: Bearer` header |

## 2. External services

Depending on which translation backend you select in the Extension's options:

### Google Free (default)
- The subtitle text of the current video is sent in batches to `https://translate.googleapis.com/translate_a/single` (Google's unofficial free translation endpoint).
- Each request includes the source-language text, source language code, and target language code. No identifying information is attached by the Extension.
- The request reaches Google's servers and is subject to Google's privacy practices.

### Chrome Built-in (offline)
- Translation runs entirely on your device using Chrome's built-in Translator API (Chrome 138+).
- **No subtitle text leaves your device.**
- On first use of a new language pair, Chrome may download a small translation model from Google's servers (handled by the browser itself, not by the Extension).

### Gemini (Bring Your Own Key)
- You enter your own Gemini API key (issued from Google AI Studio) on the Extension's options page. The key is stored in `chrome.storage.local` on the current device only and is **not** synced to your Google account.
- When this backend is selected, the subtitle text of the current video is sent in batches to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash[-lite]:generateContent` together with your key.
- Each request includes the source-language text and target language. No identifying information is attached by the Extension.
- The request reaches Google's servers and is subject to Google's privacy practices (the Gemini API terms apply to your usage of your own key).
- If the call fails (rate limit, invalid key, etc.), the Extension automatically falls back to **Google Free** so that subtitles still appear. You can see the actual backend in use via the popup or console logs.

### Mindlogic Gateway (Bring Your Own Key)
- You enter your own API key, issued by a school or organization that subscribes to the Mindlogic API Gateway, on the Extension's options page. The key is stored in `chrome.storage.local` on the current device only and is **not** synced to your Google account. You also enter that organization's Gateway base URL — different organizations use different domains, so the Extension does not assume a fixed one.
- When this backend is selected, the subtitle text of the current video is sent in batches to the base URL you configured (e.g. `https://factchat-cloud.mindlogic.ai/v1/gateway/chat/completions`) together with your key (as an `Authorization: Bearer` header) and the model ID you chose (e.g. `gemini-2.5-flash`, `claude-haiku-4-5-20251001`, `gpt-5.4-mini`).
- Each request includes the source-language text and target language. No identifying information is attached by the Extension.
- The gateway forwards the request to the upstream provider (OpenAI, Anthropic, Google, etc.) selected by the model ID. Your subtitle text reaches both Mindlogic and that upstream provider, and is subject to their respective privacy practices and the terms of your gateway subscription.
- If the call fails (no key, invalid key, rate limit, etc.), the Extension automatically falls back to **Google Free** so that subtitles still appear. You can see the actual backend in use via the popup or console logs.

You can switch backends or disable the Extension at any time from the popup or options page.

### AI Explain / Ask a question (Gemini / Mindlogic Gateway)

Separately from subtitle translation, the Extension lets you select text (in the subtitle box or in the answer panel itself) or type a free-form question to get an AI explanation — via the 💡/❓ buttons in the panel, or the `Alt+Q` keyboard shortcut. This uses whichever BYOK backend (Gemini or Mindlogic Gateway) you've configured for "해설" in Options, and sends your selected text/question (plus, on YouTube, the surrounding subtitle line for context) to that backend's API — same endpoints and key-handling as described above. No conversation history is sent beyond what you can see in the current answer thread (follow-up questions include the visible thread; closing the tab discards it).

**As of this version, `Alt+Q` works on any website, not only YouTube.** Pressing it injects a small answer panel into the current tab **only for that one keypress** (Chrome's `activeTab` permission — the Extension does not run on other websites otherwise, and stops having any special access to that tab once you navigate away or close the panel). On non-YouTube pages there is no subtitle context to send — only the text you select or type.

### Notion (optional export)

If you enter a Notion integration token and database ID in Options, the 📝 Notion button in the answer panel saves that answer (and, on YouTube, the video title/URL) as a page in your own Notion database, via `https://api.notion.com`. This only happens when you click that button — nothing is saved automatically.

## 3. Permissions explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save your settings (sync) and the translation cache (IndexedDB). |
| `scripting` | Run the content script on YouTube pages (declared in `content_scripts`), and — together with `activeTab` — inject the "Ask AI" panel into the active tab when you press `Alt+Q` on a non-YouTube page. |
| `offscreen` | Host the Chrome Built-in Translator API, which requires a DOM context. |
| `host_permissions: https://www.youtube.com/*` | Read YouTube caption tracks and overlay subtitles on the video player. |
| `host_permissions: https://translate.googleapis.com/*` | Call the Google Free translation endpoint when that backend is selected. |
| `host_permissions: https://generativelanguage.googleapis.com/*` | Call the Gemini API with your own API key when the Gemini backend is selected. The Extension itself does not ship any API key. |
| `host_permissions: https://factchat-cloud.mindlogic.ai/*`, `https://factchat.mindlogic-kr-api.com/*` | Call the Mindlogic API Gateway (at the base URL you configure) with your own school/organization key when the Mindlogic backend is selected. The Extension itself does not ship any API key. Only these known gateway domains are pre-declared; a brand-new organization domain would require an Extension update. |
| `host_permissions: https://api.notion.com/*` | Save an AI explanation/answer to your own Notion database when you click the 📝 Notion button and have entered your own Notion integration token. |
| `activeTab` | Let the `Alt+Q` shortcut inject the "Ask AI" answer panel into whichever tab is active **at the moment you press it**, on any website — not only YouTube. This grants no standing access to that tab; it's scoped to that one user-initiated action. |

The Extension does **not** request the broad `tabs`, `history`, `cookies`, or `webRequest` permissions and cannot read your browsing history, other tabs' contents, or any cookies.

## 4. Your controls

- **Disable subtitles**: Toggle from the popup, or press your configured toggle key on a YouTube page (default `G`; changeable in Options — this key only controls the Extension's dual subtitles, not YouTube's own native captions).
- **Clear translation cache**: Options page → Management → Clear cache.
- **Reset all settings**: Options page → Management → Reset to defaults.
- **Remove your Gemini API key**: Options page → Gemini settings → clear the API key field. The key is then removed from `chrome.storage.local`.
- **Remove your Mindlogic API key**: Options page → Mindlogic Gateway settings → clear the API key field. The key is then removed from `chrome.storage.local`.
- **Uninstall**: `chrome://extensions` → remove. This also clears `chrome.storage.sync` and `chrome.storage.local` data tied to the Extension (subject to Chrome's sync cleanup behavior on your account).

## 5. Children's privacy

The Extension is not directed at children under 13. It does not knowingly collect data from any user.

## 6. Changes to this policy

If we materially change how data is handled, the updated policy will be published at the same URL and the "Last updated" date will change. Continued use after the update constitutes acceptance.

## 7. Contact

Open an issue on the project's GitHub repository:
<https://github.com/mw3love/youtube_dual_subtitle/issues>

---

이 문서는 YouTube Dual Subtitle 확장의 데이터 처리 정책입니다. 영문 원문이 정본이며, 한국어 안내가 필요하면 동일 내용을 번역하여 별도 페이지로 게시할 수 있습니다.
