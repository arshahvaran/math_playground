import type {
  Fact,
  ParamSpec,
  ParamValue,
  ParamValues,
  Preset,
  Readout,
  Viz,
  VizContext,
  VizInstance,
} from '../../core/types';
import { strokeWithHalo } from '../../core/paint';
import { fmt } from '../../core/stats';
import {
  DEFAULT_PERIOD_TOL,
  FEIGENBAUM_DELTA,
  PERIOD_THREE_ONSET,
  detectPeriod,
  lyapunovExponent,
  lyapunovFrom,
  sampleAttractor,
} from './logistic';

/**
 * Columns the plot rectangle can hold, one CSS pixel each. A plate wider than
 * this does not exist in the layout.
 */
const MAX_COLUMNS = 2048;

/**
 * Columns the sweep *computes*, fixed and independent of the plate.
 *
 * The mathematics is sampled on this grid and the plate is a picture of the
 * result, never the other way round. A column used to be a CSS pixel, which
 * made every published number a function of the reader's window: r itself was
 * `rLo + (c + ½)·span/plateWidth`, so the doubling onsets landed at different
 * values of r on a laptop and on a phone, and the Feigenbaum ratio a permalink
 * showed was not the one it had been shared for. It also made a resize an
 * *invalidation* — one pixel of plate height threw the whole diagram away and
 * spent tens of seconds recomputing it — because the stored rows had been
 * quantised against a rectangle that no longer existed.
 *
 * 1,024 is chosen against the two things that bind. The sweep's pace is
 * `columns/SWEEP_SECONDS` capped by the iteration budget, and at 1,024 the pace
 * is the one that binds, so the sweep still takes its 2.5 s rather than longer
 * on a wide screen. And the onsets are resolved to `span/1024`, which on the
 * whole map is 1.6e-3 — the resolution the Feigenbaum reading's band is derived
 * from, and now the same resolution for every reader.
 */
export const SWEEP_COLUMNS = 1024;

/**
 * Vertical quantisation of the attractor, as a power of two.
 *
 * A column is stored as the set of levels its samples occupy — one bit each, 128
 * words a column, 512 KB for the whole sweep — rather than as the pixel rows
 * they landed on. That is what makes the stored sweep independent of the plate:
 * 4,096 levels is `MAX_PLOT_ROWS`, so the quantisation is never coarser than the
 * rectangle it is painted into, and the painter merges the levels that share a
 * row rather than drawing them twice.
 */
const VALUE_BITS = 12;
const VALUE_LEVELS = 1 << VALUE_BITS;
const LEVEL_WORDS = VALUE_LEVELS >>> 5;

/** The Detail control's range. `MAX_DETAIL ≤ MAX_PLOT_ROWS` is what makes the dedupe below safe. */
const MIN_DETAIL = 100;
const MAX_DETAIL = 1000;
const DEFAULT_DETAIL = 400;
const MAX_PLOT_ROWS = 4096;

/** Deepest doubling the onset tracker records: period 64, which is `MAX_PERIOD`. */
const MAX_LEVEL = 6;

/**
 * Onset uncertainty in column widths.
 *
 * A doubling is located to the column that first resolves it, so its position
 * carries the column width h as a resolution error. It also carries a bias of
 * roughly the same size from the finite transient — near a doubling the cycle
 * is neutral, so an orbit takes many thousands of iterations to separate onto
 * the new branches, and the column where it manages that is not exactly the one
 * containing rₖ. Two column widths per onset is the honest figure; the readout
 * publishes the resulting uncertainty as its band, so the ledger judges the
 * ratio against what the sweep can actually see.
 *
 * There is no second ceiling on top of that. A cap of 25 % used to withhold the
 * reading here as well, which put two ceilings on one claim — the ledger's, and
 * a looser one the tab kept for itself — and the two could disagree about the
 * same number. The band is now stated and judged in exactly one place.
 */
const ONSET_SPREAD = 2;

/**
 * Column widths of uncertainty on the r where a *tangent* bifurcation is first
 * resolved, which is a larger number than `ONSET_SPREAD` and for a different
 * reason.
 *
 * The period-3 window opens at r = 1 + √8, where the new 3-cycle is born
 * neutral and the orbit spends an intermittent transient near the tangency
 * before it lands on the cycle, so the first column reporting period 3 is always
 * *past* the onset rather than scattered about it. Four column widths is the
 * resolution allowance; the bias itself is `TANGENT_BIAS` and is added on top,
 * because it does not shrink when the window does.
 */
const TANGENT_SPREAD = 4;

/**
 * Seconds a full sweep takes when nothing else binds. Slow enough that the
 * columns are visibly laid down left to right, fast enough that a zoom is not
 * a wait.
 */
const SWEEP_SECONDS = 2.5;

/**
 * Map iterations per second of simulated time. The pace above sets the column
 * rate; this caps it, so the transient and the largest sample count cannot turn
 * one tick into a dropped frame.
 */
const ITERATION_BUDGET = 4e6;

/**
 * Iterations thrown away before a column is sampled. Was the Transient control
 * (100–5,000); fixed at the deepest value a preset ever asked for, because near
 * a doubling the cycle is neutral and the orbit needs thousands of iterations
 * to land on the new branches — 5,000 is what locates the cascade's onsets to
 * the column, and the map is cheap enough that nothing else notices.
 */
