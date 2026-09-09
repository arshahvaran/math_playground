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
  NAMED_SYSTEMS,
  RESTRICTIONS,
  boxCountingDimension,
  branching,
  createChaosGame,
  findSystem,
  polygonOpenSetRatio,
  polygonSystem,
  polygonVertex,
  restrictedDimension,
  type AffineMap,
  type Bounds,
  type Restriction,
} from './ifs';

/**
 * Hard ceiling on points, and the `points` slider's top. Nothing is stored per
 * point — see `Occupancy` — so this is a budget on time, not on memory: two
 * million points is about a second of plotting.
 */
const MAX_POINTS = 2_000_000;

const MIN_VERTICES = 3;
const MAX_VERTICES = 8;

/** The `system` value that means "use the vertices and ratio sliders". */
const CUSTOM = 'polygon';

const DEFAULT_SYSTEM = 'sierpinski';
const DEFAULT_VERTICES = 3;
const DEFAULT_RATIO = 0.5;
const DEFAULT_POINTS = 200_000;
const DEFAULT_RATE = 2_000;
const DEFAULT_SEED = 42;

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

/** Plate margin, CSS px: the wider one leaves room for the vertex numerals outside the polygon. */
const MARGIN_POLYGON = 18;
const MARGIN_PLAIN = 8;

/** Gap between a vertex and its numeral, CSS px. */
const LABEL_GAP = 11;

/**
 * Absolute error inside which the box count counts as agreeing with the closed
 * form, and the tolerance the ledger's needle is scaled by.
 *
 * Box counting has no standard error to quote — the estimate is a regression on
 * five deterministic counters, not a mean over trials. What it has instead is a
 * discretisation bias: N(ε) = C·ε^−D only up to a bounded oscillation, because
 * the grid is not aligned with the attractor's own subdivision, and the
 * five-point least squares damps that oscillation to a few hundredths. Measured
 * across the systems this tab offers, at 10⁶ points and levels 4…8: +0.0117 for
 * the Sierpiński triangle, −0.0083 for the pentagon, −0.0136 for the filled
 * square, +0.0052 for the restricted square. 0.05 is roughly four times the
 * largest of those and is what the same regression is worth at 10⁵ points too.
 */
const DIM_TOLERANCE = 0.05;

const TAU = 2 * Math.PI;

const RESTRICTION_LABELS: Readonly<Record<Restriction, string>> = {
  none: 'None',
  'no-repeat': 'No repeat',
  'not-neighbour': 'Not a neighbour',
  'not-opposite': 'Not the opposite',
};

const params: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'system',
    label: 'System',
    options: [
      ...NAMED_SYSTEMS.map((s) => ({ value: s.id, label: s.label })),
      { value: CUSTOM, label: 'Custom n-gon' },
    ],
    default: DEFAULT_SYSTEM,
    help: 'The named systems carry their own vertex count and ratio; the custom n-gon takes the two sliders below.',
  },
  {
    kind: 'int',
    key: 'n',
    label: 'Vertices',
    min: MIN_VERTICES,
    max: MAX_VERTICES,
    default: DEFAULT_VERTICES,
    help: 'Vertices of the polygon, numbered anticlockwise on the plate. Active for the custom n-gon.',
  },
  {
    kind: 'range',
    key: 'r',
    label: 'Ratio',
    min: 0.1,
    max: 0.9,
    step: 0.001,
    default: DEFAULT_RATIO,
    help: [
      'Similarity ratio. Each jump multiplies the distance to the chosen vertex by ',
      { v: 'r' },
      ', so the point moves 1 − ',
      { v: 'r' },
      ' of the way toward it and ',
      { v: 'r' },
      ' = ½ is the classic halfway jump. Above the open-set ratio the copies overlap and the dimension formula stops holding, so the tab stops claiming it.',
    ],
  },
  {
    kind: 'choice',
    key: 'restriction',
    label: 'Restriction',
    options: RESTRICTIONS.map((id) => ({ value: id, label: RESTRICTION_LABELS[id] })),
    default: 'none',
    help: [
      'Which vertex the next jump may not choose, counted around the polygon from the last one. Forbidding a choice cuts the branching from ',
      { v: 'n' },
      ' to ',
      { v: 'm' },
      ' and the dimension with it. Polygon systems only.',
    ],
  },
  {
    kind: 'range',
    key: 'points',
    label: 'Points',
    min: 1_000,
    max: MAX_POINTS,
    step: 1_000,
    default: DEFAULT_POINTS,
    log: true,
    help: 'Points plotted before the run stops.',
  },
  {
    kind: 'range',
    key: 'pointsPerFrame',
    label: 'Points per frame',
    min: 100,
    max: 20_000,
    step: 100,
    default: DEFAULT_RATE,
    log: true,
    help: 'Plotting rate, in points per frame of simulation time. Changes take effect without restarting.',
  },
  {
    kind: 'toggle',
    key: 'colourByVertex',
    label: 'Colour by vertex',
    default: false,
    help: 'Ink alternate maps in the two pens, so the copies the attractor is made of separate.',
  },
  {
    kind: 'seed',
    key: 'seed',
    label: 'Seed',
    default: DEFAULT_SEED,
    help: 'Same seed, same order of jumps. The picture is the same either way — that is the point.',
  },
];

