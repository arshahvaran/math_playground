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
  detectPeriod,
  lyapunovFrom,
  sampleAttractor,
} from './logistic';

/**
 * Columns the sweep can hold, one CSS pixel each. A plate wider than this does
 * not exist in the layout; the cap is what lets every per-column array be
 * allocated once at load rather than on every resize.
 */
const MAX_COLUMNS = 2048;

/** Slider ceilings. `samples ≤ MAX_PLOT_ROWS` is what makes the dedupe below safe. */
const MAX_SAMPLES = 2000;
const MAX_PLOT_ROWS = 4096;

/**
 * Pixel rows held between two frames, across every column not yet painted.
 *
 * `step()` computes columns and `draw()` puts them on the background layer, so
 * something has to hold the ones in between — and a fast-forward runs hundreds
 * of steps with no frame between them. A ring of columns is that buffer: at the
 * default 400 samples it holds 1,280 columns, more than any plate has, so a
 * single fast-forward finishes the sweep; at 2,000 samples it holds 256 and the
 * sweep simply advances in batches of that. Nothing here ever reallocates.
 */
const MAX_PENDING_POINTS = 512_000;

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
 * publishes the resulting relative uncertainty as its tolerance, so the ledger
 * judges the ratio against what the sweep can actually see.
 */
const ONSET_SPREAD = 2;

/**
 * Relative uncertainty above which the Feigenbaum reading is withheld. A ratio
 * this loose says nothing about a constant known to ten digits, and the
 * ledger's "waiting for the first sample" is the honest reading instead.
 */
const MAX_RATIO_UNCERTAINTY = 0.25;

/**
 * Seconds a full sweep takes when nothing else binds. Slow enough that the
 * columns are visibly laid down left to right, fast enough that a zoom is not
 * a wait.
 */
const SWEEP_SECONDS = 2.5;

/**
 * Map iterations per second of simulated time. The pace above sets the column
 * rate; this caps it, so the deepest transient and the largest sample count
 * cannot turn one tick into a dropped frame.
 */
const ITERATION_BUDGET = 4e6;

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

const DEFAULT_R_MIN = 2.4;
const DEFAULT_R_MAX = 4;
const DEFAULT_TRANSIENT = 2000;
const DEFAULT_SAMPLES = 400;
const DEFAULT_SEED = 42;

/** Narrowest window the r sliders may bracket, so a permalink cannot ask for a column of zero width. */
const MIN_SPAN = 0.001;

/**
 * Standard deviation of ln|f′| at r = 4, where the invariant density is the
 * arcsine law: with u = 1 − 2x the term is ln 4 + ln|u| and Var(ln|cos φ|) over
 * uniform φ is π²/12, so σ = 0.9069. It sets the tolerance on the one Lyapunov
 * reading that has a closed-form target.
 */
const LAMBDA_SIGMA_AT_FOUR = Math.PI / Math.sqrt(12);

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'rMin',
    label: 'r from',
    min: 0,
    max: 4,
    step: 0.001,
    default: DEFAULT_R_MIN,
    help: ['Left edge of the window. Below ', { v: 'r' }, ' = 1 every orbit falls to zero.'],
  },
  {
    kind: 'range',
    key: 'rMax',
    label: 'r to',
    min: 0,
    max: 4,
    step: 0.001,
    default: DEFAULT_R_MAX,
    help: ['Right edge. Above ', { v: 'r' }, ' = 4 the orbit leaves [0, 1] and escapes.'],
  },
  {
    kind: 'int',
    key: 'transient',
    label: 'Transient',
    min: 100,
    max: 5000,
    default: DEFAULT_TRANSIENT,
    help: 'Iterations thrown away before a column is sampled, so what is plotted is the attractor and not the approach to it.',
  },
  {
    kind: 'int',
    key: 'samples',
    label: 'Samples per column',
    min: 50,
    max: MAX_SAMPLES,
    default: DEFAULT_SAMPLES,
    help: 'Iterates plotted per column after the transient. More of them fill the chaotic bands and resolve deeper cycles.',
  },
  {
    kind: 'toggle',
    key: 'showLyapunov',
    label: 'Lyapunov exponent',
    default: true,
    help: [
      'Draw ', { v: 'λ' }, ' = mean of ln|', { v: 'r' }, '(1 − 2', { v: 'x' }, ')| over the orbit: ',
      'negative where the orbit is periodic, positive where it is chaotic, zero at every bifurcation.',
    ],
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    // The map is deterministic: a column depends on r alone, because every
    // starting point in (0, 1) converges to the same attractor. The seed only
    // jitters each column's x₀ inside [0.3, 0.7), which decorrelates the
    // leftover transient from one column to the next instead of drawing the
    // same approach curve across the whole plate.
    help: [
      'The map is deterministic — the seed only jitters each column’s starting ',
      { v: 'x' }, '₀, which every orbit forgets.',
    ],
  },
];

