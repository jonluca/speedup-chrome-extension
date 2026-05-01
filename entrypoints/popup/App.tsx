import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";

import {
  clampSpeed,
  createEmptySpeedTriggerStats,
  DEFAULT_SPEED_CONFIG,
  formatSpeedLabel,
  getHostnameFromUrl,
  getSpeedStatsStorageKey,
  isHostnameExcluded,
  MAX_SPEED,
  MIN_SPEED,
  normalizeTabId,
  normalizeSpeedConfig,
  normalizeSpeedTriggerStats,
  setHostnameExcluded,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_FUNCTIONS,
  SPEED_STEP,
  type SpeedConfig,
  type SpeedFunctionName,
  type SpeedMode,
  type SpeedTriggerStats,
} from "../../utils/speed-config";

const QUICK_SPEEDS = [1, 1.5, 2, 3, 4, 8, 16];
const numberFormatter = new Intl.NumberFormat();
const FUNCTION_TYPE_DESCRIPTIONS: Record<SpeedFunctionName, string> = {
  requestAnimationFrame: "Animation frame callbacks",
  setInterval: "Repeating timers",
  setTimeout: "One-shot timers",
};
const buttonInteractiveClass =
  "cursor-pointer rounded-lg border transition-colors focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const neutralButtonClass = `${buttonInteractiveClass} border-slate-300 bg-white text-slate-800 hover:border-blue-300 hover:bg-[#f8fbff]`;
const quickSpeedButtonClass = `${neutralButtonClass} min-h-[34px]`;
const customSpeedInputBaseClass =
  "min-h-[34px] min-w-0 rounded-lg border px-2 text-center focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const customSpeedInputClass = `${customSpeedInputBaseClass} border-slate-300 bg-white text-slate-800`;
const selectedCustomSpeedInputClass = `${customSpeedInputBaseClass} border-blue-600 bg-blue-600 text-white`;
const selectedSpeedButtonClass = `${buttonInteractiveClass} min-h-[34px] border-blue-600 bg-blue-600 text-white hover:border-blue-600 hover:bg-blue-600`;
const modeButtonClass = `${buttonInteractiveClass} min-h-[32px] border-slate-300 bg-white px-2 text-sm font-[650] text-slate-700 hover:border-blue-300 hover:bg-[#f8fbff]`;
const selectedModeButtonClass = `${buttonInteractiveClass} min-h-[32px] border-blue-600 bg-blue-600 px-2 text-sm font-[650] text-white hover:border-blue-600 hover:bg-blue-600`;

