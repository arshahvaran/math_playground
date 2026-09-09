import type { Rng } from '../../core/types';

/**
 * Diffusion-limited aggregation: the mathematics, with no canvas in sight.
 *
 * One seed particle sits at the origin. A wanderer is released on a circle just
 * outside the cluster and takes a random walk until it touches something, where
 * it freezes and becomes part of the cluster. Repeat. Witten and Sander (1981)
 * found that the object this builds is a fractal: the particle count inside a
 * radius grows as N ~ R^D with D ≈ 1.71 in two dimensions, not as R². It is
 * nowhere dense, at every scale, and the mechanism is screening — a wanderer
 * approaching from far away meets an exposed tip long before it reaches a gap
 * between two branches, so the tips get all the growth and the gaps stay open.
 *
 * Every length here is in particle radii: a particle has radius 1 and two of
 * them touch when their centres are `CONTACT` = 2 apart. The lattice constant
 * is the same 2, so neighbouring sites touch and nothing else does.
 *
 * The RNG is consulted only inside the walk, so a seed reproduces the cluster
 * exactly at any walk speed — the caller decides how many steps to take per
 * tick, never how they come out.
 */

/** Centre distance at which two particles touch. The unit of length is the particle radius. */
export const CONTACT = 2;

/** Off-lattice walk step: half a diameter. Small enough to resolve the surface, large enough to move. */
const STEP = 1;

/** Lattice constant, for the two lattice modes. Neighbouring sites touch, and nothing else does. */
const SITE = CONTACT;
const HALF_SITE = SITE / 2;

/**
 * Slack on the lattice adjacency test.
 *
 * A triangular-lattice site sits at (2i + j, j√3), and √3 is irrational: the
 * coordinate is stored in a Float32 and a neighbour that is exactly `CONTACT`
 * away in exact arithmetic measures 2.00003 once it has been through the array.
 * A bare `≤ CONTACT` therefore misses a few per cent of contacts on that
 * lattice and lets wanderers walk through branches. The next distance up on
 * either lattice is 2√2 or 2√3, so a hundredth of a radius separates
 * "neighbour" from "not" with four orders of magnitude to spare.
 */
const ADJACENT = CONTACT + 0.01;

/**
 * Neighbour offsets, as exact multiples of the lattice basis rather than
 * `cos(d·60°)` per step: the walker's position is a running sum of these, and
 * accumulating a rounded 0.5000000000000001 over a few thousand steps walks it
 * off its own lattice.
 */
const SQUARE_DX = [SITE, -SITE, 0, 0] as const;
const SQUARE_DY = [0, 0, SITE, -SITE] as const;

const TAU = 2 * Math.PI;
const SQRT3 = Math.sqrt(3);
const HEX_DX = [2, 1, -1, -2, -1, 1] as const;
const HEX_DY = [0, SQRT3, SQRT3, 0, -SQRT3, -SQRT3] as const;

export type Lattice = 'off' | 'square' | 'hex';

/**
 * Hash-grid cell size. A contact can then only involve a particle in the 3×3
 * block around the wanderer's own cell, whatever the cluster looks like — which
 * is the whole point of the grid. Scanning the particle list instead would cost
 * O(N) per walk step, and a walk step is the inner loop of this entire tab.
 */
const CELL = CONTACT;

/**
 * The occupancy pyramid: three coarse grids, in particle radii.
 *
 * A wanderer whose 3×3 block at level ℓ is empty has no particle *centre*
 * within one cell width of itself (it sits somewhere inside the middle cell, so
 * the nearest cell it has not checked starts a full cell away), so a disc of
 * that radius around it is empty and it may cross the whole disc in one draw.
 * The levels are checked coarsest first and the first empty one wins, so an
 * open-space query costs nine reads and buys a jump of 254 instead of 1.
 *
 * Sizes are a compromise: 16 resolves the gaps between outer branches, 256 is
 * about the launch standoff at fifty thousand particles, and the memory is
 * dominated by the finest level.
 */
const PYRAMID: readonly number[] = [16, 64, 256];

/** Launch circle standoff beyond the cluster radius, in particle radii. */
const DEFAULT_LAUNCH_MARGIN = 6;

