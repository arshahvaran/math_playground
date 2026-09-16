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

// ---------------------------------------------------------------------------
// What used to be controls
//
// The tab has two knobs — the heat and the twins' starting gap. Everything else
// that was once a fader is a constant here, each with the reason it is fixed.
// The mathematics behind every one of them is unchanged; only its control is
// gone. The twin trajectory was a toggle and is simply always on now, so it has
// no constant: the twin is the whole tab.
// ---------------------------------------------------------------------------

/** σ was a fader (1–20). Fixed at Lorenz's own 10: the published exponent belongs to that value, and moving it teaches nothing the heat fader does not. */
const SIGMA = CLASSIC.sigma;

/** β was a fader (0.5–5). Fixed at Lorenz's own 8/3, for the same reason as σ. */
const BETA = CLASSIC.beta;

/**
 * The Runge–Kutta step was a fader (0.0005–0.01). Fixed at 0.005: a run at a
 * fifth of that step lands within 10⁻⁵ of it after two time units, so the object
 * on the plate is the attractor and not the integrator, and the clock below is
 * exact to one step.
 */
const STEP = 0.005;

/**
 * Points held in each trail — was a fader (100–20,000). Fixed at 4,000, which
 * at one point every 0.005 time units is twenty time units of history: about a
 * lap of each wing, and twenty seconds of watching at the pace below. The ring
 * is the ink budget and the memory budget at once.
 */
const TRAIL_LENGTH = 4_000;

/** The plane shown was a choice of three. Fixed at x–z, the one the butterfly is named for. */
const PROJECTION: Projection = { h: 'x', v: 'z' };

// ---------------------------------------------------------------------------
// Fixed by design, never controls
// ---------------------------------------------------------------------------

/**
 * Simulated time units per second of simulation clock.
 *
 * One unit per second is what makes the tab's headline event watchable: a 10⁻⁹
 * gap reaches order 1 after 22.9 time units, so the twins come apart in
 * twenty-three seconds rather than in four. Speed is the transport's business.
 */
const TIME_PER_SECOND = 1;

/**
 * Time between trail points and between separation samples.
 *
 * Both are intervals in *simulated time*, not counts of integration steps, so
 * the picture and the fit belong to the equations rather than to the step. At
 * the fixed step the trajectory covers about 2.5 CSS px between trail points on
 * a full-size plate, which is below the width of the pen drawing them.
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

/** Radius of a fixed-point ring, CSS px. */
const MARK_RADIUS = 4;

/** Length of an axis tick, CSS px. */
const TICK = 4;

const TAU = 2 * Math.PI;

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

/**
 * The widest text the clock window can be asked to hold. Its width is reserved
 * from this rather than measured from the digits on screen, so the window does
 * not step left when the clock passes 10 or 100 seconds — nothing on the page
 * may move because a digit changed.
 */
const WINDOW_BUDGET: readonly string[] = ['0000.0 s'];

type Axis = 'x' | 'y' | 'z';

interface Projection {
  /** Coordinate on the horizontal of the plate, and on the vertical. */
  readonly h: Axis;
  readonly v: Axis;
}

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'rho',
    label: 'Heat',
    min: 1,
    max: 50,
    step: 0.1,
    default: CLASSIC.rho,
    help: 'How hard the air is heated from below. Under about 24.7 every path settles down; above it nothing ever settles.',
  },
  {
    kind: 'range',
    key: 'twinGap',
    label: 'Starting gap',
    min: MIN_GAP,
    max: 1e-3,
    step: MIN_GAP,
    default: DEFAULT_GAP,
    log: true,
    help: 'How far apart the two paths begin. Every ten times closer buys them only about 2.5 more seconds together.',
  },
  // The rail renders no seed. The spec stays so that a permalink's seed is
  // honoured on the way in and the transport's Shuffle has a key to write.
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Moves the starting point a little. Nothing else here is random.',
  },
];

/**
 * Ordered to walk to the insight: watch the twins split, learn that starting a
 * thousand times closer barely delays it, then turn the heat down and watch the
 * whole effect switch off.
 */
const presets: readonly Preset[] = [
  {
    id: 'twins',
    label: 'Twins',
    caption: 'Two paths start a billionth apart, trace each other for about twenty seconds, then go their own ways.',
    values: { rho: 28, twinGap: 1e-9 },
  },
  {
    id: 'closer',
    label: 'A thousand times closer',
    caption: 'Start a trillionth apart instead and it buys them only about eight more seconds together.',
    values: { rho: 28, twinGap: 1e-12 },
  },
  {
    id: 'not-yet-chaotic',
    label: 'Less heat',
    caption: 'At a heat of 14 there is no chaos: the same twins pull together instead of apart.',
    values: { rho: 14, twinGap: 1e-9 },
  },
];

