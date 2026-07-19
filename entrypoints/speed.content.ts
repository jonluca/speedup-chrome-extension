import { browser } from "wxt/browser";

import {
  DEFAULT_SPEED_CONFIG,
  normalizeSpeedCallSources,
  normalizeSpeedCallSnapshots,
  normalizeSpeedConfig,
  normalizeSpeedStatsIncrements,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
  SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE,
  SPEED_CALLS_REFRESH_MESSAGE_TYPE,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY,
  SPEED_MESSAGE_TYPE,
  SPEED_STATS_MESSAGE_TYPE,
  type SpeedConfig,
  type SpeedCallSource,
} from "../utils/speed-config";

function postSpeedConfig(config: SpeedConfig): void {
  window.postMessage(
    {
      type: SPEED_MESSAGE_TYPE,
      config,
    },
    "*",
  );
}

function postDisabledCallSources(sources: SpeedCallSource[]): void {
  window.postMessage(
    {
      sources,
      type: SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE,
    },
    "*",
  );
}

async function loadSpeedConfig(): Promise<SpeedConfig> {
  const stored = await browser.storage.local.get(SPEED_CONFIG_STORAGE_KEY);
  return normalizeSpeedConfig(stored[SPEED_CONFIG_STORAGE_KEY] ?? DEFAULT_SPEED_CONFIG);
}

async function loadDisabledCallSources(): Promise<SpeedCallSource[]> {
  const stored = await browser.storage.local.get(SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY);
  return normalizeSpeedCallSources(stored[SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY]);
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  allFrames: true,
  async main(ctx) {
    let latestDisabledCallSources: SpeedCallSource[] = [];

    async function applySpeedConfig(config: SpeedConfig): Promise<void> {
      if (!ctx.isValid) {
        return;
      }

      postSpeedConfig(config);
      postDisabledCallSources(latestDisabledCallSources);
    }

    async function applyDisabledCallSources(sources: SpeedCallSource[]): Promise<void> {
      latestDisabledCallSources = sources;

      if (!ctx.isValid) {
        return;
      }

      postDisabledCallSources(sources);
    }

    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window || !ctx.isValid) {
        return;
      }

      if (event.data?.type === SPEED_STATS_MESSAGE_TYPE) {
        const increments = normalizeSpeedStatsIncrements(event.data.increments);

        if (increments.length === 0) {
          return;
        }

        void browser.runtime
          .sendMessage({
            increments,
            type: SPEED_STATS_MESSAGE_TYPE,
          })
          .catch(() => undefined);
        return;
      }

      if (event.data?.type === SPEED_CALLS_CHANGED_MESSAGE_TYPE) {
        void browser.runtime
          .sendMessage({
            calls: normalizeSpeedCallSnapshots(event.data.calls),
            capturedAt: event.data.capturedAt,
            frameUrl: window.location.href,
            type: SPEED_CALLS_CHANGED_MESSAGE_TYPE,
          })
          .catch(() => undefined);
      }
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!ctx.isValid || message == null || typeof message !== "object") {
        return;
      }

      const type = (message as { type?: unknown }).type;

      if (
        type !== SPEED_CALLS_COMMAND_MESSAGE_TYPE &&
        type !== SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE &&
        type !== SPEED_CALLS_REFRESH_MESSAGE_TYPE
      ) {
        return;
      }

      window.postMessage(message, "*");
      return Promise.resolve({ ok: true });
    });

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !ctx.isValid) {
        return;
      }

      const change = changes[SPEED_CONFIG_STORAGE_KEY];

      if (change) {
        void applySpeedConfig(normalizeSpeedConfig(change.newValue));
      }

      const disabledSourcesChange = changes[SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY];

      if (disabledSourcesChange) {
        void applyDisabledCallSources(normalizeSpeedCallSources(disabledSourcesChange.newValue));
      }
    });

    window.addEventListener("pagehide", () => {
      void browser.runtime
        .sendMessage({
          calls: [],
          capturedAt: Date.now(),
          frameUrl: window.location.href,
          type: SPEED_CALLS_CHANGED_MESSAGE_TYPE,
        })
        .catch(() => undefined);
    });

    const [initialConfig, initialDisabledCallSources] = await Promise.all([
      loadSpeedConfig(),
      loadDisabledCallSources(),
    ]);

    latestDisabledCallSources = initialDisabledCallSources;
    await applySpeedConfig(initialConfig);
  },
});
