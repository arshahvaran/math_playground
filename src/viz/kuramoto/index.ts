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
  BAND_SIGMAS,
  HALF_WIDTH,
  SettledOrder,
  Swarm,
  TAU,
  analyticOrder,
  criticalCoupling,
  hasPrediction,
  orderUncertainty,
} from './oscillators';

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the crowd; the control tops out here too.
 *
 * The mean-field form is O(N) per step, so this is a frame-budget number rather
 * than an algorithmic one. Measured on a 1,280 × 720 plate, two ticks plus a
 * full paint per frame: 1.38 ms at two thousand oscillators and 0.31 ms at the
 * default four hundred, against the 16 ms the budget allows. It is also where
 * the finite-crowd floor (0.886/√N = 0.020) has dropped far enough below the
 * step of the coupling control to stop being visible on the plot.
 */
const MAX_OSCILLATORS = 2_000;

const MIN_OSCILLATORS = 50;
const DEFAULT_OSCILLATORS = 400;

/** The coupling control, and with it the right-hand end of the plot's axis. */
export const MAX_COUPLING = 4;
export const COUPLING_STEP = 0.1;
/**
 * Where the tab opens: past the threshold, and not at the end of the fader.
 *
 * DESIGN §6 asks every tab to open on the completed state of its default, and
 * the completed state at a coupling of 1 is a fuzzy ring with an arrow too
 * short to see. At 3 the crowd is a clump, the arrow is more than half the
 * ring, the reading sits on the curve below, and the fader has obvious room
 * either side — so the first thing a reader does is drag it, which is the whole
 * experiment. The presets then walk back down through the threshold and up
 * again, the way the Galton board's own default is a bell and its first preset
 * is one ball.
 */
const DEFAULT_COUPLING = 3;

const DEFAULT_SEED = 42;

/**
 * Runge–Kutta step, in the model's own time units, and how many of them a
 * second of simulation buys.
 *
 * One step per 120 Hz tick, so the model advances 4.8 time units a second: fast
 * enough that a drifting oscillator visibly laps the circle, slow enough that a
 * crowd of them still reads as individuals rather than as a smear. The step is
 * not a control — it is an integration detail, and the wrong sort of knob to
 * hand a sixteen-year-old. Measured against a run at h = 0.01, four times
 * finer: the settled reading differs by under 6·10⁻⁵, so this step is fully
 * converged and nothing in the readout depends on it.
 */
export const STEP_H = 0.04;
export const STEPS_PER_SECOND = 120;

/**
 * Model time excluded from the average at the start of a run, and after every
 * change of coupling.
 *
 * A crowd started from scattered phases takes a few time units to find whatever
 * state the coupling supports, and averaging across that transient would drag
 * the reading below the answer and hold it there. Fifteen units — about three
 * seconds — is where the measured reading stops moving: traced at N = 400 and
 * 2000 over couplings from 2.5 to 4, the running average from 15 is within
 * 0.003 of its own value at 300 by the time the run reaches 30, and the slowest
 * case seen (N = 2000 at K = 2.5) is the only one that still needed a second
 * window to arrive.
 */
export const SETTLE_TIME = 15;

// ---------------------------------------------------------------------------
// The plate
// ---------------------------------------------------------------------------

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Gap between the crowd and the plot, CSS px. */
const PANEL_GAP = 20;

/** The crowd's share of the axis the plate is split along. */
const DIAL_SHARE = 0.55;

/** Below this the plot cannot carry a labelled axis, CSS px. */
const MIN_PLOT = 140;

/** The crowd never shrinks past this to make room for the plot, CSS px. */
const MIN_DIAL = 90;

/** The ring's radius as a fraction of half the square the crowd is drawn in. */
const RING_FRACTION = 0.78;

/**
 * Half-width of the band the crowd is painted in, as a fraction of the ring's
 * radius.
 *
 * The phases live on a circle, and a circle is one-dimensional: at the default
 * plate the ring is 920 px round, and four hundred dots of diameter 4 need
 * 1,600 px of it. Painted on the line itself they are a solid ring whatever the
 * coupling is doing. Spread through a band of ±14% they are a crowd, their
 * density round the circle is legible, and the clump that appears past the
 * threshold is unmistakable. The offset carries no quantity — see `Swarm`.
 */
