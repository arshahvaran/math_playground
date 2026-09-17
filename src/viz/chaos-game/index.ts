import type {
  Fact,
  ParamSpec,
  ParamValue,
  ParamValues,
  Preset,
  Prose,
  Readout,
  Viz,
  VizContext,
  VizInstance,
} from '../../core/types';
import {
  BOX_MAX_LEVEL,
  boxCountingDimension,
  branching,
  createChaosGame,
  findSystem,
  polygonOpenSetRatio,
  polygonVertex,
  restrictedDimension,
  type AffineMap,
  type Bounds,
  type NamedSystem,
  type Restriction,
} from './ifs';

/**
 * Hard ceiling on points, and the `points` slider's top. Nothing is stored per
 * point — see `Occupancy` — so this is a budget on time, not on memory: two
 * million points is about a second of plotting.
 */
const MAX_POINTS = 2_000_000;

/**
 * The `points` fader's floor: the fewest dots at which every shape on the menu
 * can still be measured.
 *
 * It is a property of the estimator, not of the picture. `boxCountingDimension`
 * keeps a dyadic level only while its occupied boxes hold ten points each on
 * average, because below that N(ε) has stopped counting the attractor and
 * started counting the sample. The filled square is the binding case: it
 * genuinely occupies all 1,024 boxes at level 5, so the level survives only from
 * 10,240 points up, and under that the fit is left with a single level and
 * returns NaN — a headline that is an em dash on a *finished* run, which is the
 * same dead band the DLA fader had in its bottom fifth.
 *
 * Measured across all four targeted shapes at three seeds, 20,000 points is
 * where every one of them produces a reading: the square exactly 2, the
 * Sierpiński triangle within 0.027 of log 3 / log 2, the pentagon within 0.032,
 * and the restricted square within 0.067 — the last still outside `DIM_TOLERANCE`
 * and correctly reported as not there yet, which is a verdict rather than a
 * missing number. The old floor of 1,000 was where 0.7857 came from.
 */
const MIN_POINTS = 20_000;

const DEFAULT_POINTS = 200_000;
const DEFAULT_SEED = 42;

/**
 * Was the "Points per frame" slider. Fixed, because speed is the transport's
 * job and not the tab's: at 60 frames of simulation time a second this is
 * 120,000 points a second, and the transport's multiplier scales it.
 */
const POINTS_PER_FRAME = 2_000;

/**
 * Was the "Colour by vertex" toggle. Fixed on: the two pens are what let a
 * reader see that the shape is made of smaller copies of itself, and a switch
 * for it was one more thing to explain.
 */
const COLOUR_BY_VERTEX = true;

/**
 * Points held for the live cursor, and the chunk the plotter works in.
 *
 * A chaos game is cumulative — a point, once plotted, never moves — so the
 * accumulated picture lives on the background layer and in the occupancy grid,
 * and only the newest points are kept as coordinates. Fast-forward runs
 * thousands of ticks between two paints, so `step()` plots in chunks of this
 * size and records each chunk's pens before the ring wraps over them.
 */
const RECENT = 1 << 15;

/** Jumps drawn as a trail behind the current point. Enough to read as motion at a low rate. */
const TRAIL = 12;

/** Plate margin, CSS px. */
const MARGIN = 8;

/**
 * Absolute error inside which the box count counts as agreeing with the closed
 * form, and the tolerance the ledger's needle is scaled by.
 *
 * Box counting has no standard error to quote — the estimate is a regression on
 * five deterministic counters, not a mean over trials. What it has instead is a
 * discretisation bias: N(ε) = C·ε^−D only up to a bounded oscillation, because
 * the grid is not aligned with the attractor's own subdivision, and the
 * five-point least squares damps that oscillation to a few hundredths. Measured
 * across the shapes this tab offers, at 10⁶ points and levels 4…8: +0.0117 for
 * the Sierpiński triangle, −0.0083 for the pentagon, −0.0136 for the filled
 * square, +0.0052 for the restricted square. 0.05 is roughly four times the
 * largest of those and is what the same regression is worth at 10⁵ points too.
 */
const DIM_TOLERANCE = 0.05;

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------
// The shape menu
// ---------------------------------------------------------------------------

