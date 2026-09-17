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
import {
  Crowd,
  MEAN_GAP,
  NAIVE_WAIT,
  Timetable,
  WaitHistory,
  dropPassenger,
  expectedWait,
  experiencedGap,
  gapStddev,
  waitStandardError,
} from './buses';

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Hard ceiling on passengers; the fader tops out here too. */
const MAX_PASSENGERS = 50_000;
const MIN_PASSENGERS = 500;
const DEFAULT_PASSENGERS = 20_000;

/**
 * Passengers per gap, over the whole timetable. This is the one number that
 * ties the picture to the statistics, and it is a constant because it has to be
 * both things at once.
 *
 * The painted window is a fixed stretch of timetable (`WINDOW_MINUTES`), so the
 * dots that land in it number `passengers · WINDOW_MINUTES / totalMinutes`,
 * which with a timetable of `passengers / PASSENGERS_PER_GAP` gaps comes to
 * `PASSENGERS_PER_GAP · WINDOW_MINUTES / MEAN_GAP` — 180 dots over 90 gaps,
 * *whatever the fader says*. The picture therefore has the same weight at 500
 * passengers and at 50,000, and only the readouts sharpen.
 *
 * Two is also where the standard error is honest: the timetable's own sampling
 * error contributes 2μ²/G = 4μ²/N at cv = 1, against μ²/N from the passengers,
 * so the measurement costs √5·μ/√N. One dot per gap would buy √3 instead and
 * leave the long gaps looking no busier than the short ones, which is the
 * entire argument.
 */
const PASSENGERS_PER_GAP = 2;

/** Gaps the timetable can hold, and the size of the array allocated for them. */
const MAX_GAPS = MAX_PASSENGERS / PASSENGERS_PER_GAP;

/**
 * The stream is paced so a run takes about this long whatever the passenger
 * count, between a floor that keeps a short run from finishing before it is
 * seen and a ceiling that keeps a long one from becoming a blur.
 */
const RUN_SECONDS = 20;
const MIN_RATE = 25;
const MAX_RATE = 2_500;

const DEFAULT_SPREAD = 100;
const DEFAULT_SEED = 42;

// ---------------------------------------------------------------------------
// The painted window
// ---------------------------------------------------------------------------

/** Rows of timetable on the plate. */
const ROWS = 6;

/** Minutes of timetable in one row. Fifteen buses' worth at the average gap. */
const MINUTES_PER_ROW = 150;

/**
 * The stretch of timetable the plate shows: fifteen hours of buses.
 *
 * Fixed in minutes rather than derived from the plate, so the experiment on
 * screen is the same experiment on a phone and on a 1,280 px window — the
 * pixels per minute change, the window does not. Everything past it is counted
 * and never painted, which is the Buffon rule: what you paint is an ink budget,
 * what you count is the measurement.
 */
const WINDOW_MINUTES = ROWS * MINUTES_PER_ROW;

/**
 * Painted passengers held. The expected occupancy is
 * `PASSENGERS_PER_GAP · WINDOW_MINUTES / MEAN_GAP` = 180 with a standard
 * deviation near 13, so 600 is over thirty of those above the mean: the ring
 * exists so that no draw can make the plate unbounded, not because it is
 * expected to wrap. If it ever did, it would drop the earliest arrivals, and
 * the accumulated picture of which gaps are busy is exactly what must not be
 * dropped — hence the headroom rather than a tighter budget.
 */
const MAX_PAINTED = 600;

/**
 * Gaps in the window whose painted crowd is counted, for finding the busiest
 * one. The window holds about 90; anything past this bound is painted and
 * counted in the readouts, it simply cannot be the one highlighted.
 */
const MAX_WINDOW_GAPS = 512;

/**
 * How far the bus ticks overhang the band they divide, CSS px.
 *
 * Two, not three, and `ROW_GAP` is eight rather than six, because at the
 * regular end of the dial every row holds exactly fifteen ten-minute gaps and
 * the ticks of one row land on the same pixel columns as the ticks of the next.
 * With three px of overhang into a six px gutter they met, and the plate grew a
 * cage of near-black full-height rules with the passengers in the cells — which
 * is the exact failure DESIGN §7 records against the first Galton render. Four
 * px of white between one tick and the one below keeps the rows six readings of
 * a timetable rather than a sheet of graph paper.
 */
const TICK_OVER = 2;

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Gap between the timetable and the settling chart, CSS px. */
const PANEL_GAP = 16;

