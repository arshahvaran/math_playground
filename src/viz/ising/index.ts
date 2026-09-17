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
  CRITICAL_TEMPERATURE,
  SpinLattice,
  WINDOW_SWEEPS,
  comparable,
  nearCritical,
  onsagerMagnetisation,
  roundingAllowance,
} from './lattice';

/**
 * Largest lattice the tab offers, and the size every buffer is allocated at.
 * 128² is 16,384 spins, and a sweep touches every one of them twice — once per
 * checkerboard colour.
 */
const MAX_SIZE = 128;

/** The three lattices the size control offers. Powers of two, so the 1/L finite-size law is one step per chip. */
export const SIZES = [32, 64, 128] as const;
const DEFAULT_SIZE = '64';

export const TEMP_MIN = 1.5;
export const TEMP_MAX = 3.5;
export const TEMP_STEP = 0.05;
const DEFAULT_TEMP = 2.0;

/** Slider positions, and therefore the number of measured points the plot can ever hold. */
export const TEMP_SLOTS = Math.round((TEMP_MAX - TEMP_MIN) / TEMP_STEP) + 1;

const DEFAULT_SEED = 42;

/**
 * Sweeps per second of simulated time. At the engine's 120 Hz tick that is
 * exactly one sweep per step, which is both the fastest the picture stays
 * readable at and well inside the budget: 128² measured at 2,900 sweeps/s in
 * node, so 120 of them is about 4% of one core.
 */
const SWEEPS_PER_SECOND = 120;

/**
 * Sweeps a temperature must be held for before it earns a point on the plot.
 *
 * Half a window. Dragging the slider across the range leaves no trail of
 * half-measured points behind it; parking on a temperature for two and a half
 * seconds does.
 */
const TRAIL_MIN_SWEEPS = WINDOW_SWEEPS / 2;

/**
 * What is painted, as against what is counted.
 *
 * The sweep counter and the average run on without limit; the picture does not
 * grow with them. Every frame paints exactly one L×L blit — 16,384 bytes at the
 * largest lattice, whatever happened between frames, because a fast-forward of
 * two hundred sweeps still ends in one bitmap — and at most `TEMP_SLOTS`
 * measured points, which is 41 by construction: the plot has one point per
 * slider position and a reader cannot manufacture a forty-second. Buffon
 * learned this with twenty thousand needles on a plate that held six hundred.
 */
export const PAINTED_POINTS = TEMP_SLOTS;

/** Plate margins and axis furniture, CSS px. */
const PAD_SIDE = 8;
const AXIS_TICK = 4;
const LABEL_GAP = 3;
/** Air between the lattice and the plot under it. */
const GRID_GAP = 10;
/** The m-axis band: tall enough for the curve's knee, short enough to leave the lattice the plate. */
const PLOT_MIN = 56;
const PLOT_MAX = 140;

/** Temperature ticks on the plot's axis. */
const TICK_STEP = 0.5;

const TAU = 2 * Math.PI;

/**
 * The widest lines the corner window can show. Its plate is sized to these
 * rather than to the text on screen, so the box never changes width as a digit
 * does.
 *
 * Words, not symbols. `T` and `m` are the names the literature uses and they
 * are meaningless to a reader who has not met statistical mechanics, which is
 * every reader this tab is for; the ledger has said "how much of the sheet
 * points one way" all along and the plate said `m`.
 */
const WINDOW_TEMPLATES: readonly string[] = ['heat 3.50', 'agreeing 0.9999'];

/** What the plot under the lattice is a plot of. */
const PLOT_CAPTION = 'how much agrees vs heat';

