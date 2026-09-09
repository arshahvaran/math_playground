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
import { createCluster, type Cluster, type Lattice } from './cluster';

/** Hard ceiling on particles; the `particles` slider tops out here too. */
const MAX_PARTICLES = 50_000;

const DEFAULT_PARTICLES = 2_000;
const DEFAULT_STICKINESS = 1;
const DEFAULT_WALK_SPEED = 300;
const DEFAULT_LATTICE: Lattice = 'off';
const DEFAULT_SEED = 42;

/** The engine's tick. `walkSpeed` is quoted per tick, so the accumulator needs it. */
const TICK_MS = 1000 / 120;

/**
 * Witten and Sander's dimension, in two dimensions. It has no closed form —
 * it is a measured universal constant of the model, like the Feigenbaum δ two
 * tabs along — which is why the ledger row carries no formula.
 */
const ANALYTIC_D = 1.71;

/**
 * Relative tolerance on the dimension readout.
 *
 * A single finite cluster measures D to about ±0.03: that is the spread of the
 * fit across seven seeds at twenty thousand particles (1.698, 1.707, 1.717,
 * 1.747, 1.754, 1.758, 1.766 — mean 1.735, sd 0.027), and the fit's own
 * standard error corrected for the correlation between checkpoints agrees to
 * within a factor of two. Three of those is 0.09, which is 5% of 1.71. Anything
 * tighter would report a perfectly good cluster as a disagreement; anything
 * looser would stop being a claim.
 */
const D_TOLERANCE = 0.05;

/**
 * Half-width of the world the plate shows, as a multiple of N^(1/1.71).
 *
 * The scale is fixed for the run from the *target* count, not from the cluster
 * currently on screen, and that is a deliberate choice: it costs a repaint on
 * every rescale, it lets the cluster visibly grow into its frame, and above all
 * it is what makes the stickiness slider legible. A view that tracked the
 * cluster would rescale the barely-sticky run to the same apparent size as the
 * sticky one and hide the only thing the slider does.
 *
 * The outermost particle of a finished cluster sits at about 1.85·N^(1/1.71) —
 * measured 122, 267, 560 and 1,021 particle radii at N = 10³, 5·10³, 2·10⁴ and
 * 5·10⁴, against N^(1/1.71) of 56.8, 145.6, 327.5 and 559.7 — and the launch
 * circle stands six radii beyond that, so 2.4 keeps both on the plate.
 */
const VIEW_REACH_FACTOR = 2.4;

/** Floor on that half-width, so a ten-particle cluster is not drawn at 200× zoom. */
const VIEW_REACH_FLOOR = 12;

/**
 * Arrival-order colour steps.
 *
 * Eight, because the encoding is a batching decision as much as a visual one:
 * every particle in a band shares one fill, so a full repaint of fifty thousand
 * particles costs nine state changes rather than fifty thousand. Eight steps
 * are already finer than the eye separates on a one-pixel grain.
 */
const ARRIVAL_BANDS = 8;

/** Launch-circle dash, CSS px. A construction line, not part of the experiment. */
const LAUNCH_DASH: readonly number[] = [5, 4];

const TAU = 2 * Math.PI;

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'particles',
    label: 'Particles',
    min: 100,
    max: MAX_PARTICLES,
    step: 100,
    default: DEFAULT_PARTICLES,
    log: true,
    help: [
      'Particles frozen before the cluster is finished. The plate is scaled for this count, so the ',
      'cluster grows into its frame.',
    ],
  },
  {
    kind: 'range',
    key: 'stickiness',
    label: 'Stickiness',
    min: 0.05,
    max: 1,
    step: 0.05,
    default: DEFAULT_STICKINESS,
    help: 'Chance of adhering on contact. Below 1 the wanderer bounces off and keeps walking.',
  },
  {
    kind: 'choice',
    key: 'lattice',
    label: 'Lattice',
    options: [
      { value: 'off', label: 'Off-lattice' },
      { value: 'square', label: 'Square' },
      { value: 'hex', label: 'Hexagonal' },
    ],
    default: DEFAULT_LATTICE,
    help: 'Off-lattice walks in any direction; the lattices restrict it to four or six neighbours.',
  },
  {
    kind: 'range',
    key: 'walkSpeed',
    label: 'Walk speed',
    min: 1,
    max: 500,
    step: 1,
    default: DEFAULT_WALK_SPEED,
    unit: '/tick',
    log: true,
    help: [
      'Walk steps per tick. A particle takes about a thousand of them to arrive, so this is the ',
      'clock, not the physics — the cluster is the same at any speed.',
    ],
  },
  {
    kind: 'toggle',
    key: 'colourByArrival',
    label: 'Colour by arrival',
    default: true,
    help: 'Shade each particle by when it arrived, oldest to newest. The growth history, in one picture.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Same seed, same walk, same cluster.',
  },
];