/** The timetable's share of the plate height. */
const TIMETABLE_SHARE = 0.55;

/** A band taller than this stops reading as a strip of timetable, CSS px. */
const MAX_ROW_PITCH = 46;

/** Air between one band and the next, CSS px. See `TICK_OVER`. */
const ROW_GAP = 8;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlateLayout {
  /** One band per row, top to bottom. Row `i` spans minutes `i·MINUTES_PER_ROW` on. */
  rows: readonly Rect[];
  /** The settling chart's whole area, its axis gutters included. */
  chart: Rect;
}

/**
 * Split the plate between the timetable and the settling chart.
 *
 * The row count is fixed, not derived: the window is a fixed stretch of
 * timetable, so a plate that fitted seven rows would be showing a different
 * experiment from one that fitted five. Tall plates get air between the bands
 * instead, which is what `MAX_ROW_PITCH` buys.
 */
export function layoutPlate(width: number, height: number): PlateLayout {
  const w = Math.max(1, width - 2 * PLATE_PAD);
  const h = Math.max(1, height - 2 * PLATE_PAD);
  const stripH = Math.max(1, (h - PANEL_GAP) * TIMETABLE_SHARE);
  const pitch = Math.min(MAX_ROW_PITCH, stripH / ROWS);
  const band = Math.max(4, pitch - ROW_GAP);
  const top = PLATE_PAD + (stripH - pitch * ROWS) / 2;
  const rows: Rect[] = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push({ x: PLATE_PAD, y: top + i * pitch, width: w, height: band });
  }
  const chartY = PLATE_PAD + stripH + PANEL_GAP;
  return { rows, chart: { x: PLATE_PAD, y: chartY, width: w, height: Math.max(1, PLATE_PAD + h - chartY) } };
}

// ---------------------------------------------------------------------------
// The settling chart's scales — pure
// ---------------------------------------------------------------------------

/** Room for the minute numerals left of the data box: `20` plus its tick and gap. */
const GUTTER_LEFT = 28;
/** Room for the passenger-count numerals under the box. */
const GUTTER_BOTTOM = 18;
/** Room for the two captions above the box. */
const GUTTER_TOP = 15;
const GUTTER_RIGHT = 8;

/** Axis tick length and the gap between a tick and its numeral, CSS px. */
const TICK = 4;
const LABEL_GAP = 3;

/**
 * Top of the wait axis, minutes. Twice the average gap, so the prediction at
 * cv = 1 sits at the half-way rule and the naive answer at the quarter, and the
 * first few passengers' wild running average still has somewhere to be drawn.
 */
const WAIT_AXIS_MAX = 2 * MEAN_GAP;

/** Minutes between the labelled rules on the wait axis. */
const WAIT_AXIS_STEP = 5;

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side and would otherwise erase the frame wherever a
 * reading sits on the axis.
 */
const HALO_PAD = 3;

export interface ChartScale {
  /** The data box, inside the gutters. The frame is drawn on its edges. */
  box: Rect;
  /** Right end of the passenger axis. The left end is one passenger. */
  nMax: number;
}

export function chartScale(area: Rect, nMax: number): ChartScale {
  return {
    box: {
      x: area.x + GUTTER_LEFT,
      y: area.y + GUTTER_TOP,
      width: Math.max(1, area.width - GUTTER_LEFT - GUTTER_RIGHT),
      height: Math.max(1, area.height - GUTTER_TOP - GUTTER_BOTTOM),
    },
    nMax: Math.max(10, nMax),
  };
}

/**
 * Passengers → x, logarithmically from one passenger to `nMax`.
 *
 * Logarithmic because the whole story is in the first few hundred arrivals: on
 * a linear axis a fifty-thousand-passenger run draws its entire settling inside
 * the first four pixels and then a flat line.
 */
export function chartX(s: ChartScale, n: number): number {
  const t = Math.log10(Math.max(1, n)) / Math.log10(s.nMax);
  return s.box.x + Math.min(1, t) * s.box.width;
}

