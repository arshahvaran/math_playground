import type {
  CanvasTheme,
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
  A_ONLY,
  B_ONLY,
  RULES,
  TAKING_TURNS,
  Table,
  expectedMoneyInto,
  solveRule,
  type RuleSolution,
} from './games';

/**
 * Players seated at each of the three rules. The purses are one Int32Array of
 * `RULES.length × MAX_PLAYERS`, allocated once at the budget ceiling.
 *
 * Two thousand is where the table stops being the thing that decides the
 * picture: the average of `P` purses wanders about its prediction with a spread
 * of √(rounds/P), which at 3,000 rounds is 1.2 coins at 2,000 players against a
 * 44-coin separation between the winning line and the losing ones.
 */
const MAX_PLAYERS = 2_000;
const DEFAULT_PLAYERS = 400;

/**
 * Rounds a run plays. Fixed, not a control: the run length is the transport's
 * job, and 3,000 rounds is where the three lines have separated by far more
 * than they wander — the winning rule is 44 coins up and the two losing ones 27
 * and 30 down, against a wander of 4 coins at the default table.
 */
const MAX_ROUNDS = 3_000;

/** Rounds played per second of simulation time: a full run in twelve seconds. */
const ROUND_RATE = 250;

/**
 * The readouts are per hundred rounds rather than per round.
 *
 * The same number either way, but a rule that wins 0.0147 coins a round is an
 * abstraction and one that wins 1.47 coins every hundred rounds is a thing a
 * reader can picture. The chain is solved per round throughout; this is the
 * only place the scale changes.
 */
const GAIN_SCALE = 100;

/**
 * Standard errors inside which a reading counts as agreeing with its
 * prediction. Three, matching the rest of the app: the reading then starts off
 * and arrives at agreement as the rounds are played, instead of being true from
 * the first one.
 */
const READOUT_SIGMAS = 3;

/**
 * Below this a solved drift is the zero it is meant to be.
 *
 * At zero tilt both games are *exactly* fair — game B is built so that
 * (1−p₀)(1−p₁)(1−p₂) and p₀p₁p₂ are both 0.05625 — but the chain reaches that
 * zero through a 3×3 elimination and lands a few times 10⁻¹⁷ away from it.
 * Published as a target, that dust turns the ledger's relative-error column
 * into sixteen digits of noise.
 */
const DRIFT_DUST = 1e-12;

const DEFAULT_TILT = 0.5;
const MAX_TILT = 2;
const DEFAULT_SEED = 42;

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

const PLATE_PAD = 8;
/** Room for the money numerals left of the box: `−150` is four glyphs of the 11 px mono, plus tick and gap. */
const GUTTER_LEFT = 42;
/** Room for the round numerals under the box. */
const GUTTER_BOTTOM = 18;
/** Room for the caption over the box. */
const GUTTER_TOP = 14;
const GUTTER_RIGHT = 8;

const TICK = 4;
const LABEL_GAP = 3;

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side of the path and would otherwise erase the frame
 * where a run touches the top or bottom of the axis.
 */
const HALO_PAD = 3;

/** Axis steps, in units of the leading decade. Finer than 1-2-5 so a 56-coin reach takes a 60-coin axis, not a 100. */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/** The axis never closes in tighter than this, so a run with nothing in it still has a scale. */
const MIN_AXIS = 5;

/** Room above the predicted end of the highest curve, as a factor. */
const HEADROOM = 1.1;

/** Wander allowed for above the prediction when the axis is built. */
const AXIS_SIGMAS = 3;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxisRange {
  /** Money at the bottom of the axis; always negative, so zero is always on the plate. */
  min: number;
  /** Money at the top. */
  max: number;
}

/** The data box, inside the axis gutters. The frame is drawn on its edges. */
export function layoutPlot(width: number, height: number): Rect {
  return {
    x: PLATE_PAD + GUTTER_LEFT,
    y: PLATE_PAD + GUTTER_TOP,
    width: Math.max(1, width - 2 * PLATE_PAD - GUTTER_LEFT - GUTTER_RIGHT),
    height: Math.max(1, height - 2 * PLATE_PAD - GUTTER_TOP - GUTTER_BOTTOM),
  };
}

