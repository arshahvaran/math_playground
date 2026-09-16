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
  CheckLog,
  Orchard,
  VISIBLE_FRACTION,
  drawPair,
  fractionStandardError,
  piFromFraction,
  piStandardError,
} from './lattice';

/**
 * Trees along each side of the square the visitor looks at.
 *
 * The ceiling is where a tree stops being a mark. A plate 440 px tall leaves a
 * 424 px square, so 100 a side puts the trees 4.2 px apart and the disc that
 * fits is the 1.5 px radius §7 sets as the floor for anything drawn in the
 * signal pen — a vermilion mark thinner than that is 2.20:1 on the plate and
 * no longer a conformant graphical object. Past 100 the picture would be a
 * texture of sub-pixel dots, which is a prettier screenshot and a worse
 * experiment.
 *
 * The floor is where the sight lines are still followable one by one.
 */
const MAX_SIDE = 100;
const MIN_SIDE = 10;

/**
 * The default is the ceiling on purpose: a bigger corner is a better corner,
 * and shrinking it is how a visitor sees the mechanism rather than the answer.
 * The exact share of the 100 × 100 corner is 0.60870, which is 0.13% above
 * 6/π²; at forty a side it is 0.65% above, and at twelve, 4%.
 */
const DEFAULT_SIDE = 100;

/** Where a run stops, and the fader's own ceiling. */
const MAX_CHECKS = 200_000;
const MIN_CHECKS = 200;
const DEFAULT_CHECKS = 20_000;

/**
 * A run is paced to take about this long whatever its length, between a floor
 * that keeps two hundred checks from trickling out one at a time and a ceiling
 * that keeps two hundred thousand from being a single frame.
 */
const RUN_SECONDS = 15;
const MIN_CHECK_RATE = 20;
const MAX_CHECK_RATE = 4_000;

/**
 * Sight lines added to the plate per second, whatever the check rate is.
 *
 * This is the "bound what you paint independently of what you count" rule in
 * its sharpest form here. At the top of the fader the run checks 4,000 trees a
 * second and the plate holds about twenty lines, so painting every check would
 * give each one five milliseconds on screen — a strobe, not a picture. Keeping
 * one check in every ⌈rate/RAY_RATE⌉ instead gives each line a little over a
 * second, at every fader position, and the lines painted are real checks and
 * not a re-roll: the counters and the plate are looking at the same run.
 */
const RAY_RATE = 18;

/**
 * Sight lines held. The ink budget below is what usually decides how many are
 * painted; this is the ring's own ceiling, which binds only on a plate past
 * about 950 px square.
 */
const MAX_RAYS = 64;

/**
 * The fraction of the plate the sight lines may ink.
 *
 * N randomly placed marks of area a on a plate of area A cover 1 − exp(−N·a/A).
 * A sight line runs from the corner to a uniform point of the square, whose
 * mean length is (√2 + ln(1 + √2))/3 = 0.7652 of the side, and it is drawn
 * 2 px wide inside a 2 px halo, so it inks 0.7652·S·4·lineWidth. Inverting for
 * f = 0.15 gives about 22 lines on the 408 px square the default plate affords
 * and 38 on a 720 px one.
 *
 * The target is lower than Buffon's 0.2 because these marks are not randomly
 * placed: every one of them starts at the same corner, so the Poisson estimate
 * understates the crowding there by a wide margin. Twenty-odd lines is also
 * where a reader can still follow a single one from the eye to the tree it
 * stops at, which is the whole reason they are drawn.
 */
const INK_TARGET = 0.15;

/** Mean distance from a corner of a unit square to a uniform point in it. */
const MEAN_RAY = (Math.SQRT2 + Math.log(1 + Math.SQRT2)) / 3;

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Gap between the display window and the plate's corner, CSS px. */
const WINDOW_MARGIN = 10;
const WINDOW_PAD = 5;

/**
 * The widest reading the window can ever print, and the only string its box is
 * sized from — §4 forbids taking a layout from a number's own text, and the
 * window must not breathe as digits change. Two integer places is more than
 * √(6/p̂) can reach once a run has checked its first few dozen trees, and a
 * reading outside them prints an em dash instead of widening the box.
 */
