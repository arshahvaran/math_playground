import type { Rng } from '../../core/types';

/**
 * Galton board: the simulation and the board geometry. Pure, canvas-free, and
 * exercised end to end by tests/galton.test.ts.
 *
 * Choreographed, not simulated. A ball's route is fixed the instant it is
 * released — `rows` independent Bernoulli(p) draws, one per peg row, packed
 * into a bitmask — and the animation merely follows that route from peg to
 * peg. The landing bin is the number of rights, so the bin counts are exactly
 * Binomial(rows, p) by construction. A collision model would look the same and
 * quietly bias the distribution (a ball that grazes a peg tends to keep its
 * direction), which would make the convergence test meaningless.
 *
 * The RNG is consulted only at release, `rows` draws per ball, so the bins for
 * a seed are identical at every drop rate and every step size. Only the clock
 * differs. tests/galton.test.ts asserts exactly that.
 */

/** Paths are 32-bit masks, one bit per row; the `rows` ParamSpec caps at this too. */
export const MAX_ROWS = 20;

/** Balls of state allocated when the caller passes no budget. */
export const DEFAULT_BUDGET = 50_000;

/**
 * Milliseconds a ball spends crossing the first row. Row r takes
 * ROW_MS / sqrt(r + 1): under gravity the speed after falling a height h is
 * sqrt(2gh), so the time to cross the r-th row of a lattice with constant
 * pitch scales as 1 / sqrt(r + 1). The entry drop above the apex and the
 * settle into the bin use the neighbouring row's rate.
 */
const ROW_MS = 180;

