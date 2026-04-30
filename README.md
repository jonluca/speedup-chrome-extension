# Speed Up Pages

A Chrome extension that speeds up webpage timers and animation frames. It injects a small page script into HTTP and HTTPS pages, then lets you control the speed multiplier from the extension popup.

## Features

- Toggle speed changes on or off from the popup.
- Choose a speed from `1x` to `100x` in `0.25x` increments.
- Quick-select common speeds: `1x`, `1.5x`, `2x`, `3x`, `4x`, `8x`, and `16x`.
- Enter and apply a custom speed value from the popup.
- Disable speed changes on the current site with a per-host exclusion.
- Enable or disable speed changes for each wrapped function type.
- Applies changes to all frames on matching pages.
- Persists settings in extension local storage.

## How It Works

The content script runs at `document_start` and injects `speed-page.js` into the page context. That page script wraps:

- `setTimeout`
- `setInterval`
- `clearTimeout`
- `clearInterval`
- `requestAnimationFrame`
- `cancelAnimationFrame`

When the popup updates the speed setting, the content script forwards the new config to the page script so active timers can be rescheduled against the new multiplier.
Each wrapped function type can be toggled independently from the popup's call tracking section.

This does not speed up network requests, media playback, CSS animations, or browser-native work that does not rely on the wrapped JavaScript timer APIs.

## Requirements

- [Bun](https://bun.sh/) `1.3.13` or compatible
- Chrome or another Chromium-based browser

## Install

```sh
bun install
```

## Development

Start WXT in development mode:

```sh
bun run dev
```

For Chrome-specific development:

```sh
bun run dev:chrome
```

WXT will create development output under `.output/`. Load the generated extension directory in Chrome from `chrome://extensions` with Developer mode enabled.

## Build

Create a production build:

```sh
bun run build
```

The Chrome build output is generated under `.output/chrome-mv3`.

Create a zip package:

```sh
bun run zip
```

## Quality Checks

Run TypeScript, linting, and formatting checks:

```sh
bun run check
```

Individual commands are also available:

```sh
bun run compile
bun run lint
bun run format:check
```

Format the project:

```sh
bun run format
```

## Project Structure

```text
entrypoints/
  background.ts        Initializes default extension settings.
  speed.content.ts     Injects the page script and forwards config changes.
  speed-page.ts        Wraps page timer and animation frame APIs.
  popup/               React popup UI for speed controls.
utils/
  speed-config.ts      Shared speed config constants and normalization helpers.
wxt.config.ts          WXT and extension manifest configuration.
```

## Notes

Changing core timer behavior can affect how some sites work. If a page behaves unexpectedly, pause the extension from the popup or reset it to normal speed.
