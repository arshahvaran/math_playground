import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import {
  BLOCK_SWEEPS,
  BURN_IN_SWEEPS,
  CRITICAL_TEMPERATURE,
  MAX_ROUNDING,
  SpinLattice,
  WINDOW_SWEEPS,
  comparable,
  nearCritical,
  onsagerMagnetisation,
  roundingAllowance,
  roundingHalfWidth,
} from '../src/viz/ising/lattice';
import {
  PAINTED_POINTS,
  SIZES,
  TEMP_MAX,
  TEMP_MIN,
  TEMP_SLOTS,
  ising,
  layoutPlate,
  sizeOf,
  temperatureOf,
} from '../src/viz/ising/index';

/** The engine's tick: 120 Hz, and the tab runs one sweep per tick. */
const TICK = 1000 / 120;

/**
 * A canvas label that opens with a bare symbol — `T = 2.00`, `Tc 2.269`,
 * `m 0.911` — rather than with the words this tab prints instead.
 *
 * `\b` is a word boundary here, and it has to be written as a word boundary: in
 * a string it is U+0008, and a literal backspace byte is what shipped. Nothing
 * on the plate contains one, so the assertion that read it matched nothing,
 * passed unconditionally, and could not have failed whatever the tab drew.
 */
const SYMBOL_LABEL = /^(Tc|T|m)\b/;

/** One complete measurement: the burn-in the readout excludes, then a full window. */
const SETTLE = BURN_IN_SWEEPS + WINDOW_SWEEPS;

const SEED = 42;

/**
 * Onsager's magnetisation at the four temperatures docs/VISUALIZATIONS.md
 * pins, to the digits it pins them to. These are the analytic targets the
 * whole tab is measured against, so they are written out rather than computed
 * a second way.
 */
const ONSAGER: ReadonlyArray<readonly [number, number]> = [
  [1.5, 0.986_500],
  [2.0, 0.911_319],
  [2.1, 0.868_748],
  [2.2, 0.784_755],
];

/** A settled lattice at one temperature and size, started ordered as the tab starts it. */
function settled(size: number, temperature: number, seed = SEED, sweeps = SETTLE): SpinLattice {
  const lattice = new SpinLattice(size, temperature);
  lattice.setSize(size);
  const rng = createRng(seed);
  for (let i = 0; i < sweeps; i++) lattice.sweep(rng);
  return lattice;
}

// ---------------------------------------------------------------------------
// The exact solution
// ---------------------------------------------------------------------------

describe('Onsager', () => {
  it('puts the transition at 2/ln(1 + √2)', () => {
    expect(CRITICAL_TEMPERATURE).toBeCloseTo(2.269_185_314_213_022, 12);
    expect(2 / Math.log(1 + Math.SQRT2)).toBe(CRITICAL_TEMPERATURE);
  });

  it('reproduces the exact magnetisation at every pinned temperature', () => {
    for (const [t, m] of ONSAGER) {
      expect(onsagerMagnetisation(t), `T = ${t}`).toBeCloseTo(m, 6);
    }
  });

  it('is exactly zero at and above the transition, and never NaN just below it', () => {
    expect(onsagerMagnetisation(CRITICAL_TEMPERATURE)).toBe(0);
    expect(onsagerMagnetisation(2.5)).toBe(0);
    expect(onsagerMagnetisation(1e6)).toBe(0);
    // The bracket 1 − sinh(2/T)^−4 crosses zero here, so an unguarded eighth
    // root of a −1e-17 would be NaN rather than a small positive number.
    for (const t of [CRITICAL_TEMPERATURE - 1e-15, CRITICAL_TEMPERATURE - 1e-9, CRITICAL_TEMPERATURE - 1e-4]) {
      const m = onsagerMagnetisation(t);
      expect(Number.isNaN(m), `T = ${t}`).toBe(false);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(1);
    }
  });

  it('falls monotonically from the cold end to the transition', () => {
    let previous = Infinity;
    for (let t = 0.5; t < CRITICAL_TEMPERATURE; t += 0.01) {
      const m = onsagerMagnetisation(t);
      expect(m, `T = ${t}`).toBeLessThanOrEqual(previous);
      previous = m;
    }
  });
});

