import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, VizContext } from '../src/core/types';
import { buffon, layoutField } from '../src/viz/buffon/index';
import {
  NeedleField,
  crossingProbability,
  dropNeedle,
  estimatePi,
  needleCrosses,
  piStandardError,
  type Needle,
} from '../src/viz/buffon/geometry';

const SEED = 42;
const LENGTH = 0.8;
const SPACING = 1;
const DROPS = 100_000;
/** Analytic crossing probability at L/d = 0.8: 2·0.8/π = 0.50930. */
const P = (2 * LENGTH) / (Math.PI * SPACING);

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/**
 * 100,000 drops. The buffer is deliberately far smaller than the drop count:
 * the statistics must keep counting after the ring wraps.
 */
function run(seed: number, budget = 1_000): NeedleField {
  const rng = createRng(seed);
  const field = new NeedleField(budget);
  for (let i = 0; i < DROPS; i++) field.push(dropNeedle(rng, LENGTH, SPACING));
  return field;
}

/**
 * `NeedleField` stores each needle's direction as (cos θ, sin θ) so the painter
 * never recomputes a sin/cos per needle per frame, so the angle has to be
 * recovered here — and through Float32 storage it comes back a few ulps off.
 * Hence `expectNeedles` rather than a bare `toEqual`.
 */
function collect(field: NeedleField): Needle[] {
  const out: Needle[] = [];
  field.forEach((u, v, t, cos, sin, crosses) => out.push({ u, v, t, angle: Math.atan2(sin, cos), crosses }));
  return out;
}

function expectNeedles(actual: Needle[], expected: Needle[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((want, i) => {
    const got = actual[i];
    expect(got).toBeDefined();
    expect(got?.u).toBe(want.u);
    expect(got?.v).toBe(want.v);
    expect(got?.t).toBe(want.t);
    expect(got?.crosses).toBe(want.crosses);
    // Float32 round-trip through (cos, sin) holds to ~7 significant digits.
    expect(got?.angle).toBeCloseTo(want.angle, 5);
  });
}

describe('buffon convergence', () => {
  it('crossing fraction reaches 2L/(πd) within 4σ at 100,000 drops', () => {
    const field = run(SEED);
    expect(field.drops).toBe(DROPS);
    expect(field.count).toBe(1_000);
    // A proportion at N = 1e5 has SE = sqrt(P(1−P)/N) = 0.00158; 0.006 is ≈ 3.8σ.
    expect(Math.abs(field.crossings / field.drops - P)).toBeLessThan(0.006);
  });

  it('π estimate reaches Math.PI within 4σ at 100,000 drops', () => {
    const field = run(SEED);
    const pi = estimatePi(field.drops, field.crossings, LENGTH, SPACING);
    // Delta-method SE of π̂ is π·sqrt((1−P)/(P·N)) = 0.00975 here, so 0.04 is ≈ 4.1σ.
    expect(piStandardError(DROPS, LENGTH, SPACING)).toBeCloseTo(0.00975, 4);
    expect(Math.abs(pi - Math.PI)).toBeLessThan(0.04);
  });

  it('reproduces the same needles and counts from the same seed', () => {
    const a = run(SEED);
    const b = run(SEED);
    expect(a.drops).toBe(b.drops);
    expect(a.crossings).toBe(b.crossings);
    expect(collect(a)).toEqual(collect(b));
  });

  it('differs between seeds', () => {
    expect(run(1).crossings).not.toBe(run(2).crossings);
  });
});

describe('dropNeedle', () => {
  it('draws three fractions in [0, 1) and an angle in [0, π), and consults no plate', () => {
    const rng = createRng(7);
    // Counted rather than asserted per needle: 40,000 expect() calls cost a
    // second, one comparison of a counter costs nothing.
    let outside = 0;
    let inconsistent = 0;
    let maxAngle = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const n = dropNeedle(rng, LENGTH, SPACING);
      const inRange = (x: number): boolean => x >= 0 && x < 1;
      if (!inRange(n.u) || !inRange(n.v) || !inRange(n.t) || n.angle < 0 || n.angle >= Math.PI) outside++;
      if (n.crosses !== needleCrosses(n.t * SPACING, n.angle, LENGTH, SPACING)) inconsistent++;
      maxAngle = Math.max(maxAngle, n.angle);
    }
    expect(outside).toBe(0);
    expect(inconsistent).toBe(0);
    // Angles do reach the top of the range: the largest of 10,000 uniform draws
    // on [0, π) falls short of π by about π/10,000 on average.
    expect(maxAngle).toBeGreaterThan(Math.PI - 0.01);
  });

  it('scales the crossing decision with L/d, not with either in pixels', () => {
    const small = createRng(11);
    const large = createRng(11);
    for (let i = 0; i < 5_000; i++) {
      expect(dropNeedle(small, 0.8, 1).crosses).toBe(dropNeedle(large, 51.2, 64).crosses);
    }
  });
});

