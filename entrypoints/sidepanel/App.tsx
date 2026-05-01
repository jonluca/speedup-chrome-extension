import { useCallback, useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { browser } from "wxt/browser";

import {
  clampSpeed,
  DEFAULT_SPEED_CONFIG,
  formatSpeedLabel,
  getHostnameFromUrl,
  isHostnameExcluded,
  MAX_SPEED,
  MIN_SPEED,
  normalizeHiddenCallSourceKeys,
  normalizeSpeedCallSources,
  normalizeSpeedCallPanelItems,
  normalizeSpeedConfig,
  normalizeTabId,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
  SPEED_CALLS_LIST_MESSAGE_TYPE,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY,
  SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY,
  SPEED_STEP,
  type SpeedCallCommand,
  type SpeedCallPanelItem,
  type SpeedCallSource,
  type SpeedConfig,
  type SpeedMode,
} from "../../utils/speed-config";

const QUICK_SPEEDS = [1, 1.5, 2, 3, 4, 8, 16];
const numberFormatter = new Intl.NumberFormat();
const buttonInteractiveClass =
  "cursor-pointer rounded-lg border transition-colors focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const neutralButtonClass = `${buttonInteractiveClass} border-slate-300 bg-white text-slate-800 hover:border-blue-300 hover:bg-[#f8fbff]`;
const selectedButtonClass = `${buttonInteractiveClass} border-blue-600 bg-blue-600 text-white hover:border-blue-600 hover:bg-blue-600`;
const dangerButtonClass = `${buttonInteractiveClass} border-red-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50`;
const speedButtonClass = `${neutralButtonClass} min-h-[34px]`;
const selectedSpeedButtonClass = `${selectedButtonClass} min-h-[34px]`;
const customSpeedInputBaseClass =
  "min-h-[34px] min-w-0 rounded-lg border px-2 text-center focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const customSpeedInputClass = `${customSpeedInputBaseClass} border-slate-300 bg-white text-slate-800`;
const selectedCustomSpeedInputClass = `${customSpeedInputBaseClass} border-blue-600 bg-blue-600 text-white`;
const CALL_ROW_RETENTION_MS = 3000;
const CALLS_COMMIT_DELAY_MS = 250;
const LIVE_STATUS_GRACE_MS = 750;
const TIMER_TICK_MS = 500;

type SortMode = "duration" | "recent";

type DisplayedSpeedCallPanelItem = SpeedCallPanelItem & {
  activeCount: number;
  displayKey: string;
  firstSeenAt: number;
  isLive: boolean;
  lastSeenAt: number;
};

type TimedSpeedCallPanelItem = DisplayedSpeedCallPanelItem & {
  ageMs: number;
  inactiveMs: number;
  isRecentlyActive: boolean;
  remainingMs: number;
};

type RetainedCallRecord = {
  activeCount: number;
  call: SpeedCallPanelItem;
  firstSeenAt: number;
  lastSeenAt: number;
};

type AggregatedCallRecord = {
  activeCount: number;
  call: SpeedCallPanelItem;
  firstAddedAt: number;
};

type ActiveTab = {
  id?: number;
  title?: string;
  url?: string;
};

type PanelResponse = {
  calls?: unknown;
  tab?: ActiveTab;
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0ms";
  }

  if (ms < 1000) {
    return `${Math.ceil(ms)}ms`;
  }

  if (ms < 60_000) {
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
  }

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function normalizeActiveTab(tab: unknown): ActiveTab {
  if (tab == null || typeof tab !== "object") {
    return {};
  }

  const source = tab as ActiveTab;

  return {
    id: normalizeTabId(source.id),
    title: typeof source.title === "string" ? source.title : undefined,
    url: typeof source.url === "string" ? source.url : undefined,
  };
}

function getCallSourceKey(call: Pick<SpeedCallPanelItem, "sourceKey">): string {
  return call.sourceKey;
}

function getCallRetentionKey(
  call: Pick<SpeedCallPanelItem, "frameId" | "sourceKey" | "tabId">,
): string {
  return `${call.tabId}:${call.frameId}:${call.sourceKey}`;
}

function sortTimedCalls(
  calls: TimedSpeedCallPanelItem[],
  sortMode: SortMode,
): TimedSpeedCallPanelItem[] {
  return calls.toSorted((left, right) => {
    if (sortMode === "recent") {
      return (
        right.lastSeenAt - left.lastSeenAt ||
        left.firstSeenAt - right.firstSeenAt ||
        left.sourceLabel.localeCompare(right.sourceLabel)
      );
    }

    return (
      right.delay - left.delay ||
      right.lastSeenAt - left.lastSeenAt ||
      left.firstSeenAt - right.firstSeenAt ||
      left.sourceLabel.localeCompare(right.sourceLabel)
    );
  });
}

function getRepresentativeCall(
  left: SpeedCallPanelItem | undefined,
  right: SpeedCallPanelItem,
): SpeedCallPanelItem {
  if (!left || right.addedAt > left.addedAt || right.dueAt > left.dueAt) {
    return right;
  }

  return left;
}

function aggregateCall(
  callsByRetentionKey: Map<string, AggregatedCallRecord>,
  call: SpeedCallPanelItem,
): void {
  const retentionKey = getCallRetentionKey(call);
  const current = callsByRetentionKey.get(retentionKey);

  if (!current) {
    callsByRetentionKey.set(retentionKey, {
      activeCount: 1,
      call,
      firstAddedAt: call.addedAt,
    });
    return;
  }

  callsByRetentionKey.set(retentionKey, {
    activeCount: current.activeCount + 1,
    call: getRepresentativeCall(current.call, call),
    firstAddedAt: Math.min(current.firstAddedAt, call.addedAt),
  });
}

function mergeSampledCalls(
  currentCalls: SpeedCallPanelItem[] | undefined,
  nextCalls: SpeedCallPanelItem[],
): SpeedCallPanelItem[] {
  if (!currentCalls || currentCalls.length === 0) {
    return nextCalls;
  }

  if (nextCalls.length === 0) {
    return currentCalls;
  }

  const sampledCallsByRetentionKey = new Map<string, AggregatedCallRecord>();

  for (const call of currentCalls) {
    aggregateCall(sampledCallsByRetentionKey, call);
  }

  for (const call of nextCalls) {
    aggregateCall(sampledCallsByRetentionKey, call);
  }

  return Array.from(sampledCallsByRetentionKey.values()).map((record) => record.call);
}

function pruneRetainedCalls(
  retainedCalls: Map<string, RetainedCallRecord>,
  now: number,
  activeTabId?: number,
): Map<string, RetainedCallRecord> {
  let changed = false;
  const next = new Map<string, RetainedCallRecord>();

  for (const [key, record] of retainedCalls) {
    const isCurrentTab = activeTabId == null || record.call.tabId === activeTabId;
    const isFresh = now - record.lastSeenAt <= CALL_ROW_RETENTION_MS;

    if (isCurrentTab && isFresh) {
      next.set(key, record);
      continue;
    }

    changed = true;
  }

  return changed ? next : retainedCalls;
}

type CallCardProps = {
  call: TimedSpeedCallPanelItem;
  config: SpeedConfig;
  isLoaded: boolean;
  onDisable: (call: SpeedCallPanelItem) => void;
  onDisableSource: (call: SpeedCallPanelItem) => void;
  onHide?: (call: SpeedCallPanelItem) => void;
  onInvoke: (call: SpeedCallPanelItem) => void;
  onShowSource?: (call: SpeedCallPanelItem) => void;
};

function CallCard({
  call,
  config,
  isLoaded,
  onDisable,
  onDisableSource,
  onHide,
  onInvoke,
  onShowSource,
}: CallCardProps) {
  const callHost = getHostnameFromUrl(call.url);
  const isCallSpeedAllowed =
    config.enabled &&
    config.enabledFunctions[call.functionName] &&
    !isHostnameExcluded(config, callHost);
  const isCallRunningFast = call.speed > MIN_SPEED;
  const isManualPauseActive =
    config.mode === "manual" && config.pauseInvocations && isCallSpeedAllowed;
  const canDisableSource = isLoaded && config.mode === "manual" && isCallSpeedAllowed;
  const canToggleCall = call.isLive && canDisableSource;
  const statusLabel = call.isRecentlyActive
    ? isManualPauseActive
      ? "paused"
      : isCallRunningFast
        ? formatSpeedLabel(call.speed)
        : "normal"
    : "recent";
  const activeCountLabel =
    call.isLive && call.activeCount > 1
      ? `, ${numberFormatter.format(call.activeCount)} active`
      : "";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block font-mono text-xs font-[720] text-slate-900">
            {call.functionName}
          </span>
          <span className="block truncate text-[11px] text-slate-500">
            {call.handlerLabel}
            {callHost ? `, ${callHost}` : ""}
            {activeCountLabel}
          </span>
          <span
            className="block truncate font-mono text-[10px] text-slate-400"
            title={call.sourceLabel}
          >
            {call.sourceLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onHide ? (
            <button
              aria-label="Hide this card"
              className={`${neutralButtonClass} min-h-[24px] px-1.5 text-[11px] font-[650]`}
              disabled={!isLoaded}
              title="Hide this card"
              type="button"
              onClick={() => onHide(call)}
            >
              Hide
            </button>
          ) : null}
          <span
            className={`rounded-full px-2 py-1 text-[11px] font-[720] ${
              call.isRecentlyActive && (isManualPauseActive || isCallRunningFast)
                ? "bg-blue-100 text-blue-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-500">
        <span>
          <strong className="block text-xs text-slate-900">
            {formatDuration(call.isLive ? call.remainingMs : call.inactiveMs)}
          </strong>
          {call.isLive ? "remaining" : "last seen"}
        </span>
        <span>
          <strong className="block text-xs text-slate-900">{formatDuration(call.delay)}</strong>
          delay
        </span>
        <span>
          <strong className="block text-xs text-slate-900">{formatDuration(call.ageMs)}</strong>
          tracked
        </span>
      </div>

      <div className="grid gap-2">
        {onShowSource ? (
          <button
            className={`${neutralButtonClass} min-h-[32px] px-2 text-sm font-[650]`}
            disabled={!isLoaded}
            type="button"
            onClick={() => onShowSource(call)}
          >
            Unhide source
          </button>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <button
            className={`${dangerButtonClass} min-h-[32px] px-2 text-sm font-[650]`}
            disabled={!canToggleCall}
            type="button"
            onClick={() => onDisable(call)}
          >
            Disable once
          </button>
          <button
            className={`${dangerButtonClass} min-h-[32px] px-2 text-sm font-[650]`}
            disabled={!canDisableSource}
            type="button"
            onClick={() => onDisableSource(call)}
          >
            Disable source
          </button>
        </div>
        <div>
          <button
            className={`${selectedButtonClass} min-h-[32px] w-full px-2 text-sm font-[650]`}
            disabled={!canToggleCall}
            type="button"
            onClick={() => onInvoke(call)}
          >
            {call.isLive ? "Invoke now" : "Waiting"}
          </button>
        </div>
      </div>
    </div>
  );
}

type CallListProps = {
  calls: TimedSpeedCallPanelItem[];
  config: SpeedConfig;
  isLoaded: boolean;
  onDisable: (call: SpeedCallPanelItem) => void;
  onDisableSource: (call: SpeedCallPanelItem) => void;
  onHide?: (call: SpeedCallPanelItem) => void;
  onInvoke: (call: SpeedCallPanelItem) => void;
  onShowSource?: (call: SpeedCallPanelItem) => void;
};

function CallList({
  calls,
  config,
  isLoaded,
  onDisable,
  onDisableSource,
  onHide,
  onInvoke,
  onShowSource,
}: CallListProps) {
  return (
    <Virtuoso
      className="call-list overflow-x-hidden"
      computeItemKey={(_, call) => call.displayKey}
      data={calls}
      increaseViewportBy={300}
      itemContent={(_, call) => (
        <div className="pb-2">
          <CallCard
            call={call}
            config={config}
            isLoaded={isLoaded}
            onDisable={onDisable}
            onDisableSource={onDisableSource}
            onHide={onHide}
            onInvoke={onInvoke}
            onShowSource={onShowSource}
          />
        </div>
      )}
      useWindowScroll
    />
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>({});
  const [calls, setCalls] = useState<SpeedCallPanelItem[]>([]);
  const [config, setConfig] = useState<SpeedConfig>(DEFAULT_SPEED_CONFIG);
  const [customSpeed, setCustomSpeed] = useState(() => DEFAULT_SPEED_CONFIG.speed.toString());
  const [disabledSources, setDisabledSources] = useState<SpeedCallSource[]>(() => []);
  const [areDisabledSourcesExpanded, setAreDisabledSourcesExpanded] = useState(false);
  const [hiddenSourceKeys, setHiddenSourceKeys] = useState<Set<string>>(() => new Set());
  const [areHiddenCallsExpanded, setAreHiddenCallsExpanded] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [retainedCalls, setRetainedCalls] = useState<Map<string, RetainedCallRecord>>(
    () => new Map(),
  );
  const [sortMode, setSortMode] = useState<SortMode>("duration");

  const loadPanelState = useCallback(async (requestedTabId?: number) => {
    const [stored, response] = await Promise.all([
      browser.storage.local.get([
        SPEED_CONFIG_STORAGE_KEY,
        SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY,
        SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY,
      ]),
      browser.runtime
        .sendMessage({
          tabId: requestedTabId,
          type: SPEED_CALLS_LIST_MESSAGE_TYPE,
        })
        .catch(() => undefined),
    ]);

    const panelResponse = (response ?? {}) as PanelResponse;
    const tab = normalizeActiveTab(panelResponse.tab);

    setActiveTab(tab);
    setCalls(normalizeSpeedCallPanelItems(panelResponse.calls));
    setConfig(normalizeSpeedConfig(stored[SPEED_CONFIG_STORAGE_KEY]));
    setDisabledSources(normalizeSpeedCallSources(stored[SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY]));
    setHiddenSourceKeys(
      new Set(normalizeHiddenCallSourceKeys(stored[SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY])),
    );
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    void loadPanelState();
  }, [loadPanelState]);

  useEffect(() => {
    setCustomSpeed(config.speed.toString());
  }, [config.speed]);

  useEffect(() => {
    const tickId = window.setInterval(() => setNow(Date.now()), TIMER_TICK_MS);
    return () => window.clearInterval(tickId);
  }, []);

  useEffect(() => {
    setRetainedCalls((current) => {
      const receivedAt = Date.now();
      const next = new Map(pruneRetainedCalls(current, receivedAt, activeTab.id));
      const activeCallsByRetentionKey = new Map<string, AggregatedCallRecord>();

      for (const call of calls) {
        aggregateCall(activeCallsByRetentionKey, call);
      }

      for (const [retentionKey, activeCall] of activeCallsByRetentionKey) {
        const previous = next.get(retentionKey);

        next.set(retentionKey, {
          activeCount: activeCall.activeCount,
          call: activeCall.call,
          firstSeenAt: previous?.firstSeenAt ?? activeCall.firstAddedAt,
          lastSeenAt: receivedAt,
        });
      }

      return next;
    });
  }, [activeTab.id, calls]);

  useEffect(() => {
    setRetainedCalls((current) => pruneRetainedCalls(current, now, activeTab.id));
  }, [activeTab.id, now]);

  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== "local") {
        return;
      }

      const configChange = changes[SPEED_CONFIG_STORAGE_KEY];

      if (configChange) {
        setConfig(normalizeSpeedConfig(configChange.newValue));
      }

      const disabledSourcesChange = changes[SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY];

      if (disabledSourcesChange) {
        setDisabledSources(normalizeSpeedCallSources(disabledSourcesChange.newValue));
      }

      const hiddenSourcesChange = changes[SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY];

      if (hiddenSourcesChange) {
        setHiddenSourceKeys(new Set(normalizeHiddenCallSourceKeys(hiddenSourcesChange.newValue)));
      }
    };

    browser.storage.onChanged.addListener(handleStorageChange);

    return () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  useEffect(() => {
    let commitTimeoutId: number | undefined;
    let lastCommittedAt = 0;
    let queuedCalls: SpeedCallPanelItem[] | undefined;

    const commitCalls = (nextCalls: SpeedCallPanelItem[]) => {
      queuedCalls = undefined;
      lastCommittedAt = Date.now();
      setCalls(nextCalls);
    };

    const flushQueuedCalls = () => {
      commitTimeoutId = undefined;

      if (!queuedCalls) {
        return;
      }

      commitCalls(queuedCalls);
    };

    const scheduleCallsCommit = (nextCalls: SpeedCallPanelItem[]) => {
      const elapsedMs = Date.now() - lastCommittedAt;

      if (elapsedMs >= CALLS_COMMIT_DELAY_MS && commitTimeoutId == null) {
        commitCalls(nextCalls);
        return;
      }

      queuedCalls = mergeSampledCalls(queuedCalls, nextCalls);

      if (commitTimeoutId == null) {
        commitTimeoutId = window.setTimeout(
          flushQueuedCalls,
          Math.max(0, CALLS_COMMIT_DELAY_MS - elapsedMs),
        );
      }
    };

    const handleRuntimeMessage = (message: unknown) => {
      if (
        message == null ||
        typeof message !== "object" ||
        (message as { type?: unknown }).type !== SPEED_CALLS_CHANGED_MESSAGE_TYPE
      ) {
        return;
      }

      const tabId = normalizeTabId((message as { tabId?: unknown }).tabId);

      if (activeTab.id != null && tabId !== activeTab.id) {
        return;
      }

      scheduleCallsCommit(normalizeSpeedCallPanelItems((message as { calls?: unknown }).calls));
    };

    browser.runtime.onMessage.addListener(handleRuntimeMessage);

    return () => {
      if (commitTimeoutId != null) {
        window.clearTimeout(commitTimeoutId);
      }

      browser.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, [activeTab.id]);

  useEffect(() => {
    const handleActivated = (activeInfo: { tabId: number }) => {
      void loadPanelState(activeInfo.tabId);
    };
    const handleUpdated = (tabId: number, changeInfo: { status?: string; url?: string }) => {
      if (tabId !== activeTab.id || (changeInfo.status !== "loading" && changeInfo.url == null)) {
        return;
      }

      void loadPanelState(tabId);
    };

    browser.tabs.onActivated.addListener(handleActivated);
    browser.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      browser.tabs.onActivated.removeListener(handleActivated);
      browser.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [activeTab.id, loadPanelState]);

  async function saveConfig(nextConfig: SpeedConfig) {
    const normalized = normalizeSpeedConfig(nextConfig);
    setConfig(normalized);
    await browser.storage.local.set({
      [SPEED_CONFIG_STORAGE_KEY]: normalized,
    });
  }

  async function saveMode(mode: SpeedMode) {
    await saveConfig({
      ...config,
      enabled: true,
      mode,
      pauseInvocations: mode === "automatic" ? false : config.pauseInvocations,
    });
  }

  async function savePauseInvocations(pauseInvocations: boolean) {
    await saveConfig({
      ...config,
      enabled: pauseInvocations ? true : config.enabled,
      mode: pauseInvocations ? "manual" : config.mode,
      pauseInvocations,
    });
  }

  async function saveCustomSpeed() {
    const speed = clampSpeed(customSpeed);
    setCustomSpeed(speed.toString());
    await saveConfig({
      ...config,
      enabled: true,
      speed,
    });
  }

  async function sendCallCommand(call: SpeedCallPanelItem, command: SpeedCallCommand) {
    await browser.runtime
      .sendMessage({
        callId: call.id,
        command,
        frameId: call.frameId,
        sourceKey: call.sourceKey,
        tabId: call.tabId,
        type: SPEED_CALLS_COMMAND_MESSAGE_TYPE,
      })
      .catch(() => undefined);
  }

  function removeRetainedCall(call: SpeedCallPanelItem) {
    const retentionKey = getCallRetentionKey(call);

    setRetainedCalls((current) => {
      if (!current.has(retentionKey)) {
        return current;
      }

      const next = new Map(current);
      next.delete(retentionKey);
      return next;
    });
  }

  function removeActiveCall(call: SpeedCallPanelItem) {
    setCalls((current) =>
      current.filter(
        (currentCall) =>
          currentCall.id !== call.id ||
          currentCall.frameId !== call.frameId ||
          currentCall.tabId !== call.tabId,
      ),
    );
    removeRetainedCall(call);
  }

  function removeActiveCallSource(sourceKey: string) {
    setCalls((current) => current.filter((currentCall) => currentCall.sourceKey !== sourceKey));
    setRetainedCalls((current) => {
      let changed = false;
      const next = new Map<string, RetainedCallRecord>();

      for (const [retentionKey, record] of current) {
        if (record.call.sourceKey === sourceKey) {
          changed = true;
          continue;
        }

        next.set(retentionKey, record);
      }

      return changed ? next : current;
    });
  }

  function invokeCall(call: SpeedCallPanelItem) {
    void sendCallCommand(call, "invoke");
  }

  function disableCall(call: SpeedCallPanelItem) {
    removeActiveCall(call);
    void sendCallCommand(call, "disable");
  }

  async function saveDisabledSources(sources: SpeedCallSource[]) {
    await browser.storage.local.set({
      [SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY]: sources,
    });
  }

  function disableCallSource(call: SpeedCallPanelItem) {
    const source: SpeedCallSource = {
      key: call.sourceKey,
      label: call.sourceLabel,
    };
    const sourcesByKey = new Map(
      disabledSources.map((disabledSource) => [disabledSource.key, disabledSource]),
    );

    sourcesByKey.set(source.key, source);

    const nextSources = Array.from(sourcesByKey.values()).sort((left, right) =>
      left.label.localeCompare(right.label),
    );

    setDisabledSources(nextSources);
    removeActiveCallSource(source.key);
    void saveDisabledSources(nextSources);
    void sendCallCommand(call, "disable-source");
  }

  function enableDisabledSource(sourceKey: string) {
    const nextSources = disabledSources.filter((source) => source.key !== sourceKey);

    setDisabledSources(nextSources);
    void saveDisabledSources(nextSources);
  }

  function clearDisabledSources() {
    setDisabledSources([]);
    void saveDisabledSources([]);
  }

  async function saveHiddenSourceKeys(sourceKeys: Set<string>) {
    await browser.storage.local.set({
      [SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY]: Array.from(sourceKeys).sort(),
    });
  }

  function hideVisibleCalls() {
    if (sortedCalls.length === 0) {
      return;
    }

    const next = new Set(hiddenSourceKeys);

    for (const call of sortedCalls) {
      next.add(getCallSourceKey(call));
    }

    setHiddenSourceKeys(next);
    void saveHiddenSourceKeys(next);
  }

  function hideCallSource(call: SpeedCallPanelItem) {
    const sourceKey = getCallSourceKey(call);

    if (hiddenSourceKeys.has(sourceKey)) {
      return;
    }

    const next = new Set(hiddenSourceKeys);
    next.add(sourceKey);
    setHiddenSourceKeys(next);
    void saveHiddenSourceKeys(next);
  }

  function showHiddenCalls() {
    const displayedHiddenSourceKeys = new Set(hiddenCalls.map(getCallSourceKey));
    const next = new Set<string>();

    for (const key of hiddenSourceKeys) {
      if (!displayedHiddenSourceKeys.has(key)) {
        next.add(key);
      }
    }

    setHiddenSourceKeys(next);
    void saveHiddenSourceKeys(next);
  }

  function showHiddenCallSource(call: SpeedCallPanelItem) {
    const sourceKey = getCallSourceKey(call);

    if (!hiddenSourceKeys.has(sourceKey)) {
      return;
    }

    const next = new Set(hiddenSourceKeys);
    next.delete(sourceKey);
    setHiddenSourceKeys(next);
    void saveHiddenSourceKeys(next);
  }

  const hostname = getHostnameFromUrl(activeTab.url);
  const isCustomSpeedSelected = !QUICK_SPEEDS.includes(config.speed);
  const disabledSourceKeys = useMemo(() => {
    return new Set(disabledSources.map((source) => source.key));
  }, [disabledSources]);
  const displayCalls = useMemo<DisplayedSpeedCallPanelItem[]>(() => {
    const activeCallsByRetentionKey = new Map<string, AggregatedCallRecord>();

    for (const call of calls) {
      aggregateCall(activeCallsByRetentionKey, call);
    }

    const displayItems: DisplayedSpeedCallPanelItem[] = [];

    for (const [retentionKey, activeCall] of activeCallsByRetentionKey) {
      const retainedCall = retainedCalls.get(retentionKey);

      displayItems.push({
        ...activeCall.call,
        activeCount: activeCall.activeCount,
        displayKey: retentionKey,
        firstSeenAt: retainedCall?.firstSeenAt ?? activeCall.firstAddedAt,
        isLive: true,
        lastSeenAt: retainedCall?.lastSeenAt ?? activeCall.call.addedAt,
      });
    }

    for (const [retentionKey, record] of retainedCalls) {
      if (activeCallsByRetentionKey.has(retentionKey)) {
        continue;
      }

      displayItems.push({
        ...record.call,
        activeCount: 0,
        displayKey: retentionKey,
        firstSeenAt: record.firstSeenAt,
        isLive: false,
        lastSeenAt: record.lastSeenAt,
      });
    }

    return displayItems;
  }, [calls, retainedCalls]);

  const callsWithTiming = useMemo(() => {
    return displayCalls.map((call) => {
      const inactiveMs = Math.max(0, now - call.lastSeenAt);

      return {
        ...call,
        ageMs: Math.max(0, now - call.firstSeenAt),
        inactiveMs,
        isRecentlyActive: call.isLive || inactiveMs <= LIVE_STATUS_GRACE_MS,
        remainingMs: Math.max(0, call.dueAt - now),
      };
    });
  }, [displayCalls, now]);

  const visibleCalls = useMemo(() => {
    return callsWithTiming.filter(
      (call) =>
        !disabledSourceKeys.has(getCallSourceKey(call)) &&
        !hiddenSourceKeys.has(getCallSourceKey(call)),
    );
  }, [callsWithTiming, disabledSourceKeys, hiddenSourceKeys]);

  const hiddenCalls = useMemo(() => {
    return callsWithTiming.filter(
      (call) =>
        !disabledSourceKeys.has(getCallSourceKey(call)) &&
        hiddenSourceKeys.has(getCallSourceKey(call)),
    );
  }, [callsWithTiming, disabledSourceKeys, hiddenSourceKeys]);

  const sortedCalls = useMemo(() => {
    return sortTimedCalls(visibleCalls, sortMode);
  }, [sortMode, visibleCalls]);

  const sortedHiddenCalls = useMemo(() => {
    return sortTimedCalls(hiddenCalls, sortMode);
  }, [hiddenCalls, sortMode]);
  const areInvocationsPaused = config.mode === "manual" && config.pauseInvocations;
  const hiddenCallCount = hiddenCalls.length;

  return (
    <main className="flex min-h-screen flex-col gap-3.5 bg-slate-50 p-4 text-slate-900">
      <header>
        <div className="min-w-0">
          <h1 className="m-0 text-lg font-[760] leading-tight">Manual Speed Up</h1>
          <p className="mb-0 mt-[3px] truncate text-xs text-slate-500">
            {hostname ?? activeTab.title ?? "Active tab"}
          </p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2" aria-label="Speed mode">
        {(["automatic", "manual"] as const).map((mode) => (
          <button
            className={`${config.mode === mode ? selectedButtonClass : neutralButtonClass} min-h-[34px] px-2 text-sm font-[650]`}
            disabled={!isLoaded}
            key={mode}
            type="button"
            onClick={() => void saveMode(mode)}
          >
            {mode === "automatic" ? "Automatic" : "Manual"}
          </button>
        ))}
      </section>

      <section
        className="flex min-h-[58px] items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        aria-label="Settings"
      >
        <div className="min-w-0">
          <strong className="block text-sm font-[720] text-slate-900">Pause invocations</strong>
          <span className="block text-[11px] text-slate-500">
            Timer calls wait until you press Invoke now.
          </span>
        </div>
        <label
          aria-label="Pause all timer invocations"
          className="relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer"
          title="Pause all timer invocations"
        >
          <input
            className="peer sr-only"
            checked={areInvocationsPaused}
            disabled={!isLoaded}
            type="checkbox"
            onChange={(event) => void savePauseInvocations(event.currentTarget.checked)}
          />
          <span className="h-full w-full rounded-full bg-slate-300 transition-colors duration-150 peer-checked:bg-blue-600 peer-focus-visible:ring-[3px] peer-focus-visible:ring-blue-600/25 peer-disabled:cursor-not-allowed peer-disabled:opacity-[0.55]" />
          <span className="pointer-events-none absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42_/_22%)] transition-transform duration-150 peer-checked:translate-x-5 peer-disabled:opacity-[0.55]" />
        </label>
      </section>

      <section
        className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3"
        aria-label="Speed multiplier"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-[720] text-slate-900">Speed multiplier</span>
          <strong className="text-sm text-blue-700">{formatSpeedLabel(config.speed)}</strong>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {QUICK_SPEEDS.map((speed) => (
            <button
              className={speed === config.speed ? selectedSpeedButtonClass : speedButtonClass}
              disabled={!isLoaded}
              key={speed}
              type="button"
              onClick={() =>
                void saveConfig({
                  ...config,
                  enabled: true,
                  speed,
                })
              }
            >
              {speed}x
            </button>
          ))}
          <input
            aria-label="Custom speed"
            className={
              isCustomSpeedSelected ? selectedCustomSpeedInputClass : customSpeedInputClass
            }
            disabled={!isLoaded}
            max={MAX_SPEED}
            min={MIN_SPEED}
            step={SPEED_STEP}
            type="number"
            value={customSpeed}
            onBlur={() => void saveCustomSpeed()}
            onChange={(event) => setCustomSpeed(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveCustomSpeed();
              }
            }}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2.5 border-t border-slate-200 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-[13px] font-[720] leading-tight text-slate-900">
              Timer sources
            </h2>
            <p className="mb-0 mt-0.5 text-[11px] text-slate-500">
              {hiddenCallCount > 0
                ? `${numberFormatter.format(sortedCalls.length)} visible, ${numberFormatter.format(hiddenCallCount)} hidden`
                : `${numberFormatter.format(sortedCalls.length)} timer ${
                    sortedCalls.length === 1 ? "source" : "sources"
                  } in this tab`}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              className={`${neutralButtonClass} min-h-[30px] px-2 text-xs font-[650]`}
              disabled={!isLoaded || sortedCalls.length === 0}
              type="button"
              onClick={hideVisibleCalls}
            >
              Hide all
            </button>
            <div
              className="grid grid-cols-2 gap-1 rounded-lg bg-slate-200 p-1"
              aria-label="Sort calls"
            >
              {(
                [
                  ["duration", "Longest"],
                  ["recent", "Newest"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  className={`min-h-[28px] rounded-md px-2 text-xs font-[650] transition-colors ${
                    sortMode === mode
                      ? "bg-white text-blue-700 shadow-[0_1px_2px_rgb(15_23_42_/_12%)]"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                  key={mode}
                  type="button"
                  onClick={() => setSortMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {sortedCalls.length > 0 ? (
          <CallList
            calls={sortedCalls}
            config={config}
            isLoaded={isLoaded}
            onDisable={disableCall}
            onDisableSource={disableCallSource}
            onHide={hideCallSource}
            onInvoke={invokeCall}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-8 text-center text-sm text-slate-500">
            {displayCalls.length > 0
              ? "All active timer sources are hidden. Calls from hidden locations stay hidden until you show them again."
              : areInvocationsPaused
                ? "No paused timer sources for this tab. New timeout and interval calls will wait here until invoked."
                : "No active timer sources for this tab. Manual mode tracks new timeout and interval calls as pages create them."}
          </div>
        )}

        {hiddenCallCount > 0 ? (
          <div className="flex flex-col gap-2 border-t border-slate-200 pt-2.5">
            <button
              aria-controls="hidden-calls-panel"
              aria-expanded={areHiddenCallsExpanded}
              className={`${neutralButtonClass} flex min-h-[42px] w-full items-center justify-between gap-3 px-3 py-2 text-left`}
              disabled={!isLoaded}
              type="button"
              onClick={() => setAreHiddenCallsExpanded((isExpanded) => !isExpanded)}
            >
              <span className="min-w-0">
                <span className="block text-xs font-[720] text-slate-900">Hidden sources</span>
                <span className="block text-[11px] text-slate-500">
                  {numberFormatter.format(hiddenCallCount)} hidden timer{" "}
                  {hiddenCallCount === 1 ? "source" : "sources"}
                </span>
              </span>
              <span className="shrink-0 text-xs font-[650] text-blue-700">
                {areHiddenCallsExpanded ? "Collapse" : "Expand"}
              </span>
            </button>

            {areHiddenCallsExpanded ? (
              <div className="flex flex-col gap-2" id="hidden-calls-panel">
                <button
                  className={`${neutralButtonClass} min-h-[30px] w-full px-2 text-xs font-[650]`}
                  disabled={!isLoaded}
                  type="button"
                  onClick={showHiddenCalls}
                >
                  Unhide all sources
                </button>
                <CallList
                  calls={sortedHiddenCalls}
                  config={config}
                  isLoaded={isLoaded}
                  onDisable={disableCall}
                  onDisableSource={disableCallSource}
                  onInvoke={invokeCall}
                  onShowSource={showHiddenCallSource}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {disabledSources.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-slate-200 pt-2.5">
            <button
              aria-controls="disabled-sources-panel"
              aria-expanded={areDisabledSourcesExpanded}
              className={`${neutralButtonClass} flex min-h-[42px] w-full items-center justify-between gap-3 px-3 py-2 text-left`}
              disabled={!isLoaded}
              type="button"
              onClick={() => setAreDisabledSourcesExpanded((isExpanded) => !isExpanded)}
            >
              <span className="min-w-0">
                <span className="block text-xs font-[720] text-slate-900">Disabled sources</span>
                <span className="block text-[11px] text-slate-500">
                  {numberFormatter.format(disabledSources.length)} blocked source{" "}
                  {disabledSources.length === 1 ? "location" : "locations"}
                </span>
              </span>
              <span className="shrink-0 text-xs font-[650] text-blue-700">
                {areDisabledSourcesExpanded ? "Collapse" : "Expand"}
              </span>
            </button>

            {areDisabledSourcesExpanded ? (
              <div className="flex flex-col gap-2" id="disabled-sources-panel">
                <button
                  className={`${neutralButtonClass} min-h-[30px] w-full px-2 text-xs font-[650]`}
                  disabled={!isLoaded}
                  type="button"
                  onClick={clearDisabledSources}
                >
                  Re-enable all sources
                </button>
                <div className="flex flex-col gap-2">
                  {disabledSources.map((source) => (
                    <div
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-slate-200 bg-white p-2"
                      key={source.key}
                    >
                      <span
                        className="truncate font-mono text-[10px] text-slate-500"
                        title={source.label}
                      >
                        {source.label}
                      </span>
                      <button
                        className={`${neutralButtonClass} min-h-[28px] px-2 text-xs font-[650]`}
                        disabled={!isLoaded}
                        type="button"
                        onClick={() => enableDisabledSource(source.key)}
                      >
                        Enable
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
