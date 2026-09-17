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
import { binomialPmf, normalPdf } from '../../core/stats';
import {
  MAX_ROWS,
  binCentreX,
  createSim,
  lateralToPx,
  layoutBoard,
  pegPosition,
  progressToPy,
  restSlot,
  type BoardGeometry,
  type GaltonParams,
} from './sim';

/** Hard ceiling on balls; the `balls` slider tops out here too. */
const MAX_BALLS = 5_000;

/**
 * Most rows the control offers. The simulation packs routes into 32-bit
 * masks and takes twenty; sixteen is where the bins are still wide enough on
 * a phone to read their index, and where the bell is already indistinguishable
 * from the curve drawn over it.
 */
const ROWS_MAX = 16;

const DEFAULT_ROWS = 12;
const DEFAULT_BALLS = 500;
const DEFAULT_SEED = 42;

/**
 * Grain of the Balls fader. One ball at a time is a fader nobody can drive:
 * a pile only changes shape by the hundred, and 5,000 steps of travel is
 * 5,000 chances to restart a run by a pixel.
 */
const BALLS_STEP = 50;

/**
 * Probability of going right at a peg. Not a control: the tool is for
 * students meeting the bell for the first time, and a fair coin is the
 * experiment. The simulation and the targets below stay general in `p` so
 * the mathematics is still there if it is ever wanted back.
 */
const BIAS = 0.5;

/**
 * The stream is paced so a run takes about this long whatever the ball
 * count, between a floor that keeps a handful of balls from trickling and a
 * ceiling that keeps five thousand from becoming a blur.
 */
const RUN_SECONDS = 12;
const MIN_DROP_RATE = 2;
const MAX_DROP_RATE = 400;

/**
 * What is drawn over the pile. These were controls; they are fixed now, with
 * the code paths kept: the curve is the lesson, the exact binomial marks are
 * a second thing to explain, and the trails are what makes the motion legible.
 */
const SHOW_NORMAL: boolean = true;
const SHOW_BINOMIAL: boolean = false;
const SHOW_TRAILS: boolean = true;

/**
 * Alpha removed from the foreground each frame when trails are on. A trail
 * outlives its ball by roughly 1/TRAIL_FADE frames. Canvas alpha is 8-bit and
 * a·(1 − 0.1) rounds back to a below about 5/255, so old trails bottom out at
 * ~2% opacity rather than vanishing — faint enough to read as ghosts, not dirt.
 */
const TRAIL_FADE = 0.1;

/**
 * Length of the axis tick under the floor, one per whole standard deviation,
 * CSS px.
 *
 * The ticks hang below the floor of the case, where the pile can never cover
 * them and where they read as the axis furniture they are. The partitions
 * between the bins are a different mark and live above the floor, inside the
 * case, under the pile.
 */
const BIN_TICK = 4;

/** Gap between the axis ticks and the axis numerals, CSS px. */
const LABEL_GAP = 3;

/**
 * Most resting balls drawn as individual dots per frame, across all bins. A
 * tall pile is drawn as dots up to its share of this and as a bar above that.
 * Four thousand small arcs in one path is about a millisecond.
 */
const DOT_BUDGET = 4_000;

/**
 * Room above the expected tallest pile, as a factor. The tallest bin count
 * fluctuates about balls·pmax with standard deviation √(balls·pmax(1−pmax)) —
 * under 4% of the expectation at 5,000 balls — so the pile stays inside the
 * bin and the normal overlay keeps a margin under the peg rows.
 */
const HEADROOM = 1.15;

/**
 * How far a ball deforms at the instant of a contact, as a fraction added to
 * its radius along the direction of travel and taken off across it. Area is
 * preserved, so the ball does not appear to grow. A third is enough to read at
 * a 3 px radius and small enough that the ball never stops being a ball.
 */
const SQUASH = 0.34;

const TAU = 2 * Math.PI;