/** The smallest round number at or above `x`, so an axis end is a number worth printing. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 0;
  const decade = 10 ** Math.floor(Math.log10(x));
  const scaled = x / decade;
  for (const step of NICE_STEPS) {
    // A hair of slack, so 60 lands on 60 rather than on 80 after 60/10 comes
    // back as 6.000000000000001.
    if (scaled <= step * (1 + 1e-9)) return step * decade;
  }
  return 10 * decade;
}

/**
 * The money axis for a run, from the predicted end of each rule.
 *
 * Built from the *predictions* and the table size, never from a measurement, so
 * the axis is fixed before the first round is played and nothing on the plate
 * moves while it runs. The room reserved above each prediction is a tenth of it
 * plus three times the wander: each round moves a purse by exactly ±1, so one
 * round's spread is one coin, and the average of `players` purses after
 * `rounds` rounds sits within √(rounds/players) of its prediction. (The mod-3
 * rule makes consecutive rounds *negatively* correlated, so that one coin is an
 * upper bound and not an approximation — measured, the two rules that read the
 * money spread by 0.74 and 0.93 coins a round against game A's 1.00.)
 */
export function axisRange(ends: readonly number[], players: number, rounds: number): AxisRange {
  const wander = AXIS_SIGMAS * Math.sqrt(rounds / Math.max(1, players));
  let top = 0;
  let bottom = 0;
  for (const end of ends) {
    if (end > top) top = end;
    if (end < bottom) bottom = end;
  }
  return {
    max: niceCeil(Math.max(MIN_AXIS, HEADROOM * top + wander)),
    min: -niceCeil(Math.max(MIN_AXIS, HEADROOM * -bottom + wander)),
  };
}

/** Round → x. Linear, one run across the box. */
export function plotX(box: Rect, round: number, rounds: number): number {
  const t = Math.min(1, Math.max(0, round / Math.max(1, rounds)));
  return box.x + t * box.width;
}

/** Money → y, top down, clamped into the box inset by `pad`. */
export function plotY(box: Rect, range: AxisRange, money: number, pad = 0): number {
  const span = Math.max(1e-9, range.max - range.min);
  const inset = Math.min(pad, box.height / 2);
  const y = box.y + ((range.max - money) / span) * box.height;
  return Math.min(Math.max(y, box.y + inset), box.y + box.height - inset);
}

/**
 * Rounds skipped between painted vertices.
 *
 * The table records one average per rule per round and the counters never stop;
 * what is painted is bounded by the plate instead. A polyline with more
 * vertices than the box has pixel columns draws nothing a reader can see — at
 * 3,000 rounds on a 660 px box five rounds share every column — so the painter
 * strides the history and lays down at most one vertex per column per trace.
 * Three traces of 3,000 segments would be 9,000 `lineTo` calls a frame for at
 * most 660 visible steps; this is the Buffon lesson applied to a curve.
 */
export function vertexStride(box: Rect, rounds: number): number {
  return Math.max(1, Math.ceil(rounds / Math.max(1, box.width)));
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Two faders. The seed is declared too, because the URL carries it and the
 * transport's Shuffle key draws a fresh one, but the rail never renders a
 * seed — it is not a control.
 *
 * The modulus and the cycle are constants in `games.ts`, not controls: three is
 * the only modulus with a paradox in it, and one of the cycles a schedule
 * picker would have to offer — strict A, B, A, B — loses.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'tilt',
    label: 'Tilt',
    min: 0,
    max: MAX_TILT,
    step: 0.1,
    default: DEFAULT_TILT,
    unit: '%',
    help: 'How far every coin in both games is tipped against the player, so at 0 both games are exactly fair.',
  },
  {
    kind: 'range',
    key: 'players',
    label: 'Players',
    min: 20,
    max: MAX_PLAYERS,
    step: 1,
    default: DEFAULT_PLAYERS,
    log: true,
    help: 'How many people sit down to each rule at once. The chart follows their average.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
  },
];