const presets: readonly Preset[] = [
  {
    id: 'whole-map',
    label: 'The whole map',
    caption: [
      'One rule, every ', { v: 'r' }, ': a single settling point, then two, then four, then a cascade ',
      'that accumulates at 3.5699 and hands the plate over to chaos.',
    ],
    values: { rMin: 2.4, rMax: 4, transient: 2000, samples: 400, showLyapunov: true },
  },
  {
    id: 'first-doubling',
    label: 'First doubling',
    caption: [
      'At ', { v: 'r' }, ' = 3 the fixed point 1 − 1/', { v: 'r' }, ' stops attracting and the orbit splits in two. ',
      { v: 'λ' }, ' touches zero exactly there.',
    ],
    values: { rMin: 2.9, rMax: 3.1, transient: 3000, samples: 400, showLyapunov: true },
  },
  {
    id: 'cascade',
    label: 'Cascade',
    caption: [
      'Four doublings in a window a fifth of a unit wide. Each interval is about 4.669 times the next — ',
      'the measured ratio in the ledger is the whole of Feigenbaum’s ', { v: 'δ' }, '.',
    ],
    values: { rMin: 3.4, rMax: 3.57, transient: 5000, samples: 500, showLyapunov: true },
  },
  {
    id: 'period-three',
    label: 'Period three',
    caption: [
      'A band of pure order inside the chaos, opening at ', { v: 'r' }, ' = 1 + √8 = 3.828427 where ',
      { v: 'λ' }, ' dives back below zero. Period three implies chaos — this is what it looks like.',
    ],
    values: { rMin: 3.82, rMax: 3.86, transient: 2000, samples: 500, showLyapunov: true },
  },
  {
    id: 'deep-chaos',
    label: 'Deep chaos',
    caption: [
      'No cycle up to 64 repeats and ', { v: 'λ' }, ' stays positive, reaching ln 2 exactly at ',
      { v: 'r' }, ' = 4, where the map is the tent map in disguise.',
    ],
    values: { rMin: 3.95, rMax: 4, transient: 2000, samples: 1000, showLyapunov: true },
  },
];