const RING_BAND = 0.14;

/**
 * The fraction of that band the dots may ink.
 *
 * `n` discs of area `a` scattered over an area `A` cover 1 − exp(−n·a/A) of it,
 * so a target `f` is n = −ln(1 − f)·A/a dots. The band on a default plate is
 * about 37,900 px² and a dot is 12.6 px², which puts f = 0.25 at roughly 870
 * dots. **This is what bounds the painting, and nothing bounds the counting** —
 * two thousand oscillators are still stepped, still summed and still in every
 * readout; `Swarm.forEach` simply visits every second or third one. Buffon
 * learned this the hard way with twenty thousand needles on one plate.
 */
const INK_TARGET = 0.25;

/** Arrowhead length and half-angle for the mean-field arrow. */
const HEAD_LENGTH = 9;
const HEAD_ANGLE = 0.42;

/** Room for the plot's axis numerals, its caption and its right margin, CSS px. */
const GUTTER_LEFT = 30;
const GUTTER_BOTTOM = 18;
const GUTTER_TOP = 14;
const GUTTER_RIGHT = 8;

/** Axis tick length and the gap between a tick and its numeral, CSS px. */
const TICK = 4;
const LABEL_GAP = 3;

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side of a path that runs along the frame itself.
 */
const HALO_PAD = 3;

/** Points along the rising branch of the analytic curve. */
const CURVE_STEPS = 160;

/**
 * The window that shows the reading on the plate, as a template rather than as
 * the reading itself. Sizing a box from the digits inside it is how a plate
 * starts twitching once a frame; this is measured once and never changes width.
 */
const WINDOW_TEMPLATE = 'r = 0.000';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlateLayout {
  /** The crowd. Always square: the circle drawn in it must be a circle. */
  dial: Rect;
  /** The plot of the reading against the coupling, or null when there is no room. */
  plot: Rect | null;
}

/**
 * Split the plate between the crowd and the plot.
 *
 * The crowd is square whichever way the plate is split, so the plot takes the
 * leftover strip: beside it on a landscape plate, under it on a phone. A strip
 * narrower than `MIN_PLOT` cannot carry a labelled axis and half a plot is
 * worse than none, so the crowd takes the whole plate instead.
 */
export function layoutPlate(width: number, height: number): PlateLayout {
  const w = Math.max(1, width - 2 * PLATE_PAD);
  const h = Math.max(1, height - 2 * PLATE_PAD);

  const horizontal = w >= 1.2 * h;
  const along = (horizontal ? w : h) - PANEL_GAP;
  const across = horizontal ? h : w;
  if (across >= MIN_PLOT && along >= MIN_DIAL + MIN_PLOT) {
    // Never past `across` (the dial is square), never past what leaves the plot
    // its minimum, never under the dial's own.
    const side = Math.min(across, Math.max(MIN_DIAL, Math.min(DIAL_SHARE * along, along - MIN_PLOT)));
    const span = along - side;
    return horizontal
      ? {
          dial: { x: PLATE_PAD, y: PLATE_PAD + (h - side) / 2, width: side, height: side },
          plot: { x: PLATE_PAD + side + PANEL_GAP, y: PLATE_PAD, width: span, height: h },
        }
      : {
          dial: { x: PLATE_PAD + (w - side) / 2, y: PLATE_PAD, width: side, height: side },
          plot: { x: PLATE_PAD, y: PLATE_PAD + side + PANEL_GAP, width: w, height: span },
        };
  }

  const size = Math.max(1, Math.min(w, h));
  return {
    dial: { x: PLATE_PAD + (w - size) / 2, y: PLATE_PAD + (h - size) / 2, width: size, height: size },
    plot: null,
  };
}

export interface DialScale {
  cx: number;
  cy: number;
  /** The ring the phases live on, in CSS px. The arrow's full length at r = 1. */
  radius: number;
}

export function dialScale(area: Rect): DialScale {
  return {
    cx: area.x + area.width / 2,
    cy: area.y + area.height / 2,
    radius: (RING_FRACTION * Math.min(area.width, area.height)) / 2,
  };
}

