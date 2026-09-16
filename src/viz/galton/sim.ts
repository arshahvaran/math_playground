import type { Rng } from '../../core/types';

/**
 * Galton board: the simulation and the board geometry. Pure, canvas-free, and
 * exercised end to end by tests/galton.test.ts.
 *
 * Two layers that never touch. The *statistics* are decided at release: a
 * ball's route is `rows` independent Bernoulli(p) draws, one per peg row,
 * packed into a bitmask, so the landing bin is popcount(route) and the bin
 * counts are exactly Binomial(rows, p) by construction — identical for a seed
 * at every drop rate, step size and plate size. The *motion* is then real
 * ballistics along that route: free flight under gravity between pegs, a
 * restitution bounce off the curved surface of each peg the route names, and
 * a damped bounce on the pile. The route decides which side of a peg the ball
 * strikes; the physics decides how it gets there and what it does next.
 *
 * Why not a genuine collision model: a ball that grazes a peg tends to keep
 * its direction, so real collisions bias the bins — every physical Galton
 * board is slightly non-binomial for exactly that reason. Here the bins stay
 * exact and the fiction is confined to one number per bounce, where on the
 * shoulder the ball strikes, which is the impact parameter a real board leaves
 * to chance. See `planFlight` for how that number is chosen and what remains
 * of the fiction when it cannot be chosen well enough.
 *
 * The RNG is consulted only at release, `rows` draws per ball, so the bins for
 * a seed are identical at every drop rate and every step size. Only the clock
 * differs. tests/galton.test.ts asserts exactly that.
 */

/** Paths are 32-bit masks, one bit per row; the sim clamps `rows` to this. */
export const MAX_ROWS = 20;

/** Balls of state allocated when the caller passes no budget. */
export const DEFAULT_BUDGET = 50_000;

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

/**
 * Row progress → CSS px. `y = −1` is the release point, `y = rows` the bin
 * mouth, and the same line continues into the bin: `binTop = originY +
 * rows · rowSpacing`, so a ball inside the bin needs no second mapping.
 */
export function progressToPy(g: BoardGeometry, y: number): number {
  return g.originY + y * g.rowSpacing;
}

/**
 * Resting place of the ball that arrived `stack`-th in its bin: lateral
 * offset from the bin's centre line and depth below the bin mouth, CSS px.
 *
 * Resting balls sit in a grid of `cols` per row at a pitch of 2·dotRadius,
 * filling from the floor up, so a pile of c balls stands ⌈c / cols⌉ rows tall
 * — the same height its histogram bar reaches on the shared `unit` scale that
 * derived `dotRadius`. One function serves both the renderer, which paints
 * the pile here, and the simulation, whose arriving ball bounces on this very
 * point: the two cannot disagree on where the pile is.
 */
