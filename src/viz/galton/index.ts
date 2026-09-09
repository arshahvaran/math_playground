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
  type BoardGeometry,
  type GaltonParams,
} from './sim';

/** Hard ceiling on balls; the `balls` slider tops out here too. */
const MAX_BALLS = 20_000;

const DEFAULT_ROWS = 12;
const DEFAULT_P = 0.5;
const DEFAULT_BALLS = 2_000;
const DEFAULT_DROP_RATE = 40;
const DEFAULT_SEED = 42;

/**
 * Alpha removed from the foreground each frame when trails are on. A trail
 * outlives its ball by roughly 1/TRAIL_FADE frames. Canvas alpha is 8-bit and
 * a·(1 − 0.1) rounds back to a below about 5/255, so old trails bottom out at
 * ~2% opacity rather than vanishing — faint enough to read as ghosts, not dirt.
 */
const TRAIL_FADE = 0.1;

/**
 * Length of the floor tick under each bin edge, CSS px.
 *
 * A histogram needs a baseline and a scale, not a grid of cells: full-height
 * dividers boxed every bin and cut the distribution into strips. The ticks hang
 * below the floor, where the pile can never cover them and where they read as
 * the axis furniture they are.
 */
const BIN_TICK = 4;

/** Gap between the floor ticks and the bin index numerals, CSS px. */
const LABEL_GAP = 3;

/**
 * Most resting balls drawn as individual dots per frame, across all bins. A
 * tall pile is drawn as dots up to its share of this and as a bar above that.
 * Four thousand small arcs in one path is about a millisecond; twenty
 * thousand would be most of the frame budget for a pile that never moves.
 */
const DOT_BUDGET = 4_000;

/**
 * Room above the expected tallest pile, as a factor. The tallest bin count
 * fluctuates about balls·pmax with standard deviation √(balls·pmax(1−pmax)) —
 * under 2% of the expectation at 20,000 balls — so the pile stays inside the
 * bin and the normal overlay keeps a margin under the peg rows.
 */
const HEADROOM = 1.15;

const TAU = 2 * Math.PI;

const params: readonly ParamSpec[] = [
  {
    kind: 'int',
    key: 'rows',
    label: 'Rows',
    min: 3,
    max: MAX_ROWS,
    default: DEFAULT_ROWS,
    help: 'Peg rows. Each ball makes one left-or-right choice per row, so there are rows + 1 bins.',
  },
  {
    kind: 'range',
    key: 'p',
    label: 'Bias',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_P,
    help: 'Probability of going right at a peg. ½ is a fair coin.',
  },
  {
    kind: 'range',
    key: 'balls',
    label: 'Balls',
    min: 1,
    max: MAX_BALLS,
    step: 1,
    default: DEFAULT_BALLS,
    log: true,
    help: 'Balls released before the stream stops.',
  },
  {
    kind: 'range',
    key: 'dropRate',
    label: 'Drop rate',
    min: 1,
    max: 400,
    step: 1,
    default: DEFAULT_DROP_RATE,
    unit: '/s',
    help: 'Balls released per second of simulation time. Changes take effect without restarting.',
  },
  {
    kind: 'toggle',
    key: 'showNormal',
    label: 'Normal overlay',
    default: true,
    help: [
      'Draw N(', { v: 'n' }, '·', { v: 'p' }, ', ', { v: 'n' }, '·', { v: 'p' }, '·(1−', { v: 'p' }, ')) ',
      '— the curve de Moivre found as the limit of this pile — at the scale of the finished pile.',
    ],
  },
  {
    kind: 'toggle',
    key: 'showBinomial',
    label: 'Binomial bars',
    default: false,
    help: [
      'Mark the exact expected count in each bin, balls · C(', { v: 'n' }, ',', { v: 'k' }, ') · ',
      { v: 'p' }, 'ᵏ(1−', { v: 'p' }, ')ⁿ⁻ᵏ.',
    ],
  },
  {
    kind: 'toggle',
    key: 'showTrails',
    label: 'Trails',
    default: true,
    help: 'Let each ball leave a fading trace of its route.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Same seed, same routes, same pile.',
  },
];