const WINDOW_SAMPLE = 'π ≈ 00.0000';

const DEFAULT_SEED = 42;

const TAU = 2 * Math.PI;

const params: readonly ParamSpec[] = [
  {
    kind: 'int',
    key: 'size',
    label: 'Orchard size',
    min: MIN_SIDE,
    max: MAX_SIDE,
    default: DEFAULT_SIDE,
    help: 'Trees along each side of the square, with you standing at the corner.',
  },
  {
    kind: 'range',
    key: 'checks',
    label: 'Random checks',
    min: MIN_CHECKS,
    max: MAX_CHECKS,
    step: 100,
    default: DEFAULT_CHECKS,
    log: true,
    help: 'How many trees to pick at random and look at, one at a time.',
  },
  // Not a control — the rail never renders a seed spec — but the spec is what
  // binds the seed to the URL: without it a permalink's seed is dropped on the
  // way in and the transport's Shuffle key has nothing to set.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'small-orchard',
    label: 'Small orchard',
    caption: 'Twelve trees a side is small enough to follow one sight line at a time and see it stop at the nearer tree in the way.',
    values: { size: 12, checks: 2_000 },
  },
  {
    id: 'forty-a-side',
    label: 'Forty a side',
    caption: 'Forty a side and the hidden trees fall into a pattern, with the share still in view already close to six in ten.',
    values: { size: 40, checks: 20_000 },
  },
  {
    id: 'hundred-a-side',
    label: 'A hundred a side',
    caption: [
      'A hundred a side and two hundred thousand checks settle the share to three figures, and ',
      { v: 'π' },
      ' comes out of a picture with nothing round in it.',
    ],
    values: { size: MAX_SIDE, checks: MAX_CHECKS },
  },
];

const facts: readonly Fact[] = [
  {
    text: [
      'Ernesto Cesàro proved in 1881 that two whole numbers picked at random share no factor above 1 with ',
      'probability 6/', { v: 'π' }, '², which is about 61 in 100.',
    ],
    source: {
      label: "Cesàro, 'Question proposée 75', Mathesis 1 (1881), 184; Coprime integers",
      url: 'https://en.wikipedia.org/wiki/Coprime_integers',
    },
  },
  {
    text: [
      'The ', { v: 'π' }, '² arrives by way of the Basel problem — Euler showed in 1735 that 1 + 1/4 + 1/9 + 1/16 + … ',
      'adds up to ', { v: 'π' }, '²/6 — so the picture and the constant are both downstream of that one sum.',
    ],
    source: {
      label: 'Euler, De summis serierum reciprocarum (1735); Basel problem',
      url: 'https://en.wikipedia.org/wiki/Basel_problem',
    },
  },
];

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

export interface OrchardLayout {
  /** Side of the square the lattice is laid out in, CSS px. */
  side: number;
  /** Distance between neighbouring trees, CSS px. */
  spacing: number;
  /** The observer's eye — lattice (0, 0) — in CSS px. */
  originX: number;
  originY: number;
  /** Drawn radius of one tree. Never below the 1.5 px §7 sets for the signal pen. */
  dotRadius: number;
  /** Drawn radius of the eye. */
  eyeRadius: number;
}

/**
 * Lay `side + 1` lattice columns, 0 through `side`, into the largest square the
 * plate holds.
 *
 * The eye is lattice (0, 0) and sits at the bottom-left, so x runs right and y
 * runs up, the way a reader expects a first-quadrant picture. Every point is
 * placed at the centre of its own cell — spacing is `square/(side + 1)` and
 * the first centre is half a cell in — which leaves a half-cell margin all
 * round, so no tree is ever clipped by the plate edge whatever the radius
 * works out to.
 */
