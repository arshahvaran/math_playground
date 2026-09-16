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
  RunTally,
  boxesAllowed,
  cycleLengths,
  guessingProbability,
  longestCycle,
  shuffle,
  successProbability,
} from './cycles';

/** Most prisoners the fader offers, and the width of every per-person array. */
const MAX_PEOPLE = 200;
const MIN_PEOPLE = 6;
const DEFAULT_PEOPLE = 100;

/**
 * Where a run stops, and the length of the two history arrays.
 *
 * Two thousand rounds pin the share to about ±0.01 at three standard errors,
 * which is the point at which the plate's curve visibly stops moving. More
 * rounds would buy a digit nobody reads and cost the run its patience.
 */
const MAX_ROUNDS = 2_000;
const MIN_ROUNDS = 20;
const DEFAULT_ROUNDS = 300;

const DEFAULT_SEED = 42;

/**
 * The stream is paced so a run takes about this long whatever the round count,
 * between a floor that lets a reader watch single permutations come and go and
 * a ceiling that keeps two thousand of them from being a smear.
 */
const RUN_SECONDS = 15;
const MIN_ROUND_RATE = 1.5;
const MAX_ROUND_RATE = 150;

/**
 * How long one permutation is held on the plate, in simulation milliseconds.
 *
 * The counters run at up to 150 rounds a second; the picture changes four times
 * a second. This is the same separation Buffon needed between what is counted
 * and what is painted, arrived at from the other side: there the ink saturated,
 * here the reader cannot see a loop that is replaced before the eye lands on
 * it. The loop that decides a round has to be legible, or the plate is a
 * flicker with a counter under it.
 */
const SHOW_MS = 250;

/**
 * Vertices the tally curve may spend. At 2,000 rounds over a 650 px box a
 * vertex per round is three per pixel; 360 is about one every two.
 */
const PAINTED_SAMPLES = 360;

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Gap between the loops and the tally under them, CSS px. */
const PANEL_GAP = 18;

/** The loops' share of the plate's height. */
const LOOPS_SHARE = 0.6;

/** Room for the axis numerals and captions around the tally's data box, CSS px. */
const GUTTER_LEFT = 30;
const GUTTER_RIGHT = 8;
const GUTTER_TOP = 16;
const GUTTER_BOTTOM = 16;

/** Axis tick length, and the gap between a tick or a box and its text, CSS px. */
const TICK = 4;
const LABEL_GAP = 3;

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side of the path and would otherwise erase the axis
 * where the guessing line — pinned at zero for the life of the run — lies along
 * the floor of the box.
 */
const HALO_PAD = 3;

/**
 * The dash the guessing curve is drawn with, CSS px on, px off, and the empty
 * pattern that clears it. Both are module constants because `setLineDash`
 * copies what it is given, so the array is read and never kept — and a literal
 * at each of the four call sites would be four allocations a frame.
 */
const GUESS_DASH: number[] = [5, 4];
const NO_DASH: number[] = [];

/**
 * Bounds on the dot pitch a ring is laid out at, CSS px.
 *
 * The floor is under the drawn dot's own diameter on purpose. Two hundred
 * prisoners in a single loop on a 375 px phone is a ring that cannot be drawn
 * as two hundred separable boxes at any pitch the panel can hold, and the
 * honest failure there is a dense ring of overlapping dots inside the panel
 * rather than a sparse one hanging over the edge of it.
 */
const MIN_PITCH = 1.5;
const MAX_PITCH = 26;

/** Drawn radius of one box, as a share of the pitch and between these bounds. */
const DOT_SHARE = 0.3;
const MIN_DOT = 1.5;
const MAX_DOT = 4.5;

/**
 * Passes the pitch search may take, the most one pass may shrink by, and the
 * *least*.
 *
 * The floor keeps a badly overfull first guess from collapsing the picture in
 * one step. The ceiling is what keeps the search from stalling: the drawn dot
 * is clamped at `MAX_DOT`, so a plate full of single-box loops has a cell size
 * that does not respond to the pitch at all until the pitch falls under 15, and
 * a purely proportional step would spend every pass multiplying a number that
 * changes nothing. Two percent a pass guarantees progress.
 */
const FIT_PASSES = 14;
const SHRINK_FLOOR = 0.5;
const SHRINK_CEILING = 0.98;