const presets: readonly Preset[] = [
  {
    id: 'one-thousand',
    label: 'One thousand',
    caption:
      'A thousand points read as scattered dust, and every one of them is already exactly on the triangle. Nothing converges here except the eye.',
    values: {
      system: 'sierpinski',
      restriction: 'none',
      points: 1_000,
      pointsPerFrame: 100,
      colourByVertex: false,
    },
  },
  {
    id: 'sierpinski',
    label: 'Sierpiński',
    caption: [
      'Two hundred thousand jumps toward three vertices, halfway each time: the triangle, at a measured dimension of log 3 / log 2 = ',
      { v: 'D' },
      ' = 1.585.',
    ],
    values: {
      system: 'sierpinski',
      restriction: 'none',
      points: 200_000,
      pointsPerFrame: 2_000,
      colourByVertex: false,
    },
  },
  {
    id: 'square-fills',
    label: 'The square fills',
    caption: [
      'Four vertices and the same halfway jump, and the square fills solid. The four half-squares tile it with nothing left over, so log 4 / log 2 = 2 and there is no fractal here at all.',
    ],
    values: {
      system: 'square',
      n: 4,
      r: 0.5,
      restriction: 'none',
      points: 1_000_000,
      pointsPerFrame: 8_000,
      colourByVertex: false,
    },
  },
  {
    id: 'restrict-it',
    label: 'Restrict it',
    caption: [
      'The same square, the same halfway jumps — but never the vertex just used. Three choices instead of four, and the dimension falls from 2 to log 3 / log 2. The restriction makes the structure, not the randomness.',
    ],
    values: {
      system: 'square',
      n: 4,
      r: 0.5,
      restriction: 'no-repeat',
      points: 1_000_000,
      pointsPerFrame: 8_000,
      colourByVertex: false,
    },
  },
  {
    id: 'fern',
    label: 'Barnsley fern',
    caption:
      'Four affine maps, chosen 1 : 85 : 7 : 7. The map picked one time in a hundred is degenerate — it flattens the plane onto a segment — and it is the one that draws the stem.',
    values: { system: 'fern', points: 1_000_000, pointsPerFrame: 8_000, colourByVertex: false },
  },
  {
    id: 'dragon',
    label: 'Dragon curve',
    caption: [
      'Two maps, each a 45° turn and a shrink by √2, so log 2 / log √2 = 2 exactly: the dragon tiles the plane. The box count still reads about 1.8 over these five octaves, because what is fractal about a dragon is its boundary.',
    ],
    values: { system: 'dragon', points: 500_000, pointsPerFrame: 8_000, colourByVertex: false },
  },
];

