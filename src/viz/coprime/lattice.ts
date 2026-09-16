import type { Rng } from '../../core/types';

/**
 * Visible lattice points: the mathematics, with no canvas in sight.
 *
 * Stand at the origin of a square lattice with a tree at every point (x, y),
 * x, y ≥ 1. The tree at (x, y) is hidden behind a nearer one exactly when the
 * segment from the origin to it passes through another lattice point, and the
 * lattice points on that segment are (k·x/g, k·y/g) for g = gcd(x, y) and
 * k = 1…g. So there is a nearer tree in the way exactly when g > 1, and the
 * tree doing the hiding is always (x/g, y/g) — the nearest point on the ray.
 *
 * The share of trees still in view is therefore P(gcd(x, y) = 1). Sieve on the
 * primes: a prime p divides both coordinates with probability 1/p², and
 * divisibility by distinct primes is independent, so
 *
 *   P = ∏ₚ (1 − 1/p²) = 1 / ∏ₚ (1 − 1/p²)⁻¹ = 1/ζ(2) = 6/π² = 0.6079271…
 *
 * using Euler's product for ζ and his 1735 answer to the Basel problem,
 * ζ(2) = π²/6. Inverting it, π = √(6/P): a road to π along which nothing in
 * the picture is round.
 */

/** 1/ζ(2) = 6/π². The share of lattice points in view from the origin. */
export const VISIBLE_FRACTION = 6 / (Math.PI * Math.PI);

/**
 * Euclid's algorithm, on positive integers only — every caller here draws its
 * arguments from [1, side], so the gcd(0, n) = n case cannot arise.
 */
export function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** A tree is in view exactly when its coordinates share no factor above 1. */
export function isVisible(x: number, y: number): boolean {
  return gcd(x, y) === 1;
}

/**
 * Recover π from an observed visible share: P = 6/π², so π = √(6/P).
 *
 * Infinite before the first visible tree — no share, no information about π —
 * rather than a division that quietly returns Infinity for a share of zero and
 * NaN for the 0/0 of an empty run. Both are reported as "not measured yet".
 */
export function piFromFraction(share: number): number {
  return Math.sqrt(6 / share);
}

/**
 * sd(p̂) for a share of N independent checks, as a coefficient over √N.
 *
 * p̂ is a proportion, so Var(p̂) = P(1 − P)/N and sd(p̂) = √(P(1 − P))/√N with
 * P = 6/π²: the coefficient is √(0.60793 × 0.39207) = 0.48821.
 */
export const FRACTION_SE_COEFFICIENT = Math.sqrt(VISIBLE_FRACTION * (1 - VISIBLE_FRACTION));

/**
 * |dπ/dp| at p = 6/π², which is exactly π³/12 = 2.58386.
 *
 * π(p) = √6·p^(−1/2), so dπ/dp = −½√6·p^(−3/2), and at p = 6/π² the power is
 * (π²/6)^(3/2) = π³/6^(3/2), leaving ½√6·π³/6^(3/2) = π³/12. An error in the
 * share is magnified two and a half times on its way into π.
 */
export const PI_SENSITIVITY = Math.PI ** 3 / 12;

/**
 * sd(π̂) as a coefficient over √N, by the delta method: |dπ/dp|·sd(p̂) =
 * 2.58386 × 0.48821 = 1.26147. So 0.0126 at ten thousand checks, 0.00399 at a
 * hundred thousand, 0.00126 at a million — the same √N bargain every estimator
 * in this app pays, and the reason the tab caps the run where it does rather
 * than pretending another decimal is around the corner.
 */
export const PI_SE_COEFFICIENT = PI_SENSITIVITY * FRACTION_SE_COEFFICIENT;

/** sd of the sampled share after `checks` independent checks. */
export function fractionStandardError(checks: number): number {
  return FRACTION_SE_COEFFICIENT / Math.sqrt(checks);
}

/** sd of the π recovered from `checks` independent checks. */
export function piStandardError(checks: number): number {
  return PI_SE_COEFFICIENT / Math.sqrt(checks);
}

/**
 * How far the visible share of a finite `side` × `side` corner can sit from
 * 6/π². This is a bias, not noise: the corner is counted exactly.
 *
 * Counting by the coordinate that is larger, the visible points of [1, n]²
 * number 2·Φ(n) − 1 with Φ(n) = Σ_{k≤n} φ(k), and Mertens' estimate gives
 * Φ(n) = 3n²/π² + O(n log n). Dividing by n², the share is 6/π² + O(log n / n).
 *
 * The constant here is measured rather than quoted: over every side the tab
 * offers, max |share(n) − 6/π²|·n/log n is 0.368, at n = 13. COEFFICIENT is
 * 0.5, which clears that worst case by 36% and is stated once here so the
 * convergence test can assert against a bound derived from the theorem instead
 * of from the answer.
 *
 * It is also why a small orchard reads honestly short of 6/π² on the page: at
 * twelve a side the exact share is 0.6319, which is 4% high and no amount of
 * checking will move it.
 */
export const BIAS_COEFFICIENT = 0.5;

export function orchardBias(side: number): number {
  const n = Math.max(2, side);
  return (BIAS_COEFFICIENT * Math.log(n)) / n;
}