/**
 * Kill radius as a multiple of the launch radius.
 *
 * A wanderer that drifts away must be given up on. The standard argument: a
 * random walk in two dimensions is recurrent — Pólya's theorem says it returns
 * to any neighbourhood with probability 1 — so following it is *correct*, but
 * the expected return time is infinite, so following it is also unboundedly
 * slow. It is relaunched instead, and the relaunches are counted and published
 * because that is the honest cost of the shortcut.
 *
 * Ten rather than the customary three because relaunching on a fresh uniform
 * angle throws away where the walker actually was. The exact re-entry density
 * on a circle of radius a from distance r is the exterior Poisson kernel
 * (r² − a²)/(2π(r² + a² − 2ar·cos θ)), which at r = 3a runs from 1.5× uniform
 * facing the walker to 0.67× behind it, and at r = 10a from 1.22× to 0.82×.
 * The far field is nearly free to cross — see `freeRadius` — so the wider
 * circle costs a few jumps and halves the bias on the walkers that are killed.
 */
const DEFAULT_KILL_FACTOR = 10;

/** Growth checkpoints per octave of N, for the dimension fit. */
const CHECKPOINTS_PER_OCTAVE = 8;
const CHECKPOINT_RATIO = 2 ** (1 / CHECKPOINTS_PER_OCTAVE);

/** First N recorded in the growth history. */
const HISTORY_FROM = 16;

/** Checkpoint slots. 16 → 50,000 at eight per octave is 92 of them. */
const HISTORY_MAX = 128;

/**
 * Smallest N a checkpoint may have and still enter the dimension fit.
 *
 * Below a few hundred particles the cluster is a handful of arms and its
 * radius of gyration is dominated by which way the first dozen happened to go;
 * including that regime drags the slope well off 1.71. This is the standard
 * finite-size caveat on any DLA dimension estimate, not a fitted constant.
 */
export const FIT_FROM = 300;

export interface ClusterOptions {
  /** Particles to freeze, including the seed. */
  particles: number;
  /** Typed-array ceiling. Allocated once; defaults to `particles`. */
  capacity?: number;
  /** Probability of adhering on contact, in (0, 1]. Below 1 the wanderer bounces and walks on. */
  stickiness: number;
  lattice: Lattice;
  /** Launch circle standoff beyond the cluster radius, in particle radii. */
  launchMargin?: number;
  /** Kill radius as a multiple of the launch radius. */
  killFactor?: number;
}

export interface DimensionFit {
  /** The slope of ln N against ln R_g, which is D in N ~ R_g^D. NaN below three checkpoints. */
  dimension: number;
  /** Standard error of that slope, from the fit residual. This is the honest tolerance. */
  stderr: number;
  /** RMS residual in ln N. */
  residual: number;
  /** Checkpoints the fit used. */
  points: number;
}

/**
 * Radius of gyration of the first `n` particles: the RMS distance from their
 * own centre of mass, √(⟨|r − r̄|²⟩). This is the cluster's size in the sense
 * the scaling law N ~ R_g^D uses, and it is preferred to the outermost particle
 * because a single early arm reaching outward does not move it.
 *
 * Two passes rather than ⟨r²⟩ − ⟨r⟩², for the reason `core/stats.ts` gives:
 * the one-pass form cancels catastrophically once the centre of mass is far
 * from the spread. Here it never is — the seed is at the origin — but the
 * running accumulators inside `Cluster` use the one-pass form, and this is what
 * they are checked against.
 */
export function radiusOfGyration(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): number {
  const m = Math.min(Math.max(0, Math.floor(n)), xs.length, ys.length);
  if (m === 0) return NaN;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < m; i++) {
    cx += xs[i]!;
    cy += ys[i]!;
  }
  cx /= m;
  cy /= m;
  let ss = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i]! - cx;
    const dy = ys[i]! - cy;
    ss += dx * dx + dy * dy;
  }
  return Math.sqrt(ss / m);
}

