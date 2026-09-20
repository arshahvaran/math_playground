import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { Readout, VizContext, VizInstance } from '../src/core/types';
import { dropRateFor, galton, pileMetrics } from '../src/viz/galton/index';
import { binomialPmf, normalPdf } from '../src/core/stats';
import { proseText } from '../src/ui/dom';
import { snapToStep } from '../src/core/grid';
import { testable, verdictOf } from '../src/ui/readouts';
import {
  DEFAULT_BOARD,
  GRAVITY_PX,
  MAX_ROWS,
  PEG_RESTITUTION_MAX,
  PEG_RESTITUTION_MIN,
  STRIKE_MAX,
  STRIKE_MIN,
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

/** The ball ceiling the registry entry declares, mirrored here so both move together. */
const MAX_BALLS_EXPECTED = 5_000;

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
        // contact radius from a peg's centre, so that is the margin. The peg
        // it left is two rows up when the ball is sailing over a pin, which is
        // why the sim publishes the row rather than leaving it to be assumed.
        const f = b.fromRow;
        const to = popcount32(b.path & ((1 << b.row) - 1)) - b.row / 2;
        const from = f < 0 ? 0 : popcount32(b.path & ((1 << f) - 1)) - f / 2;
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
  /** The peg row this flight left: `row − 1`, or `row − 2` over a sailed-over pin. */
  fromRow: number;
  done: boolean;
  settled: boolean;
  path: number;
  bin: number;
  stack: number;
  /** Impact parameter of the contact this flight ends at, radians. */
  strike: number;
  /** How recently the ball hit something, 1 at contact and 0 once the squash has faded. */
  impact: number;
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
        t, x: b.x, y: b.y * ASPECT, vx: b.vx, vy: b.vy, row: b.row, fromRow: b.fromRow,
        done: b.done, settled: b.settled,
        path: b.path, bin: b.bin, stack: b.stack, strike: b.strike, impact: b.impact,
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
    // Arrival speeds are grouped by how far the flight fell, because a ball
    // that sailed over a pin has had two rows to accelerate and arrives faster.
    // Averaging the two together would hide both the plateau and the reason a
    // skip looks different on the plate.
    const arrival = Array.from({ length: rows }, () => [] as number[]);
    const overPin: number[] = [];
    const strike = Array.from({ length: rows }, () => [] as number[]);
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row !== prev.row && prev.row < rows) {
          const speed = Math.hypot(prev.vx, prev.vy);
          if (prev.row - prev.fromRow >= 2) overPin.push(speed);
          else arrival[prev.row]!.push(speed);
          strike[prev.row]!.push(cur.t);
        }
      }
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = arrival.map(mean);
    const t = strike.map(mean);
    // Measured on the default board, one-row arrivals only: 17.4, 20.7, 21.9,
    // 23.0 pitch/s, then 23.5 ± 0.6. The plateau is broader than the ± 0.1 of a
    // board where every ball fell one row at a time, because a ball that has
    // sailed over a pin arrives at 30 and leaves fast enough to still be quick
    // a row or two later. It is still flat: nothing accumulates down the plate.
    expect(v[1]!).toBeGreaterThan(v[0]! * 1.1);
    expect(v[2]!).toBeGreaterThan(v[1]!);
    expect(v[3]!).toBeGreaterThan(v[2]!);
    for (let r = 4; r < rows; r++) expect(Math.abs(v[r]! / v[3]! - 1)).toBeLessThan(0.06);
    // Two rows of falling instead of one, so the ball arrives half again as
    // fast: v² = 2gh with h doubled is √2, and the pin it left gave it a start.
    expect(overPin.length).toBeGreaterThan(50);
    expect(mean(overPin)).toBeGreaterThan(1.2 * v[rows - 1]!);
    // The row-to-row transit is not a fixed duration: the entry drop is the
    // shortest, and a ball reaches the twelfth row about 1.4 s after release —
    // quicker than the 1.6 s of a board that stopped at every row, because a
    // ball that sails over a pin spends no time bouncing on it.
    expect(t[1]! - t[0]!).toBeGreaterThan(t[0]!);
    expect(t[rows - 1]!).toBeGreaterThan(1_300);
    expect(t[rows - 1]!).toBeLessThan(1_600);
  });

  it('rebounds off every peg it meets upward and toward the side the route chose', () => {
    const balls = 100;
    const sim = make(5, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 1);
    let bounces = 0;
    let sailedOver = 0;
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row === prev.row || prev.row >= rows) continue;
        const s = (cur.path >>> prev.row) & 1 ? 1 : -1;
        expect(Math.sign(cur.vx), `ball path ${cur.path.toString(2)} row ${prev.row}`).toBe(s);
        expect(cur.vy).toBeLessThan(0);
        bounces++;
        // A flight of two rows passed a pin without touching it. The decision
        // that pin would have made was made anyway — it is in the route, drawn
        // at release — so the pins met plus the pins passed is still one per
        // row for every ball, which is what keeps the bins exactly binomial.
        sailedOver += cur.row - cur.fromRow - 1;
      }
    }
    expect(bounces + sailedOver).toBe(balls * rows);
    expect(sailedOver).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Variety — the complaint this rebuild answers