const params: readonly ParamSpec[] = [
  {
    kind: 'int',
    key: 'rows',
    label: 'Rows',
    min: 3,
    max: ROWS_MAX,
    default: DEFAULT_ROWS,
    help: 'Peg rows. Each ball makes one left-or-right choice per row, so there are rows + 1 bins.',
  },
  {
    kind: 'range',
    key: 'balls',
    label: 'Balls',
    // Fifty at a time. A range parameter lives on one grid — `min + k·step`,
    // and `core/grid.ts` is the only definition of it — so a step of 50 from a
    // minimum of 1 would put the reachable counts at 1, 51, 101 … and a
    // permalink asking for 100 balls would quietly run 101. The minimum is 50
    // instead, which keeps the round hundreds every shared link and every
    // preset is written in.
    //
    // The "One ball" preset is below that floor on purpose: a preset writes
    // its values straight into the parameters, so the board really does drop
    // exactly one ball, and the fader shows its own floor while it does.
    min: BALLS_STEP,
    max: MAX_BALLS,
    step: BALLS_STEP,
    default: DEFAULT_BALLS,
    log: true,
    help: 'Balls released before the stream stops, fifty at a time.',
  },
  // Not a control: the rail skips seed specs, and "the same experiment,
  // another draw" is the transport's Shuffle key. It is declared all the same
  // because coerceParams() only reads a permalink key that has a spec —
  // without it `?seed=7` is dropped on the way in and every shared link
  // replays the default run.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'one-ball',
    label: 'One ball',
    caption: 'One ball, one route: a coin decides left or right at every peg, and the bin it reaches is the number of rights.',
    values: { rows: 12, balls: 1 },
  },
  {
    id: 'a-hundred',
    label: 'A hundred',
    caption: 'A hundred balls already crowd the middle: 924 routes lead to the centre bin and a single route to each edge.',
    values: { rows: 12, balls: 100 },
  },
  {
    id: 'five-thousand',
    label: 'Five thousand',
    caption: [
      'Five thousand balls fill in the bell, and a normal curve drawn from nothing but ',
      { v: 'n' }, '·', { v: 'p' }, ' and ', { v: 'n' }, '·', { v: 'p' }, '·(1−', { v: 'p' }, ') sits on the pile.',
    ],
    values: { rows: 12, balls: 5_000 },
  },
  {
    id: 'three-rows',
    label: 'Three rows',
    caption: 'Three rows give a triangle in the ratio 1 : 3 : 3 : 1 — a row of Pascal’s triangle, not yet a bell.',
    values: { rows: 3, balls: 5_000 },
  },
  {
    id: 'sixteen-rows',
    label: 'Sixteen rows',
    caption: 'Sixteen rows and five thousand balls: the pile and the curve drawn over it are now hard to tell apart.',
    values: { rows: 16, balls: 5_000 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Galton called the board a quincunx, after the five-dot pattern of its pegs, and in Natural Inheritance (1889) ' +
      'ran balls through a two-stage version to argue that heredity, reshuffling a bell-shaped population every ' +
      'generation, hands on a population that is still bell-shaped.',
    source: {
      label: 'Galton, Natural Inheritance (1889), ch. V, “Normal Variability”',
      url: 'https://galton.org/books/natural-inheritance/',
    },
  },
  {
    text:
      'Abraham de Moivre derived the bell curve in 1733 as the limiting shape of exactly this pile — the binomial ' +
      'for many coin flips — seventy-six years before Gauss attached his name to it.',
    source: {
      label: 'de Moivre, Approximatio ad summam terminorum binomii (a+b)ⁿ in seriem expansi (1733); De Moivre–Laplace theorem',
      url: 'https://en.wikipedia.org/wiki/De_Moivre%E2%80%93Laplace_theorem',
    },
  },
  {
    text: [
      'The number of routes to bin ', { v: 'k' }, ' is the binomial coefficient C(', { v: 'n' }, ', ', { v: 'k' }, '): ',
      'the board is Pascal’s triangle with a ball rolling down it, and at ', { v: 'p' }, ' = ½ each pile is ',
      'that coefficient out of 2ⁿ.',
    ],
    source: {
      label: 'Wikipedia, Galton board',
      url: 'https://en.wikipedia.org/wiki/Galton_board',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** Balls this run will drop, clamped the way the sim clamps its own target. */
function ballTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_BALLS, Math.floor(num(values, 'balls', DEFAULT_BALLS))));
}