const presets: readonly Preset[] = [
  {
    id: 'a-hundred',
    label: 'A hundred',
    caption: [
      'A hundred particles, slowly: each one wanders in from the dashed launch circle and freezes the instant it ',
      'touches. There is no dimension to report yet — a hundred particles is a shape, not a fractal.',
    ],
    values: { particles: 100, stickiness: 1, lattice: 'off', walkSpeed: 40, colourByArrival: true },
  },
  {
    id: 'two-thousand',
    label: 'Two thousand',
    caption:
      'Branches now shadow one another: almost nothing reaches the inner gaps, because a wanderer meets a tip first.',
    values: { particles: 2_000, stickiness: 1, lattice: 'off', walkSpeed: 300, colourByArrival: true },
  },
  {
    id: 'sticky',
    label: 'Sticky',
    caption: 'Every contact sticks, so growth happens wherever the wanderer first arrives — which is always the tips.',
    values: { particles: 5_000, stickiness: 1, lattice: 'off', walkSpeed: 500, colourByArrival: true },
  },
  {
    id: 'barely-sticky',
    label: 'Barely sticky',
    caption: [
      'One contact in twenty sticks, so a wanderer bounces along the branches and works its way into the fjords: ',
      'the same 5,000 particles, packed into a cluster 40% smaller. Screening is the whole mechanism, and this is ',
      'the slider that switches it off.',
    ],
    values: { particles: 5_000, stickiness: 0.05, lattice: 'off', walkSpeed: 500, colourByArrival: true },
  },
  {
    id: 'twenty-thousand',
    label: 'Twenty thousand',
    caption: [
      'Twenty thousand particles measure ', { v: 'D' }, ' ≈ 1.75 from the growth history — an estimate this ',
      'noisy is what a finite cluster buys you, and it is still not 2.',
    ],
    values: { particles: 20_000, stickiness: 1, lattice: 'off', walkSpeed: 500, colourByArrival: true },
  },
];

const facts: readonly Fact[] = [
  {
    text: [
      'Witten and Sander wrote the rule down in 1981 — release a particle far away, let it walk at random, freeze ',
      'it where it lands — and found the result is a fractal of dimension ', { v: 'D' }, ' ≈ 1.71 in two dimensions. ',
      'The paper is three pages long and the model has no free parameters at all.',
    ],
    source: {
      label: 'Witten and Sander, “Diffusion-Limited Aggregation, a Kinetic Critical Phenomenon”, Phys. Rev. Lett. 47, 1400 (1981)',
      url: 'https://doi.org/10.1103/PhysRevLett.47.1400',
    },
  },
  {
    text:
      'The tips grow fastest because a wandering particle is overwhelmingly likely to meet an exposed branch before ' +
      'it reaches an interior gap. Screening starves the inside of the cluster of anything to grow with — and it is ' +
      'the same mechanism that makes lightning branch, and that makes a viscous finger split rather than fatten.',
    source: {
      label: 'Witten and Sander, “Diffusion-limited aggregation”, Phys. Rev. B 27, 5686 (1983)',
      url: 'https://doi.org/10.1103/PhysRevB.27.5686',
    },
  },
  {
    text: [
      'Zinc leaves grown by electrodeposition in a thin cell were measured at ', { v: 'D' }, ' ≈ 1.66 in 1984 — ',
      'a real object in a dish, agreeing with a rule about random walks to within the experimental scatter.',
    ],
    source: {
      label: 'Matsushita et al., “Fractal Structures of Zinc Metal Leaves Grown by Electrodeposition”, Phys. Rev. Lett. 53, 286 (1984)',
      url: 'https://doi.org/10.1103/PhysRevLett.53.286',
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

function asLattice(v: ParamValue | undefined, fallback: Lattice): Lattice {
  return v === 'off' || v === 'square' || v === 'hex' ? v : fallback;
}

/** Particles this run will freeze, clamped the way the cluster clamps its own target. */
function particleTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_PARTICLES, Math.floor(num(values, 'particles', DEFAULT_PARTICLES))));
}

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * Half-width of the world the plate shows, in particle radii, for a run of
 * `target` particles. See `VIEW_REACH_FACTOR`.
 */
