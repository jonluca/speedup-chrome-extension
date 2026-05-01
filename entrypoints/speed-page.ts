import {
  DEFAULT_SPEED_CONFIG,
  effectiveSpeed,
  isHostnameExcluded,
  isSpeedFunctionEnabled,
  normalizeSpeedCallSources,
  normalizeSpeedCallCommand,
  normalizeSpeedConfig,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
  SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE,
  SPEED_CALLS_REFRESH_MESSAGE_TYPE,
  SPEED_MESSAGE_TYPE,
  SPEED_STATS_MESSAGE_TYPE,
  type SpeedCallFunctionName,
  type SpeedCallSnapshot,
  type SpeedConfig,
  type SpeedFunctionName,
  type SpeedStatsIncrement,
} from "../utils/speed-config";

declare global {
  interface Window {
    __speedupExtensionInstalled?: true;
  }
}

type TimeoutHandler = string | ((...args: unknown[]) => void);
type TimerArgs = unknown[];

const STATS_FLUSH_DELAY_MS = 1000;
const CALLS_FLUSH_DELAY_MS = 100;

type TimerRecord = {
  active: boolean;
  addedAt: number;
  callId: string;
  delay: number;
  functionName: SpeedCallFunctionName;
  handler: TimeoutHandler;
  handlerLabel: string;
  nativeId: number | undefined;
  publicId: number;
  remainingVirtualMs: number;
  scheduledSpeed: number;
  sourceKey: string;
  sourceLabel: string;
  startedAt: number;
  type: "interval" | "timeout";
  args: TimerArgs;
};

type TimerSource = {
  key: string;
  label: string;
};

type SpeedFunctionSpeeds = Record<SpeedFunctionName, number>;