export const TRANSIENT = 5000;

/**
 * The r-offset a finite transient adds to a *doubling* the sweep resolves.
 *
 * A column reports the new period only once the orbit has actually landed on the
 * new cycle to within `DEFAULT_PERIOD_TOL`, and either side of a doubling it has
 * not: at r = 3 − δ the fixed point's multiplier is −(1 − δ), so an orbit a
 * distance A from it is still A·e^(−nδ) away after n iterations and reads as a
 * 2-cycle while that exceeds the tolerance. The sweep therefore resolves the
 * split about δ = ln(A/tol)/TRANSIENT on the wrong side of r = 3 — 2.3e-3 at
 * A ≈ 0.1 and 5,000 iterations, measured 1.9e-3 early.
 *
 * It is a property of the transient and not of the grid, which is why it is
 * added to the band rather than counted in columns: zooming in makes a column
 * narrower and leaves this exactly where it was, and a band that shrank with the
 * zoom would certify a correct reading out of existence.
 *
 * It does not appear in the Feigenbaum band, because that reading is built from
 * *differences* of onsets and a common offset cancels in rₖ₊₁ − rₖ. What is left
 * there is the resolution, which is what `ONSET_SPREAD` counts.
 */
const SETTLE_BIAS = Math.log(0.1 / DEFAULT_PERIOD_TOL) / TRANSIENT;

/**
 * The same offset at the period-3 tangency. The approach to the new cycle is
 * algebraic there rather than geometric, so the sweep resolves it far more
 * sharply: measured 3.0e-5 past 1 + √8, three quarters of a column on the island
 * window. Twice the measurement, so the allowance does not rest on one number.
 */
const TANGENT_BIAS = 6e-5;

/**
 * Was the Lyapunov toggle. Always on: the curve touching zero is what marks
 * each split on the plate, and a switch to hide it was a question, not a knob.
 */
const SHOW_LYAPUNOV = true;

/** Plate margins, CSS px. The bottom also carries the r-axis ticks and numerals. */
const PAD_TOP = 8;
const PAD_SIDE = 8;
const AXIS_TICK = 4;
const LABEL_GAP = 3;

/**
 * The λ band drawn over the plate. Below −2 the curve is clamped to the floor,
 * which is where every superstable cycle would otherwise take it: λ is −∞
 * wherever the orbit passes through the critical point.
 *
 * The top is just above ln 2 = 0.6931, which λ cannot exceed anywhere in this
 * family — r = 4 is the most chaotic the map gets. It is also what keeps the
 * zero line off the data: with a top of 1 the band puts λ = 0 exactly a third
 * of the way down the plate, which is exactly where the attractor x = ⅔ sits,
 * and the first doubling then happens with a grey rule lying along the branch
 * it is about to split.
 */
const LAMBDA_TOP = 0.8;
const LAMBDA_BOTTOM = -2;

const DEFAULT_SEED = 42;

/**
 * The windows the Zoom control offers, in r. They replace a pair of free r
 * sliders: every stop is somewhere a newcomer should be taken, and a window
 * typed by hand found nothing these five do not show.
 */
const WINDOWS = [
  { id: 'whole', label: 'The whole map', lo: 2.4, hi: 4, measures: 'feigenbaum' },
  { id: 'first-split', label: 'First split', lo: 2.9, hi: 3.1, measures: 'split' },
  { id: 'cascade', label: 'The cascade', lo: 3.4, hi: 3.57, measures: 'feigenbaum' },
  { id: 'island', label: 'The island of order', lo: 3.82, hi: 3.86, measures: 'window3' },
  { id: 'deep-chaos', label: 'Deep chaos', lo: 3.95, hi: 4, measures: 'lyapunov' },
] as const;

type Window = (typeof WINDOWS)[number];

/**
 * The reading a window is *for*: the one quantity inside it that has a closed
 * form to be held to, and therefore the one the hero shows.
 *
 * It is a property of the window and not of the tab, because three of the five
 * contain no cascade at all — the first split has one doubling in it, the island
 * of order and deep chaos have none — and the Feigenbaum ratio needs three
 * consecutive ones. Publishing δ as the headline everywhere left three zooms,
 * one of them a shipped preset, with a permanent em dash and "not measured yet"
 * under it on a *finished* sweep. Naming the measurement here is what makes that
 * unrepresentable: every window ships with something it can measure, and the
 * compiler lists every site when one is added.
 */
type Measurement = Window['measures'];

const DEFAULT_ZOOM: Window['id'] = 'whole';

/**
 * Standard deviation of ln|f′| at r = 4, where the invariant density is the
 * arcsine law: with u = 1 − 2x the term is ln 4 + ln|u| and Var(ln|cos φ|) over
 * uniform φ is π²/12, so σ = 0.9069. It sets the tolerance on the one Lyapunov
 * reading that has a closed-form target.
 */
const LAMBDA_SIGMA_AT_FOUR = Math.PI / Math.sqrt(12);