const facts: readonly Fact[] = [
  {
    text: [
      'Michael Barnsley named the chaos game in Fractals Everywhere (1988) and put the fern in it: four affine maps ',
      'chosen with probabilities 0.01, 0.85, 0.07 and 0.07. The 1% map is degenerate — it collapses the whole plane ',
      'onto a vertical segment — and it is the one that draws the stem.',
    ],
    source: {
      label: 'Barnsley, Fractals Everywhere (Academic Press, 1988), §3.8 and Table 3.8.3',
      url: 'https://en.wikipedia.org/wiki/Barnsley_fern',
    },
  },
  {
    text: [
      'The picture does not depend on where the game starts. Hutchinson proved in 1981 that a finite set of ',
      'contractions has exactly one non-empty compact invariant set, and that iterating from any starting set ',
      'converges to it — so the first few points are simply off the attractor, and this tab throws twenty of them away.',
    ],
    source: {
      label: 'Hutchinson, “Fractals and self-similarity”, Indiana Univ. Math. J. 30 (1981), 713–747',
      url: 'https://doi.org/10.1512/iumj.1981.30.30055',
    },
  },
  {
    text: [
      'Under the open set condition — the copies overlapping only on their edges — an attractor made of ',
      { v: 'n' },
      ' copies of itself at ratio ',
      { v: 'r' },
      ' has dimension exactly log ',
      { v: 'n' },
      ' / log(1/',
      { v: 'r' },
      '). The condition is what fails when the ratio is raised: at ',
      { v: 'r' },
      ' = 0.6 the three copies of a triangle overlap, the formula returns 2.15, and a set in the plane cannot exceed 2.',
    ],
    source: {
      label: 'Moran (1946); Hutchinson (1981), §5.3 — the open set condition',
      url: 'https://en.wikipedia.org/wiki/Open_set_condition',
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
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** Pixel size out of a CSS font shorthand, for sizing the readout's backing plate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 12;
}

/** Points this run will plot, clamped the way the plotter clamps its own target. */
function pointTarget(values: ParamValues): number {
  return Math.max(1, Math.min(MAX_POINTS, Math.floor(num(values, 'points', DEFAULT_POINTS))));
}

/**
 * The system the current parameters select, with everything the readouts need.
 *
 * A named polygon system carries its own vertex count and ratio, so choosing
 * "Sierpiński pentagon" cannot be combined with a ratio slider left at ½ into a
 * picture whose published dimension is wrong. The two sliders drive the custom
 * n-gon, which is where the reader is meant to break the rules.
 */
export interface ActiveSystem {
  maps: readonly AffineMap[];
  /** Polygon vertices; 0 when the system is not a polygon system. */
  n: number;
  r: number;
  /** The rule as requested. A non-polygon system ignores it. */
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
  const id = text(values, 'system', DEFAULT_SYSTEM);
  const requested = text(values, 'restriction', 'none') as Restriction;
  const rule: Restriction = RESTRICTIONS.includes(requested) ? requested : 'none';
  const named = id === CUSTOM ? undefined : findSystem(id);

  if (named && !named.polygon) {
    // The fern and the dragon: no vertices, no restriction, and a closed form
    // only where the maps are similarities. The dragon has one — log 2 / log √2
    // = 2 — but its box count does not reach it at these scales, because its
    // boundary is a dimension-1.5236 curve and the boundary term still carries a
    // third of the count at 1/256. Publishing 2 as a target would mean a ledger
    // that never converges, so the dimension is reported and not claimed.
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

  const n = named?.polygon
    ? named.polygon.n
    : Math.min(MAX_VERTICES, Math.max(MIN_VERTICES, Math.round(num(values, 'n', DEFAULT_VERTICES))));
  const r = named?.polygon
    ? named.polygon.r
    : Math.min(0.99, Math.max(0.01, num(values, 'r', DEFAULT_RATIO)));
  const m = branching(n, rule);
  // Below the open-set ratio the pieces meet only on their edges, the formula is
  // exact, and the estimate has something to converge to. Above it they overlap:
  // log m / log(1/r) overcounts, the true dimension is capped at 2, and the tab
  // measures without claiming.
  const open = r <= polygonOpenSetRatio(n) + 1e-9;
  return {
    maps: named?.polygon ? named.maps : polygonSystem(n, r),
    n,
    r,
    restriction: rule,
    branching: m,
    dimension: open ? restrictedDimension(n, r, rule) : NaN,
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

  /** Only a polygon system needs room outside the figure, for its vertex numerals. */
  const margin = (): number => (active.n > 0 ? MARGIN_POLYGON : MARGIN_PLAIN);

  let view = layoutView(ctx.width, ctx.height, game.bounds, margin());

  /**
   * Which of the two pens last inked each finest-level cell, one bit per cell:
   * 128 KB that lets a resize, a fast-forward or a flick of the colour toggle
   * repaint a million points in the colours they were plotted in. The occupancy
   * grid says *that* a cell is inked; this says which pen did it.
   */
  const pen = new Uint32Array(Math.max(1, (game.grid.size * game.grid.size) >>> 5));

  // Live parameters, absorbed without disturbing the points already down.
  let target = pointTarget(ctx.params);
  let rate = DEFAULT_RATE;
  let colourByVertex = false;

  // Fractional points owed by the rate accumulator between ticks.
  let pending = 0;

  // Render bookkeeping. The background layer is this tab's accumulating datum —
  // a chaos game never moves a point it has plotted — so `draw()` owns it, and
  // this is how much of it is already painted. None of it is simulation state:
  // `draw()` advances nothing, and painting the same point twice paints the
  // same pixel.
  let painted = 0;
  let repaintAll = true;

  function syncLive(): void {
    target = pointTarget(ctx.params);
    rate = num(ctx.params, 'pointsPerFrame', DEFAULT_RATE);
    colourByVertex = flag(ctx.params, 'colourByVertex', false);
  }

  /** Finest-level cell of an attractor point, or −1 when it falls outside the grid square. */
  function cellOf(x: number, y: number): number {
    const size = game.grid.size;
    const s = size / game.square.span;
    const cx = ((x - game.square.x0) * s) | 0;
    const cy = ((y - game.square.y0) * s) | 0;
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return -1;
    return (cy << game.grid.level) + cx;
  }

  /** Record which pen owns each of the points plotted since `from`. Last writer wins. */
  function recordPens(from: number): void {
    game.forEachRecent(from, (x, y, vertex) => {
      const index = cellOf(x, y);
      if (index < 0) return;
      const w = index >>> 5;
      const bit = 1 << (index & 31);
      if ((vertex & 1) === 1) pen[w] = (pen[w] ?? 0) | bit;
      else pen[w] = (pen[w] ?? 0) & ~bit;
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
      pending += (rate * 60 * dt) / 1000;
      let owed = Math.min(Math.floor(pending), target - game.plotted);
      pending -= owed;
      while (owed > 0) {
        // In chunks the cursor ring can hold: fast-forward runs thousands of
        // ticks between paints, and a chunk larger than the ring would wrap
        // points before their pen was recorded.
        const chunk = Math.min(owed, RECENT);
        const before = game.plotted;
        game.step(chunk);
        recordPens(before);
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

      // New points onto the background, which is cumulative. `painted` is a
      // render cursor, not simulation state: nothing here advances the game.
      // Two conditions need the whole picture back rather than an increment:
      // the colour toggle, and a fast-forward that plotted more points between
      // two frames than the cursor ring holds.
      if (repaintAll || painted < game.oldestRecent) {
        paintBackground();
      } else if (painted < game.plotted) {
        paintRange(ctx.layers.background, painted);
        painted = game.plotted;
      }

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

      drawWindow(fg);
      ctx.emit(readouts());
    },

    onParamChange(key, value) {
      switch (key) {
        case 'pointsPerFrame':
          rate = asNumber(value, rate);
          return true;
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
        case 'colourByVertex':
          colourByVertex = value === true;
          // Every cell remembers which pen inked it, so the whole picture
          // recolours without replotting a point.
          repaintAll = true;
          return true;
        default:
          // system, n, r, restriction, seed: a different attractor, or a
          // different walk over the same one. The shell resets.
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
      syncLive();
      pen.fill(0);
      pending = 0;
      painted = 0;
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
   * This is the resize path, the fast-forward path and the colour toggle's
   * path. The grid is 1,024 cells across the figure and the plate is at most
   * about 1,000 CSS px, so a cell is a pixel and this is the picture rather
   * than an approximation of it. Zero words are skipped whole, which on a
   * fractal is most of them.
   */
  function paintBackground(): void {
    const bg = ctx.layers.background;
    const { width, height, theme } = ctx;
    view = layoutView(width, height, game.bounds, margin());
    bg.clearRect(0, 0, width, height);

    if (active.n > 0) {
      const n = active.n;
      // The polygon is the frame the experiment happens inside, so it takes the
      // container pen; the vertices are the experiment's own geometry — the
      // thing a jump is aimed at — so they take the apparatus pen.
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

      // Numerals outside the polygon, which is what makes a restriction rule
      // legible: "not a neighbour" is a statement about these numbers.
      bg.font = theme.labelFont;
      bg.fillStyle = theme.inkMuted;
      bg.textAlign = 'center';
      bg.textBaseline = 'middle';
      for (let k = 0; k < n; k++) {
        const v = polygonVertex(n, k);
        const out = radius + LABEL_GAP;
        bg.fillText(
          String(k),
          view.originX + view.scale * v.x + out * v.x,
          view.originY - view.scale * v.y - out * v.y,
        );
      }
    }

    // The attractor goes on over the apparatus, exactly where the live points
    // land — otherwise a resize would reorder the picture.
    const size = game.grid.size;
    const s = (view.scale * game.square.span) / size;
    const x0 = view.originX + view.scale * game.square.x0;
    const y0 = view.originY - view.scale * game.square.y0;
    // A cell smaller than a pixel is drawn as one; a plate finer than the grid
    // grows the mark to the cell so the picture has no gaps in it.
    const d = Math.max(1, Math.ceil(s));
    const off = (d - 1) / 2;
    // One pass per pen, so the fill style is set twice rather than once per
    // cell. With the toggle off there is one pen and one pass.
    const passes = colourByVertex ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      bg.fillStyle = p === 1 ? theme.data1 : theme.data2;
      game.grid.forEachCell((cx, cy, index) => {
        if (colourByVertex) {
          const bit = ((pen[index >>> 5] ?? 0) >>> (index & 31)) & 1;
          if (bit !== p) return;
        }
        bg.fillRect(
          Math.floor(x0 + (cx + 0.5) * s - off),
          Math.floor(y0 - (cy + 0.5) * s - off),
          d,
          d,
        );
      });
    }

    painted = game.plotted;
    repaintAll = false;
  }

  /** Paint the points plotted since chronological index `from`, batched by pen. */
  function paintRange(bg: CanvasRenderingContext2D, from: number): void {
    const passes = colourByVertex ? 2 : 1;
    for (let p = 0; p < passes; p++) {
      bg.fillStyle = p === 1 ? ctx.theme.data1 : ctx.theme.data2;
      game.forEachRecent(from, (x, y, vertex) => {
        if (colourByVertex && (vertex & 1) !== p) return;
        // Snapped to whole CSS pixels and painted at full strength: §7 lets a
        // sub-3 px mark through on exactly that condition, and an
        // anti-aliased point would smear the drafting pen from 9.41:1 to 2.56.
        bg.fillRect(
          Math.floor(view.originX + view.scale * x),
          Math.floor(view.originY - view.scale * y),
          1,
          1,
        );
      });
    }
  }

  /**
   * The live dimension, top right, as a display window: an opaque plate of the
   * canvas colour with a container-pen frame. Opaque because a million points
   * read straight through a translucent one. Published through emit() as well;
   * the canvas itself is aria-hidden.
   */
  function drawWindow(fg: CanvasRenderingContext2D): void {
    const { theme, width } = ctx;
    const d = boxCountingDimension(game.grid);
    const label = `D ≈ ${Number.isFinite(d) ? d.toFixed(3) : '—'}`;
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
    fg.strokeRect(plateX + snap, plateY + snap, plateW - 2 * snap, plateH - 2 * snap);
    fg.fillStyle = theme.ink;
    fg.fillText(label, width - margin, margin);
  }

  function formula(): Prose {
    if (active.n === 0) return ['log 2 / log √2'];
    const count: Prose = active.restriction === 'none' ? [{ v: 'n' }] : [{ v: 'm' }];
    return ['log ', ...count, ' / log(1/', { v: 'r' }, ')'];
  }

  function readouts(): Readout[] {
    const measured = boxCountingDimension(game.grid);
    const dimension: Readout = {
      key: 'dimension',
      label: 'Box dimension',
      value: measured,
      digits: 4,
    };
    if (active.targeted) {
      dimension.target = active.dimension;
      dimension.formula = formula();
      // Not the ledger's 1% default: 1% of 1.585 is 0.016, which no box count
      // over five dyadic scales reaches, and a finished and perfectly correct
      // run would read "not yet converged" forever.
      dimension.tolerance = DIM_TOLERANCE / Math.abs(active.dimension);
    }
    const out: Readout[] = [
      { key: 'points', label: 'Points plotted', value: game.plotted, digits: 7 },
      dimension,
    ];
    if (Number.isFinite(active.dimension)) {
      out.push({
        key: 'analytic',
        label: 'Analytic dimension',
        value: active.dimension,
        digits: 7,
        formula: formula(),
      });
    }
    out.push({
      key: 'cells',
      label: 'Boxes at 1/256',
      value: game.grid.count(BOX_MAX_LEVEL),
      digits: 7,
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
  blurb: [
    'Jumps toward a vertex picked at random, a million times over, until an attractor of dimension log ',
    { v: 'n' },
    ' / log(1/',
    { v: 'r' },
    ') is drawn exactly.',
  ],
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