/** Balls per second that finish a run of `balls` in about RUN_SECONDS. */
export function dropRateFor(balls: number): number {
  return Math.min(MAX_DROP_RATE, Math.max(MIN_DROP_RATE, balls / RUN_SECONDS));
}

function simParams(values: ParamValues): GaltonParams {
  const balls = ballTarget(values);
  return {
    rows: num(values, 'rows', DEFAULT_ROWS),
    p: BIAS,
    balls,
    dropRate: dropRateFor(balls),
  };
}

/**
 * How the pile is drawn, fixed for a run so bars, dots and overlays share one
 * vertical scale.
 *
 * `unit` is that scale: pixels of pile height per ball, and equally the height
 * of the histogram bar, the binomial mark and the normal curve. Resting balls
 * sit in a grid of `cols` per row, so a row of dots stands cols·unit tall and
 * the dot is drawn at half of that — a pile of c balls is c·unit tall however
 * it is drawn. The scale is the smaller of what dots of the derived radius
 * occupy and what the bin depth allows the expected tallest pile.
 */
interface Pile {
  /** Drawn radius of a resting dot, cols·unit/2. Never exceeds an in-flight ball. */
  radius: number;
  cols: number;
  /** Pixels of pile height per ball. */
  unit: number;
  /** Dots drawn per bin before the bar alone carries the count. */
  cap: number;
  /** Expected landings per bin, balls · pmf(k). */
  expected: Float64Array;
  mu: number;
  sigma: number;
}

export function pileMetrics(g: BoardGeometry, p: number, balls: number, particleRadius: number): Pile {
  const rows = g.rows;
  const expected = new Float64Array(rows + 1);
  let pmax = 0;
  for (let k = 0; k <= rows; k++) {
    const q = binomialPmf(rows, k, p);
    expected[k] = balls * q;
    if (q > pmax) pmax = q;
  }
  const mu = rows * p;
  const sigma = Math.sqrt(rows * p * (1 - p));
  // Reserve the headroom against the tallest mark that is actually painted, not
  // against the binomial mode alone. The overlay peaks at balls·pdf(μ) =
  // balls/(σ√2π), and below about five rows that density is the larger of the
  // two — 0.4606 against a mode of 0.375 at three rows — so headroom bought for
  // the bars sawed the top off the curve.
  const peak = sigma > 0 ? Math.max(pmax, normalPdf(mu, mu, sigma)) : pmax;
  const tallest = Math.max(1, balls * peak * HEADROOM);
  const depth = Math.max(1, g.binBottom - g.binTop);
  const area = Math.max(1, g.pegSpacing * depth);
  // A c-ball pile occupies c·(2r)² of bin area, so r = ½·√(area / tallest) fills it exactly.
  let radius = 0.5 * Math.sqrt(area / tallest);
  radius = Math.min(particleRadius, Math.max(0.5, radius));
  const cols = Math.max(1, Math.floor(g.pegSpacing / (2 * radius)));
  // The dot pitch 2r/cols is the area derivation only while the radius is the
  // one it produced. Clamping r — up to the 0.5 px floor, down to the
  // in-flight ball size on a large plate — makes that pitch disagree with
  // depth/tallest, which is the scale that puts the expected tallest pile at
  // depth/HEADROOM by construction. Take the smaller of the two and then lay
  // the dot grid out from it rather than the other way round: a row of `cols`
  // dots is cols·unit tall, so the dot is half that. Drawing the dots at their
  // own pitch instead stood a tail pile at up to 2.5× the height of the bar,
  // the silhouette and the marks that measure the same balls, and sent an
  // arriving ball to a resting place tens of pixels above its own bar. The
  // seam where the bar takes over from the dots is now the partial top row,
  // at most one dot high.
  const unit = Math.min((2 * radius) / cols, depth / tallest);
  return {
    radius: (cols * unit) / 2,
    cols,
    unit,
    cap: Math.max(1, Math.floor(DOT_BUDGET / (rows + 1))),
    expected,
    mu,
    sigma,
  };
}

