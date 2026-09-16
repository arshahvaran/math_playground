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
  DartField,
  ErrorHistory,
  PI_SE_COEFFICIENT,
  estimatePi,
  piStandardError,
  throwDart,
} from './estimate';

/**
 * Darts kept on screen. Older ones are overwritten in place; the counters do
 * not forget them, so the estimate uses every dart.
 *
 * This is an ink budget and an arc budget at once. A dart is a disc of radius
 * `theme.particleRadius` = 2 px, so it inks πr² = 12.6 px², and N randomly
 * placed marks of area a on a field of area A cover 1 − exp(−N·a/A): 3,000
 * darts on the 410 px square the default plate affords is 20% coverage, which
 * is where two clouds still read as clouds of points rather than as two solid
 * regions with a seam. It is also under the 4,000 arcs a single path can fill
 * in about a millisecond, and this tab paints two of them plus two plot curves
 * every frame. `INK_TARGET` is what actually decides how many are painted on a
 * plate smaller than that.
 */
const MAX_DARTS = 3_000;

/**
 * The fraction of the dart field the darts may ink.
 *
 * Deriving the painted count from the plate rather than fixing it keeps the
 * picture the same weight on a phone as on a 1,280 px window: on the 272 px
 * square a handheld affords, 0.25 is 1,700 darts rather than the full ring,
 * which at 3,000 would ink 40% of a much smaller field. The ring still holds
 * them all and the counters still count them.
 */
const INK_TARGET = 0.25;

/** Hard ceiling on the run; the `darts` fader tops out here too. */
const MAX_TARGET = 2_000_000;

const DEFAULT_DARTS = 100_000;

/**
 * Darts thrown per second of simulation time. This was the `dartRate` fader.
 * Fixed, because speed is the transport's job — its keys run more ticks of
 * the same experiment — and a second fader was one more thing a newcomer had
 * to ask about. Exported so a test can count ticks against it.
 */
export const DART_RATE = 2_000;

/**
 * The convergence plot. This was the `showErrorPlot` toggle; always on now,
 * because the plot is the point of the tab — the estimate alone says nothing
 * about how slowly it improves. `layoutPlate()` keeps the switch, so the
 * layout with no plot stays reachable and tested.
 */
const SHOW_ERROR_PLOT = true;

/**
 * The 1/√n reference line on the plot. This was the `showEnvelope` toggle;
 * always on now, because the measured error means nothing until there is a
 * line to compare it against.
 */
const SHOW_ENVELOPE = true;

const DEFAULT_SEED = 42;

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Plate layout — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

/** Margin between the plate's edge and anything painted on it, CSS px. */
const PLATE_PAD = 8;

/** Gap between the dart field and the convergence plot, CSS px. */
const PANEL_GAP = 20;

/** The dart field's share of the axis the plate is split along. */
const FIELD_SHARE = 0.6;

/** Below this the plot cannot carry a labelled decade axis, CSS px. */
const MIN_PLOT = 130;

/** The field never shrinks past this to make room for the plot, CSS px. */
const MIN_FIELD = 80;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlateLayout {
  /** The dart field. Always square: the circle inscribed in it must be a circle. */
  field: Rect;
  /** The convergence plot, or null when it is switched off or there is no room. */
  plot: Rect | null;
}

/**
 * Split the plate between the dart field and the convergence plot.
 *
 * The field is square whichever way the plate is split, so the plot takes the
 * leftover strip: beside the field on a landscape plate, under it on a phone.
 * A strip narrower than `MIN_PLOT` cannot carry a labelled decade axis, and
 * half a plot is worse than none — the field takes the whole plate instead,
 * which is the honest outcome at 200 px.
 */
