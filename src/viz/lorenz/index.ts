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
import { Welford } from '../../core/stats';
import {
  CLASSIC,
  DOUBLING_CLASSIC,
  LAMBDA_1_CLASSIC,
  SeparationLog,
  Trail,
  doublingTime,
  fixedPoints,
  hasClassicParameters,
  initialState,
  lyapunovEstimate,
  lyapunovStandardError,
  rk4Step,
  separation,
  viewBox,
  type LorenzParams,
  type LyapunovFit,
  type Vec3,
  type ViewBox,
} from './system';

/**
 * Points held in each trail. The ring is the ink budget and the memory budget
 * at once: 20,000 points at one every 0.005 time units is a hundred time units
 * of history, which at the pace below is a hundred seconds of watching.
 */
const MAX_TRAIL = 20_000;

/**
 * Simulated time units per second of simulation clock.
 *
 * Fixed, and deliberately not a control: the integration step is an accuracy
 * knob, and a run at dt = 0.001 must not crawl at a fifth of the pace of one at
 * 0.005. One unit per second is also what makes the tab's headline event
 * watchable — a 10⁻⁹ gap reaches order 1 after 22.9 time units, so the twins
 * come apart in twenty-three seconds rather than in four.
 */
const TIME_PER_SECOND = 1;

/**
 * Time between trail points and between separation samples.
 *
 * Both are intervals in *simulated time*, not counts of integration steps, so
 * the picture and the fit are the same at every step size — which is the whole
 * claim the "Fine step" preset makes. At the default the trajectory covers
 * about 2.5 CSS px between trail points on a full-size plate, which is below
 * the width of the pen drawing them.
 */
const TRAIL_SAMPLE = 0.005;
const SEPARATION_SAMPLE = 0.05;

/** Float error in an accumulated interval is ~1e-18; this is far above it and far below a sample. */
const SAMPLE_EPSILON = 1e-9;

/**
 * Separation samples kept, and how many new ones are worth refitting for.
 *
 * 8,192 samples is 410 time units — twenty times the divergence episode the fit
 * is measured over, and the log stops rather than wrapping when it is full (see
 * `SeparationLog`). The fit is O(n) in the samples, so refitting on every one
 * would be O(n²) over a run; once per time unit is far faster than a reader can
 * read the number.
 */
const SEPARATION_CAPACITY = 8_192;
const FIT_STRIDE = 20;

/**
 * How the trail fades, in nats of alpha removed over one trail length.
 *
 * The foreground is faded rather than cleared and only the newly-arrived
 * segments are painted, so a point's brightness is the record of how long ago
 * it was laid down — which is what a Lorenz trail is for. Three nats means a
 * point is down to 5% of full strength by the time the ring evicts it, so the
 * geometric fade and the hard end of the ring agree about where the trail stops.
 *
 * The fade is *owed* and paid in quanta because canvas alpha is 8-bit: the
 * 0.0025 per frame that a 4,000-point trail asks for is a fifth of one alpha
 * step and `destination-out` rounds it away to nothing, so the trail would
 * never fade at all. Accumulating to 6% and paying in one go is the same
 * exponential at the same rate — 6% steps a third of a second apart are
 * invisible on a gradient — and it is above the rounding floor. Old ink still
 * bottoms out at about 3% opacity rather than vanishing, which is what an
 * attractor's invariant measure looks like when you leave it running.
 */
const FADE_NATS = 3;
const FADE_QUANTUM = 0.06;

/** Margin between the viewing box and the edge of the plate, CSS px. */
const PLATE_PAD = 14;

/** Radius of a fixed-point ring, and the gap from it to its label, CSS px. */
const MARK_RADIUS = 4;
const LABEL_GAP = 5;

/** Length of an axis tick, CSS px. */
const TICK = 4;

const TAU = 2 * Math.PI;

const DEFAULT_DT = 0.005;
const DEFAULT_TRAIL = 4_000;
const DEFAULT_GAP = 1e-9;
const DEFAULT_SEED = 42;

/**
 * Smallest initial gap the twin can actually be given.
 *
 * The rail quantises a range to `step` and rounds the result to at most ten
 * decimals, so every fader position below 5·10⁻¹¹ reports exactly zero — and a
 * zero gap is not a twin, it is the same trajectory drawn twice with ln 0 in
 * the ledger. The declared minimum is honoured here instead.
 */