/** The paradox, then the tilt taken away, then the tilt pushed past where it works. */
const presets: readonly Preset[] = [
  {
    id: 'each-one-loses',
    label: 'Each one loses',
    caption: 'Both games are tipped against the player and both lines sink, yet taking turns between them climbs.',
    values: { tilt: 0.5, players: 400 },
  },
  {
    id: 'perfectly-fair',
    label: 'Perfectly fair',
    caption: 'With no tilt at all each game breaks even on its own, and taking turns still makes money.',
    values: { tilt: 0, players: 400 },
  },
  {
    id: 'tilted-too-far',
    label: 'Tilted too far',
    caption: 'Tilt the coins four times as far and even taking turns sinks, so the trick has a tipping point.',
    values: { tilt: 2, players: 400 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Juan Parrondo built the paradox in 1996 out of the Brownian ratchet, Feynman’s thought experiment about ' +
      'whether a tiny toothed wheel could pull useful work out of the random jostling of heat.',
    source: {
      label: "Harmer and Abbott, 'Losing strategies can win by Parrondo's paradox', Nature 402 (1999), 864",
      url: 'https://doi.org/10.1038/47220',
    },
  },
  {
    text:
      'The order matters as much as the mixture: taking one round of each in strict alternation loses, while ' +
      'taking two rounds of each in a row wins.',
    source: {
      label: "Harmer and Abbott, 'Parrondo's paradox', Statistical Science 14(2) (1999), 206–213",
      url: 'https://doi.org/10.1214/ss/1009212247',
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

/** The slider is a percentage, because 0.5 % is readable and 0.005 is not. */
function epsOf(values: ParamValues): number {
  return Math.min(MAX_TILT, Math.max(0, num(values, 'tilt', DEFAULT_TILT))) / 100;
}

/** Players per rule, clamped the way the table clamps its own. */
function playerCount(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_PLAYERS, Math.floor(num(values, 'players', DEFAULT_PLAYERS))));
}

/** Pixel size out of a CSS font shorthand, for sizing the key. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * The pens, as a hierarchy of salience rather than as three categories.
 *
 * Taking turns is the whole point of the tab and takes the signal pen; the
 * prediction is the drafting pen, as every analytic overlay in the app is.
 *
 * The two rules that lose *are* peers — "coins per 100 rounds" measured of one
 * game and of the other — and §7 is explicit that a second hue would rank them.
 * So they share the area pen and the first game is dashed, which is the same
 * move the prisoners' two strategies make. The pen it used to have was
 * `gridSoft`, the frame's own: two greys 1.14:1 apart, one of them also drawing
 * the box, the ticks and the dashed break-even rule, on a tab called Two Losing
 * Games where a reader could not count two of them.
 */
function penFor(rule: number, theme: CanvasTheme): string {
  switch (rule) {
    case A_ONLY:
    case B_ONLY:
      return theme.data3;
    case TAKING_TURNS:
      return theme.data1;
    default:
      return theme.data2;
  }
}

/** The second encoding that separates the two losing traces. See `penFor`. */
const A_DASH: readonly number[] = [6, 4];
const NO_DASH: readonly number[] = [];

function dashFor(rule: number): number[] {
  return [...(rule === A_ONLY ? A_DASH : NO_DASH)];
}

/**
 * Key rows: the star first, then the two losers, then the pen the predictions
 * are drawn in.
 *
 * The games are "first" and "second" rather than A and B wherever a reader who
 * is not reading the source meets them — the key here, and the plain labels
 * under the readings. The letters stay in `games.ts`, in the exact table's
 * column of names, and in the literature.
 */
const KEY_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['taking turns', TAKING_TURNS],
  ['first game', A_ONLY],
  ['second game', B_ONLY],
  ['predicted', -1],
];

/** A money numeral for the axis, with a real minus sign rather than a hyphen. */
function moneyLabel(money: number): string {
  return money < 0 ? `−${-money}` : String(money);
}

/** A solved drift with the floating-point dust swept off. See `DRIFT_DUST`. */
function cleanDrift(drift: number): number {
  return Math.abs(drift) < DRIFT_DUST ? 0 : drift;
}

/**
 * One rule's gain, measured and predicted, both per hundred rounds.
 *
 * `samples` is players × rounds *played so far*, and the sd of one of those
 * observations is exactly `GAIN_SCALE`: a round moves one purse by one coin, up
 * or down, and the reading is a hundred times the average of those steps. (The
 * mod-3 rule makes consecutive rounds negatively correlated, so one coin is an
 * upper bound rather than an approximation — measured, the two rules that read
 * the money spread by 0.74 and 0.93 coins a round against game A's 1.00.)
 *
 * The range is what makes the band sign-sensitive, and that matters more here
 * than anywhere else in the app: the whole result is that each game *loses* on
 * its own, so an acceptance window that also contains a winning game inverts the
 * tab. Judged against a span of ±GAIN_SCALE the band is at most a twentieth of
 * the prediction wherever the prediction is inside the span, which cannot reach
 * zero from a negative one — where a bar built from the *final* round count
 * spanned it comfortably, printing "agrees with the prediction" on a finished
 * run 52.7 % away and on a Game A reading of −1.527 against −1.000.
 */
function gainReadout(
  key: string,
  label: string,
  plain: string,
  perRound: number,
  drift: number,
  samples: number,
): Readout {
  return {
    key,
    label,
    value: GAIN_SCALE * perRound,
    digits: 4,
    target: GAIN_SCALE * cleanDrift(drift),
    band: { kind: 'sampled', sigma: GAIN_SCALE, samples, sigmas: READOUT_SIGMAS },
    range: [-GAIN_SCALE, GAIN_SCALE],
    plain,
  };
}

function create(ctx: VizContext): VizInstance {
  const table = new Table(MAX_PLAYERS, MAX_ROUNDS);

  // The exact predicted money after each round, one curve per rule, allocated
  // once at the round ceiling and refilled whenever the tilt changes.
  const predicted = RULES.map(() => new Float64Array(MAX_ROUNDS + 1));
  let solutions: RuleSolution[] = RULES.map((rule) => solveRule(rule, DEFAULT_TILT / 100));

  let box = layoutPlot(ctx.width, ctx.height);
  let range: AxisRange = { min: -MIN_AXIS, max: MIN_AXIS };

  // Fractional rounds owed by the rate accumulator between ticks.
  let pending = 0;

  /**
   * Re-solve the chain and re-measure the plate. Called from `drawBackground()`
   * and from `reset()` both, because the contract does not fix which the shell
   * runs first after a parameter change, and it is idempotent.
   */
  function syncStructure(): void {
    const eps = epsOf(ctx.params);
    solutions = RULES.map((rule) => solveRule(rule, eps));
    const ends: number[] = [];
    for (let r = 0; r < RULES.length; r++) {
      const curve = predicted[r]!;
      expectedMoneyInto(RULES[r]!, eps, curve);
      ends.push(curve[MAX_ROUNDS]!);
    }
    box = layoutPlot(ctx.width, ctx.height);
    range = axisRange(ends, playerCount(ctx.params), MAX_ROUNDS);
  }

  /**
   * The three gains and the two occupancy shares that explain them.
   *
   * Every target is solved from the chain on the spot, for whatever tilt the
   * fader is on — none of them is a published constant, which is the only way
   * the comparison stays honest across the whole range of the slider.
   */
  function readouts(): Readout[] {
    const players = table.players;
    // Observations behind every reading below: one per player per round played.
    // The count the run is going to *reach* is not evidence — a bar derived from
    // it is honest on the last frame and absurdly generous on every frame before
    // it, which is how a reading 52.7 % out came to be certified — so what is
    // declared is the count in hand and the ledger does the division.
    const samples = players * table.round;

    return [
      { key: 'rounds', label: 'Rounds', value: table.round, digits: 5, plain: 'rounds played' },
      gainReadout(
        'gainA',
        'Game A, coins per 100 rounds',
        'coins per 100 rounds, first game only',
        table.averagePerRound(A_ONLY),
        solutions[A_ONLY]!.drift,
        samples,
      ),
      gainReadout(
        'gainB',
        'Game B, coins per 100 rounds',
        'coins per 100 rounds, second game only',
        table.averagePerRound(B_ONLY),
        solutions[B_ONLY]!.drift,
        samples,
      ),
      {
        ...gainReadout(
          'gainTurns',
          'Taking turns, coins per 100 rounds',
          'coins per 100 rounds, taking turns',
          table.averagePerRound(TAKING_TURNS),
          solutions[TAKING_TURNS]!.drift,
          samples,
        ),
        headline: true,
        hint: 'each game on its own loses money',
      },
      // Why it works, for anyone who opens the table. Game B's own losses keep
      // dropping it back onto the multiples of three where its bad coin lives,
      // so it meets that coin on 38.4 % of its rounds instead of a third of
      // them; two rounds of A carry the money off those squares and the share
      // falls to 35.3 %, which is the whole of the paradox in one number.
      {
        key: 'shareB',
        label: 'Game B, share of rounds on a multiple of 3',
        value: table.shareOnBad(B_ONLY),
        digits: 4,
        target: solutions[B_ONLY]!.shares[0]!,
        // A share over the same players × rounds observations. Were they
        // independent the sd of one would be at most ½; consecutive rounds of
        // one player are not independent — the money walks — so it is declared
        // at 1, twice the independent bound, which is 0.0027 against a share of
        // 0.38 at the default table.
        band: { kind: 'sampled', sigma: 1, samples, sigmas: READOUT_SIGMAS },
        range: [0, 1],
        expertOnly: true,
      },
      {
        key: 'shareTurns',
        label: 'Taking turns, share of rounds on a multiple of 3',
        value: table.shareOnBad(TAKING_TURNS),
        digits: 4,
        target: solutions[TAKING_TURNS]!.shares[0]!,
        band: { kind: 'sampled', sigma: 1, samples, sigmas: READOUT_SIGMAS },
        range: [0, 1],
        expertOnly: true,
      },
      { key: 'players', label: 'Players per rule', value: players, digits: 5, expertOnly: true },
    ];
  }

  function paintBackground(): void {
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    const left = Math.round(box.x) + snap;
    const right = Math.round(box.x + box.width) + snap;
    const top = Math.round(box.y) + snap;
    const bottom = Math.round(box.y + box.height) + snap;

    // Frame and ticks: furniture, so the container pen at a hairline. Ticks hang
    // outside the box — a chart with three lines on it needs a scale, not a
    // lattice of rules across the lines.
    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.beginPath();
    bg.moveTo(left, top);
    bg.lineTo(left, bottom);
    bg.lineTo(right, bottom);
    bg.lineTo(right, top);
    bg.lineTo(left, top);
    for (let k = 0; k <= 4; k++) {
      const x = Math.round(plotX(box, (k * MAX_ROUNDS) / 4, MAX_ROUNDS)) + snap;
      bg.moveTo(x, bottom);
      bg.lineTo(x, bottom + TICK);
    }
    for (const money of [range.max, 0, range.min]) {
      const y = Math.round(plotY(box, range, money)) + snap;
      bg.moveTo(left - TICK, y);
      bg.lineTo(left, y);
    }
    bg.stroke();

    // Breaking even: furniture, so the container pen at a hairline, and dashed
    // so it can never be read as a fourth line of data. Snapped, so the
    // hairline covers whole device pixels rather than smearing across two.
    const zero = Math.round(plotY(box, range, 0)) + snap;
    bg.setLineDash([4, 4]);
    bg.beginPath();
    bg.moveTo(left, zero);
    bg.lineTo(right, zero);
    bg.stroke();
    bg.setLineDash([]);

    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    bg.textBaseline = 'top';
    // Three numerals across the whole run, anchored at the ends so none of them
    // can overhang the plate however wide the label face turns out to be:
    // `3000` centred on the last tick is 30.8 px of glyph in a 16 px margin,
    // and both terms are constants, so it cleared the edge by 0.6 px at every
    // plate width this tab is ever given.
    const numeralY = bottom + TICK + LABEL_GAP;
    bg.textAlign = 'left';
    bg.fillText('0', plotX(box, 0, MAX_ROUNDS), numeralY);
    bg.textAlign = 'center';
    bg.fillText(String(MAX_ROUNDS / 2), plotX(box, MAX_ROUNDS / 2, MAX_ROUNDS), numeralY);
    bg.textAlign = 'right';
    bg.fillText(String(MAX_ROUNDS), plotX(box, MAX_ROUNDS, MAX_ROUNDS), numeralY);
    bg.textAlign = 'right';
    bg.textBaseline = 'middle';
    for (const money of [range.max, 0, range.min]) {
      bg.fillText(moneyLabel(money), left - TICK - LABEL_GAP, plotY(box, range, money));
    }
    bg.textAlign = 'left';
    bg.textBaseline = 'bottom';
    bg.fillText('money vs rounds', box.x, box.y - LABEL_GAP);

    // The predictions are static geometry: they depend on the tilt and on
    // nothing the run does, so they belong here rather than on a layer that is
    // repainted sixty times a second. Drawn the full length of the axis from
    // the first frame, so the measured traces are seen growing along a line
    // that was already there.
    const stride = vertexStride(box, MAX_ROUNDS);
    for (let r = 0; r < RULES.length; r++) {
      const curve = predicted[r]!;
      bg.lineJoin = 'round';
      bg.beginPath();
      for (let n = 0; n <= MAX_ROUNDS; n += stride) {
        bg.lineTo(plotX(box, n, MAX_ROUNDS), plotY(box, range, curve[n]!, HALO_PAD));
      }
      if (MAX_ROUNDS % stride !== 0) {
        bg.lineTo(plotX(box, MAX_ROUNDS, MAX_ROUNDS), plotY(box, range, curve[MAX_ROUNDS]!, HALO_PAD));
      }
      // The three predictions cross the dashed zero line and each other, and the
      // drafting pen is 1.96:1 from the signal pen, so the plate colour goes
      // down between them.
      strokeWithHalo(bg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);
    }
  }

  /**
   * The key to the four pens.
   *
   * On the foreground and painted after the traces, because a key the data
   * draws over is not a key. It goes in whichever left corner the traces leave
   * alone: every trace starts at nothing and fans out to the right, so the
   * corner furthest from the zero line is clear for as long as the key is wide.
   */
  function paintKey(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const sample = 14;
    const gap = 5;
    const pad = 5;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    fg.font = theme.labelFont;
    let textW = 0;
    for (const [text] of KEY_ROWS) textW = Math.max(textW, fg.measureText(text).width);

    const w = Math.round(2 * pad + sample + gap + textW);
    const h = Math.round(2 * pad + KEY_ROWS.length * step - 4);
    // A key that does not fit is worse than none: it would sit on the traces.
    if (w > box.width - 12 || h > box.height - 12) return;

    const zero = plotY(box, range, 0);
    const high = zero < box.y + box.height / 2;
    const x = Math.round(box.x + 6);
    const y = Math.round(high ? box.y + box.height - 6 - h : box.y + 6);

    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    fg.fillStyle = theme.canvas;
    fg.fillRect(x, y, w, h);
    fg.strokeStyle = theme.gridSoft;
    fg.lineWidth = theme.lineWidth;
    // Inset by half a line width so the frame lands inside the plate it draws.
    fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);

    fg.textAlign = 'left';
    fg.textBaseline = 'middle';
    fg.lineWidth = 2 * theme.lineWidth;
    KEY_ROWS.forEach(([text, rule], i) => {
      const cy = y + pad + i * step + textH / 2;
      fg.strokeStyle = penFor(rule, theme);
      // The swatch carries the dash as well as the pen, or the key cannot tell
      // the two losing games apart either.
      fg.setLineDash(dashFor(rule));
      fg.beginPath();
      fg.moveTo(x + pad, cy);
      fg.lineTo(x + pad + sample, cy);
      fg.stroke();
      fg.fillStyle = theme.ink;
      fg.fillText(text, x + pad + sample + gap, cy);
    });
    fg.setLineDash(dashFor(-1));
  }

  const instance: VizInstance = {
    step(dt) {
      if (table.finished) {
        pending = 0;
        return;
      }
      pending += (ROUND_RATE * dt) / 1000;
      // A round consumes exactly one draw per player per rule, always in the
      // same order, so the run for a seed is the same however the driver
      // batches its ticks.
      while (pending >= 1 && !table.finished) {
        table.playRound(ctx.rng);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move everything.
      syncStructure();
      paintBackground();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      const round = table.round;
      const stride = vertexStride(box, MAX_ROUNDS);
      fg.lineJoin = 'round';
      // RULES is ordered A, B, taking turns, so the star is painted last and
      // nothing lands on top of it.
      for (let r = 0; r < RULES.length; r++) {
        // The dash is what separates the two losing traces, which share a pen:
        // it goes on before the halo so the plate colour is laid under the
        // dashes and not through the gaps between them.
        fg.setLineDash(dashFor(r));
        fg.beginPath();
        for (let n = 0; n <= round; n += stride) {
          fg.lineTo(plotX(box, n, MAX_ROUNDS), plotY(box, range, table.historyAt(r, n), HALO_PAD));
        }
        if (round % stride !== 0) {
          fg.lineTo(plotX(box, round, MAX_ROUNDS), plotY(box, range, table.historyAt(r, round), HALO_PAD));
        }
        // Every trace crosses its own prediction repeatedly — that is what it
        // means for the measurement to land on it — so the plate colour goes
        // down between the two pens.
        strokeWithHalo(fg, undefined, penFor(r, theme), theme.canvas, 2 * theme.lineWidth);
      }
      fg.setLineDash(dashFor(-1));

      paintKey(fg);
      ctx.emit(readouts());
    },

    // No onParamChange: both faders are structural. A new tilt is a new pair of
    // games, and a new table size seats players who have played nothing, so
    // either one is a fresh experiment and the shell resets.

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      syncStructure();
      table.configure(playerCount(ctx.params), epsOf(ctx.params));
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const parrondo: Viz = {
  id: 'parrondo',
  title: 'Two Losing Games',
  group: 'randomness',
  blurb: 'Plays two coin games that each lose money on their own, and wins by taking turns between them.',
  // Landscape, because the plate is one chart of money against rounds and the
  // rounds axis is the long one. Square on a phone, where a 1.6 bed leaves the
  // three lines 230 px to separate in and the key nowhere to sit.
  aspect: 1.6,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  budget: { maxEntities: RULES.length * MAX_PLAYERS },
  create,
};
