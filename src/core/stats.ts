/**
 * Statistics shared by every visualization: moments, histograms, the normal
 * distribution, binomial coefficients, and the readout formatter.
 *
 * Everything takes `ArrayLike<number>`, so a Float64Array allocated at the
 * budget ceiling with `n` live entries works as well as a plain array. Nothing
 * here touches the DOM or a canvas; tests/stats.test.ts runs it all under node.
 */

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

/**
 * Number of leading entries to read. Particle state lives in typed arrays sized
 * to the budget ceiling, so callers pass the live count rather than the length.
 * Clamped to the array, so an off-by-one never reads `undefined` into a sum.
 */
function liveCount(xs: ArrayLike<number>, n: number | undefined): number {
  return n === undefined ? xs.length : Math.min(Math.max(0, Math.floor(n)), xs.length);
}

/** Arithmetic mean of the first `n` entries. NaN when there are none. */
export function mean(xs: ArrayLike<number>, n?: number): number {
  const m = liveCount(xs, n);
  let sum = 0;
  for (let i = 0; i < m; i++) sum += xs[i]!;
  return sum / m;
}

/**
 * Population variance (divisor `n`, not `n − 1`) of the first `n` entries.
 *
 * Population, because the analytic targets — `n·p·(1−p)` for the Galton board,
 * `n` for a random walk — are the variances of distributions, and that is what
 * a readout is compared against; at the sample sizes here the two differ by
 * less than the display precision anyway.
 *
 * Two passes — mean first, then squared deviations — rather than the one-pass
 * `E[x²] − E[x]²`, which cancels catastrophically once the mean is large next
 * to the spread: a walker sitting around 1e6 with a variance of 100 loses most
 * of its digits that way. NaN when there are no entries.
 */
export function variance(xs: ArrayLike<number>, n?: number): number {
  const m = liveCount(xs, n);
  const mu = mean(xs, m);
  let ss = 0;
  for (let i = 0; i < m; i++) {
    const d = xs[i]! - mu;
    ss += d * d;
  }
  return ss / m;
}

/** Population standard deviation of the first `n` entries. */
export function stddev(xs: ArrayLike<number>, n?: number): number {
  return Math.sqrt(variance(xs, n));
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export interface HistogramOptions {
  bins: number;
  min: number;
  max: number;
  /** Leading entries to read; defaults to the whole array. */
  n?: number;
}

export interface Histogram {
  /** One count per bin. */
  counts: Uint32Array;
  /** `bins + 1` boundaries, `edges[0] === min` and `edges[bins] === max`. */
  edges: Float64Array;
  /** Samples below `min`. */
  underflow: number;
  /** Samples above `max`. */
  overflow: number;
}

/**
 * Equal-width histogram of the first `n` entries over `[min, max]`.
 *
 * Bin `i` covers `[edges[i], edges[i+1])`; the last bin is closed on the right
 * so a sample exactly on `max` is kept. Samples outside the range are tallied
 * as `underflow` / `overflow`, so `sum(counts) + underflow + overflow` is the
 * number of samples read. NaN is skipped and counted nowhere.
 *
 * For integer data — Galton landing bins 0..rows — use half-integer bounds
 * (`min: -0.5, max: rows + 0.5, bins: rows + 1`) so each value gets its own bin.
 */
export function histogram(xs: ArrayLike<number>, opts: HistogramOptions): Histogram {
  const { bins, min, max } = opts;
  if (!Number.isInteger(bins) || bins < 1) {
    throw new RangeError(`histogram: bins must be a positive integer, got ${bins}`);
  }
  if (!(max > min)) {
    throw new RangeError(`histogram: need max > min, got [${min}, ${max}]`);
  }

  const m = liveCount(xs, opts.n);
  const counts = new Uint32Array(bins);
  const edges = new Float64Array(bins + 1);
  const span = max - min;
  // Divide rather than multiply by a precomputed width: 3 · (1/10) is
  // 0.30000000000000004, 3/10 is 0.3, and these edges become axis labels.
  for (let i = 0; i < bins; i++) edges[i] = min + (span * i) / bins;
  edges[bins] = max;

  const scale = bins / span;
  let underflow = 0;
  let overflow = 0;
  for (let i = 0; i < m; i++) {
    const x = xs[i]!;
    if (x < min) {
      underflow++;
    } else if (x > max) {
      overflow++;
    } else if (x === x) {
      // (x − min) · scale rounds up to exactly `bins` for x = max and can for x
      // an ulp below it; clamp instead of dropping the sample.
      let b = Math.floor((x - min) * scale);
      if (b >= bins) b = bins - 1;
      // The published edges are min + span·i/bins and this index is from
      // (x − min)·bins/span; the two round differently, and a sample sitting
      // exactly on edges[i] can come out as i − 1 (0.7/3 · 3/0.7 is one ulp
      // under 1). Measure-zero for continuous data, a systematic left shift
      // for values computed on the same grid, so settle it against the edges
      // themselves. They are monotone and the error is under a bin, so one
      // step suffices; b ≥ 1 whenever the first branch fires, since x ≥ edges[0].
      if (x < edges[b]!) b--;
      else if (b + 1 < bins && x >= edges[b + 1]!) b++;
      counts[b]!++;
    }
  }
  return { counts, edges, underflow, overflow };
}

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

const SQRT_2PI = 2.5066282746310002;

/** Density of N(mu, sigma²) at `x`. `sigma` must be positive. */
export function normalPdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * SQRT_2PI);
}