const params: readonly ParamSpec[] = [
  {
    kind: 'range',
    key: 'temp',
    label: 'Temperature',
    min: TEMP_MIN,
    max: TEMP_MAX,
    step: TEMP_STEP,
    default: DEFAULT_TEMP,
    help: 'How hard heat jostles each little magnet — the sheet loses its direction at 2.269.',
  },
  {
    kind: 'choice',
    key: 'size',
    label: 'Grid size',
    options: SIZES.map((n) => ({ value: String(n), label: `${n} × ${n}` })),
    default: DEFAULT_SIZE,
    help: 'A bigger grid gives a sharper answer and takes longer to settle.',
  },
  // Not a control — the rail never renders a seed spec — but the spec is what
  // binds the seed to the URL: without it a permalink's seed is dropped on the
  // way in and the transport's Shuffle key has nothing to set.
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

const presets: readonly Preset[] = [
  {
    id: 'warm',
    label: 'Warm',
    caption: 'Heat wins: every little magnet keeps flipping and the sheet never settles on a direction.',
    values: { temp: 3 },
  },
  {
    id: 'the-edge',
    label: 'The edge',
    caption: 'Just below the tipping point, patches grow until most of the sheet already points one way.',
    values: { temp: 2.2 },
  },
  {
    id: 'cold',
    label: 'Cold',
    caption: 'One direction has taken the whole sheet, and the exact formula says how nearly all of it agrees.',
    values: { temp: 1.8 },
  },
];

const facts: readonly Fact[] = [
  {
    text:
      'Wilhelm Lenz handed this model to his student Ernst Ising in 1920, and Ising’s thesis solved the ' +
      'one-dimensional chain and found no sudden change at any temperature at all.',
    source: {
      label: 'Ising, “Beitrag zur Theorie des Ferromagnetismus”, Zeitschrift für Physik 31 (1925) 253–258',
      url: 'https://doi.org/10.1007/BF02980577',
    },
  },
  {
    text:
      'Onsager announced the magnetisation formula from the floor of a conference in 1949 and never published ' +
      'a derivation, leaving Chen Ning Yang to work one out and print it three years later.',
    source: {
      label: 'Yang, “The Spontaneous Magnetization of a Two-Dimensional Ising Model”, Physical Review 85 (1952) 808–816',
      url: 'https://doi.org/10.1103/PhysRev.85.808',
    },
  },
];

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

/** Pixel size out of a CSS font shorthand, for the axis gutter and the readout window. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/**
 * A digit's advance in the in-canvas label face, near enough to reserve a
 * gutter with. The face is monospaced at 0.6 em; `measureText` would be exact
 * but `layoutPlate()` has no context to ask, and the layout must not depend on
 * what is being drawn.
 */
function digitWidth(labelHeight: number): number {
  return Math.ceil(0.62 * labelHeight);
}

/** The temperature a parameter set asks for, clamped to the control's own range. */
export function temperatureOf(values: ParamValues): number {
  const t = num(values, 'temp', DEFAULT_TEMP);
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, t));
}

/** The lattice side a parameter set asks for; an unknown one — an old permalink — is the default. */
export function sizeOf(values: ParamValues): number {
  const raw = values['size'];
  const found = SIZES.find((n) => String(n) === String(raw));
  return found ?? Number(DEFAULT_SIZE);
}

export interface PlateLayout {
  /** Side of the square lattice area, CSS px. */
  side: number;
  gridX: number;
  gridY: number;
  /** The plot band: m = 1 at `plotTop`, m = 0 at `plotBottom`. */
  plotX0: number;
  plotX1: number;
  plotTop: number;
  plotBottom: number;
}

/**
 * Where the lattice and the plot sit on a plate `width` × `height`.
 *
 * The plot is measured up from the bottom — a gutter for the temperature
 * numerals, then a fixed band for m ∈ [0, 1] — and the lattice takes a centred
 * square of whatever is left. Both are derived from the plate rather than from
 * any reading, so nothing here moves when a digit changes.
 *
 * The m scale gets a gutter of its own on the left, outside the band. Onsager's
 * curve comes in at 0.9865 at the cold end of the axis, which is the top-left
 * corner, so a numeral printed inside the band there lands underneath it.
 *
 * Between the lattice and the plot sits one line of caption, so the square is
 * measured from the top pad down to *that* rather than down to the plot. The
 * top pad is the reason the square is measured from `PAD_SIDE` and not from
 * zero: at the declared aspect the height binds, and a square centred in the
 * whole of the space above the plot was landing on y = 0 with its own boundary
 * stroke half off the canvas.
 */
export function layoutPlate(width: number, height: number, labelHeight: number): PlateLayout {
  const gutter = AXIS_TICK + LABEL_GAP + labelHeight + 2;
  const leftGutter = digitWidth(labelHeight) + LABEL_GAP + AXIS_TICK;
  const band = Math.max(PLOT_MIN, Math.min(PLOT_MAX, Math.round(0.24 * height)));
  const plotBottom = Math.max(1, Math.round(height - gutter));
  const plotTop = Math.max(1, plotBottom - band);
  const captionBand = labelHeight + LABEL_GAP;
  const available = Math.max(8, plotTop - captionBand - GRID_GAP - PAD_SIDE);
  const side = Math.max(8, Math.min(Math.floor(width) - 2 * PAD_SIDE, available));
  const plotX0 = PAD_SIDE + leftGutter;
  return {
    side,
    gridX: Math.round((width - side) / 2),
    gridY: PAD_SIDE + Math.max(0, Math.round((available - side) / 2)),
    plotX0,
    plotX1: Math.max(plotX0 + 1, Math.floor(width) - PAD_SIDE),
    plotTop,
    plotBottom,
  };
}

