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
import { NeedleField, crossingProbability, dropNeedle, estimatePi, piStandardError } from './geometry';

/**
 * Needles kept on screen. Older ones are overwritten in place; the drop and
 * crossing counters do not forget them, so the estimate uses every drop.
 *
 * This is an ink budget, not a memory one, and it is what the tab is worth
 * looking at at all: at 8,000 drops a 20,000-needle field is a solid vermilion
 * mass with the floorboards buried under it. 600 is the ceiling on a full-size
 * plate — see `INK_TARGET`, which is what actually decides how many of them are
 * painted.
 */
const MAX_NEEDLES = 600;

/**
 * The fraction of the plate the needles may ink.
 *
 * Randomly placed marks of area a on a plate of area A cover 1 − exp(−N·a/A) of
 * it, so a target f is N = −ln(1 − f)·A/a needles. A needle inks L × 2·lineWidth
 * px² — 102 px² at the default L = 0.8·d = 51 px — which puts f = 0.2 at about
 * 680 needles on a 705 × 440 plate and 250 on a 343 px phone square. At that
 * coverage the ruled lines read straight through the field and every needle's
 * own orientation is still separable; by 0.5 neither is true.
 *
 * Deriving the count from the plate rather than fixing it is what keeps the
 * picture the same weight on a phone as on a 1,280 px window, and it costs
 * nothing: the ring still holds the needles and the counters still count them.
 */
const INK_TARGET = 0.2;

/**
 * Weight steps for the weight-by-angle overlay. Needles are batched into one
 * path per (crossing, level) pair, so a frame costs at most 2·WEIGHT_LEVELS
 * style changes and stroke calls instead of one of each per needle. Eight steps
 * are indistinguishable from a continuous ramp at these line widths.
 */
const WEIGHT_LEVELS = 8;

/**
 * Needle width in units of `theme.lineWidth`: the floor every needle is drawn
 * at, and the extra the weight overlay adds at |sin θ| = 1.
 *
 * |sin θ| is encoded as weight rather than as opacity because opacity cannot
 * carry it: the vermilion pen is 4.80:1 on the white plate at full strength and
 * a translucent one composites straight through the floor — the alpha ramp this
 * replaces bottomed out at 1.46:1, under the 3:1 SC 1.4.11 asks of a graphical
 * object, on 44% of the needles. Every needle here keeps its pen at full
 * strength, so the worst case is the pen's own 4.80:1 (vermilion) and 7.49:1
 * (the muted pen for misses) whatever its angle.
 */
const WEIGHT_BASE = 2;
const WEIGHT_SPREAD = 2;

/**
 * Needles per second of simulation time. This was the "Drop rate" fader
 * (1–2,000/s); it is fixed because how fast a run goes is the transport's job,
 * and 120 against the 120 Hz tick is exactly one needle per step.
 */
const DROP_RATE = 120;

/**
 * Where a run stops. This was the "Total drops" fader (100–200,000); it is
 * fixed because 20,000 drops already pin π to about two decimals, which is the
 * lesson, and at DROP_RATE they finish inside the shell's settle budget on a
 * reduced-motion load.
 */
const MAX_DROPS = 20_000;

/**
 * The weight-by-angle overlay. This was the "Weight by angle" toggle; it is off
 * because |sin θ| answers a question a newcomer has not asked yet. The painter
 * still knows how to draw it, so the switch is a constant, not a deletion.
 */
const SHOW_ANGLE: boolean = false;

const DEFAULT_SEED = 42;

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'ratio',
    label: 'Needle length',
    min: 0.1,
    max: 1,
    step: 0.01,
    default: 0.8,
    help: 'As a fraction of the gap between the lines: 1 means the needle is exactly as long as the gap.',
  },
  {
    kind: 'int',
    key: 'spacing',
    label: 'Line spacing',
    min: 24,
    max: 160,
    default: 64,
    unit: 'px',
  },
  // Not a control — the rail never renders this kind — but the spec is what
  // binds the seed to the URL: without it a permalink's seed is dropped on the
  // way in and the transport's Shuffle key has nothing to set.
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
  },
];