export default function App() {
  const [config, setConfig] = useState<SpeedConfig>(DEFAULT_SPEED_CONFIG);
  const [customSpeed, setCustomSpeed] = useState(() => DEFAULT_SPEED_CONFIG.speed.toString());
  const [currentHost, setCurrentHost] = useState<string>();
  const [currentTabId, setCurrentTabId] = useState<number>();
  const [stats, setStats] = useState<SpeedTriggerStats>(() => createEmptySpeedTriggerStats());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const activeTab = tabs[0];
      const tabId = normalizeTabId(activeTab?.id);
      const statsStorageKey = getSpeedStatsStorageKey(tabId);
      const stored = await browser.storage.local.get(
        statsStorageKey ? [SPEED_CONFIG_STORAGE_KEY, statsStorageKey] : SPEED_CONFIG_STORAGE_KEY,
      );

      if (!cancelled) {
        setConfig(normalizeSpeedConfig(stored[SPEED_CONFIG_STORAGE_KEY]));
        setCurrentHost(getHostnameFromUrl(activeTab?.url));
        setCurrentTabId(tabId);
        setStats(normalizeSpeedTriggerStats(statsStorageKey ? stored[statsStorageKey] : undefined));
        setIsLoaded(true);
      }
    }

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCustomSpeed(config.speed.toString());
  }, [config.speed]);

  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== "local") {
        return;
      }

      const configChange = changes[SPEED_CONFIG_STORAGE_KEY];
      const statsStorageKey = getSpeedStatsStorageKey(currentTabId);
      const statsChange = statsStorageKey ? changes[statsStorageKey] : undefined;

      if (configChange) {
        setConfig(normalizeSpeedConfig(configChange.newValue));
      }

      if (statsChange) {
        setStats(normalizeSpeedTriggerStats(statsChange.newValue));
      }
    };

    browser.storage.onChanged.addListener(handleStorageChange);

    return () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [currentTabId]);

  async function saveConfig(nextConfig: SpeedConfig) {
    const normalized = normalizeSpeedConfig(nextConfig);
    setConfig(normalized);
    await browser.storage.local.set({
      [SPEED_CONFIG_STORAGE_KEY]: normalized,
    });
  }

  async function saveCurrentSiteExclusion(excluded: boolean) {
    if (!currentHost) {
      return;
    }

    await saveConfig(setHostnameExcluded(config, currentHost, excluded));
  }

  async function saveFunctionEnabled(functionName: SpeedFunctionName, enabled: boolean) {
    await saveConfig({
      ...config,
      enabledFunctions: {
        ...config.enabledFunctions,
        [functionName]: enabled,
      },
    });
  }

  async function saveMode(mode: SpeedMode) {
    await saveConfig({
      ...config,
      enabled: true,
      mode,
    });
  }

  async function openManualSidebar() {
    void saveMode("manual");

    if (currentTabId == null) {
      return;
    }

    await browser.sidePanel.open({ tabId: currentTabId });
  }

  async function selectMode(mode: SpeedMode) {
    if (mode === "manual") {
      await openManualSidebar();
      return;
    }

    await saveMode(mode);
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

  async function resetStats() {
    const statsStorageKey = getSpeedStatsStorageKey(currentTabId);

    if (!statsStorageKey) {
      return;
    }

    const emptyStats = createEmptySpeedTriggerStats();
    setStats(emptyStats);
    await browser.storage.local.set({
      [statsStorageKey]: emptyStats,
    });
  }

  const isCurrentSiteExcluded = useMemo(
    () => isHostnameExcluded(config, currentHost),
    [config, currentHost],
  );
  const enabledFunctionCount = useMemo(
    () => SPEED_FUNCTIONS.filter((functionName) => config.enabledFunctions[functionName]).length,
    [config.enabledFunctions],
  );
  const showSpeedControls = !isCurrentSiteExcluded;
  const isCustomSpeedSelected = !QUICK_SPEEDS.includes(config.speed);

  const statusText = useMemo(() => {
    if (!config.enabled) {
      return "Paused";
    }

    if (isCurrentSiteExcluded) {
      return "Site paused";
    }

    if (enabledFunctionCount === 0) {
      return "All off";
    }

    if (config.mode === "manual") {
      return "Manual";
    }

    return formatSpeedLabel(config.speed);
  }, [config.enabled, config.mode, config.speed, enabledFunctionCount, isCurrentSiteExcluded]);

  const statsRows = useMemo(
    () =>
      SPEED_FUNCTIONS.map((functionName) => {
        return {
          functionName,
          total: stats[functionName],
        };
      }),
    [stats],
  );

  const totalTriggers = useMemo(
    () => statsRows.reduce((total, row) => total + row.total, 0),
    [statsRows],
  );

  return (
    <main className="flex min-h-[430px] flex-col gap-3.5 bg-slate-50 p-4 text-slate-900">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-lg font-[720] leading-tight">Page Speed</h1>
          <p className="mb-0 mt-[3px] text-xs text-slate-500">Timers and animation frames</p>
        </div>
        <label
          aria-label="Enable speed changes"
          className="relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer"
          title="Enable speed changes"
        >
          <input
            className="peer sr-only"
            checked={config.enabled}
            disabled={!isLoaded}
            type="checkbox"
            onChange={(event) =>
              void saveConfig({
                ...config,
                enabled: event.currentTarget.checked,
              })
            }
          />
          <span className="h-full w-full rounded-full bg-slate-300 transition-colors duration-150 peer-checked:bg-blue-600 peer-focus-visible:ring-[3px] peer-focus-visible:ring-blue-600/25" />
          <span className="pointer-events-none absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42_/_22%)] transition-transform duration-150 peer-checked:translate-x-5" />
        </label>
      </header>

      <section
        className="grid min-h-[78px] place-items-center rounded-lg border border-blue-100 bg-blue-50"
        aria-live="polite"
      >
        <span className="text-[38px] font-[760] leading-none text-blue-700">{statusText}</span>
      </section>

      <section className="grid grid-cols-2 gap-2" aria-label="Speed mode">
        {(["automatic", "manual"] as const).map((mode) => (
          <button
            className={config.mode === mode ? selectedModeButtonClass : modeButtonClass}
            disabled={!isLoaded}
            key={mode}
            type="button"
            onClick={() => void selectMode(mode)}
          >
            {mode === "automatic" ? "Automatic" : "Manual"}
          </button>
        ))}
      </section>

      <section
        className="flex min-h-[46px] items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        aria-label="Site exclusion"
      >
        <div className="min-w-0">
          <strong className="block text-xs font-[720] text-slate-900">Disable on this site</strong>
          <span className="block truncate text-[11px] text-slate-500">
            {currentHost ?? "Only available on HTTP and HTTPS tabs"}
          </span>
        </div>
        <label
          aria-label="Disable speed changes on this site"
          className="relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer"
          title="Disable speed changes on this site"
        >
          <input
            className="peer sr-only"
            checked={isCurrentSiteExcluded}
            disabled={!isLoaded || !currentHost}
            type="checkbox"
            onChange={(event) => void saveCurrentSiteExclusion(event.currentTarget.checked)}
          />
          <span className="h-full w-full rounded-full bg-slate-300 transition-colors duration-150 peer-checked:bg-blue-600 peer-focus-visible:ring-[3px] peer-focus-visible:ring-blue-600/25 peer-disabled:cursor-not-allowed peer-disabled:opacity-[0.55]" />
          <span className="pointer-events-none absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42_/_22%)] transition-transform duration-150 peer-checked:translate-x-5 peer-disabled:opacity-[0.55]" />
        </label>
      </section>

      {showSpeedControls ? (
        <>
          <div className="grid grid-cols-4 gap-2" aria-label="Quick speed choices">
            {QUICK_SPEEDS.map((speed) => (
              <button
                className={
                  speed === config.speed ? selectedSpeedButtonClass : quickSpeedButtonClass
                }
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
              id="customSpeed"
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

          <button
            className={`${neutralButtonClass} min-h-[34px] w-full font-[650]`}
            disabled={!isLoaded}
            type="button"
            onClick={() => void saveConfig({ ...config, enabled: true, speed: 1 })}
          >
            Reset to normal speed
          </button>

          <button
            className={`${neutralButtonClass} min-h-[34px] w-full font-[650]`}
            disabled={!isLoaded || currentTabId == null}
            type="button"
            onClick={() => void openManualSidebar()}
          >
            Open manual sidebar
          </button>
        </>
      ) : null}

      <section
        className="flex flex-col gap-2.5 border-t border-slate-200 pt-3.5"
        aria-label="Speed-up function types and trigger counts"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-[13px] font-[720] leading-tight text-slate-900">
              Speed-up calls
            </h2>
            <p className="mb-0 mt-0.5 text-[11px] text-slate-500">
              {enabledFunctionCount} of {SPEED_FUNCTIONS.length} enabled,{" "}
              {numberFormatter.format(totalTriggers)} this tab
            </p>
          </div>
          <button
            className={`${neutralButtonClass} min-h-[30px] px-2.5 text-xs font-[650]`}
            disabled={!isLoaded || currentTabId == null || totalTriggers === 0}
            type="button"
            onClick={() => void resetStats()}
          >
            Clear
          </button>
        </div>

        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {statsRows.map((row) => (
            <li
              className="grid min-h-[54px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
              key={row.functionName}
            >
              <div className="min-w-0">
                <span className="block font-mono text-xs font-[650] text-slate-800">
                  {row.functionName}
                </span>
                <span className="block truncate text-[11px] text-slate-500">
                  {FUNCTION_TYPE_DESCRIPTIONS[row.functionName]}
                </span>
              </div>
              <strong className="min-w-8 shrink-0 text-right text-lg leading-none text-blue-700 tabular-nums">
                {numberFormatter.format(row.total)}
              </strong>
              <label
                aria-label={`Enable ${row.functionName}`}
                className="relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer"
                title={`Enable ${row.functionName}`}
              >
                <input
                  className="peer sr-only"
                  checked={config.enabledFunctions[row.functionName]}
                  disabled={!isLoaded}
                  type="checkbox"
                  onChange={(event) =>
                    void saveFunctionEnabled(row.functionName, event.currentTarget.checked)
                  }
                />
                <span className="h-full w-full rounded-full bg-slate-300 transition-colors duration-150 peer-checked:bg-blue-600 peer-focus-visible:ring-[3px] peer-focus-visible:ring-blue-600/25 peer-disabled:cursor-not-allowed peer-disabled:opacity-[0.55]" />
                <span className="pointer-events-none absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42_/_22%)] transition-transform duration-150 peer-checked:translate-x-5 peer-disabled:opacity-[0.55]" />
              </label>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