describe('needleCrosses', () => {
  it('always crosses when centred exactly on a line, at any angle', () => {
    for (let k = 0; k < 6; k++) {
      for (const angle of [0, 0.3, Math.PI / 2, 2.5, Math.PI - 1e-9]) {
        expect(needleCrosses(k * SPACING, angle, LENGTH, SPACING)).toBe(true);
      }
    }
  });

  it('never crosses when horizontal and off a line', () => {
    for (const y of [0.05, 0.3, 0.5, 0.7, 0.999, 3.5, 7.25]) {
      expect(needleCrosses(y, 0, LENGTH, SPACING)).toBe(false);
    }
  });

  it('always crosses when vertical at full length', () => {
    // Reach is d/2, so one of y₀ ≤ d/2 or d − y₀ ≤ d/2 holds for every y₀.
    for (let i = 0; i <= 100; i++) {
      expect(needleCrosses(i / 100 + 2, Math.PI / 2, SPACING, SPACING)).toBe(true);
    }
  });

  it('depends on y only through the distance to the nearest line', () => {
    const rng = createRng(3);
    for (let i = 0; i < 2_000; i++) {
      const y0 = rng.range(0, SPACING);
      const angle = rng.range(0, Math.PI);
      const base = needleCrosses(y0, angle, LENGTH, SPACING);
      expect(needleCrosses(SPACING - y0, angle, LENGTH, SPACING)).toBe(base);
      expect(needleCrosses(y0 + 7 * SPACING, angle, LENGTH, SPACING)).toBe(base);
      expect(needleCrosses(y0 - 3 * SPACING, angle, LENGTH, SPACING)).toBe(base);
    }
  });
});

describe('crossingProbability', () => {
  it('is 2L/(πd) for L ≤ d', () => {
    expect(crossingProbability(0.8, 1)).toBeCloseTo(P, 12);
    expect(crossingProbability(51.2, 64)).toBeCloseTo(P, 12);
    expect(crossingProbability(1, 1)).toBeCloseTo(2 / Math.PI, 12);
    expect(crossingProbability(0, 1)).toBe(0);
  });

  it('clamps the out-of-scope long-needle case to the L = d value', () => {
    expect(crossingProbability(1.5, 1)).toBeCloseTo(2 / Math.PI, 12);
  });
});

describe('estimatePi', () => {
  it('is NaN before the first crossing', () => {
    expect(estimatePi(0, 0, LENGTH, SPACING)).toBeNaN();
    expect(estimatePi(50, 0, LENGTH, SPACING)).toBeNaN();
  });

  it('recovers π exactly from the expected crossing count', () => {
    expect(estimatePi(1_000, 1_000 * P, LENGTH, SPACING)).toBeCloseTo(Math.PI, 10);
    expect(estimatePi(3_408, 1_808, 5 / 6, 1)).toBeCloseTo(355 / 113, 12);
  });
});

describe('piStandardError', () => {
  it('follows the delta method and shrinks as 1/√N', () => {
    const se = piStandardError(DROPS, LENGTH, SPACING);
    expect(se).toBeCloseTo(Math.PI * Math.sqrt((1 - P) / (P * DROPS)), 12);
    expect(se / piStandardError(4 * DROPS, LENGTH, SPACING)).toBeCloseTo(2, 12);
  });

  it('is infinite with no drops or a zero-length needle', () => {
    expect(piStandardError(0, LENGTH, SPACING)).toBe(Infinity);
    expect(piStandardError(1_000, 0, SPACING)).toBe(Infinity);
  });
});