/** Minutes → y, top down, linear from zero to `WAIT_AXIS_MAX`, clamped into the box. */
export function chartY(s: ChartScale, minutes: number, pad = 0): number {
  const inset = Math.min(pad, s.box.height / 2);
  const bottom = s.box.y + s.box.height - inset;
  if (!Number.isFinite(minutes)) return bottom;
  const y = s.box.y + (1 - minutes / WAIT_AXIS_MAX) * s.box.height;
  return Math.min(Math.max(y, s.box.y + inset), bottom);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Two faders. The seed is declared as well, because the URL carries it and the
 * transport's Shuffle key draws a fresh one, but the rail never renders a seed
 * spec — it is not a control, and without the spec a permalink's `?seed=7`
 * would be dropped on the way in.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'spread',
    label: 'How irregular',
    min: 0,
    max: 100,
    step: 5,
    default: DEFAULT_SPREAD,
    unit: '%',
    help: 'Zero means every bus is exactly ten minutes after the last one, a hundred means they turn up completely at random, and the average gap is ten minutes either way.',
  },
  {
    kind: 'range',
    key: 'passengers',
    label: 'Passengers',
    min: MIN_PASSENGERS,
    max: MAX_PASSENGERS,
    step: 100,
    default: DEFAULT_PASSENGERS,
    log: true,
    help: 'How many people turn up at the stop; only the ones on the stretch of timetable shown get a dot, but every one of them is counted.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
  },
];

/** Three timetables with the same average gap, in the order that walks to the point. */
const presets: readonly Preset[] = [
  {
    id: 'clockwork',
    label: 'Clockwork',
    caption: 'Every bus is exactly ten minutes after the last one, and the average wait is five minutes — half the gap, just as everybody guesses.',
    values: { spread: 0 },
  },
  {
    id: 'a-bit-ragged',
    label: 'A bit ragged',
    caption: 'The buses drift a little, the average gap is still ten minutes, and the average wait has already climbed past five.',
    values: { spread: 50 },
  },
  {
    id: 'at-random',
    label: 'Buses at random',
    caption: 'Now they turn up completely at random, the average gap is still ten minutes, and the average wait has doubled to ten.',
    values: { spread: 100 },
  },
];

const facts: readonly Fact[] = [
  {
    text: 'The rider sees more delay than the operator does, because the stretch of timetable you turn up in is picked in proportion to its own length.',
    source: {
      label: 'Wikipedia, Renewal theory — the inspection paradox',
      url: 'https://en.wikipedia.org/wiki/Renewal_theory#Inspection_paradox',
    },
  },
  {
    text: 'Scott Feld showed in 1991 that your friends have more friends than you do on average, which is the same counting mistake wearing a different hat.',
    source: {
      label: "Feld, 'Why Your Friends Have More Friends Than You Do', American Journal of Sociology 96(6), 1991",
      url: 'https://doi.org/10.1086/229693',
    },
  },
];

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** σ/μ from the percentage the fader shows. */
function irregularity(values: ParamValues): number {
  return Math.min(100, Math.max(0, num(values, 'spread', DEFAULT_SPREAD))) / 100;
}

/** Passengers this run will follow, clamped the way `step()` clamps its own ceiling. */
function passengerTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_PASSENGERS, Math.floor(num(values, 'passengers', DEFAULT_PASSENGERS))));
}

/** Gaps the timetable needs so that the painted window holds its two dots a gap. */
function gapsFor(passengers: number): number {
  return Math.max(1, Math.min(MAX_GAPS, Math.ceil(passengers / PASSENGERS_PER_GAP)));
}

/** Passengers per second that finish a run of `passengers` in about RUN_SECONDS. */
export function arrivalRateFor(passengers: number): number {
  return Math.min(MAX_RATE, Math.max(MIN_RATE, passengers / RUN_SECONDS));
}

/** Pixel size out of a CSS font shorthand, for sizing a display window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * Standard error of the average *gap landed in* after `passengers` arrivals
 * onto a timetable of `gaps` gaps. Two sources, exactly as `waitStandardError`
 * has, and neither term is the wait's.
 *
 * **Passenger sampling.** The gap caught is the length-biased X*, and with the
 * gamma moments E[Xʲ] = μʲ·∏(1 + (i−1)cv²) from `buses.ts`, writing A = 1 + cv²
 * and B = 1 + 2cv²:
 *
 *   E[X*] = E[X²]/E[X] = μA     E[X*²] = E[X³]/E[X] = μ²AB
 *   Var(X*) = μ²A(B − A) = μ²A·cv²
 *
 * which is 0 at cv = 0 and 2μ² at cv = 1. The wait is a uniform point *inside*
 * that gap, so its variance is μ²(AB/3 − A²/4) — μ² at cv = 1 — and four of
 * those is 4μ², twice this. Taking the wait's band for this row therefore
 * overstated it by √2 on this term, in the direction that buys verdicts.
 *
 * **Timetable sampling.** For a fixed timetable the measurement converges on
 * M₂/M₁, which is exactly twice what the wait converges to, so this term is
 * four times the wait's: μ²A(BE + A − 2AB + A·cv²) with E = 1 + 3cv².
 *
 * `cv` is the dial, already clamped to [0, 1] by `irregularity()`. NaN with no
 * passengers or no timetable: no draws, no information, and a band that is not
 * a number is one the ledger refuses rather than one it widens to infinity.
 */
