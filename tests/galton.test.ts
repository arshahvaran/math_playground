import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { Readout, VizContext, VizInstance } from '../src/core/types';
import { dropRateFor, galton, pileMetrics } from '../src/viz/galton/index';
import { binomialPmf, normalPdf } from '../src/core/stats';
import { proseText } from '../src/ui/dom';
import { testable, verdictOf } from '../src/ui/readouts';
import {
  DEFAULT_BOARD,
  GRAVITY_PX,
  MAX_ROWS,
  binCentreX,
  createSim,
  lateralToPx,
  layoutBoard,
  pegPosition,
  popcount32,
  progressToPy,
  restSlot,
  type BoardPhysics,
  type GaltonParams,
  type GaltonSim,
} from '../src/viz/galton/sim';

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** Row pitch in peg pitches: the lattice is equilateral. */
const ASPECT = Math.sqrt(3) / 2;

function sumOf(xs: Uint32Array): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Step until every ball has landed and come to rest. Throws rather than spin forever. */
function runToRest(sim: GaltonSim, balls: number, dt: number): number {
  let steps = 0;
  while (sim.landed < balls || sumOf(sim.settledBins) < balls) {
    sim.step(dt);
    if (++steps > 200_000) throw new Error(`no rest after ${steps} steps: landed ${sim.landed}/${balls}`);
  }
  return steps;
}

function make(seed: number, params: GaltonParams): GaltonSim {
  return createSim(createRng(seed), params, 20_000);
}

describe('galton sim: convergence', () => {
  it('lands 20,000 balls on 12 rows at p = ½ with the binomial mean and variance', () => {
    const balls = 20_000;
    const sim = make(42, { rows: 12, p: 0.5, balls, dropRate: 20_000 });
    runToRest(sim, balls, 1000);

    const { mean, variance, n } = sim.stats();
    expect(n).toBe(balls);
    // Bin ~ Binomial(12, ½): mean 6, variance 3.
    // SE of the sample mean is √(3 / 20000) ≈ 0.012, so 0.05 is about 4σ.
    // SE of the sample variance is √((μ₄ − σ⁴) / n) with μ₄ = σ⁴(3 − 1/6) for
    // this binomial ≈ √(16.5 / 20000) ≈ 0.029, so 0.15 is about 5σ.
    expect(Math.abs(mean - 6)).toBeLessThan(0.05);
    expect(Math.abs(variance - 3)).toBeLessThan(0.15);
  });

  it('slides the whole distribution right at p = 0.7 while keeping the binomial variance', () => {
    const balls = 20_000;
    const sim = make(42, { rows: 12, p: 0.7, balls, dropRate: 20_000 });
    runToRest(sim, balls, 1000);

    const { mean, variance } = sim.stats();
    // Mean 12 · 0.7 = 8.4, variance 12 · 0.7 · 0.3 = 2.52.
    // SE of the mean √(2.52 / 20000) ≈ 0.011, so 0.06 is about 5σ.
    // SE of the variance ≈ √((μ₄ − σ⁴) / n) ≈ 0.025, so 0.15 is 6σ.
    expect(Math.abs(mean - 8.4)).toBeLessThan(0.06);
    expect(Math.abs(variance - 2.52)).toBeLessThan(0.15);
  });

  it('gives three rows exactly four bins that sum to the ball count, in the ratio 1 : 3 : 3 : 1', () => {
    const balls = 5_000;
    const sim = make(42, { rows: 3, p: 0.5, balls, dropRate: 5_000 });
    runToRest(sim, balls, 1000);

    expect(sim.bins.length).toBe(4);
    expect(sumOf(sim.bins)).toBe(balls);
    const frac = Array.from(sim.bins, (c) => c / balls);
    // Edge bins expect 1/8 with SE √(0.125 · 0.875 / 5000) ≈ 0.0047: 0.025 is 5σ.
    // Middle bins expect 3/8 with SE √(0.375 · 0.625 / 5000) ≈ 0.0068: 0.035 is 5σ.
    expect(Math.abs(frac[0]! - 1 / 8)).toBeLessThan(0.025);
    expect(Math.abs(frac[1]! - 3 / 8)).toBeLessThan(0.035);
    expect(Math.abs(frac[2]! - 3 / 8)).toBeLessThan(0.035);
    expect(Math.abs(frac[3]! - 1 / 8)).toBeLessThan(0.025);
  });
});

describe('galton sim: determinism', () => {
  it('produces identical bins from the same seed', () => {
    const params: GaltonParams = { rows: 12, p: 0.5, balls: 5_000, dropRate: 5_000 };
    const a = make(42, params);
    const b = make(42, params);
    runToRest(a, params.balls, 1000);
    runToRest(b, params.balls, 1000);
    expect(Array.from(a.bins)).toEqual(Array.from(b.bins));
    expect(a.stats()).toEqual(b.stats());
  });

  it('produces identical bins at any step size and drop rate: the clock never touches the statistics', () => {
    const balls = 3_000;
    const fast = make(7, { rows: 10, p: 0.4, balls, dropRate: 20_000 });
    const slow = make(7, { rows: 10, p: 0.4, balls, dropRate: 400 });
    runToRest(fast, balls, 1000);
    runToRest(slow, balls, TICK);
    expect(Array.from(slow.bins)).toEqual(Array.from(fast.bins));
  });

  it('differs between seeds', () => {
    const params: GaltonParams = { rows: 12, p: 0.5, balls: 2_000, dropRate: 2_000 };
    const a = make(1, params);
    const b = make(2, params);
    runToRest(a, params.balls, 1000);
    runToRest(b, params.balls, 1000);
    expect(Array.from(a.bins)).not.toEqual(Array.from(b.bins));
  });

  it('moves every ball along the same trajectory whatever the step size', () => {
    // The motion is analytic per segment, so a tick of a second and a hundred
    // and twenty ticks of a hundred-and-twentieth land on the same parabola —
    // this is what makes the animation identical at every refresh rate, and
    // what lets Fast-forward skip frames without changing where a ball is.
    const params: GaltonParams = { rows: 12, p: 0.5, balls: 40, dropRate: 20 };
    const coarse = make(11, params);
    const fine = make(11, params);
    for (let s = 0; s < 5; s++) {
      coarse.step(1000);
      for (let i = 0; i < 120; i++) fine.step(TICK);
      expect(fine.ballCount).toBe(coarse.ballCount);
      for (let i = 0; i < fine.ballCount; i++) {
        const a = coarse.ball(i);
        const b = fine.ball(i);
        // 120 · (1000/120) is a second to within an ulp; the positions differ
        // by the speed times that, nothing more.
        expect(b.x).toBeCloseTo(a.x, 6);
        expect(b.y).toBeCloseTo(a.y, 6);
        expect(b.row).toBe(a.row);
        expect(b.done).toBe(a.done);
      }
    }
  });
});