const presets: readonly Preset[] = [
  {
    id: 'short-needle',
    label: 'Short needle',
    caption: 'A short needle hardly ever lands on a line, so the estimate of π wanders for a long time.',
    values: { ratio: 0.3 },
  },
  {
    id: 'full-length',
    label: 'Full length',
    caption: 'A needle as long as the gap crosses a line most often, and that is the quickest way to a good estimate of π.',
    values: { ratio: 1 },
  },
  {
    id: 'wider-boards',
    label: 'Wider boards',
    caption:
      'The gap doubles and the needle grows with it, yet the estimate is no different: only the needle compared with the gap matters.',
    values: { spacing: 128 },
  },
];

const facts: readonly Fact[] = [
  {
    text: 'Buffon posed the needle problem in 1777, asking what a gambler should pay to bet that a dropped stick would cross a floorboard joint.',
    source: {
      label: "Buffon, Essai d'arithmétique morale (1777), Histoire naturelle, Supplément t. IV",
      url: 'https://mathshistory.st-andrews.ac.uk/Biographies/Buffon/',
    },
  },
  {
    text: 'In 1901 Mario Lazzarini reported 3,408 throws giving π correct to six decimals, and he almost certainly stopped counting at the moment the answer looked best.',
    source: {
      label: "Badger, 'Lazzarini's Lucky Approximation of π', Mathematics Magazine 67(2), 1994",
      url: 'https://doi.org/10.2307/2690682',
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

export interface FieldLayout {
  /** Whole strips that fit the plate. Needles are painted only inside these. */
  rows: number;
  /** Top of the block of whole strips, in CSS px. */
  originY: number;
  /** Painted y of each of the `rows + 1` ruled lines, snapped to whole device pixels. */
  lines: readonly number[];
}

/**
 * Where the ruled lines land on a plate `height` px tall.
 *
 * Needles are painted only inside the whole strips that fit, and the block of
 * them is centred so any leftover splits into two equal margins. (The strips
 * also decide the sampling: a partial one at the bottom would make y mod d
 * non-uniform there and bias the crossing fraction low — about 1.5% at 64 px
 * spacing on a 500 px canvas, enough to make π look wrong.)
 *
 * A rule is drawn `lineWidth` wide about its centre, so the centre is held half
 * that far inside the plate. Without it, a plate whose height is an exact
 * multiple of the spacing — 448 px at d = 64, which is what a 1400 px window
 * gives — leaves no margin at all and the closing rule is centred on the pixel
 * row after the last one, so it simply never appears: seven floorboards drawn
 * with seven edges instead of eight, and the bottom strip of needles reported
 * as crossings of a line that is not on screen.
 */
export function layoutField(height: number, spacing: number, lineWidth: number): FieldLayout {
  const d = Math.max(1, spacing);
  const rows = Math.max(1, Math.floor(height / d));
  const originY = Math.floor((height - rows * d) / 2);
  // An odd-width line centred on a half-pixel covers whole device pixels at
  // DPR 1; on an integer it smears across two.
  const snap = lineWidth % 2 === 1 ? 0.5 : 0;
  const inset = lineWidth / 2;
  const lines: number[] = [];
  for (let k = 0; k <= rows; k++) {
    const y = originY + k * d + snap;
    lines.push(Math.min(Math.max(y, inset), height - inset));
  }
  return { rows, originY, lines };
}

function create(ctx: VizContext): VizInstance {
  const field = new NeedleField(MAX_NEEDLES);

  // Structural parameters: changing either one is a new experiment.
  let spacing = 64;
  let length = 0.8 * spacing;

  // Where the ruled lines and the strips are on the current plate. Purely a
  // painting concern: the needles themselves are stored unscaled, so this is
  // re-derived on every resize and the field re-lays-out with it.
  let layout: FieldLayout = layoutField(ctx.height, spacing, ctx.theme.lineWidth);

  // Fractional needles owed by the drop-rate accumulator between ticks.
  let pending = 0;

  function syncStructure(): void {
    spacing = Math.max(1, Math.round(num(ctx.params, 'spacing', 64)));
    const ratio = Math.min(1, Math.max(0.01, num(ctx.params, 'ratio', 0.8)));
    length = ratio * spacing;
    layout = layoutField(ctx.height, spacing, ctx.theme.lineWidth);
  }

  function readouts(): Readout[] {
    const drops = field.drops;
    const crossings = field.crossings;
    const p = crossingProbability(length, spacing);
    return [
      { key: 'drops', label: 'Drops', value: drops, digits: 6, plain: 'needles dropped' },
      { key: 'crossings', label: 'Crossings', value: crossings, digits: 6, plain: 'crossed a line' },
      // §5: the hero prints "analytic" and the closed form behind the target.
      // L is the needle length, d the line spacing.
      {
        key: 'fraction',
        label: 'Crossing fraction',
        value: crossings / drops,
        target: p,
        formula: ['2', { v: 'L' }, '/(', { v: 'π' }, { v: 'd' }, ')'],
        // One needle is one Bernoulli(P) trial, so the share of crossings has
        // standard deviation √(P(1−P)) per drop and the ledger divides by the
        // drops made *so far*. Declaring nothing here is what left both rows on
        // this tab reading "not enough data to judge": a target with no band is
        // a prediction nobody is holding the reading to.
        band: { kind: 'sampled', sigma: Math.sqrt(p * (1 - p)), samples: drops },
        range: [0, 1],
        expertOnly: true,
      },
      {
        key: 'pi',
        label: 'π estimate',
        value: estimatePi(drops, crossings, length, spacing),
        digits: 5,
        target: Math.PI,
        plain: 'our estimate of pi',
        headline: true,
        // Not the fraction's band: π̂ = 2L/(d·p̂) is not linear in p̂, and the
        // delta method turns √(P(1−P)/N) into π·√((1−P)/(P·N)) — the standard
        // error two rows down, which is why this is that reading rather than a
        // second derivation of it. NaN before the first drop, which the ledger
        // reads as "no band" and the hero as "not measured yet"; a twentieth of
        // π wants 9(1−P)/(P·0.05²) = 3,470 drops at the default needle, and the
        // run goes to 20,000.
        band: { kind: 'absolute', half: 3 * piStandardError(drops, length, spacing) },
      },
      {
        key: 'se',
        label: 'Std. error of π',
        value: piStandardError(drops, length, spacing),
        digits: 3,
        expertOnly: true,
      },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      if (field.drops >= MAX_DROPS) {
        pending = 0;
        return;
      }
      pending += (DROP_RATE * dt) / 1000;
      // Each drop consumes exactly four rng draws, so the needle sequence for a
      // seed is the same whatever the clock does.
      while (pending >= 1 && field.drops < MAX_DROPS) {
        field.push(dropNeedle(ctx.rng, length, spacing));
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both can move the lines.
      syncStructure();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);
      // The ruled floorboards are the experiment, not the frame around it: the
      // crossings being counted are crossings of these lines, so they keep the
      // apparatus pen. Nothing else on this plate does.
      bg.strokeStyle = theme.grid;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (const y of layout.lines) {
        bg.moveTo(0, y);
        bg.lineTo(width, y);
      }
      bg.stroke();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // One Path2D per (crossing, weight level) bucket. Non-crossing buckets
      // come first so crossing needles paint on top of the muted ones.
      const paths = new Array<Path2D | undefined>(2 * WEIGHT_LEVELS);
      const { rows, originY } = layout;
      const half = length / 2;
      const top = WEIGHT_LEVELS - 1;
      // Paint the newest needles the ink budget affords and let the rest
      // recede. `forEach` skips from the oldest end, which is the right end to
      // drop: a needle's information is already in the counters.
      //
      // The mean width under the overlay is WEIGHT_BASE + WEIGHT_SPREAD·E|sin θ|,
      // and E|sin θ| over θ ~ U[0, π) is 2/π — the same 2/π that caps the
      // crossing probability — so the overlay inks about 1.6× as much per
      // needle and buys correspondingly fewer of them.
      const meanWeight = WEIGHT_BASE + (SHOW_ANGLE ? (WEIGHT_SPREAD * 2) / Math.PI : 0);
      const perNeedle = Math.max(1, length * meanWeight * theme.lineWidth);
      const affordable = Math.ceil((-Math.log(1 - INK_TARGET) * width * height) / perNeedle);
      const skip = Math.max(0, field.count - affordable);
      field.forEach((u, v, t, cos, sin, crosses) => {
        // The field hands back the direction it stored at push, so no needle
        // costs a sin/cos here — a pair each a frame was a measurable slice.
        const level = SHOW_ANGLE ? Math.round(Math.abs(sin) * top) : top;
        const b = crosses ? WEIGHT_LEVELS + level : level;
        const path = paths[b] ?? (paths[b] = new Path2D());
        // The stored draws are fractions, so the plate in front of us now — not
        // the one the needle was dropped on — decides where it lands.
        const x = u * width;
        const cy = originY + (Math.floor(v * rows) + t) * spacing;
        path.moveTo(x - half * cos, cy - half * sin);
        path.lineTo(x + half * cos, cy + half * sin);
      }, skip);

      // 2 px, not a hairline: the signal pen is 4.80:1 on the plate as a solid
      // 2 px mark and 2.20:1 once anti-aliasing smears it across a thinner one,
      // which is why nothing in this system draws a 1 px line in it. With the
      // overlay on, that 2 px is the floor of the weight ramp rather than the
      // whole of it; with it off, `level` is `top` for every needle and the
      // spread is zero, so all of them are drawn at exactly the same 2 px.
      fg.lineCap = 'butt';
      const spread = SHOW_ANGLE ? WEIGHT_SPREAD : 0;
      for (let b = 0; b < 2 * WEIGHT_LEVELS; b++) {
        const path = paths[b];
        if (!path) continue;
        const level = b % WEIGHT_LEVELS;
        fg.lineWidth = theme.lineWidth * (WEIGHT_BASE + spread * (level / top));
        fg.strokeStyle = b < WEIGHT_LEVELS ? theme.inkMuted : theme.data1;
        fg.stroke(path);
      }

      // Live π in the top-right corner as a display window: an opaque plate of
      // the canvas colour with a 1 px frame, right-aligned mono, ink text. The
      // plate is opaque because 20,000 needles read straight through a
      // translucent one, and the frame takes the container pen — a window holds
      // the experiment's number, it is not part of the experiment. Published
      // below through emit() as well; the canvas itself is aria-hidden.
      const pi = estimatePi(field.drops, field.crossings, length, spacing);
      const label = `π ≈ ${Number.isNaN(pi) ? '—' : pi.toFixed(4)}`;
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

      ctx.emit(readouts());
    },

    // No onParamChange: every knob left — ratio, spacing, seed — is structural.
    // The needles already down belong to a different experiment, so the shell
    // resets on each of them.

    reset() {
      syncStructure();
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      field.reset();
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const buffon: Viz = {
  id: 'buffon',
  title: "Buffon's Needle",
  group: 'randomness',
  blurb: [
    'Drops needles onto a ruled floor, where the fraction that cross a line is enough to pull ',
    { v: 'π' },
    ' out of nothing but sticks and floorboards.',
  ],
  // Landscape, like the floor it models: whole strips are what the estimator
  // samples, and the field is centred on them. Square on a phone, where a 1.6
  // bed fits three floorboards and a square fits five.
  aspect: 1.6,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_NEEDLES },
  create,
};