/**
 * Iterates behind the exponent quoted at r = 4.
 *
 * λ̂ is an average of terms whose spread is `LAMBDA_SIGMA_AT_FOUR`, so three
 * standard errors of it are 2.72/√n — 19.6 % of ln 2 over the 400 samples a
 * column plots, and still 12 % at the Detail control's ceiling. A band that wide
 * cannot test a constant known exactly, so the sweep reads this one off an orbit
 * of its own: 20,000 iterates put the band at 2.8 %, and the whole extra run
 * costs four thousandths of what the sweep spends anyway.
 *
 * Detail is a drawing control — how many points of each column's attractor are
 * plotted — and tying a measurement's precision to it was the mistake. The
 * points on the plate and the iterates behind a published exponent are not the
 * same quantity.
 */
export const LAMBDA_4_SAMPLES = 20_000;

/**
 * Where the first doubling happens, exactly.
 *
 * The map's non-zero fixed point is x* = 1 − 1/r and its multiplier is
 * f′(x*) = 2 − r, so the fixed point is stable while |2 − r| < 1 and loses
 * stability at r = 3 with multiplier −1 — a period doubling, and the one point
 * of the cascade with a closed form a reader can check by hand.
 */
const FIRST_SPLIT = 3;

/**
 * The widest lines the corner window can ever show. Its plate is sized to
 * these rather than to the lines on screen, so a reading that changes length
 * between two columns — "never repeats" after "cycles through 16 values" —
 * never changes the box.
 */
const WINDOW_TEMPLATES: readonly string[] = ['r 3.4567890', 'cycles through 64 values'];

const params: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'zoom',
    label: 'Zoom',
    options: WINDOWS.map((w) => ({ value: w.id, label: w.label })),
    default: DEFAULT_ZOOM,
  },
  {
    kind: 'int',
    key: 'detail',
    label: 'Detail',
    min: MIN_DETAIL,
    max: MAX_DETAIL,
    default: DEFAULT_DETAIL,
  },
  // The rail renders no control for a seed. It stays declared so a permalink's
  // seed is still typed by coerceParams and the transport's Shuffle key has a
  // knob to turn. The map is deterministic: a column depends on r alone,
  // because every starting point in (0, 1) converges to the same attractor.
  // The seed only jitters each column's x₀ inside [0.3, 0.7), which
  // decorrelates the leftover transient from one column to the next instead of
  // drawing the same approach curve across the whole plate.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'whole-map',
    label: 'The whole map',
    caption: [
      'Turn ', { v: 'r' }, ' up from left to right: one resting value splits into two, then four, then blurs into chaos.',
    ],
    values: { zoom: 'whole' },
  },
  {
    id: 'first-split',
    label: 'First split',
    caption: [
      'At ', { v: 'r' }, ' = 3 the single resting value lets go and ', { v: 'x' }, ' starts bouncing between two.',
    ],
    values: { zoom: 'first-split' },
  },
  {
    id: 'cascade',
    label: 'The cascade',
    caption: 'The splits come faster and faster: each gap is about 4.669 times shorter than the one before it.',
    values: { zoom: 'cascade' },
  },
];