/**
 * Fit D in N ~ R_g^D over a growth history, by least squares on ln N against
 * ln R_g. The dimension is *measured* here, never assumed: the cluster is
 * sampled as it grows and the slope of the log–log line is the answer.
 *
 * ln N is the dependent variable because N is the exact count and R_g the
 * fluctuating one — regressing the other way and inverting the slope would
 * attenuate D toward zero by the usual errors-in-variables factor.
 *
 * `stderr` is the textbook standard error of a least-squares slope,
 * s·(Σ(x − x̄)²)^(−1/2) with s the residual standard deviation, and it is what a
 * test should compare against: a DLA dimension estimate is genuinely noisy, and
 * the fit itself says by how much. Checkpoints are geometrically spaced, so the
 * fit weights every octave of growth equally rather than the last one.
 */
export function fractalDimension(
  ns: ArrayLike<number>,
  rgs: ArrayLike<number>,
  count: number,
  minN: number = FIT_FROM,
): DimensionFit {
  const m = Math.min(Math.max(0, Math.floor(count)), ns.length, rgs.length);
  let sx = 0;
  let sy = 0;
  let k = 0;
  for (let i = 0; i < m; i++) {
    const n = ns[i]!;
    const rg = rgs[i]!;
    if (n < minN || !(rg > 0)) continue;
    sx += Math.log(rg);
    sy += Math.log(n);
    k++;
  }
  if (k < 3) return { dimension: NaN, stderr: Infinity, residual: NaN, points: k };
  const mx = sx / k;
  const my = sy / k;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i++) {
    const n = ns[i]!;
    const rg = rgs[i]!;
    if (n < minN || !(rg > 0)) continue;
    const dx = Math.log(rg) - mx;
    sxx += dx * dx;
    sxy += dx * (Math.log(n) - my);
  }
  if (!(sxx > 0)) return { dimension: NaN, stderr: Infinity, residual: NaN, points: k };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < m; i++) {
    const n = ns[i]!;
    const rg = rgs[i]!;
    if (n < minN || !(rg > 0)) continue;
    const e = Math.log(n) - (intercept + slope * Math.log(rg));
    ss += e * e;
  }
  // Two degrees of freedom go to the slope and the intercept.
  const residual = Math.sqrt(ss / Math.max(1, k - 2));
  return { dimension: slope, stderr: residual / Math.sqrt(sxx), residual, points: k };
}

/**
 * A growing DLA cluster.
 *
 * State is three typed arrays plus two grids, all allocated once at `capacity`:
 * the particle coordinates, a hash grid at the contact distance for the O(1)
 * contact test, and the occupancy pyramid that tells a wanderer how far it may
 * jump through empty space. Nothing here allocates per step or per frame.
 */
export class Cluster {
  readonly capacity: number;
  /** Particle centres, in particle radii, in arrival order. */
  readonly xs: Float32Array;
  readonly ys: Float32Array;

  /** Checkpointed growth history: N and R_g at geometrically spaced counts. */
  readonly historyN = new Float64Array(HISTORY_MAX);
  readonly historyRg = new Float64Array(HISTORY_MAX);

  #rng: Rng;
  #target = 1;
  #stickiness = 1;
  #lattice: Lattice = 'off';
  #launchMargin = DEFAULT_LAUNCH_MARGIN;
  #killFactor = DEFAULT_KILL_FACTOR;

  #count = 0;
  #relaunches = 0;
  #bounces = 0;
  #steps = 0;
  #historyCount = 0;
  #nextCheckpoint = HISTORY_FROM;

  /** Outermost particle, so the launch and kill circles follow the cluster. */
  #clusterRadius = 0;

  /** Running first and second moments, for R_g without rescanning the arrays. */
  #sumX = 0;
  #sumY = 0;
  #sumSq = 0;

  #walkerX = 0;
  #walkerY = 0;
  #walking = false;

  /** Scratch for `#snap`, so the lattice modes allocate nothing per step. */
  #snapX = 0;
  #snapY = 0;

  // Hash grid: `heads` indexes into the chain in `nextIn`, both sized once.
  readonly #mask: number;
  readonly #heads: Int32Array;
  readonly #nextIn: Int32Array;

  // Occupancy pyramid: one byte per cell per level, in one buffer.
  readonly #levelOffset: Int32Array;
  readonly #levelHalf: Int32Array;
  readonly #occupancy: Uint8Array;
  /** Cleared if a particle ever lands outside the pyramid, which disables it. */
  #pyramidValid = true;