export default defineUnlistedScript(() => {
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const originalCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const originalPerformanceNow = window.performance.now.bind(window.performance);
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);

  if (window.__speedupExtensionInstalled) {
    return;
  }

  window.__speedupExtensionInstalled = true;

  let config: SpeedConfig = DEFAULT_SPEED_CONFIG;
  let virtualClockBase = originalPerformanceNow();
  let realClockBase = virtualClockBase;
  let nextCallSequence = 1;
  let nextSyntheticTimerId = -1;

  let disabledSourceKeys = new Set<string>();
  const timers = new Map<number, TimerRecord>();
  const timerCallIds = new Map<string, TimerRecord>();
  const animationFrames = new Map<number, number>();
  const pendingStats = new Map<SpeedFunctionName, SpeedStatsIncrement>();
  let statsFlushId: number | undefined;
  let callsFlushId: number | undefined;
  const pageSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function getSpeed(functionName: SpeedFunctionName): number {
    return Math.max(1, effectiveSpeed(config, window.location.hostname, functionName));
  }

  function getCurrentSpeeds(): SpeedFunctionSpeeds {
    return {
      requestAnimationFrame: getSpeed("requestAnimationFrame"),
      setInterval: getSpeed("setInterval"),
      setTimeout: getSpeed("setTimeout"),
    };
  }

  function isSpeedChangeAllowed(functionName: SpeedFunctionName): boolean {
    return (
      config.enabled &&
      !isHostnameExcluded(config, window.location.hostname) &&
      isSpeedFunctionEnabled(config, functionName)
    );
  }

  function shouldManageTimer(functionName: SpeedCallFunctionName): boolean {
    if (!isSpeedChangeAllowed(functionName)) {
      return false;
    }

    return config.mode === "manual" || config.speed > 1;
  }

  function shouldPauseTimerInvocations(functionName: SpeedCallFunctionName): boolean {
    return (
      config.mode === "manual" && config.pauseInvocations && isSpeedChangeAllowed(functionName)
    );
  }

  function getTimerSpeed(record: TimerRecord): number {
    if (!isSpeedChangeAllowed(record.functionName)) {
      return 1;
    }

    if (config.mode === "manual") {
      return 1;
    }

    return config.speed;
  }

  function virtualNow(
    realNow = originalPerformanceNow(),
    speed = getSpeed("requestAnimationFrame"),
  ): number {
    return virtualClockBase + (realNow - realClockBase) * speed;
  }

  function normalizeDelay(delay?: number): number {
    const parsed = Number(delay ?? 0);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }

  function createCallId(): string {
    const callId = `${pageSessionId}:${nextCallSequence}`;
    nextCallSequence += 1;
    return callId;
  }

  function createSyntheticTimerId(): number {
    const id = nextSyntheticTimerId;
    nextSyntheticTimerId -= 1;
    return id;
  }

  function createSuppressedTimerId(): number {
    return createSyntheticTimerId();
  }

  function getHandlerLabel(handler: TimeoutHandler): string {
    if (typeof handler === "string") {
      return "string handler";
    }

    return handler.name ? `${handler.name}()` : "anonymous handler";
  }

  function isInternalStackLocation(location: string): boolean {
    return (
      location.includes("/speed-page.js:") ||
      location.startsWith("chrome-extension://") ||
      location.startsWith("moz-extension://")
    );
  }

  function normalizeStackLocation(location: string): string {
    const match = location.match(/^(.*):(\d+):(\d+)$/);

    if (!match) {
      return location;
    }

    const [, rawUrl, line, column] = match;

    try {
      const url = new URL(rawUrl);
      url.hash = "";
      return `${url.href}:${line}:${column}`;
    } catch {
      return location;
    }
  }

  function getStackFrameLocation(frame: string): string | undefined {
    const trimmed = frame.trim();

    if (!trimmed || trimmed === "Error") {
      return undefined;
    }

    const withoutAt = trimmed.replace(/^at\s+/, "");
    const parenthesizedLocation = withoutAt.match(/\((.+)\)$/);
    const rawLocation = parenthesizedLocation?.[1] ?? withoutAt;
    const locationMatch = rawLocation.match(/(.+:\d+:\d+)$/);

    if (!locationMatch) {
      return undefined;
    }

    const location = normalizeStackLocation(locationMatch[1]);
    return isInternalStackLocation(location) ? undefined : location;
  }

  function getTimerSource(
    functionName: SpeedCallFunctionName,
    handlerLabel: string,
    delay: number,
  ): TimerSource {
    const stack = new Error().stack;

    if (typeof stack === "string") {
      for (const frame of stack.split("\n")) {
        const location = getStackFrameLocation(frame);

        if (location) {
          return {
            key: `${functionName}:${location}`,
            label: location,
          };
        }
      }
    }

    return {
      key: `${functionName}:unknown:${handlerLabel}:${delay}`,
      label: "unknown location",
    };
  }

  function getNativeDelay(virtualDelay: number, speed: number): number {
    if (virtualDelay <= 0) {
      return 0;
    }

    return virtualDelay / Math.max(1, speed);
  }

  function flushSpeedStats(): void {
    statsFlushId = undefined;

    if (pendingStats.size === 0) {
      return;
    }

    const increments = Array.from(pendingStats.values());
    pendingStats.clear();

    window.postMessage(
      {
        increments,
        type: SPEED_STATS_MESSAGE_TYPE,
      },
      "*",
    );
  }

  function scheduleStatsFlush(): void {
    if (statsFlushId != null) {
      return;
    }

    statsFlushId = originalSetTimeout(flushSpeedStats, STATS_FLUSH_DELAY_MS);
  }

  function getTimerRemainingMs(record: TimerRecord, now = originalPerformanceNow()): number {
    if (record.nativeId == null) {
      return getNativeDelay(record.remainingVirtualMs, record.scheduledSpeed);
    }

    const elapsedVirtualMs = (now - record.startedAt) * record.scheduledSpeed;
    const remainingVirtualMs = Math.max(0, record.remainingVirtualMs - elapsedVirtualMs);
    return getNativeDelay(remainingVirtualMs, record.scheduledSpeed);
  }

  function getTimerSnapshot(
    record: TimerRecord,
    now = originalPerformanceNow(),
  ): SpeedCallSnapshot {
    const remainingMs = getTimerRemainingMs(record, now);

    return {
      addedAt: record.addedAt,
      delay: record.delay,
      dueAt: Date.now() + remainingMs,
      functionName: record.functionName,
      handlerLabel: record.handlerLabel,
      id: record.callId,
      publicId: record.publicId,
      remainingMs,
      speed: record.scheduledSpeed,
      sourceKey: record.sourceKey,
      sourceLabel: record.sourceLabel,
      type: record.type,
      url: window.location.href,
    };
  }

  function flushSpeedCalls(): void {
    callsFlushId = undefined;

    const now = originalPerformanceNow();
    const calls = Array.from(timers.values())
      .filter((record) => record.active)
      .map((record) => getTimerSnapshot(record, now));

    window.postMessage(
      {
        calls,
        capturedAt: Date.now(),
        type: SPEED_CALLS_CHANGED_MESSAGE_TYPE,
      },
      "*",
    );
  }

  function scheduleCallsFlush(): void {
    if (callsFlushId != null) {
      return;
    }

    callsFlushId = originalSetTimeout(flushSpeedCalls, CALLS_FLUSH_DELAY_MS);
  }

  function logSpeedTrigger(
    functionName: SpeedFunctionName,
    shouldLog = getSpeed(functionName) > 1,
  ): void {
    if (!shouldLog) {
      return;
    }

    const increment = pendingStats.get(functionName);

    if (increment) {
      increment.count += 1;
    } else {
      pendingStats.set(functionName, {
        count: 1,
        functionName,
      });
    }

    scheduleStatsFlush();
  }

  function invokeTimerHandler(handler: TimeoutHandler, args: TimerArgs): void {
    if (typeof handler === "function") {
      handler.apply(window, args);
      return;
    }

    (0, eval)(handler);
  }

  function completeTimerOccurrence(record: TimerRecord): void {
    if (!record.active) {
      return;
    }

    if (record.type === "timeout") {
      removeTimerRecord(record);
      scheduleCallsFlush();
    }

    invokeTimerHandler(record.handler, record.args);

    if (record.type === "interval" && record.active) {
      record.remainingVirtualMs = record.delay;
      scheduleTimer(record);
    }
  }

  function removeTimerRecord(record: TimerRecord): void {
    record.active = false;
    timers.delete(record.publicId);
    timerCallIds.delete(record.callId);
  }

  function cancelTimerRecord(record: TimerRecord): void {
    removeTimerRecord(record);
    if (record.nativeId != null) {
      originalClearTimeout(record.nativeId);
      record.nativeId = undefined;
    }
    scheduleCallsFlush();
  }

  function scheduleTimer(record: TimerRecord, notify = true): void {
    const isPaused = shouldPauseTimerInvocations(record.functionName);
    const speed = isPaused ? 1 : getTimerSpeed(record);

    record.scheduledSpeed = speed;
    record.startedAt = originalPerformanceNow();

    if (isPaused) {
      record.nativeId = undefined;

      if (notify) {
        scheduleCallsFlush();
      }

      return;
    }

    record.nativeId = originalSetTimeout(
      () => {
        completeTimerOccurrence(record);
      },
      getNativeDelay(record.remainingVirtualMs, speed),
    );

    if (notify) {
      scheduleCallsFlush();
    }
  }

  function clearManagedTimer(publicId?: unknown): boolean {
    if (typeof publicId !== "number") {
      return false;
    }

    const record = timers.get(publicId);

    if (!record) {
      return false;
    }

    cancelTimerRecord(record);
    return true;
  }

  function rescheduleTimer(record: TimerRecord, now = originalPerformanceNow()): void {
    if (record.nativeId != null) {
      const elapsedVirtualMs = (now - record.startedAt) * record.scheduledSpeed;
      record.remainingVirtualMs = Math.max(0, record.remainingVirtualMs - elapsedVirtualMs);
      originalClearTimeout(record.nativeId);
      record.nativeId = undefined;
    }

    scheduleTimer(record);
  }

  function rescheduleTimersForSpeedChange(now: number): void {
    for (const record of timers.values()) {
      if (!record.active) {
        continue;
      }

      rescheduleTimer(record, now);
    }
  }

  function invokeCallNow(callId: unknown): void {
    if (typeof callId !== "string") {
      return;
    }

    const record = timerCallIds.get(callId);

    if (
      !record ||
      !record.active ||
      config.mode !== "manual" ||
      !isSpeedChangeAllowed(record.functionName)
    ) {
      flushSpeedCalls();
      return;
    }

    if (record.nativeId != null) {
      originalClearTimeout(record.nativeId);
      record.nativeId = undefined;
    }

    if (record.delay > 0) {
      logSpeedTrigger(record.functionName, true);
    }

    completeTimerOccurrence(record);
    flushSpeedCalls();
  }

  function disableCall(callId: unknown): void {
    if (typeof callId !== "string") {
      return;
    }

    const record = timerCallIds.get(callId);

    if (
      !record ||
      !record.active ||
      config.mode !== "manual" ||
      !isSpeedChangeAllowed(record.functionName)
    ) {
      flushSpeedCalls();
      return;
    }

    cancelTimerRecord(record);
    flushSpeedCalls();
  }

  function getSourceKeyFromCommand(sourceKey: unknown, callId: unknown): string | undefined {
    const normalizedSourceKey = normalizeSpeedCallSources([sourceKey])[0]?.key;

    if (normalizedSourceKey) {
      return normalizedSourceKey;
    }

    if (typeof callId !== "string") {
      return undefined;
    }

    return timerCallIds.get(callId)?.sourceKey;
  }

  function cancelCallsBySource(sourceKey: string): void {
    let changed = false;

    for (const record of Array.from(timers.values())) {
      if (!record.active || record.sourceKey !== sourceKey) {
        continue;
      }

      cancelTimerRecord(record);
      changed = true;
    }

    if (changed) {
      flushSpeedCalls();
    }
  }

  function disableCallSource(sourceKey: unknown, callId: unknown): void {
    const normalizedSourceKey = getSourceKeyFromCommand(sourceKey, callId);

    if (!normalizedSourceKey) {
      flushSpeedCalls();
      return;
    }

    disabledSourceKeys.add(normalizedSourceKey);
    cancelCallsBySource(normalizedSourceKey);
    flushSpeedCalls();
  }

  function handleCallCommand(command: unknown, callId: unknown, sourceKey: unknown): void {
    const normalizedCommand = normalizeSpeedCallCommand(command);

    if (normalizedCommand === "disable-source") {
      disableCallSource(sourceKey, callId);
      return;
    }

    if (normalizedCommand === "disable") {
      disableCall(callId);
      return;
    }

    invokeCallNow(callId);
  }

  function updateConfig(nextConfig: unknown): void {
    const now = originalPerformanceNow();
    const previousSpeeds = getCurrentSpeeds();

    virtualClockBase = virtualNow(now, previousSpeeds.requestAnimationFrame);
    realClockBase = now;
    config = normalizeSpeedConfig(nextConfig);
    rescheduleTimersForSpeedChange(now);
    scheduleCallsFlush();
  }

  function updateDisabledCallSources(sources: unknown): void {
    disabledSourceKeys = new Set(normalizeSpeedCallSources(sources).map((source) => source.key));

    for (const sourceKey of disabledSourceKeys) {
      cancelCallsBySource(sourceKey);
    }

    scheduleCallsFlush();
  }

  function managedSetTimeout(handler: TimeoutHandler, delay?: number, ...args: TimerArgs): number {
    if (!shouldManageTimer("setTimeout")) {
      return originalSetTimeout(handler, delay, ...args);
    }

    const normalizedDelay = normalizeDelay(delay);
    const handlerLabel = getHandlerLabel(handler);
    const source = getTimerSource("setTimeout", handlerLabel, normalizedDelay);

    if (disabledSourceKeys.has(source.key)) {
      return createSuppressedTimerId();
    }

    const record: TimerRecord = {
      active: true,
      addedAt: Date.now(),
      args,
      callId: createCallId(),
      delay: normalizedDelay,
      functionName: "setTimeout",
      handler,
      handlerLabel,
      nativeId: undefined,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      scheduledSpeed: 1,
      sourceKey: source.key,
      sourceLabel: source.label,
      startedAt: 0,
      type: "timeout",
    };

    if (normalizedDelay > 0 && getTimerSpeed(record) > 1) {
      logSpeedTrigger("setTimeout");
    }

    scheduleTimer(record, false);
    record.publicId = record.nativeId ?? createSyntheticTimerId();
    timers.set(record.publicId, record);
    timerCallIds.set(record.callId, record);
    scheduleCallsFlush();

    return record.publicId;
  }

  function managedSetInterval(handler: TimeoutHandler, delay?: number, ...args: TimerArgs): number {
    if (!shouldManageTimer("setInterval")) {
      return originalSetInterval(handler, delay, ...args);
    }

    const normalizedDelay = normalizeDelay(delay);
    const handlerLabel = getHandlerLabel(handler);
    const source = getTimerSource("setInterval", handlerLabel, normalizedDelay);

    if (disabledSourceKeys.has(source.key)) {
      return createSuppressedTimerId();
    }

    const record: TimerRecord = {
      active: true,
      addedAt: Date.now(),
      args,
      callId: createCallId(),
      delay: normalizedDelay,
      functionName: "setInterval",
      handler,
      handlerLabel,
      nativeId: undefined,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      scheduledSpeed: 1,
      sourceKey: source.key,
      sourceLabel: source.label,
      startedAt: 0,
      type: "interval",
    };

    if (normalizedDelay > 0 && getTimerSpeed(record) > 1) {
      logSpeedTrigger("setInterval");
    }

    scheduleTimer(record, false);
    record.publicId = record.nativeId ?? createSyntheticTimerId();
    timers.set(record.publicId, record);
    timerCallIds.set(record.callId, record);
    scheduleCallsFlush();

    return record.publicId;
  }

  function managedClearTimeout(id?: unknown): void {
    if (!clearManagedTimer(id)) {
      originalClearTimeout(id as number | undefined);
    }
  }

  function managedClearInterval(id?: unknown): void {
    if (!clearManagedTimer(id)) {
      originalClearInterval(id as number | undefined);
    }
  }

  function managedRequestAnimationFrame(callback: FrameRequestCallback): number {
    if (getSpeed("requestAnimationFrame") <= 1) {
      return originalRequestAnimationFrame(callback);
    }

    const nativeId = originalRequestAnimationFrame((timestamp) => {
      animationFrames.delete(nativeId);
      callback(virtualNow(timestamp));
    });

    logSpeedTrigger("requestAnimationFrame");

    animationFrames.set(nativeId, nativeId);
    return nativeId;
  }

  function managedCancelAnimationFrame(id: number): void {
    const nativeId = animationFrames.get(id);

    if (nativeId != null) {
      animationFrames.delete(id);
      originalCancelAnimationFrame(nativeId);
      return;
    }

    originalCancelAnimationFrame(id);
  }

  function copyNativeToString(
    target: (...args: never[]) => unknown,
    nativeFunction: (...args: never[]) => unknown,
  ): void {
    Object.defineProperty(target, "toString", {
      configurable: true,
      value: () => nativeFunction.toString(),
    });
  }

  copyNativeToString(managedSetTimeout, originalSetTimeout);
  copyNativeToString(managedSetInterval, originalSetInterval);
  copyNativeToString(managedClearTimeout, originalClearTimeout);
  copyNativeToString(managedClearInterval, originalClearInterval);
  copyNativeToString(managedRequestAnimationFrame, originalRequestAnimationFrame);
  copyNativeToString(managedCancelAnimationFrame, originalCancelAnimationFrame);

  window.setTimeout = managedSetTimeout as unknown as typeof window.setTimeout;
  window.setInterval = managedSetInterval as unknown as typeof window.setInterval;
  window.clearTimeout = managedClearTimeout as unknown as typeof window.clearTimeout;
  window.clearInterval = managedClearInterval as unknown as typeof window.clearInterval;
  window.requestAnimationFrame =
    managedRequestAnimationFrame as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = managedCancelAnimationFrame as typeof window.cancelAnimationFrame;

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }

    if (event.data?.type === SPEED_MESSAGE_TYPE) {
      updateConfig(event.data.config);
      return;
    }

    if (event.data?.type === SPEED_CALLS_REFRESH_MESSAGE_TYPE) {
      flushSpeedCalls();
      return;
    }

    if (event.data?.type === SPEED_CALLS_DISABLED_SOURCES_MESSAGE_TYPE) {
      updateDisabledCallSources(event.data.sources);
      return;
    }

    if (event.data?.type === SPEED_CALLS_COMMAND_MESSAGE_TYPE) {
      handleCallCommand(event.data.command, event.data.callId, event.data.sourceKey);
    }
  });

  window.addEventListener("pagehide", () => {
    flushSpeedStats();
    flushSpeedCalls();
  });
});
