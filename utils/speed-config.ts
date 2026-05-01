export const SPEED_CONFIG_STORAGE_KEY = "speedup:config";
export const SPEED_DISABLED_CALL_SOURCES_STORAGE_KEY = "speedup:disabled-call-sources";
export const SPEED_HIDDEN_CALL_SOURCES_STORAGE_KEY = "speedup:hidden-call-sources";
export const SPEED_TAB_STATS_STORAGE_KEY_PREFIX = "speedup:stats:tab";

export const SPEED_MESSAGE_TYPE = "speedup-extension:config";
export const SPEED_STATS_MESSAGE_TYPE = "speedup-extension:stats";
export const SPEED_CALLS_CHANGED_MESSAGE_TYPE = "speedup-extension:calls-changed";
export const SPEED_CALLS_COMMAND_MESSAGE_TYPE = "speedup-extension:calls-command";
export const SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE = "speedup-extension:calls-disabled-sources";
export const SPEED_CALLS_LIST_MESSAGE_TYPE = "speedup-extension:calls-list";
export const SPEED_CALLS_REFRESH_MESSAGE_TYPE = "speedup-extension:calls-refresh";

export const MIN_SPEED = 1;
export const MAX_SPEED = 100;
export const SPEED_STEP = 0.25;

export const SPEED_CALL_COMMANDS = ["invoke", "disable", "disable-source"] as const;
export const SPEED_FUNCTIONS = ["setTimeout", "setInterval", "requestAnimationFrame"] as const;
export const SPEED_MODES = ["automatic", "manual"] as const;

export type SpeedCallCommand = (typeof SPEED_CALL_COMMANDS)[number];
export type SpeedFunctionName = (typeof SPEED_FUNCTIONS)[number];
export type SpeedMode = (typeof SPEED_MODES)[number];

export type SpeedCallSource = {
  key: string;
  label: string;
};

export type SpeedFunctionSettings = Record<SpeedFunctionName, boolean>;

export type SpeedConfig = {
  enabled: boolean;
  enabledFunctions: SpeedFunctionSettings;
  excludedHosts: string[];
  mode: SpeedMode;
  speed: number;
};

export type SpeedTriggerStats = Record<SpeedFunctionName, number>;

export type SpeedStatsIncrement = {
  count: number;
  functionName: SpeedFunctionName;
};

export type SpeedCallFunctionName = Extract<SpeedFunctionName, "setTimeout" | "setInterval">;

export type SpeedCallSnapshot = {
  addedAt: number;
  delay: number;
  dueAt: number;
  functionName: SpeedCallFunctionName;
  handlerLabel: string;
  id: string;
  publicId: number;
  remainingMs: number;
  speed: number;
  sourceKey: string;
  sourceLabel: string;
  type: "interval" | "timeout";
  url: string;
};

export type SpeedCallPanelItem = SpeedCallSnapshot & {
  frameId: number;
  tabId: number;
};

export const DEFAULT_SPEED_CONFIG: SpeedConfig = {
  enabled: true,
  enabledFunctions: createDefaultSpeedFunctionSettings(),
  excludedHosts: [],
  mode: "automatic",
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
    enabledFunctions: normalizeSpeedFunctionSettings(config.enabledFunctions),
    excludedHosts: normalizeExcludedHosts(config.excludedHosts),
    mode: isSpeedMode(config.mode) ? config.mode : DEFAULT_SPEED_CONFIG.mode,
    speed: clampSpeed(config.speed),
  };
}