export function viewReach(target: number): number {
  const n = Math.max(1, target);
  return VIEW_REACH_FACTOR * n ** (1 / ANALYTIC_D) + VIEW_REACH_FLOOR;
}

/**
 * The arrival band of particle `i` out of `target`.
 *
 * Monotone in `i` by construction, which is what lets the painter walk a
 * contiguous index range per band instead of sorting or testing per particle.
 */
export function arrivalBand(i: number, target: number): number {
  const b = Math.floor((i * ARRIVAL_BANDS) / Math.max(1, target));
  return Math.min(ARRIVAL_BANDS - 1, Math.max(0, b));
}

/** First index of band `b`, so a band is the half-open range [bandStart(b), bandStart(b+1)). */
function bandStart(b: number, target: number): number {
  return Math.ceil((b * Math.max(1, target)) / ARRIVAL_BANDS);
}

function create(ctx: VizContext): VizInstance {
  // One cluster for the life of the tab, allocated at the budget ceiling: a
  // parameter change re-seeds and re-uses these arrays rather than replacing
  // 1 MB of typed arrays and asking the collector to clean up after it.
  const cluster: Cluster = createCluster(ctx.rng, {
    capacity: MAX_PARTICLES,
    particles: DEFAULT_PARTICLES,
    stickiness: DEFAULT_STICKINESS,
    lattice: DEFAULT_LATTICE,
  });

  // Live parameters, absorbed without disturbing the cluster on screen.
  let walkSpeed = DEFAULT_WALK_SPEED;
  let colourByArrival = true;

  // World → plate. Fixed for the run by the target count; see `viewReach`.
  let scale = 1;
  let originX = 0;
  let originY = 0;
  /** Drawn radius of one particle, CSS px. */
  let grainRadius = 1;

  // Painting state. `painted` is a cursor into the cluster, not simulation
  // state: particles never move once frozen, so the background layer keeps
  // every one of them and each frame only adds the arrivals since the last.
  let painted = 0;
  let repaintAll = true;

  // Fractional walk steps owed by the speed accumulator between ticks.
  let pending = 0;

  function syncLive(): void {
    walkSpeed = num(ctx.params, 'walkSpeed', DEFAULT_WALK_SPEED);
    colourByArrival = flag(ctx.params, 'colourByArrival', true);
  }

  function syncView(): void {
    const reach = viewReach(cluster.target);
    scale = Math.min(ctx.width, ctx.height) / (2 * reach);
    originX = ctx.width / 2;
    originY = ctx.height / 2;
    grainRadius = scale;
  }

  /**
   * Add particles `[from, to)` to the current path of `g`, as discs where there
   * is room for one and as pixel-snapped squares where there is not.
   *
   * The switch is not cosmetic. At twenty thousand particles the whole cluster
   * is 440 px across, so a particle is a third of a pixel: drawn as an `arc()`
   * it is an anti-aliased smear at partial coverage, where §7 measures the
   * signal pen at 2.20:1 — under the 3:1 SC 1.4.11 asks. A square snapped to
   * whole CSS pixels is painted at full coverage instead, so every grain keeps
   * the pen's own 4.80:1 whatever the zoom. Above 1.5 px there is room for the
   * disc §7 asks for, and the small-count presets get it.
   */
  function addGrains(g: CanvasRenderingContext2D, from: number, to: number): void {
    const { xs, ys } = cluster;
    if (grainRadius >= 1.5) {
      for (let i = from; i < to; i++) {
        const px = originX + xs[i]! * scale;
        const py = originY - ys[i]! * scale;
        g.moveTo(px + grainRadius, py);
        g.arc(px, py, grainRadius, 0, TAU);
      }
      return;
    }
    const side = Math.max(1, Math.round(2 * grainRadius));
    for (let i = from; i < to; i++) {
      const px = Math.round(originX + xs[i]! * scale - side / 2);
      const py = Math.round(originY - ys[i]! * scale - side / 2);
      g.rect(px, py, side, side);
    }
  }

  /**
   * Paint particles `[from, to)` onto the background layer.
   *
   * With arrival colouring on, a particle is two marks: an opaque graphite
   * grain, and the signal pen over it at the band's own alpha. That is the only
   * way to run a ramp between two theme tokens without inventing a hue —
   * `--data-3` and `--data-1` are hex strings from the stylesheet and nothing
   * here may parse or interpolate them — and it is safe for the same reason
   * §3's washes are: the alpha composites over an opaque grain, never over the
   * plate, so the worst contrast on the ramp is graphite's own 3.61:1 and the
   * best is vermilion's 4.80:1. Never `globalAlpha` over the bare plate.
   */
  function paintGrains(from: number, to: number): void {
    if (to <= from) return;
    const g = ctx.layers.background;
    const { theme } = ctx;
    if (!colourByArrival) {
      g.fillStyle = theme.data1;
      g.beginPath();
      addGrains(g, from, to);
      g.fill();
      return;
    }

    const target = cluster.target;
    g.fillStyle = theme.data3;
    g.beginPath();
    addGrains(g, from, to);
    g.fill();

    // Bands are contiguous index ranges, so this is one pass over [from, to)
    // however many particles arrived — at most eight fills, and in a live frame
    // one or two.
    g.fillStyle = theme.data1;
    const first = arrivalBand(from, target);
    const last = arrivalBand(to - 1, target);
    for (let b = first; b <= last; b++) {
      const lo = Math.max(from, bandStart(b, target));
      const hi = Math.min(to, bandStart(b + 1, target));
      if (hi <= lo) continue;
      g.globalAlpha = (b + 1) / ARRIVAL_BANDS;
      g.beginPath();
      addGrains(g, lo, hi);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  /** Repaint every frozen particle. Resize, parameter change, and nothing else. */
  function repaintCluster(): void {
    const g = ctx.layers.background;
    g.clearRect(0, 0, ctx.width, ctx.height);
    paintGrains(0, cluster.count);
    painted = cluster.count;
    repaintAll = false;
  }

  function readouts(dimension: number): Readout[] {
    return [
      { key: 'particles', label: 'Particles', value: cluster.count, digits: 6 },
      // In particle radii, so the scaling law reads directly off the row: a
      // finished cluster of N particles measures R_g ≈ N^(1/1.71) in these
      // units — 56.8, 218.4 and 559.7 at N = 10³, 10⁴ and 5·10⁴.
      { key: 'gyration', label: 'Radius of gyration', value: cluster.gyration, digits: 4, unit: 'r' },
      {
        key: 'dimension',
        label: 'Fractal dimension',
        value: dimension,
        digits: 4,
        target: ANALYTIC_D,
        tolerance: D_TOLERANCE,
      },
      { key: 'relaunched', label: 'Walkers relaunched', value: cluster.relaunches, digits: 6 },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      if (cluster.done) {
        pending = 0;
        return;
      }
      // Steps per tick depend only on dt and walkSpeed, and the cluster draws
      // from the rng only inside a step, so the cluster for a seed is the same
      // at every walk speed — only the clock differs.
      pending += (walkSpeed * dt) / TICK_MS;
      const steps = Math.floor(pending);
      if (steps <= 0) return;
      pending -= steps;
      cluster.advance(steps);
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move every grain.
      syncView();
      repaintCluster();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;

      // The cluster lives on the background layer and is only ever added to:
      // a particle never moves after it freezes, so repainting fifty thousand
      // of them every frame would buy nothing at all.
      if (repaintAll) repaintCluster();
      else if (cluster.count > painted) {
        paintGrains(painted, cluster.count);
        painted = cluster.count;
      }

      fg.clearRect(0, 0, width, height);

      // The launch circle: where every wanderer starts, standing just outside
      // the cluster and growing with it. Furniture around the experiment rather
      // than part of it, so it takes the container pen — dashed, because it is
      // a construction line and not an object anything is measured against, and
      // 2 px because §7 measures a hairline in that pen at 1.82:1.
      const launch = cluster.launchRadius * scale;
      if (launch > 2 && launch < Math.max(width, height)) {
        fg.strokeStyle = theme.gridSoft;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.setLineDash([...LAUNCH_DASH]);
        fg.beginPath();
        fg.arc(originX, originY, launch, 0, TAU);
        fg.stroke();
        fg.setLineDash([]);
      }

      // The live wanderer, at the full particle size however small the grains
      // are: it is the one thing on the plate that is still moving.
      if (cluster.walking && !cluster.done) {
        fg.fillStyle = theme.data1;
        fg.beginPath();
        const px = originX + cluster.walkerX * scale;
        const py = originY - cluster.walkerY * scale;
        fg.arc(px, py, theme.particleRadius, 0, TAU);
        fg.fill();
      }

      // The measured dimension in the top-right corner as a display window: an
      // opaque plate of the canvas colour with a 1 px container-pen frame,
      // right-aligned mono, ink text. Published below through emit() as well;
      // the canvas itself is aria-hidden. One fit per frame, shared with the
      // ledger: it is a regression over the whole growth history.
      const d = cluster.dimension().dimension;
      const label = `D ≈ ${Number.isNaN(d) ? '—' : d.toFixed(3)}`;
      const margin = 10;
      const pad = 5;
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      const textW = fg.measureText(label).width;
      const textH = fontPx(theme.labelFont);
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const plateX = Math.round(width - margin - textW - pad);
      const plateY = Math.round(margin - pad);
      const plateW = Math.round(textW + 2 * pad);
      const plateH = Math.round(textH + 2 * pad);
      fg.fillStyle = theme.canvas;
      fg.fillRect(plateX, plateY, plateW, plateH);
      fg.strokeStyle = theme.gridSoft;
      fg.lineWidth = theme.lineWidth;
      // Inset by half a line width so the frame lands inside the plate it draws.
      fg.strokeRect(plateX + snap, plateY + snap, plateW - 2 * snap, plateH - 2 * snap);
      fg.fillStyle = theme.ink;
      fg.fillText(label, width - margin, margin);

      ctx.emit(readouts(d));
    },

    onParamChange(key, value) {
      switch (key) {
        case 'walkSpeed':
          walkSpeed = asNumber(value, walkSpeed);
          return true;
        case 'colourByArrival':
          colourByArrival = value === true;
          // Cosmetic, but it re-colours particles that are already on the
          // background layer, so the whole cluster is repainted next frame.
          repaintAll = true;
          return true;
        case 'particles': {
          // Asymmetric, for the reason Buffon's drop ceiling is: the target
          // gates when the walk stops and nothing else, so the cluster on
          // screen is the first `count` particles of the run a fresh load at
          // the higher target would grow — a true prefix — and raising the
          // ceiling continues that same walk instead of restarting it. Below
          // the count already frozen there is no honest reading: the ledger
          // would go on reporting 20,000 particles while the control, the
          // caption and the permalink all said 1,000. So the shell resets.
          const next = particleTarget({ ...ctx.params, particles: value });
          if (next < cluster.count) return false;
          cluster.retarget(next);
          // Both the plate scale and the arrival bands are derived from the
          // target, so every grain on the layer is now in the wrong place and
          // the wrong colour.
          syncView();
          repaintAll = true;
          return true;
        }
        default:
          // stickiness, lattice, seed: the particles already frozen belong to a
          // different experiment, so the shell resets.
          return false;
      }
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      cluster.reset({
        particles: particleTarget(ctx.params),
        stickiness: num(ctx.params, 'stickiness', DEFAULT_STICKINESS),
        lattice: asLattice(ctx.params['lattice'], DEFAULT_LATTICE),
      });
      syncLive();
      syncView();
      pending = 0;
      painted = 0;
      // The background accumulates, so the previous cluster would still be
      // under this one. The shell repaints after a reset; this covers the
      // transport's own Reset key, which does not.
      ctx.layers.background.clearRect(0, 0, ctx.width, ctx.height);
      repaintAll = true;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const dla: Viz = {
  id: 'dla',
  title: 'Diffusion-Limited Aggregation',
  group: 'randomness',
  blurb: [
    'Releases a particle far away, lets it random-walk until it touches the cluster, and freezes it — ',
    'coral, frost and lightning grow this way.',
  ],
  // The cluster grows radially and the view is a disc, so the plate is square:
  // a 1.6 bed would scale the whole picture by its height and leave a third of
  // the plate empty on both sides.
  aspect: 1,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_PARTICLES },
  create,
};
