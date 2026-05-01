import {
  DEFAULT_SPEED_CONFIG,
  effectiveSpeed,
  isHostnameExcluded,
  isSpeedFunctionEnabled,
  normalizeSpeedConfig,
  SPEED_CALLS_CHANGED_MESSAGE_TYPE,
  SPEED_CALLS_COMMAND_MESSAGE_TYPE,
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
  nativeId: number;
  publicId: number;
  remainingVirtualMs: number;
  scheduledSpeed: number;
  startedAt: number;
  type: "interval" | "timeout";
  args: TimerArgs;
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

  function getHandlerLabel(handler: TimeoutHandler): string {
    if (typeof handler === "string") {
      return "string handler";
    }

    return handler.name ? `${handler.name}()` : "anonymous handler";
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
      timers.delete(record.publicId);
      timerCallIds.delete(record.callId);
      record.active = false;
      scheduleCallsFlush();
    }

    invokeTimerHandler(record.handler, record.args);

    if (record.type === "interval" && record.active) {
      record.remainingVirtualMs = record.delay;
      scheduleTimer(record);
    }
  }

  function scheduleTimer(record: TimerRecord, notify = true): void {
    const speed = getTimerSpeed(record);

    record.scheduledSpeed = speed;
    record.startedAt = originalPerformanceNow();
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

    record.active = false;
    timers.delete(publicId);
    timerCallIds.delete(record.callId);
    originalClearTimeout(record.nativeId);
    scheduleCallsFlush();
    return true;
  }

  function rescheduleTimer(record: TimerRecord, now = originalPerformanceNow()): void {
    const elapsedVirtualMs = (now - record.startedAt) * record.scheduledSpeed;
    record.remainingVirtualMs = Math.max(0, record.remainingVirtualMs - elapsedVirtualMs);

    originalClearTimeout(record.nativeId);
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

    originalClearTimeout(record.nativeId);

    if (record.delay > 0) {
      logSpeedTrigger(record.functionName, true);
    }

    completeTimerOccurrence(record);
    flushSpeedCalls();
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

  function managedSetTimeout(handler: TimeoutHandler, delay?: number, ...args: TimerArgs): number {
    if (!shouldManageTimer("setTimeout")) {
      return originalSetTimeout(handler, delay, ...args);
    }

    const normalizedDelay = normalizeDelay(delay);

    const record: TimerRecord = {
      active: true,
      addedAt: Date.now(),
      args,
      callId: createCallId(),
      delay: normalizedDelay,
      functionName: "setTimeout",
      handler,
      handlerLabel: getHandlerLabel(handler),
      nativeId: 0,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      scheduledSpeed: 1,
      startedAt: 0,
      type: "timeout",
    };

    if (normalizedDelay > 0 && getTimerSpeed(record) > 1) {
      logSpeedTrigger("setTimeout");
    }

    scheduleTimer(record, false);
    record.publicId = record.nativeId;
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

    const record: TimerRecord = {
      active: true,
      addedAt: Date.now(),
      args,
      callId: createCallId(),
      delay: normalizedDelay,
      functionName: "setInterval",
      handler,
      handlerLabel: getHandlerLabel(handler),
      nativeId: 0,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      scheduledSpeed: 1,
      startedAt: 0,
      type: "interval",
    };

    if (normalizedDelay > 0 && getTimerSpeed(record) > 1) {
      logSpeedTrigger("setInterval");
    }

    scheduleTimer(record, false);
    record.publicId = record.nativeId;
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

    if (event.data?.type === SPEED_CALLS_COMMAND_MESSAGE_TYPE) {
      invokeCallNow(event.data.callId);
    }
  });

  window.addEventListener("pagehide", () => {
    flushSpeedStats();
    flushSpeedCalls();
  });
});