/**
 * The trees of [1, side]², with the exact count of the ones in view.
 *
 * The mask is allocated once at the largest side the tab offers and refilled
 * in place whenever the side changes, so no slider position allocates. It
 * carries two things at once: the painter's per-tree colour, and the exact
 * count that the tab reports as a measurement independent of the random
 * checks. Both come out of the same single pass of gcds — 10,000 of them at
 * the ceiling, which is a fraction of a millisecond and happens only on a
 * parameter change or a resize.
 */
export class Orchard {
  readonly maxSide: number;

  private readonly mask: Uint8Array;
  private currentSide = 0;
  private lit = 0;

  constructor(maxSide: number) {
    this.maxSide = Math.max(1, Math.floor(maxSide));
    this.mask = new Uint8Array(this.maxSide * this.maxSide);
  }

  /** Trees along each side, clamped to what the mask was allocated for. */
  get side(): number {
    return this.currentSide;
  }

  get trees(): number {
    return this.currentSide * this.currentSide;
  }

  /** Trees with no nearer tree in the way. */
  get visible(): number {
    return this.lit;
  }

  /** The exactly counted share. NaN before a side is set. */
  get fraction(): number {
    return this.lit / this.trees;
  }

  /** Rebuild for a new side. Idempotent, so a resize may call it freely. */
  setSide(side: number): void {
    const n = Math.max(1, Math.min(this.maxSide, Math.round(side)));
    if (n === this.currentSide) return;
    this.currentSide = n;
    let lit = 0;
    // Row stride is the current side, so the mask is re-laid-out on every
    // change rather than kept at the ceiling's stride: the painter walks it
    // contiguously and never multiplies by a stride the side does not have.
    for (let y = 1; y <= n; y++) {
      const row = (y - 1) * n;
      for (let x = 1; x <= n; x++) {
        const visible = gcd(x, y) === 1;
        this.mask[row + x - 1] = visible ? 1 : 0;
        if (visible) lit++;
      }
    }
    this.lit = lit;
  }

  /** Whether the tree at (x, y), both 1-based, is in view. */
  visibleAt(x: number, y: number): boolean {
    if (x < 1 || y < 1 || x > this.currentSide || y > this.currentSide) return false;
    return this.mask[(y - 1) * this.currentSide + x - 1] === 1;
  }
}

/** One checked tree: where it is, and the factor its coordinates share. */
export interface Check {
  x: number;
  y: number;
  /** gcd(x, y). 1 when the tree is in view; the tree in the way is (x/g, y/g). */
  divisor: number;
}

/**
 * Pick one tree at random from [1, side]².
 *
 * Exactly two draws from `rng`, always x then y, so a seed reproduces the
 * sequence of checked trees whatever the clock, the plate size or the pacing
 * does — which is what lets a permalink replay a run on someone else's window
 * and what makes the convergence test an assertion rather than a hope.
 */
export function drawPair(rng: Rng, side: number): Check {
  const x = rng.int(1, side);
  const y = rng.int(1, side);
  return { x, y, divisor: gcd(x, y) };
}

/**
 * The sight lines still on the plate, plus the statistics of every tree ever
 * checked.
 *
 * A ring buffer over typed arrays allocated once at the budget. `checks` and
 * `visible` are counters rather than the buffer length: they keep going after
 * the ring wraps, because the estimate must use every check and not just the
 * handful still painted.
 *
 * `record` takes a `keep` flag rather than deciding for itself. What is
 * painted and what is counted are two different budgets here — a run checks
 * four thousand trees a second and the plate can hold about twenty sight lines
 * — so the caller keeps only the throws it wants drawn, and the counters take
 * all of them either way.
 */
export class CheckLog {
  readonly capacity: number;

  // Uint16 holds a coordinate and a divisor for any side this tab offers
  // (100), with three orders of magnitude to spare.
  private readonly xs: Uint16Array;
  private readonly ys: Uint16Array;
  private readonly divisors: Uint16Array;

  /** Slot the next kept check writes to. */
  private head = 0;
  /** Live entries, ≤ capacity. */
  private stored = 0;
  private total = 0;
  private lit = 0;

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.xs = new Uint16Array(this.capacity);
    this.ys = new Uint16Array(this.capacity);
    this.divisors = new Uint16Array(this.capacity);
  }

  /** Sight lines currently held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Every tree checked since the last reset, painted or not. */
  get checks(): number {
    return this.total;
  }

  /** Every checked tree that was in view. */
  get visible(): number {
    return this.lit;
  }

  /** The running share. NaN before the first check. */
  get fraction(): number {
    return this.lit / this.total;
  }

  record(check: Check, keep: boolean): void {
    this.total++;
    if (check.divisor === 1) this.lit++;
    if (!keep) return;
    const i = this.head;
    this.xs[i] = check.x;
    this.ys[i] = check.y;
    this.divisors[i] = check.divisor;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
  }

  /**
   * Visit the held sight lines oldest first, so a painter following this order
   * lands the newest on top. `from` skips the first `from` of them, so a
   * painter with an ink budget drops the oldest — the right end to drop, since
   * a checked tree's information is already in the counters.
   */
  forEach(cb: (x: number, y: number, divisor: number, index: number) => void, from = 0): void {
    // Until the ring wraps the oldest entry is slot 0; afterwards it is the
    // slot `head` is about to overwrite.
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = Math.max(0, from); i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.xs[slot] ?? 0, this.ys[slot] ?? 0, this.divisors[slot] ?? 1, i);
    }
  }

  /** Forget every sight line and zero the counters. Nothing reallocates. */
  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.total = 0;
    this.lit = 0;
  }
}