const MIN_GAP = 1e-12;

/** How far the seed moves the starting point, in world units, per coordinate. */
const JITTER = 0.5;

type Axis = 'x' | 'y' | 'z';

interface Projection {
  readonly id: string;
  readonly label: string;
  /** Coordinate on the horizontal of the plate, and on the vertical. */
  readonly h: Axis;
  readonly v: Axis;
}

/** The three coordinate planes. `xz` is the one the butterfly is named for. */
const PROJECTIONS: readonly Projection[] = [
  { id: 'xz', label: 'x – z (the butterfly)', h: 'x', v: 'z' },
  { id: 'xy', label: 'x – y', h: 'x', v: 'y' },
  { id: 'yz', label: 'y – z', h: 'y', v: 'z' },
];

function projectionFor(id: string): Projection {
  return PROJECTIONS.find((p) => p.id === id) ?? PROJECTIONS[0]!;
}

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'sigma',
    label: 'Prandtl σ',
    min: 1,
    max: 20,
    step: 0.1,
    default: CLASSIC.sigma,
    help: [
      'How fast momentum diffuses against heat. Lorenz used ', { v: 'σ' }, ' = 10, and the published ',
      'exponent belongs to that value.',
    ],
  },
  {
    kind: 'range',
    key: 'rho',
    label: 'Rayleigh ρ',
    min: 1,
    max: 50,
    step: 0.1,
    default: CLASSIC.rho,
    help: [
      'Heating, as a multiple of the value convection starts at. The wing centres are stable below ',
      { v: 'σ' }, '(', { v: 'σ' }, '+', { v: 'β' }, '+3)/(', { v: 'σ' }, '−', { v: 'β' }, '−1) = 24.74 ',
      'and there is nothing left to settle onto above it.',
    ],
  },
  {
    kind: 'range',
    key: 'beta',
    label: 'Geometry β',
    min: 0.5,
    max: 5,
    step: 0.01,
    default: CLASSIC.beta,
    help: [
      'Aspect ratio of the convection roll. Lorenz used ', { v: 'β' }, ' = 8/3, which this fader shows ',
      'to its own two decimals as 2.67.',
    ],
  },
  {
    kind: 'range',
    key: 'dt',
    label: 'Integration step',
    min: 0.0005,
    max: 0.01,
    step: 0.0001,
    default: DEFAULT_DT,
    log: true,
    help: [
      'Runge–Kutta step ', { v: 'h' }, '. Accuracy only — time advances at one unit per second whatever ',
      'it is set to, so a finer step buys a truer orbit and not a slower one.',
    ],
  },
  {
    kind: 'range',
    key: 'trailLength',
    label: 'Trail length',
    min: 100,
    max: MAX_TRAIL,
    step: 100,
    default: DEFAULT_TRAIL,
    log: true,
    help: 'Points kept behind each trajectory. One point every 0.005 time units, so 4,000 is twenty time units of history.',
  },
  {
    kind: 'toggle',
    key: 'twin',
    label: 'Twin trajectory',
    default: true,
    help: [
      'Run a second trajectory from a starting point ', { v: 'ε' }, ' away and draw it in the second pen.',
    ],
  },
  {
    kind: 'range',
    key: 'twinGap',
    label: 'Initial gap ε',
    min: MIN_GAP,
    max: 1e-3,
    step: MIN_GAP,
    default: DEFAULT_GAP,
    log: true,
    help: [
      'How far apart the twins start. The gap doubles every 0.765 time units, so 10⁻⁹ reaches order 1 ',
      'after about 22.9 of them — and every decade you take off buys only 2.5 more.',
    ],
  },
  {
    kind: 'choice',
    key: 'projection',
    label: 'Projection',
    options: PROJECTIONS.map((p) => ({ value: p.id, label: p.label })),
    default: 'xz',
    help: 'Which two of the three coordinates the plate shows. The trail already drawn is re-projected, not restarted.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Jitters the starting point, and nothing else — there is no randomness in these equations. The attractor is the same object from anywhere in its basin.',
  },
];

