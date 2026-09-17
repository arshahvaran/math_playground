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
  DOMINANT_P,
  FAIR_P,
  LEAD_MEAN,
  LEAD_VARIANCE,
  LeadTally,
  TRACE_SAMPLES,
  analyticBarHeight,
  analyticBinProbability,
  playGame,
} from './walk';

/**
 * Bars in the histogram.
 *
 * Odd on purpose: an even count splits the plate at ½, and the games that came
 * out exactly level — the single value this tab is arguing about — would all
 * have to fall to one side of that split. Twenty-one bars put ½ at the centre
 * of the middle bar, and at the shortest game the fader offers they still hold
 * 400/42 ≈ 10 of the values a game can actually produce, so the bars are a
 * histogram rather than a comb.
 */
export const BINS = 21;

/**
 * Where the two faders stop, and why the product of them is the number that
 * matters.
 *
 * A game costs one `rng.next()` and a comparison per flip, which measures about
 * 50 M flips a second. A run is paced to finish in `RUN_SECONDS` whatever it is
 * asked for, so the peak rate is MAX_GAMES·MAX_FLIPS/RUN_SECONDS = 5 M flips a
 * second — 83,000 in a 60 Hz frame, 1.7 ms of the 16 ms budget, and 200 ms for
 * the two seconds of simulated time one Fast-forward press buys. Raising either
 * ceiling raises all three together.
 *
 * Six thousand rather than five, because of what the headline is measuring: a
 * proportion near 0.41 is settled to a twentieth of itself only from about
 * 5,200 games, so at five thousand there was no setting of the two faders at
 * which the tab's own headline could be tested — it would have read "still
 * settling" for ever, which is as unhelpful as the false check mark it
 * replaced. The ceiling is now just past that count, and the last preset is
 * where the reader meets it.
 */
export const MAX_GAMES = 6_000;
export const MAX_FLIPS = 10_000;
export const MIN_GAMES = 200;
export const MIN_FLIPS = 400;

/**
 * The faders' grids. A game must have an even number of flips for the count of
 * led intervals to be even, which is what the exact law above is stated in, and
 * a permalink can carry any number at all — so both are snapped here as well as
 * in the control.
 */
export const FLIP_STEP = 40;
export const GAME_STEP = 100;

const DEFAULT_FLIPS = 2_000;
const DEFAULT_GAMES = 2_000;
const DEFAULT_SEED = 42;

/** A run of any length takes about this long, the way the Galton board's does. */
export const RUN_SECONDS = 12;

/**
 * Traces kept on the fan, and how often a new one is caught.
 *
 * This is the ink budget, and it is deliberately not the game count: the tally
 * below counts every game played — five thousand of them — while the fan paints
 * five. A fan of fifty is a solid vermilion band in which no single path can be
 * followed, and following one path is the entire job of the fan. Catching two
 * and a half a second rather than every game is the same argument in time: at
 * the default pace 167 games finish every second, and a fan that redrew itself
 * 167 times a second would be a flicker, not a picture.
 */
export const TRACES = 5;
const TRACES_PER_SECOND = 2.5;

/**
 * Half-height of the fan, in standard deviations of the final score.
 *
 * A game's score wanders on the scale √n, and the largest excursion of a fair
 * walk clears a√n with probability about 4·Φ̄(a) — one trace in forty at 2.5,
 * one in two hundred at 3. At 3 the traces sat in the middle half of the fan
 * and read as a ribbon; 2.5 fills it, and a clip is rare enough to read as a
 * trace that went off the top rather than as a flat line. The traces arrive
 * already divided by √n, so this is the same frame at 400 flips and at 10,000.
 */
const TRACE_SIGMA = 2.5;

/** The fan's share of the plate between the top margin and the axis. */
const FAN_SHARE = 0.34;

/**
 * Room above the tallest bar the law predicts, as a factor.
 *
 * The end bars are the tallest, at F(1/21) = 0.140 each, and a bar's height
 * fluctuates by √(p(1−p)/games) — 0.8% of the plate at the default game count
 * and 2.5% at the fewest games the fader offers. A third of the bar's own
 * height is many times either, so the histogram never reaches the fan and the
 * vertical scale can be fixed for the whole run: nothing on this plate moves
 * because a number changed.
 */
