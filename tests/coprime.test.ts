import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import { bandOf, verdictOf } from '../src/ui/readouts';
import {
  checkRateFor,
  checkTarget,
  coprime,
  layoutOrchard,
  paintEveryFor,
  sideTarget,
  treeX,
  treeY,
} from '../src/viz/coprime/index';
import {
  BIAS_COEFFICIENT,
  CheckLog,
  FRACTION_SE_COEFFICIENT,
  Orchard,
  PI_SENSITIVITY,
  PI_SE_COEFFICIENT,
  VISIBLE_FRACTION,
  drawPair,
  fractionStandardError,
  gcd,
  isVisible,
  orchardBias,
  piFromFraction,
  piStandardError,
} from '../src/viz/coprime/lattice';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** The tab's ceilings, which are module constants rather than parameters. */
const MAX_SIDE = 100;
const MAX_CHECKS = 200_000;
const MAX_RAYS = 64;

// ---------------------------------------------------------------------------
// The mathematics
// ---------------------------------------------------------------------------

/** Σ_{k≤n} φ(k), by a sieve — the independent route to the exact visible count. */
function totientSum(n: number): number {
  const phi = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) phi[i] = i;
  for (let i = 2; i <= n; i++) {
    if (phi[i] === i) {
      for (let j = i; j <= n; j += i) phi[j] = (phi[j] ?? 0) - (phi[j] ?? 0) / i;
    }
  }
  let sum = 0;
  for (let k = 1; k <= n; k++) sum += phi[k] ?? 0;
  return sum;
}

/** Lattice points strictly between the origin and (x, y). Should be gcd(x, y) − 1. */
function pointsBetween(x: number, y: number): number {
  let count = 0;
  for (let k = 1; k < Math.max(x, y); k++) {
    const px = (k * x) / Math.max(x, y);
    const py = (k * y) / Math.max(x, y);
    if (Number.isInteger(px) && Number.isInteger(py) && (px > 0 || py > 0) && (px < x || py < y)) count++;
  }
  return count;
}

describe('the lattice', () => {
  it('hides a tree exactly when a lattice point stands between it and the eye', () => {
    // The geometric statement the tab is built on, checked against the
    // arithmetic one on every tree of a 40 × 40 corner.
    let disagreements = 0;
    for (let x = 1; x <= 40; x++) {
      for (let y = 1; y <= 40; y++) {
        if (pointsBetween(x, y) !== gcd(x, y) - 1) disagreements++;
        if (isVisible(x, y) !== (pointsBetween(x, y) === 0)) disagreements++;
      }
    }
    expect(disagreements).toBe(0);
  });

  it('puts the blocking tree at (x/g, y/g), the nearest lattice point on the ray', () => {
    for (const [x, y] of [[6, 4], [12, 18], [35, 21], [100, 75]] as const) {
      const g = gcd(x, y);
      expect(g).toBeGreaterThan(1);
      // The blocker is on the ray…
      expect((x / g) * y).toBe((y / g) * x);
      // …strictly nearer…
      expect(x / g).toBeLessThan(x);
      // …and itself in view, so nothing stands between it and the eye.
      expect(isVisible(x / g, y / g)).toBe(true);
    }
  });

  it('agrees with Euclid on the usual corner cases', () => {
    expect(gcd(1, 1)).toBe(1);
    expect(gcd(7, 7)).toBe(7);
    expect(gcd(13, 1)).toBe(1);
    expect(gcd(270, 192)).toBe(6);
    expect(gcd(17, 19)).toBe(1);
  });
});

describe('the constants', () => {
  it('is 6/π² = 1/ζ(2), and π comes back out of it', () => {
    expect(VISIBLE_FRACTION).toBe(6 / Math.PI ** 2);
    expect(VISIBLE_FRACTION).toBeCloseTo(0.6079271018540266, 15);
    expect(piFromFraction(VISIBLE_FRACTION)).toBeCloseTo(Math.PI, 12);
  });

  it('carries the delta-method coefficients the readouts spend', () => {
    // sd(p̂) = √(P(1−P))/√N.
    expect(FRACTION_SE_COEFFICIENT).toBeCloseTo(0.48821, 5);
    // |dπ/dp| at p = 6/π² is exactly π³/12.
    expect(PI_SENSITIVITY).toBeCloseTo(2.58386, 5);
    expect(PI_SENSITIVITY).toBeCloseTo(0.5 * Math.sqrt(6) * VISIBLE_FRACTION ** -1.5, 12);
    // …so sd(π̂) = 1.26147/√N, the number docs/VISUALIZATIONS.md quotes.
    expect(PI_SE_COEFFICIENT).toBeCloseTo(1.26147, 5);
    expect(piStandardError(1e4)).toBeCloseTo(0.0126, 4);
    expect(piStandardError(1e5)).toBeCloseTo(0.00399, 5);
    expect(piStandardError(1e6)).toBeCloseTo(0.00126, 5);
  });

  it('shrinks both standard errors as 1/√N', () => {
    expect(piStandardError(1_000) / piStandardError(4_000)).toBeCloseTo(2, 12);
    expect(fractionStandardError(1_000) / fractionStandardError(4_000)).toBeCloseTo(2, 12);
  });
});

