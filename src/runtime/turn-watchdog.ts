export type TurnTimeout = "idle" | "max";

/** How long a turn gets to wind down after an interrupt before its process is killed. */
export const INTERRUPT_GRACE_MS = 5_000;

/**
 * Deadline for one native turn. It is idle-based: any sign of progress restarts
 * the idle window, so a long turn that keeps working is never cut off by it.
 * While a human decides on an approval the idle window is suspended, and it
 * restarts in full afterwards. The absolute cap runs regardless of progress.
 */
export class TurnWatchdog {
  private idleTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private paused = false;
  private done = false;

  constructor(private readonly options: { idleMs: number; maxMs: number; onTimeout(kind: TurnTimeout): void }) {
    this.armIdle();
    this.maxTimer = setTimeout(() => this.fire("max"), options.maxMs);
    this.maxTimer.unref();
  }

  /** Progress of any kind: an SDK message, a text delta or a tool event. */
  touch(): void {
    if (!this.paused) this.armIdle();
  }

  setPaused(paused: boolean): void {
    if (this.done || paused === this.paused) return;
    this.paused = paused;
    if (paused) this.clearIdle();
    else this.armIdle();
  }

  /** Safe to call repeatedly, from every exit path. */
  dispose(): void {
    this.done = true;
    this.clearIdle();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
  }

  private armIdle(): void {
    if (this.done) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.fire("idle"), this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private fire(kind: TurnTimeout): void {
    if (this.done) return;
    this.dispose();
    this.options.onTimeout(kind);
  }
}