/**
 * Where a phase lands on the plate: angle anticlockwise from the right, with
 * the band offset applied to the radius. Canvas y runs down, so the sine is
 * subtracted and the crowd turns the way a clock's hand does not.
 */
export function phaseX(d: DialScale, phase: number, offset: number): number {
  return d.cx + d.radius * (1 + RING_BAND * offset) * Math.cos(phase);
}
export function phaseY(d: DialScale, phase: number, offset: number): number {
  return d.cy - d.radius * (1 + RING_BAND * offset) * Math.sin(phase);
}

/** Dots the band can hold at `INK_TARGET`, and the stride that gets there. */
export function paintStride(d: DialScale, count: number, dotRadius: number): number {
  const band = 4 * Math.PI * RING_BAND * d.radius * d.radius;
  const dot = Math.max(1, Math.PI * dotRadius * dotRadius);
  const affordable = Math.max(1, Math.ceil((-Math.log(1 - INK_TARGET) * band) / dot));
  return Math.max(1, Math.ceil(count / affordable));
}

export interface PlotScale {
  /** The data box, inside the axis gutters. The frame is drawn on its edges. */
  box: Rect;
}

export function plotScale(area: Rect): PlotScale {
  return {
    box: {
      x: area.x + GUTTER_LEFT,
      y: area.y + GUTTER_TOP,
      width: Math.max(1, area.width - GUTTER_LEFT - GUTTER_RIGHT),
      height: Math.max(1, area.height - GUTTER_TOP - GUTTER_BOTTOM),
    },
  };
}

/** Coupling → x. Linear, zero to `MAX_COUPLING`. */
export function plotX(s: PlotScale, coupling: number): number {
  const t = Math.min(1, Math.max(0, coupling / MAX_COUPLING));
  return s.box.x + t * s.box.width;
}

