import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VizInstance } from '../src/core/types';
import { createEngine } from '../src/core/engine';

/**
 * The engine owns requestAnimationFrame, so testing it means owning the clock.
 *
 * `advance(ms)` moves the fake clock and fires exactly the frames that were
 * queued before the call, which is what a real browser does: a callback that
 * re-queues itself lands in the NEXT frame, not this one.
 */
function harness() {
  let now = 0;
  let nextId = 1;
  let queued = new Map<number, FrameRequestCallback>();

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queued.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued.delete(id);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);

  return {
    /** One frame of `ms`. Callbacks queued during it run on the next call. */
    advance(ms: number): void {
      now += ms;
      const due = queued;
      queued = new Map();
      for (const cb of due.values()) cb(now);
    },
    get pending(): number {
      return queued.size;
    },
  };
}

interface Stub extends VizInstance {
  steps: number;
  draws: number;
}

function stub(onDraw?: () => void): Stub {
  return {
    steps: 0,
    draws: 0,
    step() {
      this.steps++;
    },
    draw() {
      this.draws++;
      onDraw?.();
    },
    reset() {},
    destroy() {},
  };
}

const FIXED_DT = 1000 / 120;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createEngine', () => {
  it('steps at the fixed timestep in proportion to elapsed time', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    h.advance(100);

    // 100 ms at 120 Hz is 12 whole ticks; the 0.67 ms remainder is banked.
    expect(inst.steps).toBe(Math.floor(100 / FIXED_DT));
    expect(inst.draws).toBe(1);
  });

  it('draws once per frame regardless of how many steps that frame ran', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    h.advance(8); // shorter than one tick — zero steps, still one paint
    expect(inst.steps).toBe(0);
    expect(inst.draws).toBe(1);

    h.advance(100);
    expect(inst.draws).toBe(2);
  });

  it('banks the sub-tick remainder instead of dropping it', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    for (let i = 0; i < 8; i++) h.advance(4); // 32 ms total, never a whole tick alone

    // Dropping remainders would give 0; the accumulator turns them into 3 ticks.
    expect(inst.steps).toBe(Math.floor(32 / FIXED_DT));
  });

  it('clamps a long frame so a backgrounded tab cannot spiral', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    h.advance(5000); // five seconds away from the tab

    // Without the 250 ms clamp this would be 600 steps in one frame.
    expect(inst.steps).toBe(Math.floor(250 / FIXED_DT));
    expect(inst.steps).toBeLessThan(31);
  });

  it('scales steps by the speed multiplier', () => {
    // Asserted as an identity rather than a recomputed division: FIXED_DT is
    // 1000/120, so `Math.floor(200 / FIXED_DT)` is 23, not the 24 it looks like.
    // Running the same arithmetic the engine runs keeps the test honest.
    const run = (speed: number, ms: number): number => {
      const h = harness();
      const inst = stub();
      const engine = createEngine(() => inst);
      engine.setSpeed(speed);
      engine.start();
      h.advance(ms);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      return inst.steps;
    };

    expect(run(2, 100)).toBe(run(1, 200));
    expect(run(2, 100)).toBeGreaterThan(run(1, 100));
    expect(run(0.5, 200)).toBe(run(1, 100));
  });

  it('stops stepping after stop() and reports it', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    h.advance(100);
    const stepped = inst.steps;

    engine.stop();
    expect(engine.running).toBe(false);
    h.advance(100);
    h.advance(100);

    expect(inst.steps).toBe(stepped);
    expect(h.pending).toBe(0);
  });

  it('ignores a second start() rather than running two loops', () => {
    const h = harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.start();
    engine.start();
    h.advance(100);

    expect(inst.draws).toBe(1);
  });

  it('does not resurrect the loop when draw() stops the engine', () => {
    const h = harness();
    let engine!: ReturnType<typeof createEngine>;
    // A visualization that has finished, or a teardown triggered mid-paint.
    const inst = stub(() => engine.stop());
    engine = createEngine(() => inst);

    engine.start();
    h.advance(100);

    expect(engine.running).toBe(false);
    const stepped = inst.steps;

    h.advance(100);
    h.advance(100);

    // The frame that called stop() must not queue its successor: stop() already
    // cancelled the id it knew about, so a re-queue here would leave an
    // unstoppable loop stepping a torn-down instance forever.
    expect(h.pending).toBe(0);
    expect(inst.steps).toBe(stepped);
  });

  it('idles without dying while no instance exists, and banks no time', () => {
    const h = harness();
    let inst: Stub | null = null;
    const engine = createEngine(() => inst);

    engine.start();
    h.advance(1000); // a full second with nothing to drive
    expect(h.pending).toBe(1); // still alive

    inst = stub();
    h.advance(100);

    // The idle second must not be replayed onto the instance that just arrived.
    expect(inst.steps).toBe(Math.floor(100 / FIXED_DT));
  });

  it('advances exactly one tick per stepOnce() while paused', () => {
    harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.stepOnce();
    engine.stepOnce();

    expect(inst.steps).toBe(2);
    expect(inst.draws).toBe(2);
    expect(engine.running).toBe(false);
  });

  it('fastForward runs every tick but paints once', () => {
    harness();
    const inst = stub();
    const engine = createEngine(() => inst);

    engine.fastForward(1000);

    expect(inst.steps).toBe(1000);
    expect(inst.draws).toBe(1);
  });

  it('is inert when there is no instance to drive', () => {
    harness();
    const engine = createEngine(() => null);

    expect(() => {
      engine.stepOnce();
      engine.fastForward(10);
    }).not.toThrow();
  });
});
