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

/**
 * Longest *simulation* run we will do in one frame, in ticks.
 *
 * `MAX_FRAME_MS` bounds the clock and then `elapsed * speed` multiplies it
 * straight back out, so at the 8× the transport offers a clamped 250 ms frame
 * asked for 2,000 ms of simulation — 240 steps, the same burst size as a
 * Fast-forward press, in a frame that is supposed to paint. That is a stable bad
 * state rather than a spiral: if 240 ticks cost more than 250 ms of wall clock
 * the clamp binds again on the next frame and keeps binding, and the tab sits at
 * about 1.5 fps until the run ends. Measured on the Ising sheet at 128², 8× plus
 * a held Fast-forward yielded the main thread once every 389 ms.
 *
 * Clamping the work as well as the clock fixes it for every visualization at
 * once, current and future, where per-tab tuning would not: losing simulated
 * time is already the accepted trade for a frame nobody watched, and this
 * applies it in the unit that actually costs money. 32 is two frames of 8× at
 * 60 Hz, so an honest 8× never touches it, and it also keeps the chaos game's
 * points-per-paint under the ring its incremental path needs.
 */
const MAX_TICKS_PER_FRAME = 32;

export interface EngineHandle {
  start(): void;
  stop(): void;
  /** Advance exactly one tick while paused. Drives the reduced-motion step button. */
  stepOnce(): void;
  /**
   * Run `ticks` steps, painting every `paintEvery` of them. Drives "skip to
   * 10,000 trials".
   *
   * `paintEvery` defaults to the whole run — one paint at the end, which is the
   * point of the control. A caller passes a smaller number when the *reader* is
   * driving, because a visualization that can only paint incrementally has to be
   * given the chance: the chaos game keeps a ring of its 32,768 most recent
   * points and falls back to replaying its whole occupancy grid when more than
   * that arrived between two paints. One 240-tick press plots 240,000 points, so
   * that fallback was taken on every press by construction, and a press cost 634
   * ms of re-stroking the 818,000 cells already on screen instead of the 180 ms
   * the new points actually cost. Painting in chunks that fit the ring makes the
   * incremental path reachable again, and costs six extra `draw()` calls.
   */
  fastForward(ticks: number, paintEvery?: number): void;
  setSpeed(multiplier: number): void;
  readonly running: boolean;
}

export function createEngine(getInstance: () => VizInstance | null): EngineHandle {
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let speed = 1;
  let running = false;

  /**
   * Queue the next frame, but only while the engine is still running.
   *
   * `step()` or `draw()` may stop the engine mid-frame — a run that has just
   * finished, or a teardown triggered during a paint. `stop()` cancels the id it
   * knows about, which is the frame already executing, so re-queueing
   * unconditionally here would hand back a loop that nothing can stop and that
   * keeps stepping a torn-down instance.
   */
  function schedule(): void {
    if (running) raf = requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    if (!running) return;

    const inst = getInstance();
    if (!inst) {
      // Nothing to drive yet: the shell may start the loop before the first
      // route resolves, or swap instances across an await while a tab's module
      // loads. Idle rather than exit — a loop that dies here leaves `running`
      // true, and no later start() can revive it. Resetting `last` keeps the
      // idle time from being banked and replayed onto the instance that arrives.
      last = now;
      schedule();
      return;
    }

    const elapsed = Math.min(now - last, MAX_FRAME_MS);
    last = now;
    accumulator += elapsed * speed;

    // The clamp is counted in ticks, not in milliseconds, because ticks are
    // what the frame spends: `MAX_TICKS_PER_FRAME * FIXED_DT` is not an exact
    // multiple of FIXED_DT in binary, so clamping the accumulator to it left a
    // frame one tick short and banked the difference for the next one.
    const due = Math.floor(accumulator / FIXED_DT);
    const ticks = due > MAX_TICKS_PER_FRAME ? MAX_TICKS_PER_FRAME : due;
    for (let i = 0; i < ticks; i++) inst.step(FIXED_DT);
    // Bank the sub-tick remainder — it is what keeps 60 Hz and 144 Hz in step —
    // and drop whatever the cap refused. Simulated time the frame could not
    // afford is lost, not owed: carrying it forward is what turns one late
    // frame into a permanently late one, which is the whole failure this cap
    // exists to prevent.
    accumulator %= FIXED_DT;

    inst.draw();
    schedule();
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

    fastForward(ticks: number, paintEvery?: number) {
      const inst = getInstance();
      if (!inst) return;
      // Whole, finite, non-negative at the boundary rather than trusted from the
      // caller: `done < ticks` never becomes false for a NaN or an Infinity, and
      // this loop is the one place in the app with no frame boundary to escape
      // through — it would take the tab with it rather than drop a frame.
      const total = Number.isFinite(ticks) ? Math.max(0, Math.floor(ticks)) : 0;
      const chunk = paintEvery !== undefined && paintEvery > 0 ? Math.floor(paintEvery) : total;
      let done = 0;
      do {
        const run = Math.min(chunk, total - done);
        for (let i = 0; i < run; i++) inst.step(FIXED_DT);
        inst.draw();
        done += run;
      } while (done < total);
    },

    setSpeed(multiplier: number) {
      speed = multiplier;
    },
  };
}
