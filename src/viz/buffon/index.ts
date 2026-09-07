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
 */
const MAX_NEEDLES = 20_000;

/**
 * Alpha steps for the fade-by-angle overlay. Needles are batched into one path
 * per (crossing, level) pair, so a frame costs at most 2·ALPHA_LEVELS style
 * changes and stroke calls instead of one of each per needle. Eight steps are
 * indistinguishable from a continuous ramp at these line widths.
 */
const ALPHA_LEVELS = 8;
const ALPHA_MIN = 0.25;

const DEFAULT_SEED = 42;

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'ratio',
    label: 'Needle length L/d',
    min: 0.1,
    max: 1,
    step: 0.01,
    default: 0.8,
    help: 'Needle length as a fraction of the line spacing. The formula 2L/(πd) needs L ≤ d.',
  },
  {
    kind: 'int',
    key: 'spacing',
    label: 'Line spacing',
    min: 24,
    max: 160,
    default: 64,
    unit: 'px',
    help: 'Distance d between the ruled lines.',
  },
  {
    kind: 'range',
    key: 'dropRate',
    label: 'Drop rate',
    min: 1,
    max: 2000,
    step: 1,
    default: 120,
    unit: '/s',
    log: true,
    help: 'Needles dropped per second of simulation time.',
  },
  {
    kind: 'range',
    key: 'maxDrops',
    label: 'Total drops',
    min: 100,
    max: 200_000,
    step: 100,
    default: 20_000,
    log: true,
    help: 'Stop after this many drops. Only the newest 20,000 stay on screen; the counts keep going.',
  },
  {
    kind: 'toggle',
    key: 'showAngle',
    label: 'Fade by angle',
    default: false,
    help: 'Crossing depends only on |sin θ|: needles fade toward horizontal and stay solid near vertical.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Same seed, same needles, same estimate.',
  },
];