/** Padding inside a display window, and its inset from the panel corner, CSS px. */
const WINDOW_PAD = 5;
const WINDOW_INSET = 6;

/** Lines in the loops panel's readout window: the longest loop, and the limit. */
const LOOP_LINES = 2;

/** Where the first dot of a ring sits: straight up, so a loop reads like a clock. */
const RING_START = -Math.PI / 2;

const TAU = 2 * Math.PI;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlateLayout {
  /** The permutation, drawn as loops. */
  loops: Rect;
  /** The running tally against the prediction. */
  chart: Rect;
}

/**
 * Split the plate: the loops on top, the tally underneath, on every plate.
 *
 * Not a landscape/portrait switch like the dart tab's, because neither panel
 * here wants to be narrow. A ring of sixty boxes is three hundred px across at
 * a pitch anyone can see, and a time series put beside something is a time
 * series with half its time. `Viz.aspect` and `aspectNarrow` give both panels a
 * usable box on a 1,280 px window and on a 375 px phone instead.
 */
export function layoutPlate(width: number, height: number): PlateLayout {
  const w = Math.max(1, width - 2 * PLATE_PAD);
  const h = Math.max(2, height - 2 * PLATE_PAD);
  const gap = Math.min(PANEL_GAP, h - 2);
  const inner = h - gap;
  const loopsH = Math.max(1, Math.round(LOOPS_SHARE * inner));
  return {
    loops: { x: PLATE_PAD, y: PLATE_PAD, width: w, height: loopsH },
    chart: {
      x: PLATE_PAD,
      y: PLATE_PAD + loopsH + gap,
      width: w,
      height: Math.max(1, inner - loopsH),
    },
  };
}

export interface ChartScale {
  /** The data box, inside the axis gutters. The axes are drawn on its edges. */
  box: Rect;
  /** Rounds the x axis spans: the whole run, fixed before it starts. */
  rounds: number;
}

/**
 * Axes for a run of `rounds`.
 *
 * The x axis spans the run rather than the rounds played so far, and the y axis
 * is the whole of [0, 1] whatever the prediction is. Both are fixed before the
 * first round, so nothing on the plate moves as the numbers arrive — a curve
 * whose axis rescales under it is a curve that never appears to converge.
 */
export function chartScale(area: Rect, rounds: number): ChartScale {
  return {
    box: {
      x: area.x + GUTTER_LEFT,
      y: area.y + GUTTER_TOP,
      width: Math.max(1, area.width - GUTTER_LEFT - GUTTER_RIGHT),
      height: Math.max(1, area.height - GUTTER_TOP - GUTTER_BOTTOM),
    },
    rounds: Math.max(1, Math.floor(rounds)),
  };
}

/** Round number → x. */
export function chartX(s: ChartScale, round: number): number {
  return s.box.x + Math.min(1, Math.max(0, round / s.rounds)) * s.box.width;
}

/**
 * Share in [0, 1] → y, bottom up, held `pad` px inside the box.
 *
 * The share before the first round is 0/0, which is not a reading and is not a
 * point on this axis; it is read as the floor rather than left to plot at NaN
 * and break the path it is part of.
 */
export function chartY(s: ChartScale, share: number, pad = 0): number {
  const inset = Math.min(pad, s.box.height / 2);
  const t = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
  const y = s.box.y + s.box.height - t * s.box.height;
  return Math.min(Math.max(y, s.box.y + inset), s.box.y + s.box.height - inset);
}

// ---------------------------------------------------------------------------
// The loops — where each ring goes, and how big it is
// ---------------------------------------------------------------------------

/** The circle the `m` boxes of one loop sit on, at dot pitch `pitch`. */
export function ringRadius(m: number, pitch: number): number {
  if (m <= 1) return 0;
  // Spacing m dots `pitch` apart around a circle puts its circumference at
  // m·pitch. Below about five dots the chord falls enough short of the arc to
  // crowd them, so the two-dot case — a diameter of one pitch — is the floor.
  return Math.max((m * pitch) / (2 * Math.PI), pitch / 2);
}

/** Drawn radius of one box, from the pitch. */
export function dotRadius(pitch: number): number {
  // §7: a particle is never drawn under 1.5 CSS px, or anti-aliasing takes the
  // vermilion pen to 2.20:1 on the plate and under the 3:1 a graphical object
  // owes it. The ceiling is what keeps six prisoners from being six saucers.
  return Math.min(MAX_DOT, Math.max(MIN_DOT, DOT_SHARE * pitch));
}

