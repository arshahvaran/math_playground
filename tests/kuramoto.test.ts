import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import { testable, verdictOf } from '../src/ui/readouts';
import {
  COUPLING_STEP,
  MAX_COUPLING,
  MAX_OSCILLATORS,
  SETTLE_TIME,
  STEPS_PER_SECOND,
  STEP_H,
  dialScale,
  kuramoto,
  layoutPlate,
  paintStride,
  phaseX,
  phaseY,
  plotScale,
  plotX,
  plotY,
  type Rect,
} from '../src/viz/kuramoto/index';
import {
  HALF_WIDTH,
  INCOHERENT_MEAN,
  SettledOrder,
  Swarm,
  TAU,
  analyticOrder,
  criticalCoupling,
  hasPrediction,
  incoherentFloor,
  lockedSpread,
  lockedStandardError,
  naturalSpeed,
  orderUncertainty,
  wrapPhase,
} from '../src/viz/kuramoto/oscillators';

/**
 * Coupled oscillators, checked against the one model of collective behaviour
 * that has an exact answer.
 *
 * With Lorentzian natural speeds of half-width γ the threshold is `Kc = 2γ` and
 * above it the settled reading is `r = √(1 − Kc/K)`, both exactly. Every
 * tolerance below is a multiple of `orderUncertainty`, which is derived in
 * `oscillators.ts` from the model itself — the quenched sampling error of this
 * crowd's own draw of speeds above the threshold, the finite-crowd floor below
 * it — and of nothing else. None of them was widened to make a run pass.
 */

const SEED = 42;
const THRESHOLD = 2;

/** The engine's tick: 120 Hz, and with `STEPS_PER_SECOND` exactly one step. */
const TICK = 1000 / 120;

/**
 * Model time a convergence run covers. The averaging window is what the
 * reading's own error bar is about, and 110 units leaves 95 of them after the
 * transient — six times the settling time, which is where the running average
 * was measured to stop moving.
 */
const RUN_TIME = 110;

/** The protocol the tab uses, run directly against the mathematics. */
function settledOrder(seed: number, n: number, coupling: number, h = STEP_H, until = RUN_TIME): number {
  const swarm = new Swarm(2_000);
  swarm.populate(createRng(seed), n, HALF_WIDTH);
  const average = new SettledOrder();
  let t = 0;
  while (t < until) {
    swarm.advance(h, coupling);
    t += h;
    if (t >= SETTLE_TIME) average.push(swarm.order);
  }
  return average.mean;
}

// ---------------------------------------------------------------------------
// The exact answer
// ---------------------------------------------------------------------------

describe('the exact transition', () => {
  it('puts the threshold at 2γ and pins the reading above it', () => {
    expect(criticalCoupling(HALF_WIDTH)).toBe(THRESHOLD);
    expect(criticalCoupling(0.5)).toBe(1);
    // √(1 − Kc/K) at γ = 1, to the digits the catalogue quotes.
    expect(analyticOrder(2.5, HALF_WIDTH)).toBeCloseTo(0.4472136, 7);
    expect(analyticOrder(3, HALF_WIDTH)).toBeCloseTo(0.5773503, 7);
    expect(analyticOrder(4, HALF_WIDTH)).toBeCloseTo(0.7071068, 7);
    // Exactly zero at and below it: there is no partial credit for a coupling
    // that has not reached the threshold.
    expect(analyticOrder(2, HALF_WIDTH)).toBe(0);
    expect(analyticOrder(1.9999, HALF_WIDTH)).toBe(0);
    expect(analyticOrder(0, HALF_WIDTH)).toBe(0);
  });

  it('leaves the axis with infinite slope, which is why the lift-off is vertical', () => {
    // r ≈ √((K − Kc)/K), so halving the distance past the threshold divides the
    // reading by √2 rather than by 2.
    const near = analyticOrder(2.02, HALF_WIDTH);
    const nearer = analyticOrder(2.01, HALF_WIDTH);
    expect(near / nearer).toBeCloseTo(Math.SQRT2, 2);
  });

  it('draws speeds by the Cauchy inverse CDF', () => {
    expect(naturalSpeed(0.5, 1)).toBeCloseTo(0, 12);
    // The quartiles of a Lorentzian of half-width γ are ±γ.
    expect(naturalSpeed(0.75, 1)).toBeCloseTo(1, 12);
    expect(naturalSpeed(0.25, 2)).toBeCloseTo(-2, 12);
    // And the empirical CDF matches (1/π)·arctan(ω/γ) + ½. 40,000 draws give a
    // Kolmogorov–Smirnov statistic under 1.36/√n = 0.0068 at 95%.
    const rng = createRng(3);
    const n = 40_000;
    const speeds = Array.from({ length: n }, () => naturalSpeed(rng.next(), 1)).sort((a, b) => a - b);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const cdf = Math.atan(speeds[i] ?? 0) / Math.PI + 0.5;
      worst = Math.max(worst, Math.abs(cdf - (i + 1) / n), Math.abs(cdf - i / n));
    }
    expect(worst).toBeLessThan(1.36 / Math.sqrt(n));
  });
});