/**
 * Cumulative distribution of N(mu, sigma²) at `x`. `sigma` must be positive.
 *
 * Hart's rational approximation (1968, algorithm 5666) in the form given by
 * West, "Better approximations to cumulative normal functions", Wilmott 2005:
 * a degree-6/7 rational function of |z| times exp(−z²/2) below 7.07, a
 * five-term continued fraction above it. Measured against erfc on a 0.001 grid
 * over [−37, 37]: absolute error ≤ 2.2e-16 everywhere; relative error in the
 * lower tail ≤ 1.5e-14 down to z = −3 and ≤ 9e-9 below that (worst just past
 * the switch-over), so Φ(−10) ≈ 7.62e-24 is good to eight digits. Beyond ±37
 * the tail is under 1e-300 and is returned as exactly 0 / 1.
 *
 * Chosen over Abramowitz–Stegun 7.1.26 (max error 1.5e-7) for the same
 * operation count: a `target` readout should not carry an approximation error
 * of its own. Both tails come from one evaluation at |z|, so Φ(−z) and
 * 1 − Φ(z) agree to a single rounding of 1.
 */
export function normalCdf(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  const a = Math.abs(z);
  let tail: number;
  if (a > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * a * a);
    if (a < 7.07106781186547) {
      let num = 0.0352624965998911 * a + 0.700383064443688;
      num = num * a + 6.37396220353165;
      num = num * a + 33.912866078383;
      num = num * a + 112.079291497871;
      num = num * a + 221.213596169931;
      num = num * a + 220.206867912376;
      let den = 0.0883883476483184 * a + 1.75566716318264;
      den = den * a + 16.064177579207;
      den = den * a + 86.7807322029461;
      den = den * a + 296.564248779674;
      den = den * a + 637.333633378831;
      den = den * a + 793.826512519948;
      den = den * a + 440.413735824752;
      tail = (e * num) / den;
    } else {
      let cf = a + 0.65;
      cf = a + 4 / cf;
      cf = a + 3 / cf;
      cf = a + 2 / cf;
      cf = a + 1 / cf;
      tail = e / cf / SQRT_2PI;
    }
  }
  return z > 0 ? 1 - tail : tail;
}

// ---------------------------------------------------------------------------
// Binomial
// ---------------------------------------------------------------------------

const HALF_LOG_2PI = 0.9189385332046728;

/**
 * ln Γ(z) for z ≥ 0.5 by the Lanczos approximation, g = 7 with nine terms —
 * the coefficient set used by most double-precision implementations, relative
 * error in Γ around 1e-15 across the positive reals. The sum is written out
 * rather than looped over a coefficient table: nine fixed terms, and the
 * unrolled form is what the JIT would produce anyway.
 *
 * Only ever called with arguments ≥ 1 from `logChoose`, so no reflection
 * formula is needed for the left half-plane.
 */
function lgamma(z: number): number {
  z -= 1;
  const t = z + 7.5;
  const s =
    0.99999999999980993 +
    676.5203681218851 / (z + 1) -
    1259.1392167224028 / (z + 2) +
    771.32342877765313 / (z + 3) -
    176.61502916214059 / (z + 4) +
    12.507343278686905 / (z + 5) -
    0.13857109526572012 / (z + 6) +
    9.9843695780195716e-6 / (z + 7) +
    1.5056327351493116e-7 / (z + 8);
  return HALF_LOG_2PI + (z + 0.5) * Math.log(t) - t + Math.log(s);
}