export interface RingSlots {
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
}

/**
 * Lay the rings out in rows at a fixed pitch and return the height used. Each
 * row is centred across `area` as it closes.
 *
 * `slots.x` carries a row-relative centre until the row closes, which is what
 * lets one forward pass both pack and centre without a second array of rows.
 */
function packRows(
  lengths: ArrayLike<number>,
  count: number,
  area: Rect,
  pitch: number,
  slots: RingSlots,
): number {
  const dot = dotRadius(pitch);
  let rowStart = 0;
  let rowX = 0;
  let rowTop = 0;
  let rowH = 0;

  const closeRow = (end: number): void => {
    const shift = (area.width - rowX) / 2;
    for (let i = rowStart; i < end; i++) {
      slots.x[i] = area.x + (slots.x[i] ?? 0) + shift;
      slots.y[i] = area.y + rowTop + rowH / 2;
    }
  };

  for (let i = 0; i < count; i++) {
    const r = ringRadius(lengths[i] ?? 1, pitch);
    // The ring, its dots, and one dot-diameter of air around the lot.
    const cell = 2 * r + 4 * dot;
    if (rowX > 0 && rowX + cell > area.width) {
      closeRow(i);
      rowStart = i;
      rowTop += rowH;
      rowX = 0;
      rowH = 0;
    }
    slots.x[i] = rowX + cell / 2;
    slots.r[i] = r;
    rowX += cell;
    rowH = Math.max(rowH, cell);
  }
  closeRow(count);
  return rowTop + rowH;
}

/**
 * Place one ring per loop inside `area`, longest first, and return the dot
 * pitch it took to make them fit.
 *
 * The pitch is found by shrinking — pack, measure, scale, pack again — because
 * row packing is not a closed form in the pitch: the height responds to it
 * roughly as a square, since a smaller ring both shortens its own row and lets
 * more rings share it, while the width of the largest ring responds linearly.
 * The smaller of those two ratios is the step. Wrapping makes the measured
 * height very slightly non-monotone in the pitch, so the search can settle a
 * notch under the largest pitch that would have fitted; a notch is a fraction
 * of a dot, and the alternative is a bisection that costs twice as much to
 * land in the same place.
 */
