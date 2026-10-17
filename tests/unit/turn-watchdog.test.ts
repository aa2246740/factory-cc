import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnWatchdog } from "../../src/runtime/turn-watchdog.js";

const IDLE = 10_000;
const MAX = 120_000;
let onTimeout: ReturnType<typeof vi.fn>;
let watchdogs: TurnWatchdog[] = [];
function start(options: { idleMs?: number; maxMs?: number } = {}): TurnWatchdog {
  const watchdog = new TurnWatchdog({ idleMs: IDLE, maxMs: MAX, ...options, onTimeout });
  watchdogs.push(watchdog);
  return watchdog;
}

beforeEach(() => {
  vi.useFakeTimers();
  onTimeout = vi.fn();
});
afterEach(() => {
  for (const watchdog of watchdogs) watchdog.dispose();
  watchdogs = [];
  vi.useRealTimers();
});

describe("turn watchdog", () => {
  it("times out a turn that makes no progress", () => {
    start();
    vi.advanceTimersByTime(IDLE - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("idle");
    vi.advanceTimersByTime(MAX);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("keeps a turn alive well past the idle limit while it reports progress, then times out from the last sign of life", () => {
    const watchdog = start();
    // Eight times the idle limit, each gap shorter than it: the old absolute deadline would have fired.
    for (let elapsed = 0; elapsed < IDLE * 8; elapsed += IDLE / 2) {
      vi.advanceTimersByTime(IDLE / 2);
      watchdog.touch();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDLE - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("idle");
  });

  it("pauses the idle limit while an approval is pending and restarts a full window afterwards", () => {
    const watchdog = start({ maxMs: IDLE * 100 });
    vi.advanceTimersByTime(IDLE - 100);
    watchdog.setPaused(true);
    vi.advanceTimersByTime(IDLE * 20);
    watchdog.touch();
    vi.advanceTimersByTime(IDLE * 20);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.setPaused(false);
    vi.advanceTimersByTime(IDLE - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("idle");
  });

  it("does not time out an approval wait that is decided just before the limit", () => {
    const watchdog = start({ maxMs: IDLE * 100 });
    watchdog.setPaused(true);
    vi.advanceTimersByTime(IDLE * 3 - 1);
    watchdog.setPaused(false);
    watchdog.touch();
    vi.advanceTimersByTime(IDLE - 1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("enforces the absolute cap whatever the progress or pauses", () => {
    const watchdog = start({ maxMs: IDLE * 5 });
    for (let elapsed = 0; elapsed < IDLE * 5 - 1; elapsed += IDLE / 2) {
      vi.advanceTimersByTime(Math.min(IDLE / 2, IDLE * 5 - 1 - elapsed));
      watchdog.touch();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("max");

    const paused = start({ maxMs: IDLE * 5 });
    paused.setPaused(true);
    vi.advanceTimersByTime(IDLE * 5);
    expect(onTimeout).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenLastCalledWith("max");
  });

  it("leaves no timer behind after a timeout or disposal, and ignores later calls", () => {
    const fired = start();
    vi.advanceTimersByTime(IDLE);
    expect(vi.getTimerCount()).toBe(0);
    fired.touch();
    fired.setPaused(true);
    fired.setPaused(false);
    expect(vi.getTimerCount()).toBe(0);

    const disposed = start();
    expect(vi.getTimerCount()).toBe(2);
    disposed.dispose();
    disposed.dispose();
    expect(vi.getTimerCount()).toBe(0);
    disposed.touch();
    disposed.setPaused(false);
    vi.advanceTimersByTime(MAX * 2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