export function layoutPlate(width: number, height: number, showPlot: boolean): PlateLayout {
  const w = Math.max(1, width - 2 * PLATE_PAD);
  const h = Math.max(1, height - 2 * PLATE_PAD);

  if (showPlot) {
    const horizontal = w >= 1.2 * h;
    const along = (horizontal ? w : h) - PANEL_GAP;
    const across = horizontal ? h : w;
    if (across >= MIN_PLOT && along >= MIN_FIELD + MIN_PLOT) {
      // Never past `across` (the field is square), never past what leaves the
      // plot its minimum, never under the field's own.
      const side = Math.min(across, Math.max(MIN_FIELD, Math.min(FIELD_SHARE * along, along - MIN_PLOT)));
      const span = along - side;
      return horizontal
        ? {
            field: { x: PLATE_PAD, y: PLATE_PAD + (h - side) / 2, width: side, height: side },
            plot: { x: PLATE_PAD + side + PANEL_GAP, y: PLATE_PAD, width: span, height: h },
          }
        : {
            field: { x: PLATE_PAD + (w - side) / 2, y: PLATE_PAD, width: side, height: side },
            plot: { x: PLATE_PAD, y: PLATE_PAD + side + PANEL_GAP, width: w, height: span },
          };
    }
  }

  const size = Math.max(1, Math.min(w, h));
  return {
    field: {
      x: PLATE_PAD + (w - size) / 2,
      y: PLATE_PAD + (h - size) / 2,
      width: size,
      height: size,
    },
    plot: null,
  };
}

// ---------------------------------------------------------------------------
// The convergence plot's scales — log-log, and pure
// ---------------------------------------------------------------------------

/**
 * Room for the y-axis decade labels, left of the data box. The widest is
 * `10⁻⁴` — four glyphs of the 11 px mono label face, plus the tick and its gap.
 */
const GUTTER_LEFT = 40;
/** Room for the x-axis decade labels, under the data box. */
const GUTTER_BOTTOM = 18;
/** Room for the caption, above the data box. */
const GUTTER_TOP = 14;
const GUTTER_RIGHT = 6;

/** Axis tick length and the gap between a tick and its numeral, CSS px. */
const TICK = 4;
const LABEL_GAP = 3;

/**
 * Top of the error axis: a decade above three standard errors at the first
 * dart, 3 × 1.6422 = 4.93. Nothing can reach it — the worst estimate a run can
 * publish is 0 or 4, an error of at most π — so the curve never leaves the box.
 */
const ERR_MAX = 10 ** Math.ceil(Math.log10(3 * piStandardError(1)));

/**
 * How far a curve is held inside its own frame, CSS px. `strokeWithHalo` lays
 * the plate colour down at `lineWidth + 4` under a 2 px curve, so the halo
 * reaches three px either side of the path and would otherwise erase the frame
 * where an error of exactly zero puts the curve on the floor.
 */
const HALO_PAD = 3;

export interface PlotScale {
  /** The data box, inside the axis gutters. The frame is drawn on its edges. */
  box: Rect;
  /** Right end of the x axis, in darts. The left end is one dart. */
  nMax: number;
  /** Bottom of the y axis, in absolute error. The top is `ERR_MAX`. */
  errMin: number;
}

/**
 * Axes for a run of `nMax` darts.
 *
 * The x axis spans the whole run, one dart to `nMax`, so the envelope crosses
 * the box corner to corner however long the run is. The y axis stops a decade
 * below the envelope's own last value, which leaves the measured error a
 * decade of room under the reference line it is being compared against and
 * still fits the whole descent: 10 down to 10⁻⁴ at two million darts.
 */
export function plotScale(area: Rect, nMax: number): PlotScale {
  const n = Math.max(10, nMax);
  return {
    box: {
      x: area.x + GUTTER_LEFT,
      y: area.y + GUTTER_TOP,
      width: Math.max(1, area.width - GUTTER_LEFT - GUTTER_RIGHT),
      height: Math.max(1, area.height - GUTTER_TOP - GUTTER_BOTTOM),
    },
    nMax: n,
    errMin: 10 ** Math.floor(Math.log10(piStandardError(n) / 10)),
  };
}

/** Darts → x. Log axis from one dart to `nMax`. */
export function plotX(s: PlotScale, n: number): number {
  const t = Math.log10(Math.max(1, n)) / Math.log10(s.nMax);
  return s.box.x + Math.min(1, t) * s.box.width;
}

/**
 * Absolute error → y, top down. Log axis from `errMin` to `ERR_MAX`, clamped
 * into the box inset by `pad`.
 *
 * An error of exactly zero has no logarithm and does happen — one dart in a
 * few thousand lands the running estimate on π — so it is read as the floor
 * rather than as −∞, and so is the NaN before the first dart.
 */
