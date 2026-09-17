import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { agrees, testable, verdictOf } from '../src/ui/readouts';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import {
  DART_RATE,
  layoutPlate,
  montecarloPi,
  plotScale,
  plotX,
  plotY,
  type Rect,
} from '../src/viz/montecarlo-pi/index';
import {
  DartField,
  ErrorHistory,
  PI_SE_COEFFICIENT,
  P_INSIDE,
  estimatePi,
  piStandardError,
  throwDart,
} from '../src/viz/montecarlo-pi/estimate';

const SEED = 42;
const DARTS = 200_000;

/**
 * The standard error of the estimate at 200,000 darts: 1.642183/√200000 =
 * 0.0036720. Every tolerance below is a multiple of this and of nothing else.
 */
const SIGMA = PI_SE_COEFFICIENT / Math.sqrt(DARTS);

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

interface Run {
  field: DartField;
  history: ErrorHistory;
}

/**
 * `DARTS` throws from `seed`. The ring is deliberately far smaller than the
 * dart count: the statistics must keep counting after it wraps.
 */
function run(seed: number, budget = 1_000, darts = DARTS): Run {
  const rng = createRng(seed);
  const field = new DartField(budget);
  const history = new ErrorHistory();
  for (let i = 0; i < darts; i++) {
    field.push(throwDart(rng));
    history.sample(field.darts, field.inside);
  }
  return { field, history };
}

describe('montecarlo-pi convergence', () => {
  it('reaches Math.PI within 4σ at 200,000 darts', () => {
    const { field } = run(SEED);
    expect(field.darts).toBe(DARTS);
    expect(field.count).toBe(1_000);
    // 4σ = 4 × 0.0036720 = 0.014688. Not a tuned number: the estimator is
    // 4·p̂ with p̂ binomial, so this is the normal-approximation four-sigma
    // interval and a failure means the sampler is wrong, not unlucky.
    expect(SIGMA).toBeCloseTo(0.0036720, 7);
    const pi = estimatePi(field.inside, field.darts);
    expect(Math.abs(pi - Math.PI)).toBeLessThan(4 * SIGMA);
  });

  it('lands the inside fraction on π/4 within 4σ', () => {
    const { field } = run(SEED);
    // The fraction's own standard error is √(p(1−p)/n) = SIGMA/4.
    expect(Math.abs(field.inside / field.darts - P_INSIDE)).toBeLessThan(SIGMA);
  });

  it('keeps the measured error inside three envelopes for 95% of the sampled n', () => {
    const { history } = run(SEED);
    let inside = 0;
    let total = 0;
    let worst = 0;
    history.forEach((n, error) => {
      total++;
      const ratio = error / piStandardError(n);
      if (ratio <= 3) inside++;
      worst = Math.max(worst, ratio);
    });
    expect(total).toBeGreaterThan(100);
    // Per sampled n, |error| ≤ 3·SE holds with probability 0.9973 under the
    // normal approximation — but the samples are one path, not independent
    // draws, so the run is free to spend a stretch of decades outside. The law
    // of the iterated logarithm bounds those excursions at √(2·ln ln n)·SE,
    // which is 2.24 at n = 2·10⁵: below three, so an excursion past 3σ is
    // possible and must be rare. 95% of the sampled n is that "rare", and the
    // seed is fixed, so this either holds deterministically or the sampler is
    // wrong.
    expect(inside / total).toBeGreaterThanOrEqual(0.95);
  });

  it('reproduces the same darts and counts from the same seed, and differs between seeds', () => {
    const a = run(SEED, 500, 20_000);
    const b = run(SEED, 500, 20_000);
    expect(a.field.darts).toBe(b.field.darts);
    expect(a.field.inside).toBe(b.field.inside);
    expect(collect(a.field)).toEqual(collect(b.field));
    expect(samples(a.history)).toEqual(samples(b.history));
    expect(run(1, 500, 20_000).field.inside).not.toBe(run(2, 500, 20_000).field.inside);
  });
});

/** Every dart the field still holds, oldest first. */
function collect(field: DartField): Array<[number, number, boolean]> {
  const out: Array<[number, number, boolean]> = [];
  field.forEach((x, y, inside) => out.push([x, y, inside]));
  return out;
}

/** Every sample the history still holds, oldest first. */
function samples(history: ErrorHistory): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  history.forEach((n, error) => out.push([n, error]));
  return out;
}

