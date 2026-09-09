/**
 * The logistic map, xₙ₊₁ = r·xₙ·(1 − xₙ): the mathematics, with no canvas in
 * sight. Exercised end to end by tests/bifurcation.test.ts.
 *
 * One rule, iterated. For r below 1 every orbit falls to 0; up to r = 3 it
 * settles on the fixed point 1 − 1/r; at r = 3 that point loses stability and
 * the orbit splits in two, then in four, then in eight, with the windows
 * shrinking by a constant factor until they accumulate at r∞ ≈ 3.5699456 and
 * the orbit stops repeating at all. Plotting what survives against r is the
 * bifurcation diagram, and it is exact: no randomness enters anywhere in this
 * file.
 *
 * Two numbers make the picture checkable rather than merely pretty:
 *
 *   δ = 4.669201609…  the ratio of successive doubling intervals, which is the
 *                     same for every smooth map with one quadratic maximum
 *   λ = lim (1/n) Σ ln|f′(xᵢ)|   the Lyapunov exponent, negative wherever the
 *                     orbit is periodic, positive wherever it is chaotic, and
 *                     zero at each bifurcation
 *
 * λ is the honest signature: a diagram can look chaotic and be a period-512
 * cycle. λ says which it is, and at r = 4 it has a closed form — the map is
 * conjugate to the tent map there, so λ = ln 2 exactly.
 */

/**
 * Longest cycle `detectPeriod` will resolve. Beyond period 64 a cycle is
 * indistinguishable from chaos at any sample count this tab can afford, and the
 * cascade has accumulated by period 32 anyway (r₆ − r₅ is under 10⁻³).
 */
export const MAX_PERIOD = 64;

/**
 * Distance below which two iterates count as the same point.
 *
 * A converged cycle repeats to machine precision, so this is not a resolution
 * knob but a floor on the *separation* of two branches: 10⁻⁶ is above the
 * rounding noise of a few thousand iterations and below the branch separation
 * √(r − r_k) everywhere but the last 10⁻¹² of r before a doubling.
 */
export const DEFAULT_PERIOD_TOL = 1e-6;

/**
 * Where an orbit starts when the caller does not say.
 *
 * Deliberately not ½. The critical point ½ maps to r/4, which at r = 4 is 1 and
 * then 0 — the orbit dies on the fixed point at the origin, and the Lyapunov
 * exponent it reports is ln 4 rather than ln 2. Every other starting point in
 * (0, 1) lands on the same attractor, so the choice is free apart from that one
 * trap. In double precision the r = 4 orbit from 0.4 survives 2 × 10⁶ iterations
 * without touching 0 or 1; from ½ it is dead on the first.
 */
export const DEFAULT_X0 = 0.4;

/**
 * Feigenbaum's first constant, δ = 4.669201609102990671853…
 *
 * Universal: every smooth unimodal map with a quadratic maximum period-doubles
 * at this rate, which is why it turns up in dripping taps and convecting fluids
 * and not only here.
 */
export const FEIGENBAUM_DELTA = 4.66920160910299;

/** Accumulation point of the doubling cascade — the end of order, r∞. */
export const ACCUMULATION = 3.5699456;

/**
 * Where the period-3 window opens, r = 1 + √8 = 3.8284271…
 *
 * A tangent bifurcation: three fixed points of f³ appear out of nothing, so a
 * band of pure order opens inside the chaos. By Li and Yorke, a continuous map
 * with a period-3 point has points of every period — the window is the visible
 * form of that theorem.
 */
export const PERIOD_THREE_ONSET = 1 + Math.sqrt(8);

/**
 * The first five period-doubling onsets: where the 2ᵏ cycle loses stability.
 *
 * r₁ = 3 and r₂ = 1 + √6 are exact (the 2-cycle multiplier is 4 + 2r − r², and
 * it passes −1 there); r₃, r₄ and r₅ are the standard published values, which
 * no closed form is known for.
 */
const ONSETS: readonly number[] = [3, 1 + Math.sqrt(6), 3.54409036, 3.564407266, 3.56875942];

/** One iteration of the map. */
export function iterate(x: number, r: number): number {
  return r * x * (1 - x);
}

/**
 * Iterate `transientCount` times from `x0`, discarding the result, then write
 * the next `count` iterates into `out` starting at `offset`.
 *
 * The into-form exists because the tab computes one of these per rendered
 * column, several columns per frame: allocating a Float64Array each time is the
 * per-frame allocation the budget forbids. `attractor()` is this function plus
 * the allocation, for callers who want the array.
 */
export function sampleAttractor(
  out: Float64Array,
  offset: number,
  count: number,
  r: number,
  transientCount: number,
  x0: number = DEFAULT_X0,
): void {
  let x = x0;
  for (let i = 0; i < transientCount; i++) x = r * x * (1 - x);
  for (let i = 0; i < count; i++) {
    out[offset + i] = x;
    x = r * x * (1 - x);
  }
}