describe('Orchard: the exact count', () => {
  it('counts the visible trees of [1, n]² as 2·Φ(n) − 1', () => {
    const orchard = new Orchard(MAX_SIDE);
    for (let n = 1; n <= MAX_SIDE; n++) {
      orchard.setSide(n);
      expect(orchard.side, `n=${n}`).toBe(n);
      expect(orchard.trees, `n=${n}`).toBe(n * n);
      expect(orchard.visible, `n=${n}`).toBe(2 * totientSum(n) - 1);
    }
  });

  it('lands on the textbook small cases', () => {
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(1);
    expect(orchard.fraction).toBe(1);
    // (1,1) (1,2) (2,1) are in view; (2,2) hides behind (1,1).
    orchard.setSide(2);
    expect(orchard.visible).toBe(3);
    expect(orchard.fraction).toBe(0.75);
    orchard.setSide(10);
    expect(orchard.fraction).toBe(0.63);
  });

  it('marks a tree visible exactly where gcd says so, and nothing outside the corner', () => {
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(37);
    let wrong = 0;
    for (let x = 1; x <= 37; x++) {
      for (let y = 1; y <= 37; y++) if (orchard.visibleAt(x, y) !== isVisible(x, y)) wrong++;
    }
    expect(wrong).toBe(0);
    for (const [x, y] of [[0, 1], [1, 0], [38, 1], [1, 38], [-3, 4]] as const) {
      expect(orchard.visibleAt(x, y), `${x},${y}`).toBe(false);
    }
  });

  it('clamps to the side the mask was allocated for, and re-setting the same side changes nothing', () => {
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE + 500);
    expect(orchard.side).toBe(MAX_SIDE);
    const before = orchard.visible;
    orchard.setSide(MAX_SIDE);
    expect(orchard.visible).toBe(before);
    orchard.setSide(0);
    expect(orchard.side).toBe(1);
  });

  it('sits within the log n / n bound of 6/π² at every side the tab offers', () => {
    // Φ(n) = 3n²/π² + O(n log n), so the share is 6/π² + O(log n / n). The
    // module fixes the constant at 0.5; this is the assertion that the bound
    // holds, and that it is not vacuous — the worst case must be within a
    // factor of two of it, or the bound has stopped saying anything.
    const orchard = new Orchard(MAX_SIDE);
    let worst = 0;
    let worstAt = 0;
    for (let n = 10; n <= MAX_SIDE; n++) {
      orchard.setSide(n);
      const gap = Math.abs(orchard.fraction - VISIBLE_FRACTION);
      expect(gap, `n=${n}`).toBeLessThan(orchardBias(n));
      const ratio = (gap * n) / Math.log(n);
      if (ratio > worst) {
        worst = ratio;
        worstAt = n;
      }
    }
    expect(worst, `worst at n=${worstAt}`).toBeGreaterThan(0.5 * BIAS_COEFFICIENT);
    // Measured: 0.368, at n = 13.
    expect(worst).toBeCloseTo(0.368, 3);
    expect(worstAt).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

/** Check `checks` trees of an `n` × `n` corner from `seed`, exactly as `step()` does. */
function run(seed: number, n: number, checks: number): { share: number; pi: number; visible: number } {
  const rng = createRng(seed);
  let visible = 0;
  for (let i = 0; i < checks; i++) if (drawPair(rng, n).divisor === 1) visible++;
  const share = visible / checks;
  return { share, pi: piFromFraction(share), visible };
}

describe('coprime convergence', () => {
  it('reaches the corner’s own exact share within 4σ at 200,000 checks', () => {
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE);
    const exact = orchard.fraction;
    const { share } = run(SEED, MAX_SIDE, MAX_CHECKS);
    // The checks sample the 100 × 100 corner with replacement, so what they
    // estimate is that corner's own share, not 6/π². A proportion over 200,000
    // draws has sd = √(p(1−p)/N) = 0.00109; 0.0044 is 4σ.
    const sd = Math.sqrt((exact * (1 - exact)) / MAX_CHECKS);
    expect(sd).toBeCloseTo(0.00109, 5);
    expect(Math.abs(share - exact)).toBeLessThan(4 * sd);
  });

  it('reaches 6/π² within the sampling spread plus the corner’s own known gap', () => {
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE);
    // The corner is finite, so its share is 6/π² plus a bias that no amount of
    // checking removes. It is exactly countable, so it is added to the 4σ
    // sampling allowance rather than guessed at: 4 × 0.00109 + 0.00077.
    const bias = Math.abs(orchard.fraction - VISIBLE_FRACTION);
    expect(bias).toBeCloseTo(0.00077, 5);
    const allowance = 4 * fractionStandardError(MAX_CHECKS) + bias;
    const { share, pi } = run(SEED, MAX_SIDE, MAX_CHECKS);
    expect(Math.abs(share - VISIBLE_FRACTION)).toBeLessThan(allowance);
    // …and the same allowance carried into π through |dπ/dp| = π³/12.
    expect(Math.abs(pi - Math.PI)).toBeLessThan(PI_SENSITIVITY * allowance);
  });

  it('holds at ten thousand checks too, where the spread is three times wider', () => {
    const { share } = run(SEED, MAX_SIDE, 10_000);
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE);
    const allowance = 4 * fractionStandardError(10_000) + Math.abs(orchard.fraction - VISIBLE_FRACTION);
    expect(fractionStandardError(10_000)).toBeCloseTo(0.004882, 6);
    expect(Math.abs(share - VISIBLE_FRACTION)).toBeLessThan(allowance);
  });

  it('cannot beat the corner it is looking at, however long it runs', () => {
    // Forty a side is 0.65% high whatever the check count, which is why the
    // headline's tolerance is statistical only: folding this in would print
    // agreement on a reading that is honestly out.
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(40);
    const { share } = run(SEED, 40, 100_000);
    expect(Math.abs(share - orchard.fraction)).toBeLessThan(4 * fractionStandardError(100_000));
    expect(piFromFraction(orchard.fraction)).toBeCloseTo(3.13144, 5);
  });

  it('reproduces a run from a seed and differs between seeds', () => {
    expect(run(SEED, MAX_SIDE, 20_000)).toEqual(run(SEED, MAX_SIDE, 20_000));
    expect(run(1, MAX_SIDE, 20_000).visible).not.toBe(run(2, MAX_SIDE, 20_000).visible);
  });

  it('spends exactly two draws per check, x then y, whatever the side is', () => {
    const a = createRng(9);
    const b = createRng(9);
    for (let i = 0; i < 2_000; i++) {
      const check = drawPair(a, 50);
      expect(check.x).toBe(b.int(1, 50));
      expect(check.y).toBe(b.int(1, 50));
      expect(check.divisor).toBe(gcd(check.x, check.y));
    }
    // Two sides, one seed, one draw count: the stream is not consulted about
    // how big the corner is, so a permalink survives a change of side.
    const small = createRng(5);
    const large = createRng(5);
    for (let i = 0; i < 500; i++) {
      drawPair(small, 10);
      drawPair(large, 100);
    }
    expect(small.next()).toBe(large.next());
  });

  it('draws every coordinate in [1, n] and covers the corner', () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    let outside = 0;
    for (let i = 0; i < 20_000; i++) {
      const { x, y } = drawPair(rng, 12);
      if (x < 1 || x > 12 || y < 1 || y > 12) outside++;
      seen.add(x);
      seen.add(y);
    }
    expect(outside).toBe(0);
    expect(seen.size).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// CheckLog
// ---------------------------------------------------------------------------

describe('CheckLog', () => {
  const check = (x: number, y: number) => ({ x, y, divisor: gcd(x, y) });

  it('keeps only the newest kept entries but counts every check', () => {
    const log = new CheckLog(3);
    for (let i = 1; i <= 10; i++) log.record(check(i, 6), true);
    expect(log.capacity).toBe(3);
    expect(log.count).toBe(3);
    expect(log.checks).toBe(10);
    // gcd(i, 6) = 1 for i in {1, 5, 7}.
    expect(log.visible).toBe(3);
    const xs: number[] = [];
    log.forEach((x) => xs.push(x));
    expect(xs).toEqual([8, 9, 10]);
  });

  it('counts an unkept check without painting it, which is the whole point of the flag', () => {
    const log = new CheckLog(8);
    for (let i = 1; i <= 100; i++) log.record(check(i, 7), i % 25 === 0);
    expect(log.checks).toBe(100);
    expect(log.count).toBe(4);
    // Multiples of 7 up to 100 are the only ones sharing a factor: 14 of them.
    expect(log.visible).toBe(100 - 14);
    expect(log.fraction).toBeCloseTo(0.86, 12);
  });

  it('visits oldest first with a chronological index', () => {
    const log = new CheckLog(3);
    for (let i = 1; i <= 3; i++) log.record(check(i, 1), true);
    const seen: number[] = [];
    log.forEach((x, _y, _d, index) => {
      seen.push(index);
      expect(x).toBe(index + 1);
    });
    expect(seen).toEqual([0, 1, 2]);
    // `from` drops the oldest, which is what the ink budget does.
    const kept: number[] = [];
    log.forEach((x) => kept.push(x), 2);
    expect(kept).toEqual([3]);
  });

  it('reset clears the sight lines and the counters', () => {
    const log = new CheckLog(4);
    for (let i = 1; i <= 20; i++) log.record(check(i, 4), true);
    log.reset();
    expect(log.count).toBe(0);
    expect(log.checks).toBe(0);
    expect(log.visible).toBe(0);
    expect(log.fraction).toBeNaN();
  });

  it('never allocates below one slot', () => {
    const log = new CheckLog(0);
    log.record(check(2, 4), true);
    log.record(check(3, 5), true);
    expect(log.count).toBe(1);
    expect(log.checks).toBe(2);
    expect(log.visible).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('layoutOrchard', () => {
  it('keeps every tree and the eye inside the plate at every side and plate shape', () => {
    const plates: ReadonlyArray<readonly [number, number]> = [
      [506, 440],
      [1_280, 720],
      [343, 361],
      [200, 200],
    ];
    for (const [width, height] of plates) {
      for (const n of [10, 37, 60, MAX_SIDE]) {
        const g = layoutOrchard(width, height, n);
        expect(g.dotRadius, `${width}×${height} n=${n}`).toBeGreaterThanOrEqual(1.5);
        for (const i of [0, 1, n]) {
          for (const j of [0, 1, n]) {
            const r = i === 0 && j === 0 ? g.eyeRadius : g.dotRadius;
            const x = treeX(g, i);
            const y = treeY(g, j);
            expect(x - r, `${width}×${height} n=${n} at ${i},${j}`).toBeGreaterThanOrEqual(0);
            expect(x + r).toBeLessThanOrEqual(width);
            expect(y - r).toBeGreaterThanOrEqual(0);
            expect(y + r).toBeLessThanOrEqual(height);
          }
        }
      }
    }
  });

  it('puts the eye at the bottom-left, with x running right and y running up', () => {
    const g = layoutOrchard(506, 440, 40);
    expect(treeX(g, 0)).toBeLessThan(treeX(g, 40));
    expect(treeY(g, 0)).toBeGreaterThan(treeY(g, 40));
    expect(treeX(g, 5) - treeX(g, 4)).toBeCloseTo(g.spacing, 12);
  });

  it('takes the square from the shorter side of the plate', () => {
    expect(layoutOrchard(1_280, 440, 50).side).toBe(440 - 16);
    expect(layoutOrchard(400, 900, 50).side).toBe(400 - 16);
  });
});

describe('pacing', () => {
  it('finishes a run in about fifteen seconds, between a floor and a ceiling', () => {
    expect(checkRateFor(20_000)).toBeCloseTo(20_000 / 15, 9);
    expect(checkRateFor(200)).toBe(20);
    expect(checkRateFor(MAX_CHECKS)).toBe(4_000);
  });

  it('paints about eighteen sight lines a second whatever the check rate is', () => {
    for (const checks of [200, 2_000, 20_000, MAX_CHECKS]) {
      const rate = checkRateFor(checks);
      const painted = rate / paintEveryFor(rate);
      expect(painted, `checks=${checks}`).toBeGreaterThan(12);
      expect(painted, `checks=${checks}`).toBeLessThan(28);
    }
  });

  it('clamps the parameters the way the instance does', () => {
    expect(sideTarget({ size: 1 })).toBe(10);
    expect(sideTarget({ size: 5_000 })).toBe(MAX_SIDE);
    expect(sideTarget({})).toBe(MAX_SIDE);
    expect(checkTarget({ checks: 1e9 })).toBe(MAX_CHECKS);
    expect(checkTarget({ checks: -4 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];
interface Disc {
  pen: string;
  x: number;
  y: number;
  r: number;
}
interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  segments: readonly Seg[];
}

/**
 * A canvas context that records the arcs it fills, the segments it strokes and
 * the text it writes, and accepts everything else. The trees, the sight lines
 * and the one number on the plate are what is under test; the window's own
 * plate and frame go through fillRect/strokeRect, which record nothing.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  discs: Disc[];
  texts: string[];
} {
  const strokes: Stroke[] = [];
  const discs: Disc[] = [];
  const texts: string[] = [];
  let segments: Seg[] = [];
  let arcs: Array<[number, number, number]> = [];
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
    save: () => undefined,
    restore: () => undefined,
    // A fixed advance per glyph: the window's box must come from a constant
    // string, so the only thing a test needs of this is that it is stable.
    measureText: (text: string) => ({ width: 6.6 * text.length }),
    fillText: (text: string) => {
      texts.push(text);
    },
    beginPath(): void {
      segments = [];
      arcs = [];
    },
    moveTo(mx: number, my: number): void {
      x = mx;
      y = my;
    },
    lineTo(lx: number, ly: number): void {
      segments.push([x, y, lx, ly]);
      x = lx;
      y = ly;
    },
    arc(cx: number, cy: number, r: number): void {
      arcs.push([cx, cy, r]);
    },
    fill(): void {
      for (const [cx, cy, r] of arcs) discs.push({ pen: String(api.fillStyle), x: cx, y: cy, r });
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
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, discs, texts };
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

const DEFAULTS: Record<string, ParamValue> = { size: MAX_SIDE, checks: 20_000, seed: SEED };

function stubViz(overrides: Record<string, ParamValue> = {}, width = 506, height = 440) {
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
  const instance = coprime.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** Run until the ledger reports `checks` trees checked, then paint one frame. */
function until(v: Viz, checks: number): void {
  const rate = checkRateFor(checkTarget(v.ctx.params));
  tick(v, Math.ceil((checks * 1000) / (rate * TICK)));
  paint(v);
}

/** One frame, with the stroke log cleared first so it holds exactly that frame. */
function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.fg.discs.length = 0;
  v.fg.texts.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.discs.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Exactly what src/main.ts does on a resize. */
function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.discs.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

/** The last emitted frame, keyed — what the ledger is handed, bands and all. */
function rows(v: Viz): Record<string, Readout | undefined> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r]));
}

/** One configuration, run for `checks` checks, as keyed readouts. */
function rowsAfter(params: Record<string, ParamValue>, checks: number): Record<string, Readout | undefined> {
  const v = stubViz(params);
  until(v, checks);
  return rows(v);
}

/** The sight lines painted in the last frame, halo strokes and all. */
function rays(v: Viz): Seg[] {
  return v.fg.strokes.flatMap((s) => s.segments);
}

describe('coprime instance: readouts', () => {
  it('publishes every number it draws, with the analytic targets, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) until(v, 5_000);
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual([
      'checked',
      'share',
      'pi',
      'picture',
      'lit',
      'trees',
      'picturePi',
      'se',
    ]);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE);
    // The two sampled rows are judged against what they are estimating — this
    // corner's own share, and the π that comes out of it — and the two
    // exhaustive rows against the endless orchard's constants.
    expect(by['share']?.target).toBe(orchard.fraction);
    expect(by['pi']?.target).toBe(piFromFraction(orchard.fraction));
    expect(by['picture']?.target).toBe(VISIBLE_FRACTION);
    expect(by['picturePi']?.target).toBe(Math.PI);
    expect(by['trees']?.value).toBe(MAX_SIDE * MAX_SIDE);
    expect(by['lit']?.value).toBe(2 * totientSum(MAX_SIDE) - 1);
    // 5,000 checks: sd(π̂) is 0.0178, so 0.08 is 4.5σ.
    expect(Math.abs((by['pi']?.value ?? 0) - Math.PI)).toBeLessThan(0.08);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('prints the one number on the plate and publishes the same value', () => {
    const v = stubViz();
    until(v, 5_000);
    const printed = v.fg.texts.at(-1) ?? '';
    expect(printed).toMatch(/^π ≈ \d\.\d{4}$/);
    expect(printed).toBe(`π ≈ ${(ledger(v)['pi'] ?? 0).toFixed(4)}`);
  });

  it('holds the window’s box to one width whatever the reading is', () => {
    // Nothing on this plate may be sized from a number's own text. The em dash
    // before the first check and a four-decimal π afterwards take the same box.
    const v = stubViz();
    paint(v);
    expect(v.fg.texts.at(-1)).toBe('π ≈ —');
    const empty = v.fg.strokes.length;
    until(v, 2_000);
    // Exactly one strokeRect either way — and it is not in `strokes`, which
    // records paths only — so what is asserted here is that the frame is drawn
    // from a constant: the sample string, whose width the recorder fixes.
    expect(v.fg.texts.at(-1)?.length).toBe('π ≈ 3.1416'.length);
    expect(empty).toBe(0);
  });

  it('marks one headline and gives every visible number a plain lower-case label', () => {
    const v = stubViz();
    until(v, 1_000);
    const last = v.emitted.at(-1) ?? [];
    const headline = last.filter((r) => r.headline === true);
    expect(headline.map((r) => r.key)).toEqual(['pi']);
    expect(headline[0]?.plain).toBe('our estimate of pi');
    // The headline is held to the π *this corner* can reach, so the hero prints
    // a prediction of 3.13962 at a hundred a side and 3.08132 at twelve. The
    // hint is what keeps that from reading as a claim about π itself — and it
    // names the constant rather than quoting the prediction, which the verdict
    // line above it is already printing.
    expect(headline[0]?.hint).toMatch(/endless orchard/);
    expect(headline[0]?.hint).not.toContain(String(headline[0]?.target));

    const shown = last.filter((r) => r.expertOnly !== true).map((r) => r.key);
    expect(shown).toEqual(['checked', 'share', 'pi', 'picture']);
    for (const r of last) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('declares a band from the checks in hand, never from the ceiling the fader names', () => {
    // The ceiling is where the run stops; it is not evidence. Taken from it, the
    // bar was the end of the run's bar on every frame before the last — and
    // dragging the fader re-scaled it 32× without a single new check behind it.
    const v = stubViz({ checks: MAX_CHECKS });
    until(v, 5_000);
    const early = rows(v);
    const share = early['share'];
    const pi = early['pi'];
    const orchard = new Orchard(MAX_SIDE);
    orchard.setSide(MAX_SIDE);
    const f = orchard.fraction;
    expect(share?.band).toEqual({ kind: 'sampled', sigma: Math.sqrt(f * (1 - f)), samples: 5_000 });
    // π = √(6/p), so |dπ/dp| = π/2p and sd(π̂) = (π/2)·√((1−p)/p) — which at the
    // endless orchard's share is the 1.26/√N coefficient the module publishes.
    expect(pi?.band).toEqual({
      kind: 'sampled',
      sigma: (piFromFraction(f) / 2) * Math.sqrt((1 - f) / f),
      samples: 5_000,
    });
    expect(PI_SE_COEFFICIENT).toBeCloseTo((Math.PI / 2) * Math.sqrt((1 - VISIBLE_FRACTION) / VISIBLE_FRACTION), 12);
    // One band per reading: a half-migrated row declaring both costs the verdict.
    for (const r of v.emitted.at(-1) ?? []) expect(r.tolerance, r.key).toBeUndefined();

    // Four times the checks, half the band, with the ceiling untouched.
    const half = bandOf(share as Readout);
    expect(half).toBeGreaterThan(0);
    until(v, 15_000);
    const later = rows(v)['share'];
    expect(later?.band).toMatchObject({ samples: 20_000 });
    expect(bandOf(later as Readout)).toBeCloseTo((half ?? 0) / 2, 12);
  });

  it('holds the exactly counted rows to the endless orchard, with the corner’s own bias allowed for', () => {
    // These two are counted tree by tree: no sampling noise, and the allowance
    // is the display decision of how near 6/π² a finite corner has to sit to be
    // reading it. A hundred a side is 0.13% out and agrees; twelve a side is 4%
    // out and says so — and the two rows, which are one count in two
    // coordinates, can no longer reach opposite verdicts about one corner.
    const big = rowsAfter({ size: MAX_SIDE, checks: 2_000 }, 2_000);
    expect(verdictOf(big['picture'] as Readout).state).toBe('agree');
    expect(verdictOf(big['picturePi'] as Readout).state).toBe('agree');

    const small = rowsAfter({ size: 12, checks: 2_000 }, 2_000);
    expect(verdictOf(small['picture'] as Readout).state).not.toBe('agree');
    expect(verdictOf(small['picturePi'] as Readout).state).not.toBe('agree');
    // π's half of the allowance is half the share's, by the same |dπ/dp| = π/2p.
    expect(small['picturePi']?.band).toEqual({ kind: 'absolute', half: 0.005 * Math.PI });
    expect(small['picture']?.band).toEqual({ kind: 'absolute', half: 0.01 * VISIBLE_FRACTION });
  });

  it('never certifies a corner against a limit it cannot reach, however long it runs', () => {
    // The shipped "Small orchard" chip printed "✓ matches the prediction of
    // 3.14159" at 2,000 checks and took it back at 20,000: the bar was
    // statistical and the gap was structural, so the reader was rewarded for
    // gathering less data. Twelve a side converges on √(6·144/91) = 3.08132,
    // and that is what the row is held to at every check count.
    for (const checks of [2_000, 20_000, 200_000]) {
      const by = rowsAfter({ size: 12, checks }, checks);
      const pi = by['pi'] as Readout;
      expect(pi.target, `${checks} checks`).toBeCloseTo(3.08132, 5);
      expect(verdictOf(pi).state, `${checks} checks`).toBe('agree');
      // …and the sentence the reader gets quotes the corner's own limit. The
      // tick is a claim about this orchard and can no longer be read as one
      // about π, whatever the check count does to the width of the band.
      expect(verdictOf(pi).text, `${checks} checks`).toContain('3.08132');
      expect(verdictOf(pi).text, `${checks} checks`).not.toContain('3.14159');
    }
  });

  it('draws without mutating the simulation, and resets to an empty run', () => {
    const v = stubViz();
    until(v, 3_000);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['checked']).toBe(0);
    expect(ledger(v)['pi']).toBeNaN();
    // The picture is still counted: it does not depend on the run at all.
    expect(ledger(v)['lit']).toBe(2 * totientSum(MAX_SIDE) - 1);
    v.instance.destroy();
  });
});

describe('coprime instance: the run', () => {
  it('stops at exactly the ceiling the fader names and stays there', () => {
    const v = stubViz({ checks: 2_000 });
    until(v, 2_000);
    expect(ledger(v)['checked']).toBe(2_000);
    const done = ledger(v);
    tick(v, 5_000);
    paint(v);
    expect(ledger(v)).toEqual(done);
  });

  it('absorbs a new ceiling and keeps the checks already made', () => {
    const v = stubViz({ checks: 2_000 });
    until(v, 2_000);
    const before = ledger(v)['checked'];
    expect(setParam(v, 'checks', 20_000)).toBe(true);
    expect(ledger(v)['checked']).toBe(before);
    tick(v, 600);
    paint(v);
    expect(ledger(v)['checked']).toBeGreaterThan(before ?? 0);
  });

  it('starts over when the ceiling is dragged below the checks already made', () => {
    // A *lowered* ceiling cannot be absorbed: `step()` stops at once, so the old
    // and much sharper run froze under the new label and the ledger went on
    // reporting 20,000 checks while the fader, the caption and the permalink all
    // said 200. Falling through to the shell's reset makes the page and the link
    // it advertises the same run.
    const v = stubViz({ checks: 20_000 });
    until(v, 20_000);
    expect(ledger(v)['checked']).toBeGreaterThan(19_000);
    expect(setParam(v, 'checks', 200)).toBe(false);
    expect(ledger(v)['checked']).toBe(0);
    until(v, 200);
    expect(ledger(v)['checked']).toBe(200);

    const fresh = stubViz({ checks: 200 });
    until(fresh, 200);
    expect(ledger(v)).toEqual(ledger(fresh));
  });

  it('never reports more checks than the fader is set to, drag it where you like', () => {
    const v = stubViz({ checks: MAX_CHECKS });
    for (const checks of [50_000, 200, 2_000, MAX_CHECKS, 1_000]) {
      setParam(v, 'checks', checks);
      until(v, checks);
      expect(ledger(v)['checked'], `checks=${checks}`).toBeLessThanOrEqual(checkTarget({ checks }));
    }
  });

  it('resets on the side and the seed, so each is a fresh experiment', () => {
    for (const [key, value] of [['size', 40], ['seed', 7]] as const) {
      const v = stubViz();
      until(v, 3_000);
      expect(setParam(v, key, value), key).toBe(false);
      expect(ledger(v)['checked'], key).toBe(0);
      until(v, 3_000);

      const fresh = stubViz({ [key]: value });
      until(fresh, 3_000);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('checks only trees inside the corner it is drawing', () => {
    const v = stubViz({ size: 12, checks: 2_000 });
    until(v, 400);
    const g = layoutOrchard(506, 440, 12);
    for (const [, , x1, y1] of rays(v)) {
      // Every sight line ends on a lattice point of the drawn corner.
      const i = Math.round((x1 - g.originX) / g.spacing);
      const j = Math.round((g.originY - y1) / g.spacing);
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(12);
      expect(j).toBeGreaterThanOrEqual(1);
      expect(j).toBeLessThanOrEqual(12);
      expect(treeX(g, i)).toBeCloseTo(x1, 6);
      expect(treeY(g, j)).toBeCloseTo(y1, 6);
    }
  });

  it('ends a blocked sight line on the tree doing the blocking', () => {
    const v = stubViz({ size: 40, checks: 20_000 });
    until(v, 2_000);
    const g = layoutOrchard(506, 440, 40);
    const blocked = v.fg.strokes.filter((s) => s.pen === THEME.inkMuted && s.segments.length > 0);
    expect(blocked.length).toBeGreaterThan(0);
    for (const s of blocked) {
      for (const [, , x1, y1] of s.segments) {
        const i = Math.round((x1 - g.originX) / g.spacing);
        const j = Math.round((g.originY - y1) / g.spacing);
        // The blocker is the nearest lattice point on its own ray, so it is
        // itself in view. A muted line ending on a hidden tree would mean the
        // painter stopped at the wrong place.
        expect(isVisible(i, j), `${i},${j}`).toBe(true);
      }
    }
  });
});

describe('coprime instance: the plate', () => {
  it('paints every tree once, in the right pen, on the background layer', () => {
    const v = stubViz({ size: 20 });
    const trees = v.bg.discs.filter((d) => d.pen !== THEME.grid);
    expect(trees).toHaveLength(400);
    const lit = trees.filter((d) => d.pen === THEME.data1).length;
    expect(lit).toBe(2 * totientSum(20) - 1);
    expect(trees.filter((d) => d.pen === THEME.data3)).toHaveLength(400 - lit);
    // The eye, and only the eye, takes the apparatus pen.
    expect(v.bg.discs.filter((d) => d.pen === THEME.grid)).toHaveLength(1);
    // Nothing is painted with a colour that is not a theme token.
    const pens = new Set(v.bg.discs.map((d) => d.pen));
    expect([...pens].every((p) => Object.values(THEME).includes(p))).toBe(true);
  });

  it('never draws a tree below the 1.5 px the signal pen needs', () => {
    for (const n of [10, 40, MAX_SIDE]) {
      const v = stubViz({ size: n }, 343, 361);
      for (const d of v.bg.discs) expect(d.r, `n=${n}`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('holds the sight lines under the ink budget on every plate', () => {
    // N marks of area a on a plate of area A cover 1 − exp(−N·a/A).
    const plates: ReadonlyArray<readonly [number, number]> = [
      [506, 440],
      [1_280, 720],
      [343, 361],
    ];
    for (const [width, height] of plates) {
      const v = stubViz({ size: 40 }, width, height);
      until(v, 10_000);
      let area = 0;
      for (const s of v.fg.strokes) {
        for (const [x0, y0, x1, y1] of s.segments) area += Math.hypot(x1 - x0, y1 - y0) * s.width;
      }
      const g = layoutOrchard(width, height, 40);
      const ink = 1 - Math.exp(-area / (g.side * g.side));
      expect(ink, `${width}×${height}`).toBeLessThan(0.35);
      // Halo and pen are two strokes of the same path, so the painted count is
      // half the segments the recorder saw.
      const painted = rays(v).length / 2;
      expect(painted).toBeGreaterThan(4);
      expect(painted).toBeLessThanOrEqual(MAX_RAYS);
    }
  });

  it('paints fewer sight lines on a smaller plate rather than a denser picture', () => {
    const small = stubViz({ size: 40 }, 343, 361);
    const large = stubViz({ size: 40 }, 1_280, 720);
    for (const v of [small, large]) until(v, 10_000);
    expect(rays(small).length).toBeLessThan(rays(large).length);
  });

  it('paints every sight line at full strength and at exactly 2 px, inside its halo', () => {
    const v = stubViz({ size: 40 });
    until(v, 5_000);
    const drawn = v.fg.strokes.filter((s) => s.segments.length > 0);
    expect(drawn.length).toBeGreaterThan(0);
    for (const s of drawn) {
      // A translucent pen composites straight through the plate: the vermilion
      // is 4.80:1 solid and well under 3:1 at any alpha worth the name.
      expect(s.alpha).toBe(1);
      expect([THEME.canvas, THEME.data1, THEME.inkMuted]).toContain(s.pen);
      expect(s.width).toBe(s.pen === THEME.canvas ? 4 : 2);
    }
    // Every pen stroke is preceded by its halo over the same path.
    const halos = drawn.filter((s) => s.pen === THEME.canvas);
    expect(halos).toHaveLength(drawn.length / 2);
  });

  it('keeps the counters and re-places the sight lines when the plate changes size', () => {
    const v = stubViz({ size: 40 }, 506, 440);
    until(v, 6_000);
    const before = ledger(v);

    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);
    const wide = layoutOrchard(1_280, 720, 40);
    for (const [x0, y0, x1, y1] of rays(v)) {
      expect(x0).toBeCloseTo(treeX(wide, 0), 6);
      expect(y0).toBeCloseTo(treeY(wide, 0), 6);
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1_280);
      expect(y1).toBeGreaterThanOrEqual(0);
      expect(y1).toBeLessThanOrEqual(720);
    }

    resize(v, 343, 361);
    expect(ledger(v)).toEqual(before);
    // The trees move with the plate; they are not stranded at old coordinates.
    const narrow = layoutOrchard(343, 361, 40);
    for (const d of v.bg.discs) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(343);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(361);
    }
    expect(v.bg.discs.some((d) => Math.abs(d.x - treeX(narrow, 40)) < 1e-6)).toBe(true);
  });

  it('gives the same ledger on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({ size: 40 }, 1_280, 720);
    const narrow = stubViz({ size: 40 }, 320, 300);
    for (const v of [wide, narrow]) until(v, 8_000);
    expect(ledger(narrow)).toEqual(ledger(wide));
    expect(ledger(wide)['checked']).toBeGreaterThan(7_000);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Prose as the page prints it, for counting sentences. */
function text(prose: Prose): string {
  return typeof prose === 'string' ? prose : prose.map((s) => (typeof s === 'string' ? s : s.v)).join('');
}

/** A full stop followed by a new sentence. A decimal point has no space after it. */
const SECOND_SENTENCE = /[.!?]\s+\S/;

/** Words a sixteen-year-old has not met, and that the simple view must never print. */
const JARGON =
  /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov)\b/i;

describe('coprime metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(coprime.params.map((p) => p.key)).toEqual(['size', 'checks', 'seed']);
    expect(coprime.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(coprime.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    expect(coprime.id).toBe('coprime');
    expect(coprime.group).toBe('numbers');
    expect(coprime.budget?.maxEntities).toBe(MAX_SIDE * MAX_SIDE);
  });

  it('offers at most three presets, each one plain sentence, each from a declared parameter', () => {
    const presets = coprime.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.length).toBeLessThanOrEqual(3);
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      expect(text(preset.caption), preset.id).not.toMatch(JARGON);
      for (const key of Object.keys(preset.values)) {
        expect(coprime.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
    }
    // Ordered to walk to the insight: a corner you can follow by eye, then a
    // pattern, then the number.
    expect(presets.map((p) => p.id)).toEqual(['small-orchard', 'forty-a-side', 'hundred-a-side']);
  });

  it('states at most two facts, one sentence each, and sources both', () => {
    expect(coprime.facts.length).toBeGreaterThan(0);
    expect(coprime.facts.length).toBeLessThanOrEqual(2);
    for (const fact of coprime.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(coprime.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).not.toMatch(JARGON);
    expect(blurb).toMatch(/^Plants /);
  });

  it('spends that sentence on the picture and the surprise, not on what the code does', () => {
    const blurb = text(coprime.blurb);
    // Three things or the line has not earned its place: where the viewer is
    // standing, why a tree goes dark, and the fact that a grid with nothing
    // round anywhere in it still hands back π.
    expect(blurb).toMatch(/corner/i);
    expect(blurb).toMatch(/hide|in front/i);
    expect(blurb).toMatch(/nothing round/i);
    expect(blurb).toContain('π');
  });

  it('keeps the story captions and the facts free of the same words', () => {
    for (const preset of coprime.presets ?? []) expect(text(preset.caption), preset.id).not.toMatch(JARGON);
    for (const fact of coprime.facts) expect(text(fact.text)).not.toMatch(JARGON);
  });

  it('never prints a word a newcomer would have to ask about', () => {
    const v = stubViz();
    until(v, 2_000);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(JARGON);
      expect(r.hint ?? '', r.key).not.toMatch(JARGON);
    }
    for (const p of coprime.params) {
      expect(text(p.help ?? ''), p.key).not.toMatch(JARGON);
    }
  });
});

