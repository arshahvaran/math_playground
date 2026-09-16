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
  MEAN_FACTOR,
  MEDIAN_FACTOR,
  STEP_DECADES,
  TOP_SLICE,
  meanFactorTolerance,
  medianFactorTolerance,
  shareBelowStake,
  shareTolerance,
  wealthWindow,
  type WealthWindow,
} from './growth';

/** Hard ceiling on the crowd; the `players` fader tops out here too. */
const MAX_PLAYERS = 20_000;
const MIN_PLAYERS = 500;
const DEFAULT_PLAYERS = 4_000;

/**
 * Rounds the fader offers, and the tens it moves in.
 *
 * A hundred is where the two lines are four and a half decades apart and 86% of
 * the crowd is under the stake, which is the whole argument. It is also close to
 * where a browser-sized crowd stops being able to *measure* the average: the few
 * players who carry E[W] are rarer than one in a few thousand by then, so the
 * reading drifts a per cent or so below 1.05 and the allowance that admits it
 * widens with it. Past a hundred it would be honest and useless at once.
 *
 * The step of ten is the middle pile's doing and is load-bearing, not cosmetic:
 * an even round count has a genuine middle at r/2 heads, worth exactly
 * √(UP·DOWN) per round, while an odd one splits the crowd into two equal halves
 * with a gap between them and the reading lands 4% off — see
 * `medianFactorTolerance`.
 */
const MIN_ROUNDS = 10;
const MAX_ROUNDS = 100;
const ROUND_STEP = 10;
const DEFAULT_ROUNDS = 40;

const DEFAULT_SEED = 42;

/**
 * Paths recorded, and the ceiling on paths painted.
 *
 * This is an ink budget, not a memory one. Every path crosses the whole plate,
 * so `n` of them ink roughly `1 − exp(−n·w/h)` of it: at the 2 px the graphite
 * pen needs to stay a conformant mark, forty-eight of them ink a quarter of a
 * 340 px tall plot and a hundred and twenty would ink half of it. Forty-eight is
 * the ceiling and `INK_TARGET` is what actually decides how many are drawn — the
 * crowd behind them keeps its full size, and every reading is taken over all of
 * it.
 *
 * Forty-odd paths is also what makes the tab's own point countable: at a hundred
 * rounds 13.6% of players finish above the stake, so four or five of the threads
 * on screen are the ones carrying the whole average, and a reader can point at
 * them.
 */
const MAX_PAINTED = 48;

/** The fraction of the plot the fan may ink. Past a third the paths stop being separable. */
const INK_TARGET = 0.22;

/**
 * Width of a path in units of `theme.lineWidth`. The graphite pen is 3.61:1 on
 * the plate solid and 1.77:1 once anti-aliasing smears it across a hairline —
 * DESIGN §7's "never a 1 px mark in `--data-3`" — so a path is 2 px, always.
 */
const PATH_WEIGHT = 2;

/**
 * The run's pace. Every round is one coin flip per player, and a whole run takes
 * about this long whatever the round count, between a floor that keeps a short
 * run from crawling and a ceiling that keeps a long one from being a blur.
 */
const RUN_SECONDS = 14;
const MIN_ROUND_RATE = 1;
const MAX_ROUND_RATE = 20;

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Room for the y-axis labels. The widest is `÷10⁷`: four glyphs of the 11 px mono face, plus tick and gap. */
const GUTTER_LEFT = 44;
/** Room for the round numerals under the box. */
const GUTTER_BOTTOM = 18;
/** Room for the axis caption above the box. */
const GUTTER_TOP = 14;
const GUTTER_RIGHT = 8;

/** Axis tick length and the gap between a tick and its numeral, CSS px. */
const TICK = 4;
const LABEL_GAP = 3;

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side of the path and would otherwise erase the frame
 * wherever a curve rides an edge.
 */
const HALO_PAD = 3;

export interface PlotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The data box, inside the axis gutters. The frame is drawn on its edges. */
export function layoutPlot(width: number, height: number): PlotBox {
  const x = PLATE_PAD + GUTTER_LEFT;
  const y = PLATE_PAD + GUTTER_TOP;
  return {
    x,
    y,
    width: Math.max(1, width - x - PLATE_PAD - GUTTER_RIGHT),
    height: Math.max(1, height - y - PLATE_PAD - GUTTER_BOTTOM),
  };
}

/** Round → x. Linear, from the stake at round zero to the far edge at the last round. */
export function plotX(box: PlotBox, round: number, rounds: number): number {
  return box.x + (round / Math.max(1, rounds)) * box.width;
}