export function restSlot(
  cols: number,
  dotRadius: number,
  binDepth: number,
  stack: number,
): { dx: number; depth: number } {
  const n = Math.max(1, Math.floor(cols));
  const col = stack % n;
  const row = Math.floor(stack / n);
  return {
    dx: (2 * col + 1 - n) * dotRadius,
    depth: Math.max(dotRadius, binDepth - dotRadius - row * 2 * dotRadius),
  };
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

/**
 * Gravity, CSS px/s². One constant for every plate: a taller board falls
 * longer, a three-row board with its huge pitch is the same board scaled up
 * and moves like one. 8,000 px/s² puts a twelve-row ball at the bin mouth
 * 1.8 s after release on the default 36 px pitch and at rest 0.3 s later —
 * real gravity on a board a metre tall would be twice that, and unreadable.
 *
 * Inside the simulation the unit of length is the peg pitch, so the working
 * value is GRAVITY_PX / pitch, in pitches/s².
 */
export const GRAVITY_PX = 8_000;

/**
 * Coefficient of restitution at a peg: the normal component of the velocity
 * rebounds at half its speed. Higher looks like a superball and, past about
 * 0.6, the hop off one peg reaches into the row above and clips a neighbour.
 */
const PEG_RESTITUTION = 0.5;

/**
 * The component along the peg's surface is absorbed entirely: the rebound is
 * along the contact normal. A light ball on a rough pin grips rather than
 * skids, and this is not a cosmetic choice — with any of the tangential
 * velocity kept, the sideways kick from a strike steep enough to matter
 * outruns the half pitch the lattice allows before the next peg, and the
 * route could only be held by steering. Measured across e ∈ [0.5, 0.7]: a
 * tangential retention of 0.3 doubles the residual correction and 0.6
 * leaves half the bounces unable to reach their peg naturally.
 */

/** Restitution on the pile — a ball landing on a bed of balls is a dead bounce. */
const PILE_RESTITUTION = 0.35;

/** A hop shorter than this, in pitches, is not animated; the ball is at rest. */
const MIN_HOP = 0.02;

/**
 * Where on a peg's shoulder a ball may strike, as the angle of the contact
 * point from the top of the peg. Below 4° the strike is a dead-centre hit
 * with no sideways kick at all; above 45° the contact normal points more
 * sideways than up, which is a ball hitting the side of a peg it should have
 * cleared. The nominal angle is what the one-step lookahead in `planFlight`
 * assumes for the peg after next, before that peg's own angle is chosen.
 */
const STRIKE_MIN = (4 * Math.PI) / 180;
const STRIKE_MAX = (45 * Math.PI) / 180;
const STRIKE_NOMINAL = (14 * Math.PI) / 180;

/** Grid points and bisection steps used to choose the strike angle. */
const STRIKE_GRID = 6;
const STRIKE_BISECTIONS = 16;

/**
 * Contact radius ceiling, pitches. Beyond it the contact circles of a row's
 * pegs would overlap the flight corridor and a ball could not pass between
 * them; layoutBoard() never gets near it (0.07 at three rows, 0.31 at sixteen
 * on the narrowest phone, 0.35 at the simulation's ceiling of twenty), so
 * this only guards a caller passing nonsense.
 */
const MAX_CONTACT = 0.4;

/**
 * The parts of the board the physics needs, CSS px. The renderer derives them
 * from `layoutBoard()` and its pile metrics and hands them over through
 * `setBoard()`; the defaults are the twelve-row board on a desktop plate, so a
 * simulation that is never told about a plate — the tests — still falls at a
 * sensible rate.
 */
export interface BoardPhysics {
  /** Peg pitch. Sets the length unit, and with GRAVITY_PX the time scale. */
  pitch: number;
  /** Peg radius + ball radius: the centre distance at which the two touch. */
  contact: number;
  /** Bin depth from the mouth to the floor. */
  binDepth: number;
  /** Radius of a resting ball in the pile, and balls per row of the pile. */
  dotRadius: number;
  cols: number;
}

export const DEFAULT_BOARD: Readonly<BoardPhysics> = {
  pitch: 36,
  contact: 8,
  binDepth: 160,
  dotRadius: 3,
  cols: 6,
};

/** Time to fall a height `h` (positive, downward) starting at vertical speed `vy` under `g`. */
function fallTime(g: number, vy: number, h: number): number {
  return (-vy + Math.sqrt(vy * vy + 2 * g * h)) / g;
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

/** Per-ball flags. */
const DONE = 1; // through the bin mouth: counted in `bins`
const SETTLED = 2; // resting animation finished and counted in `settledBins`; the ball no longer moves

/**
 * Per-ball motion phases. Each is one analytic segment — x and y are both
 * quadratic in the time since the segment began — so a step of any length
 * lands on exactly the same trajectory as many short ones.
 */
const FLIGHT = 0; // free flight toward peg row `row`
const BIN = 1; // past the last peg, falling to its place on the pile
const BOUNCE = 2; // hopping on the pile
const REST = 3; // at rest; may still be waiting its turn to be counted

/**
 * One ball, as seen by the renderer. `forEachBall` / `forEachActive` reuse a
 * single view across calls: copy the fields out rather than keeping the object.
 */
export interface BallView {
  /** Lateral offset from the centre line in peg pitches. Bin k's centre is at k − rows/2. */
  x: number;
  /**
   * Vertical position in rows: −1 at release, r at the centre of peg row r,
   * rows at the bin mouth, and greater inside the bin. A ball in flight rises
   * above the row it just left when it hops off a peg.
   */
  y: number;
  /** Velocity, peg pitches per second; `vy` positive downward. */
  vx: number;
  vy: number;
  /** Peg row the ball is flying toward, or `rows` once it is past the last peg. */
  row: number;
  /** Bit r set ⇔ the ball went right at peg row r. */
  path: number;
  /** Through the bin mouth: counted in `bins`. */
  done: boolean;
  /** At rest in the pile and counted in `settledBins`. Implies `done`. */
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
  /** Balls that have entered a bin. */
  readonly landed: number;
  /** Balls released but not yet in a bin. */
  readonly inFlight: number;
  /** Balls released so far, including those at rest — the number the renderer can ask for. */
  readonly ballCount: number;
  /** Landing counts, one per bin, length rows + 1. A view: read, do not keep across setParams. */
  readonly bins: Uint32Array;
  /** Balls per bin that have finished settling, so the renderer can draw a pile that never double-draws a ball still in the air. */
  readonly settledBins: Uint32Array;
  /** Simulation clock, ms. */
  readonly time: number;
  /** Gravity in the simulation's own units, peg pitches per s². */
  readonly gravity: number;
  /** Centre distance at which a ball touches a peg, peg pitches. */
  readonly contact: number;
  /** A fresh copy of ball `i`'s state, 0 ≤ i < ballCount. */
  ball(i: number): BallView;
  /** Every released ball, in release order. */
  forEachBall(cb: (ball: BallView, index: number) => void): void;
  /** Only balls still moving: in flight, bouncing, or resting but not yet counted. */
  forEachActive(cb: (ball: BallView, index: number) => void): void;
  /** Clear the board. Does not reseed the RNG; the caller owns it. */
  reset(): void;
  /**
   * Apply new parameters. A change of `rows` resets the board, since paths
   * for a different row count are a different experiment; `p` applies to
   * balls released from now on; `balls` and `dropRate` take effect immediately.
   */
  setParams(p: GaltonParams): void;
  /**
   * Tell the physics what the plate looks like. Segments already in the air
   * finish on the plan they were launched with; every later launch uses the
   * new board, so a resize mid-run costs one flight of slightly stale aim.
   */
  setBoard(board: BoardPhysics): void;
  /** Mean and population variance of the landed bin indices. NaN until a ball lands. */
  stats(): { mean: number; variance: number; n: number };
}

export function createSim(rng: Rng, params: GaltonParams, budget = DEFAULT_BUDGET): GaltonSim {
  const capacity = Math.max(1, Math.floor(budget));

  // Per-ball state, allocated once at the ceiling. Nothing grows per frame.
  const paths = new Uint32Array(capacity);
  const spawnTime = new Float64Array(capacity);
  const flags = new Uint8Array(capacity);
  const phase = new Uint8Array(capacity);
  const row = new Uint8Array(capacity);
  const binIdx = new Uint8Array(capacity);
  const stackIdx = new Uint32Array(capacity);
  // The current segment: launch point and velocity, lateral and vertical
  // acceleration, the strike angle it ends in, its duration, and the time
  // elapsed within it. Seconds and pitches.
  const sX = new Float64Array(capacity);
  const sY = new Float64Array(capacity);
  const sVx = new Float64Array(capacity);
  const sVy = new Float64Array(capacity);
  const sAx = new Float64Array(capacity);
  const sAy = new Float64Array(capacity);
  const sTheta = new Float64Array(capacity);
  const sDur = new Float64Array(capacity);
  const sT = new Float64Array(capacity);

  // Per-bin state at the row ceiling; `bins` / `settledBins` are views of the live prefix.
  const binsAll = new Uint32Array(MAX_ROWS + 1);
  const settledAll = new Uint32Array(MAX_ROWS + 1);
  // Resting places handed out so far, per bin. Runs ahead of `bins`: a ball
  // is given its place when it is aimed at the last peg, so the flight into
  // the bin can be planned, and is counted in `bins` when it enters the bin.
  const assigned = new Uint32Array(MAX_ROWS + 1);
  // Balls that reached that point during this tick, waiting for their place.
  // Places go out in order of the exact instant each ball got there, not in
  // the order the tick happened to visit them, so a run stepped a second at
  // a time lays out the same pile as one stepped at 120 Hz — see `advance`.
  const pending = new Uint32Array(capacity);
  let pendingCount = 0;

  let rows = 0;
  let p = 0.5;
  let target = 0;
  let dropRate = 0;
  let bins = binsAll.subarray(0, 1);
  let settledBins = settledAll.subarray(0, 1);

  // The board, in pitches where the physics needs it and px where the pile does.
  let pitch = DEFAULT_BOARD.pitch;
  let g = GRAVITY_PX / pitch;
  let contact = DEFAULT_BOARD.contact / pitch;
  let binDepth = DEFAULT_BOARD.binDepth;
  let dotRadius = DEFAULT_BOARD.dotRadius;
  let cols = DEFAULT_BOARD.cols;

  let time = 0;
  let spawned = 0;
  let landed = 0;
  // Balls come to rest roughly in release order, so the counted ones form a
  // prefix that `firstActive` skips; a straggler behind it is skipped by flag.
  let firstActive = 0;
  // Balls owed by the drop-rate accumulator. Starts at one so the first ball
  // leaves on the first tick instead of waiting a full period.
  let owed = 1;

  const view: BallView = {
    x: 0, y: 0, vx: 0, vy: 0, row: 0, path: 0, done: false, settled: false, bin: 0, stack: 0, age: 0,
  };

  /** +1 if the route turns right at peg row `r`, −1 if left. */
  function side(path: number, r: number): number {
    return (path >>> r) & 1 ? 1 : -1;
  }

  /** Index of the peg the route reaches in row `r`: the rights taken above it. */
  function pegIndex(path: number, r: number): number {
    return popcount32(path & ((1 << r) - 1));
  }

  // Scratch for the two-vector helpers below, so planning allocates nothing.
  let outX = 0;
  let outY = 0;

  /** Contact point for a strike on peg (r, k) at `theta` from the top, on side `s`. */
  function contactPoint(r: number, k: number, s: number, theta: number): void {
    outX = k - r / 2 + s * contact * Math.sin(theta);
    outY = r * ASPECT - contact * Math.cos(theta);
  }

  /** Resting place of ball `i`, in pitches from the centre line and the apex row. */
  function slotPoint(i: number): void {
    const slot = restSlot(cols, dotRadius, binDepth, stackIdx[i] ?? 0);
    outX = (binIdx[i] ?? 0) - rows / 2 + slot.dx / pitch;
    outY = rows * ASPECT + slot.depth / pitch;
  }

  /**
   * Rebound off the peg surface. The contact normal at a strike `theta` from
   * the top on side `s` is (s·sin θ, −cos θ); the normal component of the
   * incoming velocity reverses at PEG_RESTITUTION and the tangential one is
   * absorbed, so the ball leaves along the normal — upward and toward `s`. A
   * ball that arrives faster leaves faster, and hops higher: nothing here
   * knows the row count or the clock.
   */
  function reflect(vx: number, vy: number, theta: number, s: number): void {
    const nx = s * Math.sin(theta);
    const ny = -Math.cos(theta);
    const vn = vx * nx + vy * ny;
    // vn ≥ 0 would be a ball already moving away from the surface, which the
    // planner never produces; treat it as a grazing miss rather than reverse it.
    const out = vn < 0 ? -PEG_RESTITUTION * vn : 0;
    outX = out * nx;
    outY = out * ny;
  }

  // The flight the planner is evaluating, written by `evaluate()`.
  let evT = 0;
  let evAx = 0;

  /**
   * Plan the flight of ball `i` from (x0, y0) with velocity (vx, vy) to peg
   * row `r`, index `k`, and choose where on that peg's shoulder it strikes.
   *
   * The vertical motion is exact: T is the time gravity takes to bring the
   * ball from y0 down to the contact point, so a ball arriving fast is
   * through the row sooner. The lateral motion is where the pre-drawn route
   * meets the physics. With the launch velocity the rebound gave it the ball
   * would reach the contact height at x0 + vx·T; the contact point is where
   * the route needs it. The difference is closed by a constant lateral
   * acceleration over the flight — gently, spread along the arc, never a
   * snap — and the strike angle is chosen to make that difference as small as
   * it can be:
   *
   * The angle sets the rebound. A strike near the top of the peg sends the
   * ball almost straight back up with little sideways kick; further round the
   * shoulder the kick grows. So the angle to choose on *this* peg is the one
   * whose rebound flies naturally to the *next* target — the nominal contact
   * point on the peg after this one, or the ball's resting place in its bin
   * when this is the last peg. That is a one-step lookahead solved by
   * bisection on the angle; it finds an exact solution for about nine bounces
   * in ten at twelve rows, and the residual on the rest is the gentle
   * correction above (median 0.03 pitch, never above 0.2). The fiction that
   * remains is the strike angle itself, the one quantity a real board leaves
   * to chance.
   */
  function planFlight(i: number, x0: number, y0: number, vx: number, vy: number, r: number, k: number): void {
    const path = paths[i] ?? 0;
    const s = side(path, r);
    // The lookahead's target: the next peg's nominal contact point, or the pile.
    let afterX: number;
    let afterY: number;
    if (r + 1 < rows) {
      contactPoint(r + 1, k + (s > 0 ? 1 : 0), side(path, r + 1), STRIKE_NOMINAL);
      afterX = outX;
      afterY = outY;
    } else {
      // Past this peg the ball is in its bin, so it takes its place in the
      // pile now: the flight after this one is aimed at it.
      const bin = k + (s > 0 ? 1 : 0);
      binIdx[i] = bin;
      stackIdx[i] = assigned[bin] ?? 0;
      assigned[bin] = (assigned[bin] ?? 0) + 1;
      slotPoint(i);
      afterX = outX;
      afterY = outY;
    }

    /** Lateral miss of the rebound's natural flight to `after`, for a strike at `theta`. */
    const evaluate = (theta: number): number => {
      contactPoint(r, k, s, theta);
      const xA = outX;
      const yA = outY;
      const T = fallTime(g, vy, yA - y0);
      const ax = (2 * (xA - (x0 + vx * T))) / (T * T);
      reflect(vx + ax * T, vy + g * T, theta, s);
      const T2 = fallTime(g, outY, afterY - yA);
      evT = T;
      evAx = ax;
      return afterX - (xA + outX * T2);
    };

    // Coarse grid, then bisect the first bracket. Without a bracket the
    // rebound cannot reach the next target at any angle in range — a slow
    // ball high on the board, usually — and the best grid point stands.
    let bestTheta = STRIKE_MIN;
    let bestMiss = Infinity;
    let loTheta = 0;
    let loMiss = 0;
    let hiTheta = -1;
    let hiMiss = 0;
    for (let j = 0; j <= STRIKE_GRID; j++) {
      const theta = STRIKE_MIN + ((STRIKE_MAX - STRIKE_MIN) * j) / STRIKE_GRID;
      const miss = evaluate(theta);
      if (Math.abs(miss) < Math.abs(bestMiss)) {
        bestMiss = miss;
        bestTheta = theta;
      }
      if (j > 0 && hiTheta < 0 && (loMiss < 0) !== (miss < 0)) {
        hiTheta = theta;
        hiMiss = miss;
      } else if (hiTheta < 0) {
        loTheta = theta;
        loMiss = miss;
      }
    }
    if (hiTheta >= 0) {
      for (let j = 0; j < STRIKE_BISECTIONS; j++) {
        const mid = (loTheta + hiTheta) / 2;
        const miss = evaluate(mid);
        if ((miss < 0) === (loMiss < 0)) {
          loTheta = mid;
          loMiss = miss;
        } else {
          hiTheta = mid;
          hiMiss = miss;
        }
      }
      bestTheta = Math.abs(loMiss) < Math.abs(hiMiss) ? loTheta : hiTheta;
    }
    evaluate(bestTheta);

    phase[i] = FLIGHT;
    row[i] = r;
    sX[i] = x0;
    sY[i] = y0;
    sVx[i] = vx;
    sVy[i] = vy;
    sAx[i] = evAx;
    sAy[i] = g;
    sTheta[i] = bestTheta;
    sDur[i] = evT;
    sT[i] = 0;
  }

  /** The flight into the bin: from the last peg's rebound down to the ball's place on the pile. */
  function planBin(i: number, x0: number, y0: number, vx: number, vy: number): void {
    slotPoint(i);
    const T = fallTime(g, vy, outY - y0);
    phase[i] = BIN;
    row[i] = rows;
    sX[i] = x0;
    sY[i] = y0;
    sVx[i] = vx;
    sVy[i] = vy;
    // A bin is a pitch wide and the fall into it is long, so this correction
    // is the gentlest on the board: the ball leans toward its place in the
    // pile as it drops.
    sAx[i] = (2 * (outX - (x0 + vx * T))) / (T * T);
    sAy[i] = g;
    sDur[i] = T;
    sT[i] = 0;
  }

  /**
   * Bounce on the pile with the ball arriving at `vDown`, or come to rest if
   * the hop would be too small to see. The pile catches the ball laterally —
   * it lands in the hollow between the balls under it — so a bounce is
   * vertical, from and back to the resting place.
   */
  function bounce(i: number, vDown: number): void {
    const v = PILE_RESTITUTION * vDown;
    slotPoint(i);
    if ((v * v) / (2 * g) < MIN_HOP) {
      phase[i] = REST;
      sVx[i] = 0;
      sVy[i] = 0;
      sAx[i] = 0;
      sAy[i] = 0;
      sDur[i] = Infinity;
    } else {
      phase[i] = BOUNCE;
      sVx[i] = 0;
      sVy[i] = -v;
      sAx[i] = 0;
      sAy[i] = g;
      sDur[i] = (2 * v) / g;
    }
    sX[i] = outX;
    sY[i] = outY;
    sT[i] = 0;
  }

  function land(i: number): void {
    const k = binIdx[i] ?? 0;
    bins[k] = (bins[k] ?? 0) + 1;
    landed++;
    flags[i] = (flags[i] ?? 0) | DONE;
  }

  /** Finish ball `i`'s current segment and plan the next one. */
  function complete(i: number): void {
    const T = sDur[i] ?? 0;
    const x = (sX[i] ?? 0) + (sVx[i] ?? 0) * T + ((sAx[i] ?? 0) * T * T) / 2;
    const y = (sY[i] ?? 0) + (sVy[i] ?? 0) * T + ((sAy[i] ?? 0) * T * T) / 2;
    const vx = (sVx[i] ?? 0) + (sAx[i] ?? 0) * T;
    const vy = (sVy[i] ?? 0) + (sAy[i] ?? 0) * T;
    switch (phase[i]) {
      case FLIGHT: {
        const r = row[i] ?? 0;
        const path = paths[i] ?? 0;
        const s = side(path, r);
        reflect(vx, vy, sTheta[i] ?? 0, s);
        const k = pegIndex(path, r) + (s > 0 ? 1 : 0);
        if (r + 1 < rows) planFlight(i, x, y, outX, outY, r + 1, k);
        else planBin(i, x, y, outX, outY);
        return;
      }
      case BIN:
        // A long step can carry the ball through the mouth and onto the pile
        // between two mouth checks.
        if (((flags[i] ?? 0) & DONE) === 0) land(i);
        bounce(i, vy);
        return;
      case BOUNCE:
        // Back on the pile at the speed it left with.
        bounce(i, -(sVy[i] ?? 0));
        return;
      default:
        return;
    }
  }

  /** Move ball `i` forward by `dt` ms through as many segments as that covers. */
  function advance(i: number, dt: number): void {
    let t = (sT[i] ?? 0) + dt / 1000;
    let dur = sDur[i] ?? Infinity;
    while (t >= dur) {
      t -= dur;
      if (phase[i] === FLIGHT && (row[i] ?? 0) === rows - 2) {
        // Completing this flight aims the ball at the last peg, which hands
        // it a place in the pile. Park it at the end of the segment instead,
        // with the rest of the tick still to run, and let `resolvePending`
        // hand places out in order of arrival once every ball has moved.
        sT[i] = t;
        pending[pendingCount++] = i;
        return;
      }
      complete(i);
      dur = sDur[i] ?? Infinity;
    }
    sT[i] = t;
    if (phase[i] === BIN && ((flags[i] ?? 0) & DONE) === 0) {
      const y = (sY[i] ?? 0) + (sVy[i] ?? 0) * t + ((sAy[i] ?? 0) * t * t) / 2;
      if (y >= rows * ASPECT) land(i);
    }
  }

  /**
   * Finish the tick for the balls `advance` parked: hand out their places in
   * the pile in the order they reached the last-but-one row, then run each
   * through the rest of the tick. The order is exact — every parked ball is
   * stopped at the same instant of the same tick, so the one with more of
   * the tick left to run got there first — and independent of the step size.
   */
  function resolvePending(): void {
    if (pendingCount === 0) return;
    const list = pending.subarray(0, pendingCount);
    list.sort((a, b) => (sT[b] ?? 0) - (sT[a] ?? 0) || a - b);
    for (let j = 0; j < pendingCount; j++) {
      const i = list[j] ?? 0;
      const left = sT[i] ?? 0;
      complete(i);
      advance(i, left * 1000);
    }
    pendingCount = 0;
  }

  /**
   * Count resting balls into `settledBins` in the order their places were
   * handed out. Two balls bound for one bin can arrive out of order — a
   * route with steeper strikes is a slower route — and the renderer paints
   * the pile as its first n places, so a ball may not be counted until every
   * place below its own is filled. It sits on its place meanwhile, drawn as
   * the ball it still is; nothing on screen moves.
   */
  function settleInOrder(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = firstActive; i < spawned; i++) {
        const f = flags[i] ?? 0;
        if ((f & SETTLED) !== 0 || phase[i] !== REST) continue;
        const k = binIdx[i] ?? 0;
        if (stackIdx[i] === (settledBins[k] ?? 0)) {
          flags[i] = f | SETTLED;
          settledBins[k] = (settledBins[k] ?? 0) + 1;
          progress = true;
        }
      }
    }
  }

  function fillView(i: number): BallView {
    const t = sT[i] ?? 0;
    const path = paths[i] ?? 0;
    const f = flags[i] ?? 0;
    if (phase[i] === REST) {
      // Read the place back from the current board rather than the one the
      // ball settled under, so a resize moves it with the pile it is part of.
      slotPoint(i);
      view.x = outX;
      view.y = outY / ASPECT;
      view.vx = 0;
      view.vy = 0;
    } else {
      view.x = (sX[i] ?? 0) + (sVx[i] ?? 0) * t + ((sAx[i] ?? 0) * t * t) / 2;
      view.y = ((sY[i] ?? 0) + (sVy[i] ?? 0) * t + ((sAy[i] ?? 0) * t * t) / 2) / ASPECT;
      view.vx = (sVx[i] ?? 0) + (sAx[i] ?? 0) * t;
      view.vy = (sVy[i] ?? 0) + (sAy[i] ?? 0) * t;
    }
    view.row = row[i] ?? 0;
    view.path = path;
    view.done = (f & DONE) !== 0;
    view.settled = (f & SETTLED) !== 0;
    view.bin = binIdx[i] ?? 0;
    view.stack = stackIdx[i] ?? 0;
    view.age = time - (spawnTime[i] ?? 0);
    return view;
  }

  /** Release one ball that has already been falling for `age` ms. */
  function spawn(age: number): void {
    const i = spawned++;
    let path = 0;
    for (let r = 0; r < rows; r++) if (rng.bool(p)) path |= 1 << r;
    paths[i] = path >>> 0;
    spawnTime[i] = time - age;
    flags[i] = 0;
    // From rest, one row pitch above the apex, on the centre line.
    planFlight(i, 0, -ASPECT, 0, 0, 0, 0);
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
    assigned.fill(0);
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
    if (rowsChanged) reset();
  }

  function setBoard(board: BoardPhysics): void {
    pitch = Math.max(1, board.pitch);
    g = GRAVITY_PX / pitch;
    contact = Math.min(MAX_CONTACT, Math.max(0.01, board.contact / pitch));
    binDepth = Math.max(1, board.binDepth);
    dotRadius = Math.max(0.1, board.dotRadius);
    cols = Math.max(1, Math.floor(board.cols));
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

      resolvePending();
      settleInOrder();
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
    get gravity() {
      return g;
    },
    get contact() {
      return contact;
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
    setBoard,

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