/**
 * One entry of the shape menu: a named system and the rule its jumps obey.
 *
 * The vertex count and the jump ratio were sliders, and the restriction rule
 * was a third control. All three now ride on the shape. Every named system
 * carries its own (n, r) — ½ for the triangle and the square, 1/(1 + φ) for the
 * pentagon — so no slider can combine with a named shape into a picture whose
 * published dimension is wrong. And the one rule the tab still teaches, the
 * square that must never jump to the corner it just used, is a menu entry of
 * its own: the teaching moment is then two entries apart rather than two
 * controls apart. The other rules keep their mathematics in `ifs.ts`.
 */
export interface Shape {
  readonly id: string;
  readonly label: string;
  readonly system: NamedSystem;
  readonly restriction: Restriction;
}

function shape(id: string, label: string, systemId: string, restriction: Restriction = 'none'): Shape {
  const system = findSystem(systemId);
  // A menu entry naming a system the catalogue does not have is a programming
  // error, and the first test that imports this module reports it.
  if (!system) throw new Error(`chaos-game: no named system "${systemId}" for shape "${id}"`);
  return { id, label, system, restriction };
}

const DEFAULT_SHAPE: Shape = shape('sierpinski', 'Triangle', 'sierpinski');

export const SHAPES: readonly Shape[] = [
  DEFAULT_SHAPE,
  shape('pentagon', 'Pentagon', 'pentagon'),
  shape('square', 'Square', 'square'),
  shape('square-no-repeat', 'Square, never the same corner twice', 'square', 'no-repeat'),
  shape('fern', 'Fern', 'fern'),
  shape('dragon', 'Dragon curve', 'dragon'),
];

function findShape(id: string): Shape | undefined {
  return SHAPES.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Controls, presets, facts
// ---------------------------------------------------------------------------

const params: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'system',
    label: 'Shape',
    options: SHAPES.map((s) => ({ value: s.id, label: s.label })),
    default: DEFAULT_SHAPE.id,
  },
  {
    kind: 'range',
    key: 'points',
    label: 'Dots',
    min: MIN_POINTS,
    max: MAX_POINTS,
    step: 1_000,
    default: DEFAULT_POINTS,
    log: true,
  },
  // Not a control: the rail never renders a seed. It stays a spec so the URL
  // keeps carrying it, Shuffle has something to redraw, and a shared permalink
  // still reproduces the run through coerceParams().
  { kind: 'seed', key: 'seed', label: 'Seed', default: DEFAULT_SEED },
];

/**
 * Three chips that walk to the insight in order: random jumps make an exact
 * shape; the same game on a square makes no shape at all; one rule brings the
 * shape back. The last two differ in nothing but the rule.
 */
const presets: readonly Preset[] = [
  {
    id: 'triangle',
    label: 'Triangle',
    caption: 'Jump halfway to a random corner, 200,000 times, and the same triangle appears every time.',
    values: { system: 'sierpinski', points: 200_000 },
  },
  {
    id: 'square-fills',
    label: 'Square fills',
    caption: 'Four corners instead of three and there is no pattern at all: the square just fills in solid.',
    values: { system: 'square', points: 1_000_000 },
  },
  {
    id: 'add-a-rule',
    label: 'Add one rule',
    caption:
      'Add one rule to the same square, never the corner you just used, and a pattern appears: the rule makes the shape, not the luck.',
    values: { system: 'square-no-repeat', points: 1_000_000 },
  },
];

const facts: readonly Fact[] = [
  {
    text: 'Michael Barnsley named the chaos game in his 1988 book Fractals Everywhere, and the fern in the shape menu is his: four jump rules, and the one used only once in a hundred jumps is what draws the stem.',
    source: {
      label: 'Barnsley, Fractals Everywhere (Academic Press, 1988), §3.8 and Table 3.8.3',
      url: 'https://en.wikipedia.org/wiki/Barnsley_fern',
    },
  },
  {
    text: 'It does not matter where the first dot starts: John Hutchinson proved in 1981 that a set of jump rules like these has exactly one shape it settles onto, which is why this tab throws its first twenty dots away.',
    source: {
      label: 'Hutchinson, “Fractals and self-similarity”, Indiana Univ. Math. J. 30 (1981), 713–747',
      url: 'https://doi.org/10.1512/iumj.1981.30.30055',
    },
  },
];

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function num(values: ParamValues, key: string, fallback: number): number {
  return asNumber(values[key], fallback);
}