/**
 * Decades above the stake → y, top down, held inside the box by `pad`.
 *
 * The inset is for the two curves and their halos, which the window contains by
 * construction and which would otherwise erase the frame where one runs along
 * it. It is not a way of keeping a stray path on the plate: `draw()` drops a
 * thread that leaves the window rather than pinning it to an edge.
 */
export function plotY(box: PlotBox, win: WealthWindow, decade: number, pad = 0): number {
  const span = Math.max(1, win.top - win.bottom);
  const inset = Math.min(pad, box.height / 2);
  const y = box.y + ((win.top - decade) / span) * box.height;
  return Math.min(Math.max(y, box.y + inset), box.y + box.height - inset);
}

/** Rounds between x-axis ticks: the coarsest step that still leaves ten or fewer of them. */
export function roundTickStep(rounds: number): number {
  for (const step of [1, 2, 5, 10, 20, 25, 50]) {
    if (rounds / step <= 10) return step;
  }
  return Math.max(1, Math.ceil(rounds / 10));
}

/**
 * A y-axis label, as a multiple of the stake: `start`, `×10`, `÷100`, `÷10⁸`.
 *
 * Powers of ten in the abstract are the wrong label for a plate whose whole
 * point is what happened to somebody's money. "÷100" says a reader kept a
 * hundredth of what they put in, which is the sentence the axis is for.
 */
export function multipleLabel(decade: number): string {
  if (decade === 0) return 'start';
  const n = Math.abs(decade);
  const sign = decade > 0 ? '×' : '÷';
  if (n === 1) return `${sign}10`;
  if (n === 2) return `${sign}100`;
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  let sup = '';
  for (const ch of String(n)) sup += digits[Number(ch)] ?? '';
  return `${sign}10${sup}`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Two faders. The payoffs are not among them: 1.5 and 0.6 are chosen so that the
 * average grows while the middle shrinks, and a reader who moves either one
 * mostly turns the tab into a game that simply wins or simply loses.
 *
 * The seed is declared but never rendered — the rail skips seed specs — because
 * `coerceParams()` only reads a permalink key that has a spec, and without it
 * `?seed=7` is dropped on the way in and every shared link replays the default.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'players',
    label: 'Players',
    min: MIN_PLAYERS,
    max: MAX_PLAYERS,
    step: 100,
    default: DEFAULT_PLAYERS,
    log: true,
    help: 'Everyone plays the same game at the same time; a few dozen of their paths are drawn.',
  },
  {
    kind: 'range',
    key: 'rounds',
    label: 'Rounds',
    min: MIN_ROUNDS,
    max: MAX_ROUNDS,
    step: ROUND_STEP,
    default: DEFAULT_ROUNDS,
    help: 'How many times each player flips the coin.',
  },
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