export function effectiveSpeed(
  config: SpeedConfig,
  hostname?: unknown,
  functionName?: SpeedFunctionName,
): number {
  return config.enabled &&
    config.mode === "automatic" &&
    !isHostnameExcluded(config, hostname) &&
    (functionName == null || isSpeedFunctionEnabled(config, functionName))
    ? config.speed
    : 1;
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

export function createDefaultSpeedFunctionSettings(): SpeedFunctionSettings {
  return SPEED_FUNCTIONS.reduce((settings, functionName) => {
    settings[functionName] = functionName !== "requestAnimationFrame";
    return settings;
  }, {} as SpeedFunctionSettings);
}

export function normalizeSpeedFunctionSettings(value: unknown): SpeedFunctionSettings {
  const settings = createDefaultSpeedFunctionSettings();

  if (!isRecord(value)) {
    return settings;
  }

  for (const functionName of SPEED_FUNCTIONS) {
    const enabled = value[functionName];

    if (typeof enabled === "boolean") {
      settings[functionName] = enabled;
    }
  }

  return settings;
}

export function isSpeedFunctionEnabled(
  config: SpeedConfig,
  functionName: SpeedFunctionName,
): boolean {
  return config.enabledFunctions[functionName];
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

export function normalizeSpeedCallSnapshots(value: unknown): SpeedCallSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const snapshots: SpeedCallSnapshot[] = [];

  for (const snapshot of value) {
    const normalizedSnapshot = normalizeSpeedCallSnapshot(snapshot);

    if (normalizedSnapshot) {
      snapshots.push(normalizedSnapshot);
    }
  }

  return snapshots;
}

export function normalizeSpeedCallPanelItems(value: unknown): SpeedCallPanelItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: SpeedCallPanelItem[] = [];

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const snapshot = normalizeSpeedCallSnapshot(item);
    const tabId = normalizeTabId(item.tabId);
    const frameId = normalizeFrameId(item.frameId);

    if (snapshot && tabId != null && frameId != null) {
      items.push({
        ...snapshot,
        frameId,
        tabId,
      });
    }
  }

  return items;
}

export function normalizeHiddenCallSourceKeys(value: unknown): string[] {
  return normalizeCallSourceKeys(value);
}

export function normalizeCallSourceKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const keys = new Set<string>();

  for (const key of value) {
    const normalizedKey = isRecord(key)
      ? normalizeNonEmptyString(key.key)
      : normalizeNonEmptyString(key);

    if (normalizedKey) {
      keys.add(normalizedKey);
    }
  }

  return Array.from(keys).sort();
}

export function normalizeSpeedCallSources(value: unknown): SpeedCallSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sources = new Map<string, SpeedCallSource>();

  for (const source of value) {
    const key = isRecord(source)
      ? normalizeNonEmptyString(source.key)
      : normalizeNonEmptyString(source);

    if (!key) {
      continue;
    }

    sources.set(key, {
      key,
      label: isRecord(source) ? (normalizeNonEmptyString(source.label) ?? key) : key,
    });
  }

  return Array.from(sources.values()).sort((left, right) => left.label.localeCompare(right.label));
}

export function normalizeSpeedCallCommand(value: unknown): SpeedCallCommand {
  if (value === "disable" || value === "disable-source") {
    return value;
  }

  return "invoke";
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

export function normalizeFrameId(frameId: unknown): number | undefined {
  const parsed = Number(frameId);

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

function isSpeedCallFunctionName(value: unknown): value is SpeedCallFunctionName {
  return value === "setTimeout" || value === "setInterval";
}

function isSpeedMode(value: unknown): value is SpeedMode {
  return typeof value === "string" && SPEED_MODES.includes(value as SpeedMode);
}

function normalizeSpeedCallSnapshot(value: unknown): SpeedCallSnapshot | undefined {
  if (!isRecord(value) || !isSpeedCallFunctionName(value.functionName)) {
    return undefined;
  }

  const id = normalizeNonEmptyString(value.id);
  const type = value.type === "interval" || value.type === "timeout" ? value.type : undefined;

  if (!id || !type) {
    return undefined;
  }

  const sourceKey = normalizeNonEmptyString(value.sourceKey) ?? id;

  return {
    addedAt: normalizeFiniteNumber(value.addedAt),
    delay: normalizeNonNegativeNumber(value.delay),
    dueAt: normalizeFiniteNumber(value.dueAt),
    functionName: value.functionName,
    handlerLabel: normalizeNonEmptyString(value.handlerLabel) ?? "anonymous handler",
    id,
    publicId: normalizeNonNegativeInteger(value.publicId),
    remainingMs: normalizeNonNegativeNumber(value.remainingMs),
    speed: clampSpeed(value.speed),
    sourceKey,
    sourceLabel: normalizeNonEmptyString(value.sourceLabel) ?? sourceKey,
    type,
    url: normalizeNonEmptyString(value.url) ?? "",
  };
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function normalizeNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function normalizeFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