const presets: readonly Preset[] = [
  {
    id: 'butterfly',
    label: 'The butterfly',
    caption: [
      'One trajectory, no randomness, three equations: it never repeats, never escapes, and winds ',
      'around the two fixed points at ', { v: 'C' }, '± forever.',
    ],
    values: { sigma: 10, rho: 28, beta: 8 / 3, dt: 0.005, trailLength: 4_000, twin: false, projection: 'xz' },
  },
  {
    id: 'twins',
    label: 'Twins',
    caption: [
      'A second trajectory starting a billionth of a unit away. It traces the first exactly, then ',
      'leaves it — the butterfly effect as something you watch rather than something you are told.',
    ],
    values: { rho: 28, twin: true, twinGap: 1e-9, trailLength: 4_000, projection: 'xz' },
  },
  {
    id: 'not-yet-chaotic',
    label: 'Not yet chaotic',
    caption: [
      'At ', { v: 'ρ' }, ' = 14 the wing centres are still stable: the same twins converge instead of ',
      'diverging and the fitted exponent comes out negative.',
    ],
    values: { rho: 14, twin: true, twinGap: 1e-9, projection: 'xz' },
  },
  {
    id: 'fine-step',
    label: 'Fine step',
    caption: [
      'A fifth of the integration step, and the object on the plate is the same one — the attractor ',
      'is a property of the equations, not of how they were integrated.',
    ],
    values: { rho: 28, dt: 0.001, twin: true, twinGap: 1e-9, projection: 'xz' },
  },
];