/** Three steps: the lines part, the lines run away, and one player in a hundred owns the room. */
const presets: readonly Preset[] = [
  {
    id: 'ten-rounds',
    label: 'Ten rounds',
    caption: 'Ten rounds is enough for the two lines to part, and already most players hold less than they started with.',
    values: { players: 4_000, rounds: 10 },
  },
  {
    id: 'a-hundred-rounds',
    label: 'A hundred rounds',
    caption:
      'A hundred rounds later the average has multiplied a hundredfold while the middle of the crowd is down to half a per cent of the stake.',
    values: { players: 4_000, rounds: 100 },
  },
  {
    id: 'a-big-crowd',
    label: 'A big crowd',
    caption: 'Twenty thousand players, and the luckiest one in a hundred of them ends up holding almost all of the money.',
    values: { players: 20_000, rounds: 100 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'The +50% / −40% coin is Ole Peters’ standard illustration of the gap between what happens to an average ' +
      'and what happens to a person, set out in Nature Physics in 2019.',
    source: {
      label: 'Peters, “The ergodicity problem in economics”, Nature Physics 15, 1216–1221 (2019)',
      url: 'https://doi.org/10.1038/s41567-019-0732-0',
    },
  },
  {
    text:
      'John Kelly, a colleague of Claude Shannon at Bell Labs, showed in 1956 that staking only a quarter of your ' +
      'money on this same coin turns the middle player’s 5.13% loss a round into a 0.62% gain.',
    source: {
      label: 'Kelly, “A New Interpretation of Information Rate”, Bell System Technical Journal 35(4), 917–926 (1956)',
      url: 'https://doi.org/10.1002/j.1538-7305.1956.tb03809.x',
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

/** The crowd this run plays with, clamped the way `Crowd` clamps its own. */
function playerCount(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_PLAYERS, Math.floor(num(values, 'players', DEFAULT_PLAYERS))));
}

/**
 * The rounds this run will play.
 *
 * Snapped to the fader's own step rather than merely clamped, because the step
 * is what keeps the count even and the middle pile exactly on its prediction.
 * The router already rounds a `range` to its step on the way in, so this only
 * catches a value handed straight to `create()`.
 */
function roundCount(values: ParamValues): number {
  const raw = num(values, 'rounds', DEFAULT_ROUNDS);
  const snapped = ROUND_STEP * Math.round(raw / ROUND_STEP);
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, snapped));
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

/**
 * A display window: an opaque plate of the canvas colour with a 1 px frame.
 *
 * Opaque because forty paths read straight through a translucent one, and the
 * frame takes the container pen — a window holds a key to the experiment, it is
 * not part of it.
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
  const crowd = new Crowd(MAX_PLAYERS, MAX_ROUNDS, MAX_PAINTED);

  // Structural: both come from the parameters and both move the axis, so they
  // are re-read wherever the background is repainted.
  let box = layoutPlot(ctx.width, ctx.height);
  let win = wealthWindow(DEFAULT_ROUNDS);
  let rate = roundRateFor(DEFAULT_ROUNDS);

  // Fractional rounds owed by the rate accumulator between ticks.
  let pending = 0;

  function syncStructure(): void {
    const rounds = roundCount(ctx.params);
    box = layoutPlot(ctx.width, ctx.height);
    win = wealthWindow(rounds);
    rate = roundRateFor(rounds);
  }

  /**
   * The share under the stake is the headline: it is the reading that
   * contradicts the game's own advertising, and the one of the three a crowd
   * this size pins down to about a percentage point. The two per-round factors
   * are the mathematics behind it, and the luckiest slice is for the exact table.
   */
  function readouts(): Readout[] {
    const s = crowd.read();
    const players = crowd.players;
    return [
      { key: 'round', label: 'Rounds played', value: s.round, digits: 3, plain: 'rounds played' },
      {
        key: 'below',
        label: 'Below the stake',
        value: 100 * s.shareBelow,
        digits: 3,
        unit: '%',
        // The prediction is for the round reached, not for the round the run is
        // aiming at: a reading being compared against the end of a run it is
        // only a third of the way through would be off all the way and right at
        // the last frame.
        target: 100 * shareBelowStake(s.round),
        tolerance: shareTolerance(players, s.round),
        plain: 'players poorer than when they started',
        headline: true,
        hint: 'the coin has to land heads 56% of the time just to break even',
      },
      {
        key: 'typical',
        label: 'Middle pile, per round',
        value: s.medianFactor,
        digits: 5,
        target: MEDIAN_FACTOR,
        tolerance: medianFactorTolerance(players, s.round),
        formula: ['√(', { v: 'u' }, '·', { v: 'd' }, ')'],
        plain: 'what the middle player’s money does each round',
      },
      {
        key: 'average',
        label: 'Average pile, per round',
        value: s.meanFactor,
        digits: 5,
        target: MEAN_FACTOR,
        tolerance: meanFactorTolerance(players, s.round),
        formula: ['(', { v: 'u' }, ' + ', { v: 'd' }, ')/2'],
        plain: 'what the average of every pile does each round',
      },
      {
        key: 'top',
        label: `Held by the luckiest ${100 * TOP_SLICE}%`,
        value: 100 * s.topShare,
        digits: 3,
        unit: '%',
        expertOnly: true,
      },
      { key: 'richest', label: 'Largest pile, × the stake', value: s.richest, digits: 4, expertOnly: true },
    ];
  }

  /**
   * The key to the three pens, in the box's top-left corner.
   *
   * On the foreground and painted after the curves, because the background layer
   * is *under* them: a key the data draws over is not a key. The corner is the
   * one part of the box nothing can reach — being two decades up after a tenth
   * of the rounds needs a run of heads with a probability of about one in a
   * million — and both curves leave the stake heading elsewhere.
   */
  function paintLegend(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const rows: ReadonlyArray<[string, string, number]> = [
      ['one player', theme.data3, PATH_WEIGHT * theme.lineWidth],
      ['average', theme.data2, 2 * theme.lineWidth],
      ['middle', theme.data1, 2 * theme.lineWidth],
    ];

    const sample = 14;
    const gap = 5;
    const pad = 5;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    fg.font = theme.labelFont;
    let textW = 0;
    for (const [text] of rows) textW = Math.max(textW, fg.measureText(text).width);

    const w = Math.round(2 * pad + sample + gap + textW);
    const h = Math.round(2 * pad + rows.length * step - 4);
    // A key that does not fit is worse than none: it would sit on the fan.
    if (w > box.width - 12 || h > box.height - 12) return;

    const x = Math.round(box.x + 6);
    const y = Math.round(box.y + 6);
    paintWindow(fg, theme.canvas, theme.gridSoft, theme.lineWidth, x, y, w, h);

    fg.textAlign = 'left';
    fg.textBaseline = 'middle';
    rows.forEach(([text, pen, width], i) => {
      const cy = y + pad + i * step + textH / 2;
      fg.strokeStyle = pen;
      fg.lineWidth = width;
      fg.beginPath();
      fg.moveTo(x + pad, cy);
      fg.lineTo(x + pad + sample, cy);
      fg.stroke();
      fg.fillStyle = theme.ink;
      fg.fillText(text, x + pad + sample + gap, cy);
    });
  }

  const instance: VizInstance = {
    step(dt) {
      if (crowd.finished) {
        pending = 0;
        return;
      }
      pending += (rate * dt) / 1000;
      // A round is exactly one draw per player, so the coin sequence for a seed
      // is the same however the driver batched its ticks — only the clock differs.
      while (pending >= 1 && !crowd.finished) {
        crowd.play(ctx.rng);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the axis.
      syncStructure();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      const rounds = roundCount(ctx.params);
      bg.clearRect(0, 0, width, height);

      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const left = Math.round(box.x) + snap;
      const right = Math.round(box.x + box.width) + snap;
      const top = Math.round(box.y) + snap;
      const bottom = Math.round(box.y + box.height) + snap;

      // The frame and the graduations contain the experiment rather than being
      // part of it: container pen, hairline, ticks hanging outside the box. A
      // lattice of rules across the plot would slice the fan into cells.
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      bg.moveTo(left, top);
      bg.lineTo(left, bottom);
      bg.lineTo(right, bottom);
      bg.lineTo(right, top);
      bg.lineTo(left, top);
      for (let d = win.bottom; d <= win.top; d++) {
        const y = Math.round(plotY(box, win, d)) + snap;
        bg.moveTo(left - TICK, y);
        bg.lineTo(left, y);
      }
      const tickStep = roundTickStep(rounds);
      for (let r = 0; r <= rounds; r += tickStep) {
        const x = Math.round(plotX(box, r, rounds)) + snap;
        bg.moveTo(x, bottom);
        bg.lineTo(x, bottom + TICK);
      }
      bg.stroke();

      // The stake is the experiment's own reference — every reading on this
      // plate is a comparison against it — so it is the one near-black rule
      // here, and the only thing on the plate wearing the apparatus pen.
      bg.strokeStyle = theme.grid;
      bg.beginPath();
      const stake = Math.round(plotY(box, win, 0)) + snap;
      bg.moveTo(left, stake);
      bg.lineTo(right, stake);
      bg.stroke();

      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;

      // Numerals thin out rather than collide, anchored on the stake so that
      // `start` is labelled at every plate size.
      const decades = Math.max(1, win.top - win.bottom);
      const everyY = box.height / decades >= 26 ? 1 : 2;
      bg.textAlign = 'right';
      bg.textBaseline = 'middle';
      for (let d = 0; d <= win.top; d += everyY) {
        bg.fillText(multipleLabel(d), left - TICK - LABEL_GAP, plotY(box, win, d));
      }
      for (let d = -everyY; d >= win.bottom; d -= everyY) {
        bg.fillText(multipleLabel(d), left - TICK - LABEL_GAP, plotY(box, win, d));
      }

      const everyX = box.width / Math.max(1, rounds / tickStep) >= 30 ? 1 : 2;
      bg.textBaseline = 'top';
      for (let r = 0; r <= rounds; r += tickStep * everyX) {
        // Anchored at the ends rather than centred throughout, so no numeral can
        // overhang the plate whatever the label face turns out to be: a numeral
        // centred on the last tick clears the right margin by 4.5 px at 360 px
        // in the shipped face and by nothing at all in a wider one.
        bg.textAlign = r === 0 ? 'left' : r >= rounds ? 'right' : 'center';
        bg.fillText(String(r), plotX(box, r, rounds), bottom + TICK + LABEL_GAP);
      }

      // The axis caption, and the name of the other axis where there is room for
      // it. Both are fixed strings, so nothing here is sized from a reading.
      const caption = 'each step up is ten times richer';
      bg.textAlign = 'left';
      bg.textBaseline = 'bottom';
      bg.fillText(caption, box.x, box.y - LABEL_GAP);
      if (bg.measureText(`${caption}rounds`).width + 12 <= box.width) {
        bg.textAlign = 'right';
        bg.fillText('rounds', box.x + box.width, box.y - LABEL_GAP);
      }
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const rounds = crowd.rounds;
      const played = crowd.round;
      fg.clearRect(0, 0, width, height);
      fg.lineJoin = 'round';

      // Paint the paths the ink budget affords and let the rest of the crowd go
      // uncounted on screen while every reading still counts all of it.
      //
      // A path is not a straight line: it travels `box.width/rounds` across and
      // `STEP_DECADES` of a decade up or down per round, so its length — and the
      // ink it costs — is the hypotenuse, which is half as long again at a
      // hundred rounds as the plot is wide. `n` such marks over a plot of area A
      // ink 1 − exp(−n·a/A) of it.
      const pxPerDecade = box.height / Math.max(1, win.top - win.bottom);
      const acrossPerRound = box.width / Math.max(1, rounds);
      const pathLength = rounds * Math.hypot(acrossPerRound, STEP_DECADES * pxPerDecade);
      const perPath = Math.max(1, pathLength * PATH_WEIGHT * theme.lineWidth);
      const affordable = Math.ceil((-Math.log(1 - INK_TARGET) * box.width * box.height) / perPath);
      const paths = Math.min(crowd.paths, Math.max(1, affordable));

      // One path object for the whole fan: forty-eight threads is one stroke and
      // one style change, never one of each per player.
      //
      // A thread that leaves the window is dropped while it is outside and
      // picked up where it comes back, rather than clamped to the edge. The
      // clamp is what `plotY` does for the two curves, which can never reach an
      // edge; for a path it would draw a horizontal line along the floor, and a
      // flat line on this plate reads as a player whose money stopped moving —
      // the exact opposite of what happened to them. Roughly one thread in a
      // run goes under, which is the 1.4% the window was sized for.
      const edge = theme.lineWidth;
      fg.strokeStyle = theme.data3;
      fg.lineWidth = PATH_WEIGHT * theme.lineWidth;
      fg.beginPath();
      for (let i = 0; i < paths; i++) {
        let open = false;
        for (let r = 0; r <= played; r++) {
          const decade = crowd.pathAt(i, r);
          if (decade > win.top || decade < win.bottom) {
            open = false;
            continue;
          }
          const x = plotX(box, r, rounds);
          const y = plotY(box, win, decade, edge);
          if (open) {
            fg.lineTo(x, y);
          } else {
            fg.moveTo(x, y);
            open = true;
          }
        }
      }
      fg.stroke();

      // The average takes the drafting pen: it is the line everybody predicts
      // before the run, and the one the game is sold on. The middle of the crowd
      // takes the signal pen, because it is what is actually happening to the
      // player watching. Both cross the fan and each other, so both take the
      // halo — the two pens are 1.96:1 apart and the plate colour goes between.
      const curve = 2 * theme.lineWidth;
      fg.beginPath();
      for (let r = 0; r <= played; r++) {
        fg.lineTo(plotX(box, r, rounds), plotY(box, win, crowd.meanAt(r), HALO_PAD));
      }
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, curve);

      fg.beginPath();
      for (let r = 0; r <= played; r++) {
        fg.lineTo(plotX(box, r, rounds), plotY(box, win, crowd.medianAt(r), HALO_PAD));
      }
      strokeWithHalo(fg, undefined, theme.data1, theme.canvas, curve);

      paintLegend(fg);

      ctx.emit(readouts());
    },

    // No onParamChange: both knobs are structural. A new crowd is a new
    // experiment, and a new round count is a new axis — the window is a function
    // of it — so the paths already drawn belong to a plate that no longer
    // exists. The shell resets on each.

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      crowd.setParams(playerCount(ctx.params), roundCount(ctx.params));
      crowd.reset();
      syncStructure();
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const compounding: Viz = {
  id: 'compounding',
  title: 'Compounding',
  group: 'randomness',
  blurb:
    'Flips a coin for every player each round, growing their money by half on heads and shrinking it by two fifths on tails.',
  // Landscape, like every plot: the x axis is time and the fan needs room to
  // spread along it. Squarer on a phone, where the log axis can span eleven
  // decades and a 1.6 bed would give each of them 20 px.
  aspect: 1.6,
  aspectNarrow: 0.9,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_PLAYERS },
  create,
};