// ---------------------------------------------------------------------------

/** Population standard deviation. */
function sd(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length);
}

/** Every ball's impact parameter at each peg row, in release order. */
function strikesPerBall(runs: readonly Sample[][], rows: number): number[][] {
  return runs.map((run) => {
    const out: number[] = [];
    let seen = -1;
    for (const smp of run) {
      if (smp.row >= rows || smp.row <= seen) continue;
      seen = smp.row;
      out[smp.row] = smp.strike;
    }
    return out;
  });
}

describe('galton sim: every bounce is its own bounce', () => {
  const rows = 6;
  const balls = 400;

  it('strikes a different point of the shoulder every time, and never two the same', () => {
    // The complaint: "for right there is only one right path, and for left
    // there is only one left trajectory". It was true, and the cause was that
    // the impact parameter was solved rather than varied, so a ball arriving
    // at a peg by a given route always struck it in the same place and left
    // along the same arc. Here the collision is drawn, and the strike it
    // produces is compared *within a route* — balls that took exactly the same
    // left/right decisions through exactly the same pegs, which is the case
    // the old board rendered identically.
    const sim = make(23, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 0.5);
    const strikes = strikesPerBall(runs, rows);

    // Every strike a ball made is on the shoulder, and it made one at every
    // row it did not sail over — `strikesPerBall` leaves those rows empty, so
    // the count is the rows met rather than the rows there are.
    let met = 0;
    for (const perRow of strikes) {
      expect(perRow.length).toBe(rows);
      const made = [...perRow.keys()].filter((r) => perRow[r] !== undefined);
      expect(made.length).toBeGreaterThan(rows / 2);
      met += made.length;
      for (const r of made) {
        expect(perRow[r]!).toBeGreaterThanOrEqual(STRIKE_MIN - 1e-9);
        expect(perRow[r]!).toBeLessThanOrEqual(STRIKE_MAX + 1e-9);
      }
    }
    expect(met).toBeLessThan(balls * rows);

    // No two balls follow an identical arc: the sequence of impact parameters
    // is the arc's fingerprint — with the pins it passed marked, since which
    // pins a ball met is part of its arc — and all four hundred are distinct.
    const fingerprints = new Set(
      strikes.map((perRow) =>
        Array.from({ length: rows }, (_, r) => perRow[r]?.toFixed(9) ?? '-').join(' '),
      ),
    );
    expect(fingerprints.size).toBe(balls);

    // And the spread within one route is wide, not a rounding error. Measured
    // on this seed: 5 to 7 degrees of standard deviation per group, against a
    // band 41 degrees wide.
    let groups = 0;
    let worst = Infinity;
    for (const r of [1, 3, 5]) {
      const byRoute = new Map<number, number[]>();
      runs.forEach((run, i) => {
        const route = (run[0]?.path ?? 0) & ((1 << (r + 1)) - 1);
        const theta = strikes[i]?.[r];
        if (theta === undefined) return;
        const bucket = byRoute.get(route);
        if (bucket) bucket.push(theta);
        else byRoute.set(route, [theta]);
      });
      for (const angles of byRoute.values()) {
        if (angles.length < 8) continue;
        groups++;
        worst = Math.min(worst, sd(angles));
        expect(new Set(angles.map((t) => t.toFixed(9))).size).toBe(angles.length);
      }
    }
    expect(groups).toBeGreaterThan(10);
    // 0.03 rad is 1.7 degrees. The old board scored exactly zero here.
    expect(worst).toBeGreaterThan(0.03);
  });

  it('puts balls on one route in visibly different places at the same height', () => {
    // The same claim read off the picture rather than off the peg: where a
    // ball is when it crosses the middle of a row. Balls on the same route are
    // in the same corridor, so anything above zero here is arc variety.
    const sim = make(31, { rows, p: 0.5, balls, dropRate: 1e6 });
    const runs = trace(sim, balls, 0.5);
    const spreads: number[] = [];
    for (const r of [2, 4]) {
      const level = (r - 0.5) * ASPECT;
      const byRoute = new Map<number, number[]>();
      for (const run of runs) {
        const crossing = run.find((smp) => smp.row === r && smp.y >= level);
        if (!crossing) continue;
        const route = crossing.path & ((1 << (r + 1)) - 1);
        const bucket = byRoute.get(route);
        if (bucket) bucket.push(crossing.x);
        else byRoute.set(route, [crossing.x]);
      }
      for (const xs of byRoute.values()) {
        if (xs.length < 8) continue;
        expect(new Set(xs.map((x) => x.toFixed(9))).size).toBe(xs.length);
        spreads.push(sd(xs));
      }
    }
    expect(spreads.length).toBeGreaterThan(8);
    // Hundredths of a peg pitch, on a board whose pitch is tens of pixels.
    expect(Math.min(...spreads)).toBeGreaterThan(0.005);
  });

  it('gives back a different, plausible fraction of the speed at every peg', () => {
    // Complaint two: the impact was unconvincing. It is a real collision now —
    // the ball meets the peg's surface, the rebound is along the contact
    // normal, and the restitution is drawn per bounce inside a band a pin
    // could return. That is what makes one hop taller than the next.
    const sim = make(5, { rows: 12, p: 0.5, balls: 120, dropRate: 1e6 });
    const runs = trace(sim, 120, 0.25);
    const restitutions: number[] = [];
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row === prev.row || prev.row >= 12) continue;
        const s = (cur.path >>> prev.row) & 1 ? 1 : -1;
        const nx = s * Math.sin(prev.strike);
        const ny = -Math.cos(prev.strike);
        const into = prev.vx * nx + prev.vy * ny;
        const away = cur.vx * nx + cur.vy * ny;
        expect(into).toBeLessThan(0);
        expect(away).toBeGreaterThan(0);
        restitutions.push(away / -into);
      }
    }
    expect(restitutions.length).toBeGreaterThan(1000);
    // A 0.25 ms sample is taken a shade after the contact, so gravity has had
    // time to shave a little off: the window is the band plus that slack.
    const slack = 0.03;
    expect(Math.min(...restitutions)).toBeGreaterThan(PEG_RESTITUTION_MIN - slack);
    expect(Math.max(...restitutions)).toBeLessThan(PEG_RESTITUTION_MAX + slack);
    // And it really is drawn, not a constant with noise on it.
    expect(sd(restitutions)).toBeGreaterThan(0.04);
  });

  it('hops a visibly different height off the same peg', () => {
    const sim = make(8, { rows: 12, p: 0.5, balls: 120, dropRate: 1e6 });
    const runs = trace(sim, 120, 0.5);
    const hops: number[] = [];
    for (const run of runs) {
      let launchY = Number.NaN;
      let top = Number.NaN;
      let from = -1;
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!;
        const cur = run[i]!;
        if (cur.row !== prev.row) {
          if (from >= 1) hops.push(launchY - top);
          from = prev.row < 12 ? prev.row : -1;
          launchY = cur.y;
          top = cur.y;
        } else if (cur.y < top) {
          top = cur.y;
        }
      }
    }
    expect(hops.length).toBeGreaterThan(500);
    // Measured on the default board: 0.05 to 0.39 of a peg pitch. The point is
    // the ratio — the tallest hop is several times the shortest, which is what
    // stops the board reading as a mechanism.
    expect(Math.max(...hops) / Math.min(...hops)).toBeGreaterThan(3);
    expect(sd(hops)).toBeGreaterThan(0.02);
  });

  it('flies a true parabola between contacts, rather than being steered to its next peg', () => {
    // The flight carries a small constant lateral correction where the drawn
    // collision cannot quite reach the shoulder the route names. It has to stay
    // small, or the "physics" is a puppeteer: a correction near gravity would
    // be a ball on a wire.
    const sim = make(15, { rows: 12, p: 0.5, balls: 120, dropRate: 1e6 });
    const runs = trace(sim, 120, 0.5);
    const residual: number[] = [];
    for (const run of runs) {
      for (let i = 2; i < run.length; i++) {
        const a = run[i - 1]!;
        const b = run[i]!;
        if (a.row !== b.row || b.row >= 12) continue;
        residual.push(Math.abs((b.vx - a.vx) / ((b.t - a.t) / 1000)) / sim.gravity);
      }
    }
    residual.sort((x, y) => x - y);
    expect(residual.length).toBeGreaterThan(2000);
    // Measured: median 2% of gravity, ninetieth percentile 9%, never past 20%.
    expect(residual[Math.floor(residual.length / 2)]!).toBeLessThan(0.05);
    expect(residual[Math.floor(residual.length * 0.9)]!).toBeLessThan(0.15);
    expect(residual.at(-1)!).toBeLessThan(0.35);
  });

  it('marks a contact for the renderer to squash, and only a contact', () => {
    const sim = make(4, { rows: 8, p: 0.5, balls: 40, dropRate: 1e6 });
    const runs = trace(sim, 40, 0.5);
    for (const run of runs) {
      // The entry drop strikes nothing, so nothing is squashed on it.
      for (const smp of run) {
        expect(smp.impact).toBeGreaterThanOrEqual(0);
        expect(smp.impact).toBeLessThanOrEqual(1);
        if (smp.row === 0) expect(smp.impact).toBe(0);
      }
      // Every bounce leaves a mark that is strong when fresh and gone later.
      expect(run.filter((smp) => smp.impact > 0.5).length).toBeGreaterThan(3);
      expect(run.filter((smp) => smp.impact === 0).length).toBeGreaterThan(3);
    }
    sim.forEachBall((b) => {
      if (b.settled) expect(b.impact).toBe(0);
    });
  });
});