export function layoutOrchard(width: number, height: number, side: number): OrchardLayout {
  const n = Math.max(1, Math.round(side));
  const square = Math.max(1, Math.min(width, height) - 2 * PLATE_PAD);
  const spacing = square / (n + 1);
  const left = (width - square) / 2;
  const top = (height - square) / 2;
  return {
    side: square,
    spacing,
    originX: left + spacing / 2,
    originY: top + square - spacing / 2,
    // The same clamp the Galton board's pegs take: fat discs on a sparse
    // lattice, down to the signal pen's floor on a crowded one.
    dotRadius: Math.min(5, Math.max(1.5, spacing * 0.3)),
    eyeRadius: Math.min(7, Math.max(3, spacing * 0.5)),
  };
}

/** Pixel position of lattice column `i`. */
export function treeX(g: OrchardLayout, i: number): number {
  return g.originX + i * g.spacing;
}

/** Pixel position of lattice row `j`. y runs up the plate, so this subtracts. */
export function treeY(g: OrchardLayout, j: number): number {
  return g.originY - j * g.spacing;
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** Trees a side this run uses, clamped the way `Orchard` clamps its own. */
export function sideTarget(values: ParamValues): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(num(values, 'size', DEFAULT_SIDE))));
}

/** Checks this run will make, clamped the way `step()` clamps its own ceiling. */
export function checkTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_CHECKS, Math.floor(num(values, 'checks', DEFAULT_CHECKS))));
}

/** Checks per second that finish a run of `checks` in about RUN_SECONDS. */
export function checkRateFor(checks: number): number {
  return Math.min(MAX_CHECK_RATE, Math.max(MIN_CHECK_RATE, checks / RUN_SECONDS));
}

/** Checks per painted sight line, so the plate gains about RAY_RATE of them a second. */
export function paintEveryFor(rate: number): number {
  return Math.max(1, Math.round(rate / RAY_RATE));
}

