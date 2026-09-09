import type { Rng } from '../../core/types';

/**
 * Monte Carlo π: the mathematics, with no canvas in sight.
 *
 * The square [−1, 1]² has area 4; the circle inscribed in it has area π. A dart
 * thrown uniformly at the square therefore lands inside the circle with
 * probability
 *
 *   p = π/4 = 0.785398…
 *
 * so every dart is one Bernoulli(p) trial and 4·p̂ = 4·inside/N estimates π.
 * Two counters — darts thrown and darts inside — are the whole experiment;
 * everything the tab shows is a function of them.
 */

/** P(a dart lands inside the inscribed circle) = π/4. */
export const P_INSIDE = Math.PI / 4;

/**
 * The coefficient in the estimator's standard error, 4·√(p(1−p)) = 1.642183…
 *
 * p̂ = inside/n is binomial with Var(p̂) = p(1−p)/n, and the estimator is
 * exactly 4·p̂ — a constant multiple, so no delta method is needed:
 *
 *   SE(π̂) = 4·√(p(1−p)/n) = 1.642183…/√n
 *
 * Computed rather than written down, because a literal 1.64218 is a number
 * nobody can check against the line above it.
 */
export const PI_SE_COEFFICIENT = 4 * Math.sqrt(P_INSIDE * (1 - P_INSIDE));

/**
 * Standard error of the π estimate after `n` darts: 1.642183/√n.
 *
 * 0.051930 at n = 10³, 0.016422 at 10⁴, 0.0051930 at 10⁵, 0.0016422 at 10⁶ —
 * a hundred times the darts for one more decimal place. That is the honest
 * reason nobody computes π this way, and it is the curve the tab draws.
 * Infinite for n ≤ 0: no trials, no information.
 */
export function piStandardError(n: number): number {
  return n > 0 ? PI_SE_COEFFICIENT / Math.sqrt(n) : Infinity;
}

/** One dart, in the units the circle is defined in rather than in pixels. */
export interface Dart {
  /** Uniform in [−1, 1). */
  x: number;
  /** Uniform in [−1, 1). */
  y: number;
  /** x² + y² ≤ 1 — inside the inscribed unit circle, or on it. */
  inside: boolean;
}

/**
 * One throw. Two draws from `rng`, always in the same order — x, then y — so a
 * seed reproduces the dart sequence exactly.
 *
 * No plate size is consulted: the dart is already in the coordinates the circle
 * lives in, and the painter scales it by whatever plate is in front of it. So
 * the counters for a seed are identical at every dart rate and every canvas
 * size, which is what lets a permalink reproduce a run on someone else's
 * window and what makes a mid-run resize a re-placement rather than a fork.
 */
export function throwDart(rng: Rng): Dart {
  const x = rng.range(-1, 1);
  const y = rng.range(-1, 1);
  return { x, y, inside: x * x + y * y <= 1 };
}

/**
 * π̂ = 4·inside/total. NaN before the first dart rather than 0, which is a
 * reading the ledger would print as if it meant something.
 */
export function estimatePi(inside: number, total: number): number {
  if (!(total > 0)) return NaN;
  return (4 * inside) / total;
}

/**
 * The darts on screen, plus the statistics of every dart ever thrown.
 *
 * A ring buffer over typed arrays allocated once at the budget: after
 * `capacity` darts the oldest is overwritten, so the painted field never grows
 * past the budget however long the tab runs. `darts` and `inside` are counters,
 * not the buffer length — a two-million-dart run keeps counting long after the
 * three-thousandth dart overwrote the first, because the estimate must use
 * every dart while only a bounded number are painted.
 */
export class DartField {
  readonly capacity: number;

  /** Positions in circle coordinates, so a resize re-places rather than strands them. */
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  /**
   * The inside flag as decided at throw time, in full double precision, rather
   * than recomputed from the stored pair: a dart within a Float32 ulp of the
   * boundary would otherwise be painted in a colour the counters disagree with.
   */
  private readonly insideFlags: Uint8Array;