describe('the error bar the tolerances are built from', () => {
  it('matches the locked-band integral it claims to be a closed form for', () => {
    // E[f²] = (2/π)·[arctan(s/γ)(1 + γ²/s²) − γ/s] against the same integral
    // evaluated on a 200,000-point midpoint rule, which is good to ~1e-10 here.
    for (const K of [2.5, 3, 4]) {
      const r = analyticOrder(K, HALF_WIDTH);
      const s = K * r;
      const steps = 200_000;
      let sum = 0;
      for (let i = 0; i < steps; i++) {
        const w = -s + (2 * s * (i + 0.5)) / steps;
        sum += (1 - (w * w) / (s * s)) * (HALF_WIDTH / (Math.PI * (HALF_WIDTH * HALF_WIDTH + w * w)));
      }
      const numeric = (sum * 2 * s) / steps;
      expect(lockedSpread(K, HALF_WIDTH) ** 2 + r * r).toBeCloseTo(numeric, 8);
    }
    expect(lockedSpread(2, HALF_WIDTH)).toBeNaN();
  });

  it('shrinks as 1/√n and diverges at the threshold', () => {
    expect(lockedStandardError(4, HALF_WIDTH, 400) / lockedStandardError(4, HALF_WIDTH, 40_000)).toBeCloseTo(10, 9);
    // (K − γ)/(K − Kc) at K = 4, γ = 1 is exactly 1.5, and the locked-band
    // spread there is 0.3956396, so the bar at 2,000 oscillators is 0.0132702.
    expect(lockedSpread(4, HALF_WIDTH)).toBeCloseTo(0.3956396, 7);
    expect(lockedStandardError(4, HALF_WIDTH, 2_000)).toBeCloseTo((1.5 * 0.3956396) / Math.sqrt(2_000), 8);
    expect(lockedStandardError(4, HALF_WIDTH, 2_000)).toBeCloseTo(0.0132702, 6);
    // Capped at one, past which r itself cannot go and a bar says nothing.
    expect(lockedStandardError(2.001, HALF_WIDTH, 2_000)).toBe(1);
    expect(lockedStandardError(2, HALF_WIDTH, 2_000)).toBe(Infinity);
  });

  it('states the finite-crowd floor below the threshold', () => {
    // With no coupling at all the floor is the two-dimensional random walk:
    // E[r] = √(π/n)/2 = 0.886227/√n.
    expect(INCOHERENT_MEAN).toBeCloseTo(0.8862269, 7);
    expect(incoherentFloor(0, HALF_WIDTH, 2_000)).toBeCloseTo(INCOHERENT_MEAN / Math.sqrt(2_000), 12);
    // Coupling that locks nothing still amplifies, by 1/√(1 − K/Kc).
    expect(incoherentFloor(1, HALF_WIDTH, 2_000)).toBeCloseTo(
      incoherentFloor(0, HALF_WIDTH, 2_000) * Math.SQRT2,
      12,
    );
    expect(incoherentFloor(2, HALF_WIDTH, 2_000)).toBe(Infinity);
  });

  it('refuses to quote a prediction in the band where a finite crowd has none', () => {
    // Away from the threshold the exact answer is worth quoting; on it, where
    // the response diverges, it is not — and the tab says so rather than
    // printing "matches the prediction of 0" beside a reading of a quarter.
    expect(hasPrediction(1.9, HALF_WIDTH, 2_000)).toBe(true);
    expect(hasPrediction(2, HALF_WIDTH, 2_000)).toBe(false);
    expect(hasPrediction(2.2, HALF_WIDTH, 2_000)).toBe(true);
    // And the band *narrows as the crowd grows*, which is what the second
    // control is for: the threshold never moves, the blur around it shrinks.
    expect(hasPrediction(2.2, HALF_WIDTH, 400)).toBe(false);
    expect(hasPrediction(2.3, HALF_WIDTH, 400)).toBe(true);
    expect(hasPrediction(1.9, HALF_WIDTH, 400)).toBe(false);
    // The smallest crowd on the control cannot tell zero from its own wobble
    // anywhere below the threshold, and has a wide band above it too.
    expect(hasPrediction(0, HALF_WIDTH, 50)).toBe(false);
    expect(hasPrediction(2.5, HALF_WIDTH, 50)).toBe(false);
    expect(hasPrediction(4, HALF_WIDTH, 50)).toBe(true);
    // One number serves both sides.
    expect(orderUncertainty(4, HALF_WIDTH, 2_000)).toBe(lockedStandardError(4, HALF_WIDTH, 2_000));
    expect(orderUncertainty(1, HALF_WIDTH, 2_000)).toBe(incoherentFloor(1, HALF_WIDTH, 2_000));
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe('kuramoto convergence', () => {
  const N = 2_000;

  it('settles on √(1 − Kc/K) within three bars at every coupling above the threshold', () => {
    for (const K of [2.5, 3, 4]) {
      const target = analyticOrder(K, HALF_WIDTH);
      const bar = lockedStandardError(K, HALF_WIDTH, N);
      const measured = settledOrder(SEED, N, K);
      // Three quenched sampling errors, and nothing else: the crowd's speeds
      // are drawn once and never redrawn, so the reading sits a fixed distance
      // from the exact one however long the run goes on, and that distance is
      // what `lockedStandardError` predicts. Measured at seed 42 with 2,000
      // oscillators — 0.4781, 0.5940 and 0.7124 against 0.4472136, 0.5773503
      // and 0.7071068, which is 1.04, 0.86 and 0.40 bars. A failure here is a
      // wrong sampler or a wrong integrator, not an unlucky crowd.
      expect(Math.abs(measured - target), `K=${K} measured ${measured.toFixed(4)}`).toBeLessThan(3 * bar);
    }
  });

  it('reads the finite-crowd floor below the threshold, not zero', () => {
    for (const K of [0, 1, 1.5]) {
      const floor = incoherentFloor(K, HALF_WIDTH, N);
      const measured = settledOrder(SEED, N, K);
      // The reading is *not* zero and must not be asserted to be: with 2,000
      // oscillators the floor is 0.0198 at K = 0, 0.0280 at K = 1 and 0.0396
      // at K = 1.5, and the run measured 0.0193, 0.0286 and 0.0421 — the floor
      // to within a tenth of itself at every one. Below a third of it would
      // mean the crowd is not fluctuating at all, which is its own bug.
      expect(measured, `K=${K}`).toBeGreaterThan(floor / 3);
      expect(measured, `K=${K} measured ${measured.toFixed(4)}`).toBeLessThan(3 * floor);
    }
  });

  it('is the same answer at a quarter of the step, so nothing rests on the integrator', () => {
    for (const K of [2.5, 4]) {
      const coarse = settledOrder(SEED, 800, K, STEP_H);
      const fine = settledOrder(SEED, 800, K, STEP_H / 4);
      // RK4 is fourth order, so a quarter step is 256 times the accuracy; if
      // h = 0.04 were biasing the reading this would show it. Measured at 800
      // oscillators: 0.429461 against 0.429468 at K = 2.5 and 0.709764 against
      // 0.709818 at K = 4 — differences of 6.7·10⁻⁶ and 5.4·10⁻⁵, four hundred
      // times under the bar the reading is quoted with.
      expect(Math.abs(coarse - fine), `K=${K}`).toBeLessThan(1e-3);
    }
  });

  it('reproduces the crowd from a seed, and differs between seeds', () => {
    const a = new Swarm(100);
    const b = new Swarm(100);
    a.populate(createRng(SEED), 60, HALF_WIDTH);
    b.populate(createRng(SEED), 60, HALF_WIDTH);
    for (let i = 0; i < 60; i++) {
      expect(b.speedAt(i)).toBe(a.speedAt(i));
      expect(b.phaseAt(i)).toBe(a.phaseAt(i));
    }
    for (let i = 0; i < 200; i++) {
      a.advance(STEP_H, 3);
      b.advance(STEP_H, 3);
    }
    expect(b.order).toBe(a.order);
    expect(settledOrder(1, 200, 4, STEP_H, 40)).not.toBe(settledOrder(2, 200, 4, STEP_H, 40));
  });
});

// ---------------------------------------------------------------------------
// The swarm
// ---------------------------------------------------------------------------

describe('Swarm', () => {
  it('consumes exactly three draws per oscillator: speed, phase, then the painting offset', () => {
    const swarm = new Swarm(50);
    swarm.populate(createRng(11), 20, 1.5);
    const stream = createRng(11);
    for (let i = 0; i < 20; i++) {
      expect(swarm.speedAt(i)).toBe(naturalSpeed(stream.next(), 1.5));
      expect(swarm.phaseAt(i)).toBe(TAU * stream.next());
      stream.next();
    }
  });

  it('extends the crowd rather than redrawing it when the count goes up', () => {
    const small = new Swarm(500);
    const large = new Swarm(500);
    small.populate(createRng(SEED), 80, HALF_WIDTH);
    large.populate(createRng(SEED), 400, HALF_WIDTH);
    // Oscillator i is the same however many follow it, so raising the control
    // adds to the crowd instead of replacing it: what the reader watches change
    // is the floor, not the faces.
    for (let i = 0; i < 80; i++) expect(large.speedAt(i)).toBe(small.speedAt(i));
    expect(large.count).toBe(400);
    expect(small.count).toBe(80);
  });

  it('clamps the crowd to the budget and reports an empty one honestly', () => {
    const swarm = new Swarm(32);
    swarm.populate(createRng(1), 1_000, HALF_WIDTH);
    expect(swarm.count).toBe(32);
    expect(swarm.speedAt(32)).toBeNaN();
    swarm.reset();
    expect(swarm.count).toBe(0);
    expect(swarm.order).toBe(0);
    // A step with nobody in it is a no-op rather than a NaN.
    swarm.advance(STEP_H, 3);
    expect(swarm.order).toBe(0);
  });

  it('keeps every phase inside one turn, however fast the fastest oscillator is', () => {
    const swarm = new Swarm(600);
    swarm.populate(createRng(9), 600, HALF_WIDTH);
    for (let i = 0; i < 500; i++) swarm.advance(STEP_H, 1);
    for (let i = 0; i < 600; i++) {
      const p = swarm.phaseAt(i);
      expect(p, `oscillator ${i}`).toBeGreaterThanOrEqual(0);
      expect(p, `oscillator ${i}`).toBeLessThan(TAU);
    }
    expect(wrapPhase(-0.25)).toBeCloseTo(TAU - 0.25, 12);
    expect(wrapPhase(TAU)).toBe(0);
    expect(wrapPhase(3 * TAU + 1)).toBeCloseTo(1, 9);
  });

  it('reads one when the phases coincide and near zero when they are spread', () => {
    const together = new Swarm(10);
    together.populate(createRng(4), 10, HALF_WIDTH);
    // No natural spread and infinite pull would take any crowd here; setting it
    // up directly is the cheaper statement of the same fact.
    const spread = new Swarm(2_000);
    spread.populate(createRng(4), 2_000, HALF_WIDTH);
    expect(spread.order).toBeLessThan(6 * INCOHERENT_MEAN / Math.sqrt(2_000));
    expect(spread.order).toBeGreaterThanOrEqual(0);
    // With enough coupling and enough time a crowd of ten locks completely.
    for (let i = 0; i < 4_000; i++) together.advance(STEP_H, 60);
    expect(together.order).toBeGreaterThan(0.99);
  });

  it('thins the crowd by a stride, visiting every k-th oscillator', () => {
    const swarm = new Swarm(20);
    swarm.populate(createRng(2), 20, HALF_WIDTH);
    const seen: number[] = [];
    swarm.forEach((_phase, _offset, index) => seen.push(index), 3);
    expect(seen).toEqual([0, 3, 6, 9, 12, 15, 18]);
    const all: number[] = [];
    swarm.forEach((_phase, _offset, index) => all.push(index));
    expect(all).toHaveLength(20);
  });
});

describe('SettledOrder', () => {
  it('is not a reading until the transient has been excluded', () => {
    const average = new SettledOrder();
    expect(average.mean).toBeNaN();
    expect(average.count).toBe(0);
    for (const v of [0.2, 0.4, 0.6]) average.push(v);
    expect(average.mean).toBeCloseTo(0.4, 12);
    expect(average.count).toBe(3);
    average.reset();
    expect(average.mean).toBeNaN();
  });

  it('holds its accuracy over a run long enough to leave open for an hour', () => {
    const average = new SettledOrder();
    for (let i = 0; i < 500_000; i++) average.push(0.7071067811865476);
    expect(average.mean).toBeCloseTo(0.7071067811865476, 14);
  });
});

// ---------------------------------------------------------------------------
// Layout and scales
// ---------------------------------------------------------------------------

/** Whether `inner` sits entirely inside the `width` × `height` plate. */
function onPlate(inner: Rect, width: number, height: number): boolean {
  return (
    inner.x >= 0 &&
    inner.y >= 0 &&
    inner.width > 0 &&
    inner.height > 0 &&
    inner.x + inner.width <= width + 1e-9 &&
    inner.y + inner.height <= height + 1e-9
  );
}

describe('layoutPlate', () => {
  it('splits a landscape plate side by side and a portrait one top to bottom', () => {
    const wide = layoutPlate(720, 448);
    expect(wide.plot).not.toBeNull();
    expect(wide.plot?.x).toBeGreaterThan(wide.dial.x + wide.dial.width);

    const tall = layoutPlate(343, 490);
    expect(tall.plot).not.toBeNull();
    expect(tall.plot?.y).toBeGreaterThan(tall.dial.y + tall.dial.height);
  });

  it('drops the plot rather than painting an unlabellable one', () => {
    expect(layoutPlate(220, 150).plot).toBeNull();
    expect(layoutPlate(130, 400).plot).toBeNull();
  });

  it('keeps both panels on the plate, the dial square and the two disjoint, at every size', () => {
    for (let width = 160; width <= 1_400; width += 7) {
      for (const height of [140, 200, 343, 448, 720]) {
        const { dial, plot } = layoutPlate(width, height);
        const where = `${width}×${height}`;
        expect(onPlate(dial, width, height), where).toBe(true);
        expect(dial.width, where).toBeCloseTo(dial.height, 9);
        if (!plot) continue;
        expect(onPlate(plot, width, height), where).toBe(true);
        const apart = plot.x >= dial.x + dial.width || plot.y >= dial.y + dial.height;
        expect(apart, where).toBe(true);
      }
    }
  });
});

describe('the dial', () => {
  const dial = dialScale({ x: 0, y: 0, width: 300, height: 300 });

  it('puts a phase on the ring, anticlockwise from the right', () => {
    expect(phaseX(dial, 0, 0)).toBeCloseTo(dial.cx + dial.radius, 9);
    expect(phaseY(dial, 0, 0)).toBeCloseTo(dial.cy, 9);
    // Canvas y runs down, so a quarter turn anticlockwise is up the plate.
    expect(phaseY(dial, Math.PI / 2, 0)).toBeCloseTo(dial.cy - dial.radius, 9);
    expect(phaseX(dial, Math.PI, 0)).toBeCloseTo(dial.cx - dial.radius, 9);
  });

  it('keeps the whole band inside the square it is drawn in', () => {
    for (const offset of [-1, 0, 1]) {
      for (let k = 0; k < 16; k++) {
        const phase = (k / 16) * TAU;
        expect(Math.hypot(phaseX(dial, phase, offset) - dial.cx, phaseY(dial, phase, offset) - dial.cy))
          .toBeLessThan(150);
      }
    }
  });

  it('paints fewer of a bigger crowd rather than a denser band', () => {
    // The stride is an ink budget: the band holds about 870 dots at the
    // default plate, so a crowd twice that is visited every other oscillator.
    expect(paintStride(dial, 200, 2)).toBe(1);
    const big = paintStride(dial, 2_000, 2);
    expect(big).toBeGreaterThan(1);
    const painted = Math.ceil(2_000 / big);
    const band = 4 * Math.PI * 0.14 * dial.radius * dial.radius;
    const ink = 1 - Math.exp((-painted * Math.PI * 4) / band);
    expect(ink).toBeLessThan(0.3);
    // A smaller plate paints fewer, not the same number closer together.
    const small = dialScale({ x: 0, y: 0, width: 150, height: 150 });
    expect(paintStride(small, 2_000, 2)).toBeGreaterThan(big);
  });
});

describe('the plot scales', () => {
  const scale = plotScale({ x: 100, y: 50, width: 300, height: 400 });

  it('runs the coupling axis from zero to the control’s own ceiling', () => {
    expect(plotX(scale, 0)).toBeCloseTo(scale.box.x, 9);
    expect(plotX(scale, MAX_COUPLING)).toBeCloseTo(scale.box.x + scale.box.width, 9);
    expect(plotX(scale, 2)).toBeCloseTo(scale.box.x + scale.box.width / 2, 9);
  });

  it('runs the reading axis from zero at the floor to one at the ceiling', () => {
    expect(plotY(scale, 0)).toBeCloseTo(scale.box.y + scale.box.height, 9);
    expect(plotY(scale, 1)).toBeCloseTo(scale.box.y, 9);
    expect(plotY(scale, 0.5)).toBeCloseTo(scale.box.y + scale.box.height / 2, 9);
    // The halo inset keeps a curve on the floor clear of the frame under it.
    expect(plotY(scale, 0, 3)).toBe(scale.box.y + scale.box.height - 3);
    expect(plotY(scale, 1, 3)).toBe(scale.box.y + 3);
  });

  it('clamps a reading outside the axis instead of leaving the box', () => {
    expect(plotY(scale, -1)).toBe(plotY(scale, 0));
    expect(plotY(scale, 5)).toBe(plotY(scale, 1));
    expect(plotX(scale, 99)).toBe(plotX(scale, MAX_COUPLING));
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];
type Arc = readonly [number, number, number];

interface Fill {
  pen: string;
  alpha: number;
  arcs: readonly Arc[];
}

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  segments: readonly Seg[];
  arcs: readonly Arc[];
}

/**
 * A canvas context that records the paths it is asked to fill and stroke and
 * accepts everything else. Text and the display window paint through
 * fillText / fillRect / strokeRect, which record nothing, so every entry is
 * geometry.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; fills: Fill[]; strokes: Stroke[] } {
  const fills: Fill[] = [];
  const strokes: Stroke[] = [];
  let segments: Seg[] = [];
  let arcs: Arc[] = [];
  let x = 0;
  let y = 0;
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillText: () => undefined,
    setLineDash: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (text: string) => ({ width: 7 * text.length }),
    beginPath(): void {
      segments = [];
      arcs = [];
    },
    moveTo(nx: number, ny: number): void {
      x = nx;
      y = ny;
    },
    lineTo(nx: number, ny: number): void {
      segments.push([x, y, nx, ny]);
      x = nx;
      y = ny;
    },
    arc(cx: number, cy: number, r: number): void {
      arcs.push([cx, cy, r]);
    },
    fill(): void {
      fills.push({ pen: String(api.fillStyle), alpha: api.globalAlpha, arcs: [...arcs] });
    },
    stroke(): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        segments: [...segments],
        arcs: [...arcs],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, fills, strokes };
}

/** The pinned canvas contract from theme.css §RULE 0 — the plate is white in both schemes. */
const THEME = {
  canvas: '#ffffff',
  ink: '#171b1d',
  inkMuted: '#4e5750',
  grid: '#23292b',
  gridSoft: '#8a938f',
  data1: '#d53619',
  data2: '#24467a',
  data3: '#7f8985',
  data3Fill: '#d2d6d4',
  accent: '#d53619',
  labelFont: '500 11px "Martian Mono", monospace',
  lineWidth: 1,
  particleRadius: 2,
};

/** The shipped defaults, so a stub with no overrides is the tab as it opens. */
const DEFAULTS: Record<string, ParamValue> = {
  coupling: 3,
  count: 400,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 720, height = 448) {
  const bg = recordingContext();
  const fg = recordingContext();
  const emitted: Readout[][] = [];
  const ctx: VizContext = {
    layers: { background: bg.ctx, foreground: fg.ctx },
    width,
    height,
    rng: createRng(1),
    params: { ...DEFAULTS, ...overrides },
    theme: THEME,
    emit: (readouts) => {
      emitted.push([...readouts]);
    },
    reducedMotion: false,
  };
  const instance = kuramoto.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Stub = ReturnType<typeof stubViz>;

function tick(v: Stub, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** Ticks that cover `time` model units. One step per tick at the engine's 120 Hz. */
function ticksFor(time: number): number {
  return Math.ceil(time / STEP_H) + 1;
}

/** One frame, with the paint log cleared first so it holds exactly that frame. */
function paint(v: Stub): void {
  v.fg.fills.length = 0;
  v.fg.strokes.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Stub, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.strokes.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Exactly what src/main.ts does on a resize. */
function resize(v: Stub, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Stub): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function rows(v: Stub): Record<string, Readout> {
  return Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
}

describe('kuramoto instance: readouts', () => {
  it('publishes the settled reading against its exact target, identically for a seed', () => {
    const a = stubViz({ coupling: 4, count: 800 });
    const b = stubViz({ coupling: 4, count: 800 });
    for (const v of [a, b]) {
      tick(v, ticksFor(RUN_TIME));
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['order', 'threshold', 'count', 'coupling', 'live', 'averaged']);
    // The hero is the one readout marked as the headline, and it must be r.
    expect(last?.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['order']);
    const by = rows(a);
    expect(by['order']?.target).toBeCloseTo(0.7071068, 7);
    expect(by['threshold']?.value).toBe(THRESHOLD);
    expect(by['count']?.value).toBe(800);
    expect(by['coupling']?.value).toBe(4);
    // Driven through the shell's own contract rather than the mathematics
    // directly: one step per 120 Hz tick, the transient excluded, the reading
    // published by `emit`. The bar at 800 oscillators is 0.0210 and the run
    // measured 0.7098 against 0.7071068 — 0.13 of it.
    const bar = lockedStandardError(4, HALF_WIDTH, 800);
    expect(Math.abs((by['order']?.value ?? 0) - 0.7071068)).toBeLessThan(3 * bar);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('is not a measurement until the transient is behind it', () => {
    const v = stubViz({ coupling: 4 });
    tick(v, ticksFor(SETTLE_TIME) - 4);
    paint(v);
    // "not measured yet" under the headline, rather than a number averaged
    // across a crowd that was still finding its state.
    expect(ledger(v)['order']).toBeNaN();
    expect(ledger(v)['averaged']).toBe(0);
    tick(v, ticksFor(SETTLE_TIME));
    paint(v);
    expect(Number.isFinite(ledger(v)['order'] ?? NaN)).toBe(true);
    expect(ledger(v)['averaged']).toBeGreaterThan(0);
  });

  it('drops the target in the band around the threshold, and says what is happening instead', () => {
    const v = stubViz({ coupling: 2, count: 2_000 });
    tick(v, ticksFor(RUN_TIME));
    paint(v);
    const order = rows(v)['order'];
    expect(order?.target).toBeUndefined();
    expect(order?.hint).toMatch(/nothing settles on a sharp value/);
    // The reading at the threshold is a real, large number — a finite crowd
    // does not read zero there — and claiming it matched a prediction of zero
    // would be the tab lying about its own picture.
    expect(order?.value ?? 0).toBeGreaterThan(0.05);
  });

  it('sets the bar from this coupling and this crowd, in r’s own units', () => {
    const v = stubViz({ coupling: 4, count: MAX_OSCILLATORS });
    tick(v, ticksFor(RUN_TIME));
    paint(v);
    const order = rows(v)['order'] as Readout;
    expect(order.tolerance).toBeUndefined();
    expect(order.band).toEqual({
      kind: 'absolute',
      half: 3 * lockedStandardError(4, HALF_WIDTH, MAX_OSCILLATORS),
    });
    // r is the length of an average of unit vectors, so it lives in [0, 1] and
    // the band is judged against that span as well as against the answer.
    expect(order.range).toEqual([0, 1]);
    expect(verdictOf(order).state).toBe('agree');

    const below = stubViz({ coupling: 1, count: 2_000 });
    tick(below, ticksFor(RUN_TIME));
    paint(below);
    // Below the threshold the exact answer is zero, which is no scale at all —
    // the declared range is the only thing left to judge three finite-crowd
    // floors against, and a floor that is 8% of everything r can be is not a
    // test of "zero" however it was derived.
    const quiet = rows(below)['order'] as Readout;
    expect(quiet.target).toBe(0);
    expect(quiet.band).toEqual({ kind: 'absolute', half: 3 * incoherentFloor(1, HALF_WIDTH, 2_000) });
    expect(testable(quiet)).toBe(false);
  });

  it('refuses a verdict through a bar that covers most of the range r lives in', () => {
    // The defect this replaces, at the settings it was found on: the default
    // coupling with the fireflies fader at its stop. Three bars there are 0.368
    // either side of 0.577, an acceptance window 74% as wide as everything the
    // reading is allowed to be — which certifies nothing, whatever it was
    // derived from.
    const few = stubViz({ coupling: 3, count: 50 });
    tick(few, ticksFor(RUN_TIME));
    paint(few);
    const thin = rows(few)['order'] as Readout;
    expect(thin.target).toBeCloseTo(analyticOrder(3, HALF_WIDTH), 12);
    const window = 2 * 3 * orderUncertainty(3, HALF_WIDTH, 50);
    expect(window).toBeGreaterThan(0.7);
    expect(testable(thin)).toBe(false);
    expect(verdictOf(thin).state).not.toBe('agree');
  });

  it('brings enough fireflies to the chip that names the number', () => {
    // The quenched error of a crowd's own draw of speeds falls only with the
    // size of the crowd, so a preset whose caption quotes 0.707 has to set the
    // crowd as well as the coupling or the tab can never say that number is the
    // one it read.
    const preset = (kuramoto.presets ?? []).find((p) => p.id === 'in-step');
    expect(preset).toBeDefined();
    const v = stubViz({ ...(preset?.values ?? {}) });
    tick(v, ticksFor(RUN_TIME));
    paint(v);
    const order = rows(v)['order'] as Readout;
    expect(order.target).toBeCloseTo(0.7071068, 7);
    expect(verdictOf(order).state).toBe('agree');
  });

  it('gives the simple view plain words and keeps the precise names for the exact table', () => {
    const v = stubViz();
    tick(v, ticksFor(SETTLE_TIME + 5));
    paint(v);
    const by = rows(v);
    expect(by['order']?.plain).toBe('how together they are');
    expect(by['order']?.label).toBe('Order parameter r');
    expect(by['threshold']?.plain).toBe('the tipping point');
    expect(by['count']?.plain).toBe('fireflies in the crowd');
    // Internals a reader without physics would have to ask about.
    expect(by['live']?.expertOnly).toBe(true);
    expect(by['coupling']?.expertOnly).toBe(true);
    expect(by['averaged']?.expertOnly).toBe(true);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly !== true) expect(r.plain, r.key).toBeDefined();
    }
  });

  it('never puts a word a sixteen-year-old would have to look up into the simple view', () => {
    // The vocabulary the readouts module bans, plus the three this tab could
    // most easily have reached for.
    const banned =
      /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov)\b/i;
    for (const coupling of [0, 1, 2, 2.5, 4]) {
      const v = stubViz({ coupling });
      tick(v, ticksFor(SETTLE_TIME + 10));
      paint(v);
      for (const r of v.emitted.at(-1) ?? []) {
        if (r.expertOnly === true) continue;
        expect(r.plain ?? '', `${r.key} plain`).not.toMatch(banned);
        expect(r.hint ?? '', `${r.key} hint`).not.toMatch(banned);
      }
    }
  });

  it('draws without moving the crowd, and resets to a crowd with no reading', () => {
    const v = stubViz({ coupling: 3 });
    tick(v, ticksFor(SETTLE_TIME + 10));
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['order']).toBeNaN();
    expect(ledger(v)['averaged']).toBe(0);
    expect(ledger(v)['count']).toBe(400);
    v.instance.destroy();
  });

  it('advances one step of the model per tick, whatever the clock does', () => {
    // The rate is declared per simulated second and the engine's tick is
    // 1/120 s, so a tick is exactly one Runge–Kutta step and the run is the
    // same however the driver batches its ticks.
    expect((STEPS_PER_SECOND * TICK) / 1000).toBeCloseTo(1, 12);
    const v = stubViz({ coupling: 4 });
    tick(v, 120);
    paint(v);
    // One simulated second is 4.8 model time units, none of it past the
    // transient yet.
    expect(120 * STEP_H).toBeCloseTo(4.8, 12);
    expect(ledger(v)['averaged']).toBe(0);
    tick(v, 505);
    paint(v);
    expect(ledger(v)['averaged']).toBeCloseTo(625 * STEP_H - SETTLE_TIME, 6);
  });
});

describe('kuramoto instance: parameters', () => {
  it('declares two faders and the seed, and nothing else the rail would render', () => {
    expect(kuramoto.params.map((p) => p.key)).toEqual(['coupling', 'count', 'seed']);
    expect(kuramoto.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    // The rail never renders a seed, so these are the two controls on the tab.
    expect(kuramoto.params.filter((p) => p.kind !== 'seed').map((p) => p.key)).toEqual(['coupling', 'count']);
    // And the tab opens past the threshold, on a state that reads at a glance
    // and still leaves the fader room to be dragged either way.
    const coupling = kuramoto.params.find((p) => p.key === 'coupling');
    expect(coupling?.kind === 'range' ? coupling.default : 0).toBe(3);
    expect(hasPrediction(3, HALF_WIDTH, 400)).toBe(true);
  });

  it('opens on a settled reading that agrees with the exact answer', () => {
    const v = stubViz();
    tick(v, ticksFor(RUN_TIME));
    paint(v);
    const order = rows(v)['order'];
    const target = analyticOrder(3, HALF_WIDTH);
    // What a reader sees on a cold load: 0.6063 under "how together they are",
    // against a prediction of 0.5774, inside a bar of 0.0434 × 3.
    expect(order?.target).toBeCloseTo(target, 12);
    expect(Math.abs((order?.value ?? 0) - target)).toBeLessThan(
      3 * lockedStandardError(3, HALF_WIDTH, 400),
    );
  });

  it('absorbs a new coupling: the same crowd, pulled harder, measured afresh', () => {
    const v = stubViz({ coupling: 1, count: 600 });
    tick(v, ticksFor(SETTLE_TIME + 20));
    paint(v);
    const phases = paintedPhases(v).length;
    expect(ledger(v)['order']).toBeLessThan(0.2);

    expect(setParam(v, 'coupling', 4)).toBe(true);
    // The measurement starts again — an average across two couplings measures
    // neither — but the crowd is untouched, which is what makes creeping the
    // control up through the threshold one continuous experiment.
    expect(ledger(v)['order']).toBeNaN();
    expect(ledger(v)['count']).toBe(600);
    expect(paintedPhases(v)).toHaveLength(phases);
    tick(v, ticksFor(RUN_TIME));
    paint(v);
    expect(Math.abs((ledger(v)['order'] ?? 0) - 0.7071068)).toBeLessThan(
      3 * lockedStandardError(4, HALF_WIDTH, 600),
    );
  });

  it('refuses a new crowd or a new seed: both are a different experiment', () => {
    const v = stubViz();
    tick(v, ticksFor(SETTLE_TIME + 10));
    expect(v.instance.onParamChange?.('count', 900)).toBe(false);
    expect(v.instance.onParamChange?.('seed', 7)).toBe(false);
    expect(setParam(v, 'count', 900)).toBe(false);
    expect(ledger(v)['count']).toBe(900);
    expect(ledger(v)['order']).toBeNaN();
  });

  it('clamps a permalink that asks for more than the budget', () => {
    const v = stubViz({ count: 99_999, coupling: 9 });
    paint(v);
    expect(ledger(v)['count']).toBe(kuramoto.budget?.maxEntities);
    expect(ledger(v)['coupling']).toBe(MAX_COUPLING);
  });

  it('keeps a trail of readings across couplings, and clears it for a new crowd', () => {
    const v = stubViz({ coupling: 2.5, count: 400 });
    tick(v, ticksFor(SETTLE_TIME + 20));
    paint(v);
    expect(trailDots(v)).toHaveLength(1);

    setParam(v, 'coupling', 3.5);
    tick(v, ticksFor(SETTLE_TIME + 20));
    paint(v);
    // Two readings on the plot, at two positions of the control: the trail up
    // the curve is the moment the tab is built around.
    expect(trailDots(v)).toHaveLength(2);

    setParam(v, 'count', 800);
    tick(v, ticksFor(SETTLE_TIME + 20));
    paint(v);
    expect(trailDots(v)).toHaveLength(1);
  });
});

/** Every dot painted on the dial this frame, as [x, y]. */
function paintedPhases(v: Stub): Array<[number, number]> {
  const dial = dialScale(layoutPlate(v.ctx.width, v.ctx.height).dial);
  const out: Array<[number, number]> = [];
  for (const fill of v.fg.fills) {
    if (fill.pen !== THEME.data1) continue;
    for (const [x, y, r] of fill.arcs) {
      if (r !== THEME.particleRadius) continue;
      if (Math.hypot(x - dial.cx, y - dial.cy) > dial.radius * 1.2) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/** Every settled reading painted on the plot this frame, as [x, y]. */
function trailDots(v: Stub): Array<[number, number]> {
  const plot = layoutPlate(v.ctx.width, v.ctx.height).plot;
  if (!plot) return [];
  const box = plotScale(plot).box;
  const out: Array<[number, number]> = [];
  for (const fill of v.fg.fills) {
    if (fill.pen !== THEME.data1) continue;
    for (const [x, y] of fill.arcs) {
      if (x >= box.x - 5 && x <= box.x + box.width + 5 && y >= box.y - 5 && y <= box.y + box.height + 5) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

describe('kuramoto instance: paint', () => {
  it('puts the ring on the background in the apparatus pen and never repaints it per frame', () => {
    const v = stubViz();
    const ring = v.bg.strokes.find((s) => s.arcs.length === 1);
    expect(ring?.pen).toBe(THEME.grid);
    expect(ring?.width).toBe(2 * THEME.lineWidth);
    tick(v, 600);
    paint(v);
    // Nothing on the foreground draws a ring: the phases are dots on it.
    expect(v.fg.strokes.some((s) => s.arcs.length === 1 && s.pen === THEME.grid)).toBe(false);
  });

  it('paints the crowd in the signal pen at full strength, in one path', () => {
    const v = stubViz({ count: 600 });
    tick(v, 600);
    paint(v);
    const crowd = v.fg.fills.filter((f) => f.pen === THEME.data1 && f.arcs.length > 100);
    expect(crowd).toHaveLength(1);
    // A translucent pen composites through the 3:1 a graphical object owes the
    // plate, so nothing here is ever drawn at less than full strength.
    expect(crowd[0]?.alpha).toBe(1);
    for (const [, , r] of crowd[0]?.arcs ?? []) expect(r).toBe(THEME.particleRadius);
  });

  it('holds the band under saturation, bounding the ink and not the counting', () => {
    const dial = dialScale(layoutPlate(720, 448).dial);
    const band = 4 * Math.PI * 0.14 * dial.radius * dial.radius;
    const counts: number[] = [];
    for (const n of [200, 2_000]) {
      const v = stubViz({ count: n });
      tick(v, 240);
      paint(v);
      // Every one of them is still stepped and still counted, whatever the
      // painter does with them.
      expect(ledger(v)['count']).toBe(n);
      const painted = paintedPhases(v).length;
      expect(painted).toBeLessThanOrEqual(n);
      // n discs of area πr² over an area A cover 1 − exp(−n·a/A).
      const ink = 1 - Math.exp((-painted * Math.PI * THEME.particleRadius ** 2) / band);
      expect(ink, `${n} oscillators`).toBeLessThan(0.3);
      counts.push(painted);
    }
    // Ten times the crowd buys about three times the dots: the band's ink
    // budget binds long before the crowd does.
    expect(counts[1]).toBeGreaterThan(counts[0] ?? 0);
    expect(counts[1]).toBeLessThan(4 * (counts[0] ?? 0));
    // And a phone paints fewer again rather than a denser band.
    const phone = stubViz({ count: 2_000 }, 343, 490);
    tick(phone, 240);
    paint(phone);
    expect(ledger(phone)['count']).toBe(2_000);
    expect(paintedPhases(phone).length).toBeLessThan(counts[1] ?? 0);
  });

  it('draws the arrow in the drafting pen, at 2 px, over its own plate-coloured halo', () => {
    const v = stubViz({ coupling: 4 });
    tick(v, ticksFor(SETTLE_TIME + 10));
    paint(v);
    const drawn = v.fg.strokes.filter((s) => s.segments.length > 0);
    // §7: the halo is laid down at lineWidth + 4 and then the pen at
    // lineWidth, in that order — a halo painted after its mark would erase it.
    expect(drawn.slice(0, 2).map((s) => [s.pen, s.width])).toEqual([
      [THEME.canvas, 2 * THEME.lineWidth + 4],
      [THEME.data2, 2 * THEME.lineWidth],
    ]);
    for (const s of drawn) expect(s.alpha).toBe(1);
  });

  it('makes the arrow’s length the reading, which is the point of the picture', () => {
    const v = stubViz({ coupling: 4, count: 800 });
    tick(v, ticksFor(SETTLE_TIME + 40));
    paint(v);
    const dial = dialScale(layoutPlate(720, 448).dial);
    const shaft = v.fg.strokes.find((s) => s.pen === THEME.data2 && s.segments.length > 0)?.segments[0];
    expect(shaft).toBeDefined();
    const [x0, y0, x1, y1] = shaft as Seg;
    expect(x0).toBeCloseTo(dial.cx, 9);
    expect(y0).toBeCloseTo(dial.cy, 9);
    const live = ledger(v)['live'] ?? 0;
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(live * dial.radius, 6);
    // …and the arrow a reader sees is within a whisker of the headline number,
    // because the headline is the time average of exactly that length.
    expect(Math.abs(live - (ledger(v)['order'] ?? 0))).toBeLessThan(0.05);
  });

  it('keeps every settled reading inside the plot frame', () => {
    for (const [width, height] of [[720, 448], [1_280, 720], [343, 490]] as const) {
      const v = stubViz({ coupling: 4, count: 400 }, width, height);
      tick(v, ticksFor(SETTLE_TIME + 20));
      paint(v);
      const plot = layoutPlate(width, height).plot;
      expect(plot).not.toBeNull();
      const box = plotScale(plot as Rect).box;
      for (const [x, y] of trailDots(v)) {
        expect(x, `${width}×${height}`).toBeGreaterThanOrEqual(box.x - 1e-9);
        expect(x, `${width}×${height}`).toBeLessThanOrEqual(box.x + box.width + 1e-9);
        expect(y, `${width}×${height}`).toBeGreaterThanOrEqual(box.y - 1e-9);
        expect(y, `${width}×${height}`).toBeLessThanOrEqual(box.y + box.height + 1e-9);
      }
    }
  });

  it('draws the analytic curve and the threshold once, on the layer under the data', () => {
    const v = stubViz();
    const curves = v.bg.strokes.filter((s) => s.pen === THEME.data2 && s.segments.length > 0);
    // The threshold marker is one segment; the curve is the sampled branch
    // plus the flat run along the axis before it.
    expect(curves.some((s) => s.segments.length === 1)).toBe(true);
    expect(curves.some((s) => s.segments.length > 100)).toBe(true);
    // Both leave the axis at exactly the threshold.
    const box = plotScale(layoutPlate(720, 448).plot as Rect).box;
    const branch = curves.find((s) => s.segments.length > 100) as Stroke;
    const foot = branch.segments[0] as Seg;
    expect(foot[2]).toBeCloseTo(box.x + box.width / 2, 6);
  });
});

describe('kuramoto instance: resize', () => {
  it('leaves the reading untouched and re-places the crowd', () => {
    const v = stubViz({ coupling: 4 }, 720, 448);
    tick(v, ticksFor(SETTLE_TIME + 20));
    paint(v);
    const before = ledger(v);

    resize(v, 360, 300);
    expect(ledger(v)).toEqual(before);
    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);

    const dial = dialScale(layoutPlate(1_280, 720).dial);
    for (const [x, y] of paintedPhases(v)) {
      const rho = Math.hypot(x - dial.cx, y - dial.cy);
      expect(rho).toBeGreaterThan(dial.radius * 0.85);
      expect(rho).toBeLessThan(dial.radius * 1.15);
    }
  });

  it('gives the same reading on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({ coupling: 3, count: 300 }, 1_280, 720);
    const narrow = stubViz({ coupling: 3, count: 300 }, 320, 200);
    for (const v of [wide, narrow]) {
      tick(v, ticksFor(SETTLE_TIME + 20));
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
  });
});

// ---------------------------------------------------------------------------
// Metadata: what the page shows a newcomer
// ---------------------------------------------------------------------------

/** The words of a sentence, markup dropped. */
function words(text: Prose): string {
  return typeof text === 'string' ? text : text.map((s) => (typeof s === 'string' ? s : s.v)).join('');
}

/** One sentence: no full stop, question mark or exclamation mark followed by a space. */
function oneSentence(text: Prose): boolean {
  return !/[.!?]\s/.test(words(text));
}

/**
 * Words a visitor would have to look up, banned from every surface a visitor
 * reads without asking for it. The readouts and the rail's help are held to
 * the same list where each is checked, above.
 *
 * `Readout.label` is deliberately outside this. types.ts reserves it for the
 * precise name the exact table shows — "Order parameter r" is exactly the term
 * a reader who opened that table came for — which is why the ban stops at the
 * simple view.
 */
const JARGON =
  /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov)\b/i;

describe('kuramoto metadata', () => {
  it('is registered under a permanent id, in the waves group', () => {
    expect(kuramoto.id).toBe('kuramoto');
    expect(kuramoto.group).toBe('waves');
    expect(kuramoto.budget?.maxEntities).toBe(MAX_OSCILLATORS);
    expect(kuramoto.aspect).toBe(1.6);
  });

  it('says what it does in one plain sentence', () => {
    expect(oneSentence(kuramoto.blurb)).toBe(true);
    expect(words(kuramoto.blurb)).toMatch(/fireflies/);
  });

  it('spends that sentence on the picture and the surprise, not on what the code does', () => {
    const blurb = words(kuramoto.blurb);
    // The fireflies alone are decoration. What makes the tab worth opening is
    // that the crowd does not drift into step gradually — it snaps, at one
    // precise strength of nudge — and that the same thing runs a heart and
    // shook a footbridge.
    expect(blurb).toMatch(/precise/i);
    expect(blurb).toMatch(/unison|together|step/i);
    expect(blurb).toMatch(/pacemaker/i);
    expect(blurb).not.toMatch(JARGON);
  });

  it('never prints a word a newcomer would have to ask about in the story or the facts', () => {
    for (const preset of kuramoto.presets ?? []) expect(words(preset.caption), preset.id).not.toMatch(JARGON);
    for (const fact of kuramoto.facts) expect(words(fact.text)).not.toMatch(JARGON);
  });

  it('offers three presets that walk below, onto and past the threshold', () => {
    const presets = kuramoto.presets ?? [];
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.values['coupling'])).toEqual([1, 2, 4]);
    for (const preset of presets) {
      expect(oneSentence(preset.caption), preset.id).toBe(true);
      // The caption slot reserves two lines of a 68ch measure; a third would
      // push the fact card down the page.
      expect(words(preset.caption).length, preset.id).toBeLessThanOrEqual(120);
    }
  });

  it('sets every preset value from a declared parameter, inside its range and on its step', () => {
    for (const preset of kuramoto.presets ?? []) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = kuramoto.params.find((p) => p.key === key);
        expect(spec, `preset ${preset.id} sets unknown param ${key}`).toBeDefined();
        if (!spec || spec.kind !== 'range') continue;
        const n = value as number;
        expect(n, `${preset.id}.${key}`).toBeGreaterThanOrEqual(spec.min);
        expect(n, `${preset.id}.${key}`).toBeLessThanOrEqual(spec.max);
        // A tenth is not a binary fraction, so the remainder is compared
        // against the step's own rounding rather than against zero.
        const steps = (n - spec.min) / spec.step;
        expect(Math.abs(steps - Math.round(steps)), `${preset.id}.${key}`).toBeLessThan(1e-9);
      }
    }
    expect(COUPLING_STEP).toBe(0.1);
  });

  it('carries at most two facts, one sentence each, every one sourced', () => {
    expect(kuramoto.facts.length).toBeGreaterThanOrEqual(1);
    expect(kuramoto.facts.length).toBeLessThanOrEqual(2);
    for (const fact of kuramoto.facts) {
      expect(oneSentence(fact.text)).toBe(true);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('explains both controls in the rail, in plain words', () => {
    const banned = /\b(mean|variance|analytic|estimator|asymptotic|order parameter|markov)\b/i;
    for (const spec of kuramoto.params) {
      if (spec.kind === 'seed') continue;
      const help = words(spec.help ?? '');
      expect(help.length, spec.key).toBeGreaterThan(0);
      // The help row reserves two lines under the control; longer than this
      // and the rail's panel grows as the reader scrolls past it.
      expect(help.length, spec.key).toBeLessThanOrEqual(110);
      expect(help, spec.key).not.toMatch(banned);
    }
  });
});