const HEADROOM = 1.3;

/** The tallest bar the law predicts, in probability. The vertical scale comes from it. */
const TALLEST_BAR = analyticBinProbability(0, BINS);

/** Plate margin, axis tick length, and the gap between a tick and its numeral, CSS px. */
const PAD = 8;
const TICK = 4;
const LABEL_GAP = 3;
/** Room under the ticks for the axis numerals, CSS px. */
const LABEL_ROW = 14;
/** Room between the fan and the histogram, enough for the caption that sits in it. */
const GAP = 18;
/** Shortest fan and histogram worth drawing, CSS px. Below this the plate is all furniture. */
const MIN_FAN = 40;
const MIN_HIST = 60;

/**
 * Standard errors inside which a finished run is expected to land. Three is the
 * same bet the Galton board's variance row makes: about three runs in a
 * thousand sit outside it, and a row that cried wolf more often than that would
 * teach the wrong lesson about what agreement looks like.
 */
const SIGMAS = 3;

/**
 * How far the exact finite-game law sits above its own limit.
 *
 * Summing Feller's C(2k,k)·C(2m−2k,m−k)/4^m over the two dominated tails gives
 * DOMINANT_P + 2.97/flips, and over the fair-looking band FAIR_P + 1.22/flips,
 * at every game length the fader reaches; the largest gap between that exact
 * distribution function and F, at the bars' own edges, is 0.0036. Both tail
 * terms are what closing a band on an atom of the finite law costs — the atom
 * at 0.1 carries 2·f(0.1)/n = 2.12/n and the one at ½ carries 2·f(½)/n =
 * 1.27/n — plus the error in summing a convex density on a grid of spacing 2/n.
 * The mean needs no such term: it is exactly ½ at every game length, and the
 * variance is exactly (n+2)/(8n), which is ⅛ over by 2/n.
 *
 * These are bounds on the exact law, not on a simulation, and tests/arcsine
 * pins all four against it rather than against a run.
 */
export const DOMINANT_EXCESS = 3;
export const FAIR_EXCESS = 1.25;
export const CDF_EXCESS = 0.004;
export const VARIANCE_EXCESS = 2;

/**
 * Kolmogorov's 99th percentile: P(√M · Dₘ > 1.628) = 0.01. The gap this tab
 * measures is taken at the bars' edges only, so it is bounded above by Dₘ and
 * this is a conservative band for it.
 */