/**
 * The attractor at `r`: `sampleCount` iterates taken after `transientCount`
 * have been thrown away.
 *
 * The transient is what makes the picture exact. Every orbit in (0, 1) converges
 * to the same attractor, so what is left after the approach is a property of r
 * alone — the starting point has been forgotten.
 */
export function attractor(
  r: number,
  transientCount: number,
  sampleCount: number,
  x0: number = DEFAULT_X0,
): Float64Array {
  const n = Math.max(0, Math.floor(sampleCount));
  const out = new Float64Array(n);
  sampleAttractor(out, 0, n, r, Math.max(0, Math.floor(transientCount)), x0);
  return out;
}

/**
 * The period of a converged orbit, or 0 when no cycle up to `MAX_PERIOD`
 * repeats — which is chaos, or an orbit still approaching its cycle.
 *
 * The smallest p with |xᵢ₊ₚ − xᵢ| ≤ tol for *every* i in the window, so a run
 * that has not settled fails at every p and reports 0 rather than inventing a
 * cycle. Both loops break on the first mismatch, which is what keeps this cheap
 * enough to run on every column: a chaotic orbit costs MAX_PERIOD comparisons,
 * not MAX_PERIOD × count.
 *
 * `offset` and `count` read a window of a larger buffer without a subarray, for
 * the same per-frame-allocation reason as `sampleAttractor`.
 */
export function detectPeriod(
  orbit: ArrayLike<number>,
  tol: number = DEFAULT_PERIOD_TOL,
  offset = 0,
  count: number = orbit.length - offset,
): number {
  const n = Math.min(count, orbit.length - offset);
  // A period is only evidence if the window holds at least two of its cycles.
  const cap = Math.min(MAX_PERIOD, Math.floor(n / 2));
  for (let p = 1; p <= cap; p++) {
    let matched = true;
    for (let i = 0; i + p < n; i++) {
      if (Math.abs(orbit[offset + i + p]! - orbit[offset + i]!) > tol) {
        matched = false;
        break;
      }
    }
    if (matched) return p;
  }
  return 0;
}

/** The first five period-doubling onsets, r₁ … r₅. */
export function periodDoublingOnsets(): readonly number[] {
  return ONSETS;
}

/**
 * Ratios of successive doubling intervals, (rₖ₊₁ − rₖ) / (rₖ₊₂ − rₖ₊₁).
 *
 * On the onsets above these run 4.7514, 4.6563, 4.6682 — the sequence whose
 * limit Feigenbaum identified as δ. Fewer than three onsets give no ratio, so
 * the result is `onsets.length − 2` long and empty rather than undefined.
 */
export function feigenbaumRatios(onsets: ArrayLike<number>): number[] {
  const ratios: number[] = [];
  for (let i = 0; i + 2 < onsets.length; i++) {
    ratios.push((onsets[i + 1]! - onsets[i]!) / (onsets[i + 2]! - onsets[i + 1]!));
  }
  return ratios;
}

/**
 * Mean of ln|f′(xᵢ)| = ln|r(1 − 2xᵢ)| along the orbit at `r`, after a transient.
 *
 * This is the exponential rate at which two nearby orbits separate: negative
 * inside a periodic window (nearby orbits fall together onto the cycle),
 * positive in chaos, and zero at a bifurcation, where the cycle is neutral.
 *
 * Two values it must reproduce, both closed-form:
 *
 *   r = 3.2  the 2-cycle has multiplier 4 + 2r − r² = 0.16, so λ = ½·ln 0.16
 *            = −0.9162907, and the orbit reaches it to machine precision
 *   r = 4    conjugate to the tent map, so λ = ln 2 = 0.6931472
 *
 * −∞ is a real answer, not a failure: a superstable cycle passes through the
 * critical point ½, where f′ = 0.
 */
export function lyapunovExponent(
  r: number,
  transientCount: number,
  sampleCount: number,
  x0: number = DEFAULT_X0,
): number {
  const n = Math.max(0, Math.floor(sampleCount));
  let x = x0;
  for (let i = 0, t = Math.max(0, Math.floor(transientCount)); i < t; i++) x = r * x * (1 - x);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.log(Math.abs(r * (1 - 2 * x)));
    x = r * x * (1 - x);
  }
  return sum / n;
}

/**
 * The same exponent, read off an orbit already in hand.
 *
 * The samples a column plots *are* the post-transient orbit, so the tab gets λ
 * for the cost of a logarithm per sample instead of iterating the map a second
 * time. Identical to `lyapunovExponent` on the orbit that produced them.
 */
export function lyapunovFrom(
  orbit: ArrayLike<number>,
  r: number,
  offset = 0,
  count: number = orbit.length - offset,
): number {
  const n = Math.min(count, orbit.length - offset);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.log(Math.abs(r * (1 - 2 * orbit[offset + i]!)));
  return sum / n;
}
