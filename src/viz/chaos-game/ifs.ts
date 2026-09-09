import type { Rng } from '../../core/types';

/**
 * The chaos game: iterated function systems, the restricted sampler, and the
 * box-counting estimator. Pure, canvas-free, and exercised end to end by
 * tests/chaos-game.test.ts.
 *
 * An IFS is a finite list of contracting affine maps with probabilities.
 * Hutchinson (1981): such a list has exactly one non-empty compact set A with
 * A = ⋃ fᵢ(A), and iterating the maps from *any* starting set converges to it.
 * The chaos game is the Monte Carlo form of that theorem — pick a map at
 * random, apply it, plot the point — and it is why the picture is the same
 * every run from every start. The randomness chooses which part of A gets
 * inked next; it does not choose A.
 *
 * For n similarities of ratio r whose pieces have disjoint interiors (the open
 * set condition), the attractor's Hausdorff and box dimensions are both
 * log n / log(1/r). Under a restriction rule the count n becomes the branching
 * number m of the allowed-transition graph, and the formula becomes
 * log m / log(1/r) — which is the whole content of tab 11's teaching moment:
 * the square at r = ½ has m = 4 and dimension 2, and forbidding an immediate
 * repeat leaves m = 3 and dimension log 3 / log 2, the Sierpiński triangle's.
 *
 * The RNG is consulted exactly once per point, for the map choice, so the point
 * sequence for a seed is identical at every plotting rate and every step size.
 * Only the clock differs. tests/chaos-game.test.ts asserts exactly that.
 */

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/**
 * One affine map of the plane, applied as
 *
 *   (x, y) ↦ (a·x + b·y + e, c·x + d·y + f)
 *
 * `weight` is the probability of choosing it. Weights over a system sum to 1.
 */