describe('throwDart', () => {
  it('draws two uniforms in [−1, 1) and decides inside from them', () => {
    const rng = createRng(7);
    // Counted rather than asserted per dart: 40,000 expect() calls cost a
    // second, one comparison of a counter costs nothing.
    let outside = 0;
    let inconsistent = 0;
    for (let i = 0; i < 20_000; i++) {
      const d = throwDart(rng);
      if (d.x < -1 || d.x >= 1 || d.y < -1 || d.y >= 1) outside++;
      if (d.inside !== d.x * d.x + d.y * d.y <= 1) inconsistent++;
    }
    expect(outside).toBe(0);
    expect(inconsistent).toBe(0);
  });

  it('consumes exactly two draws per dart, x then y', () => {
    const a = createRng(11);
    const b = createRng(11);
    for (let i = 0; i < 1_000; i++) {
      const dart = throwDart(a);
      const x = -1 + 2 * b.next();
      const y = -1 + 2 * b.next();
      expect(dart.x).toBe(x);
      expect(dart.y).toBe(y);
    }
  });

  it('lands inside with probability π/4', () => {
    const rng = createRng(3);
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (throwDart(rng).inside) hits++;
    // SE of the fraction is √(p(1−p)/n) = 0.0013; 0.0052 is 4σ.
    expect(Math.abs(hits / n - P_INSIDE)).toBeLessThan(4 * Math.sqrt((P_INSIDE * (1 - P_INSIDE)) / n));
  });
});

describe('estimatePi', () => {
  it('is NaN before the first dart', () => {
    expect(estimatePi(0, 0)).toBeNaN();
    expect(estimatePi(0, -1)).toBeNaN();
  });

  it('recovers π exactly from the expected inside count', () => {
    expect(estimatePi(1_000 * P_INSIDE, 1_000)).toBeCloseTo(Math.PI, 12);
    expect(estimatePi(1, 1)).toBe(4);
    expect(estimatePi(0, 10)).toBe(0);
  });
});

describe('piStandardError', () => {
  it('is 4·√(p(1−p)/n) with p = π/4, the verified 1.64218/√n', () => {
    expect(PI_SE_COEFFICIENT).toBeCloseTo(1.6421834, 7);
    expect(piStandardError(1e3)).toBeCloseTo(0.051930, 6);
    expect(piStandardError(1e4)).toBeCloseTo(0.016422, 6);
    expect(piStandardError(1e5)).toBeCloseTo(0.0051930, 7);
    expect(piStandardError(1e6)).toBeCloseTo(0.0016422, 7);
  });

  it('shrinks as 1/√n — a hundred times the darts for one decimal place', () => {
    expect(piStandardError(1e3) / piStandardError(1e5)).toBeCloseTo(10, 12);
    // NaN, not Infinity: a standard error over no darts is a reading that does
    // not exist, and NaN is the sentinel the ledger already renders as "not
    // measured yet".
    expect(piStandardError(0)).toBeNaN();
    expect(piStandardError(-5)).toBeNaN();
  });
});

describe('DartField', () => {
  // Dyadic fractions, so they survive the Float32 round trip exactly.
  const dart = (i: number, inside: boolean): { x: number; y: number; inside: boolean } => ({
    x: i / 8,
    y: -i / 16,
    inside,
  });

  it('keeps only the newest `budget` darts but counts every throw', () => {
    const field = new DartField(5);
    for (let i = 0; i < 8; i++) field.push(dart(i, i % 2 === 0));
    expect(field.capacity).toBe(5);
    expect(field.count).toBe(5);
    expect(field.darts).toBe(8);
    expect(field.inside).toBe(4);
    expect(collect(field)).toEqual([3, 4, 5, 6, 7].map((i) => [i / 8, -i / 16, i % 2 === 0]));
  });

  it('visits oldest first with a chronological index, and skips from that end', () => {
    const field = new DartField(4);
    for (let i = 0; i < 4; i++) field.push(dart(i, false));
    const seen: number[] = [];
    field.forEach((x, _y, _inside, index) => {
      seen.push(index);
      expect(x).toBe(index / 8);
    }, 2);
    expect(seen).toEqual([2, 3]);
  });

  it('reset clears the darts and the counters', () => {
    const field = new DartField(4);
    for (let i = 0; i < 10; i++) field.push(dart(i, true));
    field.reset();
    expect(field.count).toBe(0);
    expect(field.darts).toBe(0);
    expect(field.inside).toBe(0);
    expect(collect(field)).toEqual([]);
  });

  it('never allocates below one slot', () => {
    const field = new DartField(0);
    field.push(dart(1, false));
    field.push(dart(2, true));
    expect(field.count).toBe(1);
    expect(field.darts).toBe(2);
    expect(field.inside).toBe(1);
  });
});

