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
  GASES,
  MEAN_FACTOR,
  RMS_FACTOR,
  RMS_SD_FACTOR,
  SPEED_SD_FACTOR,
  SpeedTally,
  fasterThanSound,
  gasById,
  speedTail,
  thermalScale,
  type Gas,
} from './gas';
import {
  FRAME,
  LABEL_GAP,
  PORT_GAP,
  SLOTS,
  SLOT_SPEED,
  TICK,
  TOP_SPEED,
  createMachine,
  hopperGrid,
  layoutPlate,
  restSlot,
  slotShare,
  type HopperGrid,
  type PlateLayout,
} from './sim';

/** Hard ceiling on beads; the Beads fader tops out here too. */
export const MAX_BEADS = 5_000;

/** Grain of the Beads fader, for the reason the Galton board gives for its balls. */
export const BEADS_STEP = 50;
const DEFAULT_BEADS = 1_200;
const DEFAULT_SEED = 42;
const DEFAULT_GAS = 'nitrogen';

/**
 * The temperature fader, kelvin. 200 K is the bottom because every gas on
 * offer is still a gas there; 700 K the top because nitrogen at 700 K is the
 * fastest bead the machine is built for — 2.4 beads in ten thousand clear the
 * far wall at 2,000 m/s, and a hotter or lighter gas would stack a visible
 * pile against it. Ten kelvin a step: fifty stops is a fader a hand can drive.
 */
export const MIN_TEMPERATURE = 200;
export const MAX_TEMPERATURE = 700;
export const TEMPERATURE_STEP = 10;
const DEFAULT_TEMPERATURE = 300;

/**
 * The stream is paced so a run takes about this long whatever the bead count,
 * between a floor that keeps fifty beads from trickling and a ceiling that
 * keeps five thousand from becoming a blur — the Galton board's three numbers.
 */
export const RUN_SECONDS = 12;
const MIN_LAUNCH_RATE = 2;
const MAX_LAUNCH_RATE = 400;

/**
 * Alpha removed from the foreground each frame in the open air above the
 * slots, so a bead leaves a short wake and a run shows its arcs: a flat one
 * for a fast bead, a steep one for a slow bead. The Galton board's fade.
 */
const TRAIL_FADE = 0.1;

/**
 * Most resting beads drawn as dots per frame, across all slots. A pile above
 * its share of the budget is a bar with dots up to its share — the Galton
 * board's rule, except that the share follows the law rather than being the
 * same for every slot: the law is lopsided, and the tall slots near the hump
 * are the ones that need the dots.
 */
const DOT_BUDGET = 4_000;
const MIN_DOTS_PER_SLOT = 20;

/**
 * Room above the tallest pile and the tallest bar the law predicts, as a
 * factor. A pile's count fluctuates by √(n·q) about n·q, under 4% of the tallest
 * at five thousand beads, so 1.15 keeps the piles inside the slots. A bar is a
 * share, and at fifty beads a share fluctuates by a third of itself, so the
 * chart keeps the arcsine tab's 1.3 and clamps the rest.
 */
const HEADROOM = 1.15;
const CHART_HEADROOM = 1.3;

/** The fan: revolutions per second while beads remain, and seconds it takes to spin down. */
const SPIN = 1.6;
const SPIN_DOWN_S = 1.2;
const BLADES = 7;

/** Speeds at which the chart's axis is numbered, m/s. */
const AXIS_STEP = 500;

/** Dash of the speed-of-sound marker, CSS px. A reference line, not a mark of the data. */
const MARKER_DASH = [4, 3];

const TAU = 2 * Math.PI;