function text(values: ParamValues, key: string, fallback: string): string {
  const v = values[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Points this run will plot, clamped the way the plotter clamps its own target. */
function pointTarget(values: ParamValues): number {
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.floor(num(values, 'points', DEFAULT_POINTS))));
}

/** The system the shape selects, with everything the readouts need. */
export interface ActiveSystem {
  maps: readonly AffineMap[];
  /** Polygon vertices; 0 when the system is not a polygon system. */
  n: number;
  r: number;
  /** The rule the shape carries. A non-polygon system has none. */
  restriction: Restriction;
  bounds?: Bounds;
  /** Vertices a jump may choose from, `n` when unrestricted. */
  branching: number;
  /** Closed-form dimension, NaN when the system has none. */
  dimension: number;
  /**
   * Whether the box count over levels 4…8 actually converges to that closed
   * form, and may therefore be published as its target.
   */
  targeted: boolean;
}

export function resolveSystem(values: ParamValues): ActiveSystem {
  const chosen = findShape(text(values, 'system', DEFAULT_SHAPE.id)) ?? DEFAULT_SHAPE;
  const named = chosen.system;

  if (!named.polygon) {
    // The fern and the dragon: no vertices, no rule, and a closed form only
    // where the maps are similarities. The dragon has one — log 2 / log √2 = 2
    // — but its box count does not reach it at these scales, because its
    // boundary is a dimension-1.5236 curve and the boundary term still carries
    // a third of the count at 1/256. Publishing 2 as a target would mean a
    // ledger that never converges, so the dimension is reported and not claimed.
    const base: ActiveSystem = {
      maps: named.maps,
      n: 0,
      r: NaN,
      restriction: 'none',
      branching: named.maps.length,
      dimension: named.dimension ?? NaN,
      targeted: false,
    };
    return named.bounds ? { ...base, bounds: named.bounds } : base;
  }

  const { n, r } = named.polygon;
  const m = branching(n, chosen.restriction);
  // Below the open-set ratio the pieces meet only on their edges, the formula is
  // exact, and the estimate has something to converge to. Above it they overlap,
  // log m / log(1/r) overcounts, and the true dimension is capped at 2. Every
  // shape on the menu sits at or below its ratio — the pentagon exactly at it,
  // hence the epsilon — and this is the guard that keeps a new entry honest.
  const open = r <= polygonOpenSetRatio(n) + 1e-9;
  return {
    maps: named.maps,
    n,
    r,
    restriction: chosen.restriction,
    branching: m,
    dimension: open ? restrictedDimension(n, r, chosen.restriction) : NaN,
    targeted: open && m > 1,
  };
}

/**
 * Where the attractor sits on the plate, in CSS px.
 *
 * One scale for both axes — a fractal stretched to fill a rectangle is no
 * longer self-similar and its box count would no longer measure anything — and
 * the figure centred on the plate with `margin` clear on the tightest side.
 */
export interface View {
  scale: number;
  /** Plate x of the attractor's x = 0, and plate y of its y = 0. */
  originX: number;
  originY: number;
}

export function layoutView(width: number, height: number, bounds: Bounds, margin: number): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const scale = Math.max(
    1e-6,
    Math.min((width - 2 * margin) / w, (height - 2 * margin) / h),
  );
  return {
    scale,
    originX: width / 2 - (scale * (bounds.minX + bounds.maxX)) / 2,
    // Attractor coordinates are y-up; the plate is y-down.
    originY: height / 2 + (scale * (bounds.minY + bounds.maxY)) / 2,
  };
}

