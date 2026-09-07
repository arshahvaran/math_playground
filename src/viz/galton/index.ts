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

/** Histogram bars sit under the pile; translucent so the dots stay the data. */
const BAR_ALPHA = 0.35;

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
    help: 'Draw N(n·p, n·p·(1−p)) — the curve de Moivre found as the limit of this pile — at the scale of the finished pile.',
  },
  {
    kind: 'toggle',
    key: 'showBinomial',
    label: 'Binomial bars',
    default: false,
    help: 'Mark the exact expected count in each bin, balls · C(n,k) · pᵏ(1−p)ⁿ⁻ᵏ.',
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
    caption: 'Ten thousand balls fill in the bell, and a normal curve drawn from nothing but n·p and n·p·(1−p) sits on the pile.',
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
    text:
      'The number of routes to bin k is the binomial coefficient C(n, k): the board is Pascal’s triangle with a ball ' +
      'rolling down it, and at p = ½ each pile is that coefficient out of 2ⁿ.',
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

function simParams(values: ParamValues): GaltonParams {
  return {
    rows: num(values, 'rows', DEFAULT_ROWS),
    p: num(values, 'p', DEFAULT_P),
    balls: num(values, 'balls', DEFAULT_BALLS),
    dropRate: num(values, 'dropRate', DEFAULT_DROP_RATE),
  };
}

/**
 * `#rgb`, `#rrggbb` or `#rrggbbaa` → `rgba(r, g, b, alpha)`. Theme colours
 * arrive as hex; anything else comes back untouched, so an unexpected
 * `rgb(…)` degrades to an opaque fill rather than an invalid one.
 */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1] ?? '';
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * How the pile is drawn, fixed for a run so bars, dots and overlays share one
 * vertical scale.
 *
 * Resting balls sit in a grid of `cols` per row at a pitch of 2·radius, so a
 * pile of c balls is c·(2·radius/cols) px tall — that is `unit`, and it is
 * also the height of the histogram bar and the scale of the theoretical
 * overlays. The radius is chosen so the expected tallest pile fills the bin
 * depth with HEADROOM to spare, and never exceeds the in-flight ball size.
 */
interface Pile {
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

function pileMetrics(g: BoardGeometry, p: number, balls: number, particleRadius: number): Pile {
  const rows = g.rows;
  const expected = new Float64Array(rows + 1);
  let pmax = 0;
  for (let k = 0; k <= rows; k++) {
    const q = binomialPmf(rows, k, p);
    expected[k] = balls * q;
    if (q > pmax) pmax = q;
  }
  const tallest = Math.max(1, balls * pmax * HEADROOM);
  const area = Math.max(1, g.pegSpacing * (g.binBottom - g.binTop));
  // A c-ball pile occupies c·(2r)² of bin area, so r = ½·√(area / tallest) fills it exactly.
  let radius = 0.5 * Math.sqrt(area / tallest);
  radius = Math.min(particleRadius, Math.max(0.5, radius));
  const cols = Math.max(1, Math.floor(g.pegSpacing / (2 * radius)));
  return {
    radius,
    cols,
    unit: (2 * radius) / cols,
    cap: Math.max(1, Math.floor(DOT_BUDGET / (rows + 1))),
    expected,
    mu: rows * p,
    sigma: Math.sqrt(rows * p * (1 - p)),
  };
}

function create(ctx: VizContext): VizInstance {
  const sim = createSim(ctx.rng, simParams(ctx.params), MAX_BALLS);

  let geometry = layoutBoard(ctx.width, ctx.height, sim.rows);
  let pile = pileMetrics(geometry, DEFAULT_P, DEFAULT_BALLS, ctx.theme.particleRadius);

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
    geometry = layoutBoard(ctx.width, ctx.height, sim.rows);
    const sp = simParams(ctx.params);
    pile = pileMetrics(geometry, sp.p, Math.min(MAX_BALLS, sp.balls), ctx.theme.particleRadius);
  }

  /** Resting place of the ball that arrived `stack`-th in bin `k`. */
  function restX(k: number, stack: number): number {
    return binCentreX(geometry, k) + (2 * (stack % pile.cols) + 1 - pile.cols) * pile.radius;
  }
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
      { key: 'mean', label: 'Mean bin', value: mean, target: rows * p },
      { key: 'variance', label: 'Variance', value: variance, target: rows * p * (1 - p) },
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

      // Bin dividers and floor. An odd-width line centred on a half-pixel
      // covers whole device pixels at DPR 1; on an integer it smears across two.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const half = g.pegSpacing / 2;
      const left = binCentreX(g, 0) - half;
      const right = binCentreX(g, rows) + half;
      bg.strokeStyle = theme.grid;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (let k = 0; k <= rows + 1; k++) {
        const x = Math.round(left + k * g.pegSpacing) + snap;
        bg.moveTo(x, g.binTop);
        bg.lineTo(x, g.binBottom);
      }
      const floor = Math.round(g.binBottom) + snap;
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
        bg.fillText(String(k), binCentreX(g, k), g.binBottom + 5);
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

      // Histogram bars under the pile. Same `unit` as the dots, so a bar is
      // exactly as tall as the pile it sits behind and carries on above the
      // dot cap without a seam.
      fg.fillStyle = withAlpha(theme.data3, BAR_ALPHA);
      let tallest = 0;
      let mode = 0;
      for (let k = 0; k <= rows; k++) {
        const c = bins[k] ?? 0;
        if (c > tallest) {
          tallest = c;
          mode = k;
        }
        if (c === 0) continue;
        const h = Math.min(depth, c * pile.unit);
        fg.fillRect(binCentreX(g, k) - half, g.binBottom - h, g.pegSpacing, h);
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

      if (showBinomial) {
        fg.strokeStyle = theme.data3;
        fg.lineWidth = theme.lineWidth;
        fg.beginPath();
        for (let k = 0; k <= rows; k++) {
          const h = Math.min(depth, (pile.expected[k] ?? 0) * pile.unit);
          const y = g.binBottom - h;
          const cx = binCentreX(g, k);
          fg.moveTo(cx - 0.35 * g.pegSpacing, y);
          fg.lineTo(cx + 0.35 * g.pegSpacing, y);
        }
        fg.stroke();
      }

      // p = 0 or 1 is a point mass; there is no curve to draw.
      if (showNormal && pile.sigma > 0) {
        const balls = num(ctx.params, 'balls', DEFAULT_BALLS);
        const left = binCentreX(g, 0) - half;
        const right = binCentreX(g, rows) + half;
        fg.strokeStyle = theme.data2;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'round';
        fg.beginPath();
        for (let px = left; px <= right; px += 2) {
          // Continuous bin coordinate; a unit-width bin at u expects balls · pdf(u) landings.
          const u = (px - g.originX) / g.pegSpacing + rows / 2;
          const h = Math.min(depth, balls * normalPdf(u, pile.mu, pile.sigma) * pile.unit);
          fg.lineTo(px, g.binBottom - h);
        }
        fg.stroke();
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
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_BALLS },
  create,
};