  /** Slot the next push writes to. */
  private head = 0;
  /** Live entries, ≤ capacity. */
  private stored = 0;
  private total = 0;
  private hits = 0;

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);
    this.insideFlags = new Uint8Array(this.capacity);
  }

  /** Darts currently held for painting, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Every dart ever thrown since the last reset, including overwritten ones. */
  get darts(): number {
    return this.total;
  }

  /** Every dart that landed inside the circle since the last reset. */
  get inside(): number {
    return this.hits;
  }

  push(d: Dart): void {
    const i = this.head;
    this.xs[i] = d.x;
    this.ys[i] = d.y;
    this.insideFlags[i] = d.inside ? 1 : 0;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
    this.total++;
    if (d.inside) this.hits++;
  }

  /**
   * Visit the held darts oldest first, so a painter that follows this order
   * lands the newest dart on top. `index` is the chronological position among
   * the held darts, 0 for the oldest; `from` skips the first `from` of them, so
   * a painter on an ink budget drops the oldest — the right end to drop, since
   * a dart's information is already in the counters.
   */
  forEach(cb: (x: number, y: number, inside: boolean, index: number) => void, from = 0): void {
    // Until the buffer wraps the oldest entry is slot 0; afterwards it is the
    // slot `head` is about to overwrite.
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = Math.max(0, from); i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.xs[slot] ?? 0, this.ys[slot] ?? 0, this.insideFlags[slot] === 1, i);
    }
  }

  /** Forget every dart and zero the counters. The arrays are kept; nothing reallocates. */
  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.total = 0;
    this.hits = 0;
  }
}

/** Samples per decade of `n` kept in the error history. */
const SAMPLES_PER_DECADE = 48;

/**
 * Slots in the error history: eight decades of `n`.
 *
 * The convergence plot is log-log, so its points are wanted at equal *ratios*
 * of `n`, not at equal counts — 48 per decade is about a pixel apart on a
 * 300 px axis and far finer than the plotted line width. The darts fader stops
 * at 2·10⁶, which is 6.3 decades from the first dart and about 260 points, so a
 * run in the app never wraps the ring. The wrap is the guarantee that a longer
 * one degrades by forgetting its left end rather than by growing without bound.
 */
const HISTORY_CAPACITY = 8 * SAMPLES_PER_DECADE;

/** Ratio between consecutive sampled `n`: 10^(1/48) = 1.04914. */
const HISTORY_STEP = 10 ** (1 / SAMPLES_PER_DECADE);

/**
 * |π̂ − π| against `n`, sampled logarithmically.
 *
 * The gate is `ceil(n · 10^(1/48))` with a floor of one dart, so the first
 * twenty darts are all recorded — below n = 21 the ratio step is under one
 * whole dart — and the sampling thins out to 48 points per decade after that.
 * That is what fits a million darts into a few hundred points while keeping the
 * left end of the curve, which is where the 1/√n law is doing its steepest work.
 */
export class ErrorHistory {
  readonly capacity: number;

  private readonly ns: Float64Array;
  private readonly errors: Float64Array;

  private head = 0;
  private stored = 0;
  /** The next dart count that will be recorded. */
  private gate = 1;

  constructor(capacity: number = HISTORY_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.ns = new Float64Array(this.capacity);
    this.errors = new Float64Array(this.capacity);
  }

  /** Samples held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /**
   * Record |π̂ − π| if `darts` has reached the next gate. Called once per dart —
   * one comparison, and the gate is what keeps the plot bounded.
   */
  sample(darts: number, inside: number): void {
    if (darts < this.gate) return;
    const i = this.head;
    this.ns[i] = darts;
    this.errors[i] = Math.abs(estimatePi(inside, darts) - Math.PI);
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
    this.gate = Math.max(darts + 1, Math.ceil(darts * HISTORY_STEP));
  }

  /** Visit the samples oldest first, which on a log-log plot is left to right. */
  forEach(cb: (n: number, error: number, index: number) => void): void {
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.ns[slot] ?? 0, this.errors[slot] ?? 0, i);
    }
  }

  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.gate = 1;
  }
}