describe('the finite-size band', () => {
  it('rounds the transition over T_c/L, so a bigger grid rounds it less', () => {
    expect(roundingHalfWidth(64)).toBeCloseTo(CRITICAL_TEMPERATURE / 64, 12);
    // ν = 1 in two dimensions, so the half-width is exactly inverse in L.
    expect(roundingHalfWidth(32) / roundingHalfWidth(128)).toBeCloseTo(4, 12);
    for (const t of [1.8, 2.0, 2.1]) {
      expect(roundingAllowance(t, 128), `T = ${t}`).toBeLessThan(roundingAllowance(t, 32));
    }
  });

  it('withholds the comparison above the transition and inside the rounded band', () => {
    // Above T_c the exact answer is zero and a finite grid never reads zero.
    for (const t of [2.3, 2.5, 3, 3.5]) expect(comparable(t, 64), `T = ${t}`).toBe(false);
    // Well below it the curve is worth comparing against at every size.
    for (const size of SIZES) expect(comparable(2.0, size), `L = ${size}`).toBe(true);
    // And the band narrows as the grid grows: 2.2 is inside it at 32² and
    // outside it at 64².
    expect(comparable(2.2, 32)).toBe(false);
    expect(comparable(2.2, 64)).toBe(true);
  });

  it('calls the tipping point a tipping point on both sides of it', () => {
    for (const size of SIZES) {
      expect(nearCritical(CRITICAL_TEMPERATURE, size), `L = ${size}`).toBe(true);
      // Every slider stop is either compared against the curve or declared too
      // close to the transition to call. A stop below T_c that is neither would
      // be told the exact answer is zero while the curve says it is not.
      for (let k = 0; k < TEMP_SLOTS; k++) {
        const t = TEMP_MIN + k * 0.05;
        if (comparable(t, size) || nearCritical(t, size)) continue;
        expect(onsagerMagnetisation(t), `L = ${size}, T = ${t.toFixed(2)}`).toBe(0);
      }
      // …and far from it the band lets go, so "a little left over" is said only
      // where the reading is in fact a little.
      expect(nearCritical(3, size), `L = ${size}`).toBe(false);
      expect(nearCritical(1.8, size), `L = ${size}`).toBe(false);
    }
  });

  it('never publishes a comparison whose rounding is worth more than a tenth of the reading', () => {
    for (const size of SIZES) {
      for (let t = TEMP_MIN; t <= TEMP_MAX; t += 0.01) {
        if (!comparable(t, size)) continue;
        const m = onsagerMagnetisation(t);
        expect(roundingAllowance(t, size) / m, `L = ${size}, T = ${t}`).toBeLessThanOrEqual(MAX_ROUNDING);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Convergence — the measurement against the curve
// ---------------------------------------------------------------------------

/**
 * The tolerance, derived rather than tuned, and the same expression the tab
 * publishes to the ledger.
 *
 * Two independent errors, added rather than combined in quadrature, because
 * one is a systematic bound and not a spread:
 *
 *  - `roundingAllowance(T, L)` — a finite lattice does not sit on the
 *    infinite-lattice curve at T, it sits on the curve smeared across the
 *    window |T − T_c| ≲ T_c/L that a grid of side L cannot resolve (ξ ~ |t|^−1
 *    with ν = 1, so ξ reaches L at |t| = 1/L). The largest that can displace
 *    the reading is the largest the curve itself moves over that window.
 *  - three standard errors of the time average, taken from the spread of its
 *    block means so the correlation between successive sweeps is inside the
 *    figure rather than ignored by it.
 */
function tolerance(lattice: SpinLattice, temperature: number): number {
  return roundingAllowance(temperature, lattice.size) + 3 * lattice.averageError;
}

describe('ising convergence', () => {
  it('reaches Onsager’s curve at every temperature in the ordered phase', () => {
    for (const [t] of ONSAGER) {
      const lattice = settled(64, t);
      const exact = onsagerMagnetisation(t);
      const tol = tolerance(lattice, t);
      expect(Math.abs(lattice.magnetisation - exact), `T = ${t}`).toBeLessThanOrEqual(tol);
      // …and the tolerance is a real constraint, not a licence: at 64² it is
      // under a seventh of the reading everywhere the tab compares at all.
      expect(tol / exact, `T = ${t}`).toBeLessThan(0.15);
    }
  });

  it('measures the curve more sharply on a bigger grid', () => {
    // Same temperature, same seed, four times the spins: both the rounding and
    // the statistical error shrink, and so does the error actually observed.
    const small = settled(32, 2.0);
    const large = settled(128, 2.0);
    const exact = onsagerMagnetisation(2.0);
    expect(tolerance(large, 2.0)).toBeLessThan(tolerance(small, 2.0));
    expect(Math.abs(large.magnetisation - exact)).toBeLessThan(Math.abs(small.magnetisation - exact));
    expect(Math.abs(large.magnetisation - exact)).toBeLessThanOrEqual(tolerance(large, 2.0));
  });

  it('holds at the hardest temperature the tab still compares at', () => {
    // 2.2 is 0.069 below T_c and the last slider stop inside the band at 64².
    for (const size of [64, 128]) {
      const lattice = settled(size, 2.2);
      const exact = onsagerMagnetisation(2.2);
      expect(Math.abs(lattice.magnetisation - exact), `L = ${size}`).toBeLessThanOrEqual(tolerance(lattice, 2.2));
    }
  });

  it('leaves a 1/L floor above the transition rather than pretending to read zero', () => {
    /*
     * Above T_c the total magnetisation is a sum of L²/ξ² weakly correlated
     * blocks, so it is Gaussian about zero with ⟨M²⟩ = S(T)/L², where
     * S(T) = Σ_r ⟨s₀ s_r⟩ depends on temperature alone. A Gaussian's mean
     * absolute value is √(2/π) times its rms, so
     *
     *   ⟨|M|⟩ = √(2 S(T) / (π L²)),
     *
     * which is inversely proportional to L with no free constant in it.
     * Doubling the lattice must therefore halve the reading. (At T = 4 the
     * measurements below back out S ≈ 4.6; the high-temperature series
     * 1 + 4v + 12v² + 36v³ + … at v = tanh(1/4) gives ≈ 4.9, so the law is
     * checked here and its amplitude is consistent with the series.)
     */
    const floors = SIZES.map((size) => settled(size, 4.0));
    for (const lattice of floors) expect(lattice.magnetisation).toBeGreaterThan(0);
    for (let i = 1; i < floors.length; i++) {
      const coarse = floors[i - 1]!;
      const fine = floors[i]!;
      const predicted = coarse.magnetisation / 2;
      // Three standard errors of the difference, from the two block-mean errors.
      const slack = 3 * Math.hypot(fine.averageError, coarse.averageError / 2);
      expect(Math.abs(fine.magnetisation - predicted), `L = ${fine.size}`).toBeLessThanOrEqual(slack);
    }
  });
});

// ---------------------------------------------------------------------------
// The lattice as a machine
// ---------------------------------------------------------------------------

/** Recount the up spins and the bond sum from the spins themselves. */
function recount(lattice: SpinLattice): { ups: number; energy: number } {
  const L = lattice.size;
  const s = lattice.spins;
  let ups = 0;
  let bonds = 0;
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) {
      const here = s[y * L + x] === 1 ? 1 : -1;
      if (here === 1) ups++;
      const right = s[y * L + ((x + 1) % L)] === 1 ? 1 : -1;
      const down = s[((y + 1) % L) * L + x] === 1 ? 1 : -1;
      // Each bond counted once, from its left and its top end.
      bonds += here * right + here * down;
    }
  }
  return { ups, energy: -bonds / (L * L) };
}

describe('SpinLattice', () => {
  it('starts every spin up, with every bond satisfied', () => {
    const lattice = new SpinLattice(32, 2.0);
    lattice.setSize(32);
    expect(lattice.spinCount).toBe(1024);
    expect(lattice.liveMagnetisation).toBe(1);
    // E = −J Σ⟨ij⟩ sᵢsⱼ over the 2N bonds of a torus, all of them satisfied.
    expect(lattice.energyPerSpin).toBe(-2);
    expect(lattice.magnetisation).toBeNaN();
  });

  it('keeps its running counters in step with the spins it actually holds', () => {
    // The up count and the bond sum are carried by the accepted flips rather
    // than recomputed, so nothing else in the tab is right if these drift.
    const lattice = settled(32, 2.25, 3, 300);
    const brute = recount(lattice);
    expect(lattice.liveMagnetisation).toBeCloseTo(Math.abs((2 * brute.ups) / lattice.spinCount - 1), 12);
    expect(lattice.energyPerSpin).toBeCloseTo(brute.energy, 12);
    expect(lattice.energyPerSpin).toBeGreaterThanOrEqual(-2);
    expect(lattice.energyPerSpin).toBeLessThanOrEqual(2);
  });

  it('reproduces a run exactly from a seed, and differs between seeds', () => {
    const a = settled(32, 2.1, 5, 200);
    const b = settled(32, 2.1, 5, 200);
    expect(Array.from(a.spins)).toEqual(Array.from(b.spins));
    expect(a.magnetisation).toBe(b.magnetisation);
    expect(a.energyPerSpin).toBe(b.energyPerSpin);
    expect(settled(32, 2.1, 6, 200).magnetisation).not.toBe(a.magnetisation);
  });

  it('excludes the burn-in from the average and then averages a trailing window', () => {
    const lattice = new SpinLattice(32, 2.0);
    lattice.setSize(32);
    const rng = createRng(SEED);
    for (let i = 0; i < BURN_IN_SWEEPS; i++) lattice.sweep(rng);
    expect(lattice.measuredSweeps).toBe(0);
    expect(lattice.magnetisation).toBeNaN();
    expect(lattice.sweeps).toBe(BURN_IN_SWEEPS);

    lattice.sweep(rng);
    expect(lattice.measuredSweeps).toBe(1);
    expect(lattice.magnetisation).toBe(lattice.liveMagnetisation);

    for (let i = 0; i < 3 * WINDOW_SWEEPS; i++) lattice.sweep(rng);
    // The window is a ring: it never grows past its length however long the run.
    expect(lattice.measuredSweeps).toBe(WINDOW_SWEEPS);
    expect(lattice.sweeps).toBe(BURN_IN_SWEEPS + 1 + 3 * WINDOW_SWEEPS);
  });

  it('has no error to report until two blocks have closed', () => {
    const lattice = new SpinLattice(32, 2.0);
    lattice.setSize(32);
    const rng = createRng(SEED);
    for (let i = 0; i < BURN_IN_SWEEPS + 2 * BLOCK_SWEEPS - 1; i++) lattice.sweep(rng);
    expect(lattice.averageError).toBeNaN();
    lattice.sweep(rng);
    expect(lattice.averageError).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lattice.averageError)).toBe(true);
  });

  it('carries the spins through a temperature change and restarts only the measurement', () => {
    const lattice = settled(32, 2.0, SEED, 200);
    const before = Array.from(lattice.spins.slice(0, lattice.spinCount));
    lattice.setTemperature(2.6);
    // The sheet the reader is looking at is the sheet that gets warmed.
    expect(Array.from(lattice.spins.slice(0, lattice.spinCount))).toEqual(before);
    expect(lattice.temperature).toBe(2.6);
    expect(lattice.sweeps).toBe(0);
    expect(lattice.measuredSweeps).toBe(0);
    expect(lattice.magnetisation).toBeNaN();
    // Setting the same temperature again is not a restart.
    const rng = createRng(1);
    for (let i = 0; i < 10; i++) lattice.sweep(rng);
    lattice.setTemperature(2.6);
    expect(lattice.sweeps).toBe(10);
  });

  it('re-lays the sheet on a size change and on reset', () => {
    const lattice = settled(64, 2.4, SEED, 200);
    expect(lattice.liveMagnetisation).toBeLessThan(1);
    lattice.setSize(32);
    expect(lattice.size).toBe(32);
    expect(lattice.spinCount).toBe(1024);
    expect(lattice.liveMagnetisation).toBe(1);
    expect(lattice.energyPerSpin).toBe(-2);

    const rng = createRng(2);
    for (let i = 0; i < 200; i++) lattice.sweep(rng);
    lattice.reset();
    expect(lattice.liveMagnetisation).toBe(1);
    expect(lattice.sweeps).toBe(0);
  });

  it('allocates once at the ceiling, whatever size it is asked to run', () => {
    const lattice = new SpinLattice(128, 2.0);
    const buffer = lattice.spins;
    expect(buffer).toHaveLength(128 * 128);
    for (const size of SIZES) {
      lattice.setSize(size);
      expect(lattice.spins, `L = ${size}`).toBe(buffer);
    }
  });

  it('is a fair Metropolis chain: it warms to nothing and cools to everything', () => {
    // Two sanity ends with no free parameters in them.
    expect(settled(32, 20, SEED).magnetisation).toBeLessThan(0.1);
    expect(settled(32, 0.6, SEED).magnetisation).toBeGreaterThan(0.999);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  arcs: number;
  segments: number;
}

interface Fill {
  pen: string;
  arcs: number;
}

interface Rect {
  pen: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Blit {
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  smoothing: boolean;
}

interface Recorder {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  fills: Fill[];
  rects: Rect[];
  texts: string[];
  blits: Blit[];
}

/**
 * A canvas context that records what it is asked to paint. Only the shapes the
 * tests assert on are kept; everything else is accepted and dropped.
 */
function recordingContext(): Recorder {
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const rects: Rect[] = [];
  const texts: string[] = [];
  const blits: Blit[] = [];
  let arcs = 0;
  let segments = 0;
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    fillRect(x: number, y: number, w: number, h: number): void {
      rects.push({ pen: String(api.fillStyle), x, y, w, h });
    },
    strokeRect(x: number, y: number, w: number, h: number): void {
      rects.push({ pen: String(api.strokeStyle), x, y, w, h });
    },
    fillText(text: string): void {
      texts.push(text);
    },
    measureText: (text: string) => ({ width: 6 * text.length }),
    save: () => undefined,
    restore: () => undefined,
    createImageData: (w: number, h: number) => new StubImageData(w, h),
    putImageData: () => undefined,
    drawImage(
      _source: unknown,
      _sx: number,
      _sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void {
      blits.push({ sw, sh, dx, dy, dw, dh, smoothing: api.imageSmoothingEnabled });
    },
    beginPath(): void {
      arcs = 0;
      segments = 0;
    },
    moveTo: () => undefined,
    lineTo(): void {
      segments++;
    },
    arc(): void {
      arcs++;
    },
    stroke(): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        arcs,
        segments,
      });
    },
    fill(): void {
      fills.push({ pen: String(api.fillStyle), arcs });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, fills, rects, texts, blits };
}

/** Enough of ImageData for the alpha mask; vitest runs in node, which has none. */
class StubImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

/** The scratch canvas `createSpinSurface()` asks the document for. */
const surfaces: Recorder[] = [];
(globalThis as { document?: unknown }).document ??= {
  createElement(): unknown {
    const recorder = recordingContext();
    surfaces.push(recorder);
    return { width: 0, height: 0, getContext: () => recorder.ctx };
  },
};

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

const DEFAULTS: Record<string, ParamValue> = { temp: 2.0, size: '64', seed: SEED };

function stubViz(overrides: Record<string, ParamValue> = {}, width = 420, height = 568) {
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
  const instance = ising.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

/** One sweep per tick, which is what `SWEEPS_PER_SECOND` against the 120 Hz tick gives. */
function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.fg.fills.length = 0;
  v.fg.rects.length = 0;
  v.fg.texts.length = 0;
  v.fg.blits.length = 0;
  v.instance.draw();
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function rowsOf(v: Viz): Record<string, Readout> {
  const last = v.emitted.at(-1) ?? [];
  return Object.fromEntries(last.map((r) => [r.key, r]));
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
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
  v.bg.rects.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

describe('ising instance: readouts', () => {
  it('publishes every number it draws, identically for a seed', () => {
    const a = stubViz({ size: '32' });
    const b = stubViz({ size: '32' });
    for (const v of [a, b]) {
      tick(v, SETTLE);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual([
      'magnet',
      'temp',
      'sweeps',
      'onsager',
      'tc',
      'energy',
      'se',
      'spins',
    ]);
    expect(b.emitted.at(-1)).toEqual(last);

    const rows = rowsOf(a);
    // Everything the corner window and the axis print has a row behind it.
    expect(rows['temp']?.value).toBe(2);
    expect(rows['tc']?.value).toBeCloseTo(CRITICAL_TEMPERATURE, 12);
    expect(rows['spins']?.value).toBe(1024);
    expect(rows['sweeps']?.value).toBe(SETTLE);
    // In words, not in symbols: a reader who has not met statistical mechanics
    // reads `T` and `m` as nothing at all.
    expect(a.fg.texts).toContain('heat 2.00');
    expect(a.bg.texts).toContain(`tips at ${CRITICAL_TEMPERATURE.toFixed(3)}`);
    expect(a.bg.texts).toContain('how much agrees vs heat');
    // The matcher is checked against the labels it exists to catch before it is
    // pointed at the plate: written with a literal U+0008 where `\b` was meant,
    // it matched nothing at all and the loop below could not fail.
    for (const label of ['T = 2.00', 'Tc 2.269', 'm 0.911', 'T', 'm']) {
      expect(label, label).toMatch(SYMBOL_LABEL);
    }
    for (const kept of ['heat 2.00', 'tips at 2.269', 'how much agrees vs heat', 'measured']) {
      expect(kept, kept).not.toMatch(SYMBOL_LABEL);
    }
    for (const text of [...a.bg.texts, ...a.fg.texts]) {
      expect(text, text).not.toMatch(SYMBOL_LABEL);
    }
  });

  it('marks one headline, and carries the analytic target and a derived band', () => {
    const v = stubViz();
    tick(v, SETTLE);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    expect(last.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['magnet']);

    const magnet = rowsOf(v)['magnet'];
    expect(magnet?.target).toBeCloseTo(0.911_319, 6);
    expect(magnet?.plain).toBe('how much of the sheet points one way');
    // A magnetisation per spin is bounded by its own definition, and the band
    // is judged against the smaller of that span and the prediction.
    expect(magnet?.range).toEqual([0, 1]);
    // The band is the rounding the lattice is entitled to plus three standard
    // errors of the average, in |M|'s own units — declared beside the target so
    // a temperature with no prediction leaves no stray zero behind, which the
    // ledger would now read as a claim of exactness.
    expect(magnet?.tolerance).toBeUndefined();
    const band = magnet?.band;
    expect(band?.kind).toBe('absolute');
    const half = band?.kind === 'absolute' ? band.half : 0;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.05 * Math.min(1, magnet?.target ?? 0));
    expect(Math.abs((magnet?.value ?? 0) - 0.911_319)).toBeLessThan(half);
  });

  it('withholds the target where a grid this size cannot carry one, and says why', () => {
    const hot = stubViz({ temp: 3 });
    tick(hot, SETTLE);
    paint(hot);
    const above = rowsOf(hot)['magnet'];
    expect(above?.target).toBeUndefined();
    expect(above?.hint).toBe(
      'on an endless sheet this would be exactly 0 — a small grid always keeps a little left over',
    );
    // It still reads a small positive number, and says so rather than claiming zero.
    expect(above?.value).toBeGreaterThan(0);
    expect(above?.value).toBeLessThan(0.1);
    expect(ledger(hot)['onsager']).toBe(0);

    const edge = stubViz({ temp: 2.25 });
    tick(edge, SETTLE);
    paint(edge);
    const inside = rowsOf(edge)['magnet'];
    expect(inside?.target).toBeUndefined();
    expect(inside?.hint).toBe('right at the tipping point, where a grid this small cannot give a straight answer');
  });

  it('gives every visible reading a lower-case plain label and keeps the internals back', () => {
    const v = stubViz({ size: '32' });
    tick(v, 200);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const shown = last.filter((r) => r.expertOnly !== true);
    expect(shown.map((r) => r.key)).toEqual(['magnet', 'temp', 'sweeps']);
    for (const r of shown) {
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('never prints a word a sixteen-year-old would have to ask about', () => {
    // The simple view reads `plain` and `hint`; the precise names stay in the
    // table, which is where "Std. error" and "Onsager |M|" belong.
    const banned =
      /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov)\b/i;
    for (const temp of [1.8, 2.0, 2.25, 3]) {
      const v = stubViz({ temp, size: '32' });
      tick(v, SETTLE);
      paint(v);
      for (const r of v.emitted.at(-1) ?? []) {
        if (r.expertOnly === true) continue;
        expect(r.plain ?? '', `${temp} ${r.key}`).not.toMatch(banned);
        expect(r.hint ?? '', `${temp} ${r.key}`).not.toMatch(banned);
      }
    }
  });

  it('draws without moving the simulation on', () => {
    const v = stubViz({ size: '32' });
    tick(v, 300);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    // …and the picture is the same picture, not a second one accumulated on top.
    const first = v.fg.blits.length;
    paint(v);
    expect(v.fg.blits).toHaveLength(first);
  });
});

describe('ising instance: the knobs', () => {
  it('absorbs a temperature change, carrying the sheet into it', () => {
    const v = stubViz({ size: '32' });
    tick(v, 300);
    paint(v);

    expect(setParam(v, 'temp', 2.6)).toBe(true);
    // The measurement restarts…
    expect(ledger(v)['sweeps']).toBe(0);
    expect(ledger(v)['temp']).toBe(2.6);
    // …but the spins do not, so the warmed sheet is the sheet that was there.
    // A restarted lattice would read exactly 1 on its first sweep.
    tick(v, 1);
    paint(v);
    expect(ledger(v)['energy']).toBeGreaterThan(-2);
  });

  it('restarts on the size and on the seed, because each one is a different sheet', () => {
    for (const [key, value] of [
      ['size', '32'],
      ['seed', 7],
    ] as const) {
      const v = stubViz();
      tick(v, 200);
      paint(v);
      expect(setParam(v, key, value), key).toBe(false);
      expect(ledger(v)['sweeps'], key).toBe(0);

      const fresh = stubViz({ [key]: value });
      tick(fresh, 200);
      paint(fresh);
      tick(v, 200);
      paint(v);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('clamps a permalink that asks for something the controls cannot ask for', () => {
    expect(temperatureOf({ temp: 9 })).toBe(TEMP_MAX);
    expect(temperatureOf({ temp: 0 })).toBe(TEMP_MIN);
    expect(temperatureOf({})).toBe(2);
    // An old permalink naming a size the tab no longer offers takes the default.
    expect(sizeOf({ size: '96' })).toBe(64);
    expect(sizeOf({ size: '128' })).toBe(128);
    expect(sizeOf({})).toBe(64);
    const v = stubViz({ temp: 9, size: '96' });
    tick(v, 10);
    paint(v);
    expect(ledger(v)['temp']).toBe(TEMP_MAX);
    expect(ledger(v)['spins']).toBe(64 * 64);
  });
});

describe('ising instance: the plate', () => {
  it('blits the whole lattice once a frame, unsmoothed, whatever happened between frames', () => {
    const v = stubViz({ size: '128' });
    tick(v, 5);
    paint(v);
    expect(v.fg.blits).toHaveLength(1);
    const blit = v.fg.blits[0];
    expect(blit?.sw).toBe(128);
    expect(blit?.sh).toBe(128);
    expect(blit?.smoothing).toBe(false);
    // Two hundred sweeps between frames still cost exactly one blit: what is
    // painted is bounded independently of what is counted.
    tick(v, 200);
    paint(v);
    expect(v.fg.blits).toHaveLength(1);
    expect(ledger(v)['sweeps']).toBe(205);
  });

  it('paints the sheet as a wash under the signal pen, at full strength', () => {
    const v = stubViz({ size: '32' });
    tick(v, 50);
    paint(v);
    const layout = layoutPlate(420, 568, 11);
    const wash = v.fg.rects.find((r) => r.pen === THEME.data3Fill);
    expect(wash).toEqual({ pen: THEME.data3Fill, x: layout.gridX, y: layout.gridY, w: layout.side, h: layout.side });
    const blit = v.fg.blits[0];
    expect(blit?.dx).toBe(layout.gridX);
    expect(blit?.dw).toBe(layout.side);
    // The ups are stained with the signal pen on the scratch surface, never
    // parsed into the bitmap.
    const stain = surfaces.at(-1)?.rects.at(-1);
    expect(stain?.pen).toBe(THEME.data1);
    for (const s of v.fg.strokes) expect(s.alpha).toBe(1);
  });

  it('holds the painted points at one per slider stop however long it runs', () => {
    const v = stubViz({ size: '32' });
    // Park at three temperatures long enough for each to earn a point.
    for (const temp of [2.0, 2.2, 2.4]) {
      setParam(v, 'temp', temp);
      tick(v, SETTLE);
    }
    paint(v);
    const dots = v.fg.fills.filter((f) => f.pen === THEME.data1);
    const painted = dots.reduce((n, f) => n + f.arcs, 0);
    // Three settled points plus the live one on top of the current temperature.
    expect(painted).toBe(4);
    expect(painted).toBeLessThanOrEqual(PAINTED_POINTS + 1);
    // And a temperature only brushed past leaves nothing behind.
    setParam(v, 'temp', 3.5);
    tick(v, 10);
    paint(v);
    const after = v.fg.fills.filter((f) => f.pen === THEME.data1).reduce((n, f) => n + f.arcs, 0);
    expect(after).toBe(3);
  });

  it('draws the exact curve in the analytic pen and the experiment’s own frame in the area pen', () => {
    const v = stubViz();
    // The curve is stroked twice — the plate colour first, then the pen — so
    // the vermilion points landing on it never touch it.
    const curve = v.bg.strokes.filter((s) => s.segments > 100);
    expect(curve.map((s) => s.pen)).toEqual([THEME.canvas, THEME.data2]);
    expect(curve[1]?.width).toBe(2 * THEME.lineWidth);
    expect(curve[0]?.width).toBe(2 * THEME.lineWidth + 4);
    // The boundary lives on the foreground now, after the wash that used to
    // repaint its inner half; the test above it checks where exactly.
    paint(v);
    expect(v.fg.rects.some((r) => r.pen === THEME.data3)).toBe(true);
    // Nothing on this plate uses the apparatus pen: the sheet is the data, and
    // the axis and the T_c rule are the furniture around it.
    for (const s of [...v.bg.strokes, ...v.fg.strokes]) expect(s.pen).not.toBe(THEME.grid);
  });

  it('gives every measured point its own halo against the curve it lands on', () => {
    const v = stubViz({ size: '32' });
    tick(v, SETTLE);
    paint(v);
    const halo = v.fg.strokes.find((s) => s.pen === THEME.canvas && s.arcs > 0);
    expect(halo?.width).toBe(2 * THEME.lineWidth + 2);
  });
});

describe('ising instance: the plate does not move', () => {
  it('keeps the lattice and the plot inside the plate at every size it is given', () => {
    for (const [width, height] of [
      [420, 568],
      [343, 490],
      [533, 720],
      [240, 320],
      [700, 400],
    ] as const) {
      const layout = layoutPlate(width, height, 11);
      const where = `${width}×${height}`;
      expect(layout.side, where).toBeGreaterThan(0);
      expect(layout.gridX, where).toBeGreaterThanOrEqual(0);
      expect(layout.gridX + layout.side, where).toBeLessThanOrEqual(width);
      expect(layout.gridY + layout.side, where).toBeLessThanOrEqual(layout.plotTop);
      expect(layout.plotTop, where).toBeLessThan(layout.plotBottom);
      expect(layout.plotBottom, where).toBeLessThan(height);
      expect(layout.plotX1, where).toBeLessThanOrEqual(width);
      // The square never sits on y = 0: at the declared aspect the height binds
      // and the top of the lattice was landing on the first row of the canvas,
      // with the outer half of its own 2 px boundary off the plate entirely.
      expect(layout.gridY, where).toBeGreaterThanOrEqual(8);
      // …and the caption between the lattice and the plot has a line to sit on.
      expect(layout.plotTop - (layout.gridY + layout.side), where).toBeGreaterThanOrEqual(11);
    }
  });

  it('draws the lattice boundary wholly inside the square, after the wash that used to eat it', () => {
    const v = stubViz({ size: '32' });
    tick(v, 50);
    paint(v);
    const layout = layoutPlate(420, 568, 11);
    const width = 2 * THEME.lineWidth;
    // On the foreground, not the background: the wash is repainted every frame
    // over the same rectangle, so half of a boundary centred on the edge was
    // painted out and the rest read as a 1 px graphite hairline — the one mark
    // DESIGN §7 forbids outright, at 1.77:1 on the plate.
    expect(v.bg.rects.some((r) => r.pen === THEME.data3)).toBe(false);
    const edge = v.fg.rects.find((r) => r.pen === THEME.data3);
    expect(edge).toEqual({
      pen: THEME.data3,
      x: layout.gridX + width / 2,
      y: layout.gridY + width / 2,
      w: layout.side - width,
      h: layout.side - width,
    });
    // Inked after the blit, or the spins would cover it again.
    const wash = v.fg.rects.findIndex((r) => r.pen === THEME.data3Fill);
    expect(v.fg.rects.indexOf(edge!)).toBeGreaterThan(wash);
  });

  it('is the same layout whatever the readings are', () => {
    // Nothing is sized from a number: the plot band and the lattice square come
    // from the plate alone, so a four-digit reading and a dash give one layout.
    expect(layoutPlate(420, 568, 11)).toEqual(layoutPlate(420, 568, 11));
    const cold = stubViz({ temp: 1.5, size: '32' });
    const hot = stubViz({ temp: 3.5, size: '128' });
    for (const v of [cold, hot]) {
      tick(v, 120);
      paint(v);
    }
    const rectOf = (v: Viz): Rect | undefined => v.fg.rects.find((r) => r.pen === THEME.data3Fill);
    expect(rectOf(cold)).toEqual(rectOf(hot));
  });

  it('leaves every reading untouched across a resize', () => {
    const v = stubViz({ size: '32' }, 420, 568);
    tick(v, 300);
    paint(v);
    const before = ledger(v);
    resize(v, 343, 490);
    expect(ledger(v)).toEqual(before);
    resize(v, 533, 720);
    expect(ledger(v)).toEqual(before);
    // …and the plot is re-laid on the new plate rather than stranded on the old.
    const layout = layoutPlate(533, 720, 11);
    expect(v.fg.blits[0]?.dw).toBe(layout.side);
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

describe('ising metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(ising.params.map((p) => p.key)).toEqual(['temp', 'size', 'seed']);
    expect(ising.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(ising.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    // The slider's own stops are what the plot has room for, one point each.
    expect(TEMP_SLOTS).toBe(41);
    expect(PAINTED_POINTS).toBe(TEMP_SLOTS);
  });

  it('keeps its id and its group, because both are in shared permalinks', () => {
    expect(ising.id).toBe('ising');
    expect(ising.group).toBe('chaos');
    expect(ising.budget?.maxEntities).toBe(128 * 128);
  });

  it('offers three presets, each one plain sentence, ordered from no order to all of it', () => {
    const presets = ising.presets ?? [];
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.id)).toEqual(['warm', 'the-edge', 'cold']);
    let previous = Infinity;
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const key of Object.keys(preset.values)) {
        expect(ising.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
      const temp = preset.values['temp'];
      expect(typeof temp, preset.id).toBe('number');
      // Each chip is colder than the last, which is the walk to the insight.
      expect(temp as number).toBeLessThan(previous);
      previous = temp as number;
    }
  });

  it('states two facts, one sentence each, and sources both', () => {
    expect(ising.facts).toHaveLength(2);
    for (const fact of ising.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(ising.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).toMatch(/^Heats /);
  });
});