/**
 * The complaint this answers: "when the ball hits one of those gray dots, and
 * then it goes for the next one, it directly hits the other one without any
 * other path that it can go."
 *
 * It was true. Every flight ended on the pin in the very next row, so the only
 * thing that could differ between two balls was the shape of the hop, never
 * which pins it touched. A real board is not like that: a ball comes off a pin
 * flat, clears the next one and comes down a whole pitch across.
 *
 * What must not change while that becomes possible is the arithmetic. The
 * route is `rows` Bernoulli draws made at release, the landing bin is its
 * popcount, and a pin that is passed rather than struck has still made its
 * decision — so the bins stay exactly Binomial(rows, p). These tests hold both
 * ends of that: the motion varies, the statistics do not.
 */
describe('galton sim: a ball that sails over a pin', () => {
  const rows = 12;

  /** Every flight of every ball, as the rows it left and arrived at. */
  function flights(seed: number, n: number, board?: BoardPhysics): { from: number; to: number; path: number }[] {
    const sim = make(seed, { rows, p: 0.5, balls: n, dropRate: 1e6 });
    if (board) sim.setBoard(board);
    const out: { from: number; to: number; path: number }[] = [];
    const at = new Map<number, number>();
    while (sim.landed < n) {
      sim.step(1);
      sim.forEachActive((b, i) => {
        if (b.row >= rows || at.get(i) === b.row) return;
        at.set(i, b.row);
        out.push({ from: b.fromRow, to: b.row, path: b.path });
      });
    }
    return out;
  }

  it('covers one row, or two over a pin it passed, and never more', () => {
    const spans = new Map<number, number>();
    for (const f of flights(31, 120)) spans.set(f.to - f.from, (spans.get(f.to - f.from) ?? 0) + 1);
    expect([...spans.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    // The entry drop and every ordinary hop are the ones of span 1.
    expect(spans.get(2)!).toBeGreaterThan(50);
  });

  it('only sails when the route goes the same way twice, which is what puts the pin beside its path', () => {
    for (const f of flights(31, 120)) {
      if (f.to - f.from < 2) continue;
      const a = (f.path >>> f.from) & 1;
      const b = (f.path >>> (f.from + 1)) & 1;
      expect(a, `path ${f.path.toString(2)} rows ${f.from}..${f.to}`).toBe(b);
    }
  });

  it('is common enough to be seen and rare enough that the board still bounces', () => {
    // Every contact is a coin the route has to allow and the plate has to have
    // room for, so this is a band, not a number. Measured on the default plate
    // at twelve rows: about one flight in eight.
    const fs = flights(31, 120);
    const sailed = fs.filter((f) => f.to - f.from >= 2).length;
    expect(sailed / fs.length).toBeGreaterThan(0.05);
    expect(sailed / fs.length).toBeLessThan(0.3);
  });

  it('gives up on it where a plate has no room, rather than flying through a pin', () => {
    // Sixteen rows on the narrowest phone: a pin plus a ball is a third of the
    // pitch, and the corridor over a pin is not there to be flown. The board
    // does not insist — it takes the ordinary hop, and `never enters a peg`
    // above is what holds it to that.
    const tight = flights(31, 40, boardFor(320, 480, rows, 5_000));
    const roomy = flights(31, 40, boardFor(900, 700, rows, 5_000));
    const share = (fs: typeof tight) => fs.filter((f) => f.to - f.from >= 2).length / fs.length;
    expect(share(tight)).toBeLessThan(share(roomy));
  });

  it('leaves the bins exactly binomial: a pin passed still made its decision', () => {
    // The whole guarantee in one line. The routes are drawn at release and the
    // flight only shows them, so this is the same distribution the board had
    // when every ball touched every row.
    const balls = 20_000;
    const sim = make(4, { rows, p: 0.5, balls, dropRate: 1e6 });
    while (sim.landed < balls) sim.step(16);
    const n = sim.bins.reduce((a, b) => a + b, 0);
    expect(n).toBe(balls);
    let mean = 0;
    for (let k = 0; k <= rows; k++) mean += (k * (sim.bins[k] ?? 0)) / n;
    // Binomial(12, ½): mean 6, sd of the mean √(12·¼/20000) = 0.012.
    expect(mean).toBeCloseTo(6, 1);
  });

  it('decides it from the ball’s own stream, so the same seed sails over the same pins', () => {
    const a = flights(31, 60);
    const b = flights(31, 60);
    expect(b).toEqual(a);
    expect(flights(32, 60)).not.toEqual(a);
  });
});

describe('galton sim: the case around the board', () => {
  it.each([
    ['the default board', 12, null],
    ['a desktop plate', 12, boardFor(480, 600, 12, 500)],
    ['sixteen rows on the narrowest phone', 16, boardFor(320, 480, 16, 5_000)],
  ] as ReadonlyArray<[string, number, BoardPhysics | null]>)(
    'never lets a ball out of the case on %s',
    (_, n, board) => {
      // A real Galton board is a sealed case, and `drawBackground` now draws
      // one: two side walls half a bin outside the outer bins, a floor, and
      // the partitions between the bins. Nothing bounces off the walls because
      // nothing can reach them — the route can only carry a ball to the outer
      // bin's centre line — and this is the test that says so, rather than dead
      // code pretending to catch a ball that never arrives.
      const balls = 80;
      const sim = make(21, { rows: n, p: 0.5, balls, dropRate: 1e6 });
      if (board) sim.setBoard(board);
      const pitch = board?.pitch ?? DEFAULT_BOARD.pitch;
      const dot = (board?.dotRadius ?? DEFAULT_BOARD.dotRadius) / pitch;
      const ball = 3 / pitch;
      const wall = n / 2 + 0.5;
      const runs = trace(sim, balls, 0.5);
      let samples = 0;
      for (const run of runs) {
        for (const smp of run) {
          expect(Math.abs(smp.x) + ball).toBeLessThanOrEqual(wall);
          samples++;
        }
      }
      expect(samples).toBeGreaterThan(5_000);
      // And the pile that is left behind sits inside its own compartment.
      sim.forEachBall((b) => {
        expect(Math.abs(b.x) + dot).toBeLessThanOrEqual(wall + 1e-9);
        expect(Math.abs(b.x - (b.bin - n / 2)) + dot).toBeLessThanOrEqual(0.5 + 1e-9);
      });
    },
  );
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
      expect(balls.min).toBe(50);
      expect(balls.max).toBe(5_000);
      expect(balls.default).toBe(500);
      expect(balls.log).toBe(true);
      expect(balls.step).toBe(50);
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
    expect(last.map((r) => r.key)).toEqual(['landed', 'mean', 'meanBin', 'variance', 'tallest', 'mode', 'bins']);
    const by = Object.fromEntries(last.map((r) => [r.key, r]));
    expect(by['landed']!.value).toBeGreaterThan(0);
    // The headline is a z-score, so its prediction is exactly zero; the raw
    // mean it is built from keeps its own row in the table.
    expect(by['mean']!.target).toBe(0);
    expect(by['meanBin']!.target).toBe(6);
    expect(by['mean']!.value).toBeCloseTo((by['meanBin']!.value - 6) / Math.sqrt(3), 12);
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
    expect(by['mean']!.label).toBe('Mean landing, z');
    expect(by['meanBin']!.label).toBe('Mean bin');
    expect(by['landed']!.label).toBe('Balls landed');
    expect(by['mean']!.headline).toBe(true);
    expect(by['mean']!.plain).toBe('average landing spot, in standard deviations from the middle');
    // No hint: the verdict under the hero already prints "matches the
    // prediction of 6", so a hint quoting it again says the same thing twice.
    expect(by['mean']!.hint).toBeUndefined();
    expect(by['landed']!.plain).toBe('balls landed');
    expect(emitted.at(-1)!.filter((r) => r.headline).length).toBe(1);
    for (const key of ['meanBin', 'tallest', 'mode', 'bins']) expect(by[key]!.expertOnly).toBe(true);
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
    const last = emitted.at(-1)!;
    const mean = last.find((r) => r.key === 'mean')!;
    const meanBin = last.find((r) => r.key === 'meanBin')!;
    // The z-score predicts zero at every row count -- that is the point of it
    // -- so what moves with the rows is the span it can occupy and the bin
    // the raw mean is held to.
    expect(mean.target).toBe(0);
    expect(mean.range).toEqual([-7.5 / Math.sqrt(3.75), 7.5 / Math.sqrt(3.75)]);
    expect(meanBin.target).toBe(7.5);
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
      // One landing carries exactly one standard deviation once the reading is
      // a z-score; the variance still carries sigma^2*SQRT(2).
      const sigma = key === 'mean' ? 1 : 3 * Math.SQRT2;
      expect(half(key, frames - 1), key).toBeCloseTo((3 * sigma) / Math.sqrt(landed), 12);
    }
  });

  it('gives the headline a band the board can satisfy, and the span a landing can occupy', () => {
    // The headline is the average landing spot in standard deviations from the
    // middle, so the prediction is exactly 0 and one ball carries exactly one
    // standard deviation. Three standard errors is then 3/SQRT(n) -- the same
    // claim the raw mean used to make in bins, 3.87% of n*p at the defaults,
    // and the number the ledger's ceiling was chosen to admit.
    //
    // A prediction of zero is no scale of its own, so the reading has to
    // declare the span it can occupy or `readouts.ts` correctly refuses any
    // verdict at all. That span is the two edge slots in these units.
    const balls = 500;
    const { instance, emitted } = stubViz({ ...defaults, balls });
    const by = runViz(instance, emitted, balls);
    const mean = by['mean']!;
    expect(mean.target).toBe(0);
    expect(mean.band).toEqual({ kind: 'sampled', sigma: 1, samples: balls });
    expect(mean.tolerance).toBeUndefined();
    const span = 6 / Math.sqrt(3);
    expect(mean.range).toEqual([-span, span]);

    const half = 3 / Math.sqrt(balls);
    // Same width as the band the raw mean declares, read in bins.
    expect(half * Math.sqrt(3)).toBeCloseTo((3 * Math.sqrt(3)) / Math.sqrt(balls), 12);
    expect((half * Math.sqrt(3)) / 6).toBeCloseTo(0.0387, 4);
    expect(Math.abs(mean.value)).toBeLessThanOrEqual(half);
    // Narrow enough to be a test: a twentieth of the span a landing can reach.
    expect(half).toBeLessThan(0.05 * 2 * span);
    // And the verdict the reader actually sees, from the one rule that writes it.
    expect(testable(mean)).toBe(true);
    expect(verdictOf(mean).state).toBe('agree');
    expect(verdictOf(mean).text).toContain('0');
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

describe('galton controls and prose', () => {
  it('moves the Balls fader fifty at a time, and keeps the round counts every link is written in', () => {
    // The complaint: the fader crawled one ball at a time. A range parameter
    // lives on one grid -- `min + k*step`, in core/grid.ts, which the rail and
    // the router both read -- so the step and the minimum decide together
    // which counts are reachable at all. A step of 50 from a minimum of 1
    // would put them at 1, 51, 101 ..., and `#/galton?balls=100` would quietly
    // run 101 balls. Fifty from fifty keeps the round hundreds.
    const spec = galton.params.find((p) => p.key === 'balls');
    expect(spec?.kind).toBe('range');
    if (spec?.kind !== 'range') throw new Error('balls must be a range param');
    expect(spec.step).toBe(50);
    expect(spec.min).toBe(50);
    expect(spec.max).toBe(MAX_BALLS_EXPECTED);
    for (const count of [50, 100, 500, 1_000, 2_500, 5_000]) {
      expect(snapToStep(count, spec.min, spec.max, spec.step), `${count} balls`).toBe(count);
    }
    // Both ends are reachable exactly, which is what the fader's stops report.
    expect(snapToStep(spec.max, spec.min, spec.max, spec.step)).toBe(spec.max);
    expect(snapToStep(spec.default, spec.min, spec.max, spec.step)).toBe(spec.default);
    // A hundred steps of travel: enough to drag, few enough that a pixel of
    // wobble is not a new experiment.
    expect((spec.max - spec.min) / spec.step).toBe(99);
  });

  it('keeps One ball at one ball, below the fader floor on purpose', () => {
    // The chosen resolution of the two the owner offered: the floor stays at
    // fifty so the round counts survive, and the preset carries its own value
    // underneath it. A preset writes straight into the parameters, so the board
    // really does drop one ball; the fader simply shows its own floor while it
    // does.
    const one = galton.presets?.find((preset) => preset.id === 'one-ball');
    expect(one?.values['balls']).toBe(1);
    const spec = galton.params.find((p) => p.key === 'balls');
    if (spec?.kind !== 'range') throw new Error('balls must be a range param');
    for (const preset of galton.presets ?? []) {
      const value = preset.values['balls'];
      if (typeof value !== 'number' || preset.id === 'one-ball') continue;
      expect(snapToStep(value, spec.min, spec.max, spec.step), `preset ${preset.id}`).toBe(value);
    }
    // And it still runs: one ball, one route, one landing.
    const { instance, emitted } = stubViz({ rows: 12, balls: 1, seed: 42 });
    const by = runViz(instance, emitted, 1);
    expect(by['landed']!.value).toBe(1);
  });

  it('says what the tab is in words a newcomer reads without stopping', () => {
    // "Drops balls through a staggered lattice of pegs" was the complaint.
    const blurb = proseText(galton.blurb);
    expect(blurb).toContain('bell curve');
    for (const jargon of ['lattice', 'binomial', 'staggered', 'distribution']) {
      expect(blurb.toLowerCase(), `blurb still says "${jargon}"`).not.toContain(jargon);
    }
    // One or two sentences, and no sentence long enough to lose a reader.
    const sentences = blurb.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);
    expect(sentences.length).toBeLessThanOrEqual(2);
    for (const sentence of sentences) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(34);
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