export function caughtGapStandardError(cv: number, passengers: number, gaps: number): number {
  const n = Math.floor(passengers);
  const g = Math.floor(gaps);
  if (!(n > 0) || !(g > 0)) return Number.NaN;
  const c2 = Math.min(1, Math.max(0, cv)) ** 2;
  const a = 1 + c2;
  const b = 1 + 2 * c2;
  const e = 1 + 3 * c2;
  const mu2 = MEAN_GAP * MEAN_GAP;
  const perPassenger = mu2 * a * c2;
  const perTimetable = mu2 * a * (b * e + a - 2 * a * b + a * c2);
  return Math.sqrt(perPassenger / n + perTimetable / g);
}

/**
 * A display window: an opaque plate of the canvas colour with a 1 px frame.
 *
 * Opaque because the marks behind it read straight through a translucent one,
 * and the frame takes the container pen — a window holds the experiment's
 * numbers, it is not part of the experiment.
 */
function paintWindow(
  fg: CanvasRenderingContext2D,
  canvas: string,
  frame: string,
  lineWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const snap = lineWidth % 2 === 1 ? 0.5 : 0;
  fg.fillStyle = canvas;
  fg.fillRect(x, y, w, h);
  fg.strokeStyle = frame;
  fg.lineWidth = lineWidth;
  // Inset by half a line width so the frame lands inside the plate it draws.
  fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);
}