export interface AffineMap {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  weight: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Vertex k of a regular n-gon inscribed in the unit circle, y up. */
export function polygonVertex(n: number, k: number): { x: number; y: number } {
  const angle = polygonAngle(n, k);
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/**
 * Odd n gets a vertex at the top, even n a flat edge — the convention every
 * drawn polygon uses, and the reason it matters here is the teaching moment:
 * n = 4 has to read as *the square*, not as a diamond, when it fills solid.
 */
function polygonAngle(n: number, k: number): number {
  const turn = (2 * Math.PI) / n;
  return Math.PI / 2 + (n % 2 === 0 ? turn / 2 : 0) + k * turn;
}

/**
 * `n` equally weighted similarities of ratio `r` toward the vertices of a
 * regular n-gon inscribed in the unit circle:
 *
 *   fᵢ(p) = r·p + (1 − r)·vᵢ
 *
 * so the distance to the chosen vertex is multiplied by `r` and the point moves
 * (1 − r) of the way toward it. `r` is the *similarity ratio*, which is the
 * quantity the dimension formula takes; at r = ½ — the classic halfway jump —
 * the two readings of "a fraction of the way" coincide, and everywhere else it
 * is the ratio that is meant. The pentagon wants r = 1/(1 + 2cos(π/5)),
 * not a jump of 0.382.
 */
export function polygonSystem(n: number, r: number): AffineMap[] {
  const sides = Math.max(3, Math.round(n));
  const weight = 1 / sides;
  const maps: AffineMap[] = [];
  for (let k = 0; k < sides; k++) {
    const v = polygonVertex(sides, k);
    maps.push({ a: r, b: 0, c: 0, d: r, e: (1 - r) * v.x, f: (1 - r) * v.y, weight });
  }
  return maps;
}

/**
 * The largest ratio at which the n pieces of a polygon system still have
 * disjoint interiors, so that the open set condition holds and
 * log n / log(1/r) is exact rather than an upper bound.
 *
 * Two pieces r·P + (1 − r)vᵢ and r·P + (1 − r)vⱼ are separated as soon as their
 * shadows on the line through vᵢ and vⱼ are. Projecting on the unit vector u
 * along that line, the pieces occupy (1 − r)(vᵢ·u) ± r·h and (1 − r)(vⱼ·u) ± r·h
 * with h = maxₖ vₖ·u, so they clear when (1 − r)·|vⱼ − vᵢ| ≥ 2·r·h, that is
 *
 *   r ≤ s / (s + 2h),   s = |vⱼ − vᵢ|
 *
 * and the binding pair is the one minimising it. It reproduces the published
 * flake ratios exactly — ½ for the triangle and the square, 1/(1 + φ) = 0.381966
 * for the pentagon, ⅓ for the hexagon, 1/(2 + √2) for the octagon — which is
 * the check that the criterion is tight and not merely sufficient here.
 */
export function polygonOpenSetRatio(n: number): number {
  const sides = Math.max(3, Math.round(n));
  const vs: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < sides; k++) vs.push(polygonVertex(sides, k));
  let best = 0.5;
  for (let i = 0; i < sides; i++) {
    for (let j = i + 1; j < sides; j++) {
      const vi = vs[i] ?? { x: 0, y: 0 };
      const vj = vs[j] ?? { x: 0, y: 0 };
      const dx = vj.x - vi.x;
      const dy = vj.y - vi.y;
      const s = Math.hypot(dx, dy);
      if (s === 0) continue;
      const ux = dx / s;
      const uy = dy / s;
      let h = 0;
      for (const v of vs) h = Math.max(h, v.x * ux + v.y * uy);
      best = Math.min(best, s / (s + 2 * h));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Named systems
// ---------------------------------------------------------------------------

/** Sierpiński pentagon: 1/(1 + 2cos(π/5)) = 1/(1 + φ) = 0.3819660. */
export const PENTAGON_RATIO = 1 / (1 + 2 * Math.cos(Math.PI / 5));

export interface NamedSystem {
  readonly id: string;
  readonly label: string;
  readonly maps: readonly AffineMap[];
  /** Present when the system is a polygon system, carrying the (n, r) it was built from. */
  readonly polygon?: { readonly n: number; readonly r: number };
  /** Closed-form dimension, where the maps are similarities meeting the open set condition. */
  readonly dimension?: number;
  /** Attractor bounds, where they are known more sharply than `attractorBounds()` finds them. */
  readonly bounds?: Bounds;
}

/**
 * The Barnsley fern, from Fractals Everywhere (1988), Table 3.8.3. The
 * coefficients and the probabilities 0.01 / 0.85 / 0.07 / 0.07 are Barnsley's
 * own; the first map, chosen one time in a hundred, is degenerate — it collapses
 * the whole plane onto a vertical segment — and it is what draws the stem. The
 * probabilities are not free: they are chosen roughly in proportion to the area
 * each map contributes, so that a finite run inks the fern evenly rather than
 * spending most of its points on the two small side fronds.
 *
 * These four maps are affine but not similarities — they shear — so there is no
 * closed-form dimension for the fern, and the tab reports its box count without
 * a target.
 */
const FERN: readonly AffineMap[] = [
  { a: 0, b: 0, c: 0, d: 0.16, e: 0, f: 0, weight: 0.01 },
  { a: 0.85, b: 0.04, c: -0.04, d: 0.85, e: 0, f: 1.6, weight: 0.85 },
  { a: 0.2, b: -0.26, c: 0.23, d: 0.22, e: 0, f: 1.6, weight: 0.07 },
  { a: -0.15, b: 0.28, c: 0.26, d: 0.24, e: 0, f: 0.44, weight: 0.07 },
];

/**
 * The Heighway dragon as a two-map IFS. In the complex plane the maps are
 * f₁(z) = (1 + i)z/2 and f₂(z) = 1 − (1 − i)z/2: each is a rotation by ±45°
 * with a scaling of 1/√2, so the similarity dimension is
 * log 2 / log √2 = 2 exactly. That is not a defect of the estimate — the dragon
 * tiles the plane, has positive area, and is genuinely two-dimensional. The
 * fractal object everyone pictures is its *boundary*, of dimension 1.5236.
 */
const DRAGON: readonly AffineMap[] = [
  { a: 0.5, b: -0.5, c: 0.5, d: 0.5, e: 0, f: 0, weight: 0.5 },
  { a: -0.5, b: -0.5, c: 0.5, d: -0.5, e: 1, f: 0, weight: 0.5 },
];

export const NAMED_SYSTEMS: readonly NamedSystem[] = [
  {
    id: 'sierpinski',
    label: 'Sierpiński triangle',
    maps: polygonSystem(3, 0.5),
    polygon: { n: 3, r: 0.5 },
    dimension: Math.log(3) / Math.log(2),
  },
  {
    id: 'pentagon',
    label: 'Sierpiński pentagon',
    maps: polygonSystem(5, PENTAGON_RATIO),
    polygon: { n: 5, r: PENTAGON_RATIO },
    dimension: Math.log(5) / Math.log(1 / PENTAGON_RATIO),
  },
  {
    id: 'square',
    label: 'Square',
    maps: polygonSystem(4, 0.5),
    polygon: { n: 4, r: 0.5 },
    dimension: 2,
  },
  {
    id: 'fern',
    label: 'Barnsley fern',
    maps: FERN,
    // The fern's own extents. `attractorBounds()` returns [−3.80, 3.84] × [−0.72,
    // 11.68] here — a box 57% too wide — because the second map is a shear, and
    // the corners of a box it is applied to travel further than any point of the
    // attractor does. The stem map pins the bottom at y = 0 exactly.
    bounds: { minX: -2.182, minY: 0, maxX: 2.6558, maxY: 9.9984 },
  },
  {
    id: 'dragon',
    label: 'Heighway dragon',
    maps: DRAGON,
    dimension: 2,
    // The dragon's known bounding box, [−⅓, 7/6] × [−⅓, ⅔]. Growing a box is
    // hopeless here: both maps have |a| + |b| = |c| + |d| = 1, so the box
    // iteration is not a contraction at all and runs away — 80 units wide after
    // 200 rounds — even though the attractor itself is a unit and a half across.
    bounds: { minX: -1 / 3, minY: -1 / 3, maxX: 7 / 6, maxY: 2 / 3 },
  },
];

export function findSystem(id: string): NamedSystem | undefined {
  return NAMED_SYSTEMS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Dimension
// ---------------------------------------------------------------------------

/**
 * log n / log(1/r): the dimension of an attractor made of `n` copies of itself
 * at ratio `r`, exact when the open set condition holds.
 *
 * n = 3, r = ½ gives 1.5849625; n = 5, r = 0.381966 gives 1.6723; n = 4, r = ½
 * gives exactly 2, which is why the square fills solid — four half-squares tile
 * a square with nothing left over.
 *
 * Above the open-set ratio the pieces overlap, the formula overcounts, and the
 * true dimension is capped at 2 for a set in the plane; the caller decides
 * whether to publish it as a target (see `polygonOpenSetRatio`).
 */
export function similarityDimension(n: number, r: number): number {
  if (!(r > 0) || r >= 1 || n <= 0) return NaN;
  return Math.log(n) / Math.log(1 / r);
}

export const RESTRICTIONS = ['none', 'no-repeat', 'not-neighbour', 'not-opposite'] as const;

export type Restriction = (typeof RESTRICTIONS)[number];

/**
 * Whether a step of cyclic distance `d` — the number of vertices between the
 * previous choice and the next one, folded into 0…⌊n/2⌋ — is allowed.
 *
 * The rules are stated in that distance rather than in vertex indices so they
 * mean the same thing at every n: 0 is choosing the same vertex again, 1 is one
 * of its two neighbours, ⌊n/2⌋ is the one across the polygon.
 */
function distanceAllowed(n: number, restriction: Restriction, d: number): boolean {
  switch (restriction) {
    case 'none':
      return true;
    case 'no-repeat':
      return d !== 0;
    case 'not-neighbour':
      return d !== 1;
    case 'not-opposite':
      return d !== Math.floor(n / 2);
  }
}

/** Cyclic distance between two vertices of an n-gon, folded into 0…⌊n/2⌋. */
function cyclicDistance(n: number, i: number, j: number): number {
  const d = Math.abs(i - j) % n;
  return Math.min(d, n - d);
}

/**
 * How many of the `n` vertices a step may choose from under `restriction`.
 *
 * This is the branching number of the allowed-transition graph, and because
 * every rule here is stated in cyclic distance the matrix is circulant: every
 * row has the same number of ones, so its spectral radius is exactly that row
 * sum. No eigenvalue solver is needed, and the graph-directed dimension formula
 * (Mauldin–Williams 1988) collapses to log m / log(1/r).
 */
export function branching(n: number, restriction: Restriction): number {
  const sides = Math.max(1, Math.round(n));
  let m = 0;
  for (let j = 0; j < sides; j++) {
    if (distanceAllowed(sides, restriction, cyclicDistance(sides, 0, j))) m++;
  }
  return m;
}

/**
 * The dimension the restricted chaos game on an n-gon converges to:
 * log m / log(1/r) for the branching number m of the restriction.
 *
 * `none` gives m = n and the plain similarity dimension. `no-repeat` on the
 * square gives m = 3 and log 3 / log 2 = 1.585 — the Sierpiński triangle's
 * dimension, out of a rule and not out of the randomness. m = 1 leaves a single
 * orbit and dimension 0, which the formula already returns.
 */
export function restrictedDimension(n: number, r: number, restriction: Restriction): number {
  return similarityDimension(branching(n, restriction), r);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function boundsOf(points: ReadonlyArray<{ x: number; y: number }>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Fixed point of an affine map, i.e. the solution of (I − A)p = t. */
export function fixedPoint(m: AffineMap): { x: number; y: number } {
  const det = (1 - m.a) * (1 - m.d) - m.b * m.c;
  // A map with an eigenvalue of exactly 1 is not a contraction and has no
  // isolated fixed point; the origin is as good a seed as any for the iteration
  // below, which only needs a starting box.
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
  return {
    x: ((1 - m.d) * m.e + m.b * m.f) / det,
    y: (m.c * m.e + (1 - m.a) * m.f) / det,
  };
}

/**
 * A bounding box of the attractor, found by growing one.
 *
 * Every map's fixed point lies on the attractor, so the box around them lies
 * inside bbox(A). Applying B ↦ bbox(B ∪ ⋃ fᵢ(B)) grows it monotonically toward
 * bbox(A), geometrically at the systems' contraction ratio, and stops as soon
 * as a round adds nothing.
 *
 * For a polygon system the answer is exact after the first round: the vertices
 * are the fixed points, the attractor is contained in their convex hull because
 * each fᵢ maps the hull into itself, and it contains every vertex — so
 * bbox(A) is the polygon's own bounding box and the iteration is already
 * stationary there.
 *
 * In general it is only an outer bound, and a loose one where a map shears or
 * rotates: the operator's gain is maxᵢ(|aᵢ| + |bᵢ|), which is 1 for the dragon,
 * so the box there does not converge at all. Systems whose extents matter and
 * whose maps are not similarities toward their own fixed points therefore carry
 * their bounds explicitly — see `NAMED_SYSTEMS`.
 */
export function attractorBounds(maps: readonly AffineMap[], iterations = 200): Bounds {
  if (maps.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let box = boundsOf(maps.map(fixedPoint));
  for (let k = 0; k < iterations; k++) {
    let { minX, minY, maxX, maxY } = box;
    for (const m of maps) {
      // Image of an axis-aligned box under an affine map, taken coordinate by
      // coordinate: the extremes of a·x + b·y over a box are reached at corners.
      const ax = [m.a * box.minX, m.a * box.maxX];
      const by = [m.b * box.minY, m.b * box.maxY];
      const cx = [m.c * box.minX, m.c * box.maxX];
      const dy = [m.d * box.minY, m.d * box.maxY];
      minX = Math.min(minX, m.e + Math.min(...ax) + Math.min(...by));
      maxX = Math.max(maxX, m.e + Math.max(...ax) + Math.max(...by));
      minY = Math.min(minY, m.f + Math.min(...cx) + Math.min(...dy));
      maxY = Math.max(maxY, m.f + Math.max(...cx) + Math.max(...dy));
    }
    const span = Math.max(maxX - minX, maxY - minY, 1e-12);
    const grew =
      Math.max(
        box.minX - minX,
        maxX - box.maxX,
        box.minY - minY,
        maxY - box.maxY,
      ) > 1e-9 * span;
    box = { minX, minY, maxX, maxY };
    if (!grew) break;
  }
  return box;
}

/**
 * The square the occupancy grid covers: the attractor's bounding box widened to
 * a square and padded.
 *
 * Square cells, because a box count is only a box count if the boxes are boxes;
 * padded, because the extreme points of an attractor sit exactly on its bounding
 * box and would otherwise index one cell past the end.
 */
export interface GridSquare {
  x0: number;
  y0: number;
  span: number;
}

export function gridSquare(bounds: Bounds, pad = 0.02): GridSquare {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const span = Math.max(w, h, 1e-9) * (1 + pad);
  return {
    x0: (bounds.minX + bounds.maxX) / 2 - span / 2,
    y0: (bounds.minY + bounds.maxY) / 2 - span / 2,
    span,
  };
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/** Finest occupancy level: 2¹⁰ × 2¹⁰ cells. See `Occupancy`. */
export const GRID_LEVEL = 10;

/** Dyadic levels the dimension is regressed over: 16 divisions up to 256. */
export const BOX_MIN_LEVEL = 4;
export const BOX_MAX_LEVEL = 8;

/**
 * A pyramid of occupancy bitsets over the grid square: level j divides it into
 * 2ʲ × 2ʲ cells, and `count(j)` is N(ε) at ε = 2⁻ʲ.
 *
 * One Uint32Array holds every level, one bit per cell — 43,693 words, 175 KB
 * for eleven levels — and the counts are maintained as points arrive rather
 * than recomputed. A point that lands in a cell already occupied at the finest
 * level costs one load and one test, because a set cell implies every ancestor
 * is set too, so `mark` stops at the first level that already holds it. Box
 * counting is then free: the readout reads eleven counters, not a million cells.
 *
 * This is also the picture's only memory. Two million points as coordinates
 * would be 16 MB of Float32 that is never read back; the grid is 175 KB, it is
 * what the box count needs anyway, and it is fine enough — 1,024 cells across a
 * plate that is at most about 1,000 CSS px — to repaint the accumulated
 * attractor pixel for pixel after a resize.
 */
export class Occupancy {
  readonly level: number;
  /** Cells across the finest level. */
  readonly size: number;
  private readonly words: Uint32Array;
  private readonly base: Int32Array;
  private readonly counts: Uint32Array;

  constructor(level = GRID_LEVEL) {
    this.level = Math.max(0, Math.min(15, Math.floor(level)));
    this.size = 1 << this.level;
    this.base = new Int32Array(this.level + 1);
    let total = 0;
    for (let j = 0; j <= this.level; j++) {
      this.base[j] = total;
      total += Math.max(1, (1 << (2 * j)) >>> 5);
    }
    this.words = new Uint32Array(total);
    this.counts = new Uint32Array(this.level + 1);
  }

  /** Occupied cells at level `j`, i.e. N(2⁻ʲ). */
  count(j: number): number {
    return this.counts[j] ?? 0;
  }

  /** Mark the finest-level cell (cx, cy) and every cell above it. Out-of-range points are ignored. */
  mark(cx: number, cy: number): void {
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return;
    for (let j = this.level; j >= 0; j--) {
      const shift = this.level - j;
      const index = ((cy >>> shift) << j) + (cx >>> shift);
      const w = (this.base[j] ?? 0) + (index >>> 5);
      const bit = 1 << (index & 31);
      // A set cell implies its parent is set, so the first hit ends the walk.
      if (((this.words[w] ?? 0) & bit) !== 0) return;
      this.words[w] = (this.words[w] ?? 0) | bit;
      this.counts[j] = (this.counts[j] ?? 0) + 1;
    }
  }

  /** Whether the finest-level cell (cx, cy) has ever been marked. */
  has(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return false;
    const index = (cy << this.level) + cx;
    const w = (this.base[this.level] ?? 0) + (index >>> 5);
    return (((this.words[w] ?? 0) >>> (index & 31)) & 1) === 1;
  }

  /**
   * Visit every occupied finest-level cell, row by row.
   *
   * Zero words are skipped whole, which is most of them: a fractal leaves the
   * grid sparse by definition, and this is the resize repaint's inner loop.
   */
  forEachCell(cb: (cx: number, cy: number, index: number) => void): void {
    const from = this.base[this.level] ?? 0;
    const to = from + Math.max(1, (1 << (2 * this.level)) >>> 5);
    const mask = this.size - 1;
    for (let w = from; w < to; w++) {
      let bits = this.words[w] ?? 0;
      if (bits === 0) continue;
      const origin = (w - from) << 5;
      while (bits !== 0) {
        // Lowest set bit first: Math.clz32 of the isolated bit gives its index.
        const lowest = bits & -bits;
        const b = 31 - Math.clz32(lowest);
        const index = origin + b;
        cb(index & mask, index >>> this.level, index);
        bits ^= lowest;
      }
    }
  }

  clear(): void {
    this.words.fill(0);
    this.counts.fill(0);
  }
}

/**
 * Box-counting dimension: the slope of log N(ε) against log(1/ε), by least
 * squares over the dyadic levels `minLevel…maxLevel`.
 *
 * The scales are stated rather than chosen per run. Below level 4 there are too
 * few boxes for the count to mean anything; above level 8 a finite sample stops
 * finding every box the attractor touches, and the missing boxes bias the slope
 * down. At 10⁶ points the finest level here holds about 150 points per occupied
 * box for the Sierpiński triangle, so the sampling error is nil and what is
 * left is the discretisation bias of an unaligned grid — a bounded oscillation
 * in log N that the five-point regression damps to a few hundredths.
 *
 * NaN before two levels have anything in them.
 */
export function boxCountingDimension(
  grid: Occupancy,
  minLevel = BOX_MIN_LEVEL,
  maxLevel = BOX_MAX_LEVEL,
): number {
  const hi = Math.min(maxLevel, grid.level);
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let j = minLevel; j <= hi; j++) {
    const c = grid.count(j);
    if (c === 0) continue;
    n++;
    sx += j;
    sy += Math.log(c);
  }
  if (n < 2) return NaN;
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (let j = minLevel; j <= hi; j++) {
    const c = grid.count(j);
    if (c === 0) continue;
    const dx = j - mx;
    sxy += dx * (Math.log(c) - my);
    sxx += dx * dx;
  }
  if (sxx === 0) return NaN;
  // x is the level j; log(1/ε) = j·log 2, so the slope in j is D·log 2.
  return sxy / sxx / Math.LN2;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

/**
 * Points discarded before the first plotted one.
 *
 * The attractor is independent of the starting point, so the first few points
 * are not wrong, they are simply not on it yet: after k steps the distance to
 * the attractor is at most rᵏ times the starting distance, which at r = ½ is
 * under a millionth of the figure's diameter by the twentieth step. Plotting
 * them would leave a short comet tail of points that belong to no picture.
 */
export const BURN_IN = 20;

/** Maps any system here can hold: eight vertices is the polygon ceiling. */
export const MAX_MAPS = 8;

/** Points kept for the live cursor. Everything older lives in the occupancy grid. */
const DEFAULT_RECENT = 1 << 15;

export interface SystemOptions {
  restriction?: Restriction;
  /** Attractor bounds, when they are known better than `attractorBounds()` finds them. */
  bounds?: Bounds;
}

export interface ChaosGameOptions extends SystemOptions {
  /** Points discarded before plotting starts. Defaults to `BURN_IN`. */
  burnIn?: number;
  /** Starting point. Defaults to the origin — any point does, which is the lesson. */
  start?: { x: number; y: number };
  /** Recent points held for the live cursor. */
  recent?: number;
  /** Finest occupancy level. Defaults to `GRID_LEVEL`. */
  level?: number;
}

export interface ChaosGame {
  /** Plot `n` more points. Exactly one rng draw each. */
  step(n: number): void;
  /**
   * Point the game at another system, reusing every buffer. Implies `reset()`.
   * Does not reseed the RNG; the caller owns it.
   */
  setSystem(maps: readonly AffineMap[], opts?: SystemOptions): void;
  readonly maps: readonly AffineMap[];
  /** Points plotted since the last reset, burn-in excluded. */
  readonly plotted: number;
  /** The current point, and the map that produced it. */
  readonly x: number;
  readonly y: number;
  readonly vertex: number;
  /** The rule actually in force: `none` whenever the requested one leaves no vertex or the weights differ. */
  readonly restriction: Restriction;
  readonly grid: Occupancy;
  readonly square: GridSquare;
  readonly bounds: Bounds;
  /** Chronological index of the oldest point still held for the cursor. */
  readonly oldestRecent: number;
  /** Visit held points with chronological index ≥ `from`, oldest first. */
  forEachRecent(
    from: number,
    cb: (x: number, y: number, vertex: number, index: number) => void,
  ): void;
  /** Clear the picture and return to the start. Does not reseed the RNG; the caller owns it. */
  reset(): void;
}

/**
 * A running chaos game over `maps`.
 *
 * Every buffer is allocated here at the ceiling and reused: `setSystem()`
 * re-points the game at a different attractor without allocating, because
 * dragging the ratio slider is one parameter change per pointer event and a
 * fresh 175 KB grid for each of them is half a megabyte of garbage per drag.
 */
export function createChaosGame(
  rng: Rng,
  maps: readonly AffineMap[],
  opts: ChaosGameOptions = {},
): ChaosGame {
  // Coefficients flat, so the inner loop reads six numbers out of six typed
  // arrays instead of chasing n object pointers per point.
  const ma = new Float64Array(MAX_MAPS);
  const mb = new Float64Array(MAX_MAPS);
  const mc = new Float64Array(MAX_MAPS);
  const md = new Float64Array(MAX_MAPS);
  const me = new Float64Array(MAX_MAPS);
  const mf = new Float64Array(MAX_MAPS);
  const cumulative = new Float64Array(MAX_MAPS);
  // The allowed successors of each vertex, as a table rather than a rejection
  // loop: one draw per point whatever the rule, so the point sequence for a
  // seed does not depend on how often the rule says no.
  const allowed = new Uint8Array(MAX_MAPS * MAX_MAPS);
  const allowedCount = new Uint8Array(MAX_MAPS);

  const grid = new Occupancy(opts.level ?? GRID_LEVEL);

  const capacity = Math.max(1, Math.floor(opts.recent ?? DEFAULT_RECENT));
  const recentX = new Float32Array(capacity);
  const recentY = new Float32Array(capacity);
  const recentV = new Uint8Array(capacity);

  const burnIn = Math.max(0, Math.floor(opts.burnIn ?? BURN_IN));
  const startX = opts.start?.x ?? 0;
  const startY = opts.start?.y ?? 0;

  let system: readonly AffineMap[] = [];
  let n = 0;
  let restriction: Restriction = 'none';
  let bounds: Bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let square: GridSquare = { x0: 0, y0: 0, span: 1 };
  let cellScale = 1;

  let x = startX;
  let y = startY;
  let vertex = 0;
  let plotted = 0;

  /** One draw. Under a restriction the draw indexes the allowed set directly. */
  function pick(): number {
    const u = rng.next();
    if (restriction !== 'none') {
      const m = allowedCount[vertex] ?? n;
      return allowed[vertex * n + Math.min(m - 1, (u * m) | 0)] ?? 0;
    }
    for (let i = 0; i < n; i++) if (u < (cumulative[i] ?? 1)) return i;
    return n - 1;
  }

  function advance(): void {
    const i = pick();
    const nx = (ma[i] ?? 0) * x + (mb[i] ?? 0) * y + (me[i] ?? 0);
    const ny = (mc[i] ?? 0) * x + (md[i] ?? 0) * y + (mf[i] ?? 0);
    x = nx;
    y = ny;
    vertex = i;
  }

  function reset(): void {
    x = startX;
    y = startY;
    // Vertex 0 for the first restricted draw. Which vertex the rule is measured
    // against for one step out of a million, before the burn-in, is not a
    // property anything can see.
    vertex = 0;
    plotted = 0;
    grid.clear();
    for (let k = 0; k < burnIn; k++) advance();
  }

  function setSystem(next: readonly AffineMap[], options: SystemOptions = {}): void {
    system = next.slice(0, MAX_MAPS);
    n = system.length;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const m = system[i] ?? { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, weight: 0 };
      ma[i] = m.a;
      mb[i] = m.b;
      mc[i] = m.c;
      md[i] = m.d;
      me[i] = m.e;
      mf[i] = m.f;
      acc += m.weight;
      cumulative[i] = acc;
    }
    // Normalise, so a system whose weights are given to two decimals still lands
    // on exactly 1 at the top and no draw can fall off the end of the table.
    if (acc > 0) for (let i = 0; i < n; i++) cumulative[i] = (cumulative[i] ?? 0) / acc;

    const requested = options.restriction ?? 'none';
    const equalWeights =
      n > 0 && system.every((m) => Math.abs(m.weight - (system[0]?.weight ?? 0)) < 1e-12);
    restriction = 'none';
    if (requested !== 'none' && equalWeights) {
      let usable = true;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = 0; j < n; j++) {
          if (distanceAllowed(n, requested, cyclicDistance(n, i, j))) allowed[i * n + m++] = j;
        }
        allowedCount[i] = m;
        if (m === 0) usable = false;
      }
      // A rule that leaves no vertex at all is no rule rather than a stuck
      // point, and one over unequal weights would silently discard the
      // probabilities the fern's stem depends on — so both fall back to `none`.
      if (usable) restriction = requested;
    }

    bounds = options.bounds ?? attractorBounds(system);
    square = gridSquare(bounds);
    cellScale = grid.size / square.span;
    reset();
  }

  setSystem(maps, opts);

  return {
    step(count) {
      const total = Math.max(0, Math.floor(count));
      for (let k = 0; k < total; k++) {
        advance();
        const slot = plotted % capacity;
        recentX[slot] = x;
        recentY[slot] = y;
        recentV[slot] = vertex;
        plotted++;
        grid.mark(((x - square.x0) * cellScale) | 0, ((y - square.y0) * cellScale) | 0);
      }
    },

    setSystem,
    grid,

    get maps() {
      return system;
    },
    get square() {
      return square;
    },
    get bounds() {
      return bounds;
    },
    get plotted() {
      return plotted;
    },
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get vertex() {
      return vertex;
    },
    get restriction() {
      return restriction;
    },
    get oldestRecent() {
      return Math.max(0, plotted - capacity);
    },

    forEachRecent(from, cb) {
      const first = Math.max(Math.floor(from), 0, plotted - capacity);
      for (let i = first; i < plotted; i++) {
        const slot = i % capacity;
        cb(recentX[slot] ?? 0, recentY[slot] ?? 0, recentV[slot] ?? 0, i);
      }
    },

    reset,
  };
}