  constructor(rng: Rng, opts: ClusterOptions) {
    this.#rng = rng;
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? opts.particles));
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);

    // Two buckets per particle keeps the chains at a couple of entries. A
    // collision costs a distance test that fails, never a wrong answer.
    let size = 16;
    while (size < 2 * this.capacity) size *= 2;
    this.#mask = size - 1;
    this.#heads = new Int32Array(size);
    this.#nextIn = new Int32Array(this.capacity);

    // The pyramid has to cover everything the cluster can reach, because a
    // particle outside it would leave its cell reading "empty" and a wanderer
    // would jump straight through the branch. R_g ≈ N^(1/1.71) in particle
    // radii and the outermost particle sits at roughly 2.5 R_g, so three
    // gyration radii plus the launch standoff is generous; if it ever is not,
    // `#pyramidValid` turns the pyramid off rather than letting it lie.
    const reach = 3 * this.capacity ** (1 / 1.71) + 64;
    const offsets: number[] = [];
    const halves: number[] = [];
    let total = 0;
    for (const cell of PYRAMID) {
      const half = Math.ceil(reach / cell);
      offsets.push(total);
      halves.push(half);
      total += (2 * half + 1) * (2 * half + 1);
    }
    this.#levelOffset = Int32Array.from(offsets);
    this.#levelHalf = Int32Array.from(halves);
    this.#occupancy = new Uint8Array(total);

    this.reset(opts);
  }

  get count(): number {
    return this.#count;
  }

  get target(): number {
    return this.#target;
  }

  get done(): boolean {
    return this.#count >= this.#target;
  }

  /** Wanderers given up on at the kill radius and released again. */
  get relaunches(): number {
    return this.#relaunches;
  }

  /** Contacts that did not stick. The whole of what the stickiness slider does. */
  get bounces(): number {
    return this.#bounces;
  }

  get steps(): number {
    return this.#steps;
  }

  /** Distance from the origin to the outermost particle. */
  get clusterRadius(): number {
    return this.#clusterRadius;
  }

  get launchRadius(): number {
    return this.#clusterRadius + this.#launchMargin;
  }

  get killRadius(): number {
    return this.launchRadius * this.#killFactor;
  }

  get walkerX(): number {
    return this.#walkerX;
  }

  get walkerY(): number {
    return this.#walkerY;
  }

  /** False between a kill and the next launch, and before the first step. */
  get walking(): boolean {
    return this.#walking;
  }

  get historyCount(): number {
    return this.#historyCount;
  }

  /**
   * Radius of gyration, from the running moments — O(1), because this is read
   * every frame. `radiusOfGyration()` recomputes it in two passes and the test
   * holds the two against each other.
   */
  get gyration(): number {
    const n = this.#count;
    if (n === 0) return NaN;
    const cx = this.#sumX / n;
    const cy = this.#sumY / n;
    return Math.sqrt(Math.max(0, this.#sumSq / n - cx * cx - cy * cy));
  }

  /** The measured dimension so far, refit from the whole growth history. */
  dimension(minN: number = FIT_FROM): DimensionFit {
    return fractalDimension(this.historyN, this.historyRg, this.#historyCount, minN);
  }

  /**
   * Raise or lower the particle target without disturbing the cluster.
   *
   * The target gates when the walk stops and nothing else — it is read nowhere
   * inside a step — so the cluster already grown is a prefix of the longer run,
   * and continuing it is the same sequence a fresh run would produce. Refuses
   * to drop below what is already frozen, where there would be no such reading.
   */
  retarget(particles: number): boolean {
    const next = Math.max(1, Math.min(this.capacity, Math.floor(particles)));
    if (next < this.#count) return false;
    this.#target = next;
    return true;
  }

  /**
   * Restart from the seed particle, optionally with new parameters.
   *
   * Every array is kept and zeroed in place, so a parameter change costs the
   * cluster that was on screen and nothing else — no reallocation of the
   * megabyte of typed arrays a fifty-thousand-particle budget reserves.
   */
  reset(opts?: Partial<ClusterOptions>): void {
    if (opts?.particles !== undefined) {
      this.#target = Math.max(1, Math.min(this.capacity, Math.floor(opts.particles)));
    }
    if (opts?.stickiness !== undefined) {
      this.#stickiness = Math.min(1, Math.max(0.001, opts.stickiness));
    }
    if (opts?.lattice !== undefined) this.#lattice = opts.lattice;
    if (opts?.launchMargin !== undefined) this.#launchMargin = Math.max(CONTACT, opts.launchMargin);
    if (opts?.killFactor !== undefined) this.#killFactor = Math.max(1.5, opts.killFactor);

    this.#heads.fill(-1);
    this.#occupancy.fill(0);
    this.#pyramidValid = true;
    this.#count = 0;
    this.#relaunches = 0;
    this.#bounces = 0;
    this.#steps = 0;
    this.#historyCount = 0;
    this.#nextCheckpoint = HISTORY_FROM;
    this.#clusterRadius = 0;
    this.#sumX = 0;
    this.#sumY = 0;
    this.#sumSq = 0;
    this.#walking = false;
    this.#walkerX = 0;
    this.#walkerY = 0;

    // The seed. Every cluster grows from one particle at the origin.
    this.#freeze(0, 0);
  }

  /**
   * Take up to `steps` walk steps. Returns how many particles froze.
   *
   * The unit of work is one *walk* step, not one particle: a particle can take
   * thousands of steps to arrive, and a frame that waited for one would stall.
   */
  advance(steps: number): number {
    const before = this.#count;
    for (let i = 0; i < steps && this.#count < this.#target; i++) this.#walkOnce();
    return this.#count - before;
  }

  /**
   * Grow to the target in one go. Returns the walk steps it took.
   *
   * `maxSteps` is a guard, not a parameter: a stickiness low enough to leave a
   * wanderer rattling inside a pocket forever would otherwise hang the caller.
   * Reaching it stops the growth short, and `count` says so.
   */
  grow(maxSteps = 4_000 * this.capacity): number {
    const before = this.#steps;
    while (this.#count < this.#target && this.#steps - before < maxSteps) this.#walkOnce();
    return this.#steps - before;
  }

  // -------------------------------------------------------------------------
  // The walk
  // -------------------------------------------------------------------------

  #walkOnce(): void {
    this.#steps++;
    if (!this.#walking) this.#launch();

    const px = this.#walkerX;
    const py = this.#walkerY;

    // How far the wanderer may move without any chance of meeting the cluster.
    const free = this.#freeRadius(px, py);
    const onLattice = this.#lattice !== 'off';
    // A snap to the nearest site can move the landing point by up to a cell
    // circumradius — √2 on the square lattice, 2/√3 on the triangular one — so
    // a flight gives that back before it starts.
    const slack = onLattice ? CONTACT : 0;
    const flight = free - slack;
    // A flight has to beat the step it replaces, or it is a shorter move for
    // more work: on a lattice that step is a whole lattice constant.
    const baseStep = onLattice ? SITE : STEP;

    let nx: number;
    let ny: number;
    if (flight > baseStep) {
      // Free flight. The first place a Brownian walker leaves an empty disc is
      // uniform on that disc's boundary, so crossing the whole disc in one draw
      // is exact rather than an approximation — that is what makes reaching
      // fifty thousand particles possible at all. On a lattice it *is* an
      // approximation: the exit distribution of a lattice walk from a disc many
      // sites across is uniform only in the limit, and the landing site is then
      // snapped. Both errors live far from the cluster, where the walk carries
      // no information about the shape being grown.
      const a = this.#rng.next() * TAU;
      nx = px + flight * Math.cos(a);
      ny = py + flight * Math.sin(a);
      if (onLattice) {
        this.#snap(nx, ny);
        nx = this.#snapX;
        ny = this.#snapY;
      }
    } else if (this.#lattice === 'square') {
      // Four neighbours at the lattice constant; the diagonals are 2√2 away and
      // are not neighbours.
      const d = this.#rng.int(0, 3);
      nx = px + SQUARE_DX[d]!;
      ny = py + SQUARE_DY[d]!;
    } else if (this.#lattice === 'hex') {
      // Six neighbours of the triangular lattice, 60° apart and one lattice
      // constant away — the contact graph of the densest packing of discs in
      // the plane, and the dual of the honeycomb.
      const d = this.#rng.int(0, 5);
      nx = px + HEX_DX[d]!;
      ny = py + HEX_DY[d]!;
    } else {
      const a = this.#rng.next() * TAU;
      nx = px + STEP * Math.cos(a);
      ny = py + STEP * Math.sin(a);
    }

    if (onLattice) {
      // On a lattice the walker only ever exists at sites, so contact is
      // adjacency: a step onto a site that touches the cluster.
      if (this.#occupied(nx, ny)) {
        if (this.#rng.next() < this.#stickiness) this.#freeze(nx, ny);
        else this.#bounces++;
        return;
      }
    } else {
      // Off the lattice the step sweeps a segment, so the wanderer is placed
      // where it first touches rather than wherever the step happened to end —
      // a step of 1 into a particle 2.001 away would otherwise bury it half a
      // radius deep, and the cluster would read denser than it is.
      const t = this.#firstContact(px, py, nx - px, ny - py);
      if (t >= 0) {
        if (this.#rng.next() < this.#stickiness) {
          this.#freeze(px + t * (nx - px), py + t * (ny - py));
        } else {
          this.#bounces++;
        }
        return;
      }
    }

    this.#walkerX = nx;
    this.#walkerY = ny;
    const kill = this.killRadius;
    if (nx * nx + ny * ny > kill * kill) {
      this.#walking = false;
      this.#relaunches++;
    }
  }

  /** Release a wanderer at a uniform angle on the launch circle. */
  #launch(): void {
    const r = this.launchRadius;
    const a = this.#rng.next() * TAU;
    let x = r * Math.cos(a);
    let y = r * Math.sin(a);
    if (this.#lattice !== 'off') {
      this.#snap(x, y);
      x = this.#snapX;
      y = this.#snapY;
    }
    this.#walkerX = x;
    this.#walkerY = y;
    this.#walking = true;
  }

  /**
   * A lower bound on the distance from (x, y) to the surface of the cluster.
   *
   * Two independent bounds, and the larger wins. The first is exact and free:
   * no particle lies beyond `clusterRadius`, so a wanderer at radius r is at
   * least r − clusterRadius − CONTACT from all of them. The second is the
   * pyramid, which is what gets a wanderer across the open bays *inside* that
   * circle — where the first bound says nothing at all.
   */
  #freeRadius(x: number, y: number): number {
    let free = Math.sqrt(x * x + y * y) - this.#clusterRadius - CONTACT;
    if (!this.#pyramidValid) return free;
    for (let l = PYRAMID.length - 1; l >= 0; l--) {
      const cell = PYRAMID[l]!;
      // Nothing this level could prove is worth the nine reads.
      if (free >= cell - CONTACT) return free;
      if (this.#blockEmpty(l, x, y)) return cell - CONTACT;
    }
    return free;
  }

  /** True when every cell of the 3×3 block around (x, y) at level `l` is empty. */
  #blockEmpty(l: number, x: number, y: number): boolean {
    const cell = PYRAMID[l]!;
    const half = this.#levelHalf[l]!;
    const span = 2 * half + 1;
    const base = this.#levelOffset[l]!;
    const cx = Math.floor(x / cell) + half;
    const cy = Math.floor(y / cell) + half;
    // Off the edge of the level proves nothing — the far-field bound covers it.
    if (cx < 1 || cy < 1 || cx >= span - 1 || cy >= span - 1) return false;
    for (let j = cy - 1; j <= cy + 1; j++) {
      const row = base + j * span;
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (this.#occupancy[row + i] !== 0) return false;
      }
    }
    return true;
  }

  /** Hash of a grid cell. Collisions are harmless: the distance test settles them. */
  #bucket(ix: number, iy: number): number {
    let h = Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    return (h ^ (h >>> 12)) & this.#mask;
  }

  /**
   * Is any particle touching the site (x, y)? The 3×3 block decides: a particle
   * within `CONTACT` of the site is at most one cell away, since a cell is one
   * contact distance across.
   */
  #occupied(x: number, y: number): boolean {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let j = cy - 1; j <= cy + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        for (let k = this.#heads[this.#bucket(i, j)]!; k >= 0; k = this.#nextIn[k]!) {
          const dx = this.xs[k]! - x;
          const dy = this.ys[k]! - y;
          if (dx * dx + dy * dy <= ADJACENT * ADJACENT) return true;
        }
      }
    }
    return false;
  }

  /**
   * Where along the step (px, py) + t·(dx, dy), t ∈ [0, 1], the wanderer first
   * touches a particle; −1 if it never does.
   *
   * Exact tangency, from the smaller root of |p + t·d − q|² = CONTACT². The
   * candidates come from the 3×3 block around the *end* of the step, which is
   * the same test `#occupied` does — a grazing pass that dips inside the
   * contact distance and comes back out is missed, and that is a discretization
   * of the same order as the step length itself.
   */
  #firstContact(px: number, py: number, dx: number, dy: number): number {
    const ex = px + dx;
    const ey = py + dy;
    const cx = Math.floor(ex / CELL);
    const cy = Math.floor(ey / CELL);
    const dd = dx * dx + dy * dy;
    if (dd === 0) return -1;
    let best = -1;
    for (let j = cy - 1; j <= cy + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        for (let k = this.#heads[this.#bucket(i, j)]!; k >= 0; k = this.#nextIn[k]!) {
          const qx = px - this.xs[k]!;
          const qy = py - this.ys[k]!;
          const b = qx * dx + qy * dy;
          const c = qx * qx + qy * qy - CONTACT * CONTACT;
          const disc = b * b - dd * c;
          if (disc < 0) continue;
          const t = (-b - Math.sqrt(disc)) / dd;
          // c ≤ 0 would mean the wanderer started inside, which the previous
          // step ruled out; t > 1 means this particle is met by the next step,
          // not this one.
          if (t < 0 || t > 1) continue;
          if (best < 0 || t < best) best = t;
        }
      }
    }
    return best;
  }

  /**
   * Move (x, y) to the nearest site of the active lattice, leaving the result
   * in `#snapX` / `#snapY`. Two scratch fields rather than a returned pair: this
   * runs on every free flight, and a per-step object would be a per-step
   * allocation in the inner loop of the tab.
   */
  #snap(x: number, y: number): void {
    if (this.#lattice === 'square') {
      this.#snapX = Math.round(x / SITE) * SITE;
      this.#snapY = Math.round(y / SITE) * SITE;
      return;
    }
    // Triangular lattice on the basis (2, 0) and (1, √3), so a site is
    // (2i + j, j√3) in units of half the lattice constant.
    const j = Math.round(y / (SQRT3 * HALF_SITE));
    const i = Math.round((x - j * HALF_SITE) / SITE);
    this.#snapX = i * SITE + j * HALF_SITE;
    this.#snapY = j * SQRT3 * HALF_SITE;
  }

  /** Add a particle at (x, y): arrays, both grids, the moments, and the history. */
  #freeze(x: number, y: number): void {
    const i = this.#count;
    if (i >= this.capacity) return;
    this.xs[i] = x;
    this.ys[i] = y;
    this.#count = i + 1;
    this.#walking = false;

    const b = this.#bucket(Math.floor(x / CELL), Math.floor(y / CELL));
    this.#nextIn[i] = this.#heads[b]!;
    this.#heads[b] = i;

    for (let l = 0; l < PYRAMID.length; l++) {
      const cell = PYRAMID[l]!;
      const half = this.#levelHalf[l]!;
      const span = 2 * half + 1;
      const cx = Math.floor(x / cell) + half;
      const cy = Math.floor(y / cell) + half;
      if (cx < 0 || cy < 0 || cx >= span || cy >= span) {
        // Outside the pyramid the bound would be a lie, so it is switched off.
        this.#pyramidValid = false;
        continue;
      }
      this.#occupancy[this.#levelOffset[l]! + cy * span + cx] = 1;
    }

    this.#sumX += x;
    this.#sumY += y;
    this.#sumSq += x * x + y * y;
    const r = Math.sqrt(x * x + y * y);
    if (r > this.#clusterRadius) this.#clusterRadius = r;

    if (this.#count >= this.#nextCheckpoint && this.#historyCount < HISTORY_MAX) {
      this.historyN[this.#historyCount] = this.#count;
      this.historyRg[this.#historyCount] = this.gyration;
      this.#historyCount++;
      this.#nextCheckpoint = Math.max(this.#count + 1, Math.ceil(this.#count * CHECKPOINT_RATIO));
    }
  }
}

export function createCluster(rng: Rng, opts: ClusterOptions): Cluster {
  return new Cluster(rng, opts);
}
