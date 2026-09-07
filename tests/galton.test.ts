import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { Readout, VizContext } from '../src/core/types';
import { galton, pileMetrics } from '../src/viz/galton/index';
import { binomialPmf } from '../src/core/stats';
import {
  MAX_ROWS,
  binCentreX,
  createSim,
  lateralToPx,
  layoutBoard,
  pegPosition,
  popcount32,
  progressToPy,
  type GaltonParams,
  type GaltonSim,
} from '../src/viz/galton/sim';

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

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
      expect(b.y).toBe(rows + 1);
      expect(b.path >>> rows).toBe(0);
      expect(b.bin).toBe(popcount32(b.path));
      expect(b.x).toBeCloseTo(b.bin - rows / 2, 6);
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
    let checked = 0;
    while (sim.landed < balls) {
      sim.step(TICK);
      sim.forEachActive((b) => {
        if (b.done) return;
        expect(b.y).toBeGreaterThanOrEqual(-1);
        expect(b.y).toBeLessThan(rows);
        if (b.y < 0) {
          expect(b.x).toBe(0);
          return;
        }
        const r = Math.floor(b.y);
        const from = popcount32(b.path & ((1 << r) - 1)) - r / 2;
        const to = from + ((b.path >>> r) & 1 ? 0.5 : -0.5);
        expect(b.x).toBeGreaterThanOrEqual(Math.min(from, to) - 1e-6);
        expect(b.x).toBeLessThanOrEqual(Math.max(from, to) + 1e-6);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('absorbs a drop-rate change without losing the balls already down, and resets on a row change', () => {
    const sim = make(42, { rows: 12, p: 0.5, balls: 500, dropRate: 400 });
    // A twelve-row fall takes about 1.2 s; two seconds guarantees landings.
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
    expect(galton.budget).toEqual({ maxEntities: 20_000 });
    const balls = galton.params.find((p) => p.key === 'balls');
    expect(balls?.kind).toBe('range');
    if (balls?.kind === 'range') expect(balls.max).toBe(20_000);
    const rows = galton.params.find((p) => p.key === 'rows');
    if (rows?.kind === 'int') expect(rows.max).toBe(MAX_ROWS);
    else throw new Error('rows must be an int param');
  });

  it('declares every parameter the contract needs, with a seed', () => {
    const keys = galton.params.map((p) => p.key);
    expect(keys).toEqual(['rows', 'p', 'balls', 'dropRate', 'showNormal', 'showBinomial', 'showTrails', 'seed']);
    expect(galton.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
  });

  it('walks Story mode from one ball to twenty rows', () => {
    expect(galton.presets?.map((p) => p.id)).toEqual([
      'one-ball',
      'a-hundred',
      'ten-thousand',
      'bias',
      'three-rows',
      'twenty-rows',
    ]);
    for (const preset of galton.presets ?? []) {
      expect(preset.caption.length).toBeGreaterThan(20);
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
      data1: '#e34234',
      data2: '#1f77b4',
      data3: '#999999',
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

describe('galton viz instance', () => {
  const defaults = { rows: 12, p: 0.5, balls: 500, dropRate: 400, showNormal: true, showBinomial: true, showTrails: true, seed: 42 };

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

  it('absorbs cosmetic and rate changes live and defers structural ones to the shell', () => {
    const { ctx, instance } = stubViz({ ...defaults });
    for (let i = 0; i < 240; i++) instance.step(TICK);
    instance.draw();
    // Mutate in place, as the shell does, then notify.
    const params = ctx.params as Record<string, number | string | boolean>;
    params['showNormal'] = false;
    expect(instance.onParamChange?.('showNormal', false)).toBe(true);
    params['dropRate'] = 10;
    expect(instance.onParamChange?.('dropRate', 10)).toBe(true);
    expect(instance.onParamChange?.('rows', 8)).toBe(false);
    expect(instance.onParamChange?.('p', 0.6)).toBe(false);
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
});

describe('pileMetrics', () => {
  /** The presets, plus the defaults, as (rows, p, balls) triples. */
  const configs: ReadonlyArray<[number, number, number]> = [
    [12, 0.5, 2_000],
    ...(galton.presets ?? []).map(
      (preset) =>
        [
          typeof preset.values['rows'] === 'number' ? preset.values['rows'] : 12,
          typeof preset.values['p'] === 'number' ? preset.values['p'] : 0.5,
          typeof preset.values['balls'] === 'number' ? preset.values['balls'] : 2_000,
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
        // √(balls·pmax(1−pmax)) — under 2% of it at 20,000 balls — so anything
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
});