function create(ctx: VizContext): VizInstance {
  const sim = createSim(ctx.rng, simParams(ctx.params), MAX_BALLS);

  let geometry = layoutBoard(ctx.width, ctx.height, sim.rows);
  let pile = pileMetrics(geometry, BIAS, DEFAULT_BALLS, ctx.theme.particleRadius);

  // This frame's bar heights, so the wash and its silhouette cannot disagree by
  // a pixel. Allocated once at the row ceiling rather than per frame.
  const barH = new Float64Array(MAX_ROWS + 1);

  function syncLayout(): void {
    // From the parameters, not from the sim: the contract does not fix whether
    // the shell calls drawBackground() or reset() first after a row change, and
    // sim.rows only moves inside reset(). layoutBoard clamps rows the same way
    // the sim does, so the two agree once reset() has run either way.
    const sp = simParams(ctx.params);
    geometry = layoutBoard(ctx.width, ctx.height, sp.rows);
    pile = pileMetrics(geometry, sp.p, ballTarget(ctx.params), ctx.theme.particleRadius);
    // The physics needs the plate: the pitch sets its length and time scale,
    // the peg and ball radii say where a strike happens, and the pile metrics
    // say where an arriving ball lands. Same numbers the pile is painted from.
    sim.setBoard({
      pitch: geometry.pegSpacing,
      contact: geometry.pegRadius + ctx.theme.particleRadius,
      binDepth: geometry.binBottom - geometry.binTop,
      dotRadius: pile.radius,
      cols: pile.cols,
    });
  }

  /** Resting place of the ball that arrived `stack`-th in bin `k`, CSS px. */
  function restX(k: number, stack: number): number {
    return binCentreX(geometry, k) + restSlot(pile.cols, pile.radius, geometry.binBottom - geometry.binTop, stack).dx;
  }
  function restY(stack: number): number {
    return geometry.binTop + restSlot(pile.cols, pile.radius, geometry.binBottom - geometry.binTop, stack).depth;
  }

  function readouts(tallest: number, mode: number): Readout[] {
    // `n` is the count behind both readings — the balls in the bins, not the
    // balls the fader asked for — and it is what the bands below are divided
    // by, so they shrink as the pile grows instead of being honest only on the
    // last frame of the run.
    const { mean, variance, n } = sim.stats();
    const rows = sim.rows;
    const meanTarget = rows * BIAS;
    const varianceTarget = rows * BIAS * (1 - BIAS);
    // The headline is the average landing spot in standard deviations from the
    // middle. One landing is Binomial(rows, p), so (k − n·p)/σ has mean 0 and
    // standard deviation exactly 1 — which is what makes the band below the
    // simplest one on the page, and the prediction exactly zero.
    const sigma = Math.sqrt(varianceTarget);
    const z = sigma > 0 ? (mean - meanTarget) / sigma : Number.NaN;
    // One ball is one route: it lands in one slot and the run is over. There is
    // no pile to have a shape, so the hero says so rather than leaving the
    // reader watching a sentence that is waiting for evidence that is never
    // coming. Taken from the run's target rather than from the count so far, so
    // it is fixed for the whole run and the hero's lines never move under it.
    const oneBall = ballTarget(ctx.params) === 1;
    return [
      { key: 'landed', label: 'Balls landed', value: sim.landed, digits: 6, plain: 'balls landed' },
      // §5: the hero prints "analytic" and the closed form the target came
      // from. n is the row count, p the bias — both italic, both variables.
      {
        key: 'mean',
        label: 'Mean landing, z',
        value: z,
        target: 0,
        digits: 3,
        formula: ['(mean − ', { v: 'n' }, '·', { v: 'p' }, ') / √(', { v: 'n' }, { v: 'p' }, '(1−', { v: 'p' }, '))'],
        plain: 'average landing spot, in standard deviations from the middle',
        headline: true,
        // In these units one ball carries exactly one standard deviation, so
        // three standard errors of the mean is 3/√n and the ledger does the
        // division from the balls that have actually landed. That is the same
        // claim the raw mean used to make — 3·√(n·p(1−p))/√n bins, 3.87 % of
        // the prediction at the defaults — written in the units the reader is
        // now shown, and it still narrows as the pile grows.
        band: { kind: 'sampled', sigma: 1, samples: n },
        // A prediction of exactly zero is no scale at all, so the ledger has
        // nothing to judge the band against unless the reading says how far it
        // could ever travel. A landing is somewhere between the two edge
        // slots, which in these units is this: −n·p/σ to n·(1−p)/σ, ±3.46 on
        // the default twelve rows. Without it `readouts.ts` would correctly
        // refuse to give a verdict at all.
        range: sigma > 0 ? [-meanTarget / sigma, (rows - meanTarget) / sigma] : [-1, 1],
        ...(oneBall
          ? { hint: 'one ball lands in one slot, so there is no pile to have a shape — raise Balls to build one' }
          : {}),
      },
      {
        key: 'meanBin',
        label: 'Mean bin',
        value: mean,
        target: meanTarget,
        formula: [{ v: 'n' }, '·', { v: 'p' }],
        // The same measurement in bins, kept for the table: the z-score above
        // is this number minus n·p over σ, and a reader who wants the slot
        // rather than the standard deviation should not have to do it in their
        // head. Same band, in bins.
        band: { kind: 'sampled', sigma, samples: n },
        range: [0, rows],
        expertOnly: true,
      },
      {
        key: 'variance',
        label: 'Variance',
        value: variance,
        target: varianceTarget,
        // The sample variance of n slot indices has standard error
        // √((μ₄ − σ⁴)/n), which for a distribution this close to normal is
        // σ²·√(2/n): one observation carries σ²·√2, and the ledger divides by
        // the balls that have landed.
        //
        // Read at the ball count the run would *finish* on, that expression was
        // 424 % of the answer at the one-ball preset and 19 % at the default
        // 500 — a band wider than the quantity it judges certifies anything,
        // which is how this row agreed with its prediction at 100 % error. Read
        // at the count in hand it is 6.0 % even at the top of the fader, still
        // over the ledger's twentieth, so the row is a reading rather than a
        // test: a variance needs about 7,200 balls to be settled that closely
        // and MAX_BALLS is 5,000. The table still prints the measurement, the
        // prediction and the error between them; what it no longer prints is a
        // verdict the run cannot support.
        band: { kind: 'sampled', sigma: varianceTarget * Math.SQRT2, samples: n },
        plain: 'spread of the pile',
      },
      { key: 'tallest', label: 'Tallest bin', value: tallest, digits: 6, expertOnly: true },
      { key: 'mode', label: 'Tallest bin index', value: mode, digits: 2, expertOnly: true },
      { key: 'bins', label: 'Bins', value: rows + 1, digits: 2, expertOnly: true },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      sim.step(dt);
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the pegs.
      syncLayout();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      const g = geometry;
      const rows = g.rows;
      bg.clearRect(0, 0, width, height);

      // The case, the floor, the bin partitions and the axis all contain the
      // experiment rather than being part of it, so they take the container
      // pen; the pegs are the only near-black geometry on the plate (DESIGN
      // §7). An odd-width line centred on a half-pixel covers whole device
      // pixels at DPR 1; on an integer it smears across two, and an even-width
      // one is the other way round.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const frameWidth = 2 * theme.lineWidth;
      const frameSnap = frameWidth % 2 === 1 ? 0.5 : 0;
      const half = g.pegSpacing / 2;
      const left = Math.round(binCentreX(g, 0) - half);
      const right = Math.round(binCentreX(g, rows) + half);
      const floor = Math.round(g.binBottom);
      const mouth = Math.round(g.binTop) + snap;
      // A real board is a sealed case: glass front, two side walls, a floor.
      // Half a row pitch of head room above the release point is where the
      // hopper would sit, and `layoutBoard` always leaves at least that much.
      const lid = Math.round(Math.max(frameWidth, g.releaseY - g.rowSpacing / 2));

      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = frameWidth;
      bg.lineJoin = 'miter';
      bg.strokeRect(left + frameSnap, lid + frameSnap, right - left, floor - lid);

      // The partitions between the bins, rising from the floor to the mouth.
      // They are hairlines in the container pen and they are painted *under*
      // the pile: the opaque histogram wash covers them wherever there are
      // balls, so what a reader sees is a comb of empty compartments above the
      // pile, which is what a real board looks like — not the cage of
      // full-height rules DESIGN §7 rules out, which was a `--grid` mistake.
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (let k = 1; k <= rows; k++) {
        const x = Math.round(binCentreX(g, k) - half) + snap;
        bg.moveTo(x, mouth);
        bg.lineTo(x, floor);
      }
      bg.stroke();

      // Pegs, inside the case: one path, one fill. 136 arcs at sixteen rows.
      bg.fillStyle = theme.grid;
      bg.beginPath();
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i <= r; i++) {
          const { x, y } = pegPosition(g, r, i);
          bg.moveTo(x + g.pegRadius, y);
          bg.arc(x, y, g.pegRadius, 0, TAU);
        }
      }
      bg.fill();

      // The axis under the floor is the scale the headline is quoted in:
      // standard deviations from the middle, zero dead centre. Bin indices
      // would be a second scale for the same distance, and the one number the
      // page asks a reader to judge is the z-score.
      const sigma = Math.sqrt(sim.rows * BIAS * (1 - BIAS));
      if (sigma > 0) {
        const mu = sim.rows * BIAS;
        const zLo = -Math.floor(mu / sigma + 1e-9);
        const zHi = Math.floor((sim.rows - mu) / sigma + 1e-9);
        const zx = (z: number): number => binCentreX(g, mu + z * sigma);
        bg.strokeStyle = theme.gridSoft;
        bg.lineWidth = theme.lineWidth;
        bg.beginPath();
        for (let z = zLo; z <= zHi; z++) {
          const x = Math.round(zx(z)) + snap;
          bg.moveTo(x, floor);
          bg.lineTo(x, floor + BIN_TICK);
        }
        bg.stroke();

        // A signed numeral is two glyphs of Martian Mono; below about 26 px of
        // spacing they touch, so the odd ones step aside.
        const every = sigma * g.pegSpacing >= 26 ? 1 : 2;
        bg.font = theme.labelFont;
        bg.fillStyle = theme.inkMuted;
        bg.textAlign = 'center';
        bg.textBaseline = 'top';
        for (let z = zLo; z <= zHi; z++) {
          if (z !== 0 && Math.abs(z) % every !== 0) continue;
          bg.fillText(z === 0 ? '0' : z < 0 ? `−${-z}` : `+${z}`, zx(z), g.binBottom + BIN_TICK + LABEL_GAP);
        }
      }
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const g = geometry;
      const rows = sim.rows;
      const bins = sim.bins;
      const settled = sim.settledBins;

      if (SHOW_TRAILS && !ctx.reducedMotion) {
        // The foreground is a transparent layer over the pegs, so fading it
        // means removing alpha, not painting the canvas colour over it — that
        // would bury the background layer within a few dozen frames.
        fg.globalCompositeOperation = 'destination-out';
        fg.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
        fg.fillRect(0, 0, width, height);
        fg.globalCompositeOperation = 'source-over';
      } else {
        fg.clearRect(0, 0, width, height);
      }

      const depth = g.binBottom - g.binTop;
      const half = g.pegSpacing / 2;
      const bandLeft = binCentreX(g, 0) - half;
      const bandRight = binCentreX(g, rows) + half;

      // The bins are redrawn in full every frame — wash, silhouette, pile, marks
      // and curve are all clamped to `depth` — so clear the band rather than
      // fade it. Under a fade every one of those marks would still be on the
      // layer from the frame before, and the curve would smear a band as wide
      // as its own travel. Trails still live in the peg region above.
      // Three line widths of margin: the widest thing painted in the band is the
      // curve's halo at lineWidth + 4, which reaches three CSS px either side of
      // a path that runs along the band's own edge when the peak is clamped.
      const pad = 3 * theme.lineWidth;
      fg.clearRect(bandLeft - pad, g.binTop - pad, bandRight - bandLeft + 2 * pad, depth + 2 * pad);

      // The histogram is two marks, not one. An opaque graphite wash — never a
      // globalAlpha, which composites to a 1.47:1 ghost and leaves the whole
      // point of tab one as the least visible object on the page — that the
      // vermilion dots read against at 3.27:1, and then a full-opacity 2 px
      // silhouette that is the conformant graphical object carrying the bell's
      // shape, including above the dot cap where the dots stop and only the
      // wash used to be. Both sit on the same `unit` as the dots, so the bar
      // backs the pile it stands behind.
      fg.fillStyle = theme.data3Fill;
      let tallest = 0;
      let mode = 0;
      for (let k = 0; k <= rows; k++) {
        const c = bins[k] ?? 0;
        if (c > tallest) {
          tallest = c;
          mode = k;
        }
        const h = c === 0 ? 0 : Math.min(depth, c * pile.unit);
        barH[k] = h;
        if (h > 0) fg.fillRect(binCentreX(g, k) - half, g.binBottom - h, g.pegSpacing, h);
      }

      // Resting dots and moving balls share one colour, so one path and one fill.
      fg.fillStyle = theme.data1;
      fg.beginPath();
      const rd = pile.radius;
      for (let k = 0; k <= rows; k++) {
        const n = Math.min(settled[k] ?? 0, pile.cap);
        for (let s = 0; s < n; s++) {
          const x = restX(k, s);
          const y = restY(s);
          fg.moveTo(x + rd, y);
          fg.arc(x, y, rd, 0, TAU);
        }
      }
      // A moving ball is wherever the physics put it, in flight, in its bin
      // or bouncing on the pile: one mapping for all three, because the bin
      // continues the lattice's own vertical scale.
      //
      // A ball that has just hit something is drawn flattened across its
      // direction of travel and stretched along it, fading back to a circle
      // over the few frames `BallView.impact` takes to decay. Right after a
      // bounce the direction of travel *is* the contact normal, so the flat
      // face is the one that met the peg — which is what makes the collision
      // read as a collision rather than as a corner in a polyline. A round
      // ball takes the cheaper `arc`; only the handful in contact pay for an
      // ellipse, and both go in the same path and the same fill.
      const R = theme.particleRadius;
      sim.forEachActive((b) => {
        const x = lateralToPx(g, b.x);
        const y = progressToPy(g, b.y);
        const speed = Math.hypot(b.vx, b.vy);
        if (b.impact > 0 && speed > 0) {
          const stretch = 1 + SQUASH * b.impact;
          const rx = R * stretch;
          const ry = R / stretch;
          const angle = Math.atan2(b.vy, b.vx);
          fg.moveTo(x + rx * Math.cos(angle), y + rx * Math.sin(angle));
          fg.ellipse(x, y, rx, ry, angle, 0, TAU);
        } else {
          fg.moveTo(x + R, y);
          fg.arc(x, y, R, 0, TAU);
        }
      });
      fg.fill();

      if (tallest > 0) {
        // The silhouette goes on last, over the wash and the dots both: it is
        // the mark that carries the shape, so nothing may paint over it. One
        // stepped outline across the whole band — the risers between bins
        // belong to the outline. Its ends drop to the floor, which the floor
        // line already draws, so the base needs no stroke of its own.
        fg.strokeStyle = theme.data3;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'miter';
        fg.beginPath();
        fg.moveTo(bandLeft, g.binBottom);
        for (let k = 0; k <= rows; k++) {
          const y = g.binBottom - (barH[k] ?? 0);
          const cx = binCentreX(g, k);
          fg.lineTo(cx - half, y);
          fg.lineTo(cx + half, y);
        }
        fg.lineTo(bandRight, g.binBottom);
        fg.stroke();
      }

      // Expectation marks are thin marks, so they take the drafting pen at 2 px
      // — the graphite pen is the worst in the rack for the thinnest mark,
      // 1.51:1 where these land, on the wash. Each one sits on the pile it
      // measures, so each one takes the halo: +2 for a mark, +4 for a curve.
      if (SHOW_BINOMIAL) {
        fg.beginPath();
        for (let k = 0; k <= rows; k++) {
          const h = Math.min(depth, (pile.expected[k] ?? 0) * pile.unit);
          const y = g.binBottom - h;
          const cx = binCentreX(g, k);
          fg.moveTo(cx - 0.35 * g.pegSpacing, y);
          fg.lineTo(cx + 0.35 * g.pegSpacing, y);
        }
        strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth, 2);
      }

      // p = 0 or 1 is a point mass; there is no curve to draw.
      if (SHOW_NORMAL && pile.sigma > 0) {
        // The count the run will reach, which is what `pile.unit` reserved its
        // headroom for; the raw parameter can be an off-step permalink value.
        const balls = ballTarget(ctx.params);
        fg.lineJoin = 'round';
        fg.beginPath();
        for (let px = bandLeft; px <= bandRight; px += 2) {
          // Continuous bin coordinate; a unit-width bin at u expects balls · pdf(u) landings.
          const u = (px - g.originX) / g.pegSpacing + rows / 2;
          const h = Math.min(depth, balls * normalPdf(u, pile.mu, pile.sigma) * pile.unit);
          fg.lineTo(px, g.binBottom - h);
        }
        // The curve crosses its own histogram by construction, and the two pens
        // are 1.96:1 apart where it crosses the dots, so the plate colour goes
        // down first and they never touch.
        strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);
      }

      ctx.emit(readouts(tallest, mode));
    },

    onParamChange() {
      // Both controls are structural. A new row count is a new board; a new
      // ball count is a new pile scale, and the balls already down were laid
      // out on the old one. The shell resets.
      return false;
    },

    reset() {
      // The seed is not a control, but it still names the run: it arrives in
      // the parameters when the URL or the shell's shuffle carries one, and
      // the same seed replays the same routes and the same motion.
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      sim.setParams(simParams(ctx.params));
      sim.reset();
      syncLayout();
      // Trails fade rather than clear, so the previous run would linger for a
      // few dozen frames after a reset. Start clean instead.
      ctx.layers.foreground.clearRect(0, 0, ctx.width, ctx.height);
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const galton: Viz = {
  id: 'galton',
  title: 'Galton Board',
  group: 'randomness',
  blurb:
    'Balls fall through a grid of pegs, bouncing left or right at random. They pile up into a bell curve every ' +
    'single time — which is why so much of nature, from heights to measurement errors, ends up that shape.',
  // The board is taller than it is wide: layoutBoard() takes the smaller of the
  // width- and height-derived peg spacings, so on the default 1.6 bed the height
  // binds and half the plate is blank. Portrait again on a phone, where a
  // landscape bed leaves the lattice a strip with no room for the bins.
  aspect: 0.8,
  aspectNarrow: 0.75,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_BALLS },
  create,
};