describe('galton sim: bookkeeping', () => {
  it('releases the first ball on the first tick and stops at the ball count', () => {
    const sim = make(42, { rows: 12, p: 0.5, balls: 3, dropRate: 1 });
    sim.step(TICK);
    expect(sim.ballCount).toBe(1);
    expect(sim.inFlight).toBe(1);
    // One ball per second: the second arrives after ~1 s, the third after ~2 s, then nothing.
    for (let i = 0; i < 120; i++) sim.step(TICK);
    expect(sim.ballCount).toBe(2);
    for (let i = 0; i < 1000; i++) sim.step(TICK);
    expect(sim.ballCount).toBe(3);
    expect(sim.landed).toBe(3);
    expect(sim.inFlight).toBe(0);
  });

  it('assigns every landed ball the bin popcount(path) and a unique stack slot', () => {
    const balls = 1_000;
    const rows = 8;
    const sim = make(42, { rows, p: 0.5, balls, dropRate: 400 });
    runToRest(sim, balls, TICK);

    expect(sim.ballCount).toBe(balls);
    expect(sim.landed).toBe(balls);
    expect(sim.inFlight).toBe(0);
    expect(Array.from(sim.settledBins)).toEqual(Array.from(sim.bins));

    const slots = Array.from({ length: rows + 1 }, () => new Set<number>());
    sim.forEachBall((b) => {
      expect(b.done).toBe(true);
      expect(b.settled).toBe(true);
      expect(b.row).toBe(rows);
      // At rest inside its bin: below the mouth, within the bin's width.
      expect(b.y).toBeGreaterThan(rows);
      expect(b.path >>> rows).toBe(0);
      expect(b.bin).toBe(popcount32(b.path));
      expect(Math.abs(b.x - (b.bin - rows / 2))).toBeLessThanOrEqual(0.5 + 1e-9);
      slots[b.bin]!.add(b.stack);
    });
    for (let k = 0; k <= rows; k++) {
      const count = sim.bins[k]!;
      expect(slots[k]!.size).toBe(count);
      for (let s = 0; s < count; s++) expect(slots[k]!.has(s)).toBe(true);
    }
    expect(sim.ball(0)).toEqual(sim.ball(0));
    expect(() => sim.ball(balls)).toThrow(RangeError);
  });

  it('keeps every ball in flight between the two pegs its route says it is between', () => {
    const rows = 12;
    const balls = 300;
    const sim = make(9, { rows, p: 0.5, balls, dropRate: 400 });
    const C = sim.contact;
    let checked = 0;
    while (sim.landed < balls) {
      sim.step(TICK);
      sim.forEachActive((b) => {
        if (b.done || b.row >= rows) return;
        expect(b.y).toBeGreaterThanOrEqual(-1);
        expect(b.y).toBeLessThan(rows);
        // The peg it left and the peg it is flying to. Contact happens a
        // contact radius from a peg's centre, so that is the margin.
        const to = popcount32(b.path & ((1 << b.row) - 1)) - b.row / 2;
        const from = b.row === 0 ? 0 : popcount32(b.path & ((1 << (b.row - 1)) - 1)) - (b.row - 1) / 2;
        expect(b.x).toBeGreaterThanOrEqual(Math.min(from, to) - C - 1e-9);
        expect(b.x).toBeLessThanOrEqual(Math.max(from, to) + C + 1e-9);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('absorbs a drop-rate change without losing the balls already down, and resets on a row change', () => {
    const sim = make(42, { rows: 12, p: 0.5, balls: 500, dropRate: 400 });
    // A twelve-row ball reaches the bin mouth 1.77 s after release on the
    // default board; two seconds guarantees landings.
    for (let i = 0; i < 240; i++) sim.step(TICK);
    const landedBefore = sim.landed;
    expect(landedBefore).toBeGreaterThan(0);

    sim.setParams({ rows: 12, p: 0.5, balls: 500, dropRate: 10 });
    expect(sim.landed).toBe(landedBefore);

    sim.setParams({ rows: 5, p: 0.5, balls: 500, dropRate: 10 });
    expect(sim.landed).toBe(0);
    expect(sim.ballCount).toBe(0);
    expect(sim.bins.length).toBe(6);
    expect(sim.rows).toBe(5);
  });

  it('reports NaN moments before the first landing', () => {
    const sim = make(42, { rows: 12, p: 0.5, balls: 10, dropRate: 10 });
    expect(sim.stats()).toEqual({ mean: NaN, variance: NaN, n: 0 });
  });

  it('never allocates beyond the budget', () => {
    const sim = createSim(createRng(42), { rows: 4, p: 0.5, balls: 1_000, dropRate: 1_000 }, 50);
    runToRest(sim, 50, 1000);
    expect(sim.ballCount).toBe(50);
    expect(sumOf(sim.bins)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** The physics board the renderer would derive for `rows` on a `width` × `height` plate at `balls`. */
function boardFor(width: number, height: number, rows: number, balls: number): BoardPhysics {
  const g = layoutBoard(width, height, rows);
  const pile = pileMetrics(g, 0.5, balls, 3);
  return {
    pitch: g.pegSpacing,
    contact: g.pegRadius + 3,
    binDepth: g.binBottom - g.binTop,
    dotRadius: pile.radius,
    cols: pile.cols,
  };
}

/** One sample of a ball's state, taken every `dt` ms of a run. */
interface Sample {
  t: number;
  x: number;
  /** Vertical position in peg pitches, not rows. */
  y: number;
  vx: number;
  vy: number;
  row: number;
  done: boolean;
  settled: boolean;
  path: number;
  bin: number;
  stack: number;
}

/** Every ball's history at `dt` ms resolution until all are at rest. */
function trace(sim: GaltonSim, balls: number, dt: number): Sample[][] {
  const out: Sample[][] = Array.from({ length: balls }, () => []);
  let t = 0;
  let steps = 0;
  while (sim.landed < balls || sumOf(sim.settledBins) < balls) {
    sim.step(dt);
    t += dt;
    if (++steps > 200_000) throw new Error('no rest');
    sim.forEachActive((b, i) => {
      out[i]!.push({
        t, x: b.x, y: b.y * ASPECT, vx: b.vx, vy: b.vy, row: b.row, done: b.done, settled: b.settled,
        path: b.path, bin: b.bin, stack: b.stack,
      });
    });
  }
  return out;
}

describe('galton sim: motion', () => {
  const rows = 12;

  it('falls freely from rest: the entry drop is y = −1 + ½·g·t² and nothing else', () => {
    const sim = make(42, { rows, p: 0.5, balls: 1, dropRate: 1 });
    // pitches/s² on the default board; the view reports rows, so divide by the row pitch.
    const g = GRAVITY_PX / DEFAULT_BOARD.pitch;
    expect(sim.gravity).toBeCloseTo(g, 12);
    let samples = 0;
    for (let i = 0; i < 40; i++) {
      sim.step(TICK);
      const b = sim.ball(0);
      if (b.row !== 0) break;
      const t = b.age / 1000;
      expect(b.y).toBeCloseTo(-1 + (g * t * t) / 2 / ASPECT, 9);
      expect(b.vy).toBeCloseTo(g * t, 9);
      // Released on the centre line; the drift toward the apex's shoulder is
      // within a contact radius.
      expect(Math.abs(b.x)).toBeLessThan(sim.contact);
      samples++;
    }
    expect(samples).toBeGreaterThan(5);
  });

  it('reaches the apex a contact radius from its centre, at the free-fall time for that height', () => {
    const sim = make(42, { rows, p: 0.5, balls: 1, dropRate: 1 });
    const g = sim.gravity;
    const C = sim.contact;
    // Fine steps, so the sample after the strike is within 0.05 ms of it.
    // The first ball leaves on the first tick.
    sim.step(0.05);
    let before = sim.ball(0);
    for (let i = 0; i < 20_000; i++) {
      sim.step(0.05);
      const b = sim.ball(0);
      if (b.row === 1) {
        // The sample before the strike is still on the entry parabola, ending
        // on the apex's contact circle: h = drop from release to contact.
        const h = before.y * ASPECT + ASPECT;
        expect(Math.hypot(before.x, before.y * ASPECT)).toBeCloseTo(C, 2);
        expect(before.age / 1000).toBeCloseTo(Math.sqrt((2 * h) / g), 3);
        // And it has been turned: upward, and toward the side its route chose.
        expect(b.vy).toBeLessThan(0);
        expect(Math.sign(b.vx)).toBe((b.path & 1) === 1 ? 1 : -1);
        return;
      }
      before = b;
    }
    throw new Error('never struck the apex');
  });

  it('speeds up through the upper rows and then bounces along at a steady pace', () => {
    // v² = 2gh holds inside every flight; between flights the peg takes its
    // toll, so the arrival speed climbs for the first rows and then settles
    // where the energy gained over one row equals the energy a bounce costs.
    // That plateau is what a real board shows too — with any restitution
    // below one, a ball does not keep accelerating down a peg lattice.
    const balls = 100;
    const sim = make(3, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 1);
    const arrival = Array.from({ length: rows }, () => [] as number[]);
    const strike = Array.from({ length: rows }, () => [] as number[]);
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row !== prev.row && prev.row < rows) {
          arrival[prev.row]!.push(Math.hypot(prev.vx, prev.vy));
          strike[prev.row]!.push(cur.t);
        }
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = arrival.map(mean);
    const t = strike.map(mean);
    // Measured on the default board: 17.5, 20.6, 21.6, 21.9 pitch/s, then 22.0 ± 0.1.
    expect(v[1]!).toBeGreaterThan(v[0]! * 1.1);
    expect(v[2]!).toBeGreaterThan(v[1]!);
    expect(v[3]!).toBeGreaterThan(v[2]!);
    for (let r = 4; r < rows; r++) expect(Math.abs(v[r]! / v[3]! - 1)).toBeLessThan(0.03);
    // The row-to-row transit is not a fixed duration: the entry drop is the
    // shortest, and a ball reaches the twelfth row about 1.6 s after release.
    expect(t[1]! - t[0]!).toBeGreaterThan(t[0]!);
    expect(t[rows - 1]!).toBeGreaterThan(1_500);
    expect(t[rows - 1]!).toBeLessThan(1_750);
  });

  it('rebounds off every peg upward and toward the side the route chose', () => {
    const balls = 100;
    const sim = make(5, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 1);
    let bounces = 0;
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row === prev.row || prev.row >= rows) continue;
        const s = (cur.path >>> prev.row) & 1 ? 1 : -1;
        expect(Math.sign(cur.vx), `ball path ${cur.path.toString(2)} row ${prev.row}`).toBe(s);
        expect(cur.vy).toBeLessThan(0);
        bounces++;
      }
    }
    expect(bounces).toBe(balls * rows);
  });

  it('bounces higher off a peg it arrives at faster', () => {
    // Hop height after striking row r, averaged: 0.075, 0.17, 0.20, 0.21 …
    // pitches on the default board, tracking the arrival speeds above. The
    // restitution model produces this; nothing scales a hop by the row.
    const balls = 100;
    const sim = make(8, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 1);
    const hop = Array.from({ length: rows }, () => [] as number[]);
    for (const run of runs) {
      let launchY = NaN;
      let top = NaN;
      let launchedFrom = -1;
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row !== prev.row) {
          if (launchedFrom >= 0) hop[launchedFrom]!.push(launchY - top);
          launchedFrom = prev.row < rows ? prev.row : -1;
          launchY = cur.y;
          top = cur.y;
        } else if (cur.y < top) {
          top = cur.y;
        }
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // The hop off the last peg ends in the bin, where no row change marks
    // it; the eleven before it are what the tracker sees.
    const h = hop.slice(0, rows - 1).map(mean);
    expect(h[0]!).toBeGreaterThan(0.03);
    expect(h[1]!).toBeGreaterThan(1.5 * h[0]!);
    expect(h[2]!).toBeGreaterThan(h[1]!);
    for (let r = 3; r < rows - 1; r++) expect(h[r]!).toBeGreaterThan(0.15);
  });

  it.each([
    ['the default board', 12, null],
    ['a desktop plate', 12, boardFor(480, 600, 12, 500)],
    ['three rows on a desktop plate', 3, boardFor(480, 600, 3, 5_000)],
    ['sixteen rows on a phone', 16, boardFor(360, 480, 16, 5_000)],
    // The narrowest plate the layout serves at the most rows the control
    // offers: contact radius 0.31 pitch, the largest a ball meets.
    ['sixteen rows on the narrowest phone', 16, boardFor(320, 480, 16, 5_000)],
  ] as ReadonlyArray<[string, number, BoardPhysics | null]>)('never enters a peg on %s', (_, n, board) => {
    const balls = 60;
    const sim = make(21, { rows: n, p: 0.5, balls, dropRate: 1e6 });
    if (board) sim.setBoard(board);
    const C = sim.contact;
    const runs = trace(sim, balls, 0.25);
    let closest = Infinity;
    let samples = 0;
    for (const run of runs) {
      for (const s of run) {
        if (s.row >= n) continue;
        samples++;
        for (let r = Math.max(0, s.row - 2); r < Math.min(n, s.row + 2); r++) {
          for (let k = 0; k <= r; k++) {
            const d = Math.hypot(s.x - (k - r / 2), s.y - r * ASPECT);
            if (d < closest) closest = d;
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(10_000);
    expect(closest).toBeGreaterThanOrEqual(C - 1e-9);
  });

  it('settles with two damped bounces on the pile, exactly where the pile is painted', () => {
    const balls = 50;
    const board = boardFor(480, 600, rows, 500);
    const g = layoutBoard(480, 600, rows);
    const sim = make(13, { rows, p: 0.5, balls, dropRate: 1e6 });
    sim.setBoard(board);
    const runs = trace(sim, balls, 0.5);
    for (const run of runs) {
      const inBin = run.filter((s) => s.row === rows && s.y >= rows * ASPECT);
      expect(inBin.length).toBeGreaterThan(20);
      const last = inBin.at(-1)!;
      const slot = restSlot(board.cols, board.dotRadius, board.binDepth, last.stack);
      const restY = rows * ASPECT + slot.depth / board.pitch;
      // Never below its own resting place: the pile is a floor.
      for (const s of inBin) expect(s.y).toBeLessThanOrEqual(restY + 1e-9);
      // Up-turns inside the bin: the ball meets the pile, hops, meets it again.
      let ups = 0;
      for (let i = 1; i < inBin.length; i++) if (inBin[i - 1]!.vy > 0 && inBin[i]!.vy < 0) ups++;
      expect(ups).toBe(2);
      // And where it stops is the dot the renderer paints for that stack.
      const rest = sim.ball(run === runs[0] ? 0 : runs.indexOf(run));
      expect(rest.settled).toBe(true);
      expect(lateralToPx(g, rest.x)).toBeCloseTo(binCentreX(g, rest.bin) + slot.dx, 9);
      expect(progressToPy(g, rest.y)).toBeCloseTo(g.binTop + slot.depth, 9);
    }
  });

  it('counts a ball into its bin the moment it passes the mouth, and into the pile only once at rest', () => {
    const balls = 30;
    const sim = make(17, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 1);
    for (const run of runs) {
      const firstDone = run.findIndex((s) => s.done);
      expect(firstDone).toBeGreaterThan(0);
      const before = run[firstDone - 1]!;
      const at = run[firstDone]!;
      expect(before.y).toBeLessThan(rows * ASPECT);
      expect(at.y).toBeGreaterThanOrEqual(rows * ASPECT - 1e-9);
      for (const s of run) if (s.settled) throw new Error('a settled ball is not active');
    }
  });

  it('lets the renderer set the plate: gravity scales with the pitch and the contact radius with the pegs', () => {
    const sim = make(1, { rows, p: 0.5, balls: 1, dropRate: 1 });
    sim.setBoard({ pitch: 20, contact: 5, binDepth: 100, dotRadius: 2, cols: 5 });
    expect(sim.gravity).toBeCloseTo(GRAVITY_PX / 20, 12);
    expect(sim.contact).toBeCloseTo(0.25, 12);
  });
});

describe('galton geometry', () => {
  const sizes: ReadonlyArray<[number, number]> = [
    [800, 600],
    [360, 640],
    [1600, 400],
    [1280, 720],
  ];

  it.each([3, 12, MAX_ROWS])('fits %i rows and their bins inside every canvas', (rows) => {
    for (const [width, height] of sizes) {
      const g = layoutBoard(width, height, rows);
      expect(g.rows).toBe(rows);
      expect(g.pegSpacing).toBeGreaterThan(1);
      expect(g.releaseY).toBeGreaterThanOrEqual(0);
      expect(g.binTop).toBeGreaterThan(g.originY);
      expect(g.binBottom).toBeGreaterThan(g.binTop);
      expect(g.binBottom).toBeLessThan(height);

      for (let r = 0; r < rows; r++) {
        for (let i = 0; i <= r; i++) {
          const { x, y } = pegPosition(g, r, i);
          expect(x - g.pegRadius).toBeGreaterThanOrEqual(0);
          expect(x + g.pegRadius).toBeLessThanOrEqual(width);
          expect(y).toBeGreaterThan(g.releaseY);
          expect(y).toBeLessThan(g.binTop);
        }
        // Row r is symmetric about the centre line.
        const first = pegPosition(g, r, 0).x;
        const last = pegPosition(g, r, r).x;
        expect(first + last).toBeCloseTo(2 * g.originX, 6);
      }

      const half = g.pegSpacing / 2;
      expect(binCentreX(g, 0) - half).toBeGreaterThanOrEqual(0);
      expect(binCentreX(g, rows) + half).toBeLessThanOrEqual(width);
    }
  });

  it('maps lattice units onto the pegs and bins it laid out', () => {
    const g = layoutBoard(800, 600, 12);
    expect(progressToPy(g, -1)).toBeCloseTo(g.releaseY, 9);
    expect(progressToPy(g, 0)).toBeCloseTo(g.originY, 9);
    expect(progressToPy(g, 12)).toBeCloseTo(g.binTop, 9);
    for (let k = 0; k <= 12; k++) {
      expect(lateralToPx(g, k - 6)).toBeCloseTo(binCentreX(g, k), 9);
    }
    // Peg (r, k) sits at lateral k − r/2: exactly where a ball with k rights arrives.
    expect(pegPosition(g, 5, 2).x).toBeCloseTo(lateralToPx(g, 2 - 2.5), 9);
    expect(pegPosition(g, 5, 2).y).toBeCloseTo(progressToPy(g, 5), 9);
    // The same line continues into the bin: a depth below the mouth is
    // progress past `rows` in rows, with no second mapping to disagree.
    expect(progressToPy(g, 12 + 50 / g.rowSpacing)).toBeCloseTo(g.binTop + 50, 9);
  });

  it('keeps the lattice equilateral', () => {
    const g = layoutBoard(800, 600, 12);
    expect(g.rowSpacing / g.pegSpacing).toBeCloseTo(Math.sqrt(3) / 2, 9);
  });
});

describe('popcount32', () => {
  it('matches a bit-by-bit count', () => {
    const naive = (v: number): number => {
      let n = 0;
      for (let i = 0; i < 32; i++) if ((v >>> i) & 1) n++;
      return n;
    };
    const rng = createRng(3);
    for (const v of [0, 1, 0x80000000, 0xffffffff, 0xaaaaaaaa, 0x0f0f0f0f]) expect(popcount32(v)).toBe(naive(v));
    for (let i = 0; i < 1000; i++) {
      const v = (rng.next() * 0x100000000) >>> 0;
      expect(popcount32(v)).toBe(naive(v));
    }
  });
});

describe('galton viz metadata', () => {
  it('has the permanent id, the randomness group, and a budget the balls slider respects', () => {
    expect(galton.id).toBe('galton');
    expect(galton.group).toBe('randomness');
    expect(galton.budget).toEqual({ maxEntities: 5_000 });
    const balls = galton.params.find((p) => p.key === 'balls');
    expect(balls?.kind).toBe('range');
    if (balls?.kind === 'range') {
      expect(balls.min).toBe(1);
      expect(balls.max).toBe(5_000);
      expect(balls.default).toBe(500);
      expect(balls.log).toBe(true);
    }
    const rows = galton.params.find((p) => p.key === 'rows');
    if (rows?.kind === 'int') {
      expect(rows.min).toBe(3);
      expect(rows.max).toBe(16);
      expect(rows.max).toBeLessThanOrEqual(MAX_ROWS);
      expect(rows.default).toBe(12);
    } else throw new Error('rows must be an int param');
  });

  it('offers exactly two controls; the seed is a spec the rail never renders, so a permalink can carry it', () => {
    // The rail skips `kind: 'seed'` (ui/controls.ts) and coerceParams() drops
    // any URL key without a spec, so the seed has to be declared to survive
    // `#/galton?seed=7` and must be the only thing declared beyond the two.
    expect(galton.params.filter((p) => p.kind !== 'seed').map((p) => p.key)).toEqual(['rows', 'balls']);
    const seed = galton.params.find((p) => p.key === 'seed');
    expect(seed?.kind).toBe('seed');
    if (seed?.kind === 'seed') expect(seed.default).toBe(42);
  });

  it('paces the stream to finish a run in about twelve seconds, between a trickle and a blur', () => {
    expect(dropRateFor(500)).toBeCloseTo(500 / 12, 9);
    expect(dropRateFor(5_000)).toBe(400);
    expect(dropRateFor(1)).toBe(2);
  });

  it('walks Story mode from one ball to sixteen rows', () => {
    expect(galton.presets?.map((p) => p.id)).toEqual([
      'one-ball',
      'a-hundred',
      'five-thousand',
      'three-rows',
      'sixteen-rows',
    ]);
    for (const preset of galton.presets ?? []) {
      // A caption is Prose now — a bare string, or the segments of a sentence
      // whose variables are marked for <var>. Measure the sentence, not the
      // segment count.
      expect(proseText(preset.caption).length).toBeGreaterThan(20);
      for (const key of Object.keys(preset.values)) {
        expect(galton.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
    }
  });

  it('sources every fact', () => {
    expect(galton.facts.length).toBeGreaterThanOrEqual(3);
    for (const fact of galton.facts) {
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });
});

/**
 * A canvas context that accepts every call and records nothing. The render
 * path is not what is under test here — the readouts are — but the readouts
 * come out of `draw()`, and a screen reader gets nothing else.
 */
function stubContext(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : () => undefined),
    set: (t, key, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function stubViz(params: Record<string, number | string | boolean>) {
  const emitted: Readout[][] = [];
  const ctx: VizContext = {
    layers: { background: stubContext(), foreground: stubContext() },
    width: 800,
    height: 600,
    rng: createRng(1),
    params,
    theme: {
      canvas: '#ffffff',
      ink: '#111111',
      inkMuted: '#666666',
      grid: '#cccccc',
      gridSoft: '#8a938f',
      data1: '#e34234',
      data2: '#1f77b4',
      data3: '#999999',
      data3Fill: '#d2d6d4',
      accent: '#ff9900',
      labelFont: '12px monospace',
      lineWidth: 1,
      particleRadius: 3,
    },
    emit: (readouts) => {
      emitted.push([...readouts]);
    },
    reducedMotion: false,
  };
  return { ctx, emitted, instance: galton.create(ctx) };
}

/** Run until every ball has landed, then return the last published ledger by key. */
function runViz(instance: VizInstance, emitted: Readout[][], balls: number): Record<string, Readout> {
  for (let i = 0; i < 100_000; i++) {
    instance.step(TICK);
    if (i % 60 !== 59) continue;
    instance.draw();
    const last = emitted.at(-1)!;
    const by = Object.fromEntries(last.map((r) => [r.key, r]));
    if ((by['landed']?.value ?? 0) >= balls) return by;
  }
  throw new Error(`no ${balls} landings after 100,000 ticks`);
}

describe('galton viz instance', () => {
  const defaults = { rows: 12, balls: 500, seed: 42 };

  it('publishes every number it draws, with the binomial targets, and identically for the same seed', () => {
    const a = stubViz({ ...defaults });
    const b = stubViz({ ...defaults });
    for (const v of [a, b]) {
      v.instance.drawBackground?.();
      for (let i = 0; i < 360; i++) v.instance.step(TICK);
      v.instance.draw();
    }
    const last = a.emitted.at(-1)!;
    expect(last.map((r) => r.key)).toEqual(['landed', 'mean', 'variance', 'tallest', 'mode', 'bins']);
    const by = Object.fromEntries(last.map((r) => [r.key, r]));
    expect(by['landed']!.value).toBeGreaterThan(0);
    expect(by['mean']!.target).toBe(6);
    expect(by['variance']!.target).toBe(3);
    expect(by['bins']!.value).toBe(13);
    expect(by['tallest']!.value).toBeGreaterThan(0);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('tells a newcomer which number to read, in plain words, and keeps the internals for the expert table', () => {
    const { instance, emitted } = stubViz({ ...defaults });
    instance.draw();
    const by = Object.fromEntries(emitted.at(-1)!.map((r) => [r.key, r]));
    // The precise labels stay: they are what the expert table and the tests read.
    expect(by['mean']!.label).toBe('Mean bin');
    expect(by['landed']!.label).toBe('Balls landed');
    expect(by['mean']!.headline).toBe(true);
    expect(by['mean']!.plain).toBe('average landing spot');
    // No hint: the verdict under the hero already prints "matches the
    // prediction of 6", so a hint quoting it again says the same thing twice.
    expect(by['mean']!.hint).toBeUndefined();
    expect(by['landed']!.plain).toBe('balls landed');
    expect(emitted.at(-1)!.filter((r) => r.headline).length).toBe(1);
    for (const key of ['tallest', 'mode', 'bins']) expect(by[key]!.expertOnly).toBe(true);
    for (const key of ['landed', 'mean', 'variance']) expect(by[key]!.expertOnly).toBeUndefined();
  });

  it('replays the seed the parameters carry: seed 7 is a different pile from seed 42, and from itself it is the same', () => {
    const balls = 200;
    const run = (seed: number): Record<string, Readout> => {
      const { instance, emitted } = stubViz({ ...defaults, balls, seed });
      return runViz(instance, emitted, balls);
    };
    const seven = run(7);
    const again = run(7);
    const fortyTwo = run(42);
    const pile = (by: Record<string, Readout>) => ['mean', 'variance', 'tallest', 'mode'].map((k) => by[k]!.value);
    expect(pile(seven)).toEqual(pile(again));
    expect(pile(seven)).not.toEqual(pile(fortyTwo));
  });

  it('moves the prediction with the rows in force', () => {
    const { instance, emitted } = stubViz({ ...defaults, rows: 15 });
    instance.draw();
    const mean = emitted.at(-1)!.find((r) => r.key === 'mean')!;
    expect(mean.target).toBe(7.5);
    expect(mean.hint).toBeUndefined();
  });

  it('defers every control change to the shell: rows and balls are both a new experiment', () => {
    const { instance } = stubViz({ ...defaults });
    for (let i = 0; i < 240; i++) instance.step(TICK);
    instance.draw();
    expect(instance.onParamChange?.('rows', 8)).toBe(false);
    expect(instance.onParamChange?.('balls', 50)).toBe(false);
    expect(instance.onParamChange?.('seed', 7)).toBe(false);
  });

  it('draws without mutating the simulation and resets to an empty board', () => {
    const { emitted, instance } = stubViz({ ...defaults });
    for (let i = 0; i < 240; i++) instance.step(TICK);
    instance.draw();
    instance.draw();
    expect(emitted.at(-1)).toEqual(emitted.at(-2));
    instance.reset();
    instance.draw();
    const by = Object.fromEntries(emitted.at(-1)!.map((r) => [r.key, r.value]));
    expect(by['landed']).toBe(0);
    expect(by['tallest']).toBe(0);
    instance.destroy();
  });

  it('finishes the default run, five hundred balls, in about fourteen seconds of simulation', () => {
    const { instance, emitted } = stubViz({ ...defaults });
    let ticks = 0;
    for (; ticks < 100_000; ticks++) {
      instance.step(TICK);
      if (ticks % 12 !== 11) continue;
      instance.draw();
      const landed = emitted.at(-1)!.find((r) => r.key === 'landed')!.value;
      if (landed >= 500) break;
    }
    // Twelve seconds of stream plus one fall.
    expect(ticks / 120).toBeGreaterThan(12);
    expect(ticks / 120).toBeLessThan(15);
  });

  it('judges Variance against the sampling error of a variance, so a finished run sits inside its band', () => {
    // Two thousand balls, a run the slider allows. A variance estimated from n
    // samples has standard error SQRT((mu4 - sigma^4)/n), which for a pile this
    // close to normal is sigma^2*SQRT(2/n) - a relative error of SQRT(2/n),
    // 3.2% here, three times the ledger's old 1% default, which is why a
    // completed and statistically perfect run used to read "not yet converged".
    const balls = 2_000;
    const expected = 3 * Math.sqrt(2 / balls);
    let worst = 0;
    for (const seed of [1, 2, 3, 7, 42, 99]) {
      const { instance, emitted } = stubViz({ ...defaults, balls, seed });
      const variance = runViz(instance, emitted, balls)['variance']!;
      expect(variance.target).toBe(3);
      // One ball carries sigma^2*SQRT(2) of it, and the ledger divides by the
      // balls that have landed - not by the count the run was going to finish
      // on, which is what made this band a constant 424% of its own prediction
      // at the one-ball preset and 19% at the default 500. A band wider than
      // the quantity it judges cannot be missed by any pile the board could
      // produce, and this row was certifying agreement at 100% error.
      expect(variance.band).toEqual({ kind: 'sampled', sigma: 3 * Math.SQRT2, samples: balls });
      expect(variance.tolerance).toBeUndefined();
      const relative = Math.abs(variance.value - variance.target!) / variance.target!;
      expect(relative, `seed ${seed}`).toBeLessThanOrEqual(expected);
      worst = Math.max(worst, relative);
    }
    // Not a threshold wide enough to pass anything: it is under a tenth, and
    // most of these correct runs miss the 1% default it replaces.
    expect(expected).toBeLessThan(0.1);
    expect(worst).toBeGreaterThan(0.01);
  });

  it('narrows both bands as the balls land, from the balls in hand', () => {
    const { instance, emitted } = stubViz({ ...defaults, balls: 2_000 });
    const half = (key: string, at: number): number => {
      const band = emitted[at]?.find((r) => r.key === key)?.band;
      return band?.kind === 'sampled' ? (3 * band.sigma) / Math.sqrt(band.samples) : NaN;
    };
    // Part way through, deliberately: the two counts are only distinguishable
    // while the run is still going, and 900 ticks of a 167-a-second stream is
    // about 1,250 of the 2,000 balls asked for.
    for (let i = 0; i < 900; i++) {
      instance.step(TICK);
      if (i % 150 === 149) instance.draw();
    }
    const frames = emitted.length;
    expect(frames).toBeGreaterThan(3);
    const landed = emitted[frames - 1]?.find((r) => r.key === 'landed')?.value ?? 0;
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(2_000);
    for (const key of ['mean', 'variance']) {
      expect(half(key, 1), key).toBeGreaterThan(half(key, frames - 1));
      // 1/SQRT(n) of the balls in the slots, not of the balls the fader asked
      // for: the run is only part way through and the band says so.
      const sigma = key === 'mean' ? Math.sqrt(3) : 3 * Math.SQRT2;
      expect(half(key, frames - 1), key).toBeCloseTo((3 * sigma) / Math.sqrt(landed), 12);
    }
  });

  it('gives the headline a band the board can satisfy, and the span a landing can occupy', () => {
    // The ledger's 1% default sat at 0.77 standard errors of the default run,
    // failed by 42% of statistically perfect finished piles, and no setting of
    // the two faders brings the headline's own noise inside it: the best the
    // board can do is 3/SQRT(16*5000) = 1.06%. Three standard errors of a
    // Binomial(rows, 1/2) landing over the balls in hand is 3.87% at the
    // defaults, which is the honest resolution of the measurement and the
    // number the ledger's ceiling was chosen to admit.
    const balls = 500;
    const { instance, emitted } = stubViz({ ...defaults, balls });
    const mean = runViz(instance, emitted, balls)['mean']!;
    expect(mean.band).toEqual({ kind: 'sampled', sigma: Math.sqrt(3), samples: balls });
    expect(mean.tolerance).toBeUndefined();
    expect(mean.range).toEqual([0, 12]);
    const half = (3 * Math.sqrt(3)) / Math.sqrt(balls);
    expect(half / mean.target!).toBeCloseTo(0.0387, 4);
    expect(Math.abs(mean.value - mean.target!)).toBeLessThanOrEqual(half);
    // And the verdict the reader actually sees, from the one rule that writes it.
    expect(testable(mean)).toBe(true);
    expect(verdictOf(mean).state).toBe('agree');
  });

  it('says what one ball can show instead of settling for ever', () => {
    // One ball lands in one slot and the run is over: there is no pile to have
    // a shape, and no number of extra frames will produce one. The band is
    // honestly enormous - three standard deviations of a single landing - so
    // the ledger refuses the verdict, and the hero carries a sentence saying
    // why rather than a spinner implying that more waiting would help.
    const { instance, emitted } = stubViz({ ...defaults, balls: 1 });
    const mean = runViz(instance, emitted, 1)['mean']!;
    expect(mean.hint).toBeDefined();
    expect(mean.hint).toContain('one ball');
    // Never the prediction itself: the verdict line above is where a number
    // belongs, and a hint repeating it says the same thing twice.
    expect(mean.hint).not.toContain(String(mean.target));
    expect(testable(mean)).toBe(false);
    expect(verdictOf(mean).state).not.toBe('agree');

    // The sentence belongs to the one-ball run, not to the board: a run with a
    // pile to measure carries no hint, so nothing on the hero moves as the
    // balls come down.
    const many = stubViz({ ...defaults, balls: 500 });
    many.instance.draw();
    expect(many.emitted.at(-1)!.find((r) => r.key === 'mean')!.hint).toBeUndefined();
  });
});

describe('pileMetrics', () => {
  /** The presets, plus the defaults, as (rows, p, balls) triples. */
  const configs: ReadonlyArray<[number, number, number]> = [
    [12, 0.5, 500],
    ...(galton.presets ?? []).map(
      (preset) =>
        [
          typeof preset.values['rows'] === 'number' ? preset.values['rows'] : 12,
          0.5,
          typeof preset.values['balls'] === 'number' ? preset.values['balls'] : 500,
        ] as [number, number, number],
    ),
  ];
  const sizes: ReadonlyArray<[number, number]> = [
    [360, 640],
    [640, 480],
    [800, 600],
    [1280, 720],
  ];

  it('keeps the expected tallest pile inside the bin at every preset and canvas size', () => {
    for (const [rows, p, balls] of configs) {
      let pmax = 0;
      for (let k = 0; k <= rows; k++) pmax = Math.max(pmax, binomialPmf(rows, k, p));
      for (const [width, height] of sizes) {
        const g = layoutBoard(width, height, rows);
        const depth = g.binBottom - g.binTop;
        const pile = pileMetrics(g, p, balls, 3);
        const peak = balls * pmax * pile.unit;
        // The scale is derived so the expected peak lands at depth/HEADROOM =
        // depth/1.15. The tallest bin fluctuates about balls·pmax with SD
        // √(balls·pmax(1−pmax)) — under 4% of it at 5,000 balls — so anything
        // at or under `depth` here never clips against the bin mouth in play.
        expect(peak, `rows ${rows}, p ${p}, balls ${balls} at ${width}x${height}`).toBeLessThanOrEqual(depth);
      }
    }
  });

  it('still fills the bin it is protecting, and keeps the dot grid inside the bin width', () => {
    // The ceiling above must not be bought by shrinking the pile to nothing:
    // once there are enough balls for the bin depth to be the binding
    // constraint, the expected peak sits at depth/HEADROOM ≈ 0.87·depth.
    for (const [rows, p, balls] of configs.filter(([, , n]) => n >= 5_000)) {
      let pmax = 0;
      for (let k = 0; k <= rows; k++) pmax = Math.max(pmax, binomialPmf(rows, k, p));
      for (const [width, height] of sizes) {
        const g = layoutBoard(width, height, rows);
        const pile = pileMetrics(g, p, balls, 3);
        const peak = balls * pmax * pile.unit;
        expect(peak, `rows ${rows}, balls ${balls} at ${width}x${height}`).toBeGreaterThan(
          0.6 * (g.binBottom - g.binTop),
        );
        // `cols` dots at a pitch of 2·radius must fit between the bin dividers.
        expect(pile.cols * 2 * pile.radius).toBeLessThanOrEqual(g.pegSpacing + 1e-12);
      }
    }
  });

  it('gives the bin band one scale: a row of dots is exactly `cols` balls of bar', () => {
    for (const [rows, p, balls] of configs) {
      for (const [width, height] of sizes) {
        const g = layoutBoard(width, height, rows);
        const pile = pileMetrics(g, p, balls, 3);
        const where = `rows ${rows}, p ${p}, balls ${balls} at ${width}x${height}`;
        // The dot pitch is derived from `unit`, so the dots cannot run at a
        // scale of their own while the bar, the silhouette, the binomial marks
        // and the normal curve run at another.
        expect(2 * pile.radius, where).toBeCloseTo(pile.cols * pile.unit, 12);
        expect(pile.radius, where).toBeGreaterThan(0);
        // A resting dot is never larger than a ball still in flight.
        expect(pile.radius, where).toBeLessThanOrEqual(3);
      }
    }
  });

  it('tops a pile out where its own bar does, and lands an arriving ball on it', () => {
    // Sixteen rows and five thousand balls on plates the live stage actually
    // gets: this is where the dot radius is smallest and the dot pitch and
    // the bin depth were once a factor of 1.67 apart — piles standing at 2.5×
    // their bar, and balls animating to a rest tens of pixels in mid-air.
    // `restSlot` is the one place a resting position comes from, for the
    // renderer's dots and for the pile the physics bounces a ball on.
    const stages: ReadonlyArray<[number, number]> = [
      [418, 522],
      [360, 640],
      [800, 600],
      [1280, 720],
    ];
    for (const [width, height] of stages) {
      const g = layoutBoard(width, height, 16);
      const pile = pileMetrics(g, 0.5, 5_000, 3);
      const depth = g.binBottom - g.binTop;
      const counts = [1, pile.cols, 4 * pile.cols, 371, pile.cap];
      for (const c of counts) {
        // The c-th arrival carries stack index c − 1.
        const slot = restSlot(pile.cols, pile.radius, depth, c - 1);
        const rest = g.binTop + slot.depth;
        const barTop = g.binBottom - c * pile.unit;
        const where = `${c} balls at ${width}x${height}`;
        // It comes to rest on the bar those c balls raise: the top row of the
        // grid straddles the bar top, so the centre is within one radius of it.
        expect(Math.abs(rest - barTop), where).toBeLessThanOrEqual(pile.radius + 1e-9);
        expect(rest, where).toBeGreaterThan(g.binTop);
        expect(Math.abs(slot.dx), where).toBeLessThanOrEqual(g.pegSpacing / 2);
        // A full grid of dots tops out on the bar exactly.
        if (c % pile.cols === 0) expect(rest - pile.radius, where).toBeCloseTo(barTop, 9);
      }
    }
  });

  it('leaves the normal overlay room for its peak, which outgrows the binomial mode below five rows', () => {
    // 1/(σ√2π) is 0.4606 at three rows against a mode of 0.375: headroom
    // reserved against the mode alone clipped the top of the bell into a flat
    // plateau, at the one row count where the pile is visibly not yet a bell.
    for (const rows of [3, 4, 5, 12, 16, MAX_ROWS]) {
      for (const balls of [500, 5_000]) {
        for (const [width, height] of sizes) {
          const g = layoutBoard(width, height, rows);
          const pile = pileMetrics(g, 0.5, balls, 3);
          const peak = balls * normalPdf(pile.mu, pile.mu, pile.sigma) * pile.unit;
          // draw() clamps the curve to the bin depth, so a peak that reaches
          // the clamp is a curve drawn with its top sawn off.
          expect(peak, `rows ${rows}, balls ${balls} at ${width}x${height}`).toBeLessThan(
            g.binBottom - g.binTop,
          );
        }
      }
    }
  });
});