/** Reading → y, bottom up. Linear, zero to one, inset by `pad` for the halo. */
export function plotY(s: PlotScale, order: number, pad = 0): number {
  const inset = Math.min(pad, s.box.height / 2);
  const t = Math.min(1, Math.max(0, order));
  const y = s.box.y + (1 - t) * s.box.height;
  return Math.min(Math.max(y, s.box.y + inset), s.box.y + s.box.height - inset);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Two faders, and the seed the URL carries.
 *
 * The half-width of the speed spread is not among them: it is the *other*
 * quantity that moves the answer, and pinning it at 1 is what puts the
 * threshold on a round 2 that a reader can watch the coupling cross. The rail
 * never renders a seed spec, but it is declared all the same — without one
 * `?seed=7` is dropped on the way in and every shared link replays the default
 * crowd, and the transport's Shuffle key has nothing to set.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'coupling',
    label: 'Coupling',
    min: 0,
    max: MAX_COUPLING,
    step: COUPLING_STEP,
    default: DEFAULT_COUPLING,
    help: 'How hard each one pulls its neighbours towards its own rhythm.',
  },
  {
    kind: 'range',
    key: 'count',
    label: 'Fireflies',
    min: MIN_OSCILLATORS,
    max: MAX_OSCILLATORS,
    step: 1,
    default: DEFAULT_OSCILLATORS,
    log: true,
    help: 'How many are in the crowd. The tipping point does not move; only the wobble around it shrinks.',
  },
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'each-to-itself',
    label: 'Each to itself',
    caption: 'A gentle pull is not enough: every one keeps its own rhythm and the crowd stays smeared right round the ring.',
    values: { coupling: 1 },
  },
  {
    id: 'tipping-point',
    label: 'The tipping point',
    caption: 'Exactly on the tipping point: below it they never gather, above it they always do, and right here nothing settles.',
    values: { coupling: 2 },
  },
  {
    id: 'in-step',
    label: 'In step',
    caption: 'Twice the tipping point and the crowd collapses into one clump, with the arrow settling on 0.707.',
    values: { coupling: 4 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'London’s Millennium Bridge opened on 10 June 2000, swayed under crowds who unconsciously fell into step with its ' +
      'own wobble, closed two days later, and reopened in February 2002 after Strogatz and colleagues modelled the ' +
      'walkers as coupled oscillators that tip into step past a crowd of about 160 people.',
    source: {
      label: 'Strogatz, Abrams, McRobie, Eckhardt and Ott, “Crowd synchrony on the Millennium Bridge”, Nature 438 (2005), 43–44',
      url: 'https://doi.org/10.1038/438043a',
    },
  },
  {
    text: [
      'The tipping point does not depend on how many oscillators there are, only on how spread out their natural ',
      'speeds are: for the bell-less Cauchy spread used here it is exactly twice the half-width, ',
      { v: 'Kc' }, ' = 2', { v: 'γ' }, ', and above it the reading is ',
      { v: 'r' }, ' = √(1 − ', { v: 'Kc' }, '/', { v: 'K' }, ') with no approximation anywhere in it.',
    ],
    source: {
      label: 'Kuramoto, Chemical Oscillations, Waves, and Turbulence (1984), ch. 5; Kuramoto model',
      url: 'https://en.wikipedia.org/wiki/Kuramoto_model',
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

/** The crowd this run will carry, clamped the way the swarm clamps its own. */
function crowdSize(values: ParamValues): number {
  return Math.max(
    MIN_OSCILLATORS,
    Math.min(MAX_OSCILLATORS, Math.floor(num(values, 'count', DEFAULT_OSCILLATORS))),
  );
}

/** The coupling this run will use, clamped to the control's own range. */
function couplingOf(values: ParamValues): number {
  return Math.max(0, Math.min(MAX_COUPLING, num(values, 'coupling', DEFAULT_COUPLING)));
}

/** Slots on the coupling control, so a trail of past readings needs no map. */
const COUPLING_SLOTS = Math.round(MAX_COUPLING / COUPLING_STEP) + 1;

function couplingSlot(coupling: number): number {
  return Math.min(COUPLING_SLOTS - 1, Math.max(0, Math.round(coupling / COUPLING_STEP)));
}

/** Pixel size out of a CSS font shorthand, for sizing a display window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

function create(ctx: VizContext): VizInstance {
  const swarm = new Swarm(MAX_OSCILLATORS);
  const average = new SettledOrder();

  /**
   * Every reading this instance has settled on, one slot per position of the
   * coupling control, with the coupling it was measured at beside it.
   *
   * Allocated once at the slot count rather than grown, and kept across a
   * change of coupling on purpose: creeping the control up and leaving a trail
   * of readings along the analytic curve is the whole moment of the tab. A new
   * crowd or a new seed is a different experiment and clears it.
   */
  const trail = new Float64Array(COUPLING_SLOTS).fill(NaN);
  const trailAt = new Float64Array(COUPLING_SLOTS).fill(NaN);

  let coupling = DEFAULT_COUPLING;
  let layout = layoutPlate(ctx.width, ctx.height);
  let dial = dialScale(layout.dial);
  let scale = plotScale(layout.plot ?? layout.dial);

  /** Model time since the run — or the current coupling — began. */
  let modelTime = 0;
  /** Fractional steps owed by the rate accumulator between ticks. */
  let pending = 0;

  const threshold = criticalCoupling(HALF_WIDTH);

  function syncLayout(): void {
    layout = layoutPlate(ctx.width, ctx.height);
    dial = dialScale(layout.dial);
    scale = plotScale(layout.plot ?? layout.dial);
  }

  /**
   * Restart the measurement without disturbing the crowd.
   *
   * The trail entry for the coupling now in force goes with it, so a slot never
   * shows a reading that is no longer the one being taken — moving the control
   * away and back would otherwise leave the old dot on the plot for the frame
   * between the change and the first step.
   */
  function restartAveraging(): void {
    modelTime = 0;
    pending = 0;
    average.reset();
    const slot = couplingSlot(coupling);
    trail[slot] = NaN;
    trailAt[slot] = NaN;
  }

  function readouts(): Readout[] {
    const n = swarm.count;
    const target = analyticOrder(coupling, HALF_WIDTH);
    const bar = orderUncertainty(coupling, HALF_WIDTH, n);
    const predicted = hasPrediction(coupling, HALF_WIDTH, n);
    return [
      {
        key: 'order',
        label: 'Order parameter r',
        value: average.mean,
        digits: 4,
        headline: true,
        plain: 'how together they are',
        // Three bars, where a bar is the quenched sampling error of this
        // crowd's own draw of speeds (above the tipping point) or the floor a
        // crowd of this size reads (below it). The ledger's 1% default is the
        // wrong bet by an order of magnitude either way: at four hundred
        // oscillators the honest bar at K = 4 is 0.030, four times the 1% of
        // 0.707 it would otherwise be held to, and a perfectly correct run
        // would read "still settling" for ever. The same three bars decide
        // whether there is a prediction to quote at all, so the two can never
        // disagree about what this reading is being held to.
        ...(predicted
          ? {
              target,
              tolerance: target > 0 ? (BAND_SIGMAS * bar) / target : BAND_SIGMAS * bar,
              formula: ['√(1 − 2', { v: 'γ' }, '/', { v: 'K' }, ')'] as const,
            }
          : {
              hint: 'the wobble in a crowd this size is as big as the answer here, so nothing settles on a sharp value',
            }),
      },
      {
        key: 'threshold',
        label: 'Critical coupling Kc',
        value: threshold,
        digits: 3,
        plain: 'the tipping point',
      },
      { key: 'count', label: 'Oscillators', value: n, digits: 5, plain: 'fireflies in the crowd' },
      { key: 'coupling', label: 'Coupling K', value: coupling, digits: 3, expertOnly: true },
      { key: 'live', label: 'Instantaneous r', value: swarm.order, digits: 4, expertOnly: true },
      {
        key: 'averaged',
        label: 'Time averaged over',
        value: Math.max(0, modelTime - SETTLE_TIME),
        digits: 4,
        expertOnly: true,
      },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      pending += (STEPS_PER_SECOND * dt) / 1000;
      // The crowd is drawn once at reset and the dynamics are deterministic, so
      // a step consumes nothing from the stream: batching ticks differently
      // cannot change the run, only when it is looked at.
      while (pending >= 1) {
        swarm.advance(STEP_H, coupling);
        modelTime += STEP_H;
        // `swarm.order` is the field of the state the step started from, so
        // every sample is a state the crowd really passed through.
        if (modelTime >= SETTLE_TIME) average.push(swarm.order);
        pending -= 1;
      }
      const slot = couplingSlot(coupling);
      trail[slot] = average.mean;
      trailAt[slot] = coupling;
    },

    drawBackground() {
      // Resize lands here; so does a refused parameter change. Both move
      // everything. The coupling does not: the curve, the axis and the
      // threshold are functions of γ alone, which is why a change of coupling
      // can be absorbed without repainting this layer.
      syncLayout();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);

      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;

      // The ring the phases live on. It is the experiment's own geometry — a
      // phase is a point on this circle and can be nowhere else — so it takes
      // the apparatus pen, at 2 px, the same call Monte Carlo π makes for the
      // circle its darts are counted against.
      bg.strokeStyle = theme.grid;
      bg.lineWidth = 2 * theme.lineWidth;
      bg.beginPath();
      bg.arc(dial.cx, dial.cy, dial.radius, 0, TAU);
      bg.stroke();

      // The centre the arrow grows from: furniture, and the one place on the
      // dial where a reader needs a fixed point of reference.
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      bg.moveTo(Math.round(dial.cx - 4) + snap, Math.round(dial.cy) + snap);
      bg.lineTo(Math.round(dial.cx + 4) + snap, Math.round(dial.cy) + snap);
      bg.moveTo(Math.round(dial.cx) + snap, Math.round(dial.cy - 4) + snap);
      bg.lineTo(Math.round(dial.cx) + snap, Math.round(dial.cy + 4) + snap);
      bg.stroke();

      if (!layout.plot) return;
      paintPlotFurniture(bg, snap);
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // The crowd: one path, one fill, no style change per dot. The stride is
      // what keeps a two-thousand-strong crowd from painting as a solid band —
      // every oscillator is still stepped and still counted.
      const r = theme.particleRadius;
      const stride = paintStride(dial, swarm.count, r);
      fg.fillStyle = theme.data1;
      fg.beginPath();
      swarm.forEach((phase, offset) => {
        const x = phaseX(dial, phase, offset);
        const y = phaseY(dial, phase, offset);
        fg.moveTo(x + r, y);
        fg.arc(x, y, r, 0, TAU);
      }, stride);
      fg.fill();

      // The arrow is the average of those dots as one vector, and its length is
      // the reading — the rare case where the number and the picture are the
      // same object. It takes the drafting pen rather than the signal one
      // because it is the quantity the curve below predicts, and the halo
      // because it crosses the crowd it is the average of, which the signal pen
      // clears by only 1.96:1.
      const length = swarm.order * dial.radius;
      if (length > 0.5) {
        const psi = swarm.heading;
        const tipX = dial.cx + length * Math.cos(psi);
        const tipY = dial.cy - length * Math.sin(psi);
        const head = Math.min(HEAD_LENGTH, length / 2);
        fg.lineJoin = 'round';
        fg.lineCap = 'butt';
        fg.beginPath();
        fg.moveTo(dial.cx, dial.cy);
        fg.lineTo(tipX, tipY);
        fg.lineTo(tipX - head * Math.cos(psi - HEAD_ANGLE), tipY + head * Math.sin(psi - HEAD_ANGLE));
        fg.moveTo(tipX, tipY);
        fg.lineTo(tipX - head * Math.cos(psi + HEAD_ANGLE), tipY + head * Math.sin(psi + HEAD_ANGLE));
        strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);
      }

      if (layout.plot) paintTrail(fg);
      paintWindow(fg);
      ctx.emit(readouts());
    },

    onParamChange(key) {
      switch (key) {
        case 'coupling': {
          // Absorbed, and the only parameter on this tab that is. Creeping the
          // control up through the threshold and watching the crowd gather is
          // the moment the tab exists for, and restarting it on every step of
          // the fader would replace that with a series of unrelated runs. The
          // crowd keeps its speeds and its phases and responds to the new pull
          // exactly as the model says it should; only the measurement starts
          // again, because an average across two couplings measures neither.
          coupling = couplingOf(ctx.params);
          restartAveraging();
          return true;
        }
        default:
          // count, seed: a different crowd, drawn from a different stretch of
          // the stream. The shell resets.
          return false;
      }
    },

    reset() {
      coupling = couplingOf(ctx.params);
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      swarm.populate(ctx.rng, crowdSize(ctx.params), HALF_WIDTH);
      restartAveraging();
      trail.fill(NaN);
      trailAt.fill(NaN);
      syncLayout();
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  /**
   * The plot's frame, axis, caption, key, threshold and analytic curve.
   *
   * All of it is static — it depends on γ and on the plate, and on nothing that
   * moves — so all of it belongs on the background layer, repainted only on a
   * resize. That includes the key, unusually: the top-left corner of this box
   * is the one region no mark can reach, because the curve is zero to the left
   * of the threshold and the readings sit on the curve, so a key there is never
   * painted over even though the readings are on the layer above.
   */
  function paintPlotFurniture(bg: CanvasRenderingContext2D, snap: number): void {
    const { theme } = ctx;
    const box = scale.box;
    const left = Math.round(box.x) + snap;
    const top = Math.round(box.y) + snap;
    const right = Math.round(box.x + box.width) + snap;
    const bottom = Math.round(box.y + box.height) + snap;

    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.beginPath();
    bg.moveTo(left, top);
    bg.lineTo(left, bottom);
    bg.lineTo(right, bottom);
    bg.lineTo(right, top);
    bg.lineTo(left, top);
    // Ticks hang outside the box: the plot needs a scale, not a lattice of
    // rules across the two things it exists to compare.
    for (let k = 0; k <= MAX_COUPLING; k++) {
      const x = Math.round(plotX(scale, k)) + snap;
      bg.moveTo(x, bottom);
      bg.lineTo(x, bottom + TICK);
    }
    for (const v of [0, 0.5, 1]) {
      const y = Math.round(plotY(scale, v)) + snap;
      bg.moveTo(left - TICK, y);
      bg.lineTo(left, y);
    }
    bg.stroke();

    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    // Numerals thin out rather than collide: "0" is about 7 px wide at the
    // label size, and a five-mark axis on a phone gives each mark 58.
    const everyX = box.width / MAX_COUPLING >= 26 ? 1 : 2;
    bg.textAlign = 'center';
    bg.textBaseline = 'top';
    for (let k = 0; k <= MAX_COUPLING; k += everyX) {
      bg.fillText(String(k), plotX(scale, k), bottom + TICK + LABEL_GAP);
    }
    bg.textAlign = 'right';
    bg.textBaseline = 'middle';
    for (const v of [0, 0.5, 1]) {
      bg.fillText(v === 0 ? '0' : v.toFixed(1), left - TICK - LABEL_GAP, plotY(scale, v));
    }
    // The caption is dropped rather than clipped on a box too narrow for it:
    // `fillText` does not wrap and does not stop at the plate's edge, so a
    // caption that does not fit runs off the paper.
    const caption = 'together vs coupling';
    if (bg.measureText(caption).width <= box.width) {
      bg.textAlign = 'left';
      bg.textBaseline = 'bottom';
      bg.fillText(caption, box.x, box.y - LABEL_GAP);
    }

    // The threshold, dashed so it reads as a boundary rather than as a second
    // measurement. Drawn before the curve, whose foot stands on it.
    bg.save();
    bg.setLineDash([4, 4]);
    bg.strokeStyle = theme.data2;
    bg.lineWidth = 2 * theme.lineWidth;
    bg.beginPath();
    bg.moveTo(Math.round(plotX(scale, threshold)) + snap, plotY(scale, 0, HALO_PAD));
    bg.lineTo(Math.round(plotX(scale, threshold)) + snap, plotY(scale, 1, HALO_PAD));
    bg.stroke();
    bg.restore();

    // The analytic curve, sampled along `r` rather than along `K`: it leaves
    // the axis with infinite slope, so equal steps in K put the first segment a
    // tenth of the way up the box in one jump and the corner reads as a kink in
    // the mathematics rather than in the sampling.
    const rMax = analyticOrder(MAX_COUPLING, HALF_WIDTH);
    bg.lineJoin = 'round';
    bg.beginPath();
    bg.moveTo(plotX(scale, 0), plotY(scale, 0, HALO_PAD));
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const v = (i / CURVE_STEPS) * rMax;
      bg.lineTo(plotX(scale, threshold / (1 - v * v)), plotY(scale, v, HALO_PAD));
    }
    strokeWithHalo(bg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);

    paintKey(bg);
  }

  /** Two line samples and a dashed one, in the corner of the box nothing reaches. */
  function paintKey(bg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const box = scale.box;
    const rows: ReadonlyArray<[string, string, boolean]> = [
      ['measured', theme.data1, false],
      ['predicted', theme.data2, false],
      ['tipping point', theme.data2, true],
    ];
    const sample = 14;
    const gap = 5;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    bg.font = theme.labelFont;
    let textW = 0;
    for (const [text] of rows) textW = Math.max(textW, bg.measureText(text).width);
    const w = sample + gap + textW;
    const h = rows.length * step;
    // A key that does not fit would sit on the curve, which is worse than none.
    if (w > box.width - 20 || h > box.height - 20) return;

    const x = box.x + 8;
    const y = box.y + 6;
    bg.textAlign = 'left';
    bg.textBaseline = 'middle';
    bg.lineWidth = 2 * theme.lineWidth;
    rows.forEach(([text, pen, dashed], i) => {
      // The samples are 2 px, an even width, so they sit on whole pixels
      // without the half-pixel offset an odd one would need.
      const cy = Math.round(y + i * step + textH / 2);
      bg.save();
      if (dashed) bg.setLineDash([4, 4]);
      bg.strokeStyle = pen;
      bg.beginPath();
      bg.moveTo(x, cy);
      bg.lineTo(x + sample, cy);
      bg.stroke();
      bg.restore();
      bg.fillStyle = theme.ink;
      bg.fillText(text, x + sample + gap, cy);
    });
  }

  /**
   * Every reading this run has settled on, as a dot on the plot.
   *
   * Each one is laid on an opaque disc of the plate colour first. The readings
   * land on the analytic curve by construction and the two pens are 1.96:1
   * apart, so without it the agreement the tab is built to show would be a
   * vermilion dot lost in a blue-black line. It is the halo of §7, drawn as a
   * disc because the mark is one.
   */
  function paintTrail(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const r = theme.particleRadius;
    const here = couplingSlot(coupling);
    for (const [pen, extra] of [
      [theme.canvas, 1.5],
      [theme.data1, 0],
    ] as const) {
      fg.fillStyle = pen;
      fg.beginPath();
      for (let i = 0; i < COUPLING_SLOTS; i++) {
        const value = trail[i] ?? NaN;
        if (!Number.isFinite(value)) continue;
        // The reading being taken right now is drawn a shade larger, so the
        // trail says where the crowd has been and the dot says where it is.
        const radius = r + extra + (i === here ? 1 : 0);
        const x = plotX(scale, trailAt[i] ?? 0);
        const y = plotY(scale, value, HALO_PAD);
        fg.moveTo(x + radius, y);
        fg.arc(x, y, radius, 0, TAU);
      }
      fg.fill();
    }
  }

  /**
   * The reading, in the dial's top-left corner — the one part of the square the
   * ring never reaches on a portrait split, and always clear of the arrow's
   * own quadrant often enough to stay legible.
   *
   * The window is opaque, because a crowd of dots reads straight through a
   * translucent one, and its frame takes the container pen: a window holds the
   * experiment's number, it is not part of the experiment. Published through
   * `emit()` as well — the canvas itself is aria-hidden.
   */
  function paintWindow(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const value = average.mean;
    const label = Number.isFinite(value) ? `r = ${value.toFixed(3)}` : 'r = —';
    const pad = 5;
    const margin = 8;
    const textH = fontPx(theme.labelFont);
    fg.font = theme.labelFont;
    // Measured from a template, never from the reading: a box sized by its own
    // digits is a box that twitches once a frame.
    const textW = fg.measureText(WINDOW_TEMPLATE).width;
    const x = Math.round(layout.dial.x + margin);
    const y = Math.round(layout.dial.y + margin);
    const w = Math.round(textW + 2 * pad);
    const h = Math.round(textH + 2 * pad);
    // On a small plate the corner is inside the ring, and a window over the
    // crowd is worse than no window: the reading is in the ledger and under the
    // plate either way, and the dots are the one thing that cannot be published
    // as text. The test is the nearest point of the window to the centre, not
    // its nearest corner — a rectangle whose corners both clear the band can
    // still have an edge cutting straight through it.
    const nearX = Math.min(Math.max(dial.cx, x), x + w);
    const nearY = Math.min(Math.max(dial.cy, y), y + h);
    const reach = dial.radius * (1 + RING_BAND) + theme.particleRadius;
    if (Math.hypot(nearX - dial.cx, nearY - dial.cy) < reach) return;
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    fg.fillStyle = theme.canvas;
    fg.fillRect(x, y, w, h);
    fg.strokeStyle = theme.gridSoft;
    fg.lineWidth = theme.lineWidth;
    // Inset by half a line width so the frame lands inside the plate it draws.
    fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);
    fg.fillStyle = theme.ink;
    fg.textAlign = 'left';
    fg.textBaseline = 'top';
    fg.fillText(label, x + pad, y + pad);
  }

  instance.reset();
  return instance;
}

export const kuramoto: Viz = {
  id: 'kuramoto',
  title: 'Coupled Oscillators',
  group: 'waves',
  blurb: 'Lets a crowd of fireflies nudge one another, and past one exact strength of nudge they all flash together.',
  // Landscape, because the plate holds two panels: a square of oscillators and
  // the plot of the reading against the coupling beside it. Portrait on a
  // phone, where the plot goes under the crowd instead.
  aspect: 1.6,
  aspectNarrow: 0.7,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_OSCILLATORS },
  create,
};
