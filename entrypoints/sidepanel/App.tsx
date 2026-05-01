import { useCallback, useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";

import {
  clampSpeed,
  DEFAULT_SPEED_CONFIG,
  formatSpeedLabel,
  getHostnameFromUrl,
  isHostnameExcluded,
  MAX_SPEED,
  MIN_SPEED,
  normalizeSpeedCallPanelItems,
  normalizeSpeedConfig,
  normalizeTabId,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
  SPEED_CALLS_LIST_MESSAGE_TYPE,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_STEP,
  type SpeedCallPanelItem,
  type SpeedConfig,
  type SpeedMode,
} from "../../utils/speed-config";

const QUICK_SPEEDS = [1, 1.5, 2, 3, 4, 8, 16];
const numberFormatter = new Intl.NumberFormat();
const buttonInteractiveClass =
  "cursor-pointer rounded-lg border transition-colors focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const neutralButtonClass = `${buttonInteractiveClass} border-slate-300 bg-white text-slate-800 hover:border-blue-300 hover:bg-[#f8fbff]`;
const selectedButtonClass = `${buttonInteractiveClass} border-blue-600 bg-blue-600 text-white hover:border-blue-600 hover:bg-blue-600`;
const speedButtonClass = `${neutralButtonClass} min-h-[34px]`;
const selectedSpeedButtonClass = `${selectedButtonClass} min-h-[34px]`;
const customSpeedInputBaseClass =
  "min-h-[34px] min-w-0 rounded-lg border px-2 text-center focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const customSpeedInputClass = `${customSpeedInputBaseClass} border-slate-300 bg-white text-slate-800`;
const selectedCustomSpeedInputClass = `${customSpeedInputBaseClass} border-blue-600 bg-blue-600 text-white`;

type SortMode = "duration" | "recent";

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

function getCallViewKey(call: Pick<SpeedCallPanelItem, "frameId" | "id" | "tabId">): string {
  return `${call.tabId}:${call.frameId}:${call.id}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>({});
  const [calls, setCalls] = useState<SpeedCallPanelItem[]>([]);
  const [config, setConfig] = useState<SpeedConfig>(DEFAULT_SPEED_CONFIG);
  const [customSpeed, setCustomSpeed] = useState(() => DEFAULT_SPEED_CONFIG.speed.toString());
  const [hiddenCallKeys, setHiddenCallKeys] = useState<Set<string>>(() => new Set());
  const [isLoaded, setIsLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sortMode, setSortMode] = useState<SortMode>("duration");

  const loadPanelState = useCallback(async (requestedTabId?: number) => {
    const [stored, response] = await Promise.all([
      browser.storage.local.get(SPEED_CONFIG_STORAGE_KEY),
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
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    void loadPanelState();
  }, [loadPanelState]);

  useEffect(() => {
    setCustomSpeed(config.speed.toString());
  }, [config.speed]);

  useEffect(() => {
    const tickId = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(tickId);
  }, []);

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
    };

    browser.storage.onChanged.addListener(handleStorageChange);

    return () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  useEffect(() => {
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

      setCalls(normalizeSpeedCallPanelItems((message as { calls?: unknown }).calls));
    };

    browser.runtime.onMessage.addListener(handleRuntimeMessage);

    return () => {
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

  useEffect(() => {
    setHiddenCallKeys((current) => {
      if (activeTab.id == null || current.size === 0) {
        return current;
      }

      const activeTabPrefix = `${activeTab.id}:`;
      const activeTabCallKeys = new Set(calls.map(getCallViewKey));
      let changed = false;
      const next = new Set<string>();

      for (const key of current) {
        if (!key.startsWith(activeTabPrefix) || activeTabCallKeys.has(key)) {
          next.add(key);
          continue;
        }

        changed = true;
      }

      return changed ? next : current;
    });
  }, [activeTab.id, calls]);

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

  async function sendCallCommand(call: SpeedCallPanelItem) {
    await browser.runtime
      .sendMessage({
        callId: call.id,
        frameId: call.frameId,
        tabId: call.tabId,
        type: SPEED_CALLS_COMMAND_MESSAGE_TYPE,
      })
      .catch(() => undefined);
  }

  function hideVisibleCalls() {
    if (sortedCalls.length === 0) {
      return;
    }

    setHiddenCallKeys((current) => {
      const next = new Set(current);

      for (const call of sortedCalls) {
        next.add(getCallViewKey(call));
      }

      return next;
    });
  }

  const hostname = getHostnameFromUrl(activeTab.url);
  const isCustomSpeedSelected = !QUICK_SPEEDS.includes(config.speed);
  const callsWithTiming = useMemo(() => {
    return calls.map((call) => ({
      ...call,
      ageMs: Math.max(0, now - call.addedAt),
      remainingMs: Math.max(0, call.dueAt - now),
    }));
  }, [calls, now]);

  const visibleCalls = useMemo(() => {
    return callsWithTiming.filter((call) => !hiddenCallKeys.has(getCallViewKey(call)));
  }, [callsWithTiming, hiddenCallKeys]);

  const sortedCalls = useMemo(() => {
    const rows = [...visibleCalls];

    return rows.sort((left, right) => {
      if (sortMode === "recent") {
        return right.addedAt - left.addedAt;
      }

      return right.remainingMs - left.remainingMs;
    });
  }, [sortMode, visibleCalls]);
  const hiddenCallCount = calls.length - visibleCalls.length;

  return (
    <main className="flex min-h-screen flex-col gap-3.5 bg-slate-50 p-4 text-slate-900">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 text-lg font-[760] leading-tight">Manual Speed Up</h1>
          <p className="mb-0 mt-[3px] truncate text-xs text-slate-500">
            {hostname ?? activeTab.title ?? "Active tab"}
          </p>
        </div>
        <button
          className={`${neutralButtonClass} min-h-[30px] px-2.5 text-xs font-[650]`}
          disabled={!isLoaded}
          type="button"
          onClick={() => void loadPanelState(activeTab.id)}
        >
          Refresh
        </button>
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
              Active calls
            </h2>
            <p className="mb-0 mt-0.5 text-[11px] text-slate-500">
              {hiddenCallCount > 0
                ? `${numberFormatter.format(sortedCalls.length)} visible, ${numberFormatter.format(hiddenCallCount)} hidden`
                : `${numberFormatter.format(sortedCalls.length)} timer calls in this tab`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {sortedCalls.map((call) => {
              const callHost = getHostnameFromUrl(call.url);
              const isCallSpeedAllowed =
                config.enabled &&
                config.enabledFunctions[call.functionName] &&
                !isHostnameExcluded(config, callHost);
              const isCallRunningFast = call.speed > MIN_SPEED;
              const canToggle = isLoaded && config.mode === "manual" && isCallSpeedAllowed;

              return (
                <li
                  className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3"
                  key={`${call.tabId}:${call.frameId}:${call.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="block font-mono text-xs font-[720] text-slate-900">
                        {call.functionName}
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {call.handlerLabel}
                        {callHost ? `, ${callHost}` : ""}
                      </span>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-[720] ${
                        isCallRunningFast
                          ? "bg-blue-100 text-blue-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {isCallRunningFast ? formatSpeedLabel(call.speed) : "normal"}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                    <span>
                      <strong className="block text-xs text-slate-900">
                        {formatDuration(call.remainingMs)}
                      </strong>
                      remaining
                    </span>
                    <span>
                      <strong className="block text-xs text-slate-900">
                        {formatDuration(call.delay)}
                      </strong>
                      delay
                    </span>
                    <span>
                      <strong className="block text-xs text-slate-900">
                        {formatDuration(call.ageMs)}
                      </strong>
                      added ago
                    </span>
                  </div>

                  <button
                    className={`${selectedButtonClass} min-h-[32px] w-full px-2 text-sm font-[650]`}
                    disabled={!canToggle}
                    type="button"
                    onClick={() => void sendCallCommand(call)}
                  >
                    Invoke now
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-8 text-center text-sm text-slate-500">
            {calls.length > 0
              ? "All active timer calls are hidden. New timeout and interval calls will appear here."
              : "No active timer calls for this tab. Manual mode tracks new timeout and interval calls as pages create them."}
          </div>
        )}
      </section>
    </main>
  );
}