function create(ctx: VizContext): VizInstance {
  const table = new Timetable(MAX_GAPS);
  const crowd = new Crowd(MAX_PAINTED);
  const history = new WaitHistory();

  /**
   * Painted passengers per gap of the window, so the plate can point at the gap
   * that has caught the most. Allocated once; only the first
   * `MAX_WINDOW_GAPS` entries are ever touched.
   */
  const perGap = new Uint16Array(MAX_WINDOW_GAPS);
  /**
   * The busiest gap so far, tracked in `step()` rather than searched for in
   * `draw()`. A search would tie-break differently from frame to frame while
   * the counts are still small, and the highlight would flicker across the
   * plate at a thousand arrivals a second.
   */
  let busiest = -1;
  let busiestCount = 0;

  // Structural: both faders are, so these are re-read on every reset.
  let cv = DEFAULT_SPREAD / 100;
  let maxPassengers = DEFAULT_PASSENGERS;
  let rate = arrivalRateFor(DEFAULT_PASSENGERS);

  let layout = layoutPlate(ctx.width, ctx.height);
  let scale = chartScale(layout.chart, maxPassengers);

  // Fractional passengers owed by the rate accumulator between ticks.
  let pending = 0;

  function syncStructure(): void {
    cv = irregularity(ctx.params);
    maxPassengers = passengerTarget(ctx.params);
    rate = arrivalRateFor(maxPassengers);
    layout = layoutPlate(ctx.width, ctx.height);
    scale = chartScale(layout.chart, maxPassengers);
  }

  /**
   * The average wait is the headline; the count and the naive answer are the
   * plain sentence beside it; everything the timetable knows about itself is
   * for the exact table only.
   *
   * Every band here is three standard errors **at the count in hand** — the
   * passengers who have actually turned up, and the gaps actually drawn — so a
   * row starts with a band too wide to test anything and arrives at a verdict
   * as the evidence comes in. Taken at the count the run was going to finish
   * on, the headline's band was 30 % of the answer at the left stop of the
   * Passengers fader, which is how "11.76 min" came to be printed under
   * "matches the prediction of 10 min". At cv = 1 a run needs about 18,000
   * passengers before three standard errors are a twentieth of a ten-minute
   * wait, so the left half of the fader honestly reads "still settling".
   *
   * The timetable is drawn in full at `reset()`, before any passenger, so the
   * three rows that measure the timetable itself have all their evidence on the
   * first frame. That is not a band that failed to shrink; it is a measurement
   * that was finished before the clock started.
   */
  function readouts(): Readout[] {
    const gaps = table.gaps;
    const passengers = crowd.passengers;
    const target = expectedWait(cv);
    const c2 = cv * cv;
    return [
      {
        key: 'passengers',
        label: 'Passengers',
        value: passengers,
        digits: 6,
        plain: 'people who came to the stop',
      },
      {
        key: 'wait',
        label: 'Average wait',
        value: crowd.meanWait,
        digits: 4,
        unit: 'min',
        target,
        // §5: the hero prints "analytic" and the closed form behind the target.
        formula: [{ v: 'μ' }, '/2 + ', { v: 'σ' }, '²/(2', { v: 'μ' }, ')'],
        // Absolute rather than σ/√n, because the two terms of
        // `waitStandardError` divide by different counts: the passengers
        // sharpen one and only a fresh timetable sharpens the other.
        band: { kind: 'absolute', half: 3 * waitStandardError(cv, passengers, gaps) },
        plain: 'average wait',
        headline: true,
      },
      {
        key: 'naive',
        label: 'Wait if the buses ran on time',
        value: NAIVE_WAIT,
        digits: 3,
        unit: 'min',
        plain: 'wait if every bus were on time',
      },
      {
        // The gap a passenger lands in, which is the wait doubled and the thing
        // the geometry on the plate actually shows. Its own band, not the
        // wait's: the two differ in the passenger term, because a wait is a
        // *uniform point inside* the gap it caught and the gap is the whole of
        // it. At cv = 1 the wait's relative band overstates this one by √2 on
        // that term, and an overstated band is the direction that certifies
        // things.
        key: 'experienced',
        label: 'Gap a passenger lands in',
        value: crowd.meanGap,
        digits: 4,
        unit: 'min',
        target: experiencedGap(cv),
        band: { kind: 'absolute', half: 3 * caughtGapStandardError(cv, passengers, gaps) },
        expertOnly: true,
      },
      {
        key: 'gapAverage',
        label: 'Average gap on the timetable',
        value: table.gapMean,
        digits: 4,
        unit: 'min',
        target: MEAN_GAP,
        // One gap carries σ = μ·cv of standard deviation and the ledger divides
        // by the gaps drawn. Exactly zero at cv = 0, where every gap really is
        // μ and the reading really is exact — which a bare `tolerance` of 0
        // could not say, because the arithmetic that read it could not tell
        // "declared as zero" from "not declared" and handed this row a 1 % bar
        // it never asked for.
        band: { kind: 'sampled', sigma: gapStddev(cv), samples: gaps },
        expertOnly: true,
      },
      {
        key: 'gapSpread',
        label: 'Gap spread',
        value: table.gapStddev,
        digits: 4,
        unit: 'min',
        target: gapStddev(cv),
        // A sample standard deviation's relative SE is √((κ−1)/4G) with κ the
        // kurtosis, and a gamma of shape 1/cv² has κ = 3 + 6cv². As a half
        // width in minutes rather than as a fraction, so that cv = 0 — where
        // the target is zero, every gap is exactly μ and the spread really is
        // exactly zero — states ± 0 rather than a percentage of nothing.
        band: {
          kind: 'absolute',
          half: 3 * gapStddev(cv) * Math.sqrt((2 + 6 * c2) / (4 * Math.max(1, gaps))),
        },
        expertOnly: true,
      },
      {
        // What this run's own timetable predicts, as opposed to what the law
        // predicts: M₂/(2M₁) from the gaps actually drawn. The measurement
        // converges on *this*, and the distance between it and the target
        // above is the timetable's share of the standard error.
        key: 'predicted',
        label: 'Wait this timetable predicts',
        value: table.predictedWait,
        digits: 4,
        unit: 'min',
        target,
        // The passenger term sent to zero: no number of arrivals sharpens what
        // *this* timetable predicts, so the only evidence is the gaps drawn —
        // all of which are drawn at reset.
        band: { kind: 'absolute', half: 3 * waitStandardError(cv, Infinity, gaps) },
        expertOnly: true,
      },
      {
        key: 'busiest',
        label: 'Busiest gap on screen',
        value: busiest >= 0 ? table.gapLength(busiest) : NaN,
        digits: 4,
        unit: 'min',
        expertOnly: true,
      },
    ];
  }

  /**
   * Repaint the background layer: the timetable, and the chart's frame and
   * axes.
   *
   * The timetable is drawn once and never again until something structural
   * moves, because it *is* static — a run draws its buses at reset and then
   * only rains passengers on them. Painting ninety bus ticks and six bands
   * every frame is exactly the way this app loses its frame budget.
   *
   * `main.ts` calls `reset()` before `drawBackground()` on both paths that can
   * reach here, so the timetable this reads is the current one.
   */
  function paintBackground(): void {
    syncStructure();
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    const painted = Math.min(WINDOW_MINUTES, table.totalMinutes);

    // The gaps, as one wash per row. They are contiguous by construction, so a
    // rectangle per gap would paint the same pixels ninety times; the bus ticks
    // below are what separate one gap from the next.
    bg.fillStyle = theme.data3Fill;
    for (let r = 0; r < ROWS; r++) {
      const row = layout.rows[r];
      if (!row) continue;
      const start = r * MINUTES_PER_ROW;
      if (start >= painted) break;
      const end = Math.min(start + MINUTES_PER_ROW, painted);
      bg.fillRect(row.x, row.y, ((end - start) / MINUTES_PER_ROW) * row.width, row.height);
    }

    // The buses are the experiment's own geometry — the gaps being measured are
    // the gaps between these — so they take the apparatus pen at 2 px. Nothing
    // else on this plate does.
    bg.strokeStyle = theme.grid;
    bg.lineWidth = 2 * theme.lineWidth;
    bg.beginPath();
    for (let j = 0; j <= table.gaps; j++) {
      const t = table.busTime(j);
      if (t > painted) break;
      const r = Math.min(ROWS - 1, Math.floor(t / MINUTES_PER_ROW));
      const row = layout.rows[r];
      if (!row) continue;
      const x = Math.round(row.x + ((t - r * MINUTES_PER_ROW) / MINUTES_PER_ROW) * row.width);
      // Held half a tick inside the row so the first and last bus of a row ink
      // the band rather than the plate beside it.
      const clamped = Math.min(Math.max(x, row.x + 1), row.x + row.width - 1);
      bg.moveTo(clamped, row.y - TICK_OVER);
      bg.lineTo(clamped, row.y + row.height + TICK_OVER);
    }
    bg.stroke();

    // The chart: frame, graduations, numerals. Furniture around the experiment,
    // so the container pen and a hairline.
    const box = scale.box;
    const left = Math.round(box.x) + snap;
    const top = Math.round(box.y) + snap;
    const right = Math.round(box.x + box.width) + snap;
    const bottom = Math.round(box.y + box.height) + snap;
    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.beginPath();
    bg.moveTo(left, top);
    bg.lineTo(left, bottom);
    bg.lineTo(right, bottom);
    bg.lineTo(right, top);
    bg.lineTo(left, top);
    for (let m = 0; m <= WAIT_AXIS_MAX; m += WAIT_AXIS_STEP) {
      const y = Math.round(chartY(scale, m)) + snap;
      bg.moveTo(left - TICK, y);
      bg.lineTo(left, y);
    }
    const decades = Math.floor(Math.log10(scale.nMax));
    for (let k = 0; k <= decades; k++) {
      const x = Math.round(chartX(scale, 10 ** k)) + snap;
      bg.moveTo(x, bottom);
      bg.lineTo(x, bottom + TICK);
    }
    bg.stroke();

    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    bg.textAlign = 'right';
    bg.textBaseline = 'middle';
    for (let m = 0; m <= WAIT_AXIS_MAX; m += WAIT_AXIS_STEP) {
      bg.fillText(String(m), left - TICK - LABEL_GAP, chartY(scale, m));
    }
    // Numerals thin out rather than collide: "10000" is about 33 px wide at the
    // label size, and a five-decade axis on a phone gives each decade 60.
    const every = box.width / Math.max(1, decades) >= 48 ? 1 : 2;
    bg.textAlign = 'center';
    bg.textBaseline = 'top';
    for (let k = 0; k <= decades; k += every) {
      bg.fillText(String(10 ** k), chartX(scale, 10 ** k), bottom + TICK + LABEL_GAP);
    }
    bg.textAlign = 'left';
    bg.textBaseline = 'bottom';
    bg.fillText('average wait (min)', box.x, box.y - LABEL_GAP);
    bg.textAlign = 'right';
    bg.fillText('passengers', box.x + box.width, box.y - LABEL_GAP);
  }

  /** Where the moment `t` lands on the plate, or null when it is past the window. */
  function place(t: number): { x: number; row: Rect; index: number } | null {
    if (!(t >= 0) || t >= WINDOW_MINUTES) return null;
    const index = Math.floor(t / MINUTES_PER_ROW);
    const row = layout.rows[index];
    if (!row) return null;
    return { x: row.x + ((t - index * MINUTES_PER_ROW) / MINUTES_PER_ROW) * row.width, row, index };
  }

  const instance: VizInstance = {
    step(dt) {
      if (crowd.passengers >= maxPassengers) {
        pending = 0;
        return;
      }
      pending += (rate * dt) / 1000;
      // Each passenger consumes exactly two rng draws, so the crowd for a seed
      // is the same however the ticks are batched — only the clock differs.
      while (pending >= 1 && crowd.passengers < maxPassengers) {
        const a = dropPassenger(ctx.rng, table);
        const paint = a.time < WINDOW_MINUTES;
        crowd.push(a, table.gapLength(a.gap), paint);
        if (paint && a.gap < MAX_WINDOW_GAPS) {
          const n = (perGap[a.gap] ?? 0) + 1;
          perGap[a.gap] = n;
          // Strictly greater, so the highlight moves only when a gap genuinely
          // overtakes the leader and never oscillates between two ties.
          if (n > busiestCount) {
            busiestCount = n;
            busiest = a.gap;
          }
        }
        history.sample(crowd.passengers, crowd.meanWait);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move everything.
      paintBackground();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // Where the busiest gap is, if a passenger has landed anywhere yet. A gap
      // that runs off the end of its row is marked in the piece that is
      // visible: the rest of it is on the next row, and boxing across the break
      // would draw a rectangle over half the timetable.
      const from = busiest >= 0 ? place(table.busTime(busiest)) : null;
      const to = busiest >= 0 ? place(Math.min(table.busTime(busiest + 1), WINDOW_MINUTES)) : null;
      const spotRight = from ? (to && to.index === from.index ? to.x : from.row.x + from.row.width) : 0;

      // The busiest gap, picked out by taking the graphite wash *off* it and
      // ringing what is left in the graphite silhouette.
      //
      // Lifting the wash rather than adding a second one is a contrast
      // decision, not a taste one. A `data3` outline laid inside the wash has
      // the wash on both sides of its vertical edges and reads at 2.2:1, under
      // the 3:1 SC 1.4.11 asks of a graphical object; against the plate it is
      // 3.56:1, which is the same arrangement — wash one side, plate the other
      // — that the Galton silhouette already relies on. The passengers it is
      // pointing at gain by it too: vermilion is 3.27:1 on the wash and 4.80:1
      // on the plate, and they are the reason this gap is worth pointing at.
      if (from) {
        const w = Math.max(2, spotRight - from.x);
        fg.fillStyle = theme.canvas;
        fg.fillRect(from.x, from.row.y, w, from.row.height);
        // An even line width needs no half-pixel offset: 2 px about an integer
        // covers whole device pixels at DPR 1 and at 2.
        fg.strokeStyle = theme.data3;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'miter';
        fg.strokeRect(from.x, from.row.y, w, from.row.height);
      }

      // The passengers: one path, one fill, never a fillStyle per dot. Their
      // lane is the draw taken when they arrived, so a resize re-places them
      // instead of stranding them at coordinates the plate no longer has.
      const r = theme.particleRadius;
      fg.fillStyle = theme.data1;
      fg.beginPath();
      crowd.forEach((t, lane) => {
        const at = place(t);
        if (!at) return;
        const y = at.row.y + r + lane * Math.max(0, at.row.height - 2 * r);
        fg.moveTo(at.x + r, y);
        fg.arc(at.x, y, r, 0, TAU);
      });
      fg.fill();

      // The highlighted gap's length, in a window above it — above rather than
      // inside, because the dots in it are the reason it is highlighted, and
      // after the dots, because it may sit over the row above.
      if (from) {
        const label = `${table.gapLength(busiest).toFixed(0)} min`;
        const pad = 4;
        const textH = fontPx(theme.labelFont);
        fg.font = theme.labelFont;
        fg.textAlign = 'center';
        fg.textBaseline = 'top';
        const textW = fg.measureText(label).width;
        const w = Math.round(textW + 2 * pad);
        const h = Math.round(textH + 2 * pad);
        const cx = Math.min(Math.max((from.x + spotRight) / 2, PLATE_PAD + w / 2), width - PLATE_PAD - w / 2);
        const wy = Math.max(0, Math.round(from.row.y - TICK_OVER - h - 2));
        paintWindow(fg, theme.canvas, theme.gridSoft, theme.lineWidth, Math.round(cx - w / 2), wy, w, h);
        fg.fillStyle = theme.ink;
        fg.fillText(label, cx, wy + pad);
      }

      // The two predictions, then the measurement over them. All three are on
      // the foreground: the halo under a thin mark is the plate colour, which
      // on this layer is opaque, so a reference line living on the background
      // would be cut into pieces wherever the curve crossed it.
      const box = scale.box;
      const curve = 2 * theme.lineWidth;
      const naiveY = chartY(scale, NAIVE_WAIT, HALO_PAD);
      const targetY = chartY(scale, expectedWait(cv), HALO_PAD);
      fg.beginPath();
      fg.moveTo(box.x, naiveY);
      fg.lineTo(box.x + box.width, naiveY);
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, curve);
      fg.beginPath();
      fg.moveTo(box.x, targetY);
      fg.lineTo(box.x + box.width, targetY);
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, curve);

      if (history.count > 0) {
        fg.lineJoin = 'round';
        fg.beginPath();
        history.forEach((n, wait) => {
          fg.lineTo(chartX(scale, n), chartY(scale, wait, HALO_PAD));
        });
        // The measurement crosses both reference lines on its way down and the
        // two pens are 1.96:1 apart, so the plate colour goes between them.
        strokeWithHalo(fg, undefined, theme.data1, theme.canvas, curve);
      }

      // The reference lines are named where they are, not in a key: two lines
      // in the same pen cannot be told apart by a swatch. Painted after the
      // curve so a crossing never takes a word with it. The labels sit either
      // side of their own line, which means that when the dial reaches zero and
      // the two lines become one, the plate says so by putting both names on it.
      fg.font = theme.labelFont;
      fg.fillStyle = theme.inkMuted;
      fg.textAlign = 'left';
      fg.textBaseline = 'bottom';
      fg.fillText('prediction', box.x + 4, targetY - 3);
      fg.textBaseline = 'top';
      fg.fillText('if the buses ran on time', box.x + 4, naiveY + 3);

      // The live answer in the chart's top-right corner, which is the one
      // region of the box nothing ever reaches: the running average starts
      // below twenty minutes and falls. Published through emit() below as well;
      // the canvas itself is aria-hidden.
      // Padded to a constant width, so the window does not change size under a
      // reading that crosses ten minutes and back.
      const wait = crowd.meanWait;
      const label = `wait ≈ ${(Number.isNaN(wait) ? '—' : wait.toFixed(2)).padStart(5, ' ')} min`;
      const pad = 5;
      const textH = fontPx(theme.labelFont);
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      const textW = fg.measureText(label).width;
      const wx = Math.round(box.x + box.width - 6 - textW - pad);
      const wy = Math.round(box.y + 6 - pad);
      paintWindow(
        fg,
        theme.canvas,
        theme.gridSoft,
        theme.lineWidth,
        wx,
        wy,
        Math.round(textW + 2 * pad),
        Math.round(textH + 2 * pad),
      );
      fg.fillStyle = theme.ink;
      fg.fillText(label, box.x + box.width - 6, box.y + 6);

      ctx.emit(readouts());
    },

    // No onParamChange. Both faders are structural: a new irregularity is a new
    // timetable, and a new passenger count is a new timetable too, because the
    // timetable's length is what keeps the painted window at two dots a gap.
    // The shell resets on each of them.

    reset() {
      syncStructure();
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      // The timetable is drawn first and in one pass, before any passenger, so
      // the buses for a seed never depend on how long anybody watched.
      table.generate(ctx.rng, cv, gapsFor(maxPassengers));
      crowd.reset();
      history.reset();
      perGap.fill(0);
      busiest = -1;
      busiestCount = 0;
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const waitingTime: Viz = {
  id: 'waiting-time',
  title: 'Why Your Bus Is Always Late',
  group: 'randomness',
  blurb: 'Drops people at random moments onto a bus timetable, and measures how long they really wait.',
  // Landscape: the plate is a strip of timetable read left to right, with the
  // settling chart under it. Nearly square on a phone, where a 1.6 bed would
  // leave the six rows about twenty pixels each.
  aspect: 1.6,
  aspectNarrow: 0.9,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_PASSENGERS },
  create,
};