export function plotY(s: PlotScale, error: number, pad = 0): number {
  const inset = Math.min(pad, s.box.height / 2);
  const bottom = s.box.y + s.box.height - inset;
  if (!(error > 0)) return bottom;
  const t = Math.log10(ERR_MAX / error) / Math.log10(ERR_MAX / s.errMin);
  return Math.min(Math.max(s.box.y + t * s.box.height, s.box.y + inset), bottom);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * One fader. The seed is declared too, because the URL carries it and the
 * transport's Shuffle key draws a fresh one, but the rail never renders a
 * seed — it is not a control.
 */
const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'darts',
    label: 'Darts',
    min: 100,
    max: MAX_TARGET,
    step: 100,
    default: DEFAULT_DARTS,
    log: true,
    help: `How many darts to throw. Only the newest ${MAX_DARTS} stay on screen; the count keeps going.`,
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
  },
];

/** Three ceilings, a hundredfold apart, so each step buys one decimal place. */
const presets: readonly Preset[] = [
  {
    id: 'a-hundred',
    label: 'A hundred darts',
    caption: ['A hundred darts gets the first decimal place of ', { v: 'π' }, ' about right, and no more.'],
    values: { darts: 100 },
  },
  {
    id: 'ten-thousand',
    label: 'Ten thousand',
    caption: 'A hundred times more darts buys exactly one more decimal place.',
    values: { darts: 10_000 },
  },
  {
    id: 'one-million',
    label: 'One million',
    caption: 'A million darts pins down about three decimals, and the plot’s straight line shows it never speeds up.',
    values: { darts: 1_000_000 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Stanisław Ulam thought of the method in 1946 while playing solitaire, wondering whether dealing ' +
      'the cards a hundred times and counting the wins would be quicker than working out the odds.',
    source: {
      label: "Metropolis, 'The Beginning of the Monte Carlo Method', Los Alamos Science 15 (1987), 125–130",
      url: 'https://en.wikipedia.org/wiki/Monte_Carlo_method',
    },
  },
  {
    text: [
      'Every extra decimal place of ', { v: 'π' }, ' costs a hundred times more darts, which is why the ',
      'record calculations use a formula that gains fourteen digits per step instead.',
    ],
    source: {
      label: 'Chudnovsky and Chudnovsky (1988); Chudnovsky algorithm',
      url: 'https://en.wikipedia.org/wiki/Chudnovsky_algorithm',
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

/** Darts this run will throw, clamped the way `step()` clamps its own ceiling. */
function dartTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_TARGET, Math.floor(num(values, 'darts', DEFAULT_DARTS))));
}

/** Pixel size out of a CSS font shorthand, for sizing a display window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * A display window: an opaque plate of the canvas colour with a 1 px frame.
 *
 * Opaque because three thousand darts read straight through a translucent one,
 * and the frame takes the container pen — a window holds the experiment's
 * numbers, it is not part of the experiment.
 */
function paintWindow(
  fg: CanvasRenderingContext2D,
  canvas: string,
  frame: string,
  lineWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const snap = lineWidth % 2 === 1 ? 0.5 : 0;
  fg.fillStyle = canvas;
  fg.fillRect(x, y, w, h);
  fg.strokeStyle = frame;
  fg.lineWidth = lineWidth;
  // Inset by half a line width so the frame lands inside the plate it draws.
  fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);
}