describe('NeedleField', () => {
  // Dyadic fractions, so they survive the Float32 round trip exactly.
  const needle = (i: number, crosses: boolean): Needle => ({
    u: i / 8,
    v: i / 16,
    t: i / 32,
    angle: 0.5,
    crosses,
  });

  it('keeps only the newest `budget` needles but counts every drop', () => {
    const field = new NeedleField(5);
    for (let i = 0; i < 8; i++) field.push(needle(i, i % 2 === 0));
    expect(field.capacity).toBe(5);
    expect(field.count).toBe(5);
    expect(field.drops).toBe(8);
    expect(field.crossings).toBe(4);
    expectNeedles(collect(field), [3, 4, 5, 6, 7].map((i) => needle(i, i % 2 === 0)));
  });

  it('visits oldest first with a chronological index', () => {
    const field = new NeedleField(3);
    for (let i = 0; i < 3; i++) field.push(needle(i, false));
    const seen: number[] = [];
    field.forEach((u, _v, _t, _cos, _sin, _crosses, index) => {
      seen.push(index);
      expect(u).toBe(index / 8);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reset clears the needles and the counters', () => {
    const field = new NeedleField(4);
    for (let i = 0; i < 10; i++) field.push(needle(i, true));
    field.reset();
    expect(field.count).toBe(0);
    expect(field.drops).toBe(0);
    expect(field.crossings).toBe(0);
    expectNeedles(collect(field), []);
    field.push(needle(0, true));
    expectNeedles(collect(field), [needle(0, true)]);
  });

  it('never allocates below one slot', () => {
    const field = new NeedleField(0);
    field.push(needle(1, false));
    field.push(needle(2, true));
    expect(field.count).toBe(1);
    expect(field.drops).toBe(2);
    expectNeedles(collect(field), [needle(2, true)]);
  });
});

describe('layoutField', () => {
  /** The extent a rule of `lineWidth` centred on `y` actually inks. */
  const extent = (y: number, lineWidth: number): [number, number] => [y - lineWidth / 2, y + lineWidth / 2];

  it('rules the whole strips that fit and centres the block', () => {
    const { rows, originY, lines } = layoutField(500, 64, 1);
    expect(rows).toBe(7);
    expect(originY).toBe(Math.floor((500 - 7 * 64) / 2));
    expect(lines).toHaveLength(8);
    expect(lines.map((y) => y - originY - 0.5)).toEqual([0, 64, 128, 192, 256, 320, 384, 448]);
  });

  it('keeps the closing rule on the plate when the height is an exact multiple of the spacing', () => {
    // The regression: 448 px at d = 64 leaves no margin, and a rule centred on
    // the field's own bottom edge falls on the pixel row after the last one.
    for (const [height, spacing] of [[448, 64], [160, 160], [24, 24], [960, 160]] as const) {
      const { rows, lines } = layoutField(height, spacing, 1);
      expect(lines, `${height}/${spacing}`).toHaveLength(rows + 1);
      for (const y of lines) {
        const [top, bottom] = extent(y, 1);
        expect(top, `${height}/${spacing} rule at ${y}`).toBeGreaterThanOrEqual(0);
        expect(bottom, `${height}/${spacing} rule at ${y}`).toBeLessThanOrEqual(height);
      }
    }
  });

  it('keeps every rule on the plate at every plate height and spacing, both line parities', () => {
    for (const lineWidth of [1, 2]) {
      for (let height = 160; height <= 900; height++) {
        for (const spacing of [24, 64, 65, 160]) {
          const { lines } = layoutField(height, spacing, lineWidth);
          const [top] = extent(lines[0] ?? 0, lineWidth);
          const [, bottom] = extent(lines[lines.length - 1] ?? 0, lineWidth);
          expect(top, `h=${height} d=${spacing} w=${lineWidth}`).toBeGreaterThanOrEqual(0);
          expect(bottom, `h=${height} d=${spacing} w=${lineWidth}`).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('snaps odd widths to half pixels and even ones to whole ones', () => {
    expect(layoutField(500, 64, 1).lines[0]).toBe(26.5);
    expect(layoutField(500, 64, 2).lines[0]).toBe(26);
  });

  it('always rules at least one strip, even on a plate shorter than the spacing', () => {
    const { rows, lines } = layoutField(100, 160, 1);
    expect(rows).toBe(1);
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];

/** A Path2D that keeps its segments, so a test can see where a needle was painted. */
class RecordingPath {
  readonly segments: Seg[] = [];
  private x = 0;
  private y = 0;
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
  lineTo(x: number, y: number): void {
    this.segments.push([this.x, this.y, x, y]);
    this.x = x;
    this.y = y;
  }
}

// The viz batches its needles into Path2D; vitest runs in node, which has none.
(globalThis as { Path2D?: unknown }).Path2D ??= RecordingPath;

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  segments: readonly Seg[];
}

/**
 * A canvas context that records the strokes it is asked for and accepts
 * everything else. The needles and the ruled lines are the only things under
 * test here; the readout window paints through fillRect/strokeRect/fillText,
 * which record nothing, so every entry in `strokes` is geometry.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; strokes: Stroke[] } {
  const strokes: Stroke[] = [];
  let path = new RecordingPath();
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
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
    measureText: () => ({ width: 48 }),
    beginPath(): void {
      path = new RecordingPath();
    },
    moveTo(x: number, y: number): void {
      path.moveTo(x, y);
    },
    lineTo(x: number, y: number): void {
      path.lineTo(x, y);
    },
    stroke(p?: RecordingPath): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        segments: [...(p ?? path).segments],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes };
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
  ratio: 0.8,
  spacing: 64,
  dropRate: 120,
  maxDrops: 20_000,
  showAngle: false,
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
  const instance = buffon.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

/** dropRate 120 with the 120 Hz tick is exactly one needle per step. */
function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with the stroke log cleared first so it holds exactly that frame. */
function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
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
function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

/** The centre of every needle painted in the last frame. */
function needleCentres(v: Viz): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const stroke of v.fg.strokes) {
    for (const [x0, y0, x1, y1] of stroke.segments) out.push([(x0 + x1) / 2, (y0 + y1) / 2]);
  }
  return out;
}

describe('buffon instance: readouts', () => {
  it('publishes every number it draws, with the analytic targets, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 2_000);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['drops', 'crossings', 'fraction', 'pi', 'se']);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['drops']?.value).toBe(2_000);
    expect(by['fraction']?.target).toBeCloseTo(P, 12);
    expect(by['pi']?.target).toBe(Math.PI);
    // 2,000 drops: SE of π̂ is 0.069, so 0.28 is 4σ.
    expect(Math.abs((by['pi']?.value ?? 0) - Math.PI)).toBeLessThan(0.28);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('draws without mutating the simulation, and resets to an empty field', () => {
    const v = stubViz();
    tick(v, 500);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['drops']).toBe(0);
    expect(ledger(v)['crossings']).toBe(0);
    v.instance.destroy();
  });
});

describe('buffon instance: maxDrops', () => {
  /** Drops and crossings after `steps` ticks of a fresh instance at this ceiling. */
  function fresh(maxDrops: number, steps: number): Record<string, number> {
    const v = stubViz({ maxDrops });
    tick(v, steps);
    paint(v);
    return ledger(v);
  }

  it('absorbs a raise as a prefix continuation, byte-identical to a fresh run', () => {
    const v = stubViz({ maxDrops: 1_000 });
    tick(v, 1_200);
    paint(v);
    expect(ledger(v)['drops']).toBe(1_000);

    expect(setParam(v, 'maxDrops', 5_000)).toBe(true);
    tick(v, 4_000);
    paint(v);
    // The first 1,000 needles are the first 1,000 of the longer run, and the rng
    // picked up where it left off, so the ledger must match a fresh 5,000.
    expect(ledger(v)).toEqual(fresh(5_000, 5_000));
  });

  it('resets on a lower ceiling than the drops already counted, so the permalink stays honest', () => {
    const v = stubViz({ maxDrops: 20_000 });
    tick(v, 20_000);
    paint(v);
    expect(ledger(v)['drops']).toBe(20_000);

    // What the shell would then advertise is #/buffon?maxDrops=1000, and that
    // has to be the run on screen — not a 20,000-drop ledger under a 1,000 label.
    expect(setParam(v, 'maxDrops', 1_000)).toBe(false);
    expect(ledger(v)['drops']).toBe(0);
    tick(v, 1_200);
    paint(v);
    expect(ledger(v)['drops']).toBe(1_000);
    expect(ledger(v)).toEqual(fresh(1_000, 1_200));
  });

  it('absorbs a lower ceiling the run has not reached yet: it is still a prefix', () => {
    const v = stubViz({ maxDrops: 20_000 });
    tick(v, 3_000);
    paint(v);
    expect(setParam(v, 'maxDrops', 5_000)).toBe(true);
    expect(ledger(v)['drops']).toBe(3_000);
    tick(v, 3_000);
    paint(v);
    expect(ledger(v)).toEqual(fresh(5_000, 6_000));
  });

  it('absorbs the rate and the overlay, and defers the structural knobs to the shell', () => {
    const v = stubViz();
    tick(v, 240);
    expect(v.instance.onParamChange?.('dropRate', 500)).toBe(true);
    expect(v.instance.onParamChange?.('showAngle', true)).toBe(true);
    expect(v.instance.onParamChange?.('ratio', 0.5)).toBe(false);
    expect(v.instance.onParamChange?.('spacing', 96)).toBe(false);
    expect(v.instance.onParamChange?.('seed', 7)).toBe(false);
  });
});

describe('buffon instance: resize', () => {
  it('leaves the counters and the estimate untouched', () => {
    const v = stubViz({}, 720, 448);
    tick(v, 3_000);
    paint(v);
    const before = ledger(v);

    resize(v, 360, 300);
    expect(ledger(v)).toEqual(before);
    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);
  });

  it('re-lays-out the needles already down instead of stranding them', () => {
    const v = stubViz({}, 400, 256);
    tick(v, 500);
    paint(v);

    // A 1,200 × 640 plate affords every needle the ring holds.
    resize(v, 1_200, 640);
    const centres = needleCentres(v);
    expect(centres).toHaveLength(500);
    const xs = centres.map(([x]) => x);
    const ys = centres.map(([, y]) => y);
    // The whole new plate is used: 500 uniform draws leave the outermost within
    // ~1% of each edge with overwhelming probability, so 5% is slack, not luck.
    expect(Math.min(...xs)).toBeLessThan(0.05 * 1_200);
    expect(Math.max(...xs)).toBeGreaterThan(0.95 * 1_200);
    // 640 px at d = 64 is ten whole strips filling the plate exactly.
    expect(Math.min(...ys)).toBeLessThan(0.05 * 640);
    expect(Math.max(...ys)).toBeGreaterThan(0.95 * 640);

    // …and shrinking puts every needle it still paints inside the smaller plate.
    resize(v, 300, 200);
    const small = needleCentres(v);
    expect(small.length).toBeGreaterThan(0);
    for (const [x, y] of small) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(200);
    }
  });

  it('keeps every needle centre inside a ruled strip after a resize', () => {
    const v = stubViz({}, 720, 448);
    tick(v, 400);
    resize(v, 500, 500);
    const { rows, originY } = layoutField(500, 64, 1);
    for (const [, y] of needleCentres(v)) {
      expect(y).toBeGreaterThanOrEqual(originY);
      expect(y).toBeLessThanOrEqual(originY + rows * 64);
    }
  });

  it('rules the plate edge to edge when its height is an exact multiple of the spacing', () => {
    // 1400 px window → 716 × 448 plate: seven strips, eight edges, and the last
    // one used to be painted one pixel row past the bottom of the canvas.
    const v = stubViz({}, 716, 448);
    v.bg.strokes.length = 0;
    resize(v, 716, 448);
    const rules = v.bg.strokes.flatMap((s) => s.segments);
    expect(rules).toHaveLength(8);
    for (const [, y0, , y1] of rules) {
      expect(y0).toBe(y1);
      expect(y0 - 0.5).toBeGreaterThanOrEqual(0);
      expect(y0 + 0.5).toBeLessThanOrEqual(448);
    }
  });

  it('gives the same crossings on any plate, so a permalink survives the recipient’s window', () => {
    // Crossing is decided by the draws, never by the layout. Two windows, one
    // seed, one ledger.
    const wide = stubViz({}, 1_280, 720);
    const narrow = stubViz({}, 320, 200);
    for (const v of [wide, narrow]) {
      tick(v, 4_000);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
    expect(ledger(wide)['crossings']).toBeGreaterThan(1_800);
  });
});

describe('buffon instance: ink', () => {
  /** What the painted needles cover: N randomly placed marks of area a ink 1 − exp(−N·a/A). */
  function inkFraction(v: Viz): number {
    let area = 0;
    for (const s of v.fg.strokes) {
      for (const [x0, y0, x1, y1] of s.segments) area += Math.hypot(x1 - x0, y1 - y0) * s.width;
    }
    return 1 - Math.exp(-area / (v.ctx.width * v.ctx.height));
  }

  it('holds the ink well under saturation at every drop count, plate and overlay', () => {
    // The "Two hundred thousand" preset. 8,000 drops is already where the old
    // 20,000-needle field painted a solid vermilion mass over the floorboards:
    // 8,000 × 102 px² over a 720 × 448 plate is 95% coverage.
    const steps = Math.round((8_000 * 1_000) / (2_000 * TICK));
    const plates: ReadonlyArray<[number, number]> = [
      [720, 448],
      [1_280, 720],
      [343, 343], // the phone square, from `aspectNarrow`
    ];
    for (const [width, height] of plates) {
      for (const showAngle of [false, true]) {
        const v = stubViz({ dropRate: 2_000, maxDrops: 200_000, showAngle }, width, height);
        tick(v, steps);
        paint(v);
        expect(ledger(v)['drops']).toBeGreaterThan(7_900);
        const painted = needleCentres(v).length;
        expect(painted).toBeLessThanOrEqual(buffon.budget?.maxEntities ?? 0);
        expect(painted).toBeGreaterThan(50);
        expect(inkFraction(v), `${width}×${height} showAngle=${showAngle}`).toBeLessThan(0.3);
      }
    }
  });

  it('paints fewer needles on a smaller plate rather than a denser picture', () => {
    const small = stubViz({}, 360, 300);
    const large = stubViz({}, 1_280, 720);
    for (const v of [small, large]) {
      tick(v, 600);
      paint(v);
    }
    // The big plate affords everything the ring holds; the phone-sized one does not.
    expect(needleCentres(large)).toHaveLength(buffon.budget?.maxEntities ?? 0);
    expect(needleCentres(small).length).toBeLessThan(needleCentres(large).length);
    // All 600 on that small plate would ink 43% of it — this is the difference.
    expect(1 - Math.exp((-600 * 0.8 * 64 * 2) / (360 * 300))).toBeGreaterThan(0.4);
    expect(inkFraction(small)).toBeLessThan(0.25);
  });

  it('paints every needle at full strength: no globalAlpha, and never under 2 px', () => {
    for (const showAngle of [false, true]) {
      const v = stubViz({ showAngle });
      tick(v, 1_000);
      paint(v);
      const strokes = v.fg.strokes.filter((s) => s.segments.length > 0);
      expect(strokes.length).toBeGreaterThan(0);
      for (const s of strokes) {
        // A translucent pen composites through the 4.5:1 the canvas foreground
        // owes the plate — the vermilion is 4.80:1 solid and 1.46:1 at α = 0.25.
        expect(s.alpha, `alpha at showAngle=${showAngle}`).toBe(1);
        expect(s.width).toBeGreaterThanOrEqual(2 * THEME.lineWidth);
        expect([THEME.inkMuted, THEME.data1]).toContain(s.pen);
      }
    }
  });

  it('encodes |sin θ| as weight only when the overlay is on', () => {
    const off = stubViz({ showAngle: false });
    tick(off, 1_000);
    paint(off);
    expect(new Set(off.fg.strokes.map((s) => s.width))).toEqual(new Set([2 * THEME.lineWidth]));

    const on = stubViz({ showAngle: true });
    tick(on, 1_000);
    paint(on);
    const widths = [...new Set(on.fg.strokes.map((s) => s.width))].sort((a, b) => a - b);
    expect(widths.length).toBeGreaterThan(4);
    expect(widths[0]).toBe(2 * THEME.lineWidth);
    expect(widths[widths.length - 1]).toBe(4 * THEME.lineWidth);
  });

  it('paints crossings over misses', () => {
    const v = stubViz();
    tick(v, 1_000);
    paint(v);
    const pens = v.fg.strokes.filter((s) => s.segments.length > 0).map((s) => s.pen);
    expect(pens.lastIndexOf(THEME.inkMuted)).toBeLessThan(pens.indexOf(THEME.data1));
  });
});

describe('buffon metadata', () => {
  it('declares every parameter the contract needs, with a seed', () => {
    expect(buffon.params.map((p) => p.key)).toEqual([
      'ratio',
      'spacing',
      'dropRate',
      'maxDrops',
      'showAngle',
      'seed',
    ]);
    expect(buffon.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
  });

  it('sets every preset value from a declared parameter', () => {
    for (const preset of buffon.presets ?? []) {
      for (const key of Object.keys(preset.values)) {
        expect(buffon.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
    }
  });

  it('sources every fact', () => {
    expect(buffon.facts.length).toBeGreaterThanOrEqual(3);
    for (const fact of buffon.facts) {
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });
});