const facts: readonly Fact[] = [
  {
    text: 'Lorenz found this in 1963 by restarting a weather run from a printout that showed three decimals where the machine kept six, and the two forecasts soon had nothing in common.',
    source: {
      label: 'Lorenz, “Deterministic Nonperiodic Flow”, Journal of the Atmospheric Sciences 20 (1963), 130–141; the printout is his own account in The Essence of Chaos (1993), ch. 4',
      url: 'https://journals.ametsoc.org/view/journals/atsc/20/2/1520-0469_1963_020_0130_dnf_2_0_co_2.xml',
    },
  },
  {
    text: 'Chaos here has a switch you can slide across: below a heat of 24.74 every path settles onto one of the two wing centres, and above it there is nothing left to settle onto.',
    source: {
      label: 'Sparrow, The Lorenz Equations: Bifurcations, Chaos, and Strange Attractors (1982), ch. 1; Strogatz, Nonlinear Dynamics and Chaos, §9.2',
      url: 'https://en.wikipedia.org/wiki/Lorenz_system',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * A starting gap in words — "a billionth", "250 trillionths" — for the sentence
 * under the headline number. The rail clamps the gap to [10⁻¹², 10⁻³] and rounds
 * it to ten decimals, so every reachable value is a whole number of the largest
 * power of a thousand at or below it. The tolerance absorbs the rounding.
 */
export function gapInWords(gap: number): string {
  const scales: ReadonlyArray<readonly [number, string]> = [
    [1e-3, 'thousandth'],
    [1e-6, 'millionth'],
    [1e-9, 'billionth'],
    [1e-12, 'trillionth'],
  ];
  for (const [unit, word] of scales) {
    if (gap < unit * (1 - 1e-6)) continue;
    const count = Math.round(gap / unit);
    return count === 1 ? `a ${word}` : `${count} ${word}s`;
  }
  return String(gap);
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
 * every heat setting rather than on 6.375.
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
  const trail = new Trail(TRAIL_LENGTH);
  const twinTrail = new Trail(TRAIL_LENGTH);
  const log = new SeparationLog(SEPARATION_CAPACITY);

  // Time averages of x² and z. Both converge on the exact relation ⟨x²⟩ = β⟨z⟩,
  // and Welford rather than a running sum because these accumulate a hundred
  // thousand samples a minute and the sum of z alone reaches 10⁷ inside two.
  const sqX = new Welford();
  const avZ = new Welford();

  let system: LorenzParams = CLASSIC;
  let box = viewBox(system);
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
    system = { sigma: SIGMA, rho: num(ctx.params, 'rho', CLASSIC.rho), beta: BETA };
    box = viewBox(system);
    gap = Math.max(MIN_GAP, num(ctx.params, 'twinGap', DEFAULT_GAP));
  }

  function paintBackground(): void {
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const plate = plateTransform(width, height, box, PROJECTION, PLATE_PAD);
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
    // container pen too. Unlabelled: "C₊" is a name a reader would have to ask
    // about, and the rings say where the wings turn without one.
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

    // Which plane this is. Two letters, at the ends of the two axes.
    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    bg.textAlign = 'right';
    bg.textBaseline = 'bottom';
    bg.fillText(plate.h, width - PLATE_PAD, Math.min(height - 2, baseY - TICK - 2));
    bg.textAlign = 'left';
    bg.textBaseline = 'top';
    bg.fillText(plate.v, Math.max(2, baseX + TICK + 2), PLATE_PAD);
  }

  /**
   * Stroke `count` trail points from chronological position `from`, as one path
   * and one stroke. Points arrive in world coordinates, so a resize re-lays-out
   * the whole history rather than stranding it.
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
   * The clock, as a display window in the top-right: an opaque plate of the
   * canvas colour with a container-pen frame. Opaque because twenty time units
   * of trail read straight through a translucent one. Its width comes from
   * `WINDOW_BUDGET`, not from the digits showing, so it never moves. The number
   * is published through `emit()` as well — the canvas is aria-hidden, and this
   * is the only one it draws.
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
    for (const line of WINDOW_BUDGET) textW = Math.max(textW, fg.measureText(line).width);
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
    // λ₁ has no closed form — it is a measured property of the attractor, so
    // the ledger prints the word "analytic" and no formula behind it. The
    // convergence band is three standard errors of *this* fit, from its own
    // residual: one divergence episode is a one-sample experiment and its
    // precision is a property of how straight the line came out, which is
    // exactly what a live band should follow.
    const se = lyapunovStandardError(fit.residual, fit.to - fit.from);
    const band = 3 * se;
    const exponentTarget = classic
      ? {
          target: LAMBDA_1_CLASSIC,
          tolerance: Number.isFinite(band) ? band / LAMBDA_1_CLASSIC : 0.15,
        }
      : {};

    // The one exact closed form a run here converges to. Both averages are over
    // the same samples, so the ratio is 1 on the attractor and 1 at a fixed
    // point — the identity does not care which regime ρ has put the system in.
    const balance = (system.beta * avZ.mean) === 0 ? NaN : sqX.mean / (system.beta * avZ.mean);

    return [
      { key: 'time', label: 'Simulated time', value: t, digits: 5, plain: 'seconds elapsed' },
      {
        key: 'separation',
        label: 'Twin separation',
        value: separation(state, twinState),
        digits: 3,
        headline: true,
        plain: 'how far apart the twins are now',
        hint: `they started ${gapInWords(gap)} apart`,
      },
      {
        key: 'lyapunov',
        label: 'Lyapunov exponent',
        value: fit.lambda,
        digits: 4,
        expertOnly: true,
        ...exponentTarget,
      },
      {
        key: 'doubling',
        label: 'Doubling time',
        value: doublingTime(fit.lambda),
        digits: 4,
        plain: 'time for the gap to double',
        ...(classic
          ? {
              // ln 2 / λ, so to first order the relative errors are the same.
              target: DOUBLING_CLASSIC,
              tolerance: Number.isFinite(band) ? band / LAMBDA_1_CLASSIC : 0.15,
              formula: ['ln 2 / ', { v: 'λ' }, '₁'],
            }
          : {}),
      },
      {
        key: 'balance',
        label: 'Mean-square ratio',
        value: balance,
        digits: 5,
        plain: 'a ratio the equations fix at exactly 1',
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
      { key: 'x', label: 'State x', value: state.x, digits: 4, expertOnly: true },
      { key: 'y', label: 'State y', value: state.y, digits: 4, expertOnly: true },
      { key: 'z', label: 'State z', value: state.z, digits: 4, expertOnly: true },
    ];
  }

  const instance: VizInstance = {
    step(dtMs) {
      if (blown) return;
      pending += (dtMs / 1000) * TIME_PER_SECOND;
      while (pending >= STEP) {
        pending -= STEP;
        state = rk4Step(state, STEP, system);
        twinState = rk4Step(twinState, STEP, system);
        t += STEP;

        if (!Number.isFinite(state.x + state.y + state.z)) {
          // Unreachable at the fixed step — RK4's stability limit is 2.78/|λ|
          // and the stiffest eigenvalue anywhere on the heat fader is under 30
          // in size, so the ceiling is above 0.09 against a step of 0.005 —
          // but a NaN on the plate is unrecoverable and the guard is one
          // comparison.
          blown = true;
          return;
        }

        sqX.push(state.x * state.x);
        avZ.push(state.z);

        sinceTrail += STEP;
        if (sinceTrail >= TRAIL_SAMPLE - SAMPLE_EPSILON) {
          sinceTrail = 0;
          trail.push(state);
          twinTrail.push(twinState);
        }

        sinceSample += STEP;
        if (sinceSample >= SEPARATION_SAMPLE - SAMPLE_EPSILON) {
          sinceSample = 0;
          log.push(t, separation(state, twinState));
          if (log.count - fitAt >= FIT_STRIDE) {
            fit = lyapunovEstimate(log);
            fitAt = log.count;
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
      const plate = plateTransform(width, height, box, PROJECTION, PLATE_PAD);

      const held = Math.min(trail.count, TRAIL_LENGTH);
      const heldTwin = Math.min(twinTrail.count, TRAIL_LENGTH);
      const fresh = trail.pushed - paintedTo;

      if (repaint || fresh >= held) {
        // Everything on the layer is stale — a resize, or a fast-forward that
        // outran the trail itself.
        fg.clearRect(0, 0, width, height);
        strokeTrail(fg, twinTrail, plate, twinTrail.count - heldTwin, heldTwin, theme.data2);
        strokeTrail(fg, trail, plate, trail.count - held, held, theme.data1);
        repaint = false;
        fadeOwed = 0;
      } else {
        // The foreground is a transparent layer over the axes, so fading it
        // means removing alpha, not painting the canvas colour over it — that
        // would bury the background within a few dozen frames.
        fadeOwed += (FADE_NATS * fresh) / TRAIL_LENGTH;
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
          strokeTrail(fg, twinTrail, plate, twinTrail.count - fresh - 1, fresh + 1, theme.data2);
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
      drawWindow(fg, [`${t.toFixed(1)} s`]);

      ctx.emit(readouts());
    },

    onParamChange() {
      // Both knobs are a different experiment — another system, or a twin that
      // started somewhere else — and the trajectory already drawn belongs to
      // the old one. So does the seed.
      return false;
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
      twinTrail.push(twinState);
      log.push(0, separation(state, twinState));
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
  blurb: 'Two paths start a billionth apart and, with no randomness anywhere in the equations, end up on opposite wings.',
  // The x–z box is 44 wide by 53 tall at Lorenz's parameters; a little wider
  // than that leaves room for the clock window without shrinking the butterfly.
  aspect: 0.95,
  aspectNarrow: 0.8,
  params,
  presets,
  facts,
  budget: { maxEntities: TRAIL_LENGTH },
  create,
};