const facts: readonly Fact[] = [
  {
    text: [
      'Lorenz found this in 1963 by restarting a run from a printout. The machine held six decimals and ',
      'printed three, so the restart began 10⁻⁶ from where the first run had been — and within a couple ',
      'of simulated months the two weather histories had nothing in common.',
    ],
    source: {
      label: 'Lorenz, “Deterministic Nonperiodic Flow”, Journal of the Atmospheric Sciences 20 (1963), 130–141; the printout is his own account in The Essence of Chaos (1993), ch. 4',
      url: 'https://journals.ametsoc.org/view/journals/atsc/20/2/1520-0469_1963_020_0130_dnf_2_0_co_2.xml',
    },
  },
  {
    text: [
      'Chaos here has a threshold you can slide across. The wing centres lose stability in a subcritical ',
      'Hopf bifurcation at ', { v: 'ρ' }, ' = ', { v: 'σ' }, '(', { v: 'σ' }, '+', { v: 'β' }, '+3)/(',
      { v: 'σ' }, '−', { v: 'β' }, '−1), which is 24.74 for Lorenz’s σ and β: at ', { v: 'ρ' },
      ' = 14 every trajectory settles onto one of them, and at 28 there is nothing left to settle onto.',
    ],
    source: {
      label: 'Sparrow, The Lorenz Equations: Bifurcations, Chaos, and Strange Attractors (1982), ch. 1; Strogatz, Nonlinear Dynamics and Chaos, §9.2',
      url: 'https://en.wikipedia.org/wiki/Lorenz_system',
    },
  },
  {
    text: [
      'The flow shrinks every volume at −(', { v: 'σ' }, '+1+', { v: 'β' }, ') = −13.67 per time unit, a factor ',
      'of a million a second at the pace above, so the attractor has zero volume — and the trajectory on it ',
      'still never closes. Its dimension is about 2.06: more than a surface, less than a solid. That it is a ',
      'genuine attractor and not an artefact of finite-precision arithmetic was open until Warwick Tucker ',
      'proved it in 2002.',
    ],
    source: {
      label: 'Tucker, “A Rigorous ODE Solver and Smale’s 14th Problem”, Foundations of Computational Mathematics 2 (2002), 53–117; dimension from Viswanath, Physica D 190 (2004)',
      url: 'https://doi.org/10.1007/s002080010018',
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

function text(values: ParamValues, key: string, fallback: string): string {
  const v = values[key];
  return typeof v === 'string' ? v : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

function component(x: number, y: number, z: number, axis: Axis): number {
  return axis === 'x' ? x : axis === 'y' ? y : z;
}

function axisRange(box: ViewBox, axis: Axis): { lo: number; hi: number } {
  if (axis === 'x') return { lo: box.xMin, hi: box.xMax };
  if (axis === 'y') return { lo: box.yMin, hi: box.yMax };
  return { lo: box.zMin, hi: box.zMax };
}

// ---------------------------------------------------------------------------
// Plate geometry
// ---------------------------------------------------------------------------

/**
 * World coordinates → CSS pixels, one uniform scale for both axes.
 *
 * Uniform because the attractor's shape is the object on display: stretching
 * the two axes independently to fill the plate would make the wings a
 * parameter of the window size, and the same run would be a different picture
 * on a phone. The leftover in the binding direction becomes symmetric margin.
 */
export interface Plate {
  readonly h: Axis;
  readonly v: Axis;
  /** CSS px per world unit. */
  scale: number;
  /** Plate coordinates of the box's centre. */
  ox: number;
  oy: number;
  hMid: number;
  vMid: number;
}

export function plateTransform(
  width: number,
  height: number,
  box: ViewBox,
  projection: Projection,
  pad: number,
): Plate {
  const h = axisRange(box, projection.h);
  const v = axisRange(box, projection.v);
  const hSpan = Math.max(1e-6, h.hi - h.lo);
  const vSpan = Math.max(1e-6, v.hi - v.lo);
  const usableW = Math.max(1, width - 2 * pad);
  const usableH = Math.max(1, height - 2 * pad);
  return {
    h: projection.h,
    v: projection.v,
    scale: Math.min(usableW / hSpan, usableH / vSpan),
    ox: width / 2,
    oy: height / 2,
    hMid: (h.lo + h.hi) / 2,
    vMid: (v.lo + v.hi) / 2,
  };
}

function toPx(plate: Plate, x: number, y: number, z: number): number {
  return plate.ox + (component(x, y, z, plate.h) - plate.hMid) * plate.scale;
}

function toPy(plate: Plate, x: number, y: number, z: number): number {
  // Screen y grows downward and the world's vertical axis grows upward.
  return plate.oy - (component(x, y, z, plate.v) - plate.vMid) * plate.scale;
}

/**
 * A round graduation interval covering `span` in roughly eight steps: 1, 2 or 5
 * times a power of ten, so the ticks land on numbers a reader recognises at
 * every parameter setting rather than on 6.375.
 */
export function tickStep(span: number): number {
  const raw = Math.max(1e-9, span) / 8;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * magnitude;
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

function create(ctx: VizContext): VizInstance {
  const trail = new Trail(MAX_TRAIL);
  const twinTrail = new Trail(MAX_TRAIL);
  const log = new SeparationLog(SEPARATION_CAPACITY);

  // Time averages of x² and z. Both converge on the exact relation ⟨x²⟩ = β⟨z⟩,
  // and Welford rather than a running sum because these accumulate a hundred
  // thousand samples a minute and the sum of z alone reaches 10⁷ inside two.
  const sqX = new Welford();
  const avZ = new Welford();

  let system: LorenzParams = CLASSIC;
  let box = viewBox(system);
  let projection = projectionFor('xz');
  let h = DEFAULT_DT;
  let trailLength = DEFAULT_TRAIL;
  let twinOn = true;
  let gap = DEFAULT_GAP;

  let state: Vec3 = initialState(system);
  let twinState: Vec3 = state;
  let t = 0;
  /** Simulated time owed by the clock between integration steps. */
  let pending = 0;
  let sinceTrail = 0;
  let sinceSample = 0;
  let fit: LyapunovFit = lyapunovEstimate(log);
  /** Samples in the log when `fit` was last computed. */
  let fitAt = 0;
  /** Set if the state ever leaves the reals; the run freezes rather than painting NaN. */
  let blown = false;

  // Painting state — what the foreground layer already holds, not what the
  // simulation is. `draw()` mutates these three and nothing else.
  let paintedTo = 0;
  let repaint = true;
  let fadeOwed = 0;

  function syncParams(): void {
    system = {
      sigma: num(ctx.params, 'sigma', CLASSIC.sigma),
      rho: num(ctx.params, 'rho', CLASSIC.rho),
      beta: num(ctx.params, 'beta', CLASSIC.beta),
    };
    box = viewBox(system);
    projection = projectionFor(text(ctx.params, 'projection', 'xz'));
    h = clamp(num(ctx.params, 'dt', DEFAULT_DT), 0.0001, 0.05);
    trailLength = clamp(Math.round(num(ctx.params, 'trailLength', DEFAULT_TRAIL)), 2, MAX_TRAIL);
    twinOn = flag(ctx.params, 'twin', true);
    gap = Math.max(MIN_GAP, num(ctx.params, 'twinGap', DEFAULT_GAP));
  }

  function paintBackground(): void {
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const plate = plateTransform(width, height, box, projection, PLATE_PAD);
    const hr = axisRange(box, plate.h);
    const vr = axisRange(box, plate.v);
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;

    // Axes and graduations. These contain the experiment rather than being part
    // of it — the experiment is a trajectory and nothing else — so they take the
    // container pen at a hairline, snapped so they are not smeared across two
    // device pixel rows and left under 3:1.
    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.beginPath();

    const zeroY = Math.round(toPy(plate, 0, 0, 0)) + snap;
    const zeroX = Math.round(toPx(plate, 0, 0, 0)) + snap;
    const onPlate = (p: number, limit: number): boolean => p >= 0 && p <= limit;

    if (onPlate(zeroY, height)) {
      bg.moveTo(0, zeroY);
      bg.lineTo(width, zeroY);
    }
    if (onPlate(zeroX, width)) {
      bg.moveTo(zeroX, 0);
      bg.lineTo(zeroX, height);
    }

    const hStep = tickStep(hr.hi - hr.lo);
    const baseY = onPlate(zeroY, height) ? zeroY : height - PLATE_PAD;
    for (let u = Math.ceil(hr.lo / hStep) * hStep; u <= hr.hi + 1e-9; u += hStep) {
      if (Math.abs(u) < 1e-9) continue;
      const px = Math.round(plate.ox + (u - plate.hMid) * plate.scale) + snap;
      bg.moveTo(px, baseY - TICK);
      bg.lineTo(px, baseY + TICK);
    }

    const vStep = tickStep(vr.hi - vr.lo);
    const baseX = onPlate(zeroX, width) ? zeroX : PLATE_PAD;
    for (let u = Math.ceil(vr.lo / vStep) * vStep; u <= vr.hi + 1e-9; u += vStep) {
      if (Math.abs(u) < 1e-9) continue;
      const py = Math.round(plate.oy - (u - plate.vMid) * plate.scale) + snap;
      bg.moveTo(baseX - TICK, py);
      bg.lineTo(baseX + TICK, py);
    }
    bg.stroke();

    // The three fixed points, as rings at 2 px. They are the skeleton the
    // trajectory is organised around — the wings are wound about C₊ and C₋, and
    // the orbit crosses between them along the origin's stable manifold — but
    // they are furniture on this plate, not the experiment, so they take the
    // container pen too.
    const marks = fixedPoints(system);
    bg.lineWidth = 2 * theme.lineWidth;
    bg.beginPath();
    for (const p of marks) {
      const px = toPx(plate, p.x, p.y, p.z);
      const py = toPy(plate, p.x, p.y, p.z);
      bg.moveTo(px + MARK_RADIUS, py);
      bg.arc(px, py, MARK_RADIUS, 0, TAU);
    }
    bg.stroke();

    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    bg.textAlign = 'left';
    bg.textBaseline = 'middle';
    const names = ['O', 'C₊', 'C₋'];
    marks.forEach((p, i) => {
      bg.fillText(
        names[i] ?? '',
        toPx(plate, p.x, p.y, p.z) + MARK_RADIUS + LABEL_GAP,
        toPy(plate, p.x, p.y, p.z),
      );
    });

    // Which plane this is. Two letters, at the ends of the two axes.
    bg.textAlign = 'right';
    bg.textBaseline = 'bottom';
    bg.fillText(plate.h, width - PLATE_PAD, Math.min(height - 2, baseY - TICK - 2));
    bg.textAlign = 'left';
    bg.textBaseline = 'top';
    bg.fillText(plate.v, Math.max(2, baseX + TICK + 2), PLATE_PAD);
  }

  /**
   * Stroke `count` trail points from chronological position `from`, as one path
   * and one stroke. Points arrive in world coordinates, so a resize or a change
   * of projection re-lays-out the whole history rather than stranding it.
   */
  function strokeTrail(
    fg: CanvasRenderingContext2D,
    ring: Trail,
    plate: Plate,
    from: number,
    count: number,
    pen: string,
  ): void {
    if (count < 2) return;
    fg.beginPath();
    let started = false;
    ring.forEach(from, count, (x, y, z) => {
      const px = toPx(plate, x, y, z);
      const py = toPy(plate, x, y, z);
      if (started) fg.lineTo(px, py);
      else {
        fg.moveTo(px, py);
        started = true;
      }
    });
    // 2 px, never a hairline: the signal pen is 4.80:1 on the plate as a solid
    // 2 px mark and 2.20:1 once anti-aliasing smears it across a thinner one.
    fg.strokeStyle = pen;
    fg.lineWidth = 2 * ctx.theme.lineWidth;
    fg.lineJoin = 'round';
    fg.lineCap = 'round';
    fg.stroke();
  }

  /**
   * The live numbers, as a display window in the top-right: an opaque plate of
   * the canvas colour with a container-pen frame. Opaque because a hundred time
   * units of trail read straight through a translucent one. Both numbers are
   * published through `emit()` as well — the canvas is aria-hidden, and these
   * two are the only ones it draws.
   */
  function drawWindow(fg: CanvasRenderingContext2D, lines: readonly string[]): void {
    const { width, theme } = ctx;
    const margin = 10;
    const pad = 5;
    const lead = Math.round(fontPx(theme.labelFont) * 1.45);
    fg.font = theme.labelFont;
    fg.textAlign = 'right';
    fg.textBaseline = 'top';
    let textW = 0;
    for (const line of lines) textW = Math.max(textW, fg.measureText(line).width);
    const textH = lines.length * lead - (lead - fontPx(theme.labelFont));

    const plateX = Math.round(width - margin - textW - pad);
    const plateY = Math.round(margin - pad);
    const plateW = Math.round(textW + 2 * pad);
    const plateH = Math.round(textH + 2 * pad);
    // The layer fades rather than clears, so the window's own rectangle has to
    // be emptied first or every frame's text would stay under the next one.
    fg.clearRect(plateX - 1, plateY - 1, plateW + 2, plateH + 2);
    fg.fillStyle = theme.canvas;
    fg.fillRect(plateX, plateY, plateW, plateH);
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    fg.strokeStyle = theme.gridSoft;
    fg.lineWidth = theme.lineWidth;
    // The trail painter leaves round joins behind it; a window is a window.
    fg.lineJoin = 'miter';
    fg.strokeRect(plateX + snap, plateY + snap, plateW - 2 * snap, plateH - 2 * snap);
    fg.fillStyle = theme.ink;
    lines.forEach((line, i) => {
      fg.fillText(line, width - margin, margin + i * lead);
    });
  }

  function readouts(): Readout[] {
    const classic = hasClassicParameters(system);
    const rows: Readout[] = [
      { key: 'time', label: 'Simulated time', value: t, digits: 5 },
    ];

    if (twinOn) {
      const d = separation(state, twinState);
      // λ₁ has no closed form — it is a measured property of the attractor, so
      // the hero prints the word "analytic" and no formula behind it. The
      // convergence band is three standard errors of *this* fit, from its own
      // residual: one divergence episode is a one-sample experiment and its
      // precision is a property of how straight the line came out, which is
      // exactly what a live band should follow.
      const se = lyapunovStandardError(fit.residual, fit.to - fit.from);
      const band = 3 * se;
      rows.push(
        { key: 'separation', label: 'Twin separation', value: d, digits: 3 },
        {
          key: 'lyapunov',
          label: 'Lyapunov exponent',
          value: fit.lambda,
          digits: 4,
          ...(classic
            ? {
                target: LAMBDA_1_CLASSIC,
                tolerance: Number.isFinite(band) ? band / LAMBDA_1_CLASSIC : 0.15,
              }
            : {}),
        },
        {
          key: 'doubling',
          label: 'Doubling time',
          value: doublingTime(fit.lambda),
          digits: 4,
          ...(classic
            ? {
                target: DOUBLING_CLASSIC,
                // ln 2 / λ, so to first order the relative errors are the same.
                tolerance: Number.isFinite(band) ? band / LAMBDA_1_CLASSIC : 0.15,
                formula: ['ln 2 / ', { v: 'λ' }, '₁'],
              }
            : {}),
        },
      );
    }

    // The one exact closed form a run here converges to. Both averages are over
    // the same samples, so the ratio is 1 on the attractor and 1 at a fixed
    // point — the identity does not care which regime ρ has put the system in.
    const balance = (system.beta * avZ.mean) === 0 ? NaN : sqX.mean / (system.beta * avZ.mean);
    rows.push(
      {
        key: 'balance',
        label: 'Mean-square ratio',
        value: balance,
        digits: 5,
        target: 1,
        // The error here is not statistical, it is a boundary term, and it is
        // bounded outright. Averaging the two derivative identities over [0, T]
        // gives ⟨x²⟩ − β⟨z⟩ = (Δz − Δ(x²)/2σ)/T exactly, and both differences
        // are capped by the attractor's own extent (|z| ≤ 48, x² ≤ 380), so the
        // relative error can never exceed about 1.1/T — 1% by T = 107, and in
        // practice 0.2% by T = 50, measured over 40 seeds.
        tolerance: 0.01,
        formula: ['⟨', { v: 'x' }, '²⟩ = ', { v: 'β' }, '⟨', { v: 'z' }, '⟩'],
      },
      { key: 'x', label: 'State x', value: state.x, digits: 4 },
      { key: 'y', label: 'State y', value: state.y, digits: 4 },
      { key: 'z', label: 'State z', value: state.z, digits: 4 },
    );
    return rows;
  }

  const instance: VizInstance = {
    step(dtMs) {
      if (blown) return;
      pending += (dtMs / 1000) * TIME_PER_SECOND;
      while (pending >= h) {
        pending -= h;
        state = rk4Step(state, h, system);
        if (twinOn) twinState = rk4Step(twinState, h, system);
        t += h;

        if (!Number.isFinite(state.x + state.y + state.z)) {
          // Unreachable at the step sizes this tab offers — RK4's stability
          // limit is 2.78/|λ| and the fastest eigenvalue here is about −32, so
          // the ceiling is 0.087 against a slider that stops at 0.01 — but a
          // permalink carries whatever number is in the URL.
          blown = true;
          return;
        }

        sqX.push(state.x * state.x);
        avZ.push(state.z);

        sinceTrail += h;
        if (sinceTrail >= TRAIL_SAMPLE - SAMPLE_EPSILON) {
          sinceTrail = 0;
          trail.push(state);
          if (twinOn) twinTrail.push(twinState);
        }

        if (twinOn) {
          sinceSample += h;
          if (sinceSample >= SEPARATION_SAMPLE - SAMPLE_EPSILON) {
            sinceSample = 0;
            log.push(t, separation(state, twinState));
            if (log.count - fitAt >= FIT_STRIDE) {
              fit = lyapunovEstimate(log);
              fitAt = log.count;
            }
          }
        }
      }
    },

    drawBackground() {
      // Resize and parameter change both land here. A resize has already wiped
      // both bitmaps, so the trail on the foreground has to be laid out again
      // from the ring rather than continued.
      syncParams();
      paintBackground();
      repaint = true;
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const plate = plateTransform(width, height, box, projection, PLATE_PAD);

      const held = Math.min(trail.count, trailLength);
      const heldTwin = Math.min(twinTrail.count, trailLength);
      const fresh = trail.pushed - paintedTo;

      if (repaint || fresh >= held) {
        // Everything on the layer is stale — a resize, a new projection, a new
        // trail length, or a fast-forward that outran the trail itself.
        fg.clearRect(0, 0, width, height);
        if (twinOn) strokeTrail(fg, twinTrail, plate, twinTrail.count - heldTwin, heldTwin, theme.data2);
        strokeTrail(fg, trail, plate, trail.count - held, held, theme.data1);
        repaint = false;
        fadeOwed = 0;
      } else {
        // The foreground is a transparent layer over the axes, so fading it
        // means removing alpha, not painting the canvas colour over it — that
        // would bury the background within a few dozen frames.
        fadeOwed += (FADE_NATS * fresh) / trailLength;
        if (fadeOwed >= FADE_QUANTUM) {
          fg.globalCompositeOperation = 'destination-out';
          fg.fillStyle = `rgba(0, 0, 0, ${Math.min(1, fadeOwed)})`;
          fg.fillRect(0, 0, width, height);
          fg.globalCompositeOperation = 'source-over';
          fadeOwed = 0;
        }
        if (fresh > 0) {
          // One point of overlap, so the new segment joins the old polyline
          // instead of starting a gap at every frame boundary.
          if (twinOn) {
            strokeTrail(fg, twinTrail, plate, twinTrail.count - fresh - 1, fresh + 1, theme.data2);
          }
          strokeTrail(fg, trail, plate, trail.count - fresh - 1, fresh + 1, theme.data1);
        }
      }
      paintedTo = trail.pushed;

      // The twin goes down first and the original over it, so the path on
      // screen while they coincide is in the signal pen rather than in the
      // drafting one — and what appears when they part is the twin peeling off
      // a trajectory that was already there. No halo between them: the two pens
      // are 1.96:1 apart, and for the first twenty seconds the twin *is* the
      // original to within a billionth. A white gutter would be a picture of a
      // difference that has not happened yet.
      const lines = [`t = ${t.toFixed(2)}`];
      if (twinOn) lines.push(`d = ${separation(state, twinState).toExponential(2)}`);
      drawWindow(fg, lines);

      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      switch (key) {
        case 'projection':
          // Absorbed, and the point of absorbing it: the history already on the
          // plate is re-projected rather than thrown away, so the reader sees
          // the same run from another side.
          projection = projectionFor(typeof value === 'string' ? value : projection.id);
          paintBackground();
          repaint = true;
          return true;
        case 'trailLength':
          trailLength = clamp(Math.round(asNumber(value, trailLength)), 2, MAX_TRAIL);
          // Shortening the trail has to take ink off the layer, and the fade
          // alone would take a hundred frames to do it.
          repaint = true;
          return true;
        default:
          // σ, ρ, β, the step, the twin and its gap, and the seed: every one of
          // them is a different system or a different experiment, and the
          // trajectory already drawn belongs to the old one.
          return false;
      }
    },

    reset() {
      syncParams();
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));

      const base = initialState(system);
      state = {
        x: base.x + ctx.rng.range(-JITTER, JITTER),
        y: base.y + ctx.rng.range(-JITTER, JITTER),
        z: base.z + ctx.rng.range(-JITTER, JITTER),
      };
      // The whole gap goes into x. Splitting it across the coordinates would
      // change only which direction the perturbation starts in, and the fit
      // discards that anyway — what matters is that the distance is exactly ε,
      // because ε is the first sample in the log the exponent is fitted from.
      twinState = { x: state.x + gap, y: state.y, z: state.z };

      t = 0;
      pending = 0;
      sinceTrail = 0;
      sinceSample = 0;
      blown = false;

      trail.reset();
      twinTrail.reset();
      log.reset();
      sqX.reset();
      avZ.reset();

      trail.push(state);
      if (twinOn) {
        twinTrail.push(twinState);
        log.push(0, separation(state, twinState));
      }
      sqX.push(state.x * state.x);
      avZ.push(state.z);
      fit = lyapunovEstimate(log);
      fitAt = log.count;

      // Trails fade rather than clear, so the previous run would linger for a
      // few hundred frames after a reset. Start clean instead.
      ctx.layers.foreground.clearRect(0, 0, ctx.width, ctx.height);
      paintedTo = trail.pushed;
      repaint = true;
      fadeOwed = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const lorenz: Viz = {
  id: 'lorenz',
  title: 'Lorenz Attractor',
  group: 'chaos',
  blurb: [
    'Integrates three equations with no randomness in them at all, and two trajectories a billionth ',
    'apart end up on opposite wings.',
  ],
  // The classic x–z box is 44 wide by 53 tall at Lorenz's parameters, and the
  // other two planes are 0.72 and 1.15; a little wider than the mean of them
  // leaves room for the display window without shrinking the butterfly.
  aspect: 0.95,
  aspectNarrow: 0.8,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_TRAIL },
  create,
};