const params: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'gas',
    label: 'Gas',
    options: GASES.map((g) => ({ value: g.id, label: g.label })),
    default: DEFAULT_GAS,
    help: 'What the beads stand for. Heavier molecules move slower at the same temperature.',
  },
  {
    kind: 'range',
    key: 'temperature',
    label: 'Temperature',
    min: MIN_TEMPERATURE,
    max: MAX_TEMPERATURE,
    step: TEMPERATURE_STEP,
    default: DEFAULT_TEMPERATURE,
    unit: 'K',
    help: 'In kelvin: water freezes at 273 K and a warm room is 300 K.',
  },
  {
    kind: 'range',
    key: 'beads',
    label: 'Beads',
    // Fifty at a time from fifty, so every round hundred is on the grid and a
    // permalink asking for 1,200 runs 1,200 — the Galton board's argument.
    min: BEADS_STEP,
    max: MAX_BEADS,
    step: BEADS_STEP,
    default: DEFAULT_BEADS,
    log: true,
    help: 'Molecules fired before the hopper runs out, fifty at a time.',
  },
  // Not a control: the rail skips seed specs, and "the same gas, another
  // draw" is the transport's Shuffle key. Declared so a permalink carries it.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'room-air',
    label: 'Room air',
    caption:
      'Nitrogen, four-fifths of the air, at room temperature: about half the beads fly between 300 and 600 m/s, ' +
      'and one in a hundred tops 1,000 m/s.',
    values: { gas: 'nitrogen', temperature: 300, beads: 5_000 },
  },
  {
    id: 'pizza-oven',
    label: 'Pizza oven',
    caption:
      'Heat the same gas to 700 K, a wood-fired pizza oven, and the hump slides right and spreads out: ' +
      'the average bead now flies half again as fast.',
    values: { gas: 'nitrogen', temperature: 700, beads: 5_000 },
  },
  {
    id: 'xenon',
    label: 'Xenon',
    caption:
      'Xenon atoms weigh almost five times as much as nitrogen molecules, so at the same temperature they fly at ' +
      'under half the speed and crowd into the first few slots.',
    values: { gas: 'xenon', temperature: 300, beads: 5_000 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'James Clerk Maxwell found this curve in 1860 by assuming that the three parts of a molecule’s velocity — ' +
      'left–right, up–down and front–back — are independent bell curves, and asking how long the arrow they add up to is.',
    source: {
      label: 'Maxwell, “Illustrations of the dynamical theory of gases”, Philosophical Magazine 19 (1860), 19–32, Prop. IV',
      url: 'https://en.wikipedia.org/wiki/Maxwell%E2%80%93Boltzmann_distribution',
    },
  },
  {
    text:
      'Sound in a gas is carried by the gas’s own molecules, and it travels slower than most of them: at any ' +
      'temperature, about 71% of nitrogen molecules and 64% of argon or xenon atoms outrun the sound they carry.',
    source: {
      label: 'Speed of sound in an ideal gas, c = √(γkT/m); Wikipedia, Speed of sound',
      url: 'https://en.wikipedia.org/wiki/Speed_of_sound#Speed_of_sound_in_ideal_gases_and_air',
    },
  },
  {
    text:
      'Ludwig Boltzmann showed in 1872 that collisions between molecules drive a gas toward this curve from any ' +
      'starting mix of speeds, and keep it there once it arrives.',
    source: {
      label:
        'Boltzmann, “Weitere Studien über das Wärmegleichgewicht unter Gasmolekülen”, Sitzungsberichte der ' +
        'Akademie der Wissenschaften Wien 66 (1872), 275–370 — the H-theorem',
      url: 'https://en.wikipedia.org/wiki/H-theorem',
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

/** Beads this run fires: on the fader's grid, as a permalink may not be. */
export function beadsFor(values: ParamValues): number {
  return onGrid(num(values, 'beads', DEFAULT_BEADS), BEADS_STEP, MAX_BEADS, BEADS_STEP);
}

/** Temperature this run is at, kelvin, on the fader's grid. */
export function temperatureFor(values: ParamValues): number {
  return onGrid(num(values, 'temperature', DEFAULT_TEMPERATURE), MIN_TEMPERATURE, MAX_TEMPERATURE, TEMPERATURE_STEP);
}

export function gasFor(values: ParamValues): Gas {
  return gasById(values['gas'] ?? DEFAULT_GAS);
}

/** a = √(kT/m) for this run, m/s. */
export function scaleFor(values: ParamValues): number {
  return thermalScale(temperatureFor(values), gasFor(values).mass);
}

/** Beads per second that empty a hopper of `beads` in about RUN_SECONDS. */
export function launchRateFor(beads: number): number {
  return Math.min(MAX_LAUNCH_RATE, Math.max(MIN_LAUNCH_RATE, beads / RUN_SECONDS));
}

/**
 * The share of beads the law puts in a window one slot wide centred on `v`.
 *
 * This is the chart's curve, and it is a window rather than the density times
 * a slot's width so that it passes through the top of every bar the law
 * predicts — exactly, at each slot's centre — where the density would sit
 * 6.6% under the narrow hump of cold xenon. The last slot reaches past the far
 * wall, so at its centre the window does too.
 */
export function analyticBarShare(v: number, a: number): number {
  const half = SLOT_SPEED / 2;
  const hi = v + half;
  return speedTail(v - half, a) - (hi >= TOP_SPEED ? 0 : speedTail(hi, a));
}

/**
 * How the piles are drawn, fixed for a run so dots, bars and silhouettes share
 * one vertical scale: the Galton board's pile metrics, slot for bin.
 *
 * `unit` is pixels of pile height per bead. Resting beads sit in a grid of
 * `cols` per row, so a row stands cols·unit tall and the dot is half that. The
 * scale is the smaller of what dots of the derived radius occupy and what the
 * slot depth allows the expected tallest pile.
 */
export interface Pile {
  radius: number;
  cols: number;
  unit: number;
  /** Dots drawn per slot before the bar alone carries the count. */
  caps: Float64Array;
  /** The law's share for each slot, and the largest of them. */
  shares: Float64Array;
  peak: number;
}

export function pileMetrics(L: PlateLayout, a: number, beads: number, particleRadius: number): Pile {
  const shares = new Float64Array(SLOTS);
  const caps = new Float64Array(SLOTS);
  let peak = 0;
  for (let k = 0; k < SLOTS; k++) {
    const q = slotShare(k, a);
    shares[k] = q;
    caps[k] = Math.ceil(DOT_BUDGET * q * HEADROOM) + MIN_DOTS_PER_SLOT;
    if (q > peak) peak = q;
  }
  const tallest = Math.max(1, beads * peak * HEADROOM);
  const depth = Math.max(1, L.depth);
  const area = Math.max(1, L.slotWidth * depth);
  // A c-bead pile occupies c·(2r)² of slot, so r = ½·√(area / tallest) fills it.
  let radius = 0.5 * Math.sqrt(area / tallest);
  radius = Math.min(particleRadius, Math.max(0.5, radius));
  const cols = Math.max(1, Math.floor(L.slotWidth / (2 * radius)));
  // Lay the dot grid out from the scale rather than the other way round, as
  // the Galton board does: a clamped radius would otherwise stand a pile at a
  // different height from the bar behind it.
  const unit = Math.min((2 * radius) / cols, depth / tallest);
  return { radius: (cols * unit) / 2, cols, unit, caps, shares, peak };
}

function create(ctx: VizContext): VizInstance {
  let beads = beadsFor(ctx.params);
  let gas = gasFor(ctx.params);
  let scale = scaleFor(ctx.params);
  const sim = createMachine(ctx.rng, { beads, launchRate: launchRateFor(beads), scale }, MAX_BEADS);
  const tally = new SpeedTally(scale * Math.sqrt(gas.gamma));

  let layout = layoutPlate(ctx.width, ctx.height);
  let pile = pileMetrics(layout, scale, beads, ctx.theme.particleRadius);
  let hopper: HopperGrid = hopperGrid(layout, beads, ctx.theme.particleRadius);

  // This frame's pile and bar heights, so a wash and its silhouette cannot
  // disagree by a pixel. Allocated once, at the slot count.
  const pileH = new Float64Array(SLOTS);
  const barH = new Float64Array(SLOTS);

  function syncStructure(): void {
    beads = beadsFor(ctx.params);
    gas = gasFor(ctx.params);
    scale = scaleFor(ctx.params);
  }

  function syncLayout(): void {
    // From the parameters, not from the machine: the shell may call this
    // before or after reset() on a change, and both must leave the same plate.
    syncStructure();
    layout = layoutPlate(ctx.width, ctx.height);
    pile = pileMetrics(layout, scale, beads, ctx.theme.particleRadius);
    hopper = hopperGrid(layout, beads, ctx.theme.particleRadius);
    sim.setGeometry({
      slotWidth: layout.slotWidth,
      drop: layout.drop,
      depth: layout.depth,
      beadRadius: ctx.theme.particleRadius,
      dotRadius: pile.radius,
      cols: pile.cols,
      // The machine measures from the port's exit.
      hopper: { ...hopper, left: hopper.left - layout.slotLeft, bottom: hopper.bottom - layout.portY },
    });
  }

  /** Machine units → CSS px. */
  function px(x: number): number {
    return layout.slotLeft + x * layout.slotWidth;
  }
  function py(y: number): number {
    return layout.portY + y * layout.drop;
  }

  /** CSS px across the chart for a speed in m/s. */
  function speedX(v: number): number {
    return layout.slotLeft + (v / TOP_SPEED) * (layout.slotRight - layout.slotLeft);
  }

  function soundSpeed(): number {
    return scale * Math.sqrt(gas.gamma);
  }

  /** The fan's angle, radians: turning while beads remain, then spinning down. */
  function fanAngle(): number {
    const t = sim.time / 1000;
    const emptied = sim.emptiedAt / 1000;
    if (t <= emptied) return TAU * SPIN * t;
    const d = Math.min(t - emptied, SPIN_DOWN_S);
    return TAU * SPIN * (emptied + d - (d * d) / (2 * SPIN_DOWN_S));
  }

  function readouts(): Readout[] {
    const n = tally.n;
    const a = scale;
    const share = fasterThanSound(gas.gamma);
    return [
      { key: 'landed', label: 'Beads landed', value: sim.landed, digits: 6, plain: 'beads landed' },
      // The hopper's level, as a number. It is also what tells the shell the
      // run is under way in its first second, before any bead has reached a
      // slot: a reduced-motion settle stops at the first batch in which no
      // published number moves, and without this one that was the first batch.
      { key: 'fired', label: 'Beads fired', value: sim.launched, digits: 6, expertOnly: true },
      // §5: the hero prints "analytic" and the closed form the target came
      // from, with k, T, π and m set in italic like every other variable.
      {
        key: 'mean',
        label: 'Mean speed',
        value: tally.mean,
        unit: 'm/s',
        digits: 3,
        target: a * MEAN_FACTOR,
        formula: ['√(8', { v: 'k' }, { v: 'T' }, '/', { v: 'π' }, { v: 'm' }, ')'],
        // One speed has standard deviation √(3 − 8/π)·a, 42% of the mean, and
        // the ledger divides by the beads that have landed — so the row is
        // still settling until about 640 beads are down, and from there it is
        // a test a broken machine would fail.
        band: { kind: 'sampled', sigma: a * SPEED_SD_FACTOR, samples: n },
        plain: 'average speed of a molecule',
        headline: true,
        hint: 'set by the temperature and the mass of one molecule, and by nothing else',
      },
      {
        key: 'rms',
        label: 'Root-mean-square speed',
        value: tally.rms,
        unit: 'm/s',
        digits: 3,
        target: a * RMS_FACTOR,
        formula: ['√(3', { v: 'k' }, { v: 'T' }, '/', { v: 'm' }, ')'],
        band: { kind: 'sampled', sigma: a * RMS_SD_FACTOR, samples: n },
        plain: 'typical speed, weighted toward the fast ones',
      },
      {
        key: 'supersonic',
        label: 'Faster than sound',
        value: tally.shareAbove,
        digits: 4,
        target: share,
        formula: [
          'erfc(√(', { v: 'γ' }, '/2)) + √(2', { v: 'γ' }, '/', { v: 'π' }, ')·e^(−', { v: 'γ' }, '/2)',
        ],
        // Three standard errors of a proportion over the beads landed so far.
        // NaN before the first, which the ledger reads as no band at all.
        band: { kind: 'absolute', half: n > 0 ? 3 * Math.sqrt((share * (1 - share)) / n) : Number.NaN },
        range: [0, 1],
        plain: 'share of molecules faster than sound',
      },
      // The marker on the chart, as a number: the plate draws it, so it is
      // published. A property of the gas, not a measurement, so no target.
      { key: 'sound', label: 'Speed of sound', value: soundSpeed(), unit: 'm/s', digits: 3, expertOnly: true },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      sim.step(dt);
      // Beads cross the mouths in release order, so the measured ones are a
      // prefix of the speeds and the tally only ever catches up.
      while (tally.n < sim.landed) tally.push(sim.speedOf(tally.n));
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the plate.
      syncLayout();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      const L = layout;
      bg.clearRect(0, 0, width, height);

      // An odd-width line centred on a half pixel covers whole device pixels.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const frameWidth = FRAME * theme.lineWidth;
      const frameSnap = frameWidth % 2 === 1 ? 0.5 : 0;
      const left = Math.round(L.left);
      const right = Math.round(L.right);
      const lid = Math.round(L.lid);
      const floor = Math.round(L.floor);
      const wall = Math.round(L.slotLeft - frameWidth / 2) + frameSnap;
      const mouth = Math.round(L.mouthY) + snap;

      // Everything here contains the experiment rather than being part of it
      // — the case, the wall, the dividers, the mesh, the fan's chamber — so
      // it all takes the container pen (DESIGN §7). The rotor is drawn in the
      // apparatus pen on the foreground, because it turns.
      bg.strokeStyle = theme.gridSoft;
      bg.lineJoin = 'miter';
      bg.lineWidth = frameWidth;
      bg.strokeRect(left + frameSnap, lid + frameSnap, right - left, floor - lid);

      // The wall, from the floor to the port: the gap between its top and the
      // lid is the port, and every bead leaves through it.
      bg.beginPath();
      bg.moveTo(wall, floor);
      bg.lineTo(wall, Math.round(L.lid + PORT_GAP));
      bg.stroke();

      // The dividers between the slots, rising from the floor to the mouths,
      // as hairlines painted under the piles: a comb of empty compartments
      // above the beads, the Galton board's bins.
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (let k = 1; k < SLOTS; k++) {
        const x = Math.round(L.slotLeft + k * L.slotWidth) + snap;
        bg.moveTo(x, mouth);
        bg.lineTo(x, floor);
      }
      bg.stroke();

      // The mesh the hopper's beads rest on, which the fan blows through.
      const meshY = Math.round(L.mesh) + snap;
      bg.setLineDash([3, 3]);
      bg.beginPath();
      bg.moveTo(L.columnLeft, meshY);
      bg.lineTo(L.columnRight, meshY);
      bg.stroke();
      bg.setLineDash([]);

      // The fan's chamber and its housing.
      const inset = 4;
      bg.strokeRect(
        Math.round(L.columnLeft + inset) + snap,
        Math.round(L.fanTop) + snap,
        Math.round(L.columnRight - L.columnLeft - 2 * inset),
        Math.round(L.floor - L.fanTop - inset),
      );
      bg.beginPath();
      bg.arc(L.fanX, L.fanY, L.fanR, 0, TAU);
      bg.stroke();

      // The chart's baseline and its ticks, hanging below where a bar can
      // never cover them: a histogram needs a baseline and a scale.
      const base = Math.round(L.chartBase) + snap;
      bg.beginPath();
      bg.moveTo(L.slotLeft, base);
      bg.lineTo(L.slotRight, base);
      for (let v = 0; v <= TOP_SPEED; v += AXIS_STEP) {
        const x = Math.round(speedX(v)) + snap;
        bg.moveTo(x, base);
        bg.lineTo(x, base + TICK);
      }
      bg.stroke();

      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;
      // Numerals anchored so neither end can overhang the plate, and the unit
      // once, at the start of the scale, in the room under the hopper.
      const numeralY = base + TICK + LABEL_GAP;
      bg.textBaseline = 'top';
      for (let v = 0; v <= TOP_SPEED; v += AXIS_STEP) {
        bg.textAlign = v === 0 ? 'left' : v === TOP_SPEED ? 'right' : 'center';
        bg.fillText(String(v), speedX(v), numeralY);
      }
      bg.textAlign = 'right';
      bg.fillText('m/s', L.slotLeft - 2 * TICK, numeralY);

      // What the chart is, in the gap above it, at the far end: the label of
      // the speed-of-sound marker hangs at the near end, and under one another
      // the two stacked into a block that read as a single phrase.
      bg.textAlign = 'right';
      bg.textBaseline = 'bottom';
      bg.fillText('beads at each speed', L.slotRight, L.chartTop - LABEL_GAP);
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const L = layout;

      // A bead is in the air from release until it crosses the mouths, which is
      // exactly the span between being fired and being counted.
      const airborne = sim.launched > sim.landed;
      if (!ctx.reducedMotion && airborne) {
        // A transparent layer over the machine, so fading it removes alpha
        // rather than painting the plate over the background layer. Only while
        // something is flying: 8-bit alpha bottoms out at about 2%, and once
        // the last bead is down that floor would hang over the finished run as
        // a haze of every arc it flew — plain to see on the dark plate.
        fg.globalCompositeOperation = 'destination-out';
        fg.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`;
        fg.fillRect(0, 0, width, height);
        fg.globalCompositeOperation = 'source-over';
      } else {
        fg.clearRect(0, 0, width, height);
      }

      // Everything below the open air is redrawn in full every frame, so it is
      // cleared rather than faded: the column with its hopper and fan, the
      // slots with their piles, and the chart. Trails live in the air alone.
      const pad = 3 * theme.lineWidth;
      fg.clearRect(L.left, L.lid, L.slotLeft - L.left + pad, L.floor - L.lid + pad);
      fg.clearRect(L.slotLeft - pad, L.mouthY - pad, L.slotRight - L.slotLeft + 2 * pad, L.floor - L.mouthY + 2 * pad);
      fg.clearRect(0, L.floor + pad, width, height - L.floor - pad);

      const slots = sim.slots;
      const settled = sim.settledSlots;
      const w = L.slotWidth;

      // The piles are the Galton board's two marks and its dots: an opaque
      // graphite wash the vermilion dots read against, the dots, and a
      // full-opacity silhouette over both that carries the shape.
      fg.fillStyle = theme.data3Fill;
      for (let k = 0; k < SLOTS; k++) {
        const c = slots[k] ?? 0;
        const h = c === 0 ? 0 : Math.min(L.depth, c * pile.unit);
        pileH[k] = h;
        if (h > 0) fg.fillRect(L.slotLeft + k * w, L.floor - h, w, h);
      }

      // Every bead — in the hopper, in the air, in a pile — is one colour, so
      // one path and one fill.
      fg.fillStyle = theme.data1;
      fg.beginPath();
      const rd = pile.radius;
      for (let k = 0; k < SLOTS; k++) {
        const n = Math.min(settled[k] ?? 0, pile.caps[k] ?? 0);
        const cx = L.slotLeft + (k + 0.5) * w;
        for (let s = 0; s < n; s++) {
          const place = restSlot(pile.cols, rd, L.depth, s);
          const x = cx + place.dx;
          const y = L.mouthY + place.depth;
          fg.moveTo(x + rd, y);
          fg.arc(x, y, rd, 0, 2 * Math.PI);
        }
      }
      // `hopperPlace`, unrolled: up to five thousand beads a frame, and a
      // returned object apiece is five thousand allocations nobody needs.
      const remaining = Math.max(0, sim.target - sim.launched);
      const rh = hopper.radius;
      const hp = hopper.pitch;
      for (let j = 0; j < remaining; j++) {
        const x = hopper.left + ((j % hopper.cols) + 0.5) * hp;
        const y = hopper.bottom - (Math.floor(j / hopper.cols) + 0.5) * hp;
        fg.moveTo(x + rh, y);
        fg.arc(x, y, rh, 0, 2 * Math.PI);
      }
      const R = theme.particleRadius;
      sim.forEachActive((b) => {
        const x = px(b.x);
        const y = py(b.y);
        fg.moveTo(x + R, y);
        fg.arc(x, y, R, 0, 2 * Math.PI);
      });
      fg.fill();

      if (sim.landed > 0) {
        fg.strokeStyle = theme.data3;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'miter';
        fg.beginPath();
        fg.moveTo(L.slotLeft, L.floor);
        for (let k = 0; k < SLOTS; k++) {
          const y = L.floor - (pileH[k] ?? 0);
          fg.lineTo(L.slotLeft + k * w, y);
          fg.lineTo(L.slotLeft + (k + 1) * w, y);
        }
        fg.lineTo(L.slotRight, L.floor);
        fg.stroke();
      }

      // The rotor turns, so it lives here, in the apparatus pen: blades swept
      // back from the hub, and the hub.
      const angle = fanAngle();
      const fr = L.fanR;
      fg.strokeStyle = theme.grid;
      fg.lineWidth = 2 * theme.lineWidth;
      fg.lineCap = 'round';
      fg.beginPath();
      for (let b = 0; b < BLADES; b++) {
        const t0 = angle + (b * TAU) / BLADES;
        fg.moveTo(L.fanX + 0.24 * fr * Math.cos(t0), L.fanY + 0.24 * fr * Math.sin(t0));
        fg.quadraticCurveTo(
          L.fanX + 0.7 * fr * Math.cos(t0 + 0.3),
          L.fanY + 0.7 * fr * Math.sin(t0 + 0.3),
          L.fanX + 0.86 * fr * Math.cos(t0 + 0.75),
          L.fanY + 0.86 * fr * Math.sin(t0 + 0.75),
        );
      }
      fg.stroke();
      fg.lineCap = 'butt';
      fg.fillStyle = theme.grid;
      fg.beginPath();
      fg.arc(L.fanX, L.fanY, 0.16 * fr, 0, TAU);
      fg.fill();

      // The chart: each slot's share of the beads counted so far, on a scale
      // fixed for the run by the law's tallest bar — a scale that followed the
      // data would redraw the picture every time a bar overtook another.
      const n = sim.landed;
      const chartDepth = L.chartBase - L.chartTop;
      const chartUnit = chartDepth / (pile.peak * CHART_HEADROOM);
      fg.fillStyle = theme.data3Fill;
      for (let k = 0; k < SLOTS; k++) {
        const share = n > 0 ? (slots[k] ?? 0) / n : 0;
        const h = Math.min(chartDepth, share * chartUnit);
        barH[k] = h;
        if (h > 0) fg.fillRect(L.slotLeft + k * w, L.chartBase - h, w, h);
      }
      if (n > 0) {
        fg.strokeStyle = theme.data3;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'miter';
        fg.beginPath();
        fg.moveTo(L.slotLeft, L.chartBase);
        for (let k = 0; k < SLOTS; k++) {
          const y = L.chartBase - (barH[k] ?? 0);
          fg.lineTo(L.slotLeft + k * w, y);
          fg.lineTo(L.slotLeft + (k + 1) * w, y);
        }
        fg.lineTo(L.slotRight, L.chartBase);
        fg.stroke();
      }

      // The speed of sound in this gas at this temperature: a dashed reference
      // in the drafting pen, haloed where it crosses the bars, and labelled on
      // the side away from the hump, which always lies to its right.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const sx = Math.round(speedX(soundSpeed())) + snap;
      fg.setLineDash(MARKER_DASH);
      fg.beginPath();
      fg.moveTo(sx, L.chartBase);
      fg.lineTo(sx, L.chartTop);
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, theme.lineWidth, 2);
      fg.setLineDash([]);
      fg.font = theme.labelFont;
      fg.fillStyle = theme.inkMuted;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      fg.fillText('sound', sx - 2 * TICK, L.chartTop);

      // The law, as the share it puts in each slot, from the first slot's
      // centre to the last one's — where a window one slot wide still lies
      // inside the axis. The drafting pen over the plate colour, so it never
      // touches the wash or the silhouette it crosses.
      const first = L.slotLeft + w / 2;
      const last = L.slotRight - w / 2;
      const span = Math.max(1, last - first);
      const steps = Math.max(2, Math.ceil(span / 2));
      fg.lineJoin = 'round';
      fg.beginPath();
      for (let i = 0; i <= steps; i++) {
        const x = first + (span * i) / steps;
        const v = ((x - L.slotLeft) / (L.slotRight - L.slotLeft)) * TOP_SPEED;
        const h = Math.min(chartDepth, analyticBarShare(v, scale) * chartUnit);
        if (i === 0) fg.moveTo(x, L.chartBase - h);
        else fg.lineTo(x, L.chartBase - h);
      }
      strokeWithHalo(fg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);

      ctx.emit(readouts());
    },

    onParamChange() {
      // All three are structural. A new gas or temperature is a new law, and a
      // new bead count a new pile scale; the beads already down belong to
      // neither. The shell resets.
      return false;
    },

    reset() {
      // The seed is not a control, but it still names the run: the same seed
      // replays the same speeds, slots and arcs.
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      syncStructure();
      sim.setParams({ beads, launchRate: launchRateFor(beads), scale });
      sim.reset();
      tally.reset(soundSpeed());
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

export const maxwellBoltzmann: Viz = {
  id: 'maxwell-boltzmann',
  title: 'Maxwell–Boltzmann',
  group: 'randomness',
  blurb:
    'Fires beads out of the top of a wall, one for each molecule of a gas: the faster a bead flies, the farther it ' +
    'lands, so the piles in the slots sort the gas by speed — a few slow, most in the middle, and a long tail of ' +
    'very fast ones.',
  // The machine over its chart: landscape on a desk, where the slots want
  // every pixel of width they can get — each one is a hundred metres a second
  // of resolution — and portrait on a phone, where a landscape bed would leave
  // both halves a strip.
  aspect: 1.5,
  aspectNarrow: 0.8,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_BEADS },
  create,
};
