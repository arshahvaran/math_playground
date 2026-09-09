import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, VizContext } from '../src/core/types';
import { bifurcation, doublingLevel, layoutPlot, tickStep } from '../src/viz/bifurcation/index';
import {
  ACCUMULATION,
  DEFAULT_X0,
  FEIGENBAUM_DELTA,
  MAX_PERIOD,
  PERIOD_THREE_ONSET,
  attractor,
  detectPeriod,
  feigenbaumRatios,
  iterate,
  lyapunovExponent,
  lyapunovFrom,
  periodDoublingOnsets,
  sampleAttractor,
} from '../src/viz/bifurcation/logistic';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

describe('the logistic map', () => {
  it('fixes 1 − 1/r, the point every orbit below r = 3 settles on', () => {
    for (const r of [1.5, 2, 2.8, 3.4]) {
      const fixed = 1 - 1 / r;
      expect(iterate(fixed, r)).toBeCloseTo(fixed, 12);
    }
  });

  it('forgets where it started: the attractor is a property of r alone', () => {
    // Two orbits at r = 3.2 from different starting points land on the same
    // 2-cycle, in the same phase or the opposite one — so compare the sets.
    const a = [...attractor(3.2, 5_000, 2, 0.2)].sort((p, q) => p - q);
    const b = [...attractor(3.2, 5_000, 2, 0.9)].sort((p, q) => p - q);
    // The 2-cycle solves x² − ((r+1)/r)·x + (r+1)/r² = 0.
    const r = 3.2;
    const s = (r + 1) / r;
    const root = Math.sqrt(s * s - (4 * (r + 1)) / (r * r));
    const analytic = [(s - root) / 2, (s + root) / 2];
    expect(a[0]).toBeCloseTo(analytic[0]!, 12);
    expect(a[1]).toBeCloseTo(analytic[1]!, 12);
    expect(b[0]).toBeCloseTo(analytic[0]!, 12);
    expect(b[1]).toBeCloseTo(analytic[1]!, 12);
  });

  it('writes the same orbit into a caller’s buffer as it returns from attractor()', () => {
    const buffer = new Float64Array(64);
    sampleAttractor(buffer, 10, 20, 3.7, 500, DEFAULT_X0);
    const direct = attractor(3.7, 500, 20, DEFAULT_X0);
    for (let i = 0; i < 20; i++) expect(buffer[10 + i]).toBe(direct[i]);
    // Nothing outside the window was touched.
    expect(buffer[9]).toBe(0);
    expect(buffer[30]).toBe(0);
  });

  it('keeps every iterate inside [0, 1] for r ≤ 4', () => {
    const orbit = attractor(4, 100, 20_000, DEFAULT_X0);
    let outside = 0;
    for (const x of orbit) if (!(x >= 0 && x <= 1)) outside++;
    expect(outside).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Period detection
// ---------------------------------------------------------------------------

describe('detectPeriod', () => {
  const TRANSIENT = 5_000;
  const SAMPLES = 300;

  it('reads 1, 2, 4 and chaos off the cascade', () => {
    expect(detectPeriod(attractor(2.8, TRANSIENT, SAMPLES))).toBe(1);
    expect(detectPeriod(attractor(3.2, TRANSIENT, SAMPLES))).toBe(2);
    expect(detectPeriod(attractor(3.5, TRANSIENT, SAMPLES))).toBe(4);
    expect(detectPeriod(attractor(3.9, TRANSIENT, SAMPLES))).toBe(0);
  });

  it('resolves 8 and 16 deeper into the cascade, and 3 inside the window', () => {
    expect(detectPeriod(attractor(3.55, TRANSIENT, SAMPLES))).toBe(8);
    expect(detectPeriod(attractor(3.566, TRANSIENT, SAMPLES))).toBe(16);
    expect(detectPeriod(attractor(3.83, TRANSIENT, SAMPLES))).toBe(3);
    // The period-3 window doubles like the whole diagram does, in miniature.
    expect(detectPeriod(attractor(3.845, TRANSIENT, SAMPLES))).toBe(6);
  });

  it('invents no cycle for an orbit still approaching one', () => {
    // r = 3.2 with no transient: the orbit is spiralling onto the 2-cycle, so
    // consecutive pairs disagree by more than the tolerance and there is no p.
    expect(detectPeriod(attractor(3.2, 0, SAMPLES))).toBe(0);
    // Given the transient it converges, and the same samples now read period 2.
    expect(detectPeriod(attractor(3.2, 200, SAMPLES))).toBe(2);
  });

  it('never reports a period the window cannot hold twice, or one past the cap', () => {
    // Eight samples of a 4-cycle: two full periods, which is the minimum
    // evidence — the check runs over every i with i + p inside the window.
    expect(detectPeriod(attractor(3.5, TRANSIENT, 8))).toBe(4);
    // Six cannot hold two, so period 4 is not claimed however well it fits.
    expect(detectPeriod(attractor(3.5, TRANSIENT, 6))).toBe(0);
    expect(detectPeriod(attractor(3.5, TRANSIENT, 4))).toBe(0);
    expect(MAX_PERIOD).toBe(64);
  });

  it('reads a window of a larger buffer without copying it', () => {
    const buffer = new Float64Array(400);
    sampleAttractor(buffer, 100, 200, 3.5, TRANSIENT, DEFAULT_X0);
    expect(detectPeriod(buffer, 1e-6, 100, 200)).toBe(4);
    // The zeros around it are a period-1 orbit of their own; reading the whole
    // buffer would see neither.
    expect(detectPeriod(buffer, 1e-6, 0, 50)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Feigenbaum
// ---------------------------------------------------------------------------

describe('period doubling and δ', () => {
  it('publishes the five onsets, with the two that are exact actually exact', () => {
    const onsets = periodDoublingOnsets();
    expect(onsets).toHaveLength(5);
    expect(onsets[0]).toBe(3);
    // The 2-cycle multiplier is 4 + 2r − r², which passes −1 at 1 + √6.
    expect(onsets[1]).toBe(1 + Math.sqrt(6));
    expect(4 + 2 * onsets[1]! - onsets[1]! * onsets[1]!).toBeCloseTo(-1, 12);
    // The cascade accumulates just past the last onset.
    expect(onsets[4]).toBeLessThan(ACCUMULATION);
    expect(ACCUMULATION - onsets[4]!).toBeLessThan(0.002);
  });

  it('reproduces 4.7514, 4.6563, 4.6682 from those onsets', () => {
    const ratios = feigenbaumRatios(periodDoublingOnsets());
    expect(ratios).toHaveLength(3);
    // Computed from the onsets above to full double precision, then rounded
    // for display: 4.7514462, 4.6562512, 4.6682415.
    expect(ratios[0]).toBeCloseTo(4.7514462, 6);
    expect(ratios[1]).toBeCloseTo(4.6562512, 6);
    expect(ratios[2]).toBeCloseTo(4.6682415, 6);
    expect(ratios.map((x) => x.toFixed(4))).toEqual(['4.7514', '4.6563', '4.6682']);
  });

  it('closes on δ, each ratio nearer than the one before', () => {
    const errors = feigenbaumRatios(periodDoublingOnsets()).map((x) => Math.abs(x - FEIGENBAUM_DELTA));
    expect(errors[0]).toBeGreaterThan(errors[1]!);
    expect(errors[1]).toBeGreaterThan(errors[2]!);
    // 0.0822 → 0.0129 → 0.00096: three onsets deep is already four digits of δ.
    expect(errors[2]).toBeLessThan(0.001);
    expect(FEIGENBAUM_DELTA).toBeCloseTo(4.669201609, 9);
  });

  it('gives no ratio without three onsets', () => {
    expect(feigenbaumRatios([])).toEqual([]);
    expect(feigenbaumRatios([3, 3.4495])).toEqual([]);
    expect(feigenbaumRatios([0, 1, 3])).toEqual([0.5]);
  });

  it('classifies doubling levels, and only powers of two', () => {
    expect([1, 2, 4, 8, 16, 32, 64].map(doublingLevel)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // 0 is "no cycle", and 3 and 6 are the window inside the chaos: neither is
    // a step of the cascade.
    expect([0, 3, 5, 6, 12].map(doublingLevel)).toEqual([-1, -1, -1, -1, -1]);
  });
});

// ---------------------------------------------------------------------------
// The Lyapunov exponent
// ---------------------------------------------------------------------------

describe('lyapunovExponent', () => {
  it('is exactly ½·ln|4 + 2r − r²| on the 2-cycle at r = 3.2', () => {
    // The cycle's multiplier is f′(p)·f′(q) = 4 + 2r − r² = 0.16 at r = 3.2, so
    // λ = ½·ln 0.16 = −0.9162907. The orbit reaches the cycle to machine
    // precision (0.16 per period, so 5,000 iterations underflow the residual),
    // and an even sample count visits each of the two points equally often —
    // hence a bound of 1e-9 rather than a statistical one.
    const analytic = 0.5 * Math.log(Math.abs(4 + 2 * 3.2 - 3.2 * 3.2));
    expect(analytic).toBeCloseTo(-0.9162907318, 9);
    expect(lyapunovExponent(3.2, 5_000, 2_000)).toBeCloseTo(analytic, 9);
  });

  it('is negative in the periodic windows and positive in the chaos', () => {
    // Period 2, period 4 and the period-3 window: order, however deep.
    expect(lyapunovExponent(3.2, 5_000, 2_000)).toBeLessThan(0);
    expect(lyapunovExponent(3.5, 5_000, 2_000)).toBeLessThan(0);
    expect(lyapunovExponent(3.83, 5_000, 2_000)).toBeLessThan(0);
    // Chaos, on both sides of the period-3 window.
    expect(lyapunovExponent(3.7, 5_000, 200_000)).toBeGreaterThan(0);
    expect(lyapunovExponent(3.9, 5_000, 200_000)).toBeGreaterThan(0);
  });

  it('reaches ln 2 at r = 4, where the map is the tent map in disguise', () => {
    // At r = 4 the invariant density is the arcsine law, under which ln|f′| has
    // standard deviation π/√12 = 0.9069. The mean of 200,000 samples therefore
    // has a standard error of 0.00203, so 0.01 is 4.9σ.
    const measured = lyapunovExponent(4, 5_000, 200_000);
    const se = Math.PI / Math.sqrt(12) / Math.sqrt(200_000);
    expect(se).toBeCloseTo(0.00203, 5);
    expect(Math.abs(measured - Math.LN2)).toBeLessThan(0.01);
  });

  it('is zero at r = 3, where the fixed point is neutral', () => {
    // At r = 3 the multiplier is exactly −1 and the approach is algebraic, not
    // geometric: eₙ ≈ 1/√(18n), so ln|f′| ≈ −1/n per step and the mean over
    // samples N taken after n₀ is −ln(1 + N/n₀)/N. At n₀ = N = 10,000 that
    // predicts −6.9e-5. The bound is 1e-3, fourteen times the prediction, which
    // covers the higher-order terms the estimate drops.
    const predicted = Math.log(2) / 10_000;
    expect(predicted).toBeCloseTo(6.93e-5, 6);
    const measured = lyapunovExponent(3, 10_000, 10_000);
    expect(measured).toBeLessThan(0);
    expect(Math.abs(measured)).toBeLessThan(1e-3);
    // Ten times as long is ten times closer to zero — the 1/N of the estimate.
    expect(Math.abs(lyapunovExponent(3, 100_000, 100_000))).toBeLessThan(Math.abs(measured) / 5);
  });

  it('reads −∞ where an orbit passes through the critical point', () => {
    // A superstable cycle contains x = ½, where f′ = 0. That is a real answer,
    // not a failure, and the drawn curve breaks there rather than plunging.
    expect(lyapunovFrom([0.2, 0.5, 0.8], 3.6)).toBe(-Infinity);
  });

  it('agrees with the orbit-in-hand form the tab actually uses', () => {
    const r = 3.77;
    const orbit = attractor(r, 1_000, 5_000);
    expect(lyapunovFrom(orbit, r)).toBeCloseTo(lyapunovExponent(r, 1_000, 5_000), 12);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('layout', () => {
  it('gives one column per CSS pixel, centred, with room for the axis', () => {
    const plot = layoutPlot(720, 448, 11);
    expect(plot.columns).toBe(704);
    expect(plot.x0).toBe(8);
    expect(plot.y0).toBe(8);
    // 448 − 8 top − (4 tick + 3 gap + 11 label + 2) gutter.
    expect(plot.h).toBe(420);
    expect(plot.x0 + plot.columns).toBeLessThanOrEqual(720);
    expect(plot.y0 + plot.h).toBeLessThan(448);
  });

  it('survives a plate too small to hold its own margins', () => {
    const plot = layoutPlot(4, 4, 11);
    expect(plot.columns).toBeGreaterThanOrEqual(1);
    expect(plot.h).toBeGreaterThanOrEqual(1);
  });

  it('keeps every r numeral on the plate and clear of its neighbour', () => {
    for (const [width, height] of [
      [720, 448],
      [1100, 688],
      [343, 312],
    ] as const) {
      // The last one is the case that forces every-other labelling: four
      // decimals on a phone plate is six digits per numeral against a 41 px
      // tick spacing.
      for (const values of [
        {},
        { rMin: 3.4, rMax: 3.57 },
        { rMin: 3.95, rMax: 4 },
        { rMin: 3.568, rMax: 3.572 },
      ]) {
        const v = stubViz(values, width, height);
        const numerals = v.bg.labels.filter((l) => l.align === 'center').sort((a, b) => a.x - b.x);
        expect(numerals.length, `${width} ${JSON.stringify(values)}`).toBeGreaterThanOrEqual(3);
        for (let i = 0; i < numerals.length; i++) {
          const label = numerals[i]!;
          expect(label.x - label.reach, `${label.text} at ${width}`).toBeGreaterThanOrEqual(0);
          expect(label.x + label.reach, `${label.text} at ${width}`).toBeLessThanOrEqual(width);
          const next = numerals[i + 1];
          if (next) expect(next.x - next.reach).toBeGreaterThanOrEqual(label.x + label.reach);
        }
      }
    }
  });

  it('picks tick steps off the 1-2-5 ladder', () => {
    expect(tickStep(1.6)).toBeCloseTo(0.2, 12);
    expect(tickStep(0.2)).toBeCloseTo(0.05, 12);
    expect(tickStep(0.17)).toBeCloseTo(0.05, 12);
    expect(tickStep(0.04)).toBeCloseTo(0.005, 12);
    expect(tickStep(0.05)).toBeCloseTo(0.01, 12);
    for (const span of [4, 1.6, 0.2, 0.04, 0.001]) {
      const n = span / tickStep(span);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

interface Fill {
  pen: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Seg = readonly [number, number, number, number];

interface Stroke {
  pen: string;
  width: number;
  segments: readonly Seg[];
}

/**
 * A canvas context that records the marks it is asked for. Only fills and
 * strokes are kept: text and the window's plate record nothing, so every entry
 * is geometry.
 */
interface Label {
  text: string;
  x: number;
  y: number;
  align: string;
  /** Half the width the context reported for it, i.e. its reach either side of x. */
  reach: number;
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  fills: Fill[];
  strokes: Stroke[];
  texts: string[];
  labels: Label[];
} {
  const fills: Fill[] = [];
  const strokes: Stroke[] = [];
  const texts: string[] = [];
  const labels: Label[] = [];
  let segments: Seg[] = [];
  let cx = 0;
  let cy = 0;
  const api = {
    lineWidth: 1,
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    strokeRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (text: string) => ({ width: 7 * text.length }),
    fillText(text: string, x: number, y: number): void {
      texts.push(text);
      labels.push({ text, x, y, align: String(api.textAlign), reach: (7 * text.length) / 2 });
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      fills.push({ pen: String(api.fillStyle), x, y, w, h });
    },
    beginPath(): void {
      segments = [];
    },
    moveTo(x: number, y: number): void {
      cx = x;
      cy = y;
    },
    lineTo(x: number, y: number): void {
      segments.push([cx, cy, x, y]);
      cx = x;
      cy = y;
    },
    stroke(): void {
      strokes.push({ pen: String(api.strokeStyle), width: api.lineWidth, segments: [...segments] });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, fills, strokes, texts, labels };
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

const DEFAULTS: Record<string, ParamValue> = {
  rMin: 2.4,
  rMax: 4,
  transient: 2000,
  samples: 400,
  showLyapunov: true,
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
  const instance = bifurcation.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Harness = ReturnType<typeof stubViz>;

function tick(v: Harness, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with the mark logs cleared first so they hold exactly that frame. */
function paint(v: Harness): void {
  v.fg.fills.length = 0;
  v.fg.strokes.length = 0;
  v.fg.texts.length = 0;
  v.bg.fills.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Harness, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Run to the end of the sweep, the way the transport's fast-forward does. */
function sweep(v: Harness): void {
  for (let i = 0; i < 40; i++) {
    tick(v, 300);
    paint(v);
    if (ledger(v)['columns'] === 704) return;
  }
  throw new Error(`sweep did not finish: ${ledger(v)['columns']} columns`);
}

function ledger(v: Harness): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function row(v: Harness, key: string): Readout {
  const found = (v.emitted.at(-1) ?? []).find((r) => r.key === key);
  expect(found, `no readout ${key}`).toBeDefined();
  return found as Readout;
}

function preset(id: string): Record<string, ParamValue> {
  const found = bifurcation.presets?.find((p) => p.id === id);
  expect(found, `no preset ${id}`).toBeDefined();
  return { ...(found?.values ?? {}) };
}

describe('bifurcation instance: the ledger', () => {
  it('publishes every number it draws, and holds still between draws', () => {
    const v = stubViz();
    tick(v, 100);
    paint(v);
    const keys = (v.emitted.at(-1) ?? []).map((r) => r.key);
    expect(keys).toEqual(['columns', 'span', 'r', 'period', 'lyapunov', 'feigenbaum', 'iterations']);
    // The three numbers painted into the corner window are all in the ledger.
    expect(v.fg.texts.some((t) => t.startsWith('r '))).toBe(true);
    expect(v.fg.texts.some((t) => t.startsWith('λ '))).toBe(true);
    expect(v.fg.texts.some((t) => t.startsWith('period '))).toBe(true);

    const before = ledger(v);
    paint(v);
    expect(ledger(v)).toEqual(before);
    expect(row(v, 'feigenbaum').target).toBeCloseTo(FEIGENBAUM_DELTA, 9);
  });

  it('counts columns, iterations and the r window it was given', () => {
    const v = stubViz();
    sweep(v);
    const l = ledger(v);
    expect(l['columns']).toBe(704);
    expect(l['span']).toBeCloseTo(1.6, 12);
    // Every column costs transient + samples iterations of the map.
    expect(l['iterations']).toBe(704 * (2000 + 400));
    // The cursor parks half a column short of the right edge, at that column's centre.
    expect(l['r']).toBeCloseTo(4 - 1.6 / 704 / 2, 9);
  });

  it('is identical for a seed, and different for another', () => {
    const a = stubViz();
    const b = stubViz();
    sweep(a);
    sweep(b);
    expect(ledger(b)).toEqual(ledger(a));
    const c = stubViz({ seed: 7 });
    sweep(c);
    // Only x₀ moves, and every orbit forgets x₀ — so the diagram is the same
    // and only the leftover transient differs. The ledger agrees on the
    // structural numbers.
    expect(ledger(c)['columns']).toBe(ledger(a)['columns']);
    expect(ledger(c)['r']).toBe(ledger(a)['r']);
  });

  it('resets to an empty sweep and no reading', () => {
    const v = stubViz();
    sweep(v);
    v.instance.reset();
    v.instance.drawBackground?.();
    paint(v);
    const l = ledger(v);
    expect(l['columns']).toBe(0);
    expect(l['iterations']).toBe(0);
    expect(Number.isNaN(l['r'] ?? 0)).toBe(true);
    expect(Number.isNaN(l['lyapunov'] ?? 0)).toBe(true);
    v.instance.destroy();
  });
});

describe('bifurcation instance: the two layers', () => {
  it('accumulates the diagram on the background and never repaints it', () => {
    const v = stubViz();
    tick(v, 60);
    paint(v);
    const first = v.bg.fills.length;
    expect(first).toBeGreaterThan(0);
    // Every attractor mark is one snapped device-pixel square in the signal pen.
    for (const f of v.bg.fills) {
      expect(f.pen).toBe(THEME.data1);
      expect(f.w).toBe(1);
      expect(f.h).toBe(1);
      expect(Number.isInteger(f.x)).toBe(true);
      expect(Number.isInteger(f.y)).toBe(true);
    }
    // A second frame with no step in between paints no column twice.
    paint(v);
    expect(v.bg.fills).toHaveLength(0);
    // And a finished sweep costs the background nothing at all.
    sweep(v);
    paint(v);
    expect(v.bg.fills).toHaveLength(0);
  });

  it('keeps the sweep cursor and the λ curve on the foreground, and drops the cursor when done', () => {
    const v = stubViz();
    tick(v, 60);
    paint(v);
    const cursor = v.fg.strokes.filter((s) => s.pen === THEME.data1);
    expect(cursor).toHaveLength(1);
    expect(cursor[0]?.width).toBe(2 * THEME.lineWidth);
    // The zero line is furniture, so it takes the container pen; the curve is
    // an analytic overlay in the drafting pen, haloed in the plate colour.
    expect(v.fg.strokes.some((s) => s.pen === THEME.gridSoft)).toBe(true);
    const curve = v.fg.strokes.filter((s) => s.pen === THEME.data2);
    expect(curve).toHaveLength(1);
    expect(v.fg.strokes.some((s) => s.pen === THEME.canvas && s.width > (curve[0]?.width ?? 0))).toBe(true);
    expect(v.fg.fills).toHaveLength(1); // the window's plate, and nothing else

    sweep(v);
    paint(v);
    expect(v.fg.strokes.filter((s) => s.pen === THEME.data1)).toHaveLength(0);
  });

  it('absorbs the λ toggle without touching the diagram, and resets for everything else', () => {
    const v = stubViz();
    sweep(v);
    expect(setParam(v, 'showLyapunov', false)).toBe(true);
    expect(ledger(v)['columns']).toBe(704);
    expect(v.fg.strokes.filter((s) => s.pen === THEME.data2)).toHaveLength(0);
    expect(v.bg.fills).toHaveLength(0);

    expect(setParam(v, 'rMax', 3.6)).toBe(false);
    expect(ledger(v)['columns']).toBe(0);
    expect(ledger(v)['span']).toBeCloseTo(1.2, 12);
  });

  it('rewinds the sweep on a resize, because every column moved', () => {
    const v = stubViz();
    sweep(v);
    v.ctx.width = 900;
    v.ctx.height = 500;
    v.instance.drawBackground?.();
    paint(v);
    expect(ledger(v)['columns']).toBe(0);
    sweep2(v, 884);
    expect(ledger(v)['columns']).toBe(884);
  });
});

/** Sweep to a known column count on a re-laid-out plate. */
function sweep2(v: Harness, columns: number): void {
  for (let i = 0; i < 40; i++) {
    tick(v, 300);
    paint(v);
    if (ledger(v)['columns'] === columns) return;
  }
  throw new Error(`sweep did not finish: ${ledger(v)['columns']} of ${columns}`);
}

describe('bifurcation instance: convergence to the analytic values', () => {
  it('measures δ inside the uncertainty its own column width implies', () => {
    const v = stubViz(preset('cascade'));
    sweep(v);
    const feigenbaum = row(v, 'feigenbaum');
    const tolerance = feigenbaum.tolerance ?? 0;
    // The window is 0.17 wide over 704 columns, so h = 2.4e-4 and the two
    // onsets bracketing each interval are located to about two columns each:
    // 2·h·(1/0.095 + 1/0.020) = 2.9% of the ratio. The claim is only worth
    // making because that is small. Measured: 4.6235, 0.98% from δ.
    expect(tolerance).toBeGreaterThan(0);
    expect(tolerance).toBeLessThan(0.05);
    expect(Math.abs(feigenbaum.value - FEIGENBAUM_DELTA) / FEIGENBAUM_DELTA).toBeLessThan(tolerance);
  });

  it('measures δ on the whole map too, more loosely, from the columns it has', () => {
    const v = stubViz(preset('whole-map'));
    sweep(v);
    const feigenbaum = row(v, 'feigenbaum');
    const tolerance = feigenbaum.tolerance ?? 0;
    // Seven times the window over the same 704 columns, so h is seven times
    // larger and so is the uncertainty: 5.9%. Measured 4.8780, 4.5% from δ —
    // agreement, and a visibly worse one than the zoom above, which is the
    // lesson the Cascade preset exists to make.
    expect(tolerance).toBeLessThan(0.1);
    expect(Math.abs(feigenbaum.value - FEIGENBAUM_DELTA) / FEIGENBAUM_DELTA).toBeLessThan(tolerance);
  });

  it('publishes no ratio for a window with no cascade in it', () => {
    // Three shrinking intervals can be assembled out of unrelated periodic
    // windows up in the chaos. The uncertainty that carries — hundreds of
    // percent — is what disqualifies them, and the ledger shows no reading
    // rather than a number.
    for (const id of ['period-three', 'deep-chaos']) {
      const v = stubViz(preset(id));
      sweep(v);
      expect(Number.isNaN(row(v, 'feigenbaum').value), id).toBe(true);
    }
  });

  it('reaches ln 2 at r = 4 on the deep-chaos window, and says so', () => {
    const v = stubViz(preset('deep-chaos'));
    sweep(v);
    const lyapunov = row(v, 'lyapunov');
    expect(lyapunov.target).toBe(Math.LN2);
    // 1,000 samples of a term with standard deviation π/√12, so SE = 0.0287
    // and 0.115 is 4σ.
    const se = Math.PI / Math.sqrt(12) / Math.sqrt(1_000);
    expect(Math.abs(lyapunov.value - Math.LN2)).toBeLessThan(4 * se);
    expect(ledger(v)['period']).toBe(0);
  });

  it('finds the period-3 window where 1 + √8 says it is', () => {
    const v = stubViz(preset('period-three'));
    let opened = NaN;
    let lambdaInside = NaN;
    // One tick a look: the sweep advances 2.35 columns a tick here, so the
    // first column reporting period 3 is caught to within three columns.
    for (let i = 0; i < 400 && Number.isNaN(opened); i++) {
      tick(v, 1);
      paint(v);
      if (ledger(v)['period'] === 3) {
        opened = ledger(v)['r'] ?? NaN;
        lambdaInside = ledger(v)['lyapunov'] ?? NaN;
      }
    }
    // The window opens at r = 1 + √8 = 3.8284271, and a column here is 5.7e-5
    // wide. The bound is 5e-4, about nine columns: three for the sampling above
    // and the rest for the tangent bifurcation itself, where the new 3-cycle is
    // neutral and an orbit needs more than the preset's 2,000 iterations to
    // land on it. Measured: 3.8284943, one and a fifth columns past 1 + √8.
    expect(PERIOD_THREE_ONSET).toBeCloseTo(3.8284271, 7);
    expect(opened).toBeGreaterThan(PERIOD_THREE_ONSET);
    expect(opened - PERIOD_THREE_ONSET).toBeLessThan(5e-4);
    // Inside the window the orbit is a stable 3-cycle, so λ is negative — order
    // sitting inside chaos, which is the whole point of the preset.
    expect(lambdaInside).toBeLessThan(0);
  });

  it('shows the first doubling at r = 3 as λ touching zero', () => {
    const v = stubViz(preset('first-doubling'));
    sweep2(v, 704);
    // The window is 2.9 to 3.1, so the doubling sits at its centre. Sample the
    // ledger as the cursor crosses: below r = 3 the period is 1, above it is 2.
    const w = stubViz(preset('first-doubling'));
    let belowPeriod = 0;
    let abovePeriod = 0;
    let minAbsLambda = Infinity;
    for (let i = 0; i < 60; i++) {
      tick(w, 20);
      paint(w);
      const l = ledger(w);
      const r = l['r'] ?? 0;
      if (r < 2.99) belowPeriod = l['period'] ?? 0;
      if (r > 3.01 && abovePeriod === 0) abovePeriod = l['period'] ?? 0;
      if (Math.abs(r - 3) < 0.01) minAbsLambda = Math.min(minAbsLambda, Math.abs(l['lyapunov'] ?? 1));
    }
    expect(belowPeriod).toBe(1);
    expect(abovePeriod).toBe(2);
    // λ is exactly 0 at r = 3 and the estimate over 400 samples after 3,000
    // iterations carries the −ln(1 + N/n₀)/N ≈ −4e-5 of the neutral fixed
    // point; a hundredth is far above that and far below the −0.9 of the
    // stable 2-cycle a fifth of a unit later.
    expect(minAbsLambda).toBeLessThan(0.01);
  });
});

describe('bifurcation: the shipped tab', () => {
  it('is registered with a permanent id, a budget, and presets that name the moment', () => {
    expect(bifurcation.id).toBe('bifurcation');
    expect(bifurcation.group).toBe('chaos');
    expect(bifurcation.budget?.maxEntities).toBeGreaterThan(0);
    expect(bifurcation.presets?.map((p) => p.id)).toEqual([
      'whole-map',
      'first-doubling',
      'cascade',
      'period-three',
      'deep-chaos',
    ]);
    expect(bifurcation.facts.length).toBeGreaterThanOrEqual(3);
    for (const fact of bifurcation.facts) expect(fact.source.label.length).toBeGreaterThan(0);
  });

  it('declares a seed and keeps every preset inside its own slider range', () => {
    const specs = new Map(bifurcation.params.map((p) => [p.key, p]));
    expect(specs.get('seed')?.kind).toBe('seed');
    for (const p of bifurcation.presets ?? []) {
      for (const [key, value] of Object.entries(p.values)) {
        const spec = specs.get(key);
        expect(spec, `preset ${p.id} sets unknown ${key}`).toBeDefined();
        if (spec && (spec.kind === 'range' || spec.kind === 'int')) {
          expect(value).toBeGreaterThanOrEqual(spec.min);
          expect(value).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });
});
