import type { VizInstance } from './types';

/** Simulation tick, in milliseconds. 120 Hz — twice display rate, so motion stays smooth at 2x speed. */
const FIXED_DT = 1000 / 120;

/**
 * Longest real elapsed time we will simulate in one frame.
 *
 * Returning to a backgrounded tab hands us a multi-second delta. Without this
 * clamp the while-loop below runs thousands of steps, blows the frame budget,
 * and produces an even larger delta next frame — the classic spiral of death.
 * Clamping makes the simulation silently lose time instead, which is the right
 * trade for an animation nobody was watching.
 */
const MAX_FRAME_MS = 250;

export interface EngineHandle {
  start(): void;
  stop(): void;
  /** Advance exactly one tick while paused. Drives the reduced-motion step button. */
  stepOnce(): void;
  /** Run `ticks` steps without painting intermediate frames. Drives "skip to 10,000 trials". */
  fastForward(ticks: number): void;
  setSpeed(multiplier: number): void;
  readonly running: boolean;
}

export function createEngine(getInstance: () => VizInstance | null): EngineHandle {
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let speed = 1;
  let running = false;

  function frame(now: number): void {
    const inst = getInstance();
    if (!inst) {
      // Nothing to drive yet: the shell may start the loop before the first
      // route resolves, or swap instances across an await while a tab's module
      // loads. Idle rather than exit — a loop that dies here leaves `running`
      // true, and no later start() can revive it. Resetting `last` keeps the
      // idle time from being banked and replayed onto the instance that arrives.
      last = now;
      raf = requestAnimationFrame(frame);
      return;
    }

    const elapsed = Math.min(now - last, MAX_FRAME_MS);
    last = now;
    accumulator += elapsed * speed;

    while (accumulator >= FIXED_DT) {
      inst.step(FIXED_DT);
      accumulator -= FIXED_DT;
    }

    inst.draw();
    raf = requestAnimationFrame(frame);
  }

  return {
    get running() {
      return running;
    },

    start() {
      if (running) return;
      running = true;
      last = performance.now();
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
    },

    stepOnce() {
      const inst = getInstance();
      if (!inst) return;
      inst.step(FIXED_DT);
      inst.draw();
    },

    fastForward(ticks: number) {
      const inst = getInstance();
      if (!inst) return;
      for (let i = 0; i < ticks; i++) inst.step(FIXED_DT);
      inst.draw();
    },

    setSpeed(multiplier: number) {
      speed = multiplier;
    },
  };
}
