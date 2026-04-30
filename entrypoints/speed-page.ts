import {
  DEFAULT_SPEED_CONFIG,
  effectiveSpeed,
  formatSpeedLabel,
  normalizeSpeedConfig,
  SPEED_MESSAGE_TYPE,
  SPEED_STATS_MESSAGE_TYPE,
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

type TimerRecord = {
  active: boolean;
  delay: number;
  handler: TimeoutHandler;
  nativeId: number;
  publicId: number;
  remainingVirtualMs: number;
  startedAt: number;
  type: "interval" | "timeout";
  args: TimerArgs;
};

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

  const timers = new Map<number, TimerRecord>();
  const animationFrames = new Map<number, number>();
  const pendingStats = new Map<string, SpeedStatsIncrement>();
  let statsFlushId: number | undefined;

  function getSpeed(): number {
    return Math.max(1, effectiveSpeed(config, window.location.hostname));
  }

  function virtualNow(realNow = originalPerformanceNow()): number {
    return virtualClockBase + (realNow - realClockBase) * getSpeed();
  }

  function normalizeDelay(delay?: number): number {
    const parsed = Number(delay ?? 0);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return parsed;
  }

  function getNativeDelay(virtualDelay: number): number {
    if (virtualDelay <= 0) {
      return 0;
    }

    return virtualDelay / getSpeed();
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

  function logSpeedTrigger(functionName: SpeedFunctionName): void {
    const speed = getSpeed();

    if (speed <= 1) {
      return;
    }

    const speedLabel = formatSpeedLabel(speed);
    const statsKey = `${functionName}:${speedLabel}`;
    const increment = pendingStats.get(statsKey);

    if (increment) {
      increment.count += 1;
    } else {
      pendingStats.set(statsKey, {
        count: 1,
        functionName,
        speedLabel,
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

  function scheduleTimer(record: TimerRecord): void {
    record.startedAt = originalPerformanceNow();
    record.nativeId = originalSetTimeout(() => {
      if (!record.active) {
        return;
      }

      if (record.type === "timeout") {
        timers.delete(record.publicId);
        record.active = false;
      }

      invokeTimerHandler(record.handler, record.args);

      if (record.type === "interval" && record.active) {
        record.remainingVirtualMs = record.delay;
        scheduleTimer(record);
      }
    }, getNativeDelay(record.remainingVirtualMs));
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
    originalClearTimeout(record.nativeId);
    return true;
  }

  function rescheduleTimersForSpeedChange(now: number, previousSpeed: number): void {
    for (const record of timers.values()) {
      if (!record.active) {
        continue;
      }

      const elapsedVirtualMs = (now - record.startedAt) * previousSpeed;
      record.remainingVirtualMs = Math.max(0, record.remainingVirtualMs - elapsedVirtualMs);

      originalClearTimeout(record.nativeId);
      scheduleTimer(record);
    }
  }

  function updateConfig(nextConfig: unknown): void {
    const now = originalPerformanceNow();
    const previousSpeed = getSpeed();

    virtualClockBase = virtualNow(now);
    realClockBase = now;
    config = normalizeSpeedConfig(nextConfig);
    rescheduleTimersForSpeedChange(now, previousSpeed);
  }

  function managedSetTimeout(handler: TimeoutHandler, delay?: number, ...args: TimerArgs): number {
    const normalizedDelay = normalizeDelay(delay);

    if (normalizedDelay > 0) {
      logSpeedTrigger("setTimeout");
    }

    const record: TimerRecord = {
      active: true,
      args,
      delay: normalizedDelay,
      handler,
      nativeId: 0,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      startedAt: 0,
      type: "timeout",
    };

    scheduleTimer(record);
    record.publicId = record.nativeId;
    timers.set(record.publicId, record);

    return record.publicId;
  }

  function managedSetInterval(handler: TimeoutHandler, delay?: number, ...args: TimerArgs): number {
    const normalizedDelay = normalizeDelay(delay);

    if (normalizedDelay > 0) {
      logSpeedTrigger("setInterval");
    }

    const record: TimerRecord = {
      active: true,
      args,
      delay: normalizedDelay,
      handler,
      nativeId: 0,
      publicId: 0,
      remainingVirtualMs: normalizedDelay,
      startedAt: 0,
      type: "interval",
    };

    scheduleTimer(record);
    record.publicId = record.nativeId;
    timers.set(record.publicId, record);

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
    if (event.source !== window || event.data?.type !== SPEED_MESSAGE_TYPE) {
      return;
    }

    updateConfig(event.data.config);
  });

  window.addEventListener("pagehide", flushSpeedStats);
});