function create(ctx: VizContext): VizInstance {
  const field = new DartField(MAX_DARTS);
  const history = new ErrorHistory();

  // Structural: the run's ceiling. It changes what the background layer holds
  // — the x axis spans the run — so it is re-read by `paintBackground`.
  let maxDarts = DEFAULT_DARTS;
  let layout = layoutPlate(ctx.width, ctx.height, SHOW_ERROR_PLOT);
  let scale = plotScale(layout.plot ?? layout.field, maxDarts);

  // Fractional darts owed by the rate accumulator between ticks.
  let pending = 0;

  function syncStructure(): void {
    maxDarts = dartTarget(ctx.params);
    layout = layoutPlate(ctx.width, ctx.height, SHOW_ERROR_PLOT);
    scale = plotScale(layout.plot ?? layout.field, maxDarts);
  }

  /**
   * The estimate is the headline; the two counts are the plain sentence under
   * it; the two error figures are for the exact table only. `label`, `target`
   * and `digits` are what the tests read, and stay as they are.
   */
  function readouts(): Readout[] {
    const darts = field.darts;
    const inside = field.inside;
    const pi = estimatePi(inside, darts);
    return [
      { key: 'darts', label: 'Darts', value: darts, digits: 7, plain: 'darts thrown' },
      { key: 'inside', label: 'Inside the circle', value: inside, digits: 7, plain: 'landed in the circle' },
      {
        key: 'pi',
        label: 'π estimate',
        value: pi,
        digits: 6,
        target: Math.PI,
        headline: true,
        plain: 'our estimate of pi',
        // The ledger's 1% default is 0.031 on π — nineteen standard errors at a
        // million darts, so the row would read "converged" whatever the
        // simulation did. Three standard errors at the count the run is going
        // to reach is the honest bar, and it is the same bet the plot draws:
        // the reading starts off and arrives at agreement as the darts land,
        // rather than being true from the first one.
        tolerance: (3 * piStandardError(maxDarts)) / Math.PI,
      },
      { key: 'error', label: 'Absolute error', value: Math.abs(pi - Math.PI), digits: 3, expertOnly: true },
      {
        // The label carries the formula so the exact table names the reference
        // line the plot draws; the plot's own key says "expected".
        key: 'se',
        label: `Std. error, ${PI_SE_COEFFICIENT.toFixed(2)}/√n`,
        value: piStandardError(darts),
        digits: 3,
        expertOnly: true,
      },
    ];
  }

  /**
   * Repaint the background layer.
   *
   * Called by `drawBackground()` and, unusually, from `onParamChange` as well:
   * the plot's frame and its decade axis are static geometry and therefore live
   * here, but raising the dart ceiling moves them, and the shell repaints the
   * background only for a change the visualization *refuses*. Refusing it
   * would throw a two-million-dart run away for a longer axis, so it is
   * absorbed and this is called directly.
   */
  function paintBackground(): void {
    syncStructure();
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    bg.clearRect(0, 0, width, height);

    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    const f = layout.field;

    // The square is what the darts are thrown at, and it contains the
    // experiment rather than being it: container pen, hairline.
    bg.strokeStyle = theme.gridSoft;
    bg.lineWidth = theme.lineWidth;
    bg.strokeRect(
      Math.round(f.x) + snap,
      Math.round(f.y) + snap,
      Math.round(f.width) - 2 * snap,
      Math.round(f.height) - 2 * snap,
    );

    // The circle *is* the experiment — "inside" means inside this — so it takes
    // the apparatus pen, at 2 px: a hairline under three thousand darts is not
    // a boundary anyone can see.
    bg.strokeStyle = theme.grid;
    bg.lineWidth = 2 * theme.lineWidth;
    bg.beginPath();
    bg.arc(f.x + f.width / 2, f.y + f.height / 2, f.width / 2, 0, TAU);
    bg.stroke();

    const plot = layout.plot;
    if (!plot) return;

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

    // Decade ticks hang outside the box: a log-log plot needs a scale, not a
    // lattice of rules over the two curves it exists to compare.
    const xDecades = Math.floor(Math.log10(scale.nMax));
    const yLow = Math.round(Math.log10(scale.errMin));
    const yHigh = Math.round(Math.log10(ERR_MAX));
    for (let k = 0; k <= xDecades; k++) {
      const x = Math.round(plotX(scale, 10 ** k)) + snap;
      bg.moveTo(x, bottom);
      bg.lineTo(x, bottom + TICK);
    }
    for (let e = yLow; e <= yHigh; e++) {
      const y = Math.round(plotY(scale, 10 ** e)) + snap;
      bg.moveTo(left - TICK, y);
      bg.lineTo(left, y);
    }
    bg.stroke();

    // Numerals thin out rather than collide: "10⁶" is about 21 px wide at the
    // label size, and a six-decade axis on a phone gives each decade 38.
    bg.font = theme.labelFont;
    bg.fillStyle = theme.inkMuted;
    const everyX = box.width / Math.max(1, xDecades) >= 40 ? 1 : 2;
    bg.textAlign = 'center';
    bg.textBaseline = 'top';
    for (let k = 0; k <= xDecades; k += everyX) {
      bg.fillText(decadeLabel(k), plotX(scale, 10 ** k), bottom + TICK + LABEL_GAP);
    }
    const everyY = box.height / Math.max(1, yHigh - yLow) >= 26 ? 1 : 2;
    bg.textAlign = 'right';
    bg.textBaseline = 'middle';
    for (let e = yHigh; e >= yLow; e -= everyY) {
      bg.fillText(decadeLabel(e), left - TICK - LABEL_GAP, plotY(scale, 10 ** e));
    }
    bg.textAlign = 'left';
    bg.textBaseline = 'bottom';
    bg.fillText('error vs darts', box.x, box.y - LABEL_GAP);
  }

  const instance: VizInstance = {
    step(dt) {
      if (field.darts >= maxDarts) {
        pending = 0;
        return;
      }
      pending += (DART_RATE * dt) / 1000;
      // Darts per tick depend only on dt, and each dart consumes exactly two
      // rng draws, so the dart sequence for a seed is the same however the
      // ticks are batched — only the clock differs.
      while (pending >= 1 && field.darts < maxDarts) {
        field.push(throwDart(ctx.rng));
        history.sample(field.darts, field.inside);
        pending -= 1;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move everything.
      paintBackground();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      fg.clearRect(0, 0, width, height);

      const f = layout.field;
      const half = f.width / 2;
      const ox = f.x + half;
      const oy = f.y + half;
      const r = theme.particleRadius;

      // Paint the newest darts the ink budget affords and let the rest recede.
      // `forEach` skips from the oldest end, which is the right end to drop: a
      // dart's information is already in the counters.
      const perDart = Math.max(1, Math.PI * r * r);
      const affordable = Math.ceil((-Math.log(1 - INK_TARGET) * f.width * f.height) / perDart);
      const skip = Math.max(0, field.count - affordable);

      // Two paths, two fills, batched by colour — never a fillStyle per dart.
      // Misses first so the darts that are actually being counted land on top.
      fg.fillStyle = theme.inkMuted;
      fg.beginPath();
      field.forEach((x, y, inside) => {
        if (inside) return;
        const cx = ox + x * half;
        const cy = oy - y * half;
        fg.moveTo(cx + r, cy);
        fg.arc(cx, cy, r, 0, TAU);
      }, skip);
      fg.fill();

      fg.fillStyle = theme.data1;
      fg.beginPath();
      field.forEach((x, y, inside) => {
        if (!inside) return;
        const cx = ox + x * half;
        const cy = oy - y * half;
        fg.moveTo(cx + r, cy);
        fg.arc(cx, cy, r, 0, TAU);
      }, skip);
      fg.fill();

      if (layout.plot) {
        const curve = 2 * theme.lineWidth;
        if (SHOW_ENVELOPE) {
          // On log-log axes 4·√(p(1−p)/n) is exactly a straight line of slope
          // −½, so the reference is two points, not a sampled curve.
          fg.beginPath();
          fg.moveTo(plotX(scale, 1), plotY(scale, piStandardError(1), HALO_PAD));
          fg.lineTo(plotX(scale, scale.nMax), plotY(scale, piStandardError(scale.nMax), HALO_PAD));
          strokeWithHalo(fg, undefined, theme.data2, theme.canvas, curve);
        }
        if (history.count > 0) {
          // The measured error crosses the reference line repeatedly and the two
          // pens are 1.96:1 apart, so the plate colour goes down between them.
          fg.lineJoin = 'round';
          fg.beginPath();
          history.forEach((n, error) => {
            fg.lineTo(plotX(scale, n), plotY(scale, error, HALO_PAD));
          });
          strokeWithHalo(fg, undefined, theme.data1, theme.canvas, curve);
        }
        paintLegend(fg);
      }

      // Live π in the field's top-right corner, which is the one region of the
      // square the circle never reaches and so the least informative place to
      // put a window. Published through emit() below as well; the canvas itself
      // is aria-hidden.
      const pi = estimatePi(field.inside, field.darts);
      const label = `π ≈ ${Number.isNaN(pi) ? '—' : pi.toFixed(4)}`;
      const pad = 5;
      const textH = fontPx(theme.labelFont);
      fg.font = theme.labelFont;
      fg.textAlign = 'right';
      fg.textBaseline = 'top';
      const textW = fg.measureText(label).width;
      const wx = Math.round(f.x + f.width - 8 - textW - pad);
      const wy = Math.round(f.y + 8 - pad);
      paintWindow(
        fg,
        theme.canvas,
        theme.gridSoft,
        theme.lineWidth,
        wx,
        wy,
        Math.round(textW + 2 * pad),
        Math.round(textH + 2 * pad),
      );
      fg.fillStyle = theme.ink;
      fg.fillText(label, f.x + f.width - 8, f.y + 8);

      ctx.emit(readouts());
    },

    onParamChange(key) {
      switch (key) {
        case 'darts': {
          // Asymmetric, for the reason Buffon's ceiling is: a dart consumes the
          // same two draws whatever the ceiling, so the run on screen is a true
          // prefix of the run a fresh load at the higher ceiling would produce,
          // and raising it continues the same sequence instead of restarting
          // it. Below the darts already thrown there is no honest reading — the
          // ledger would go on reporting a million while the control, the
          // caption and the permalink all said ten thousand — so the shell
          // resets instead.
          if (dartTarget(ctx.params) < field.darts) return false;
          paintBackground();
          return true;
        }
        default:
          // seed: the darts already down belong to a different experiment.
          return false;
      }
    },

    reset() {
      syncStructure();
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      field.reset();
      history.reset();
      pending = 0;
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  /**
   * The key to the two curves, in the box's top-right corner — where both of
   * them have already descended out of the way.
   *
   * On the foreground rather than the background, and painted after the curves,
   * because the background layer is *under* them: a key the data draws over is
   * not a key. It is one fillRect, one strokeRect and two short strokes.
   *
   * The reference line is keyed "expected", not by its formula: the formula
   * is in the exact table for anyone who opens it, and a reader who would have
   * to ask what 1.64/√n means is the reader this plate is for.
   */
  function paintLegend(fg: CanvasRenderingContext2D): void {
    const { theme } = ctx;
    const box = scale.box;
    const rows: ReadonlyArray<[string, string]> = SHOW_ENVELOPE
      ? [
          ['measured', theme.data1],
          ['expected', theme.data2],
        ]
      : [['measured', theme.data1]];

    const sample = 14;
    const gap = 5;
    const pad = 5;
    const textH = fontPx(theme.labelFont);
    const step = textH + 4;
    fg.font = theme.labelFont;
    let textW = 0;
    for (const [text] of rows) textW = Math.max(textW, fg.measureText(text).width);

    const w = Math.round(2 * pad + sample + gap + textW);
    const h = Math.round(2 * pad + rows.length * step - 4);
    // A key that does not fit is worse than none: it would sit on the curves.
    if (w > box.width - 12 || h > box.height - 12) return;

    const x = Math.round(box.x + box.width - 6 - w);
    const y = Math.round(box.y + 6);
    paintWindow(fg, theme.canvas, theme.gridSoft, theme.lineWidth, x, y, w, h);

    fg.textAlign = 'left';
    fg.textBaseline = 'middle';
    fg.lineWidth = 2 * theme.lineWidth;
    rows.forEach(([text, pen], i) => {
      const cy = y + pad + i * step + textH / 2;
      fg.strokeStyle = pen;
      fg.beginPath();
      fg.moveTo(x + pad, cy);
      fg.lineTo(x + pad + sample, cy);
      fg.stroke();
      fg.fillStyle = theme.ink;
      fg.fillText(text, x + pad + sample + gap, cy);
    });
  }

  instance.reset();
  return instance;
}

/** `10⁻⁴`, `10²`. Unicode superscripts, so the numeral needs no second line. */
function decadeLabel(exponent: number): string {
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const n = Math.abs(exponent);
  let sup = '';
  for (const ch of String(n)) sup += digits[Number(ch)] ?? '';
  return `10${exponent < 0 ? '⁻' : ''}${sup}`;
}

export const montecarloPi: Viz = {
  id: 'montecarlo-pi',
  title: 'Monte Carlo π',
  group: 'randomness',
  blurb: ['Throws darts at a square and works out ', { v: 'π' }, ' from how many land inside the circle.'],
  // Landscape, because the plate holds two panels: a square field of darts and
  // the convergence plot beside it. Portrait on a phone, where the plot goes
  // under the field instead and a 1.6 bed would leave it 60 px tall.
  aspect: 1.6,
  aspectNarrow: 0.7,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_DARTS },
  create,
};