/** Pixel size out of a CSS font shorthand, for sizing the display window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

function create(ctx: VizContext): VizInstance {
  const orchard = new Orchard(MAX_SIDE);
  const log = new CheckLog(MAX_RAYS);

  let side = DEFAULT_SIDE;
  let rate = checkRateFor(DEFAULT_CHECKS);
  let paintEvery = paintEveryFor(rate);
  let layout = layoutOrchard(ctx.width, ctx.height, side);

  /** Fractional checks owed by the rate accumulator between ticks. */
  let pending = 0;

  function syncStructure(): void {
    side = sideTarget(ctx.params);
    orchard.setSide(side);
    rate = checkRateFor(checkTarget(ctx.params));
    paintEvery = paintEveryFor(rate);
    layout = layoutOrchard(ctx.width, ctx.height, side);
  }

  function readouts(): Readout[] {
    const checks = log.checks;
    const share = log.fraction;
    const target = checkTarget(ctx.params);
    return [
      { key: 'checked', label: 'Trees checked', value: checks, digits: 6, plain: 'trees checked at random' },
      {
        key: 'share',
        label: 'Share in view, checked',
        value: share,
        digits: 4,
        target: VISIBLE_FRACTION,
        // §5: the hero prints "analytic" and the closed form behind the target.
        formula: ['6/', { v: 'π' }, '²'],
        plain: 'share in view among the ones checked',
        // The ledger's 1% default is six standard deviations at the top of the
        // fader, so the row would read agreement whatever the run did. Three
        // standard deviations at the count the run is going to reach is the
        // honest bar, and it makes the reading start off and arrive rather than
        // be true from the first check.
        tolerance: (3 * fractionStandardError(target)) / VISIBLE_FRACTION,
      },
      {
        key: 'pi',
        label: 'π estimate',
        value: piFromFraction(share),
        digits: 6,
        target: Math.PI,
        headline: true,
        plain: 'our estimate of pi',
        // Statistical only, with no allowance for the corner being finite. A
        // corner of a given size cannot do better than its own exact share —
        // forty a side caps π at 3.1314 however long it runs — and folding that
        // gap into the bar would print agreement on a reading that is honestly
        // half a percent out. It reads "within 0.4%" instead, which is true.
        tolerance: (3 * piStandardError(target)) / Math.PI,
      },
      {
        key: 'picture',
        label: 'Share in view, whole picture',
        value: orchard.fraction,
        digits: 4,
        target: VISIBLE_FRACTION,
        formula: ['6/', { v: 'π' }, '²'],
        plain: 'share in view over the whole picture',
        // No declared tolerance: this one is counted tree by tree, so the
        // ledger's 1% is exactly the right bar. A hundred a side lands 0.13%
        // out and reads as agreement; twelve a side lands 4% out and says so,
        // which is the lesson — a finite corner is not an endless orchard.
      },
      { key: 'lit', label: 'Trees in view', value: orchard.visible, digits: 6, expertOnly: true },
      { key: 'trees', label: 'Trees in the picture', value: orchard.trees, digits: 6, expertOnly: true },
      {
        key: 'picturePi',
        label: 'π from the whole picture',
        value: piFromFraction(orchard.fraction),
        digits: 6,
        target: Math.PI,
        expertOnly: true,
      },
      {
        key: 'se',
        label: 'Std. error of π, 1.26/√n',
        value: piStandardError(checks),
        digits: 3,
        expertOnly: true,
      },
    ];
  }

  const instance: VizInstance = {
    step(dt) {
      const target = checkTarget(ctx.params);
      if (log.checks >= target) {
        pending = 0;
        return;
      }
      pending += (rate * dt) / 1000;
      // Each check consumes exactly two rng draws, so the sequence of checked
      // trees for a seed is the same whatever the clock does.
      while (pending >= 1 && log.checks < target) {
        // `checks` is the count before this one, so the first check of a run is
        // always kept and the plate is never empty while the run is going.
        log.record(drawPair(ctx.rng, side), log.checks % paintEvery === 0);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move every tree.
      syncStructure();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      const g = layout;
      bg.clearRect(0, 0, width, height);

      // Two paths, two fills, for up to ten thousand discs — and this layer is
      // repainted only on a resize or a change of side, never per frame.
      // Hidden trees first, so a vermilion tree wins any overlap the radius
      // clamp produces at the crowded end of the fader.
      const r = g.dotRadius;
      for (const lit of [false, true]) {
        bg.fillStyle = lit ? theme.data1 : theme.data3;
        bg.beginPath();
        for (let y = 1; y <= side; y++) {
          const py = treeY(g, y);
          for (let x = 1; x <= side; x++) {
            if (orchard.visibleAt(x, y) !== lit) continue;
            const px = treeX(g, x);
            bg.moveTo(px + r, py);
            bg.arc(px, py, r, 0, TAU);
          }
        }
        bg.fill();
      }

      // The eye. It is where the experiment is conducted from — the one thing
      // on this plate that is apparatus rather than data — so it takes the
      // apparatus pen, and nothing else here does.
      bg.fillStyle = theme.grid;
      bg.beginPath();
      bg.arc(treeX(g, 0), treeY(g, 0), g.eyeRadius, 0, TAU);
      bg.fill();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const g = layout;
      fg.clearRect(0, 0, width, height);

      // How many sight lines this plate can carry. Derived from the plate and
      // not fixed, so a phone gets fewer lines rather than a denser picture,
      // and recomputed here rather than stored because `draw()` may not mutate.
      const perRay = Math.max(1, MEAN_RAY * g.side * 4 * theme.lineWidth);
      const affordable = Math.ceil((-Math.log(1 - INK_TARGET) * g.side * g.side) / perRay);
      const skip = Math.max(0, log.count - affordable);

      // One pass per pen, and the clear lines go *under* the blocked ones —
      // the reverse of Buffon, deliberately. A blocked line stops at the tree
      // in the way, so half of them are a third of the length of a clear one
      // or less and all of them bunch at the eye, which is exactly where the
      // vermilion fan is densest: painted first, they were rubbed out by the
      // haloes of the lines painted over them and the plate showed only
      // successes. The vermilion is long, numerous and unmissable, and can
      // afford the 4 px a muted halo takes out of it where the two cross.
      //
      // Batching by pen also costs two strokes a frame instead of two per
      // line, and it is what lets each halo be laid down in one pass.
      const eyeX = treeX(g, 0);
      const eyeY = treeY(g, 0);
      for (const clear of [true, false]) {
        fg.beginPath();
        let drawn = 0;
        log.forEach((x, y, divisor) => {
          if ((divisor === 1) !== clear) return;
          // A blocked line stops at the tree doing the blocking, (x/g, y/g) —
          // the nearest lattice point on the ray — so it visibly ends on a
          // tree instead of reaching the one that was checked. That stopping
          // short is the whole mechanism, drawn.
          fg.moveTo(eyeX, eyeY);
          fg.lineTo(treeX(g, x / divisor), treeY(g, y / divisor));
          drawn++;
        }, skip);
        if (drawn === 0) continue;
        // 2 px, and haloed: a line of sight crosses hundreds of trees on its
        // way out, and §7 puts the plate colour between two pens wherever they
        // cross. Here the halo earns its place twice over — the cleared 4 px
        // channel is what a line of sight through an orchard actually looks
        // like.
        strokeWithHalo(fg, undefined, clear ? theme.data1 : theme.inkMuted, theme.canvas, 2 * theme.lineWidth, 2);
      }

      // Live π in the top-right as a display window: an opaque plate of the
      // canvas colour with a 1 px frame, right-aligned mono, ink text. Opaque
      // because ten thousand trees read straight through a translucent one, and
      // the frame takes the container pen — a window holds the experiment's
      // number, it is not part of the experiment. Published below through
      // emit() as well; the canvas itself is aria-hidden.
      const pi = piFromFraction(log.fraction);
      const label = `π ≈ ${Number.isFinite(pi) && pi < 100 ? pi.toFixed(4) : '—'}`;
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      // Measured from the constant above, never from `label`: the box must be
      // the same width at 3.1416 as at 3.1 and as at the em dash.
      const textW = fg.measureText(WINDOW_SAMPLE).width;
      const textH = fontPx(theme.labelFont);
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const plateX = Math.round(width - WINDOW_MARGIN - textW - WINDOW_PAD);
      const plateY = Math.round(WINDOW_MARGIN - WINDOW_PAD);
      const plateW = Math.round(textW + 2 * WINDOW_PAD);
      const plateH = Math.round(textH + 2 * WINDOW_PAD);
      fg.fillStyle = theme.canvas;
      fg.fillRect(plateX, plateY, plateW, plateH);
      fg.strokeStyle = theme.gridSoft;
      fg.lineWidth = theme.lineWidth;
      // Inset by half a line width so the frame lands inside the plate it draws.
      fg.strokeRect(plateX + snap, plateY + snap, plateW - 2 * snap, plateH - 2 * snap);
      fg.fillStyle = theme.ink;
      fg.fillText(label, width - WINDOW_MARGIN, WINDOW_MARGIN);

      ctx.emit(readouts());
    },

    onParamChange(key) {
      // The ceiling is where a run stops, not what it is: raising it lets the
      // checks already made carry on counting, and nothing on the plate is
      // measured from it. The side is a different orchard and the seed is a
      // different run, so the shell resets on both.
      if (key !== 'checks') return false;
      rate = checkRateFor(checkTarget(ctx.params));
      paintEvery = paintEveryFor(rate);
      return true;
    },

    reset() {
      // The seed is not a control, but it still names the run: it arrives in
      // the parameters when a permalink or the shell's Shuffle carries one, and
      // the same seed checks the same trees in the same order.
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      syncStructure();
      log.reset();
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const coprime: Viz = {
  id: 'coprime',
  title: 'Visible Stars',
  group: 'numbers',
  blurb: [
    'Plants a tree at every point of a grid and lights the ones still in view from the corner — about six in ten, which is 6/',
    { v: 'π' },
    '².',
  ],
  // The lattice is square, so the plate is very nearly one: `layoutOrchard`
  // takes the smaller of the two sides, and any more width than this is margin
  // the picture cannot use. Slightly landscape on a desktop, slightly portrait
  // on a phone, where the tab strip and the rail take the vertical room.
  aspect: 1.15,
  aspectNarrow: 0.95,
  params,
  presets,
  facts,
  // The trees are the entities: the mask and the arcs both scale with this, and
  // it is the largest typed array the tab allocates.
  budget: { maxEntities: MAX_SIDE * MAX_SIDE },
  create,
};