/**
 * The scratch bitmap the spins are blitted through.
 *
 * `ImageData` holds raw RGBA bytes and every colour on this plate has to come
 * from `ctx.theme`, so the bitmap carries no colour at all: it is an alpha
 * mask, opaque where a spin is up and clear where it is down. One `source-in`
 * fill stains the whole mask with the theme's own pen, and `drawImage` scales
 * the result onto the plate. That is 16,384 byte writes at the largest lattice
 * instead of 16,384 `fillRect` calls, and not one colour is parsed.
 *
 * Null where there is no document to make a canvas in — a non-browser host —
 * in which case the lattice simply is not painted and every reading still
 * publishes through `emit()`.
 */
interface SpinSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
}

function createSpinSurface(size: number): SpinSurface | null {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c2d = canvas.getContext('2d');
    if (!c2d || typeof c2d.createImageData !== 'function') return null;
    return { canvas, ctx: c2d, image: c2d.createImageData(size, size) };
  } catch {
    return null;
  }
}

function create(ctx: VizContext): VizInstance {
  const lattice = new SpinLattice(MAX_SIZE, temperatureOf(ctx.params));
  const surface = createSpinSurface(MAX_SIZE);

  let layout = layoutPlate(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));

  /**
   * One settled reading per slider position, and the temperature it was taken
   * at. Allocated once at the slot count; NaN is "never measured here".
   */
  const trail = new Float64Array(TEMP_SLOTS).fill(NaN);
  const trailTemp = new Float64Array(TEMP_SLOTS);

  /** Fractional sweeps owed between ticks. */
  let pending = 0;

  function slotFor(temperature: number): number {
    const k = Math.round((temperature - TEMP_MIN) / TEMP_STEP);
    return Math.max(0, Math.min(TEMP_SLOTS - 1, k));
  }

  function tempToX(temperature: number): number {
    const span = TEMP_MAX - TEMP_MIN;
    return layout.plotX0 + ((temperature - TEMP_MIN) / span) * (layout.plotX1 - layout.plotX0);
  }

  function magnetToY(m: number): number {
    return layout.plotBottom - m * (layout.plotBottom - layout.plotTop);
  }

  /** Re-read the plate and the structural parameter. Never touches the temperature: a resize is not a new experiment. */
  function syncLayout(): void {
    layout = layoutPlate(ctx.width, ctx.height, fontPx(ctx.theme.labelFont));
    lattice.setSize(sizeOf(ctx.params));
  }

  function readouts(): Readout[] {
    const temperature = lattice.temperature;
    const size = lattice.size;
    const measured = lattice.magnetisation;
    const exact = onsagerMagnetisation(temperature);
    const error = lattice.averageError;
    const statistical = Number.isFinite(error) ? error : 0;

    // The comparison is published only where a lattice this size can carry it:
    // in the ordered phase, and outside the band around T_c where the finite
    // lattice rounds the transition into a crossover. Above T_c the exact answer
    // is zero and a finite grid never reads zero — it reads about 1.65/L at
    // T = 4, measured as 0.0520 / 0.0257 / 0.0128 at L = 32 / 64 / 128 — so a
    // "prediction" the reading must miss would be worse than no prediction.
    const compare = comparable(temperature, size);

    return [
      {
        key: 'magnet',
        label: 'Average |M| per spin',
        value: measured,
        digits: 4,
        plain: 'how much of the sheet points one way',
        headline: true,
        // A magnetisation per spin is |M| ≤ 1 by construction, and the ledger
        // judges a band against the smaller of that span and the prediction.
        range: [0, 1],
        ...(compare
          ? {
              target: exact,
              // Two independent errors, added rather than combined in
              // quadrature because one of them is a systematic bound and not a
              // spread: the finite-size rounding the lattice is entitled to,
              // and three standard errors of the time average from the spread
              // of its block means. Absolute, in |M|'s own units — the band and
              // the target are now declared in the same place, so a temperature
              // with no prediction cannot leave a stray `0` behind it, which
              // under the rule that reads 0 as "exactly" would be a claim of
              // machine precision.
              band: {
                kind: 'absolute',
                half: roundingAllowance(temperature, size) + 3 * statistical,
              },
              // §5: the hero prints "analytic" and the closed form the target
              // came from. T is the temperature — italic, like every variable.
              formula: ['(1 − sinh(2/', { v: 'T' }, ')⁻⁴)', '^(1/8)'],
            }
          : nearCritical(temperature, size)
            ? { hint: 'right at the tipping point, where a grid this small cannot give a straight answer' }
            : { hint: 'on an endless sheet this would be exactly 0 — a small grid always keeps a little left over' }),
      },
      { key: 'temp', label: 'Temperature', value: temperature, digits: 3, plain: 'temperature' },
      { key: 'sweeps', label: 'Sweeps at this temperature', value: lattice.sweeps, digits: 6, plain: 'passes over the grid' },
      { key: 'onsager', label: 'Onsager |M|', value: exact, digits: 6, expertOnly: true },
      { key: 'tc', label: 'Critical temperature', value: CRITICAL_TEMPERATURE, digits: 7, expertOnly: true },
      { key: 'energy', label: 'Energy per spin', value: lattice.energyPerSpin, digits: 4, expertOnly: true },
      { key: 'se', label: 'Std. error of the average', value: error, digits: 3, expertOnly: true },
      { key: 'spins', label: 'Spins', value: size * size, digits: 6, expertOnly: true },
    ];
  }

  /** The live reading as a display window, top-right of the plot. */
  function drawWindow(fg: CanvasRenderingContext2D, lines: readonly string[]): void {
    const { theme } = ctx;
    const pad = 5;
    const lineHeight = fontPx(theme.labelFont) + 3;
    fg.font = theme.labelFont;
    fg.textAlign = 'left';
    fg.textBaseline = 'top';
    let textW = 0;
    for (const line of WINDOW_TEMPLATES) textW = Math.max(textW, fg.measureText(line).width);
    const w = Math.round(textW + 2 * pad);
    const h = Math.round(lines.length * lineHeight + 2 * pad);
    const x = Math.round(layout.plotX1 - w);
    const y = Math.round(layout.plotTop);
    const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
    // Opaque, because the measured points and the marker read straight through
    // a translucent plate; the frame is furniture, so it takes the container pen.
    fg.fillStyle = theme.canvas;
    fg.fillRect(x, y, w, h);
    fg.strokeStyle = theme.gridSoft;
    fg.lineWidth = theme.lineWidth;
    fg.strokeRect(x + snap, y + snap, w - 2 * snap, h - 2 * snap);
    fg.fillStyle = theme.ink;
    lines.forEach((line, i) => fg.fillText(line, x + pad, y + pad + i * lineHeight));
  }

  const instance: VizInstance = {
    step(dt) {
      pending += (SWEEPS_PER_SECOND * dt) / 1000;
      while (pending >= 1) {
        lattice.sweep(ctx.rng);
        pending -= 1;
      }
      // A temperature keeps its point once the sheet has been held there long
      // enough for the average to mean something. Recording is simulation
      // state, so it happens here and never in draw().
      if (lattice.measuredSweeps >= TRAIL_MIN_SWEEPS) {
        const k = slotFor(lattice.temperature);
        trail[k] = lattice.magnetisation;
        trailTemp[k] = lattice.temperature;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here, and both move the plot.
      syncLayout();
      const bg = ctx.layers.background;
      const { width, height, theme } = ctx;
      bg.clearRect(0, 0, width, height);

      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const { plotX0, plotX1, plotTop, plotBottom } = layout;

      // The temperature axis and the T_c rule contain the experiment rather
      // than being part of it, so both take the container pen.
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      const baseline = Math.round(plotBottom) + snap;
      bg.moveTo(plotX0, baseline);
      bg.lineTo(plotX1, baseline);
      for (let t = TEMP_MIN; t <= TEMP_MAX + 1e-9; t += TICK_STEP) {
        const x = Math.round(tempToX(t)) + snap;
        bg.moveTo(x, baseline);
        bg.lineTo(x, baseline + AXIS_TICK);
      }
      const criticalX = Math.round(tempToX(CRITICAL_TEMPERATURE)) + snap;
      bg.moveTo(criticalX, plotTop);
      bg.lineTo(criticalX, plotBottom);
      // The m scale: two ticks into its own gutter, so the numerals sit outside
      // the band the curve occupies.
      const top = Math.round(plotTop) + snap;
      bg.moveTo(plotX0, top);
      bg.lineTo(plotX0 - AXIS_TICK, top);
      bg.moveTo(plotX0, baseline);
      bg.lineTo(plotX0 - AXIS_TICK, baseline);
      bg.stroke();

      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;
      bg.textBaseline = 'top';
      bg.textAlign = 'center';
      const labelW = bg.measureText('3.5').width;
      for (let t = TEMP_MIN; t <= TEMP_MAX + 1e-9; t += TICK_STEP) {
        // Nudged inside at the ends: a numeral centred on the first tick hangs
        // half its width off the plate and is cut in two.
        const at = tempToX(t);
        const x = Math.min(Math.max(at, plotX0 + labelW / 2), plotX1 - labelW / 2);
        bg.fillText(t.toFixed(1), x, baseline + AXIS_TICK + LABEL_GAP);
      }
      // The tipping point, low and to the left of its own rule. Everything else
      // in the band is either the curve or a point sitting on it, so the empty
      // triangle under the curve and left of the plunge is the one place a
      // label is never under a mark — on a phone the band is 118 px and the top
      // is not. "tips at", not "Tc": the triangle is 116 px wide at the narrow
      // plate and the longer phrase runs back out of it into the m gutter.
      bg.textAlign = 'right';
      bg.textBaseline = 'bottom';
      bg.fillText(`tips at ${CRITICAL_TEMPERATURE.toFixed(3)}`, criticalX - 4, plotBottom - 2);
      // The m scale, in the gutter, centred on the ends of the band it labels.
      // The caption above the band is what makes the 1 and the 0 mean anything.
      bg.textBaseline = 'middle';
      const scaleX = plotX0 - AXIS_TICK - LABEL_GAP;
      bg.fillText('1', scaleX, plotTop);
      bg.fillText('0', scaleX, plotBottom);
      bg.textAlign = 'left';
      bg.textBaseline = 'bottom';
      bg.fillText(PLOT_CAPTION, plotX0, plotTop - LABEL_GAP);

      // Onsager's exact curve, the whole way across: the formula below T_c and
      // flat zero above it. One sample per pixel, and the halo goes under it
      // because it crosses the axis rule and the T_c rule it is drawn over.
      bg.lineJoin = 'round';
      bg.beginPath();
      for (let x = plotX0; x <= plotX1; x++) {
        const t = TEMP_MIN + ((x - plotX0) / (plotX1 - plotX0)) * (TEMP_MAX - TEMP_MIN);
        bg.lineTo(x, magnetToY(onsagerMagnetisation(t)));
      }
      strokeWithHalo(bg, undefined, theme.data2, theme.canvas, 2 * theme.lineWidth);
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;
      const { side, gridX, gridY, plotTop, plotBottom } = layout;
      fg.clearRect(0, 0, width, height);

      const L = lattice.size;

      // The sheet, as two marks: an opaque graphite wash for the spins pointing
      // down, and the vermilion ups stained through the alpha mask on top. The
      // wash is never a globalAlpha — a translucent graphite composites to a
      // ghost and then nothing in the figure carries 3:1.
      fg.fillStyle = theme.data3Fill;
      fg.fillRect(gridX, gridY, side, side);
      if (surface) {
        const data = surface.image.data;
        const spins = lattice.spins;
        for (let y = 0; y < L; y++) {
          const row = y * L;
          // Alpha byte of pixel (0, y) in the MAX_SIZE-wide mask.
          let p = y * MAX_SIZE * 4 + 3;
          for (let x = 0; x < L; x++) {
            data[p] = spins[row + x] === 1 ? 255 : 0;
            p += 4;
          }
        }
        const sfg = surface.ctx;
        sfg.putImageData(surface.image, 0, 0, 0, 0, L, L);
        sfg.globalCompositeOperation = 'source-in';
        sfg.fillStyle = theme.data1;
        sfg.fillRect(0, 0, MAX_SIZE, MAX_SIZE);
        sfg.globalCompositeOperation = 'source-over';
        fg.save();
        // Nearest neighbour, so every cell stays a flat block of its own pen.
        // Smoothing would blend the two into a mid-grey that carries neither
        // pen's contrast, and a lattice is exactly the picture that is nothing
        // but single-pixel structure.
        fg.imageSmoothingEnabled = false;
        fg.drawImage(surface.canvas, 0, 0, L, L, gridX, gridY, side, side);
        fg.restore();
      }

      // The lattice's own boundary. The down spins are an area on this plate —
      // an opaque wash under the vermilion ups — so its edge is the area's
      // silhouette and takes the graphite pen at 2 px, not the container pen.
      //
      // On this layer and after the blit, inset by half its own width so the
      // whole stroke lands inside the square. Stroked on the background and
      // centred on the edge, the wash above repainted its inner half every
      // frame and left a 1 CSS px hairline — and §7 is explicit that a 1 px
      // mark is never drawn in the graphite pen, at 1.77:1 on the plate.
      const edge = 2 * theme.lineWidth;
      fg.strokeStyle = theme.data3;
      fg.lineWidth = edge;
      fg.strokeRect(gridX + edge / 2, gridY + edge / 2, side - edge, side - edge);

      // Where the reader is standing on the temperature axis. Furniture, so the
      // container pen — and it goes down before the measurements, which are the
      // data and belong on top.
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      const cursorX = Math.round(tempToX(lattice.temperature)) + snap;
      fg.strokeStyle = theme.gridSoft;
      fg.lineWidth = theme.lineWidth;
      fg.beginPath();
      fg.moveTo(cursorX, plotTop);
      fg.lineTo(cursorX, plotBottom);
      fg.stroke();

      // Every temperature the reader has settled on, as one path. The halo is
      // the +2 a mark gets: these land on the analytic curve by construction,
      // and vermilion on blue-black is 1.96:1 — so the plate colour is stroked
      // between them and the two pens never touch.
      const r = theme.particleRadius;
      fg.beginPath();
      let painted = 0;
      for (let k = 0; k < TEMP_SLOTS; k++) {
        const m = trail[k]!;
        if (!Number.isFinite(m)) continue;
        const x = tempToX(trailTemp[k]!);
        const y = magnetToY(m);
        fg.moveTo(x + r, y);
        fg.arc(x, y, r, 0, TAU);
        painted++;
      }
      if (painted > 0) {
        fg.lineWidth = 2 * theme.lineWidth + 2;
        fg.strokeStyle = theme.canvas;
        fg.stroke();
        fg.fillStyle = theme.data1;
        fg.fill();
      }

      // The live reading, one size up: the only thing on this plate that is
      // current and moving.
      const live = lattice.magnetisation;
      if (Number.isFinite(live)) {
        const x = tempToX(lattice.temperature);
        const y = magnetToY(live);
        fg.beginPath();
        fg.moveTo(x + r + 1.5, y);
        fg.arc(x, y, r + 1.5, 0, TAU);
        fg.lineWidth = 2 * theme.lineWidth + 2;
        fg.strokeStyle = theme.canvas;
        fg.stroke();
        fg.fillStyle = theme.data1;
        fg.fill();
      }

      drawWindow(fg, [
        `heat ${lattice.temperature.toFixed(2)}`,
        `agreeing ${Number.isFinite(live) ? live.toFixed(4) : '—'}`,
      ]);

      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      if (key !== 'temp') return false;
      // Absorbed, and this is the tab. The spins carry over, so turning the
      // temperature down through T_c cools the sheet the reader is looking at:
      // the domains coarsen, flicker, and one of them takes the whole plate.
      // Restarting the lattice here would replace that with a cut.
      lattice.setTemperature(Math.min(TEMP_MAX, Math.max(TEMP_MIN, asNumber(value, DEFAULT_TEMP))));
      return true;
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      lattice.setSize(sizeOf(ctx.params));
      lattice.setTemperature(temperatureOf(ctx.params));
      lattice.reset();
      trail.fill(NaN);
      pending = 0;
      syncLayout();
      ctx.layers.foreground.clearRect(0, 0, ctx.width, ctx.height);
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  instance.reset();
  return instance;
}

export const ising: Viz = {
  id: 'ising',
  title: 'The Ising Magnet',
  group: 'chaos',
  blurb:
    'Heats a sheet of tiny magnets until they stop agreeing with their neighbours, and cools it until one direction takes the whole sheet.',
  // Portrait: the lattice is square and wants nearly the full width of the
  // plate, and the plot of what was measured against Onsager's exact curve goes
  // under it, with one line of caption between them. 0.74 is what leaves the
  // square within a margin of the plate's width at the heights `--viz-max-h`
  // allows — 380 of 420 px — rather than letterboxed; narrower still on a
  // phone, where the width is clamped by the bench before the height binds.
  aspect: 0.74,
  aspectNarrow: 0.7,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_SIZE * MAX_SIZE },
  create,
};