export interface GaltonParams {
  /** Peg rows, 1..MAX_ROWS. There are rows + 1 bins. */
  rows: number;
  /** Probability of deflecting right at a peg. */
  p: number;
  /** Balls released before the stream stops. Clamped to the budget. */
  balls: number;
  /** Release rate, balls per second of simulation time. */
  dropRate: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Pegs sit on an equilateral lattice: row pitch = peg pitch · √3/2. A ball
 * leaving one peg then meets the next at the same angle in every row, which is
 * what makes the offset lattice read as a lattice rather than a grid.
 */
const ASPECT = Math.sqrt(3) / 2;

/** Fraction of the height where the bins begin; pegs get the space above. */
const BIN_TOP = 0.7;

/** Fraction of the width the widest structure — the row of bins — may span. */
const USABLE_WIDTH = 0.92;

/** Vertical room reserved under the bins for the index labels, CSS px. */
const LABEL_BAND = 22;

/**
 * Board layout in CSS px. Every coordinate the renderer needs derives from
 * three numbers: the apex peg's position and the peg pitch.
 *
 * Simulation coordinates are lattice units: lateral `x` in peg pitches from
 * the centre line, vertical `y` in rows, with `y = r` at peg row r. Use
 * `lateralToPx` and `progressToPy` to convert.
 */
export interface BoardGeometry {
  rows: number;
  width: number;
  height: number;
  /** Horizontal distance between neighbouring pegs in a row; also the bin width. */
  pegSpacing: number;
  /** Vertical distance between rows. */
  rowSpacing: number;
  /** Apex peg (row 0), on the centre line. */
  originX: number;
  originY: number;
  /** Where balls appear, one row pitch above the apex (`y = −1`). */
  releaseY: number;
  /** Mouth of the bins (`y = rows`); dividers run from here to `binBottom`. */
  binTop: number;
  binBottom: number;
  pegRadius: number;
}

function clampRows(rows: number): number {
  return Math.min(MAX_ROWS, Math.max(1, Math.round(rows)));
}

/**
 * Fit `rows` peg rows into the upper ~70% of the canvas and rows + 1 bins into
 * the rest, centred. The pitch is the larger lattice that fits both the width
 * (rows + 1 bins across) and the height (rows + 1 pitches from release point
 * to bin mouth), so three rows fill the board and twenty still fit.
 */
export function layoutBoard(width: number, height: number, rows: number): BoardGeometry {
  const n = clampRows(rows);
  const top = Math.max(12, 0.04 * height);
  const binTop = BIN_TOP * height;
  const binBottom = Math.max(binTop + 1, height - LABEL_BAND);

  const fromWidth = (USABLE_WIDTH * width) / (n + 1);
  const fromHeight = (binTop - top) / ((n + 1) * ASPECT);
  const pegSpacing = Math.max(1, Math.min(fromWidth, fromHeight));
  const rowSpacing = pegSpacing * ASPECT;

  // Hang the lattice from the bin mouth so the last row is always one pitch
  // above the bins; a short lattice leaves its spare room at the top.
  const originY = binTop - n * rowSpacing;

  return {
    rows: n,
    width,
    height,
    pegSpacing,
    rowSpacing,
    originX: width / 2,
    originY,
    releaseY: originY - rowSpacing,
    binTop,
    binBottom,
    pegRadius: Math.min(5, Math.max(1.5, pegSpacing * 0.14)),
  };
}

/** Centre of peg `index` (0..row) in `row` (0..rows−1). Row r holds r + 1 pegs, centred. */
export function pegPosition(g: BoardGeometry, row: number, index: number): { x: number; y: number } {
  return { x: g.originX + (index - row / 2) * g.pegSpacing, y: g.originY + row * g.rowSpacing };
}

/** Centre line of bin `k` (0..rows). A ball with k rights lands here. */
export function binCentreX(g: BoardGeometry, k: number): number {
  return g.originX + (k - g.rows / 2) * g.pegSpacing;
}

/** Lattice lateral offset → CSS px. */
export function lateralToPx(g: BoardGeometry, x: number): number {
  return g.originX + x * g.pegSpacing;
}

/** Row progress → CSS px. `y = −1` is the release point, `y = rows` the bin mouth. */
export function progressToPy(g: BoardGeometry, y: number): number {
  return g.originY + y * g.rowSpacing;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Set bits of a 32-bit integer. SWAR, no loop; ~12 ops. */
export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * Lateral profile between two pegs. Cubic ease-out: the ball leaves the peg
 * with most of its sideways motion and arrives at the next one moving almost
 * straight down, which reads as a kick rather than a slide.
 */
function easeOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Per-ball flags. */
const DONE = 1; // past the last row: counted in `bins`, resting place assigned
const SETTLED = 2; // resting animation finished; the ball no longer moves

/**
 * One ball, as seen by the renderer. `forEachBall` / `forEachActive` reuse a
 * single view across calls: copy the fields out rather than keeping the object.
 */
export interface BallView {
  /** Lateral offset from the centre line in peg pitches. Bin k sits at k − rows/2. */
  x: number;
  /** Progress in rows: −1 at release, r at peg row r, rows at the bin mouth, rows + 1 at rest. */
  y: number;
  /** Bit r set ⇔ the ball went right at peg row r. */
  path: number;
  /** Past the last row: counted in `bins` and assigned a resting place. */
  done: boolean;
  /** At rest in the pile. Implies `done`. */
  settled: boolean;
  /** Landing bin, popcount(path). Meaningful once `done`. */
  bin: number;
  /** Order of arrival within the bin, 0 first. Meaningful once `done`. */
  stack: number;
  /** Milliseconds since release. */
  age: number;
}

export interface GaltonSim {
  /** Advance by `dt` ms. Any dt works; the statistics do not depend on it. */
  step(dt: number): void;
  readonly rows: number;
  /** Balls that have passed the last row. */
  readonly landed: number;
  /** Balls released but not yet landed. */
  readonly inFlight: number;
  /** Balls released so far, including those at rest — the number the renderer can ask for. */
  readonly ballCount: number;
  /** Landing counts, one per bin, length rows + 1. A view: read, do not keep across setParams. */
  readonly bins: Uint32Array;
  /** Balls per bin that have finished settling, so the renderer can draw a pile that never double-draws a ball still in the air. */
  readonly settledBins: Uint32Array;
  /** Simulation clock, ms. */
  readonly time: number;
  /** A fresh copy of ball `i`'s state, 0 ≤ i < ballCount. */
  ball(i: number): BallView;
  /** Every released ball, in release order. */
  forEachBall(cb: (ball: BallView, index: number) => void): void;
  /** Only balls still moving: in flight or settling. */
  forEachActive(cb: (ball: BallView, index: number) => void): void;
  /** Clear the board. Does not reseed the RNG; the caller owns it. */
  reset(): void;
  /**
   * Apply new parameters. A change of `rows` resets the board, since paths
   * for a different row count are a different experiment; `p` applies to
   * balls released from now on; `balls` and `dropRate` take effect immediately.
   */
  setParams(p: GaltonParams): void;
  /** Mean and population variance of the landed bin indices. NaN until a ball lands. */
  stats(): { mean: number; variance: number; n: number };
}

export function createSim(rng: Rng, params: GaltonParams, budget = DEFAULT_BUDGET): GaltonSim {
  const capacity = Math.max(1, Math.floor(budget));

  // Per-ball state, allocated once at the ceiling. Nothing grows per frame.
  const posY = new Float32Array(capacity);
  const paths = new Uint32Array(capacity);
  const spawnTime = new Float32Array(capacity);
  const flags = new Uint8Array(capacity);
  const binIdx = new Uint8Array(capacity);
  const stackIdx = new Uint32Array(capacity);

  // Per-bin state at the row ceiling; `bins` / `settledBins` are views of the live prefix.
  const binsAll = new Uint32Array(MAX_ROWS + 1);
  const settledAll = new Uint32Array(MAX_ROWS + 1);

  // Rows per millisecond for each phase: index r for the crossing of row r,
  // index rows for the settle. The entry drop shares index 0.
  const rate = new Float32Array(MAX_ROWS + 1);

  let rows = 0;
  let p = 0.5;
  let target = 0;
  let dropRate = 0;
  let bins = binsAll.subarray(0, 1);
  let settledBins = settledAll.subarray(0, 1);

  let time = 0;
  let spawned = 0;
  let landed = 0;
  // Balls fall with a rate that depends only on their progress, so they finish
  // in release order and the resting ones form a prefix; `firstActive` skips it.
  let firstActive = 0;
  // Balls owed by the drop-rate accumulator. Starts at one so the first ball
  // leaves on the first tick instead of waiting a full period.
  let owed = 1;

  const view: BallView = { x: 0, y: 0, path: 0, done: false, settled: false, bin: 0, stack: 0, age: 0 };

  /** Lateral offset for a route at progress `y`. */
  function lateral(path: number, y: number): number {
    if (y < 0) return 0;
    if (y >= rows) return popcount32(path) - rows / 2;
    const r = y | 0;
    const t = y - r;
    // Rights taken before this row place the ball on peg (r, k); this row's
    // bit decides which of the two pegs below it heads for.
    const k = popcount32(path & ((1 << r) - 1));
    const dir = (path >>> r) & 1 ? 0.5 : -0.5;
    return k - r / 2 + dir * easeOut(t);
  }

  function fillView(i: number): BallView {
    const y = posY[i] ?? 0;
    const path = paths[i] ?? 0;
    const f = flags[i] ?? 0;
    view.x = lateral(path, y);
    view.y = y;
    view.path = path;
    view.done = (f & DONE) !== 0;
    view.settled = (f & SETTLED) !== 0;
    view.bin = binIdx[i] ?? 0;
    view.stack = stackIdx[i] ?? 0;
    view.age = time - (spawnTime[i] ?? 0);
    return view;
  }

  function land(i: number): void {
    const k = popcount32(paths[i] ?? 0);
    binIdx[i] = k;
    stackIdx[i] = bins[k] ?? 0;
    bins[k] = (bins[k] ?? 0) + 1;
    landed++;
  }

  /** Move ball `i` forward by `dt` ms, landing and settling it as it goes. */
  function advance(i: number, dt: number): void {
    let y = posY[i] ?? 0;
    const phase = y < 0 ? 0 : y < rows ? y | 0 : rows;
    y += dt * (rate[phase] ?? 0);
    if (y >= rows) {
      let f = flags[i] ?? 0;
      if (!(f & DONE)) {
        f |= DONE;
        land(i);
      }
      if (y >= rows + 1) {
        y = rows + 1;
        f |= SETTLED;
        const k = binIdx[i] ?? 0;
        settledBins[k] = (settledBins[k] ?? 0) + 1;
      }
      flags[i] = f;
    }
    posY[i] = y;
  }

  /** Release one ball that has already been falling for `age` ms. */
  function spawn(age: number): void {
    const i = spawned++;
    let path = 0;
    for (let r = 0; r < rows; r++) if (rng.bool(p)) path |= 1 << r;
    paths[i] = path >>> 0;
    posY[i] = -1;
    spawnTime[i] = time - age;
    flags[i] = 0;
    if (age > 0) advance(i, age);
  }

  function reset(): void {
    time = 0;
    spawned = 0;
    landed = 0;
    firstActive = 0;
    owed = 1;
    binsAll.fill(0);
    settledAll.fill(0);
  }

  function setParams(next: GaltonParams): void {
    const nextRows = clampRows(next.rows);
    const rowsChanged = nextRows !== rows;
    rows = nextRows;
    p = Math.min(1, Math.max(0, next.p));
    target = Math.min(capacity, Math.max(0, Math.floor(next.balls)));
    dropRate = Math.max(0, next.dropRate);
    bins = binsAll.subarray(0, rows + 1);
    settledBins = settledAll.subarray(0, rows + 1);
    for (let r = 0; r <= rows; r++) rate[r] = Math.sqrt(r + 1) / ROW_MS;
    if (rowsChanged) reset();
  }

  setParams(params);

  return {
    step(dt) {
      time += dt;

      // Balls already on the board move first; the ones released this tick
      // are placed by their own age below, so they must not be moved twice.
      while (firstActive < spawned && ((flags[firstActive] ?? 0) & SETTLED) !== 0) firstActive++;
      const already = spawned;
      for (let i = firstActive; i < already; i++) {
        if (((flags[i] ?? 0) & SETTLED) === 0) advance(i, dt);
      }

      if (spawned < target && dropRate > 0) {
        owed += (dropRate * dt) / 1000;
        const period = 1000 / dropRate;
        while (owed >= 1 && spawned < target) {
          owed -= 1;
          // What is still owed after this ball is how far past its release
          // instant the tick ended; staggering by that keeps a dense stream
          // evenly spaced instead of clumped at tick boundaries.
          spawn(owed * period);
        }
      }
    },

    get rows() {
      return rows;
    },
    get landed() {
      return landed;
    },
    get inFlight() {
      return spawned - landed;
    },
    get ballCount() {
      return spawned;
    },
    get bins() {
      return bins;
    },
    get settledBins() {
      return settledBins;
    },
    get time() {
      return time;
    },

    ball(i) {
      if (!Number.isInteger(i) || i < 0 || i >= spawned) {
        throw new RangeError(`ball(${i}): only ${spawned} balls released`);
      }
      return { ...fillView(i) };
    },

    forEachBall(cb) {
      for (let i = 0; i < spawned; i++) cb(fillView(i), i);
    },

    forEachActive(cb) {
      for (let i = firstActive; i < spawned; i++) {
        if (((flags[i] ?? 0) & SETTLED) === 0) cb(fillView(i), i);
      }
    },

    reset,
    setParams,

    stats() {
      // Bin indices are small integers, so E[x²] − E[x]² loses nothing here
      // and the bins make it O(rows) instead of a pass over every ball.
      let n = 0;
      let s1 = 0;
      let s2 = 0;
      for (let k = 0; k <= rows; k++) {
        const c = bins[k] ?? 0;
        n += c;
        s1 += k * c;
        s2 += k * k * c;
      }
      if (n === 0) return { mean: NaN, variance: NaN, n: 0 };
      const mean = s1 / n;
      return { mean, variance: s2 / n - mean * mean, n };
    },
  };
}