const facts: readonly Fact[] = [
  {
    text: [
      'Feigenbaum found ', { v: 'δ' }, ' = 4.6692016 on an HP-65 calculator in 1975 and then showed it is universal: ',
      'every smooth map with a single quadratic maximum period-doubles at the same rate, which is why the ',
      'same number turns up in dripping taps and convecting fluids.',
    ],
    source: {
      label: 'Feigenbaum, “Quantitative universality for a class of nonlinear transformations”, J. Stat. Phys. 19 (1978) 25–52',
      url: 'https://doi.org/10.1007/BF01020332',
    },
  },
  {
    text: [
      'Li and Yorke proved in 1975 that a continuous map of an interval with a point of period three has points ',
      'of every period, and uncountably many orbits that never settle — the paper that put the word chaos into ',
      'mathematics. Sharkovskii had proved the stronger ordering behind it in 1964, in Ukrainian, unnoticed.',
    ],
    source: {
      label: 'Li and Yorke, “Period Three Implies Chaos”, American Mathematical Monthly 82 (1975) 985–992',
      url: 'https://doi.org/10.2307/2318254',
    },
  },
  {
    text: [
      'Robert May put this diagram in Nature in 1976 to make an ecological point: a population model with no ',
      'noise and one parameter can produce data indistinguishable from randomness, so a wild-looking census ',
      'is not evidence of a complicated cause.',
    ],
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

function flag(values: ParamValues, key: string, fallback: boolean): boolean {
  const v = values[key];
  return typeof v === 'boolean' ? v : fallback;
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
  let rLo = DEFAULT_R_MIN;
  let rHi = DEFAULT_R_MAX;
  let transient = DEFAULT_TRANSIENT;
  let samples = DEFAULT_SAMPLES;
  // Cosmetic, absorbed live: the curve lives on the foreground, which is
  // repainted every frame anyway.
  let showLyapunov = true;

  let plot = layoutPlot(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));

  // Every array is allocated here, once, at its ceiling.
  const orbit = new Float64Array(MAX_SAMPLES);
  const jitter = new Float64Array(MAX_COLUMNS);
  const lyap = new Float64Array(MAX_COLUMNS);
  const periods = new Uint8Array(MAX_COLUMNS);
  /** Ring of columns, each `stride` pixel rows wide. */
  const pixelRows = new Uint16Array(MAX_PENDING_POINTS);
  const rowCount = new Uint16Array(MAX_COLUMNS);
  /**
   * One stamp per pixel row, holding the column that last claimed it. Four
   * hundred iterates of a period-2 orbit land on two rows; stamping instead of
   * clearing turns that into two fillRect calls rather than four hundred, and
   * needs no clear between columns because the stamp is the column index.
   */
  const rowStamp = new Uint16Array(MAX_PLOT_ROWS);
  /** Observed r of the first column resolving period 2ᵏ, NaN where not seen. */
  const onsets = new Float64Array(MAX_LEVEL + 1);

  let stride = DEFAULT_SAMPLES;
  let ringColumns = 1;

  let computed = 0;
  let painted = 0;
  let iterations = 0;
  let pending = 0;
  /** Doubling level of the last column that resolved one; −1 before the first. */
  let prevLevel = -1;

  /** Centre of column `c` in r. */
  function rAt(c: number): number {
    return rLo + ((c + 0.5) * (rHi - rLo)) / plot.columns;
  }

  /** Screen row for an attractor value in [0, 1]. */
  function valueRow(x: number): number {
    const y = Math.round(plot.y0 + (1 - x) * plot.h);
    if (y < plot.y0) return plot.y0;
    const floor = plot.y0 + plot.h - 1;
    return y > floor ? floor : y;
  }

  /** Screen y for a Lyapunov exponent, clamped to the drawn band. */
  function lambdaY(v: number): number {
    const clamped = v > LAMBDA_TOP ? LAMBDA_TOP : v < LAMBDA_BOTTOM ? LAMBDA_BOTTOM : v;
    return plot.y0 + (plot.h * (LAMBDA_TOP - clamped)) / (LAMBDA_TOP - LAMBDA_BOTTOM);
  }

  function syncLive(): void {
    showLyapunov = flag(ctx.params, 'showLyapunov', true);
  }

  function syncStructure(): void {
    const a = Math.min(4, Math.max(0, num(ctx.params, 'rMin', DEFAULT_R_MIN)));
    const b = Math.min(4, Math.max(0, num(ctx.params, 'rMax', DEFAULT_R_MAX)));
    // A permalink can arrive with the ends the wrong way round, or equal.
    rLo = Math.min(a, b);
    rHi = Math.max(a, b);
    if (rHi - rLo < MIN_SPAN) rHi = Math.min(4, rLo + MIN_SPAN);
    if (rHi - rLo < MIN_SPAN) rLo = rHi - MIN_SPAN;

    transient = Math.max(0, Math.round(num(ctx.params, 'transient', DEFAULT_TRANSIENT)));
    samples = Math.max(2, Math.min(MAX_SAMPLES, Math.round(num(ctx.params, 'samples', DEFAULT_SAMPLES))));
    // Dedupe caps a column at one row per pixel, and samples ≤ MAX_PLOT_ROWS,
    // so `samples` rows per slot can never overflow.
    stride = samples;
    ringColumns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(MAX_PENDING_POINTS / stride)));
  }

  /**
   * Rewind the sweep without touching a pixel.
   *
   * Called by both `reset()` and `drawBackground()`, because either can be the
   * one that invalidates the columns already computed and the contract does not
   * fix which the shell calls first: a resize moves every column's r, and the
   * pixel rows in the ring were quantised against a plate that no longer
   * exists. Running it twice is free.
   */
  function rewind(): void {
    computed = 0;
    painted = 0;
    iterations = 0;
    pending = 0;
    prevLevel = -1;
    onsets.fill(NaN);
    rowStamp.fill(0);
  }

  /**
   * Compute one column: its attractor, its period, its Lyapunov exponent, and
   * the distinct pixel rows the samples occupy.
   */
  function computeColumn(c: number): void {
    const r = rAt(c);
    // x₀ jittered across [0.3, 0.7). Every orbit in (0, 1) forgets where it
    // started, so this changes no column's attractor — it only decorrelates
    // whatever transient is left over from one column to the next, instead of
    // drawing the same approach curve across the whole plate. The one starting
    // point that would matter is ½, which at r = 4 maps to 1 and then to the
    // dead fixed point 0; a draw from a 32-bit stream lands on it once in 2³².
    sampleAttractor(orbit, 0, samples, r, transient, 0.3 + 0.4 * jitter[c]!);

    const period = detectPeriod(orbit, DEFAULT_PERIOD_TOL, 0, samples);
    periods[c] = period > 255 ? 255 : period;
    lyap[c] = lyapunovFrom(orbit, r, 0, samples);
    iterations += transient + samples;

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

    const slot = (c % ringColumns) * stride;
    const stamp = c + 1;
    let n = 0;
    for (let i = 0; i < samples; i++) {
      const row = valueRow(orbit[i]!);
      if (rowStamp[row] === stamp) continue;
      rowStamp[row] = stamp;
      pixelRows[slot + n] = row;
      n++;
    }
    rowCount[c % ringColumns] = n;
  }

  /**
   * The best-resolved ratio of successive doubling intervals the sweep has
   * found, with the relative uncertainty that resolution implies.
   *
   * Intervals shrink by δ each time, so the fourth is a fifth of a percent of
   * the window and a handful of columns wide: the triple with the smallest
   * uncertainty, not the deepest one, is the honest reading. Zooming in shrinks
   * h and the reading sharpens — on the whole map it measures 4.878, 4.5% from
   * δ, with 5.9% of slack; on the Cascade preset 4.624, 1.0% out, with 2.9%.
   *
   * Nothing is reported at all above `MAX_RATIO_UNCERTAINTY`: a window with no
   * cascade in it — the period-3 window, or 3.95 to 4 — can still produce three
   * shrinking intervals out of unrelated periodic windows in the chaos, and a
   * "ratio" known to ±240% is not a measurement of a constant known to ten
   * digits. The ledger's empty state says so better than a number would.
   */
  function measuredRatio(): { value: number; tolerance: number } {
    const h = (rHi - rLo) / plot.columns;
    let value = NaN;
    let tolerance = NaN;
    for (let j = 1; j + 2 <= MAX_LEVEL; j++) {
      const first = onsets[j]!;
      const second = onsets[j + 1]!;
      const third = onsets[j + 2]!;
      const lower = second - first;
      const upper = third - second;
      // Intervals of a real cascade shrink; anything else is two unrelated
      // windows and its "ratio" means nothing.
      if (!(lower > upper && upper > 0)) continue;
      const u = ONSET_SPREAD * h * (1 / lower + 1 / upper);
      if (u > MAX_RATIO_UNCERTAINTY) continue;
      if (Number.isNaN(tolerance) || u < tolerance) {
        value = lower / upper;
        tolerance = u;
      }
    }
    return { value, tolerance };
  }

  function readouts(): Readout[] {
    const cursor = computed - 1;
    const r = cursor >= 0 ? rAt(cursor) : NaN;
    const lambda = cursor >= 0 ? lyap[cursor]! : NaN;
    const period = cursor >= 0 ? periods[cursor]! : 0;
    const ratio = measuredRatio();
    // r = 4 is the one parameter where λ has a closed form: the map is
    // conjugate to the tent map there, so λ = ln 2. The cursor reads a column's
    // centre, and the rightmost column's centre is half a column short of the
    // window's edge, so the test is whether the column *contains* r = 4.
    const atFour = cursor >= 0 && Math.abs(r - 4) <= (rHi - rLo) / (2 * plot.columns) + 1e-12;
    return [
      { key: 'columns', label: 'Columns rendered', value: computed, digits: 6 },
      { key: 'span', label: 'r range', value: rHi - rLo, digits: 6 },
      { key: 'r', label: 'r at cursor', value: r, digits: 7 },
      // 0 is not a period: it is "no cycle up to 64 repeats", which is chaos or
      // an orbit that has not finished settling.
      { key: 'period', label: 'Detected period', value: period, digits: 2 },
      {
        key: 'lyapunov',
        label: 'Lyapunov exponent',
        value: lambda,
        digits: 4,
        ...(atFour
          ? {
              target: Math.LN2,
              formula: ['ln 2'],
              // λ̂ is a mean of `samples` terms whose standard deviation under
              // the arcsine density is π/√12, so its standard error is
              // 0.9069/√n — 6.5% of ln 2 at 400 samples. Three of those.
              tolerance: (3 * LAMBDA_SIGMA_AT_FOUR) / (Math.sqrt(samples) * Math.LN2),
            }
          : {}),
      },
      {
        key: 'feigenbaum',
        label: 'Feigenbaum ratio',
        value: ratio.value,
        digits: 6,
        target: FEIGENBAUM_DELTA,
        formula: [{ v: 'δ' }],
        ...(Number.isFinite(ratio.tolerance) ? { tolerance: ratio.tolerance } : {}),
      },
      { key: 'iterations', label: 'Map iterations', value: iterations, digits: 9 },
    ];
  }

  /** The live cursor reading, as a display window in the top-left corner. */
  function drawWindow(fg: CanvasRenderingContext2D, lines: readonly string[]): void {
    const { theme } = ctx;
    const margin = 10;
    const pad = 5;
    const lineHeight = fontPx(theme.labelFont) + 3;
    fg.font = theme.labelFont;
    fg.textAlign = 'left';
    fg.textBaseline = 'top';
    let textW = 0;
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
      if (computed >= plot.columns) return;
      // Columns per second: the sweep's own pace, capped by an iteration budget
      // so that 5,000 transient iterations at 2,000 samples cannot turn one
      // tick into a dropped frame.
      const pace = Math.min(plot.columns / SWEEP_SECONDS, ITERATION_BUDGET / (transient + samples));
      pending += (pace * dt) / 1000;
      while (pending >= 1 && computed < plot.columns && computed - painted < ringColumns) {
        computeColumn(computed);
        computed++;
        pending -= 1;
      }
      // With the ring full — a fast-forward outrunning the frames that drain it
      // — the debt would otherwise grow without bound and then discharge in one
      // burst that skips half the plate.
      if (pending > ringColumns) pending = ringColumns;
      if (computed >= plot.columns) pending = 0;
    },

    drawBackground() {
      // Resize and parameter change both land here, and both invalidate every
      // column already computed: the rows in the ring were quantised against
      // the old plate, and r is a different function of the column index.
      syncStructure();
      plot = layoutPlot(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));
      rewind();

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
      // eight intervals do not fit six digits each, so every other one does.
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
        bg.fillStyle = theme.data1;
        for (let c = painted; c < computed; c++) {
          const x = plot.x0 + c;
          const slot = (c % ringColumns) * stride;
          const n = rowCount[c % ringColumns]!;
          for (let i = 0; i < n; i++) bg.fillRect(x, pixelRows[slot + i]!, 1, 1);
        }
        painted = computed;
      }

      fg.clearRect(0, 0, width, height);

      if (showLyapunov) {
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
          const x = plot.x0 + c + 0.5;
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
      if (computed < plot.columns) {
        const x = plot.x0 + computed + 0.5;
        fg.strokeStyle = theme.data1;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.beginPath();
        fg.moveTo(x, plot.y0);
        fg.lineTo(x, plot.y0 + plot.h);
        fg.stroke();
      }

      const cursor = computed - 1;
      const r = cursor >= 0 ? rAt(cursor) : NaN;
      const lambda = cursor >= 0 ? lyap[cursor]! : NaN;
      const period = cursor >= 0 ? periods[cursor]! : 0;
      drawWindow(fg, [
        `r ${Number.isFinite(r) ? fmt(r, 7) : '—'}`,
        `λ ${Number.isFinite(lambda) ? fmt(lambda, 4) : '—'}`,
        `period ${cursor < 0 ? '—' : period === 0 ? 'none' : String(period)}`,
      ]);

      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      if (key === 'showLyapunov') {
        showLyapunov = value === true;
        return true;
      }
      // rMin, rMax, transient, samples, seed: every column on the plate belongs
      // to a different diagram, so the shell resets and the sweep runs again.
      return false;
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      // Every column's jitter is drawn here, once, rather than as the sweep
      // reaches it: a resize rewinds the sweep, and a run that consumed the
      // stream column by column would come back a different diagram for the
      // same seed.
      for (let c = 0; c < MAX_COLUMNS; c++) jitter[c] = ctx.rng.next();
      syncStructure();
      syncLive();
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
    'Iterates ', { v: 'x' }, ' ↦ ', { v: 'r' }, { v: 'x' }, '(1 − ', { v: 'x' }, ') a few thousand times per column ',
    'and plots what is left, against ', { v: 'r' }, '.',
  ],
  // Landscape: r is the long axis, and every column is one pixel of it, so the
  // plate's width is literally the resolution of the measurement. Still wide on
  // a phone, where a portrait bed would halve the columns.
  aspect: 1.6,
  aspectNarrow: 1.1,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_PENDING_POINTS },
  create,
};
