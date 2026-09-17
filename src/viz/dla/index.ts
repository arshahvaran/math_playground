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
import {
  FIT_MIN_PARTICLES,
  createCluster,
  type Cluster,
  type DimensionFit,
  type Lattice,
} from './cluster';

/** Hard ceiling on particles; the `particles` slider tops out here too. */
const MAX_PARTICLES = 50_000;

const DEFAULT_PARTICLES = 2_000;
const DEFAULT_STICKINESS = 1;
const DEFAULT_SEED = 42;

/**
 * Walk steps per engine tick, paced so a run takes about the same wall clock
 * whatever the particle count.
 *
 * A particle takes roughly a thousand steps to arrive, so the step rate is a
 * clock and not physics: the cluster for a seed is identical at any value,
 * because the walk draws from the stream only inside a step. Held at a constant
 * 300 the clock was calibrated for the default and nothing else, and at the top
 * of the fader it made the control's own maximum unreachable — 50,000 particles
 * at 27 a second is 1,830 simulated seconds, which is 908 presses of the only
 * skip-ahead key the app has, each one advancing the run by a tenth of a per
 * cent of itself. Every other counted tab finishes its maximum in 9 to 85
 * presses, and the two that pace themselves — coprime's `checkRateFor()` and
 * Buffon's drop rate — do it exactly like this. The total work is unchanged;
 * only how much of the clock it is spread over.
 */
const RUN_SECONDS = 60;
const STEPS_PER_PARTICLE = 1_300;
const MIN_WALK_SPEED = 120;
const MAX_WALK_SPEED = 12_000;

export function walkSpeedFor(target: number): number {
  const needed = (Math.max(1, target) * STEPS_PER_PARTICLE) / (RUN_SECONDS * 120);
  return Math.max(MIN_WALK_SPEED, Math.min(MAX_WALK_SPEED, needed));
}

/**
 * Off-lattice, always. This was a three-way "Lattice" choice; the square and
 * hexagonal walks are a specialist's comparison — the same fractal with a faint
 * crystal grain — and the free walk is the model Witten and Sander wrote down.
 * `cluster.ts` still implements all three.
 */
const LATTICE: Lattice = 'off';

/**
 * Shade each particle by when it arrived, always. This was a toggle; switched
 * off, the cluster is one flat colour and the growth history — the one thing
 * that separates a growing cluster from a picture of one — is lost.
 */
const COLOUR_BY_ARRIVAL: boolean = true;

/** The engine's tick. The walk speed is quoted per tick, so the accumulator needs it. */
const TICK_MS = 1000 / 120;

/**
 * Witten and Sander's dimension, in two dimensions. It has no closed form —
 * it is a measured universal constant of the model, like the Feigenbaum δ two
 * tabs along — which is why the ledger row carries no formula.
 */
const ANALYTIC_D = 1.71;

/**
 * Half-width of the world the plate shows, as a multiple of N^(1/1.71).
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
 * The count the frame is sized for: the cluster on screen, rounded up to an
 * octave, and never below `FRAME_MIN_COUNT`.
 *
 * The frame used to be fixed for the run from the *target*, and that is what
 * made the top of the fader open on one lit pixel. Fifty thousand particles
 * frame a world 1,355 particle radii across; on a 560 px plate a particle is
 * then a fifth of a pixel, so the seed is invisible and stays invisible for the
 * first several minutes of the run — a plate that is blank while the transport
 * says the experiment is running.
 *
 * Framing the cluster that exists instead costs a repaint per octave, ten over
 * a full run, and keeps the cluster between two thirds and all of the frame at
 * every moment of it. It is framed from the *count* through the same
 * N^(1/1.71) law and never from the cluster's measured radius, which is what
 * preserves the one thing the stickiness fader teaches: five thousand barely
 * sticky particles really do pack into a smaller cluster, and a view that
 * tracked the real radius would rescale that away.
 */
const FRAME_MIN_COUNT = 64;

