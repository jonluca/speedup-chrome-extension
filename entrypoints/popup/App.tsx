import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";

import {
  clampSpeed,
  createEmptySpeedTriggerStats,
  DEFAULT_SPEED_CONFIG,
  formatSpeedLabel,
  getHostnameFromUrl,
  isHostnameExcluded,
  MAX_SPEED,
  MIN_SPEED,
  normalizeSpeedConfig,
  normalizeSpeedTriggerStats,
  setHostnameExcluded,
  SPEED_CONFIG_STORAGE_KEY,
  SPEED_FUNCTIONS,
  SPEED_STATS_STORAGE_KEY,
  SPEED_STEP,
  type SpeedConfig,
  type SpeedTriggerStats,
} from "../../utils/speed-config";

const QUICK_SPEEDS = [1, 1.5, 2, 3, 4, 8, 16];
const numberFormatter = new Intl.NumberFormat();
const buttonInteractiveClass =
  "cursor-pointer rounded-lg border transition-colors focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const neutralButtonClass = `${buttonInteractiveClass} border-slate-300 bg-white text-slate-800 hover:border-blue-300 hover:bg-[#f8fbff]`;
const quickSpeedButtonClass = `${neutralButtonClass} min-h-[34px]`;
const customSpeedInputClass =
  "min-h-[34px] min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-center text-slate-800 focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-blue-600/25 disabled:cursor-not-allowed disabled:opacity-[0.55]";
const selectedSpeedButtonClass = `${buttonInteractiveClass} min-h-[34px] border-blue-600 bg-blue-600 text-white hover:border-blue-600 hover:bg-blue-600`;

export default function App() {
  const [config, setConfig] = useState<SpeedConfig>(DEFAULT_SPEED_CONFIG);
  const [customSpeed, setCustomSpeed] = useState(() => DEFAULT_SPEED_CONFIG.speed.toString());
  const [currentHost, setCurrentHost] = useState<string>();
  const [stats, setStats] = useState<SpeedTriggerStats>(() => createEmptySpeedTriggerStats());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      const [stored, tabs] = await Promise.all([
        browser.storage.local.get([SPEED_CONFIG_STORAGE_KEY, SPEED_STATS_STORAGE_KEY]),
        browser.tabs.query({ active: true, currentWindow: true }).catch(() => []),
      ]);

      if (!cancelled) {
        setConfig(normalizeSpeedConfig(stored[SPEED_CONFIG_STORAGE_KEY]));
        setCurrentHost(getHostnameFromUrl(tabs[0]?.url));
        setStats(normalizeSpeedTriggerStats(stored[SPEED_STATS_STORAGE_KEY]));
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
      const statsChange = changes[SPEED_STATS_STORAGE_KEY];

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
  }, []);

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
    const emptyStats = createEmptySpeedTriggerStats();
    setStats(emptyStats);
    await browser.storage.local.set({
      [SPEED_STATS_STORAGE_KEY]: emptyStats,
    });
  }

  const isCurrentSiteExcluded = useMemo(
    () => isHostnameExcluded(config, currentHost),
    [config, currentHost],
  );
  const showSpeedControls = !isCurrentSiteExcluded;

  const statusText = useMemo(() => {
    if (!config.enabled) {
      return "Paused";
    }

    if (isCurrentSiteExcluded) {
      return "Site paused";
    }

    return formatSpeedLabel(config.speed);
  }, [config.enabled, config.speed, isCurrentSiteExcluded]);

  const statsRows = useMemo(
    () =>
      SPEED_FUNCTIONS.map((functionName) => {
        const functionStats = stats[functionName];
        const breakdown = Object.entries(functionStats.bySpeed)
          .sort(([speedA], [speedB]) => Number.parseFloat(speedA) - Number.parseFloat(speedB))
          .map(([speedLabel, count]) => `${speedLabel}: ${numberFormatter.format(count)}`)
          .join(" | ");

        return {
          breakdown,
          functionName,
          total: functionStats.total,
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
              className={customSpeedInputClass}
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

          <section
            className="flex flex-col gap-2.5 border-t border-slate-200 pt-3.5"
            aria-label="Speed-up trigger counts"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="m-0 text-[13px] font-[720] leading-tight text-slate-900">
                  Speed-up calls
                </h2>
                <p className="mb-0 mt-0.5 text-[11px] text-slate-500">
                  {numberFormatter.format(totalTriggers)} total
                </p>
              </div>
              <button
                className={`${neutralButtonClass} min-h-[30px] px-2.5 text-xs font-[650]`}
                disabled={!isLoaded || totalTriggers === 0}
                type="button"
                onClick={() => void resetStats()}
              >
                Clear
              </button>
            </div>

            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {statsRows.map((row) => (
                <li
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
                  key={row.functionName}
                >
                  <div className="min-w-0">
                    <span className="block font-mono text-xs font-[650] text-slate-800">
                      {row.functionName}
                    </span>
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-slate-500">
                      {row.breakdown || "No calls yet"}
                    </span>
                  </div>
                  <strong className="shrink-0 text-lg leading-none text-blue-700">
                    {numberFormatter.format(row.total)}
                  </strong>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </main>
  );
}