describe('ErrorHistory', () => {
  it('fits two million darts into a few hundred points, sampled by ratio', () => {
    const { history } = run(SEED, 100, 2_000_000);
    expect(history.count).toBeLessThanOrEqual(history.capacity);
    expect(history.count).toBeLessThan(320);
    expect(history.count).toBeGreaterThan(200);
    const ns = samples(history).map(([n]) => n);
    // Strictly increasing, starting at the first dart and ending at the last.
    expect(ns[0]).toBe(1);
    expect(ns.at(-1)).toBeGreaterThan(1_900_000);
    for (let i = 1; i < ns.length; i++) expect(ns[i]!).toBeGreaterThan(ns[i - 1]!);
    // 48 per decade above the point where the ratio step exceeds one dart, and
    // every dart below it.
    expect(ns.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const perDecade = (history.count - 20) / Math.log10(2_000_000 / 21);
    expect(perDecade).toBeGreaterThan(45);
    expect(perDecade).toBeLessThan(51);
  });

  it('records the error the estimate actually had at that dart count', () => {
    const rng = createRng(5);
    const field = new DartField(10);
    const history = new ErrorHistory();
    const want: Array<[number, number]> = [];
    for (let i = 0; i < 12; i++) {
      field.push(throwDart(rng));
      history.sample(field.darts, field.inside);
      want.push([field.darts, Math.abs(estimatePi(field.inside, field.darts) - Math.PI)]);
    }
    expect(samples(history)).toEqual(want);
  });

  it('wraps rather than growing, and reset restarts the gate', () => {
    const history = new ErrorHistory(4);
    for (let n = 1; n <= 4; n++) history.sample(n, n);
    expect(history.count).toBe(4);
    for (let n = 5; n <= 8; n++) history.sample(n, n);
    expect(history.count).toBe(4);
    expect(samples(history).map(([n]) => n)).toEqual([5, 6, 7, 8]);
    history.reset();
    expect(history.count).toBe(0);
    history.sample(1, 1);
    expect(history.count).toBe(1);
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
    const wide = layoutPlate(720, 448, true);
    expect(wide.plot).not.toBeNull();
    expect(wide.plot!.x).toBeGreaterThan(wide.field.x + wide.field.width);
    expect(wide.field.width).toBe(wide.field.height);

    const tall = layoutPlate(343, 490, true);
    expect(tall.plot).not.toBeNull();
    expect(tall.plot!.y).toBeGreaterThan(tall.field.y + tall.field.height);
    expect(tall.field.width).toBe(tall.field.height);
  });

  it('gives the field the whole plate when the plot is off', () => {
    const { field, plot } = layoutPlate(720, 448, false);
    expect(plot).toBeNull();
    // The largest centred square the plate holds, inside the margin.
    expect(field.width).toBe(448 - 16);
    expect(field.height).toBe(448 - 16);
    expect(field.x).toBeCloseTo((720 - field.width) / 2, 9);
  });

  it('drops the plot rather than painting an unlabellable one', () => {
    expect(layoutPlate(200, 160, true).plot).toBeNull();
    expect(layoutPlate(120, 400, true).plot).toBeNull();
  });

  it('keeps both panels on the plate, square and disjoint, at every size', () => {
    for (let width = 160; width <= 1_400; width += 7) {
      for (const height of [140, 200, 343, 448, 720]) {
        for (const showPlot of [true, false]) {
          const { field, plot } = layoutPlate(width, height, showPlot);
          const where = `${width}×${height} plot=${showPlot}`;
          expect(onPlate(field, width, height), where).toBe(true);
          expect(field.width, where).toBeCloseTo(field.height, 9);
          if (!plot) continue;
          expect(onPlate(plot, width, height), where).toBe(true);
          const apart =
            plot.x >= field.x + field.width || plot.y >= field.y + field.height;
          expect(apart, where).toBe(true);
        }
      }
    }
  });
});

describe('plot scales', () => {
  const area: Rect = { x: 100, y: 50, width: 300, height: 400 };

  it('runs the x axis from one dart to the whole run', () => {
    const s = plotScale(area, 1_000_000);
    expect(plotX(s, 1)).toBeCloseTo(s.box.x, 9);
    expect(plotX(s, 1_000_000)).toBeCloseTo(s.box.x + s.box.width, 9);
    // Equal ratios are equal travel: each decade is a sixth of the axis.
    expect(plotX(s, 1_000) - plotX(s, 100)).toBeCloseTo(s.box.width / 6, 9);
  });

  it('stops the y axis a decade under the envelope at the last dart', () => {
    const s = plotScale(area, 2_000_000);
    // SE(2e6) = 0.001161, so the floor is the decade below 1.161e-4.
    expect(s.errMin).toBeCloseTo(1e-4, 12);
    expect(plotY(s, 10)).toBeCloseTo(s.box.y, 9);
    expect(plotY(s, s.errMin)).toBeCloseTo(s.box.y + s.box.height, 9);
    expect(plotY(s, 1)).toBeGreaterThan(plotY(s, 10));
  });

  it('reads a zero error, and the NaN before the first dart, as the floor', () => {
    const s = plotScale(area, 1_000);
    expect(plotY(s, 0)).toBe(s.box.y + s.box.height);
    expect(plotY(s, NaN)).toBe(s.box.y + s.box.height);
    // With the halo inset, both stay clear of the frame they sit in.
    expect(plotY(s, 0, 3)).toBe(s.box.y + s.box.height - 3);
    expect(plotY(s, 1e9, 3)).toBe(s.box.y + 3);
  });

  it('makes the envelope a straight line: it is the point of the plot', () => {
    const s = plotScale(area, 1_000_000);
    const pts = [1, 100, 10_000, 1_000_000].map((n) => [plotX(s, n), plotY(s, piStandardError(n))]);
    for (let i = 2; i < pts.length; i++) {
      const [x0, y0] = pts[i - 2] as [number, number];
      const [x1, y1] = pts[i - 1] as [number, number];
      const [x2, y2] = pts[i] as [number, number];
      // Collinear: the slope is −½ decade of error per decade of darts.
      expect((y1 - y0) / (x1 - x0)).toBeCloseTo((y2 - y1) / (x2 - x1), 9);
    }
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
}

/**
 * A canvas context that records the paths it is asked to fill and stroke and
 * accepts everything else. Text and the display windows paint through
 * fillText/fillRect/strokeRect, which record nothing, so every entry is
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

/** The two parameters the tab declares: the one fader, and the seed the URL carries. */
const DEFAULTS: Record<string, ParamValue> = {
  darts: 100_000,
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
  const instance = montecarloPi.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Stub = ReturnType<typeof stubViz>;

function tick(v: Stub, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/**
 * Ticks that certainly reach a ceiling of `darts`. The rate is fixed at
 * `DART_RATE` per simulated second — 16.67 darts per 120 Hz tick — so an
 * exact count comes from the ceiling, not from the tick count; the margin
 * covers the fraction the accumulator carries between ticks.
 */
function ticksToReach(darts: number): number {
  return Math.ceil((darts * 1000) / (DART_RATE * TICK)) + 2;
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

/** Every dart painted in the last frame, as [x, y, radius, pen]. */
function paintedDarts(v: Stub): Array<[number, number, number, string]> {
  const out: Array<[number, number, number, string]> = [];
  for (const fill of v.fg.fills) {
    for (const [x, y, r] of fill.arcs) out.push([x, y, r, fill.pen]);
  }
  return out;
}

describe('montecarlo-pi instance: readouts', () => {
  it('publishes every number it draws, with the analytic target, identically for a seed', () => {
    const a = stubViz({ darts: 5_000 });
    const b = stubViz({ darts: 5_000 });
    for (const v of [a, b]) {
      tick(v, ticksToReach(5_000));
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['darts', 'inside', 'pi', 'error', 'se']);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['darts']?.value).toBe(5_000);
    // The hero is the one readout marked as the headline, and it must be π.
    expect(last?.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['pi']);
    expect(by['pi']?.target).toBe(Math.PI);
    // 5,000 darts: SE = 0.0232, so 0.093 is 4σ.
    expect(Math.abs((by['pi']?.value ?? 0) - Math.PI)).toBeLessThan(4 * piStandardError(5_000));
    expect(by['error']?.value).toBeCloseTo(Math.abs((by['pi']?.value ?? 0) - Math.PI), 12);
    expect(by['se']?.value).toBeCloseTo(piStandardError(5_000), 12);
    expect(by['inside']?.value).toBe(Math.round(((by['pi']?.value ?? 0) * 5_000) / 4));
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('gives the simple view plain words and keeps the precise names for the exact table', () => {
    const v = stubViz();
    tick(v, 12);
    paint(v);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(by['pi']?.plain).toBe('our estimate of pi');
    expect(by['pi']?.label).toBe('π estimate');
    expect(by['darts']?.plain).toBe('darts thrown');
    expect(by['inside']?.plain).toBe('landed in the circle');
    // Two error figures a reader without statistics would have to ask about.
    expect(by['error']?.expertOnly).toBe(true);
    expect(by['se']?.expertOnly).toBe(true);
    expect(by['se']?.label).toBe(`Std. error, ${PI_SE_COEFFICIENT.toFixed(2)}/√n`);
    // Everything that stays in the simple view has a plain label.
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly !== true) expect(r.plain, r.key).toBeDefined();
    }
  });

  it('takes the band from the darts thrown, not from the darts the fader asked for', () => {
    // One dart is a Bernoulli(pi/4) trial scaled by four, so it carries exactly
    // PI_SE_COEFFICIENT of standard deviation and the ledger's sigma/SQRT(n) is
    // piStandardError(n) itself - the reference line the plot draws.
    const v = stubViz({ darts: 1_000_000 });
    tick(v, 10);
    paint(v);
    const pi = v.emitted.at(-1)?.find((r) => r.key === 'pi');
    const darts = ledger(v)['darts'] ?? 0;
    expect(darts).toBeGreaterThan(0);
    expect(darts).toBeLessThan(1_000_000);
    expect(pi?.band).toEqual({ kind: 'sampled', sigma: PI_SE_COEFFICIENT, samples: darts });
    expect(pi?.tolerance).toBeUndefined();
    // Three standard errors at the darts in hand, which is the band the plot
    // has been drawing all along. Read at the count the run was going to reach
    // it would have been 0.00157 from the first dart onwards.
    expect((3 * PI_SE_COEFFICIENT) / Math.sqrt(darts)).toBeCloseTo(3 * piStandardError(darts), 12);
    expect((3 * piStandardError(1_000_000)) / Math.PI).toBeLessThan(0.002);
  });

  it('will not certify a hundred darts, and will certify a thousand', () => {
    // The finding, in one line: a band fixed at the run's final count was 16%
    // of pi at the hundred-dart stop of the fader, and 16% of pi certified a
    // printed 3.36000 under "matches the prediction of 3.14159". A twentieth of
    // pi needs about 980 darts and nothing below that can produce a verdict.
    const few = stubViz({ darts: 100 });
    tick(few, ticksToReach(100));
    paint(few);
    const short = few.emitted.at(-1)?.find((r) => r.key === 'pi');
    expect(ledger(few)['darts']).toBe(100);
    expect(testable(short!)).toBe(false);
    expect(verdictOf(short!).state).not.toBe('agree');
    // Not a claim about this seed's luck: no reading at all can be certified
    // through a band that wide, including one that is exactly right.
    expect(agrees({ ...short!, value: Math.PI })).toBe(false);

    const enough = stubViz({ darts: 10_000 });
    tick(enough, ticksToReach(10_000));
    paint(enough);
    const long = enough.emitted.at(-1)?.find((r) => r.key === 'pi');
    expect(ledger(enough)['darts']).toBe(10_000);
    expect(testable(long!)).toBe(true);
    expect(verdictOf(long!).state).toBe('agree');
  });

  it('publishes no reading that is a number only in the loosest sense', () => {
    // An estimate over no darts and a standard error over no darts are both
    // readings that do not exist yet. NaN is what the hero and the table
    // already render as an em dash; Infinity is a 40px claim that the answer is
    // unbounded, and it reached this list on the frame after every reset and
    // every parameter change.
    const v = stubViz();
    const frames = [
      () => paint(v),
      () => {
        tick(v, 60);
        paint(v);
      },
      () => {
        setParam(v, 'seed', 7);
      },
      () => {
        v.instance.reset();
        paint(v);
      },
    ];
    for (const frame of frames) {
      frame();
      for (const r of v.emitted.at(-1) ?? []) {
        expect(Number.isFinite(r.value) || Number.isNaN(r.value), `${r.key} = ${r.value}`).toBe(true);
        const band = r.band;
        if (band?.kind === 'absolute') {
          expect(Number.isFinite(band.half) || Number.isNaN(band.half), r.key).toBe(true);
        }
      }
    }
  });

  it('draws without mutating the simulation, and resets to an empty field', () => {
    const v = stubViz();
    tick(v, 500);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['darts']).toBe(0);
    expect(ledger(v)['inside']).toBe(0);
    expect(ledger(v)['pi']).toBeNaN();
    v.instance.destroy();
  });

  it('stops at the dart ceiling', () => {
    const v = stubViz({ darts: 1_000 });
    tick(v, 500);
    paint(v);
    expect(ledger(v)['darts']).toBe(1_000);
  });

  it('throws at the fixed rate: DART_RATE darts per simulated second', () => {
    const v = stubViz();
    // 120 ticks of 1/120 s. The accumulator may still owe a fraction of a
    // dart at the end of the second, so the count is the rate or one under.
    tick(v, 120);
    paint(v);
    const thrown = ledger(v)['darts'] ?? 0;
    expect(thrown).toBeGreaterThanOrEqual(DART_RATE - 1);
    expect(thrown).toBeLessThanOrEqual(DART_RATE);
  });
});

describe('montecarlo-pi instance: parameters', () => {
  /** The ledger of a fresh instance run to a ceiling of `darts`. */
  function fresh(darts: number): Record<string, number> {
    const v = stubViz({ darts });
    tick(v, ticksToReach(darts));
    paint(v);
    return ledger(v);
  }

  it('declares the fader and the seed, and nothing the rail would render besides the fader', () => {
    expect(montecarloPi.params.map((p) => p.key)).toEqual(['darts', 'seed']);
    expect(montecarloPi.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    // The rail never renders a seed, so this is the one control on the tab.
    expect(montecarloPi.params.filter((p) => p.kind !== 'seed').map((p) => p.key)).toEqual(['darts']);
  });

  it('absorbs a raised ceiling as a prefix continuation, identical to a fresh run', () => {
    const v = stubViz({ darts: 1_000 });
    tick(v, ticksToReach(1_000));
    paint(v);
    expect(ledger(v)['darts']).toBe(1_000);

    expect(setParam(v, 'darts', 5_000)).toBe(true);
    tick(v, ticksToReach(5_000));
    paint(v);
    expect(ledger(v)).toEqual(fresh(5_000));
  });

  it('resets on a ceiling below the darts already thrown, so the permalink stays honest', () => {
    const v = stubViz({ darts: 20_000 });
    tick(v, ticksToReach(20_000));
    paint(v);
    expect(ledger(v)['darts']).toBe(20_000);
    expect(setParam(v, 'darts', 1_000)).toBe(false);
    expect(ledger(v)['darts']).toBe(0);
    tick(v, ticksToReach(1_000));
    paint(v);
    expect(ledger(v)).toEqual(fresh(1_000));
  });

  it('defers the seed to the shell', () => {
    const v = stubViz();
    tick(v, 240);
    expect(v.instance.onParamChange?.('seed', 7)).toBe(false);
  });

  it('repaints the background itself when a raised ceiling moves the axis', () => {
    const v = stubViz({ darts: 1_000 });
    tick(v, ticksToReach(1_000));
    paint(v);
    const before = ledger(v);
    v.bg.strokes.length = 0;

    // The x axis spans the whole run, so a new ceiling is new static geometry
    // on the background layer — and the shell repaints that layer only for a
    // change the visualization refuses.
    expect(setParam(v, 'darts', 100_000)).toBe(true);
    expect(v.bg.strokes.length).toBeGreaterThan(0);
    // …and the run is untouched: that is the whole reason it absorbs.
    expect(ledger(v)).toEqual(before);
  });

  it('always draws the plot and its reference line: there is nothing to switch off', () => {
    const v = stubViz();
    tick(v, 240);
    paint(v);
    expect(v.fg.strokes.some((s) => s.pen === THEME.data2)).toBe(true);
    expect(v.fg.strokes.some((s) => s.pen === THEME.data1)).toBe(true);
  });
});

describe('montecarlo-pi instance: paint', () => {
  it('paints misses under hits, both at full strength, batched by colour', () => {
    const v = stubViz();
    tick(v, 2_000);
    paint(v);
    const fills = v.fg.fills.filter((f) => f.arcs.length > 0);
    expect(fills).toHaveLength(2);
    expect(fills[0]?.pen).toBe(THEME.inkMuted);
    expect(fills[1]?.pen).toBe(THEME.data1);
    for (const fill of fills) {
      // A translucent pen composites through the 3:1 a graphical object owes
      // the plate.
      expect(fill.alpha).toBe(1);
      for (const [, , r] of fill.arcs) expect(r).toBe(THEME.particleRadius);
    }
  });

  it('paints every dart inside the square, hits inside the circle', () => {
    const v = stubViz({}, 720, 448);
    tick(v, 1_500);
    paint(v);
    const { field } = layoutPlate(720, 448, true);
    const cx = field.x + field.width / 2;
    const cy = field.y + field.height / 2;
    const radius = field.width / 2;
    let hits = 0;
    for (const [x, y, , pen] of paintedDarts(v)) {
      expect(Math.abs(x - cx)).toBeLessThanOrEqual(radius);
      expect(Math.abs(y - cy)).toBeLessThanOrEqual(radius);
      const inside = Math.hypot(x - cx, y - cy) <= radius + 1e-6;
      expect(inside).toBe(pen === THEME.data1);
      if (inside) hits++;
    }
    // The painted darts are the newest ones, so the ratio is still π/4-ish.
    expect(hits / paintedDarts(v).length).toBeCloseTo(P_INSIDE, 1);
  });

  it('holds the ink well under saturation, painting fewer darts on a smaller plate', () => {
    const plates: ReadonlyArray<[number, number]> = [
      [720, 448],
      [1_280, 720],
      [343, 490], // the phone, from `aspectNarrow`
    ];
    const counts: number[] = [];
    for (const [width, height] of plates) {
      const v = stubViz({ darts: 100_000 }, width, height);
      // 100,000 darts: the ring has wrapped thirty-three times over.
      tick(v, ticksToReach(100_000));
      paint(v);
      expect(ledger(v)['darts']).toBe(100_000);
      const painted = paintedDarts(v);
      expect(painted.length).toBeLessThanOrEqual(montecarloPi.budget?.maxEntities ?? 0);
      expect(painted.length).toBeGreaterThan(200);
      // N discs of area πr² on a field of area A cover 1 − exp(−N·a/A).
      const { field } = layoutPlate(width, height, true);
      const area = field.width * field.height;
      const ink = 1 - Math.exp((-painted.length * Math.PI * THEME.particleRadius ** 2) / area);
      expect(ink, `${width}×${height}`).toBeLessThan(0.3);
      counts.push(painted.length);
    }
    // The phone paints fewer darts rather than a denser picture.
    expect(counts[2]!).toBeLessThan(counts[0]!);
    expect(counts[0]!).toBeLessThanOrEqual(counts[1]!);
  });

  it('draws the two curves at 2 px, each over its own plate-coloured halo', () => {
    const v = stubViz();
    tick(v, 2_000);
    paint(v);
    const drawn = v.fg.strokes.filter((s) => s.segments.length > 0);
    // §7: `strokeWithHalo` lays the plate colour down at lineWidth + 4 and then
    // the pen at lineWidth, so the two pens never touch where the measured
    // error crosses its own reference line. The order is the assertion: a halo
    // painted after its curve would erase it.
    expect(drawn.slice(0, 4).map((s) => [s.pen, s.width])).toEqual([
      [THEME.canvas, 2 * THEME.lineWidth + 4],
      [THEME.data2, 2 * THEME.lineWidth],
      [THEME.canvas, 2 * THEME.lineWidth + 4],
      [THEME.data1, 2 * THEME.lineWidth],
    ]);
    for (const s of drawn) expect(s.alpha).toBe(1);
    // The reference line is one segment: on log-log axes it is exactly straight.
    expect(drawn[1]?.segments).toHaveLength(1);
    // The measured error is the sampled history, one segment per gate.
    expect(drawn[3]?.segments.length).toBeGreaterThan(80);
    // What follows is the key, whose two samples take the same two pens.
    const legend = drawn.slice(4);
    expect(legend.map((s) => s.pen)).toEqual([THEME.data1, THEME.data2]);
    for (const s of legend) {
      expect(s.segments).toHaveLength(1);
      const [x0, y0, x1, y1] = s.segments[0] as [number, number, number, number];
      expect(y0).toBe(y1);
      expect(x1 - x0).toBe(14);
    }
  });

  it('keeps the error curve inside the plot frame at every plate size', () => {
    for (const [width, height] of [[720, 448], [1_280, 720], [343, 490]] as const) {
      const v = stubViz({ darts: 2_000_000 }, width, height);
      tick(v, 600);
      paint(v);
      const { plot } = layoutPlate(width, height, true);
      expect(plot).not.toBeNull();
      const s = plotScale(plot!, 2_000_000);
      for (const stroke of v.fg.strokes) {
        for (const [x0, y0, x1, y1] of stroke.segments) {
          for (const [x, y] of [[x0, y0], [x1, y1]] as const) {
            expect(x).toBeGreaterThanOrEqual(s.box.x - 1e-9);
            expect(x).toBeLessThanOrEqual(s.box.x + s.box.width + 1e-9);
            expect(y).toBeGreaterThanOrEqual(s.box.y - 1e-9);
            expect(y).toBeLessThanOrEqual(s.box.y + s.box.height + 1e-9);
          }
        }
      }
    }
  });
});

describe('montecarlo-pi instance: resize', () => {
  it('leaves the counters and the estimate untouched, and re-places the darts', () => {
    const v = stubViz({}, 720, 448);
    tick(v, 3_000);
    paint(v);
    const before = ledger(v);

    resize(v, 360, 300);
    expect(ledger(v)).toEqual(before);
    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);

    // The whole new field is used: 3,000 uniform draws leave the outermost
    // dart within a percent of each edge with overwhelming probability.
    const { field } = layoutPlate(1_280, 720, true);
    const xs = paintedDarts(v).map(([x]) => x);
    expect(Math.min(...xs)).toBeLessThan(field.x + 0.05 * field.width);
    expect(Math.max(...xs)).toBeGreaterThan(field.x + 0.95 * field.width);
  });

  it('gives the same counts on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({ darts: 4_000 }, 1_280, 720);
    const narrow = stubViz({ darts: 4_000 }, 320, 200);
    for (const v of [wide, narrow]) {
      tick(v, ticksToReach(4_000));
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
    expect(ledger(wide)['darts']).toBe(4_000);
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
 * reads without asking for it: the blurb, the simple view, the rail's help and
 * the story captions.
 *
 * `Readout.label` is deliberately outside this. types.ts reserves it for the
 * precise name the exact table shows, which is the one place a reader has
 * asked for the technical term.
 */
const JARGON =
  /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov)\b/i;

describe('montecarlo-pi metadata', () => {
  it('is registered under a permanent id, in the randomness group', () => {
    expect(montecarloPi.id).toBe('montecarlo-pi');
    expect(montecarloPi.group).toBe('randomness');
    expect(montecarloPi.budget?.maxEntities).toBe(3_000);
  });

  it('says what it does in one plain sentence', () => {
    expect(oneSentence(montecarloPi.blurb)).toBe(true);
    expect(words(montecarloPi.blurb)).toMatch(/darts/);
  });

  it('spends that sentence on the picture and the surprise, not on what the code does', () => {
    const blurb = words(montecarloPi.blurb);
    // The plate is a square with a circle in it; the reason to watch is how
    // grudgingly the estimate sharpens. Both have to be in the one line a
    // visitor is guaranteed to read.
    expect(blurb).toMatch(/square/i);
    expect(blurb).toMatch(/circle/i);
    expect(blurb).toContain('π');
    expect(blurb).toMatch(/decimal place/i);
    expect(blurb).not.toMatch(JARGON);
  });

  it('never prints a word a newcomer would have to ask about', () => {
    for (const preset of montecarloPi.presets ?? []) expect(words(preset.caption), preset.id).not.toMatch(JARGON);
    for (const fact of montecarloPi.facts) expect(words(fact.text)).not.toMatch(JARGON);
    for (const p of montecarloPi.params) expect(words(p.help ?? ''), p.key).not.toMatch(JARGON);

    const v = stubViz();
    tick(v, 200);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(JARGON);
      expect(r.hint ?? '', r.key).not.toMatch(JARGON);
    }
  });

  it('offers three presets, each a hundredfold apart, each captioned in one sentence', () => {
    const presets = montecarloPi.presets ?? [];
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.values['darts'])).toEqual([100, 10_000, 1_000_000]);
    for (const preset of presets) {
      expect(oneSentence(preset.caption), preset.id).toBe(true);
      // The caption slot reserves two lines of a 68ch measure; a third line
      // would move the fact card under it, and 120 leaves room for word wrap.
      expect(words(preset.caption).length, preset.id).toBeLessThanOrEqual(120);
    }
  });

  it('sets every preset value from a declared parameter', () => {
    for (const preset of montecarloPi.presets ?? []) {
      for (const key of Object.keys(preset.values)) {
        expect(
          montecarloPi.params.some((p) => p.key === key),
          `preset ${preset.id} sets unknown param ${key}`,
        ).toBe(true);
      }
    }
  });

  it('keeps every preset value inside its declared range and on its step', () => {
    for (const preset of montecarloPi.presets ?? []) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = montecarloPi.params.find((p) => p.key === key);
        if (!spec || spec.kind !== 'range') continue;
        expect(typeof value).toBe('number');
        const n = value as number;
        expect(n, `${preset.id}.${key}`).toBeGreaterThanOrEqual(spec.min);
        expect(n, `${preset.id}.${key}`).toBeLessThanOrEqual(spec.max);
        expect((n - spec.min) % spec.step, `${preset.id}.${key}`).toBe(0);
      }
    }
  });

  it('carries at most two facts, one sentence each, every one sourced', () => {
    expect(montecarloPi.facts.length).toBeGreaterThanOrEqual(1);
    expect(montecarloPi.facts.length).toBeLessThanOrEqual(2);
    for (const fact of montecarloPi.facts) {
      expect(oneSentence(fact.text)).toBe(true);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });
});