const presets: readonly Preset[] = [
  {
    id: 'slow-motion',
    label: 'Slow motion',
    caption: 'Two needles a second: each one either crosses a line or misses, and the π estimate lurches after every drop.',
    values: { dropRate: 2, maxDrops: 200 },
  },
  {
    id: 'short-needle',
    label: 'Short needle',
    caption: 'A short needle rarely crosses, so each drop carries little information and the estimate wanders for longer.',
    values: { ratio: 0.3 },
  },
  {
    id: 'full-length',
    label: 'Full length',
    caption: 'L = d gives the largest crossing probability, 2/π, and the most information per drop — the fastest route to π.',
    values: { ratio: 1 },
  },
  {
    id: 'two-hundred-thousand',
    label: 'Two hundred thousand',
    caption: 'Even 200,000 drops pin π to about two decimals: the error shrinks as 1/√N, and that slowness is the lesson.',
    values: { dropRate: 2000, maxDrops: 200_000 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      "Buffon posed the needle problem in 1777 in his Essai d'arithmétique morale, " +
      'asking what a gambler should pay to bet that a dropped stick would cross a floorboard joint. ' +
      'It is the earliest problem in geometric probability.',
    source: {
      label: "Buffon, Essai d'arithmétique morale (1777), Histoire naturelle, Supplément t. IV",
      url: 'https://mathshistory.st-andrews.ac.uk/Biographies/Buffon/',
    },
  },
  {
    text:
      'In 1901 Mario Lazzarini reported 3,408 throws giving π ≈ 3.1415929 — exactly 355/113, correct to six decimals. ' +
      'With L/d = 5/6 the estimate hits 355/113 whenever the throw count is a multiple of 213 and the crossings cooperate; ' +
      '3,408 = 16 × 213, and stopping there was almost certainly a choice made after the fact.',
    source: {
      label: "Badger, 'Lazzarini's Lucky Approximation of π', Mathematics Magazine 67(2), 1994; Gridgeman, Scripta Mathematica 25, 1960",
      url: 'https://doi.org/10.2307/2690682',
    },
  },
  {
    text:
      'Dropping needles to measure π is, in effect, the first Monte Carlo method: a random experiment run many times ' +
      'to estimate a deterministic quantity, a century and a half before the name was coined at Los Alamos.',
    source: {
      label: "Wikipedia, Buffon's needle problem",
      url: 'https://en.wikipedia.org/wiki/Buffon%27s_needle_problem',
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

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

function create(ctx: VizContext): VizInstance {
  const field = new NeedleField(MAX_NEEDLES);

  // Structural parameters: changing either one is a new experiment.
  let spacing = 64;
  let length = 0.8 * spacing;

  // Live parameters: absorbed without touching the needles already dropped.
  let dropRate = 120;
  let maxDrops = 20_000;
  let showAngle = false;

  // Field layout in CSS px. Centres are sampled only inside the `rows` whole
  // strips that fit the canvas: a partial strip at the bottom would make
  // y mod d non-uniform there and bias the crossing fraction low — about 1.5%
  // at 64 px spacing on a 500 px canvas, enough to make π look wrong. The block
  // of whole strips is centred so any leftover splits into two equal margins.
  let rows = 1;
  let fieldHeight = spacing;
  let originY = 0;

  // Fractional needles owed by the drop-rate accumulator between ticks.
  let pending = 0;

  function syncLive(): void {
    dropRate = num(ctx.params, 'dropRate', 120);
    maxDrops = num(ctx.params, 'maxDrops', 20_000);
    showAngle = flag(ctx.params, 'showAngle', false);
  }

  function syncStructure(): void {
    spacing = Math.max(1, Math.round(num(ctx.params, 'spacing', 64)));
    const ratio = Math.min(1, Math.max(0.01, num(ctx.params, 'ratio', 0.8)));
    length = ratio * spacing;
    rows = Math.max(1, Math.floor(ctx.height / spacing));
    fieldHeight = rows * spacing;
    originY = Math.floor((ctx.height - fieldHeight) / 2);
  }

  function readouts(): Readout[] {
    const drops = field.drops;
    const crossings = field.crossings;
    return [
      { key: 'drops', label: 'Drops', value: drops, digits: 6 },
      { key: 'crossings', label: 'Crossings', value: crossings, digits: 6 },
      {
        key: 'fraction',
        label: 'Crossing fraction',
        value: crossings / drops,
        target: crossingProbability(length, spacing),
      },
      {
        key: 'pi',
        label: 'π estimate',
        value: estimatePi(drops, crossings, length, spacing),
        digits: 5,
        target: Math.PI,
      },
      {
        key: 'se',
        label: 'Std. error of π',
        value: piStandardError(drops, length, spacing),
        digits: 3,
      },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      if (field.drops >= maxDrops) {
        pending = 0;
        return;
      }
      pending += (dropRate * dt) / 1000;
      // Drops per tick depend only on dt and dropRate, and each drop consumes
      // exactly three rng draws, so the needle sequence for a seed is the same
      // at every drop rate — only the clock differs.
      while (pending >= 1 && field.drops < maxDrops) {
        field.push(dropNeedle(ctx.rng, ctx.width, fieldHeight, length, spacing));
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both can move the lines.
      syncStructure();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);
      bg.strokeStyle = theme.grid;
      bg.lineWidth = theme.lineWidth;
      // An odd-width line centred on a half-pixel covers whole device pixels at
      // DPR 1; on an integer it smears across two.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      bg.beginPath();
      for (let k = 0; k <= rows; k++) {
        const y = originY + k * spacing + snap;
        bg.moveTo(0, y);
        bg.lineTo(width, y);
      }
      bg.stroke();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      // One Path2D per (crossing, alpha level) bucket. Non-crossing buckets come
      // first so crossing needles paint on top of the muted ones.
      const paths = new Array<Path2D | undefined>(2 * ALPHA_LEVELS);
      const half = length / 2;
      const top = ALPHA_LEVELS - 1;
      field.forEach((x, y, angle, crosses) => {
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        const level = showAngle ? Math.round(Math.abs(s) * top) : top;
        const b = crosses ? ALPHA_LEVELS + level : level;
        const path = paths[b] ?? (paths[b] = new Path2D());
        const cy = originY + y;
        path.moveTo(x - half * c, cy - half * s);
        path.lineTo(x + half * c, cy + half * s);
      });

      fg.lineWidth = 1.5 * theme.lineWidth;
      fg.lineCap = 'butt';
      for (let b = 0; b < 2 * ALPHA_LEVELS; b++) {
        const path = paths[b];
        if (!path) continue;
        const level = b % ALPHA_LEVELS;
        fg.globalAlpha = ALPHA_MIN + (1 - ALPHA_MIN) * (level / top);
        fg.strokeStyle = b < ALPHA_LEVELS ? theme.inkMuted : theme.data1;
        fg.stroke(path);
      }
      fg.globalAlpha = 1;

      // Live π in the top-right corner, on a plate of the canvas colour so it
      // stays legible over a dense field. Published below via emit() as well.
      const pi = estimatePi(field.drops, field.crossings, length, spacing);
      const label = `π ≈ ${Number.isNaN(pi) ? '—' : pi.toFixed(4)}`;
      const margin = 10;
      const pad = 5;
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      const textW = fg.measureText(label).width;
      const textH = fontPx(theme.labelFont);
      fg.globalAlpha = 0.85;
      fg.fillStyle = theme.canvas;
      fg.fillRect(width - margin - textW - pad, margin - pad, textW + 2 * pad, textH + 2 * pad);
      fg.globalAlpha = 1;
      fg.fillStyle = theme.ink;
      fg.fillText(label, width - margin, margin);

      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      switch (key) {
        case 'dropRate':
          dropRate = asNumber(value, dropRate);
          return true;
        case 'maxDrops':
          maxDrops = asNumber(value, maxDrops);
          return true;
        case 'showAngle':
          showAngle = value === true;
          return true;
        default:
          // ratio, spacing, seed: the needles already down belong to a different
          // experiment, so the shell resets.
          return false;
      }
    },

    reset() {
      syncStructure();
      syncLive();
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
  blurb: 'Drops needles on ruled lines and recovers π from the fraction that cross one.',
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_NEEDLES },
  create,
};