function create(ctx: VizContext): VizInstance {
  let active = resolveSystem(ctx.params);
  const game = createChaosGame(ctx.rng, active.maps, {
    recent: RECENT,
    ...(active.bounds ? { bounds: active.bounds } : {}),
    restriction: active.restriction,
  });

  let view = layoutView(ctx.width, ctx.height, game.bounds, MARGIN);

  /**
   * Which of the two pens last inked each finest-level cell, one bit per cell:
   * 128 KB that lets a resize or a fast-forward repaint a million points in the
   * colours they were plotted in. The occupancy grid says *that* a cell is
   * inked; this says which pen did it.
   */
  const pen = new Uint32Array(Math.max(1, (game.grid.size * game.grid.size) >>> 5));

  /**
   * Which cells the background layer already carries, and which still owe it a
   * mark. Two more bitsets over the same cells, 128 KB each.
   *
   * A chaos game is cumulative: a point, once plotted, never moves. So the
   * background is an *append-only* record and the only work a frame owes it is
   * the cells whose ink changed since the last one — a cell newly occupied, or
   * one the other pen has taken over. `step()` maintains `dirty` as it plots and
   * `draw()` drains it, which is what makes the cost of a frame the cells that
   * changed rather than the cells that exist.
   *
   * It replaces two paths that both scaled with the whole picture. Painting the
   * recent ring point by point cost one `fillRect` per *point* — 24,000 of them
   * per paint inside a Fast-forward press, 240,000 per press, and most of them
   * re-inking a cell that already held that colour. And a burst larger than the
   * ring (a Fast-forward, or the reduced-motion settle, which runs up to 4,800
   * ticks between two frames) fell through to a full rebuild from the occupancy
   * grid: 818,000 `fillRect` calls at two million points on the filled square,
   * which froze the tab for 4.4 s. Neither is work the mathematics asks for.
   */
  const dirty = new Uint32Array(pen.length);
  const inked = new Uint32Array(pen.length);
  /** Cells in `dirty`, so an unchanged frame does not scan the bitset at all. */
  let dirtyCount = 0;

  // The one live parameter, absorbed without disturbing the points already down.
  let target = pointTarget(ctx.params);

  // Fractional points owed by the rate accumulator between ticks.
  let pending = 0;

  /** True until the whole picture has been laid down once: a reset, or a resize. */
  let repaintAll = true;

  /** Finest-level cell of an attractor point, or −1 when it falls outside the grid square. */
  function cellOf(x: number, y: number): number {
    const size = game.grid.size;
    const s = size / game.square.span;
    const cx = ((x - game.square.x0) * s) | 0;
    const cy = ((y - game.square.y0) * s) | 0;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return -1;
    return (cy << game.grid.level) + cx;
  }

  /**
   * Record which pen owns each of the points plotted since `from`, and queue
   * the cells whose ink that changed. Last writer wins.
   *
   * This is render bookkeeping and not simulation state — it advances nothing
   * and reads only what `game.step()` has already decided — but it has to run
   * beside the plotting, because the cursor ring is the only place a point's pen
   * is recorded before it is overwritten.
   */
  function recordInk(from: number): void {
    game.forEachRecent(from, (x, y, vertex) => {
      const index = cellOf(x, y);
      if (index < 0) return;
      const w = index >>> 5;
      const bit = 1 << (index & 31);
      const next = vertex & 1;
      const held = ((pen[w] ?? 0) >>> (index & 31)) & 1;
      if (next === 1) pen[w] = (pen[w] ?? 0) | bit;
      else pen[w] = (pen[w] ?? 0) & ~bit;
      // Already on the layer, in this pen: nothing to repaint. On a saturated
      // attractor that is almost every point, which is what collapses a
      // fast-forward from a rebuild of the picture to a handful of marks.
      if (((inked[w] ?? 0) & bit) !== 0 && held === next) return;
      if (((dirty[w] ?? 0) & bit) === 0) dirtyCount++;
      dirty[w] = (dirty[w] ?? 0) | bit;
    });
  }

  const instance: VizInstance = {
    step(dt) {
      if (game.plotted >= target) {
        pending = 0;
        return;
      }
      // A rate per frame, on a clock that ticks at 120 Hz: sixty frames of
      // simulation time a second, whatever the display is actually doing. One
      // rng draw per point, so the sequence for a seed is the same at every
      // rate and only the clock differs.
      pending += (POINTS_PER_FRAME * 60 * dt) / 1000;
      let owed = Math.min(Math.floor(pending), target - game.plotted);
      pending -= owed;
      while (owed > 0) {
        // In chunks the cursor ring can hold: fast-forward runs thousands of
        // ticks between paints, and a chunk larger than the ring would wrap
        // points before their pen was recorded.
        const chunk = Math.min(owed, RECENT);
        const before = game.plotted;
        game.step(chunk);
        recordInk(before);
        owed -= chunk;
      }
    },

    drawBackground() {
      // Resize and parameter change both land here. The system itself is set in
      // reset(), never here: a resize must not restart a run.
      paintBackground();
    },

    draw() {
      const fg = ctx.layers.foreground;
      const { width, height, theme } = ctx;

      // New ink onto the background, which is cumulative and never rebuilt
      // while the run continues. Nothing here advances the game; the only state
      // it touches is the record of what is already on the layer.
      if (repaintAll) paintBackground();
      else paintDirty();

      fg.clearRect(0, 0, width, height);

      // The live cursor: the last few jumps and the point they arrived at. The
      // signal pen, because this is the only thing on the plate that is moving —
      // 2 px, never a hairline, and no halo, which would punch the plate colour
      // through the attractor underneath.
      if (game.plotted > 0) {
        fg.strokeStyle = theme.data1;
        fg.lineWidth = 2 * theme.lineWidth;
        fg.lineJoin = 'round';
        fg.beginPath();
        let first = true;
        game.forEachRecent(game.plotted - (TRAIL + 1), (x, y) => {
          const px = view.originX + view.scale * x;
          const py = view.originY - view.scale * y;
          if (first) {
            fg.moveTo(px, py);
            first = false;
          } else {
            fg.lineTo(px, py);
          }
        });
        fg.stroke();

        const cx = view.originX + view.scale * game.x;
        const cy = view.originY - view.scale * game.y;
        fg.fillStyle = theme.data1;
        fg.beginPath();
        fg.moveTo(cx + theme.particleRadius, cy);
        fg.arc(cx, cy, theme.particleRadius, 0, TAU);
        fg.fill();
      }

      // No number on the plate: the headline under it is the reading, in words
      // a reader can use, and a "D ≈" beside the figure was one more thing to
      // ask about.
      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      switch (key) {
        case 'points': {
          // The same asymmetry as every other counted run in this app. One draw
          // per point means the run on screen is a true prefix of a longer one,
          // so raising the ceiling continues the sequence rather than
          // restarting it. Below the points already plotted there is no honest
          // reading of the ledger — it would report a million points under a
          // control, a caption and a permalink that all said ten thousand — so
          // the shell resets instead.
          const next = Math.floor(asNumber(value, target));
          if (next < game.plotted) return false;
          target = next;
          return true;
        }
        default:
          // shape, seed: a different attractor, or a different walk over the
          // same one. The shell resets.
          return false;
      }
    },

    reset() {
      ctx.rng.reseed(num(ctx.params, 'seed', DEFAULT_SEED));
      active = resolveSystem(ctx.params);
      game.setSystem(active.maps, {
        restriction: active.restriction,
        ...(active.bounds ? { bounds: active.bounds } : {}),
      });
      target = pointTarget(ctx.params);
      pen.fill(0);
      dirty.fill(0);
      inked.fill(0);
      dirtyCount = 0;
      pending = 0;
      repaintAll = true;
      ctx.layers.foreground.clearRect(0, 0, ctx.width, ctx.height);
    },

    destroy() {
      // No timers, workers, or listeners: everything lives in closure state.
    },
  };

  /**
   * Repaint the whole background: the apparatus, then every point ever plotted,
   * recovered from the occupancy grid.
   *
   * This is the resize path and the fast-forward path. The grid is 1,024 cells
   * across the figure and the plate is at most about 1,000 CSS px, so a cell is
   * a pixel and this is the picture rather than an approximation of it. Zero
   * words are skipped whole, which on a fractal is most of them.
   */
  function paintBackground(): void {
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    view = layoutView(width, height, game.bounds, MARGIN);
    bg.clearRect(0, 0, width, height);

    if (active.n > 0) {
      const n = active.n;
      // The polygon is the frame the experiment happens inside, so it takes the
      // container pen; the corners are the experiment's own geometry — the
      // thing a jump is aimed at — so they take the apparatus pen. No numerals
      // at the corners: they existed to make "not a neighbour" legible, and the
      // one rule left on the menu is stated without them.
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.beginPath();
      for (let k = 0; k <= n; k++) {
        const v = polygonVertex(n, k % n);
        const x = view.originX + view.scale * v.x;
        const y = view.originY - view.scale * v.y;
        if (k === 0) bg.moveTo(x, y);
        else bg.lineTo(x, y);
      }
      bg.stroke();

      const radius = Math.max(2.5, theme.particleRadius);
      bg.fillStyle = theme.grid;
      bg.beginPath();
      for (let k = 0; k < n; k++) {
        const v = polygonVertex(n, k);
        const x = view.originX + view.scale * v.x;
        const y = view.originY - view.scale * v.y;
        bg.moveTo(x + radius, y);
        bg.arc(x, y, radius, 0, TAU);
      }
      bg.fill();
    } else {
      // The two affine systems — the fern and the dragon — have no polygon to
      // aim at, so this branch used to paint nothing at all and the background
      // was left exactly as `clearRect` found it. Changing the Shape menu while
      // paused therefore blanked the whole plate: a shape change is structural,
      // the shell resets and repaints the background, and `draw()` then cleared
      // the foreground over an empty background with zero points plotted. While
      // the engine runs the next frame hides it; paused — which is the state a
      // reader is in when they are comparing shapes — the plate simply went
      // white. Every system now has something to paint, so `paintBackground()`
      // has no silent empty branch: the frame of the region the attractor lives
      // in, which is furniture and takes the container pen.
      const x0 = view.originX + view.scale * game.bounds.minX;
      const x1 = view.originX + view.scale * game.bounds.maxX;
      const y0 = view.originY - view.scale * game.bounds.maxY;
      const y1 = view.originY - view.scale * game.bounds.minY;
      const snap = theme.lineWidth % 2 === 1 ? 0.5 : 0;
      bg.strokeStyle = theme.gridSoft;
      bg.lineWidth = theme.lineWidth;
      bg.strokeRect(
        Math.round(x0) + snap,
        Math.round(y0) + snap,
        Math.round(x1 - x0) - 2 * snap,
        Math.round(y1 - y0) - 2 * snap,
      );
    }

    // The attractor goes on over the apparatus, exactly where the live points
    // land — otherwise a resize would reorder the picture.
    const cell = cellGeometry();
    // One pass per pen, so the fill style is set twice rather than once per
    // cell.
    const passes = COLOUR_BY_VERTEX ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      bg.fillStyle = p === 1 ? theme.data1 : theme.data2;
      game.grid.forEachCell((cx, cy, index) => {
        // The layer now carries this cell whichever pen owns it, so the first
        // pass is also where the record of what is painted is rebuilt.
        if (p === 0) inked[index >>> 5] = (inked[index >>> 5] ?? 0) | (1 << (index & 31));
        if (COLOUR_BY_VERTEX) {
          const bit = ((pen[index >>> 5] ?? 0) >>> (index & 31)) & 1;
          if (bit !== p) return;
        }
        paintCell(bg, cell, cx, cy);
      });
    }

    dirty.fill(0);
    dirtyCount = 0;
    repaintAll = false;
  }

  /**
   * Where the occupancy grid sits on the plate, in CSS px.
   *
   * A cell smaller than a pixel is drawn as one; a plate finer than the grid
   * grows the mark to the cell so the picture has no gaps in it.
   */
  interface CellGeometry {
    x0: number;
    y0: number;
    s: number;
    d: number;
    off: number;
  }

  function cellGeometry(): CellGeometry {
    const s = (view.scale * game.square.span) / game.grid.size;
    const d = Math.max(1, Math.ceil(s));
    return {
      x0: view.originX + view.scale * game.square.x0,
      y0: view.originY - view.scale * game.square.y0,
      s,
      d,
      off: (d - 1) / 2,
    };
  }

  /**
   * One cell, snapped to whole CSS pixels and painted at full strength: §7 lets
   * a sub-3 px mark through on exactly that condition, and an anti-aliased mark
   * would smear the drafting pen from 9.41:1 to 2.56.
   */
  function paintCell(bg: CanvasRenderingContext2D, g: CellGeometry, cx: number, cy: number): void {
    bg.fillRect(
      Math.floor(g.x0 + (cx + 0.5) * g.s - g.off),
      Math.floor(g.y0 - (cy + 0.5) * g.s - g.off),
      g.d,
      g.d,
    );
  }

  /**
   * Put the cells inked since the last frame onto the background layer.
   *
   * The cost is the number of cells whose colour changed, which on a settled
   * attractor is near zero however many points arrived — the whole point of
   * keeping the picture as an append-only record rather than rebuilding it.
   */
  function paintDirty(): void {
    if (dirtyCount === 0) return;
    const bg = ctx.layers.background;
    const cell = cellGeometry();
    const level = game.grid.level;
    const mask = game.grid.size - 1;
    const passes = COLOUR_BY_VERTEX ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      bg.fillStyle = p === 1 ? ctx.theme.data1 : ctx.theme.data2;
      for (let w = 0; w < dirty.length; w++) {
        let bits = dirty[w] ?? 0;
        if (bits === 0) continue;
        const pens = pen[w] ?? 0;
        const origin = w << 5;
        while (bits !== 0) {
          // Lowest set bit first: Math.clz32 of the isolated bit gives its index.
          const lowest = bits & -bits;
          const b = 31 - Math.clz32(lowest);
          bits ^= lowest;
          if (COLOUR_BY_VERTEX && ((pens >>> b) & 1) !== p) continue;
          const index = origin + b;
          paintCell(bg, cell, index & mask, index >>> level);
        }
      }
    }
    for (let w = 0; w < dirty.length; w++) {
      const bits = dirty[w] ?? 0;
      if (bits === 0) continue;
      inked[w] = (inked[w] ?? 0) | bits;
      dirty[w] = 0;
    }
    dirtyCount = 0;
  }

  function formula(): Prose {
    if (active.n === 0) return ['log 2 / log √2'];
    const count: Prose = active.restriction === 'none' ? [{ v: 'n' }] : [{ v: 'm' }];
    return ['log ', ...count, ' / log(1/', { v: 'r' }, ')'];
  }

  /**
   * The simple view shows two of these: the dimension, as the headline, and
   * the dot count. The closed form and the box count at 1/256 are what the
   * expert table and the tests read, and nothing a newcomer is asked to parse.
   */
  function readouts(): Readout[] {
    const measured = boxCountingDimension(game.grid, game.plotted);
    const dimension: Readout = {
      key: 'dimension',
      label: 'Box dimension',
      value: measured,
      digits: 4,
      plain: 'how crinkly the shape is',
      headline: true,
      hint: 'a filled square scores 2, a line 1',
      // A box dimension of a set in the plane lives in [0, 2] by definition, and
      // the ledger judges a band against the smaller of the prediction and this
      // span — so the filled square's 2 cannot buy a wider bar than the
      // triangle's 1.585.
      range: [0, 2],
    };
    // A target only where the fit had scales to work with. `measured` is NaN
    // when every dyadic level left is one the sample has saturated, and a
    // prediction attached to a reading that does not exist is a claim about
    // nothing.
    if (active.targeted && Number.isFinite(measured)) {
      dimension.target = active.dimension;
      dimension.formula = formula();
      // Absolute, because box counting has no standard error to quote: the
      // estimate is a regression on five deterministic counters, not a mean over
      // trials, and what it carries instead is the bounded discretisation bias
      // documented at DIM_TOLERANCE. It does not shrink with the run, and the
      // `points` floor is what makes that honest — below it the fit has no
      // scales left and emits no reading at all.
      dimension.band = { kind: 'absolute', half: DIM_TOLERANCE };
    }
    const out: Readout[] = [
      { key: 'points', label: 'Points plotted', value: game.plotted, digits: 7, plain: 'dots placed' },
      dimension,
    ];
    if (Number.isFinite(active.dimension)) {
      out.push({
        key: 'analytic',
        label: 'Analytic dimension',
        value: active.dimension,
        digits: 7,
        formula: formula(),
        expertOnly: true,
      });
    }
    out.push({
      key: 'cells',
      label: 'Boxes at 1/256',
      value: game.grid.count(BOX_MAX_LEVEL),
      digits: 7,
      expertOnly: true,
    });
    return out;
  }

  instance.reset();
  return instance;
}

export const chaosGame: Viz = {
  id: 'chaos-game',
  title: 'Chaos Game',
  group: 'chaos',
  blurb: 'Jump toward a random corner, drop a dot, repeat: the same shape appears every time.',
  // Square, because the attractors are: a triangle inscribed in the unit circle
  // and a filled square both want equal axes, and one scale has to serve both
  // directions or the figure is no longer self-similar. Square on a phone too —
  // there is no orientation a fractal reads better in.
  aspect: 1,
  aspectNarrow: 1,
  params,
  presets,
  facts,
  budget: { maxEntities: MAX_POINTS },
  create,
};