export function frameCount(count: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(FRAME_MIN_COUNT, count)));
}

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
    // The floor is where the dimension fit starts having power, not where a
    // cluster starts being drawable. Below it the tab's one headline number is
    // an em dash under a *finished* run, which is a dead band in the lower fifth
    // of the fader — and the first story chip used to sit inside it.
    min: FIT_MIN_PARTICLES,
    max: MAX_PARTICLES,
    step: 100,
    default: DEFAULT_PARTICLES,
    log: true,
  },
  {
    kind: 'range',
    key: 'stickiness',
    label: 'Stickiness',
    min: 0.05,
    max: 1,
    step: 0.05,
    default: DEFAULT_STICKINESS,
    help: 'The chance a particle sticks when it touches — turn it down and it bounces off and wanders deeper in.',
  },
  // Not a control: the rail skips seed specs. It is declared all the same
  // because a permalink's seed is only read for a key that has a spec.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'a-hundred',
    label: 'A few hundred',
    caption: 'Watch one particle at a time wander in from the dashed circle and freeze the moment it touches.',
    values: { particles: FIT_MIN_PARTICLES, stickiness: 1 },
  },
  {
    id: 'sticky',
    label: 'Sticky',
    caption: 'Every touch sticks, so the tips catch everything and the gaps between the branches stay empty.',
    values: { particles: 5_000, stickiness: 1 },
  },
  {
    id: 'barely-sticky',
    label: 'Barely sticky',
    caption:
      'Only one touch in twenty sticks, so particles bounce their way into the gaps and the same 5,000 pack into a smaller, denser cluster.',
    values: { particles: 5_000, stickiness: 0.05 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Witten and Sander wrote this rule down in 1981 — release a particle far away, let it wander at random, ' +
      'freeze it where it lands — and found it always grows a shape this feathery, scoring about 1.71, with ' +
      'nothing to tune.',
    source: {
      label: 'Witten and Sander, “Diffusion-Limited Aggregation, a Kinetic Critical Phenomenon”, Phys. Rev. Lett. 47, 1400 (1981)',
      url: 'https://doi.org/10.1103/PhysRevLett.47.1400',
    },
  },
  {
    text:
      'Zinc grown in a shallow dish of zinc solution in 1984 branched the same way and scored about 1.66 — a real ' +
      'object in a lab agreeing with a rule about random walks.',
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

/** Particles this run will freeze, clamped the way the cluster clamps its own target. */
function particleTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_PARTICLES, Math.floor(num(values, 'particles', DEFAULT_PARTICLES))));
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
    lattice: LATTICE,
  });

  // World → plate. Framed for the cluster on screen; see `frameCount`.
  let scale = 1;
  let originX = 0;
  let originY = 0;
  /** Drawn radius of one particle, CSS px. */
  let grainRadius = 1;
  /** The count the current frame was sized for, so a rescale is a comparison. */
  let framedFor = 0;

  // Painting state. `painted` is a cursor into the cluster, not simulation
  // state: particles never move once frozen, so the background layer keeps
  // every one of them and each frame only adds the arrivals since the last.
  let painted = 0;
  let repaintAll = true;

  // Fractional walk steps owed by the speed accumulator between ticks.
  let pending = 0;

  /** Derived from the target, so every run takes about the same clock. */
  let walkSpeed = walkSpeedFor(cluster.target);

  function syncView(): void {
    framedFor = frameCount(cluster.count);
    const reach = viewReach(framedFor);
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
    if (!COLOUR_BY_ARRIVAL) {
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

  /**
   * The simple view shows the dimension and the particle count and nothing
   * else; the radius of gyration and the relaunch count are the model's
   * bookkeeping, kept for the exact table and the tests that read it.
   */
  function readouts(fit: DimensionFit): Readout[] {
    const dimension = fit.dimension;
    // Three standard errors of *this* fit, in the dimension's own units, and
    // nothing else.
    //
    // `Math.max(0.05, stderr)` was a *floor* on the band: it could only ever
    // widen it, never narrow it, and that 0.05 was a constant — three times the
    // spread of the fit across seven seeds at twenty thousand particles (1.698,
    // 1.707, 1.717, 1.747, 1.754, 1.758, 1.766; sd 0.027). It is the precision a
    // cluster with seven octaves of growth behind it has earned, and a fit
    // spanning a third of one borrowed it: 1.747 at 400 particles read "matches
    // the prediction of 1.710", and asking for more particles turned that into a
    // permanent 14 % disagreement. A short fit has a wide standard error, and a
    // wide standard error now costs the verdict — the ledger's ceiling refuses
    // it and the run reads as still settling, which is what it is.
    const band: Readout['band'] = Number.isFinite(fit.stderr)
      ? { kind: 'absolute', half: 3 * fit.stderr }
      : undefined;
    return [
      { key: 'particles', label: 'Particles', value: cluster.count, digits: 6, plain: 'particles stuck' },
      // In particle radii, so the scaling law reads directly off the row: a
      // finished cluster of N particles measures R_g ≈ N^(1/1.71) in these
      // units — 56.8, 218.4 and 559.7 at N = 10³, 10⁴ and 5·10⁴.
      { key: 'gyration', label: 'Radius of gyration', value: cluster.gyration, digits: 4, unit: 'r', expertOnly: true },
      {
        key: 'dimension',
        label: 'Fractal dimension',
        value: dimension,
        digits: 4,
        target: ANALYTIC_D,
        ...(band ? { band } : {}),
        // A fractal dimension of a set in the plane is somewhere in [0, 2] by
        // definition, and the ledger judges the band against the smaller of that
        // span and the prediction.
        range: [0, 2],
        headline: true,
        plain: 'how feathery the cluster is',
        hint: 'a solid blob would score 2, a line 1',
      },
      { key: 'relaunched', label: 'Walkers relaunched', value: cluster.relaunches, digits: 6, expertOnly: true },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      if (cluster.done) {
        pending = 0;
        return;
      }
      // Steps per tick depend only on dt, and the cluster draws from the rng
      // only inside a step, so the cluster for a seed is the same however the
      // transport paces the ticks — only the clock differs.
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

      // The frame follows the cluster in octaves, so the plate is legible from
      // the first particle instead of after the first several minutes. A
      // rescale moves every grain, which makes it a repaint — ten of them over
      // a full run, against one per frame if the frame tracked every arrival.
      if (framedFor !== frameCount(cluster.count)) {
        syncView();
        repaintAll = true;
      }

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

      // The plate carries no text: the dimension is read below it, in plain
      // words, from the readouts. One fit per frame, over the whole growth
      // history.
      ctx.emit(readouts(cluster.dimension()));
    },

    onParamChange(key, value) {
      switch (key) {
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
          walkSpeed = walkSpeedFor(next);
          // Both the plate scale and the arrival bands are derived from the
          // target, so every grain on the layer is now in the wrong place and
          // the wrong colour.
          syncView();
          repaintAll = true;
          return true;
        }
        default:
          // stickiness, seed: the particles already frozen belong to a
          // different experiment, so the shell resets.
          return false;
      }
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      cluster.reset({
        particles: particleTarget(ctx.params),
        stickiness: num(ctx.params, 'stickiness', DEFAULT_STICKINESS),
        lattice: LATTICE,
      });
      syncView();
      walkSpeed = walkSpeedFor(cluster.target);
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
  blurb:
    'Lets particles wander in at random and freeze where they first touch, and since a tip is easier to hit ' +
    'than a gap, the cluster grows branches rather than a blob, like frost or lightning.',
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