const presets: readonly Preset[] = [
  {
    id: 'one-ball',
    label: 'One ball',
    caption: 'One ball, one route: a coin decides left or right at every peg, and the bin it reaches is the number of rights.',
    values: { rows: 12, p: 0.5, balls: 1, dropRate: 1, showNormal: false, showBinomial: false },
  },
  {
    id: 'a-hundred',
    label: 'A hundred',
    caption: 'A hundred balls already crowd the middle: 924 routes lead to the centre bin and a single route to each edge.',
    values: { rows: 12, p: 0.5, balls: 100, dropRate: 40, showNormal: false, showBinomial: false },
  },
  {
    id: 'ten-thousand',
    label: 'Ten thousand',
    caption: [
      'Ten thousand balls fill in the bell, and a normal curve drawn from nothing but ',
      { v: 'n' }, '·', { v: 'p' }, ' and ', { v: 'n' }, '·', { v: 'p' }, '·(1−', { v: 'p' }, ') sits on the pile.',
    ],
    values: { rows: 12, p: 0.5, balls: 10_000, dropRate: 400, showNormal: true, showBinomial: false },
  },
  {
    id: 'bias',
    label: 'Bias it',
    caption: 'Weight every peg 70:30 and the whole bell slides right without losing its shape — the curve was never about fairness.',
    values: { rows: 12, p: 0.7, balls: 10_000, dropRate: 400, showNormal: true, showBinomial: false },
  },
  {
    id: 'three-rows',
    label: 'Three rows',
    caption: 'Three rows give a triangle in the ratio 1 : 3 : 3 : 1 — a row of Pascal’s triangle, not yet a bell.',
    values: { rows: 3, p: 0.5, balls: 5_000, dropRate: 400, showNormal: false, showBinomial: true },
  },
  {
    id: 'twenty-rows',
    label: 'Twenty rows',
    caption: 'Twenty rows and twenty thousand balls: the binomial marks and the normal curve are now indistinguishable.',
    values: { rows: 20, p: 0.5, balls: 20_000, dropRate: 400, showNormal: true, showBinomial: true },
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

function flag(values: ParamValues, key: string, fallback: boolean): boolean {
  const v = values[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Balls this run will drop, clamped the way the sim clamps its own target. */
function ballTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_BALLS, Math.floor(num(values, 'balls', DEFAULT_BALLS))));
}

function simParams(values: ParamValues): GaltonParams {
  return {
    rows: num(values, 'rows', DEFAULT_ROWS),
    p: num(values, 'p', DEFAULT_P),
    balls: num(values, 'balls', DEFAULT_BALLS),
    dropRate: num(values, 'dropRate', DEFAULT_DROP_RATE),
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
  // the bars sawed the top off the curve. Not conditioned on `showNormal`: that
  // toggle is absorbed live, and a scale that moved with it would rescale the
  // whole histogram under a cosmetic switch.
  const peak = sigma > 0 ? Math.max(pmax, normalPdf(mu, mu, sigma)) : pmax;
  const tallest = Math.max(1, balls * peak * HEADROOM);
  const depth = Math.max(1, g.binBottom - g.binTop);
  const area = Math.max(1, g.pegSpacing * depth);
  // A c-ball pile occupies c·(2r)² of bin area, so r = ½·√(area / tallest) fills it exactly.
  let radius = 0.5 * Math.sqrt(area / tallest);
  radius = Math.min(particleRadius, Math.max(0.5, radius));
  const cols = Math.max(1, Math.floor(g.pegSpacing / (2 * radius)));
  // The dot pitch 2r/cols is the area derivation only while the radius is the
  // one it produced. Clamping r — up to the 0.5 px floor at twenty rows and
  // twenty thousand balls, down to the in-flight ball size on a large plate —
  // makes that pitch disagree with depth/tallest, which is the scale that puts
  // the expected tallest pile at depth/HEADROOM by construction. Take the
  // smaller of the two and then lay the dot grid out from it rather than the
  // other way round: a row of `cols` dots is cols·unit tall, so the dot is half
  // that. Drawing the dots at their own pitch instead stood a tail pile at up
  // to 2.5× the height of the bar, the silhouette and the marks that measure
  // the same balls, and sent an arriving ball to a resting place tens of pixels
  // above its own bar. The seam where the bar takes over from the dots is now
  // the partial top row, at most one dot high.
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
  let pile = pileMetrics(geometry, DEFAULT_P, DEFAULT_BALLS, ctx.theme.particleRadius);

  // This frame's bar heights, so the wash and its silhouette cannot disagree by
  // a pixel. Allocated once at the row ceiling rather than per frame.
  const barH = new Float64Array(MAX_ROWS + 1);

  // Cosmetic parameters, absorbed live.
  let showNormal = true;
  let showBinomial = false;
  let showTrails = true;

  function syncLive(): void {
    showNormal = flag(ctx.params, 'showNormal', true);
    showBinomial = flag(ctx.params, 'showBinomial', false);
    showTrails = flag(ctx.params, 'showTrails', true);
  }

  function syncLayout(): void {
    // From the parameters, not from the sim: the contract does not fix whether
    // the shell calls drawBackground() or reset() first after a row change, and
    // sim.rows only moves inside reset(). layoutBoard clamps rows the same way
    // the sim does, so the two agree once reset() has run either way.
    const sp = simParams(ctx.params);
    geometry = layoutBoard(ctx.width, ctx.height, sp.rows);
    pile = pileMetrics(geometry, sp.p, ballTarget(ctx.params), ctx.theme.particleRadius);
  }

  /** Resting place of the ball that arrived `stack`-th in bin `k`. */
  function restX(k: number, stack: number): number {
    return binCentreX(geometry, k) + (2 * (stack % pile.cols) + 1 - pile.cols) * pile.radius;
  }
  /** Rows of dots are 2·radius apart, which is cols·unit: the pile stands on the same scale as its bar. */
  function restY(stack: number): number {
    const r = pile.radius;
    return Math.max(geometry.binTop + r, geometry.binBottom - r - Math.floor(stack / pile.cols) * 2 * r);
  }

  function readouts(tallest: number, mode: number): Readout[] {
    const { mean, variance } = sim.stats();
    const rows = sim.rows;
    const p = num(ctx.params, 'p', DEFAULT_P);
    return [
      { key: 'landed', label: 'Balls landed', value: sim.landed, digits: 6 },
      // §5: the hero prints "analytic" and the closed form the target came
      // from. n is the row count, p the bias — both italic, both variables.
      {
        key: 'mean',
        label: 'Mean bin',
        value: mean,
        target: rows * p,
        formula: [{ v: 'n' }, '·', { v: 'p' }],
      },
      {
        key: 'variance',
        label: 'Variance',
        value: variance,
        target: rows * p * (1 - p),
        // A variance is a noisier estimator than a mean, and the ledger's 1%
        // default is the wrong bet for it: the sample variance of n bin indices
        // has standard error √((μ₄ − σ⁴)/n), which for a distribution close to
        // normal is σ²·√(2/n) — a relative error of √(2/n), 3.2% at the
        // 2,000-ball default, so a finished and statistically perfect run read
        // "not yet converged" for most seeds. Three of those standard errors,
        // measured at the ball count the run is going to reach rather than at
        // the count so far, so the row still starts off and arrives at agreement
        // as the balls come down instead of being true from the first landing.
        tolerance: 3 * Math.sqrt(2 / ballTarget(ctx.params)),
      },
      { key: 'tallest', label: 'Tallest bin', value: tallest, digits: 6 },
      { key: 'mode', label: 'Tallest bin index', value: mode, digits: 2 },
      { key: 'bins', label: 'Bins', value: rows + 1, digits: 2 },
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

      // Pegs: one path, one fill. 210 arcs at twenty rows.
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

      // Floor and bin ticks. These contain the experiment rather than being part
      // of it, so they take the container pen, not the peg pen — the pegs are
      // the only near-black geometry on the plate. An odd-width line centred on
      // a half-pixel covers whole device pixels at DPR 1; on an integer it
      // smears across two.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const half = g.pegSpacing / 2;
      const left = binCentreX(g, 0) - half;
      const right = binCentreX(g, rows) + half;
      const floor = Math.round(g.binBottom) + snap;
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (let k = 0; k <= rows + 1; k++) {
        const x = Math.round(left + k * g.pegSpacing) + snap;
        bg.moveTo(x, floor);
        bg.lineTo(x, floor + BIN_TICK);
      }
      bg.moveTo(left, floor);
      bg.lineTo(right, floor);
      bg.stroke();

      // Bin indices. Narrow bins take every other label so "10" and "11" do not collide.
      const every = g.pegSpacing >= 18 ? 1 : 2;
      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;
      bg.textAlign = 'center';
      bg.textBaseline = 'top';
      for (let k = 0; k <= rows; k += every) {
        bg.fillText(String(k), binCentreX(g, k), g.binBottom + BIN_TICK + LABEL_GAP);
      }
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const g = geometry;
      const rows = sim.rows;
      const bins = sim.bins;
      const settled = sim.settledBins;

      if (showTrails && !ctx.reducedMotion) {
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
      // layer from the frame before: a toggled-off overlay would ghost for a few
      // dozen frames, and the curve would smear a band as wide as its own
      // travel. Trails still live in the peg region above.
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
      const R = theme.particleRadius;
      sim.forEachActive((b) => {
        let x: number;
        let y: number;
        if (b.y < rows) {
          x = lateralToPx(g, b.x);
          y = progressToPy(g, b.y);
        } else {
          // Settling: from the bin mouth to the resting place, accelerating.
          const cx = binCentreX(g, b.bin);
          const t = Math.min(1, b.y - rows);
          const e = t * t;
          x = cx + (restX(b.bin, b.stack) - cx) * e;
          y = g.binTop + (restY(b.stack) - g.binTop) * e;
        }
        fg.moveTo(x + R, y);
        fg.arc(x, y, R, 0, TAU);
      });
      fg.fill();

      if (tallest > 0) {
        // The silhouette goes on last, over the wash and the dots both: it is
        // the mark that carries the shape, so nothing may paint over it. One
        // stepped outline across the whole band, where fourteen full-height
        // dividers used to be a cage — the risers between bins belong to the
        // outline. Its ends drop to the floor, which the floor line already
        // draws, so the base needs no stroke of its own.
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
      if (showBinomial) {
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
      if (showNormal && pile.sigma > 0) {
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

    onParamChange(key, value) {
      switch (key) {
        case 'showNormal':
          showNormal = value === true;
          return true;
        case 'showBinomial':
          showBinomial = value === true;
          return true;
        case 'showTrails':
          showTrails = value === true;
          return true;
        case 'dropRate':
          sim.setParams({ ...simParams(ctx.params), dropRate: asNumber(value, DEFAULT_DROP_RATE) });
          return true;
        default:
          // rows, p, balls, seed: the balls already down belong to a different
          // experiment, so the shell resets.
          return false;
      }
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      sim.setParams(simParams(ctx.params));
      sim.reset();
      syncLive();
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
  blurb: 'Drops balls through a staggered lattice of pegs, one coin flip per row, and piles up the binomial distribution.',
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
