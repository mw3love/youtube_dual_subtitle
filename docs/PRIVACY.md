# Privacy Policy — YouTube Dual Subtitle

_Last updated: 2026-05-27_

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
| Last translation backend used (which backend, when) | Show "최근 번역: X · N분 전" in the popup so you can see whether your preferred backend or a fallback handled the latest translation | `chrome.storage.local` (this device only) | Not sent to any third-party server |

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

You can switch backends or disable the Extension at any time from the popup or options page.

## 3. Permissions explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save your settings (sync) and the translation cache (IndexedDB). |
| `scripting` | Run the content script on YouTube pages (declared in `content_scripts`). |
| `offscreen` | Host the Chrome Built-in Translator API, which requires a DOM context. |
| `host_permissions: https://www.youtube.com/*` | Read YouTube caption tracks and overlay subtitles on the video player. |
| `host_permissions: https://translate.googleapis.com/*` | Call the Google Free translation endpoint when that backend is selected. |
| `host_permissions: https://generativelanguage.googleapis.com/*` | Call the Gemini API with your own API key when the Gemini backend is selected. The Extension itself does not ship any API key. |

The Extension does **not** request the `tabs`, `history`, `cookies`, or `webRequest` permissions and cannot read your browsing history, other tabs, or any cookies.

## 4. Your controls

- **Disable subtitles**: Toggle from the popup, or press `C` on a YouTube page.
- **Clear translation cache**: Options page → Management → Clear cache.
- **Reset all settings**: Options page → Management → Reset to defaults.
- **Remove your Gemini API key**: Options page → Gemini settings → clear the API key field. The key is then removed from `chrome.storage.local`.
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