export const KS_CRITICAL = 1.628;

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'flips',
    label: 'Flips per game',
    min: MIN_FLIPS,
    max: MAX_FLIPS,
    step: FLIP_STEP,
    default: DEFAULT_FLIPS,
    log: true,
    help: 'How long one game lasts. The coin is fair at every setting.',
  },
  {
    kind: 'range',
    key: 'games',
    label: 'Games',
    min: MIN_GAMES,
    max: MAX_GAMES,
    step: GAME_STEP,
    default: DEFAULT_GAMES,
    log: true,
    help: 'How many games are played and tallied into the chart.',
  },
  // Not a control — the rail never renders this kind — but the spec is what
  // binds the seed to the URL: without it a permalink's seed is dropped on the
  // way in and the transport's Shuffle key has nothing to set.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'short-game',
    label: 'Short game',
    caption:
      'Four hundred flips a game. One side is ahead the whole way in about one game in twelve, and the middle of the chart is already the emptiest place to be.',
    values: { flips: 400, games: 2_000 },
  },
  {
    id: 'long-game',
    label: 'Long game',
    caption:
      'Twenty-five times as many flips, and the chart does not fill in. Being ahead for about half the game is still the rarest result there is.',
    values: { flips: 10_000, games: 2_000 },
  },
  {
    id: 'many-games',
    label: 'More games',
    caption: 'Six thousand games, and the bars settle onto the curve the mathematics predicts.',
    values: { flips: 10_000, games: MAX_GAMES },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Paul Lévy published this law in 1939: the share of a fair game one side spends in front follows an arcsine curve, ' +
      'whose density is lowest at one half — so a game that ends up looking even is the least likely kind of game there is.',
    source: {
      label: 'Lévy, “Sur certains processus stochastiques homogènes”, Compositio Mathematica 7 (1939), 283–339',
      url: 'https://en.wikipedia.org/wiki/Arcsine_laws_(Wiener_process)',
    },
  },
  {
    text:
      'In a game of twenty flips, one side is ahead at every single moment of it in 35% of games, while the two sides ' +
      'split the time exactly evenly in 6% — the two extremes together beat the fair-looking middle by nearly six to one.',
    source: {
      label: 'Feller, An Introduction to Probability Theory and Its Applications, vol. 1, 3rd ed. (1968), ch. III.4',
      url: 'https://en.wikipedia.org/wiki/Arcsine_laws_(Wiener_process)',
    },
  },
  {
    text:
      'One curve answers three questions that sound unrelated: how long one side led, when the scores were last level, ' +
      'and when the biggest lead happened. Feller warned that the answer contradicts what nearly everyone expects.',
    source: {
      label: 'Feller, An Introduction to Probability Theory and Its Applications, vol. 1, 3rd ed. (1968), ch. III',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** A value clamped into `[min, max]` and put back on a grid of `step` from `min`. */
function onGrid(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  return min + step * Math.round((clamped - min) / step);
}

/** Flips this run plays per game: on the fader's grid, and therefore even. */
export function flipsFor(values: ParamValues): number {
  return onGrid(num(values, 'flips', DEFAULT_FLIPS), MIN_FLIPS, MAX_FLIPS, FLIP_STEP);
}

/** Games this run will play before it stops. */
export function gamesFor(values: ParamValues): number {
  return onGrid(num(values, 'games', DEFAULT_GAMES), MIN_GAMES, MAX_GAMES, GAME_STEP);
}

/** Games per second of simulation time that finish a run of `games` in about RUN_SECONDS. */
export function gameRateFor(games: number): number {
  return games / RUN_SECONDS;
}

/**
 * Three standard errors of a measured proportion, in the proportion's own
 * units: 3·√(p(1−p)/M) over the games tallied *so far*.
 *
 * NaN before the first game, which the ledger reads as no band at all rather
 * than as a band of unlimited width — the reading is NaN then too, and neither
 * one is a claim about anything.
 */
function proportionBand(p: number, games: number): number {
  return games > 0 ? SIGMAS * Math.sqrt((p * (1 - p)) / games) : Number.NaN;
}

export interface PlateLayout {
  /** Left and right ends of both the fan and the histogram, CSS px. */
  left: number;
  right: number;
  fanTop: number;
  fanBottom: number;
  /** The score-zero line: where a game is level. */
  fanZero: number;
  /** Half the fan's height, which is `TRACE_SIGMA` standard deviations of the score. */
  fanHalf: number;
  histTop: number;
  /** The histogram's baseline, and the line the axis ticks hang from. */
  histBase: number;
  binW: number;
}

/**
 * Where the fan and the histogram sit on a plate `width` × `height`.
 *
 * Both are derived from the plate alone — never from the text of a number — so
 * the only thing that moves between frames is the data. The axis row at the
 * bottom is reserved whether or not the numerals have been painted yet.
 */
export function layoutPlate(width: number, height: number): PlateLayout {
  const left = PAD;
  const right = Math.max(left + BINS, width - PAD);
  const top = PAD;
  const histBase = Math.max(top + MIN_FAN + GAP + MIN_HIST, height - PAD - TICK - LABEL_GAP - LABEL_ROW);
  const body = histBase - top;
  // The fan gives way to the histogram on a short plate: a histogram under
  // MIN_HIST is a row of stubs, and the fan is the part that can be read at any
  // height at all.
  const fanHeight = Math.max(MIN_FAN, Math.min(FAN_SHARE * body, body - GAP - MIN_HIST));
  return {
    left,
    right,
    fanTop: top,
    fanBottom: top + fanHeight,
    fanZero: top + fanHeight / 2,
    fanHalf: fanHeight / 2,
    histTop: top + fanHeight + GAP,
    histBase,
    binW: (right - left) / BINS,
  };
}

function create(ctx: VizContext): VizInstance {
  const tally = new LeadTally(BINS);

  // Every array this tab owns, allocated once here: the traces on the fan, and
  // this frame's bar heights so the wash and its silhouette cannot disagree by
  // a pixel. Neither one grows with the game count — the tally is `BINS` wide
  // however many games run through it.
  const traces = new Float32Array(TRACES * TRACE_SAMPLES);
  const barH = new Float64Array(BINS);
  let head = 0;
  let stored = 0;

  let flips = DEFAULT_FLIPS;
  let target = DEFAULT_GAMES;
  let rate = gameRateFor(DEFAULT_GAMES);
  let tracePeriod = 1;
  let layout = layoutPlate(ctx.width, ctx.height);

  // Fractional games owed by the rate accumulator between ticks.
  let pending = 0;

  function syncStructure(): void {
    flips = flipsFor(ctx.params);
    target = gamesFor(ctx.params);
    rate = gameRateFor(target);
    // Which games get traced is a function of the parameters alone, never of
    // the clock, so a seed replays the same five paths on the fan.
    tracePeriod = Math.max(1, Math.round(rate / TRACES_PER_SECOND));
    layout = layoutPlate(ctx.width, ctx.height);
  }

  function readouts(): Readout[] {
    const games = tally.games;
    const dominant = games > 0 ? tally.dominant / games : NaN;
    const fair = games > 0 ? tally.fair / games : NaN;
    return [
      { key: 'games', label: 'Games played', value: games, digits: 6, plain: 'games played' },
      // §5: the hero prints "analytic" and the closed form behind the target.
      //
      // Every band below is three standard errors of the reading plus, where
      // there is one, the margin by which the exact law for a game this long
      // sits above the limit it is being compared against — at 400 flips the
      // coins are not quite obeying the limit yet, and that gap is the tab's,
      // not the reader's. The rows that carry such a bias state their band
      // absolutely, because a bias is not noise and cannot be divided by √M;
      // the one that has none (the mean is exactly ½ at every game length)
      // states its σ and lets the ledger do the dividing.
      //
      // All five counts are `tally.games`, the games played so far. Taken at
      // the count the run was going to *finish* on, the headline's band was
      // 8.4 % of its own prediction at the defaults and 26 % near the bottom of
      // the fader, which is how a reading of 0.5150 came to be certified
      // against 0.4097: a band that wide cannot be falsified by any result the
      // experiment could produce, so it was not a test of anything.
      {
        key: 'dominated',
        label: 'One side led ≥ 90%',
        value: dominant,
        digits: 4,
        target: DOMINANT_P,
        formula: ['(4/', { v: 'π' }, ')·arcsin(√0.1)'],
        band: {
          kind: 'absolute',
          half: proportionBand(DOMINANT_P, games) + DOMINANT_EXCESS / flips,
        },
        range: [0, 1],
        plain: 'share of games where one side led 90% of the game or more',
        headline: true,
      },
      {
        key: 'fair',
        label: 'Lead split 45–55%',
        value: fair,
        digits: 4,
        target: FAIR_P,
        formula: ['(2/', { v: 'π' }, ')·(arcsin√0.55 − arcsin√0.45)'],
        band: { kind: 'absolute', half: proportionBand(FAIR_P, games) + FAIR_EXCESS / flips },
        range: [0, 1],
        plain: 'share of games that came out looking even',
      },
      {
        key: 'average',
        label: 'Mean lead fraction',
        value: tally.mean,
        digits: 4,
        target: LEAD_MEAN,
        formula: '1/2',
        // One game's lead fraction has standard deviation √(1/8); the ledger
        // divides by the games in hand. No finite-game term: the exact law has
        // mean exactly ½ at every game length.
        band: { kind: 'sampled', sigma: Math.sqrt(LEAD_VARIANCE), samples: games },
        range: [0, 1],
        plain: 'average share of the game spent ahead',
      },
      {
        key: 'spread',
        label: 'Variance of lead fraction',
        value: tally.variance,
        digits: 4,
        target: LEAD_VARIANCE,
        formula: '1/8',
        // The arcsine law has kurtosis 3/2, so its fourth central moment is
        // (3/2)·(1/8)² = 3/128 and one game carries √(3/128 − 1/64) = 0.0884 of
        // standard deviation — its own, not the mean's, which is 0.354 and is
        // what this row used to borrow. The exact variance is (n+2)/(8n), over
        // by 2/n of itself.
        band: {
          kind: 'absolute',
          half:
            (SIGMAS * Math.sqrt(3 / 128 - 1 / 64)) / Math.sqrt(Math.max(1, games)) +
            (LEAD_VARIANCE * VARIANCE_EXCESS) / flips,
        },
        expertOnly: true,
      },
      {
        key: 'gap',
        label: 'Largest gap to the curve',
        value: tally.cdfGap(),
        digits: 3,
        target: 0,
        // A prediction of exactly zero is no scale at all, so the band is
        // judged against the span instead: a gap between two distribution
        // functions lives in [0, 1] whatever either of them is. Kolmogorov's
        // 99th percentile at the games played so far, plus the gap the exact
        // finite-game law has against the limit before a single coin is thrown.
        band: { kind: 'absolute', half: KS_CRITICAL / Math.sqrt(Math.max(1, games)) + CDF_EXCESS },
        range: [0, 1],
        expertOnly: true,
      },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      if (tally.games >= target) {
        pending = 0;
        return;
      }
      pending += (rate * dt) / 1000;
      // Each game consumes exactly `flips` draws, so the sequence of games for
      // a seed is the same however the ticks are batched.
      while (pending >= 1 && tally.games < target) {
        const traced = tally.games % tracePeriod === 0;
        const fraction = playGame(
          ctx.rng,
          flips,
          traced ? traces : undefined,
          traced ? head * TRACE_SAMPLES : 0,
        );
        if (traced) {
          head = head + 1 === TRACES ? 0 : head + 1;
          if (stored < TRACES) stored++;
        }
        tally.push(fraction);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move everything.
      syncStructure();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      const L = layout;
      bg.clearRect(0, 0, width, height);

      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;

      // Level: the line the score crosses, and the thing the whole tab is about
      // being on the wrong side of. It is the experiment's own geometry — the
      // ruled floorboard of this tab — so it takes the apparatus pen, and
      // nothing else on the plate does.
      const zero = Math.round(L.fanZero) + snap;
      bg.strokeStyle = theme.grid;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      bg.moveTo(L.left, zero);
      bg.lineTo(L.right, zero);
      bg.stroke();

      // The histogram's baseline and its ticks contain the experiment rather
      // than being part of it, so they take the container pen. Ticks hang below
      // the floor, where a bar can never cover them: a histogram needs a
      // baseline and a scale, not a grid of cells.
      const base = Math.round(L.histBase) + snap;
      bg.strokeStyle = theme.gridSoft;
      bg.beginPath();
      bg.moveTo(L.left, base);
      bg.lineTo(L.right, base);
      for (let j = 0; j <= BINS; j++) {
        const x = Math.round(L.left + j * L.binW) + snap;
        bg.moveTo(x, base);
        bg.lineTo(x, base + TICK);
      }
      bg.stroke();

      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;

      // Three numerals, anchored so none of them can overhang the plate however
      // wide the label face turns out to be.
      const numeralY = base + TICK + LABEL_GAP;
      bg.textBaseline = 'top';
      bg.textAlign = 'left';
      bg.fillText('0%', L.left, numeralY);
      bg.textAlign = 'center';
      bg.fillText('50%', (L.left + L.right) / 2, numeralY);
      bg.textAlign = 'right';
      bg.fillText('100%', L.right, numeralY);

      // What the two halves of the plate are. The fan's two labels sit at the
      // far left, where a walk that starts level cannot reach them, and the
      // histogram's caption at the far right — under the left one it stacked
      // into a block with "behind" and the pair read as a single sentence.
      bg.textAlign = 'left';
      bg.fillText('ahead', L.left + 2, L.fanTop);
      bg.textBaseline = 'bottom';
      bg.fillText('behind', L.left + 2, L.fanBottom);
      bg.textAlign = 'right';
      bg.fillText('share of the game one side was ahead', L.right, L.histTop - LABEL_GAP);
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const L = layout;
      const games = tally.games;
      fg.clearRect(0, 0, width, height);

      const depth = L.histBase - L.histTop;
      // Pixels per unit of probability, fixed for the whole run by the law
      // rather than by the tallest bar so far: a scale that followed the data
      // would rescale the picture every time a bar overtook another.
      const unit = depth / (TALLEST_BAR * HEADROOM);

      // The histogram is two marks, not one. An opaque graphite wash — never a
      // globalAlpha, which composites to a ghost — and then a full-opacity
      // silhouette that is the conformant graphical object carrying the shape.
      fg.fillStyle = theme.data3Fill;
      for (let j = 0; j < BINS; j++) {
        const share = games > 0 ? (tally.counts[j] ?? 0) / games : 0;
        const h = Math.min(depth, share * unit);
        barH[j] = h;
        if (h > 0) fg.fillRect(L.left + j * L.binW, L.histBase - h, L.binW, h);
      }

      if (games > 0) {
        // One stepped outline across the whole row — the risers between bars
        // belong to the outline. Its ends drop to the baseline, which the
        // background already draws, so the base needs no stroke of its own.
        fg.strokeStyle = theme.data3;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'miter';
        fg.beginPath();
        fg.moveTo(L.left, L.histBase);
        for (let j = 0; j < BINS; j++) {
          const y = L.histBase - (barH[j] ?? 0);
          fg.lineTo(L.left + j * L.binW, y);
          fg.lineTo(L.left + (j + 1) * L.binW, y);
        }
        fg.lineTo(L.right, L.histBase);
        fg.stroke();
      }

      // The analytic curve, drawn from the centre of the first bar to the
      // centre of the last: those are the two positions where a window one bar
      // wide still lies inside [0, 1], and the curve means nothing outside
      // them. It crosses its own histogram by construction, and the drafting
      // pen sits 1.96:1 from the signal pen and 6.41:1 from the wash, so the
      // plate colour goes down first and the pens never touch.
      const first = L.left + L.binW / 2;
      const last = L.right - L.binW / 2;
      const span = Math.max(1, last - first);
      const steps = Math.max(2, Math.ceil(span / 2));
      fg.lineJoin = 'round';
      fg.beginPath();
      for (let i = 0; i <= steps; i++) {
        const px = first + (span * i) / steps;
        const x = (px - L.left) / (L.right - L.left);
        const h = Math.min(depth, analyticBarHeight(x, 1 / BINS) * unit);
        fg.lineTo(px, L.histBase - h);
      }
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);

      // The fan: where the fractions under the histogram come from. Every trace
      // in one path and one stroke, so the halo is laid down under all of them
      // before any pen goes on and no trace can erase its neighbour.
      if (stored > 0) {
        const scale = L.fanHalf / TRACE_SIGMA;
        const step = (L.right - L.left) / (TRACE_SAMPLES - 1);
        fg.beginPath();
        for (let t = 0; t < stored; t++) {
          const base = t * TRACE_SAMPLES;
          for (let j = 0; j < TRACE_SAMPLES; j++) {
            const y = Math.min(
              L.fanBottom,
              Math.max(L.fanTop, L.fanZero - (traces[base + j] ?? 0) * scale),
            );
            const x = L.left + j * step;
            if (j === 0) fg.moveTo(x, y);
            else fg.lineTo(x, y);
          }
        }
        strokeWithHalo(fg, undefined, theme.data1, theme.canvas, 2 * theme.lineWidth, 2);
      }

      ctx.emit(readouts());
    },

    // No onParamChange: both faders are structural. A different game length is
    // a different experiment, and a different game count is a different run —
    // the games already tallied belong to neither.

    reset() {
      // The seed is not a control, but it still names the run: it arrives in
      // the parameters when the URL or the shell's Shuffle carries one, and the
      // same seed replays the same games and the same five traces.
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      syncStructure();
      tally.reset();
      head = 0;
      stored = 0;
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const arcsine: Viz = {
  id: 'arcsine',
  title: 'The Long Lead',
  group: 'randomness',
  blurb:
    'Plays a long game of coin flips over and over, and counts how much of each game one side spent in front.',
  // Landscape: the histogram wants twenty-one bars side by side and the traces
  // want a long time axis, and both run the same way across the plate. Square
  // on a phone, where a 1.6 bed leaves the fan a 60 px strip.
  aspect: 1.6,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_GAMES },
  create,
};