/**
 * ln C(n, k) via ln Γ, so C(10⁶, 5·10⁵) ≈ e^693140 is representable as its
 * logarithm long after the coefficient itself has overflowed a double.
 * −Infinity when k is outside [0, n], i.e. ln 0. The lgamma terms grow like
 * n·ln n, so absolute precision degrades gently with n — measured against
 * exact big-integer references: 2e-13 at n = 1000, 1e-9 at n = 10⁶.
 */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  // Same subtraction order for k and n − k, so C(n, k) and C(n, n − k) are
  // bit-identical and a p = ½ board draws mirror-image bars.
  const j = Math.min(k, n - k);
  return lgamma(n + 1) - lgamma(j + 1) - lgamma(n - j + 1);
}

/**
 * P(X = k) for X ~ Binomial(n, p), computed in log space so n can be large.
 * Zero for k outside 0..n or non-integer; p = 0 and p = 1 are point masses
 * at 0 and n, handled explicitly because ln 0 would otherwise poison the sum.
 */
export function binomialPmf(n: number, k: number, p: number): number {
  if (!Number.isInteger(k) || k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  // log1p(−p) keeps (1 − p) exact for p near 0, where 1 − p itself rounds to 1.
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/**
 * Standard error of a sample proportion, √(p(1−p)/n): the 1/√n that every
 * Monte Carlo tab is really about. Infinite for n ≤ 0 — no trials, no information.
 */
export function standardError(p: number, n: number): number {
  return n > 0 ? Math.sqrt((p * (1 - p)) / n) : Infinity;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a readout to `digits` significant figures (default 4) for a table
 * that updates every frame.
 *
 * - No exponent notation for |x| in [1e-6, 1e21), which covers the required
 *   [1e-4, 1e9]; outside that, `toPrecision` form such as `1.235e-7`.
 * - No thousands separators, so the text is a valid number literal and
 *   columns line up under `font-variant-numeric: tabular-nums`.
 * - Digits left of the decimal point are never rounded away: 1234567 prints
 *   as itself, not 1235000, because a trial count shown as an approximation
 *   reads as a bug.
 * - Integer-valued input prints as an integer (`100`, not `100.0`) — counts
 *   are the most common readout.
 * - Trailing zeros are kept on non-integers (`2.500`), so a live estimate does
 *   not change width from frame to frame.
 * - NaN and ±Infinity print as `NaN`, `∞`, `-∞`.
 */
export function fmt(x: number, digits = 4): string {
  if (x !== x) return 'NaN';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';
  if (Number.isInteger(x)) return x.toFixed(0);

  const d = Math.min(21, Math.max(1, Math.round(digits)));
  const a = Math.abs(x);
  if (a >= 10 ** d) return x.toFixed(0);
  if (a < 1e-6) return x.toPrecision(d);

  // toPrecision rounds correctly, including the carry that turns 9.9996 into
  // 10.00 — but when that carry reaches 10^d it switches to exponent form, and
  // the value is then an integer anyway.
  const s = x.toPrecision(d);
  return s.includes('e') ? x.toFixed(0) : s;
}

// ---------------------------------------------------------------------------
// Online moments
// ---------------------------------------------------------------------------

/**
 * Running mean and variance (Welford 1962): one pass, O(1) memory, and no
 * cancellation. M₂ = Σ(xᵢ − x̄)² is updated from the change in the mean rather
 * than accumulated as Σx² − n·x̄², which loses digits for the same reason
 * `variance()` takes two passes. This is the readout accumulator for a
 * visualization that must publish a mean every frame without rescanning
 * fifty thousand samples.
 *
 * `variance` is the population variance, matching `variance()`. `mean`,
 * `variance` and `stddev` are NaN until the first `push`.
 */
export class Welford {
  #n = 0;
  #mean = 0;
  #m2 = 0;

  push(x: number): void {
    this.#n++;
    const delta = x - this.#mean;
    this.#mean += delta / this.#n;
    // `delta` is against the old mean, the second factor against the new one;
    // their product is exactly the increment to Σ(xᵢ − x̄)².
    this.#m2 += delta * (x - this.#mean);
  }

  get n(): number {
    return this.#n;
  }

  get mean(): number {
    return this.#n > 0 ? this.#mean : NaN;
  }

  get variance(): number {
    return this.#n > 0 ? this.#m2 / this.#n : NaN;
  }

  get stddev(): number {
    return Math.sqrt(this.variance);
  }

  reset(): void {
    this.#n = 0;
    this.#mean = 0;
    this.#m2 = 0;
  }
}
