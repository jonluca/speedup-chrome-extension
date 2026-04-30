import { browser } from "wxt/browser";

import {
  addSpeedStatsIncrements,
  DEFAULT_SPEED_CONFIG,
  getSpeedStatsStorageKey,
  normalizeTabId,
  normalizeSpeedStatsIncrements,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_STATS_MESSAGE_TYPE,
} from "../utils/speed-config";

let statsWriteQueue = Promise.resolve();

async function recordSpeedStats(tabId: unknown, increments: unknown): Promise<void> {
  const statsStorageKey = getSpeedStatsStorageKey(tabId);

  if (!statsStorageKey) {
    return;
  }

  const normalizedIncrements = normalizeSpeedStatsIncrements(increments);

  if (normalizedIncrements.length === 0) {
    return;
  }

  const stored = await browser.storage.local.get(statsStorageKey);
  const nextStats = addSpeedStatsIncrements(stored[statsStorageKey], normalizedIncrements);

  await browser.storage.local.set({
    [statsStorageKey]: nextStats,
  });
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const existing = await browser.storage.local.get(SPEED_CONFIG_STORAGE_KEY);
    const defaults: Record<string, unknown> = {};

    if (existing[SPEED_CONFIG_STORAGE_KEY] == null) {
      defaults[SPEED_CONFIG_STORAGE_KEY] = DEFAULT_SPEED_CONFIG;
    }

    if (Object.keys(defaults).length > 0) {
      await browser.storage.local.set(defaults);
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, sender: unknown) => {
    if (
      message == null ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== SPEED_STATS_MESSAGE_TYPE
    ) {
      return;
    }

    const tabId = normalizeTabId((sender as { tab?: { id?: unknown } })?.tab?.id);

    statsWriteQueue = statsWriteQueue
      .catch(() => undefined)
      .then(() => recordSpeedStats(tabId, (message as { increments?: unknown }).increments));

    return statsWriteQueue;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    const statsStorageKey = getSpeedStatsStorageKey(tabId);

    if (statsStorageKey) {
      statsWriteQueue = statsWriteQueue
        .catch(() => undefined)
        .then(() => browser.storage.local.remove(statsStorageKey));
    }
  });
});