export function layoutRings(
  lengths: ArrayLike<number>,
  count: number,
  area: Rect,
  slots: RingSlots,
): number {
  const n = Math.min(count, lengths.length, slots.x.length, slots.y.length, slots.r.length);
  if (n <= 0) return 0;

  let longest = 1;
  for (let i = 0; i < n; i++) longest = Math.max(longest, lengths[i] ?? 1);

  // The largest ring has to fit on its own before anything else can, and it is
  // about m·pitch/π across. Start there and only ever come down.
  const span = Math.min(area.width, area.height);
  let pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, (Math.PI * span) / longest));
  let used = packRows(lengths, n, area, pitch, slots);
  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const widest = 2 * ringRadius(longest, pitch) + 4 * dotRadius(pitch);
    if ((used <= area.height && widest <= area.width) || pitch <= MIN_PITCH) break;
    const fit = Math.min(Math.sqrt(area.height / used), area.width / widest);
    pitch = Math.max(MIN_PITCH, pitch * Math.max(SHRINK_FLOOR, Math.min(SHRINK_CEILING, fit)));
    used = packRows(lengths, n, area, pitch, slots);
  }

  // `packRows` centred each row across the area; this centres the block in it.
  const shift = Math.max(0, (area.height - used) / 2);
  for (let i = 0; i < n; i++) slots.y[i] = (slots.y[i] ?? 0) + shift;
  return pitch;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Two faders. The seed is declared too — the URL carries it and the transport's
 * Shuffle key draws a fresh one — but the rail never renders a seed spec, so a
 * reader turns exactly two things.
 *
 * The third knob the sketch had, the share of boxes each prisoner may open, is
 * fixed at half. Half is what makes the puzzle famous and half is where the
 * closed form lives; a fader for it would let a reader wander into a region
 * where the tab's own prediction stops applying, in exchange for a number that
 * changes nothing they came here to understand.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'int',
    key: 'people',
    label: 'Prisoners',
    min: MIN_PEOPLE,
    max: MAX_PEOPLE,
    default: DEFAULT_PEOPLE,
    help: 'Each one may open half the boxes, and every one of them has to find their own number.',
  },
  {
    kind: 'range',
    key: 'rounds',
    label: 'Rounds',
    min: MIN_ROUNDS,
    max: MAX_ROUNDS,
    step: 1,
    default: DEFAULT_ROUNDS,
    log: true,
    help: 'Shuffles of the boxes to play before the run stops.',
  },
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'ten',
    label: 'Ten prisoners',
    caption: 'Ten people with five boxes each walk free together in about a third of the rounds, which is already far more than anyone expects.',
    values: { people: 10, rounds: 200 },
  },
  {
    id: 'a-hundred',
    label: 'A hundred',
    caption: 'Ten times as many people and the share barely drops, while guessing has still never worked once.',
    values: { people: 100, rounds: 200 },
  },
  {
    id: 'long-run',
    label: 'Two thousand rounds',
    caption: 'Two thousand rounds settle the share right onto the predicted 0.3118.',
    values: { people: 100, rounds: MAX_ROUNDS },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Anna Gál and Peter Bro Miltersen set the puzzle loose in 2003, and Eugene Curtin and Max Warshauer proved ' +
      'three years later that no strategy beats following the chain.',
    source: {
      label: 'Curtin & Warshauer, “The locker puzzle”, The Mathematical Intelligencer 28(1), 2006, 28–31',
      url: 'https://doi.org/10.1007/BF02986999',
    },
  },
  {
    text:
      'The answer hardly depends on how many people there are — 0.3544 for ten, 0.3118 for a hundred, ' +
      '0.3074 for a thousand — and settles on 1 − ln 2 = 0.3069.',
    source: {
      label: 'Wikipedia, 100 prisoners problem',
      url: 'https://en.wikipedia.org/wiki/100_prisoners_problem',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** Prisoners this run holds, clamped the way the arrays are sized. */
export function peopleCount(values: ParamValues): number {
  return Math.max(MIN_PEOPLE, Math.min(MAX_PEOPLE, Math.floor(num(values, 'people', DEFAULT_PEOPLE))));
}

/** Rounds this run will play. */
export function roundTarget(values: ParamValues): number {
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.floor(num(values, 'rounds', DEFAULT_ROUNDS))));
}

/** Rounds per second that finish a run of `rounds` in about RUN_SECONDS. */
export function roundRateFor(rounds: number): number {
  return Math.min(MAX_ROUND_RATE, Math.max(MIN_ROUND_RATE, rounds / RUN_SECONDS));
}

/** Pixel size out of a CSS font shorthand, for sizing a display window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/** An opaque plate of the canvas colour with a container-pen frame. */
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

/** Height of a display window of `lines` stacked lines. Text width plays no part. */
function stackHeight(lines: number, font: string): number {
  return lines * (fontPx(font) + 4) - 4 + 2 * WINDOW_PAD;
}

/**
 * The band of the loops panel the rings may use: all of it but the strip the
 * readout window stands in.
 *
 * Taking it off the top rather than letting the rings run under the window
 * costs the largest ring about a sixth of its diameter, and buys a window that
 * never sits on a loop. That is the right way round here: the longest loop is
 * the object the whole tab is about, and a reading laid over an arc of it is
 * the one thing on this plate a newcomer would read as a fault.
 *
 * The strip is a function of the label face and the line count, never of the
 * numbers in it, so it is the same strip at "longest loop 7" as at 124.
 */
export function ringArea(loops: Rect, labelFont: string): Rect {
  const reserve = WINDOW_INSET + stackHeight(LOOP_LINES, labelFont) + LABEL_GAP;
  return {
    x: loops.x,
    y: loops.y + reserve,
    width: loops.width,
    height: Math.max(1, loops.height - reserve),
  };
}

