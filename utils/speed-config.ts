export const SPEED_CONFIG_STORAGE_KEY = "speedup:config";
export const SPEED_TAB_STATS_STORAGE_KEY_PREFIX = "speedup:stats:tab";

export const SPEED_MESSAGE_TYPE = "speedup-extension:config";
export const SPEED_STATS_MESSAGE_TYPE = "speedup-extension:stats";

export const MIN_SPEED = 1;
export const MAX_SPEED = 100;
export const SPEED_STEP = 0.25;

export const SPEED_FUNCTIONS = ["setTimeout", "setInterval", "requestAnimationFrame"] as const;

export type SpeedConfig = {
  enabled: boolean;
  excludedHosts: string[];
  speed: number;
};

export type SpeedFunctionName = (typeof SPEED_FUNCTIONS)[number];

export type SpeedTriggerStats = Record<SpeedFunctionName, number>;

export type SpeedStatsIncrement = {
  count: number;
  functionName: SpeedFunctionName;
};

export const DEFAULT_SPEED_CONFIG: SpeedConfig = {
  enabled: true,
  excludedHosts: [],
  speed: 2,
};

export function clampSpeed(speed: unknown): number {
  const parsed = Number(speed);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_SPEED_CONFIG.speed;
  }

  const stepped = Math.round(parsed / SPEED_STEP) * SPEED_STEP;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, stepped));
}

export function normalizeSpeedConfig(value: unknown): SpeedConfig {
  const config = isRecord(value) ? (value as Partial<SpeedConfig>) : {};

  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    excludedHosts: normalizeExcludedHosts(config.excludedHosts),
    speed: clampSpeed(config.speed),
  };
}

export function effectiveSpeed(config: SpeedConfig, hostname?: unknown): number {
  return config.enabled && !isHostnameExcluded(config, hostname) ? config.speed : 1;
}

export function formatSpeedLabel(speed: number): string {
  const rounded = Math.round(speed * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toString()}x`;
}

export function createEmptySpeedTriggerStats(): SpeedTriggerStats {
  return SPEED_FUNCTIONS.reduce((stats, functionName) => {
    stats[functionName] = 0;
    return stats;
  }, {} as SpeedTriggerStats);
}

export function normalizeSpeedTriggerStats(value: unknown): SpeedTriggerStats {
  const stats = createEmptySpeedTriggerStats();

  if (!isRecord(value)) {
    return stats;
  }

  for (const functionName of SPEED_FUNCTIONS) {
    const source = value[functionName];

    if (typeof source === "number") {
      stats[functionName] = normalizeNonNegativeInteger(source);
      continue;
    }

    if (!isRecord(source)) {
      continue;
    }

    stats[functionName] = normalizeNonNegativeInteger(source.total);
  }

  return stats;
}

export function normalizeSpeedStatsIncrements(value: unknown): SpeedStatsIncrement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const increments: SpeedStatsIncrement[] = [];

  for (const increment of value) {
    if (!isRecord(increment)) {
      continue;
    }

    const count = normalizePositiveInteger(increment.count);

    if (count > 0 && isSpeedFunctionName(increment.functionName)) {
      increments.push({
        count,
        functionName: increment.functionName,
      });
    }
  }

  return increments;
}

export function addSpeedStatsIncrements(
  stats: unknown,
  increments: SpeedStatsIncrement[],
): SpeedTriggerStats {
  const nextStats = normalizeSpeedTriggerStats(stats);

  for (const increment of normalizeSpeedStatsIncrements(increments)) {
    nextStats[increment.functionName] += increment.count;
  }

  return nextStats;
}

export function normalizeTabId(tabId: unknown): number | undefined {
  const parsed = Number(tabId);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function getSpeedStatsStorageKey(tabId: unknown): string | undefined {
  const normalizedTabId = normalizeTabId(tabId);

  if (normalizedTabId == null) {
    return undefined;
  }

  return `${SPEED_TAB_STATS_STORAGE_KEY_PREFIX}:${normalizedTabId}`;
}

export function getHostnameFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return undefined;
    }

    return normalizeHostname(parsedUrl.hostname);
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: unknown): string | undefined {
  if (typeof hostname !== "string") {
    return undefined;
  }

  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeExcludedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const excludedHosts = new Set<string>();

  for (const hostname of value) {
    const normalizedHostname = normalizeHostname(hostname);

    if (normalizedHostname) {
      excludedHosts.add(normalizedHostname);
    }
  }

  return Array.from(excludedHosts).sort();
}

export function isHostnameExcluded(config: SpeedConfig, hostname: unknown): boolean {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return false;
  }

  return config.excludedHosts.includes(normalizedHostname);
}

export function setHostnameExcluded(
  config: SpeedConfig,
  hostname: unknown,
  excluded: boolean,
): SpeedConfig {
  const normalizedHostname = normalizeHostname(hostname);

  if (!normalizedHostname) {
    return normalizeSpeedConfig(config);
  }

  const excludedHosts = new Set(config.excludedHosts);

  if (excluded) {
    excludedHosts.add(normalizedHostname);
  } else {
    excludedHosts.delete(normalizedHostname);
  }

  return normalizeSpeedConfig({
    ...config,
    excludedHosts: Array.from(excludedHosts),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSpeedFunctionName(value: unknown): value is SpeedFunctionName {
  return typeof value === "string" && SPEED_FUNCTIONS.includes(value as SpeedFunctionName);
}

function normalizeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function normalizePositiveInteger(value: unknown): number {
  const parsed = normalizeNonNegativeInteger(value);
  return parsed > 0 ? parsed : 0;
}