const facts: readonly Fact[] = [
  {
    text: 'Feigenbaum showed in 1978 that this 4.669 is the same for every smooth rule with a single hump, not just this one.',
    source: {
      label: 'Feigenbaum, “Quantitative universality for a class of nonlinear transformations”, J. Stat. Phys. 19 (1978) 25–52',
      url: 'https://doi.org/10.1007/BF01020332',
    },
  },
  {
    text: 'Robert May put this picture in Nature in 1976 to warn that a population rule with no randomness in it can produce numbers that look completely random.',
    source: {
      label: 'May, “Simple mathematical models with very complicated dynamics”, Nature 261 (1976) 459–467',
      url: 'https://doi.org/10.1038/261459a0',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** The window a zoom value names; an unknown one — an old permalink — is the whole map. */
export function windowFor(value: ParamValue | undefined): Window {
  return WINDOWS.find((w) => w.id === value) ?? WINDOWS[0];
}

/** Pixel size out of a CSS font shorthand, for sizing the axis gutter and the readout window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/** log₂ of a power of two, or −1 for anything else — including 0, which is chaos. */
export function doublingLevel(period: number): number {
  if (period < 1 || (period & (period - 1)) !== 0) return -1;
  return Math.round(Math.log2(period));
}

/**
 * A 1-2-5 tick step giving roughly eight intervals across `span`, so the axis
 * reads 3.45 · 3.50 · 3.55 on a zoom and 2.5 · 3.0 · 3.5 on the whole map
 * without the numerals ever colliding.
 */
export function tickStep(span: number): number {
  const raw = Math.max(span, 1e-9) / 8;
  const mag = 10 ** Math.floor(Math.log10(raw));
  if (mag >= raw) return mag;
  if (2 * mag >= raw) return 2 * mag;
  if (5 * mag >= raw) return 5 * mag;
  return 10 * mag;
}

/** Decimals a numeral needs to distinguish two neighbouring ticks. */
function tickDecimals(step: number): number {
  return Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
}

/**
 * The corner window's second line: what x is doing at the cursor, in words.
 * 0 is not a period — it is "no cycle up to 64 repeats", which is chaos or an
 * orbit that has not finished settling — so it reads as never repeating.
 */
export function cycleText(period: number): string {
  if (period === 0) return 'never repeats';
  if (period === 1) return 'settles on 1 value';
  return `cycles through ${period} values`;
}

export interface PlotLayout {
  /** Left edge of column 0, CSS px, integer. */
  x0: number;
  /** Top of the plot area, integer. */
  y0: number;
  /** Plot height, CSS px, integer. */
  h: number;
  /** Columns across the plate — one CSS pixel each. */
  columns: number;
}

/**
 * Where the diagram sits on a plate `width` × `height`.
 *
 * One column per CSS pixel, and the block of them centred, so no column is ever
 * painted at a fractional x: an attractor point is a single filled pixel, and
 * a filled pixel on a whole-pixel grid covers whole device pixels at DPR 1 and
 * 2 alike. That is what keeps the marks at the pen's own 4.80:1 against the
 * plate instead of the 2.20:1 an anti-aliased half-covered pixel would give —
 * DESIGN §7 allows a sub-3-px mark exactly on the condition that it is snapped
 * rather than smeared, and this diagram is nothing but sub-pixel structure.
 */
export function layoutPlot(width: number, height: number, labelHeight: number): PlotLayout {
  const gutter = AXIS_TICK + LABEL_GAP + labelHeight + 2;
  const usable = Math.floor(width - 2 * PAD_SIDE);
  const columns = Math.max(1, Math.min(MAX_COLUMNS, usable));
  const y0 = PAD_TOP;
  const h = Math.max(1, Math.min(MAX_PLOT_ROWS - y0 - 1, Math.floor(height - y0 - gutter)));
  return { x0: Math.round((width - columns) / 2), y0, h, columns };
}

function create(ctx: VizContext): VizInstance {
  // Structural parameters: each one is a different diagram.
  let rLo: number = WINDOWS[0].lo;
  let rHi: number = WINDOWS[0].hi;
  let samples = DEFAULT_DETAIL;
  let measures: Measurement = WINDOWS[0].measures;

  let plot = layoutPlot(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));

  // Every array is allocated here, once, at its ceiling, and every one of them
  // is indexed by a *sweep* column rather than by a pixel.
  const orbit = new Float64Array(MAX_DETAIL);
  const jitter = new Float64Array(SWEEP_COLUMNS);
  const lyap = new Float64Array(SWEEP_COLUMNS);
  const periods = new Uint8Array(SWEEP_COLUMNS);
  /**
   * The sweep itself: one bitset of occupied attractor levels per column.
   *
   * This is the diagram, and the background bitmap is a picture of it. Keeping
   * it — rather than a ring of the few hundred columns not yet painted — is what
   * lets a resize repaint instead of recompute, which is the difference between
   * a one-pixel change of plate height costing nothing and costing the whole
   * sweep.
   */
  const levels = new Uint32Array(SWEEP_COLUMNS * LEVEL_WORDS);
  /** Observed r of the first column resolving period 2ᵏ, NaN where not seen. */
  const onsets = new Float64Array(MAX_LEVEL + 1);
  /** Observed r of the first column resolving period 3, NaN where not seen. */
  let windowOnset = NaN;
  /** λ at r = 4 over its own long orbit, NaN until the sweep reaches that column. */
  let lambdaAtFour = NaN;

  let computed = 0;
  let painted = 0;
  let iterations = 0;
  let pending = 0;
  /** Doubling level of the last column that resolved one; −1 before the first. */
  let prevLevel = -1;

  /** Centre of sweep column `c` in r. A property of the window, never of the plate. */
  function rAt(c: number): number {
    return rLo + ((c + 0.5) * (rHi - rLo)) / SWEEP_COLUMNS;
  }

  /** The r a column of the sweep resolves to, as a half-width. */
  function columnWidth(): number {
    return (rHi - rLo) / SWEEP_COLUMNS;
  }

  /** Quantised level of an attractor value in [0, 1], counted down from the top. */
  function valueLevel(x: number): number {
    const v = Math.floor((1 - x) * VALUE_LEVELS);
    return v < 0 ? 0 : v >= VALUE_LEVELS ? VALUE_LEVELS - 1 : v;
  }

  /** Screen row of a quantised level. */
  function levelRow(level: number): number {
    const y = plot.y0 + Math.floor((level * plot.h) / VALUE_LEVELS);
    const floor = plot.y0 + plot.h - 1;
    return y > floor ? floor : y;
  }

  /** Left edge of sweep column `c` on the plate, CSS px, integer. */
  function columnX(c: number): number {
    return plot.x0 + Math.floor((c * plot.columns) / SWEEP_COLUMNS);
  }

  /** Screen y for a Lyapunov exponent, clamped to the drawn band. */
  function lambdaY(v: number): number {
    const clamped = v > LAMBDA_TOP ? LAMBDA_TOP : v < LAMBDA_BOTTOM ? LAMBDA_BOTTOM : v;
    return plot.y0 + (plot.h * (LAMBDA_TOP - clamped)) / (LAMBDA_TOP - LAMBDA_BOTTOM);
  }

  function syncStructure(): void {
    const zoom = windowFor(ctx.params['zoom']);
    rLo = zoom.lo;
    rHi = zoom.hi;
    measures = zoom.measures;
    samples = Math.max(MIN_DETAIL, Math.min(MAX_DETAIL, Math.round(num(ctx.params, 'detail', DEFAULT_DETAIL))));
  }

  /**
   * What the columns already computed were computed *for*: the window and the
   * sample count, and nothing about the plate.
   *
   * This is the whole difference between a repaint and an invalidation. The
   * shell calls `drawBackground()` for things that are not changes at all — the
   * in-canvas label face arrives as a promise continuation, one microtask after
   * `activate()` returns — and it calls it for a resize, which changes where the
   * diagram is drawn but not what it is. The sweep is kept as mathematics rather
   * than as pixels, so neither one can destroy it: a re-lettering and a
   * one-pixel change of plate height both cost a repaint from `levels`, and
   * `--viz-max-h` is in `dvh`, so a phone's URL bar collapsing during a scroll
   * is exactly that change, sixty times a second.
   */
  let sweptShape = '';

  function shapeOf(): string {
    return `${rLo}|${rHi}|${samples}`;
  }

  /** Rewind the sweep without touching a pixel. Running it twice is free. */
  function rewind(): void {
    computed = 0;
    painted = 0;
    iterations = 0;
    pending = 0;
    prevLevel = -1;
    onsets.fill(NaN);
    windowOnset = NaN;
    lambdaAtFour = NaN;
    sweptShape = shapeOf();
  }

  /** Does sweep column `c` contain r = 4, the one r with a closed-form exponent? */
  function holdsFour(c: number): boolean {
    return Math.abs(rAt(c) - 4) <= columnWidth() / 2 + 1e-12;
  }

  /**
   * Compute one column: its attractor, its period, its Lyapunov exponent, and
   * the distinct levels the samples occupy.
   */
  function computeColumn(c: number): void {
    const r = rAt(c);
    // x₀ jittered across [0.3, 0.7). Every orbit in (0, 1) forgets where it
    // started, so this changes no column's attractor — it only decorrelates
    // whatever transient is left over from one column to the next, instead of
    // drawing the same approach curve across the whole plate. The one starting
    // point that would matter is ½, which at r = 4 maps to 1 and then to the
    // dead fixed point 0; a draw from a 32-bit stream lands on it once in 2³².
    sampleAttractor(orbit, 0, samples, r, TRANSIENT, 0.3 + 0.4 * jitter[c]!);

    const period = detectPeriod(orbit, DEFAULT_PERIOD_TOL, 0, samples);
    periods[c] = period > 255 ? 255 : period;
    lyap[c] = lyapunovFrom(orbit, r, 0, samples);
    iterations += TRANSIENT + samples;

    // A doubling is recorded where the period the sweep last resolved was
    // exactly half this one. Columns with no period are stepped over rather
    // than breaking the chain: right at a bifurcation the two new branches have
    // not yet separated by the tolerance and the orbit is still drifting
    // between them, so a column or two there resolves nothing at all, and
    // demanding an adjacent column lost the r = 3 onset entirely. The cost is
    // that a stray period-2ᵏ window up in the chaos can also be recorded; those
    // are thrown out downstream, where a triple whose intervals fail to shrink
    // is refused.
    const level = doublingLevel(period);
    if (level >= 1 && level === prevLevel + 1 && Number.isNaN(onsets[level]!)) onsets[level] = r;
    if (level >= 0) prevLevel = level;
    // The tangent bifurcation at 1 + √8, which is not a doubling and is not on
    // the cascade's chain: the first column that resolves a 3-cycle at all.
    if (period === 3 && Number.isNaN(windowOnset)) windowOnset = r;

    // The one r in this family whose exponent has a closed form, measured on an
    // orbit of its own rather than on the handful of points the column plots.
    if (Number.isNaN(lambdaAtFour) && holdsFour(c)) {
      lambdaAtFour = lyapunovExponent(4, TRANSIENT, LAMBDA_4_SAMPLES, 0.3 + 0.4 * jitter[c]!);
      iterations += TRANSIENT + LAMBDA_4_SAMPLES;
    }

    const base = c * LEVEL_WORDS;
    levels.fill(0, base, base + LEVEL_WORDS);
    for (let i = 0; i < samples; i++) {
      const v = valueLevel(orbit[i]!);
      const w = base + (v >>> 5);
      levels[w] = (levels[w] ?? 0) | (1 << (v & 31));
    }
  }

  /**
   * Paint sweep columns `[from, to)` onto the background.
   *
   * A sweep column is a block of `plate ÷ 1024` pixels wide, which is one pixel
   * on a plate near the grid's own resolution and never fewer: a plate narrower
   * than the grid draws several columns onto the same pixel, which is all it can
   * show.
   *
   * Levels arrive in order, so the rows they land on are non-decreasing and a
   * run of them is one rectangle. That is what keeps a repaint affordable: a
   * chaotic column's four hundred samples cover a solid band of the plate and
   * cost two or three marks rather than four hundred, and a repaint of the whole
   * sweep is the difference between a hitch and a dropped second.
   */
  function paintColumns(bg: CanvasRenderingContext2D, from: number, to: number): void {
    bg.fillStyle = ctx.theme.data1;
    for (let c = from; c < to; c++) {
      const x = columnX(c);
      const w = Math.max(1, columnX(c + 1) - x);
      const base = c * LEVEL_WORDS;
      // The open run, as [runY, runEnd). −1 is "none".
      let runY = -1;
      let runEnd = -1;
      for (let k = 0; k < LEVEL_WORDS; k++) {
        let bits = levels[base + k] ?? 0;
        while (bits !== 0) {
          // Lowest set bit first: Math.clz32 of the isolated bit gives its index.
          const lowest = bits & -bits;
          const b = 31 - Math.clz32(lowest);
          bits ^= lowest;
          const y = levelRow((k << 5) + b);
          if (y < runEnd) continue;
          if (y === runEnd) {
            runEnd = y + 1;
            continue;
          }
          if (runY >= 0) bg.fillRect(x, runY, w, runEnd - runY);
          runY = y;
          runEnd = y + 1;
        }
      }
      if (runY >= 0) bg.fillRect(x, runY, w, runEnd - runY);
    }
  }

  /**
   * The best-resolved ratio of successive doubling intervals the sweep has
   * found, with the relative uncertainty that resolution implies.
   *
   * Intervals shrink by δ each time, so the fourth is a fifth of a percent of
   * the window and a handful of columns wide: the triple with the smallest
   * uncertainty, not the deepest one, is the honest reading. Zooming in shrinks
   * h and the reading sharpens.
   *
   * A triple whose intervals do not shrink is refused: a window with no cascade
   * in it can still produce three "onsets" out of unrelated periodic windows up
   * in the chaos, and their ratio is not a measurement of anything. Everything
   * else is left to the band — a ratio resolved to ±240 % is reported with a
   * ±240 % band and the ledger declines to call it a match, which is one rule in
   * one place rather than two ceilings that can disagree.
   */
  function measuredRatio(): { value: number; half: number } {
    const h = columnWidth();
    let value = NaN;
    let half = NaN;
    for (let j = 1; j + 2 <= MAX_LEVEL; j++) {
      const first = onsets[j]!;
      const second = onsets[j + 1]!;
      const third = onsets[j + 2]!;
      const lower = second - first;
      const upper = third - second;
      // Intervals of a real cascade shrink; anything else is two unrelated
      // windows and its "ratio" means nothing.
      if (!(lower > upper && upper > 0)) continue;
      // Each onset carries ONSET_SPREAD column widths, and the ratio is a
      // quotient, so the relative errors of the two intervals add.
      const u = (lower / upper) * ONSET_SPREAD * h * (1 / lower + 1 / upper);
      if (Number.isNaN(half) || u < half) {
        value = lower / upper;
        half = u;
      }
    }
    return { value, half };
  }

  function readouts(): Readout[] {
    const cursor = computed - 1;
    const r = cursor >= 0 ? rAt(cursor) : NaN;
    const lambda = cursor >= 0 ? lyap[cursor]! : NaN;
    const period = cursor >= 0 ? periods[cursor]! : 0;
    const h = columnWidth();
    const out: Readout[] = [
      { key: 'columns', label: 'Columns rendered', value: computed, digits: 6, plain: 'columns drawn so far' },
      { key: 'span', label: 'r range', value: rHi - rLo, digits: 6, expertOnly: true },
      { key: 'r', label: 'r at cursor', value: r, digits: 7, plain: 'r under the cursor' },
      // 0 is not a period: it is "no cycle up to 64 repeats", which is chaos or
      // an orbit that has not finished settling. The canvas window already says
      // "never repeats" for it, and printing the sentinel as a number made the
      // accessible rendering of that same reading "values x cycles through 0" —
      // a cycle of length zero, which is not a thing, and indistinguishable from
      // the "no column computed yet" case that emits the same 0. NaN is the
      // app's own sentinel for a reading that does not exist: the ledger renders
      // it as an em dash and "not measured yet", for free.
      {
        key: 'period',
        label: 'Detected period',
        value: period > 0 ? period : NaN,
        digits: 2,
        plain: 'values x cycles through',
      },
      // The λ the curve on the plate is drawn from, at the cursor. It carries no
      // prediction: λ has a closed form at exactly one r, and that reading is
      // `lambda4` below, measured over an orbit long enough to test it.
      { key: 'lyapunov', label: 'Lyapunov exponent', value: lambda, digits: 4, expertOnly: true },
    ];

    // r = 4 is the one parameter where λ has a closed form: the map is conjugate
    // to the tent map there, so λ = ln 2. Two of the five windows reach it.
    if (rHi >= 4 - 1e-12) {
      out.push({
        key: 'lambda4',
        label: 'Lyapunov exponent at r = 4',
        value: lambdaAtFour,
        digits: 5,
        target: Math.LN2,
        formula: ['ln 2'],
        band: { kind: 'sampled', sigma: LAMBDA_SIGMA_AT_FOUR, samples: LAMBDA_4_SAMPLES },
        ...(measures === 'lyapunov'
          ? {
              headline: true,
              plain: 'how fast two close values pull apart',
              hint: 'above zero, two values that start out close run away from each other',
            }
          : { expertOnly: true }),
      });
    }

    // The window's own measurement. Exactly one of these is the headline, and it
    // is the one the window was chosen to show — see `Measurement`.
    if (measures === 'feigenbaum') {
      const ratio = measuredRatio();
      out.push({
        key: 'feigenbaum',
        label: 'Feigenbaum ratio',
        value: ratio.value,
        digits: 6,
        target: FEIGENBAUM_DELTA,
        formula: [{ v: 'δ' }],
        plain: 'the doubling ratio',
        headline: true,
        hint: 'the gaps between splits shrink by this much each time',
        ...(Number.isFinite(ratio.half) ? { band: { kind: 'absolute', half: ratio.half } } : {}),
      });
    } else if (measures === 'split') {
      out.push({
        key: 'split',
        label: 'First doubling',
        value: onsets[1]!,
        digits: 7,
        target: FIRST_SPLIT,
        formula: ['3'],
        plain: 'where x first splits in two',
        headline: true,
        hint: 'below it x settles down; above it, x never stops bouncing',
        // Two column widths of resolution, plus the offset a finite transient
        // puts on a resolved doubling — which does not shrink when the window
        // does, so it is added rather than counted in columns.
        band: { kind: 'absolute', half: ONSET_SPREAD * h + SETTLE_BIAS },
        range: [rLo, rHi],
      });
    } else if (measures === 'window3') {
      out.push({
        key: 'window3',
        label: 'Period-3 window',
        value: windowOnset,
        digits: 7,
        target: PERIOD_THREE_ONSET,
        formula: ['1 + √8'],
        plain: 'where x starts cycling through three values',
        headline: true,
        hint: 'a band of order sitting in the middle of the chaos',
        band: { kind: 'absolute', half: TANGENT_SPREAD * h + TANGENT_BIAS },
        range: [rLo, rHi],
      });
    }

    out.push({ key: 'iterations', label: 'Map iterations', value: iterations, digits: 9, plain: 'times the rule has run' });
    return out;
  }

  /**
   * The live cursor reading, as a display window in the top-left corner. The
   * plate is sized to `WINDOW_TEMPLATES`, so it is the same box on every frame.
   */
  function drawWindow(fg: CanvasRenderingContext2D, lines: readonly string[]): void {
    const { theme } = ctx;
    const margin = 10;
    const pad = 5;
    const lineHeight = fontPx(theme.labelFont) + 3;
    fg.font = theme.labelFont;
    fg.textAlign = 'left';
    fg.textBaseline = 'top';
    let textW = 0;
    for (const line of WINDOW_TEMPLATES) textW = Math.max(textW, fg.measureText(line).width);
    for (const line of lines) textW = Math.max(textW, fg.measureText(line).width);
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    const x = Math.round(margin - pad);
    const y = Math.round(margin - pad);
    const w = Math.round(textW + 2 * pad);
    const h = Math.round(lines.length * lineHeight + 2 * pad);
    // Opaque, because a thousand columns of vermilion read straight through a
    // translucent plate; the frame is furniture, so it takes the container pen.
    fg.fillStyle = theme.canvas;
    fg.fillRect(x, y, w, h);
    fg.strokeStyle = theme.gridSoft;
    fg.lineWidth = theme.lineWidth;
    fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);
    fg.fillStyle = theme.ink;
    lines.forEach((line, i) => fg.fillText(line, margin, margin + i * lineHeight));
  }

  const instance: VizInstance = {
    step(dt) {
      if (computed >= SWEEP_COLUMNS) return;
      // Columns per second: the sweep's own pace, capped by an iteration budget
      // so that 5,000 transient iterations at 1,000 samples cannot turn one
      // tick into a dropped frame. Both terms are properties of the window, not
      // of the plate, so the sweep advances at the same rate on every screen.
      const pace = Math.min(SWEEP_COLUMNS / SWEEP_SECONDS, ITERATION_BUDGET / (TRANSIENT + samples));
      pending += (pace * dt) / 1000;
      // A column is kept the moment it is computed, so there is no buffer to
      // outrun and no back-pressure to apply: a fast-forward simply finishes
      // more of the sweep.
      if (pending > SWEEP_COLUMNS) pending = SWEEP_COLUMNS;
      while (pending >= 1 && computed < SWEEP_COLUMNS) {
        computeColumn(computed);
        computed++;
        pending -= 1;
      }
      if (computed >= SWEEP_COLUMNS) pending = 0;
    },

    drawBackground() {
      syncStructure();
      plot = layoutPlot(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));
      // Only a change of the *mathematics* invalidates: a new window is a
      // different r for every column, and a new sample count is a different
      // orbit. A resize and a re-lettering change neither, and this method is
      // what the shell calls for both of them.
      if (shapeOf() !== sweptShape) rewind();

      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);

      // The r axis contains the experiment rather than being part of it, so it
      // takes the container pen. An odd-width line centred on a half-pixel
      // covers whole device pixels at DPR 1; on an integer it smears across two.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const axisY = Math.round(plot.y0 + plot.h) + snap;
      const left = plot.x0;
      const right = plot.x0 + plot.columns;
      const step = tickStep(rHi - rLo);
      const first = Math.ceil(rLo / step - 1e-9) * step;

      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      bg.moveTo(left, axisY);
      bg.lineTo(right, axisY);
      for (let k = 0; ; k++) {
        const t = first + k * step;
        if (t > rHi + 1e-9) break;
        const x = Math.round(left + ((t - rLo) / (rHi - rLo)) * plot.columns) + snap;
        bg.moveTo(x, axisY);
        bg.lineTo(x, axisY + AXIS_TICK);
      }
      bg.stroke();

      const decimals = tickDecimals(step);
      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;
      bg.textAlign = 'center';
      bg.textBaseline = 'top';
      // Every tick carries a numeral on a full-size plate; on a phone the same
      // eight intervals do not fit five digits each, so every other one does.
      const labelW = bg.measureText(rHi.toFixed(decimals)).width;
      const every = (step / (rHi - rLo)) * plot.columns >= labelW + 12 ? 1 : 2;
      for (let k = 0; ; k++) {
        const t = first + k * step;
        if (t > rHi + 1e-9) break;
        if (k % every !== 0) continue;
        // Centred on its tick, except at the ends: a numeral under the first
        // tick of a window that starts on a round number hangs half its width
        // off the plate and is cut in two. Nudged inside instead.
        const at = left + ((t - rLo) / (rHi - rLo)) * plot.columns;
        const x = Math.min(Math.max(at, labelW / 2 + 2), width - labelW / 2 - 2);
        bg.fillText(t.toFixed(decimals), x, axisY + AXIS_TICK + LABEL_GAP);
      }

      // The diagram itself, back out of `levels`. This is the whole of what a
      // resize costs now: the sweep is mathematics and the bitmap is a picture
      // of it, so a plate that changed shape is repainted rather than re-run.
      painted = 0;
      paintColumns(bg, 0, computed);
      painted = computed;
    },

    draw() {
      const bg = ctx.layers.background;
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;

      // Columns computed since the last frame go onto the background and stay
      // there. That is what makes a zoom progressive: the plate fills in left
      // to right instead of appearing after a stall, and a finished sweep costs
      // nothing per frame.
      if (computed > painted) {
        paintColumns(bg, painted, computed);
        painted = computed;
      }

      fg.clearRect(0, 0, width, height);

      if (SHOW_LYAPUNOV) {
        const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
        const zero = Math.round(lambdaY(0)) + snap;
        fg.strokeStyle = theme.gridSoft;
        fg.lineWidth = theme.lineWidth;
        fg.beginPath();
        fg.moveTo(plot.x0, zero);
        fg.lineTo(plot.x0 + plot.columns, zero);
        fg.stroke();
        fg.font = theme.labelFont;
        fg.fillStyle = theme.inkMuted;
        fg.textAlign = 'right';
        fg.textBaseline = 'bottom';
        fg.fillText('λ = 0', plot.x0 + plot.columns - 2, zero - 2);

        // One polyline across the columns already on screen, broken wherever λ
        // is −∞ — a superstable cycle passes through the critical point, where
        // the derivative is exactly zero and the logarithm has no value.
        fg.lineJoin = 'round';
        fg.beginPath();
        let open = false;
        for (let c = 0; c < painted; c++) {
          const v = lyap[c]!;
          if (!Number.isFinite(v)) {
            open = false;
            continue;
          }
          const x = columnX(c) + Math.max(1, columnX(c + 1) - columnX(c)) / 2;
          const y = lambdaY(v);
          if (open) fg.lineTo(x, y);
          else {
            fg.moveTo(x, y);
            open = true;
          }
        }
        // The curve crosses its own diagram everywhere, and the two pens are
        // 1.96:1 apart, so the plate colour goes down between them.
        strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);
      }

      // The sweep cursor: the one thing on this plate that is current and
      // moving, and it disappears when the sweep is done.
      if (computed < SWEEP_COLUMNS) {
        const x = columnX(computed) + 0.5;
        fg.strokeStyle = theme.data1;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.beginPath();
        fg.moveTo(x, plot.y0);
        fg.lineTo(x, plot.y0 + plot.h);
        fg.stroke();
      }

      // Two lines, both of them in the ledger: where the cursor is, and what x
      // does there. λ is an expert reading and stays in the exact table.
      const cursor = computed - 1;
      const r = cursor >= 0 ? rAt(cursor) : NaN;
      const period = cursor >= 0 ? periods[cursor]! : 0;
      drawWindow(fg, [`r ${Number.isFinite(r) ? fmt(r, 7) : '—'}`, cursor < 0 ? '—' : cycleText(period)]);

      ctx.emit(readouts());
    },

    onParamChange() {
      // zoom, detail, seed: every column on the plate belongs to a different
      // diagram, so the shell resets and the sweep runs again.
      return false;
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      // Every column's jitter is drawn here, once, rather than as the sweep
      // reaches it: a resize rewinds the sweep, and a run that consumed the
      // stream column by column would come back a different diagram for the
      // same seed.
      for (let c = 0; c < SWEEP_COLUMNS; c++) jitter[c] = ctx.rng.next();
      syncStructure();
      rewind();
      ctx.layers.foreground.clearRect(0, 0, ctx.width, ctx.height);
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const bifurcation: Viz = {
  id: 'bifurcation',
  title: 'Logistic Bifurcation',
  group: 'chaos',
  blurb: [
    'Runs the rule ', { v: 'x' }, ' → ', { v: 'r' }, { v: 'x' }, '(1 − ', { v: 'x' }, ') over and over and plots where ',
    { v: 'x' }, ' ends up, for every setting of the dial ', { v: 'r' }, '.',
  ],
  // Landscape: r is the long axis, and every column is one pixel of it, so the
  // plate's width is literally the resolution of the measurement. Still wide on
  // a phone, where a portrait bed would halve the columns.
  aspect: 1.6,
  aspectNarrow: 1.1,
  params,
  presets,
  facts,
  // Orbit samples the sweep holds: one bit per attractor level per column, the
  // whole diagram kept as mathematics rather than as pixels.
  budget: { maxEntities: SWEEP_COLUMNS * VALUE_LEVELS },
  create,
};