/** A reading, or an em dash where there is not one yet. */
function reading(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function create(ctx: VizContext): VizInstance {
  // Allocated once at the ceilings, never per round and never per frame.
  const perm = new Int32Array(MAX_PEOPLE);
  const seen = new Uint8Array(MAX_PEOPLE);
  const shownLengths = new Int32Array(MAX_PEOPLE);
  const slots: RingSlots = {
    x: new Float32Array(MAX_PEOPLE),
    y: new Float32Array(MAX_PEOPLE),
    r: new Float32Array(MAX_PEOPLE),
  };
  const tally = new RunTally(MAX_ROUNDS);

  // Structural: all four are a function of the parameters, and all four change
  // what the background layer holds.
  let people = DEFAULT_PEOPLE;
  let limit = boxesAllowed(DEFAULT_PEOPLE);
  let prediction = successProbability(people, limit);
  let guessOdds = guessingProbability(people, limit);
  let target = DEFAULT_ROUNDS;

  let layout = layoutPlate(ctx.width, ctx.height);
  let rings = ringArea(layout.loops, ctx.theme.labelFont);
  let scale = chartScale(layout.chart, target);

  /** The permutation on the plate: its cycle type, held for SHOW_MS. */
  let shownCount = 0;
  let shownLongest = 0;
  let showAge = SHOW_MS;

  /** Fractional rounds owed by the rate accumulator between ticks. */
  let pending = 0;

  function syncStructure(): void {
    people = peopleCount(ctx.params);
    limit = boxesAllowed(people);
    prediction = successProbability(people, limit);
    guessOdds = guessingProbability(people, limit);
    target = roundTarget(ctx.params);
    layout = layoutPlate(ctx.width, ctx.height);
    rings = ringArea(layout.loops, ctx.theme.labelFont);
    scale = chartScale(layout.chart, target);
  }

  function playRound(): void {
    // n − 1 draws for the shuffle and one for the guessers, every round, so the
    // run a seed produces does not depend on how the ticks were batched.
    shuffle(ctx.rng, perm, people);
    const longest = longestCycle(perm, people, seen);
    // The guessers are settled by one draw against (k/n)ⁿ rather than by n
    // draws against k/n. Same distribution exactly — the prisoners choose
    // independently — for a two-hundredth of the work, and the plate could not
    // show the difference: what it shows is that the line never leaves zero.
    tally.record(longest, limit, ctx.rng.next() < guessOdds);
  }

  /**
   * The headline is the share; the counts and the loop on the plate are the
   * sentence around it. `limit`, the average loop and the odds against the
   * guessers are for the exact table only.
   *
   * `longest` names the permutation *on the plate*, not the one the counters
   * have raced ahead to, so the window and the ledger cannot disagree with the
   * picture between them.
   */
  function readouts(): Readout[] {
    return [
      { key: 'rounds', label: 'Rounds played', value: tally.rounds, digits: 5, plain: 'rounds played' },
      { key: 'wins', label: 'Wins, chain rule', value: tally.wins, digits: 5, plain: 'rounds everyone got out' },
      {
        key: 'guessWins',
        label: 'Wins, guessing',
        value: tally.guessWins,
        digits: 5,
        plain: 'rounds won by guessing instead',
      },
      {
        key: 'share',
        label: 'Success rate',
        value: tally.share,
        digits: 4,
        target: prediction,
        // §5: the hero prints "analytic" and the closed form behind the target.
        formula: ['1 − (', { v: 'Hₙ' }, ' − ', { v: 'Hₖ' }, ')'],
        headline: true,
        plain: 'share of rounds everyone got out',
        // A share over R rounds is a proportion, and its *relative* standard
        // error is √((1−p)/(p·R)) — 8.0% at p = 0.3118 over the 300-round
        // default. The ledger's 1% would therefore read "not yet" for a run
        // that is statistically perfect. Three of those, measured at the round
        // count the run is going to reach rather than the count so far, so the
        // row starts off and arrives at agreement as the rounds go by.
        tolerance: 3 * Math.sqrt((1 - prediction) / (prediction * target)),
      },
      {
        // The other half of the lesson, and the second row of the key on the
        // plate: the share of rounds the guessers won, beside the share the
        // chain rule won. `guessWins` is a raw count and `guessOdds` is one
        // round's probability — 6.22e-61 at two hundred people — so neither of
        // them is this running share, and without it the reading a screen
        // reader gets is the half that climbs and not the half that never
        // leaves zero. Its target is that per-round probability: over any
        // number of rounds the expected share is exactly the odds.
        key: 'guessShare',
        label: 'Success rate, guessing',
        value: tally.guessShare,
        digits: 4,
        target: guessOdds,
        // The same bar the chain rule's share is held to — three standard
        // errors of a proportion over the rounds this run will reach, which is
        // √((1 − p)/(p·R)) relative. With p = (k/n)ⁿ that bar is astronomically
        // wide, and that is the reading rather than a licence: the run would
        // have to be 10⁵⁷ times longer before one win were likely, so a
        // measured zero *is* this prediction.
        tolerance: 3 * Math.sqrt((1 - guessOdds) / (guessOdds * target)),
        plain: 'share of rounds guessing worked',
      },
      {
        key: 'longest',
        label: 'Longest loop on the plate',
        value: shownLongest,
        digits: 3,
        plain: 'longest loop this round',
      },
      { key: 'limit', label: 'Boxes each may open', value: limit, digits: 3, expertOnly: true },
      { key: 'averageLongest', label: 'Mean longest loop', value: tally.averageLongest, digits: 4, expertOnly: true },
      { key: 'guessOdds', label: 'Guessing win probability', value: guessOdds, digits: 3, expertOnly: true },
      { key: 'target', label: 'Rounds this run', value: target, digits: 5, expertOnly: true },
    ];
  }

  /**
   * Repaint the background layer: the tally's axes and their scale.
   *
   * The loops have nothing static in them — a new permutation four times a
   * second is the foreground's whole job — so this layer is the chart frame and
   * nothing else.
   */
  function paintBackground(): void {
    syncStructure();
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const box = scale.box;
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    const left = Math.round(box.x) + snap;
    const top = Math.round(box.y) + snap;
    const right = Math.round(box.x + box.width) + snap;
    const bottom = Math.round(box.y + box.height) + snap;

    // An L, not a box and not a lattice: the chart contains the two curves
    // rather than being part of the experiment, so it takes the container pen,
    // and a scale is what it owes them — ticks outside the frame, never rules
    // across it.
    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.beginPath();
    bg.moveTo(left, top);
    bg.lineTo(left, bottom);
    bg.lineTo(right, bottom);
    for (const share of [0, 0.5, 1]) {
      const y = Math.round(chartY(scale, share)) + snap;
      bg.moveTo(left - TICK, y);
      bg.lineTo(left, y);
    }
    bg.stroke();

    // Graduations, not readings: the axis numerals say what the box measures
    // and are the one kind of number on this plate with nothing to publish.
    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    bg.textAlign = 'right';
    bg.textBaseline = 'middle';
    for (const share of [0, 0.5, 1]) {
      bg.fillText(share === 0.5 ? '0.5' : String(share), left - TICK - LABEL_GAP, chartY(scale, share));
    }
    bg.textAlign = 'left';
    bg.textBaseline = 'bottom';
    bg.fillText('share of rounds won', box.x, box.y - LABEL_GAP);
    bg.textAlign = 'right';
    bg.textBaseline = 'top';
    bg.fillText(`${scale.rounds} rounds`, box.x + box.width, box.y + box.height + LABEL_GAP);
  }

  /**
   * The loops of one permutation, as rings of boxes.
   *
   * Two pens and four batched calls — a chain path and a dot path for each —
   * so no ring ever costs a style change. There can be at most *one* fatal
   * loop, because two loops longer than half the boxes will not fit in the
   * boxes, and that is the theorem this panel exists to draw: the room's whole
   * fate is one object, and it is the one drawn in the other colour.
   */
  function paintRings(fg: CanvasRenderingContext2D, fatal: boolean, pen: string, dot: number): void {
    fg.strokeStyle = pen;
    fg.lineWidth = 2 * ctx.theme.lineWidth;
    fg.lineJoin = 'round';
    fg.beginPath();
    for (let i = 0; i < shownCount; i++) {
      const m = shownLengths[i] ?? 0;
      if ((m > limit) !== fatal || m < 2) continue;
      const cx = slots.x[i] ?? 0;
      const cy = slots.y[i] ?? 0;
      const r = slots.r[i] ?? 0;
      for (let j = 0; j < m; j++) {
        const a = RING_START + (TAU * j) / m;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        if (j === 0) fg.moveTo(px, py);
        else fg.lineTo(px, py);
      }
      fg.closePath();
    }
    fg.stroke();

    fg.fillStyle = pen;
    fg.beginPath();
    for (let i = 0; i < shownCount; i++) {
      const m = shownLengths[i] ?? 0;
      if ((m > limit) !== fatal) continue;
      const cx = slots.x[i] ?? 0;
      const cy = slots.y[i] ?? 0;
      const r = slots.r[i] ?? 0;
      // A loop of one is a prisoner who opens his own box and finds his own
      // number: one dot, no chain.
      if (m <= 1) {
        fg.moveTo(cx + dot, cy);
        fg.arc(cx, cy, dot, 0, TAU);
        continue;
      }
      for (let j = 0; j < m; j++) {
        const a = RING_START + (TAU * j) / m;
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        fg.moveTo(px + dot, py);
        fg.arc(px, py, dot, 0, TAU);
      }
    }
    fg.fill();
  }

  /**
   * The key to the two curves, in the tally's top-right corner — the one part
   * of the box neither of them reaches once the run is under way.
   *
   * It carries their readings as well as their pens, because the two readings
   * side by side *are* the lesson: one number climbs to a third, the other
   * never leaves zero. Both are published through `emit()` below; the canvas
   * itself is aria-hidden.
   *
   * Sized from a template rather than from the readings, so a digit changing
   * cannot move anything: `0.0000` is as wide as every value that can appear
   * in it, and the widest name is the one measured.
   */
  function paintKey(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const box = scale.box;
    const rows: ReadonlyArray<readonly [string, string, boolean, number]> = [
      ['chain', theme.data1, false, tally.share],
      ['guessing', theme.data1, true, tally.guessShare],
      ['predicted', theme.data2, false, prediction],
    ];

    const sample = 16;
    const gap = 6;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    fg.font = theme.labelFont;
    let nameW = 0;
    for (const [name] of rows) nameW = Math.max(nameW, fg.measureText(name).width);
    const valueW = fg.measureText('0.0000').width;

    const w = Math.round(2 * WINDOW_PAD + sample + gap + nameW + gap + valueW);
    const h = Math.round(stackHeight(rows.length, theme.labelFont));
    // A key that does not fit is worse than none: it would sit on the curves.
    if (w > box.width - 12 || h > box.height - 12) return;

    const x = Math.round(box.x + box.width - WINDOW_INSET - w);
    const y = Math.round(box.y + WINDOW_INSET);
    paintWindow(fg, theme.canvas, theme.gridSoft, theme.lineWidth, x, y, w, h);

    fg.textBaseline = 'middle';
    fg.lineWidth = 2 * theme.lineWidth;
    rows.forEach(([name, pen, dashed, value], i) => {
      const cy = y + WINDOW_PAD + i * step + textH / 2;
      fg.strokeStyle = pen;
      fg.setLineDash(dashed ? GUESS_DASH : NO_DASH);
      fg.beginPath();
      fg.moveTo(x + WINDOW_PAD, cy);
      fg.lineTo(x + WINDOW_PAD + sample, cy);
      fg.stroke();
      fg.fillStyle = theme.ink;
      fg.textAlign = 'left';
      fg.fillText(name, x + WINDOW_PAD + sample + gap, cy);
      fg.textAlign = 'right';
      fg.fillText(reading(value, 4), x + w - WINDOW_PAD, cy);
    });
    fg.setLineDash(NO_DASH);
  }

  const instance: VizInstance = {
    step(dt) {
      showAge += dt;
      if (tally.rounds >= target) {
        // The run is over. The last permutation stays on the plate: it is the
        // one the final reading was made on.
        pending = 0;
        return;
      }
      pending += (roundRateFor(target) * dt) / 1000;
      let played = false;
      while (pending >= 1 && tally.rounds < target) {
        playRound();
        pending -= 1;
        played = true;
      }
      // The picture takes the newest permutation it is allowed to, which at
      // 150 rounds a second is one in forty. Counting and painting part company
      // here and nowhere else.
      if (played && showAge >= SHOW_MS) {
        shownCount = cycleLengths(perm, people, seen, shownLengths);
        shownLongest = shownCount > 0 ? (shownLengths[0] ?? 0) : 0;
        showAge = 0;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the axes.
      paintBackground();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // --- the permutation ------------------------------------------------
      if (shownCount > 0) {
        const pitch = layoutRings(shownLengths, shownCount, rings, slots);
        const dot = dotRadius(pitch);
        paintRings(fg, false, theme.data1, dot);
        // The fatal loop takes the drafting pen. It is the one datum on this
        // plate that is not a live reading but a verdict — it is what the
        // limit has already decided about this round — and it has to be
        // separable from the survivors at a glance, which rules out the
        // graphite pen: 1.77:1 is not a mark anyone picks a loop out with.
        paintRings(fg, true, theme.data2, dot);
      }

      const loopLines = [`longest loop ${shownLongest > 0 ? shownLongest : '—'}`, `each opens ${limit}`];
      paintLines(fg, loopLines, ['longest loop 000', 'each opens 000'], layout.loops);

      // --- the tally ------------------------------------------------------
      const curve = 2 * theme.lineWidth;
      const box = scale.box;

      // The prediction first, the measurements over it: the reference is what
      // they are read against, not what they hide behind. Every one of the
      // three takes the halo, because the chain curve crosses the prediction
      // repeatedly by construction and the two pens are 1.96:1 apart.
      fg.lineJoin = 'round';
      fg.beginPath();
      fg.moveTo(chartX(scale, 0), chartY(scale, prediction, HALO_PAD));
      fg.lineTo(box.x + box.width, chartY(scale, prediction, HALO_PAD));
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, curve);

      if (tally.rounds > 0) {
        // Two peer series, one pen: §7 is explicit that a second *hue* would
        // rank them, and these two are the same measurement of two strategies.
        // The dash is the second encoding, and the key names both.
        fg.setLineDash(GUESS_DASH);
        fg.beginPath();
        tally.forEach(PAINTED_SAMPLES, (round, _share, guessShare) => {
          fg.lineTo(chartX(scale, round), chartY(scale, guessShare, HALO_PAD));
        });
        strokeWithHalo(fg, undefined, theme.data1, theme.canvas, curve);
        fg.setLineDash(NO_DASH);

        fg.beginPath();
        tally.forEach(PAINTED_SAMPLES, (round, share) => {
          fg.lineTo(chartX(scale, round), chartY(scale, share, HALO_PAD));
        });
        strokeWithHalo(fg, undefined, theme.data1, theme.canvas, curve);
      }

      paintKey(fg);
      ctx.emit(readouts());
    },

    // No onParamChange: both knobs are structural. A different number of
    // prisoners is a different puzzle with a different prediction, and a
    // different round count is a different x axis and a different pace — the
    // rounds already played were measured against neither. The shell resets.

    reset() {
      syncStructure();
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      tally.reset();
      pending = 0;
      shownCount = 0;
      shownLongest = 0;
      // The first round played goes straight onto the plate; every one after
      // that waits its turn.
      showAge = SHOW_MS;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  /**
   * A display window of stacked lines in the top-left of `area`.
   *
   * The box is measured from `templates`, never from `lines`: the templates are
   * constant text, so the window is the same width at "longest loop 7" as at
   * "longest loop 124" and a digit arriving can never move anything.
   */
  function paintLines(
    fg: CanvasRenderingContext2D,
    lines: readonly string[],
    templates: readonly string[],
    area: Rect,
  ): void {
    const { theme } = ctx;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    fg.font = theme.labelFont;
    let textW = 0;
    for (const t of templates) textW = Math.max(textW, fg.measureText(t).width);

    const w = Math.round(textW + 2 * WINDOW_PAD);
    const h = Math.round(stackHeight(lines.length, theme.labelFont));
    if (w > area.width - 12 || h > area.height - 12) return;

    const x = Math.round(area.x + WINDOW_INSET);
    const y = Math.round(area.y + WINDOW_INSET);
    paintWindow(fg, theme.canvas, theme.gridSoft, theme.lineWidth, x, y, w, h);
    fg.fillStyle = theme.ink;
    fg.textAlign = 'left';
    fg.textBaseline = 'middle';
    lines.forEach((line, i) => {
      fg.fillText(line, x + WINDOW_PAD, y + WINDOW_PAD + i * step + textH / 2);
    });
  }

  instance.reset();
  return instance;
}

export const prisoners: Viz = {
  id: 'prisoners',
  title: 'The Prisoners and the Boxes',
  group: 'randomness',
  blurb:
    'Plays out the locker puzzle round after round, where following a chain of numbers instead of guessing turns hopeless odds into about one run in three.',
  // Landscape, because the plate holds two panels stacked: the loops of one
  // shuffle above, and the running tally below. Nearly square on a phone, where
  // a 1.5 bed would leave the tally 90 px tall and the loops of a hundred
  // boxes no room to be a hundred boxes.
  aspect: 1.45,
  aspectNarrow: 0.85,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_ROUNDS },
  create,
};
