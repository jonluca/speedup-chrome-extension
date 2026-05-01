import { browser } from "wxt/browser";

import {
  addSpeedStatsIncrements,
  DEFAULT_SPEED_CONFIG,
  getSpeedStatsStorageKey,
  normalizeFrameId,
  normalizeSpeedCallCommand,
  normalizeSpeedCallSnapshots,
  normalizeTabId,
  normalizeSpeedStatsIncrements,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
  SPEED_CALLS_LIST_MESSAGE_TYPE,
  SPEED_CALLS_REFRESH_MESSAGE_TYPE,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_STATS_MESSAGE_TYPE,
  type SpeedCallPanelItem,
  type SpeedCallSnapshot,
} from "../utils/speed-config";

let statsWriteQueue = Promise.resolve();

type StoredFrameCalls = {
  calls: SpeedCallSnapshot[];
  capturedAt: number;
  frameId: number;
  frameUrl: string;
  tabId: number;
};

const callSnapshotsByTabId = new Map<number, Map<number, StoredFrameCalls>>();

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

function getSenderTabId(sender: unknown): number | undefined {
  return normalizeTabId((sender as { tab?: { id?: unknown } })?.tab?.id);
}

function getSenderFrameId(sender: unknown): number {
  return normalizeFrameId((sender as { frameId?: unknown })?.frameId) ?? 0;
}

function getTabCallItems(tabId: number): SpeedCallPanelItem[] {
  const frameSnapshots = callSnapshotsByTabId.get(tabId);

  if (!frameSnapshots) {
    return [];
  }

  return Array.from(frameSnapshots.values()).flatMap((snapshot) =>
    snapshot.calls.map((call) => ({
      ...call,
      frameId: snapshot.frameId,
      tabId: snapshot.tabId,
    })),
  );
}

async function broadcastTabCalls(tabId: number): Promise<void> {
  await browser.runtime
    .sendMessage({
      calls: getTabCallItems(tabId),
      tabId,
      type: SPEED_CALLS_CHANGED_MESSAGE_TYPE,
    })
    .catch(() => undefined);
}

function recordSpeedCallSnapshot(message: unknown, sender: unknown): void {
  const tabId = getSenderTabId(sender);

  if (tabId == null) {
    return;
  }

  const frameId = getSenderFrameId(sender);
  const calls = normalizeSpeedCallSnapshots((message as { calls?: unknown }).calls);
  const capturedAt = Number((message as { capturedAt?: unknown }).capturedAt);
  const frameUrl =
    typeof (message as { frameUrl?: unknown }).frameUrl === "string"
      ? (message as { frameUrl: string }).frameUrl
      : "";
  let frameSnapshots = callSnapshotsByTabId.get(tabId);

  if (!frameSnapshots) {
    frameSnapshots = new Map();
    callSnapshotsByTabId.set(tabId, frameSnapshots);
  }

  frameSnapshots.set(frameId, {
    calls,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
    frameId,
    frameUrl,
    tabId,
  });

  void broadcastTabCalls(tabId);
}

async function getActiveTab(): Promise<{
  id?: number;
  title?: string;
  url?: string;
}> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const activeTab = tabs[0];
  const id = normalizeTabId(activeTab?.id);

  return {
    id,
    title: activeTab?.title,
    url: activeTab?.url,
  };
}

async function refreshTabCalls(tabId: number): Promise<void> {
  await browser.tabs
    .sendMessage(tabId, {
      type: SPEED_CALLS_REFRESH_MESSAGE_TYPE,
    })
    .catch(() => undefined);
}

async function getCallListResponse(message: unknown): Promise<{
  calls: SpeedCallPanelItem[];
  tab: { id?: number; title?: string; url?: string };
}> {
  const requestedTabId = normalizeTabId((message as { tabId?: unknown }).tabId);
  const activeTab = await getActiveTab();
  const tabId = requestedTabId ?? activeTab.id;

  if (tabId != null) {
    void refreshTabCalls(tabId);
  }

  return {
    calls: tabId == null ? [] : getTabCallItems(tabId),
    tab: requestedTabId == null ? activeTab : { id: tabId },
  };
}

async function sendCallCommand(message: unknown): Promise<{ ok: boolean }> {
  const tabId = normalizeTabId((message as { tabId?: unknown }).tabId);
  const frameId = normalizeFrameId((message as { frameId?: unknown }).frameId);
  const callId = (message as { callId?: unknown }).callId;
  const command = normalizeSpeedCallCommand((message as { command?: unknown }).command);
  const sourceKey = (message as { sourceKey?: unknown }).sourceKey;

  if (tabId == null || frameId == null || typeof callId !== "string") {
    return { ok: false };
  }

  await browser.tabs
    .sendMessage(
      tabId,
      {
        callId,
        command,
        sourceKey,
        type: SPEED_CALLS_COMMAND_MESSAGE_TYPE,
      },
      { frameId },
    )
    .catch(() => undefined);

  return { ok: true };
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
    if (message == null || typeof message !== "object") {
      return;
    }

    const type = (message as { type?: unknown }).type;

    if (type === SPEED_STATS_MESSAGE_TYPE) {
      const tabId = getSenderTabId(sender);

      statsWriteQueue = statsWriteQueue
        .catch(() => undefined)
        .then(() => recordSpeedStats(tabId, (message as { increments?: unknown }).increments));

      return statsWriteQueue;
    }

    if (type === SPEED_CALLS_CHANGED_MESSAGE_TYPE && getSenderTabId(sender) != null) {
      recordSpeedCallSnapshot(message, sender);
      return;
    }

    if (type === SPEED_CALLS_LIST_MESSAGE_TYPE) {
      return getCallListResponse(message);
    }

    if (type === SPEED_CALLS_COMMAND_MESSAGE_TYPE) {
      return sendCallCommand(message);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    const statsStorageKey = getSpeedStatsStorageKey(tabId);

    if (statsStorageKey) {
      statsWriteQueue = statsWriteQueue
        .catch(() => undefined)
        .then(() => browser.storage.local.remove(statsStorageKey));
    }

    callSnapshotsByTabId.delete(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading" && changeInfo.url == null) {
      return;
    }

    if (callSnapshotsByTabId.delete(tabId)) {
      void broadcastTabCalls(tabId);
    }
  });
});
