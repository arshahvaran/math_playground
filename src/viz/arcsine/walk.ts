import type { Rng } from '../../core/types';
import { Welford, logChoose } from '../../core/stats';

/**
 * The arcsine law: how long one side leads a fair game, with no canvas in sight.
 *
 * A fair coin is tossed `n` times. The running score is S₀ = 0 and
 * Sᵢ = Sᵢ₋₁ ± 1, and the interval between toss i−1 and toss i counts as a lead
 * for heads when max(Sᵢ₋₁, Sᵢ) > 0 — Feller's convention, and the one that
 * makes the count exact rather than nearly right, since the score is zero at
 * the moment of every crossing. The number of such intervals is always even;
 * write it 2k out of n = 2m. Then
 *
 *   P(2k of 2m) = C(2k, k)·C(2m−2k, m−k) / 4ᵐ            (Feller, vol. 1, III.4)
 *
 * which is symmetric under k ↔ m−k and — this is the whole surprise — is
 * *largest at the two ends*, k = 0 and k = m, and smallest in the middle. As
 * m grows the fraction T = k/m converges in distribution to the arcsine law,
 *
 *   F(x) = P(T ≤ x) = (2/π)·arcsin(√x),   f(x) = 1 / (π·√(x(1−x)))
 *
 * whose density is at its *minimum* at ½, where it equals 2/π = 0.6366, and
 * unbounded at both ends. Mean ½, variance ⅛.
 *
 * Every number the tab publishes is a function of T, and every comparison is
 * made against F rather than against f: the density diverges at both ends, so a
 * measured histogram cannot be compared to it there, while the two CDFs are
 * bounded, monotone and comparable at every bin edge.
 */

// ---------------------------------------------------------------------------
// The law
// ---------------------------------------------------------------------------

/** F(x) = (2/π)·arcsin(√x), the arcsine law's distribution function on [0, 1]. */
export function arcsineCdf(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return (2 / Math.PI) * Math.asin(Math.sqrt(x));
}

/**
 * A game is *dominated* when the lead fraction lands in one of these two tails:
 * heads ahead for at most a tenth of the game, or for at least nine tenths of
 * it. Either side counts, so the probability is the two tails together.
 *
 * Two literals rather than one and its complement, because `1 − 0.9` is
 * 0.09999999999999998 and not 0.1 — and a game that split 40 flips out of 400
 * lands on exactly the double 0.1, so the mirrored edge would have dropped it
 * while its reflection at 0.9 was kept. A tail that is not the mirror of its
 * partner is not a tail of a symmetric law.
 */
export const LEAD_LOW = 0.1;
export const LEAD_HIGH = 0.9;

/** A game *looks fair* when the lead was split this evenly. */
export const FAIR_LO = 0.45;
export const FAIR_HI = 0.55;

/**
 * P(one side led at least 90% of the game) = 2·F(0.1) = (4/π)·arcsin(√0.1).
 * Two games in five, which is the number this tab exists to make believable.
 */
export const DOMINANT_P = 2 * arcsineCdf(LEAD_LOW);

/** P(the lead was split 45–55%) = F(0.55) − F(0.45). The rarest outcome of all. */
export const FAIR_P = arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO);

/** E[T] = ½ and Var(T) = ⅛ — exactly, in the limit. */
export const LEAD_MEAN = 0.5;
export const LEAD_VARIANCE = 1 / 8;

/**
 * P(T = 2k/flips) under the exact finite-game law above.
 *
 * In logs, because C(20000, 10000) overflowed a double a long way back. This is
 * what the limit is *approached from*: the finite-game law sits a little above
 * the arcsine limit in both tails and in the middle band, by a term of order
 * 1/flips, and tests/arcsine.test.ts pins those two constants against this sum
 * rather than against a simulation.
 */
export function exactLeadPmf(flips: number, k: number): number {
  const m = Math.floor(flips / 2);
  if (!Number.isInteger(k) || k < 0 || k > m) return 0;
  return Math.exp(logChoose(2 * k, k) + logChoose(2 * m - 2 * k, m - k) - 2 * m * Math.LN2);
}

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

/**
 * Points kept per traced game. The fan is a picture of where the fractions come
 * from, not a plot to read values off, and 128 points across a 700 px plate is
 * a 5 px segment — finer than the eye separates on a path that crosses itself.
 */
export const TRACE_SAMPLES = 128;

/**
 * Play one game of `flips` tosses and return the fraction of it that heads led.
 *
 * Exactly one draw per toss, always in the same order, so a seed reproduces the
 * whole sequence of games however the ticks are batched. The coin is fair and
 * stays fair: a biased coin is a different experiment, and at p ≠ ½ the leader
 * is simply whoever the bias favours, which is the one answer nobody finds
 * surprising.
 *
 * With `trace` supplied, the running score is sampled into
 * `trace[at … at + TRACE_SAMPLES)` in units of √flips — the scale the walk
 * actually grows on, so a 400-flip game and a 10,000-flip one draw the same
 * height and the fan does not shrink to a flat line at the short end. Sampling
 * draws nothing, so a traced game and an untraced one consume the same stream.
 */
export function playGame(rng: Rng, flips: number, trace?: Float32Array, at = 0): number {
  const n = Math.max(2, Math.floor(flips));
  const scale = 1 / Math.sqrt(n);
  let score = 0;
  let ahead = 0;

  // The next toss index a sample is due at, and which slot it fills. −1 means
  // "no more samples", which is also the state of an untraced game, so the
  // inner loop carries one integer comparison rather than a null check.
  let slot = 1;
  let due = -1;
  if (trace) {
    trace[at] = 0;
    due = Math.round(n / (TRACE_SAMPLES - 1));
  }

  for (let i = 1; i <= n; i++) {
    const before = score;
    score += rng.next() < 0.5 ? 1 : -1;
    // The interval is a lead for heads if either end of it is above zero. Both
    // ends, because the score passes through zero on the way between them.
    if (before > 0 || score > 0) ahead++;
    if (i === due) {
      trace![at + slot] = score * scale;
      slot++;
      due = slot < TRACE_SAMPLES ? Math.round((slot * n) / (TRACE_SAMPLES - 1)) : -1;
    }
  }

  // A game shorter than the sample count leaves slots unwritten, and a stale
  // sample from the game before would draw a trace that never happened.
  if (trace) {
    const tail = score * scale;
    while (slot < TRACE_SAMPLES) trace[at + slot++] = tail;
  }

  return ahead / n;
}

// ---------------------------------------------------------------------------
// The histogram
// ---------------------------------------------------------------------------

/**
 * Which bar a lead fraction falls in, over `bins` equal bars on [0, 1].
 *
 * Folded at ½ rather than simply floored, so bar j and bar bins−1−j hold
 * mirror-image sets and a law that is symmetric about ½ cannot paint a lopsided
 * histogram. A plain half-open rule has to close one end, and closing the right
 * one hands the last bar the T = 1 games — the single most likely outcome there
 * is — while the first bar gets no such gift. At 400 flips that is a bar 20%
 * taller than its mirror, which reads as a result and is an artefact.
 *
 * `bins` is odd for the same reason: an even count splits at ½, and the games
 * that ended exactly level would all have to fall on one side of the split.
 */
export function leadBin(fraction: number, bins: number): number {
  const b = Math.max(1, Math.floor(bins));
  const folded = fraction <= 0.5 ? fraction : 1 - fraction;
  const j = Math.floor(folded * b);
  const index = fraction <= 0.5 ? j : b - 1 - j;
  return Math.min(b - 1, Math.max(0, index));
}

/** The probability the law gives bar `j` of `bins`: F at its right edge less F at its left. */
export function analyticBinProbability(j: number, bins: number): number {
  return arcsineCdf((j + 1) / bins) - arcsineCdf(j / bins);
}

/**
 * The analytic bar height as a continuous function of position: the probability
 * the law puts in a window one bar wide centred on `x`.
 *
 * This, and not the density itself, is what the drawn curve traces. The density
 * is unbounded at both ends, and over the outermost bar it averages well above
 * its own value at that bar's centre — plotting f directly puts the curve 30%
 * *below* the two tallest bars, which is exactly where a reader is looking to
 * see whether the measurement agrees. Evaluated at a bar's centre this returns
 * that bar's probability exactly, so the curve passes through the top of every
 * bar the law predicts.
 */
export function analyticBarHeight(x: number, width: number): number {
  const half = width / 2;
  return arcsineCdf(Math.min(1, x + half)) - arcsineCdf(Math.max(0, x - half));
}

/**
 * The running tally over every game played: the histogram, the two counters the
 * headline reads, and the first two moments.
 *
 * Nothing here grows with the number of games — the counts are one array of
 * `bins` and the moments are Welford's three numbers — so a run of five
 * thousand games costs exactly what a run of two hundred does, and the game
 * count is free to be the fader it is.
 */
export class LeadTally {
  readonly bins: number;
  /** Games in each bar. Allocated once; `reset` zeroes it rather than replacing it. */
  readonly counts: Uint32Array;

  private readonly moments = new Welford();
  private dominated = 0;
  private even = 0;

  constructor(bins: number) {
    this.bins = Math.max(1, Math.floor(bins));
    this.counts = new Uint32Array(this.bins);
  }

  get games(): number {
    return this.moments.n;
  }

  /** Games in which one side led at least `LEAD_EDGE` of the way. */
  get dominant(): number {
    return this.dominated;
  }

  /** Games whose lead came out inside the fair-looking band. */
  get fair(): number {
    return this.even;
  }

  get mean(): number {
    return this.moments.mean;
  }

  get variance(): number {
    return this.moments.variance;
  }

  push(fraction: number): void {
    this.counts[leadBin(fraction, this.bins)]!++;
    if (fraction <= LEAD_LOW || fraction >= LEAD_HIGH) this.dominated++;
    if (fraction >= FAIR_LO && fraction <= FAIR_HI) this.even++;
    this.moments.push(fraction);
  }

  /**
   * The largest gap between the measured distribution function and F, taken at
   * the bin edges.
   *
   * A Kolmogorov–Smirnov statistic restricted to the `bins − 1` interior edges,
   * which is what a histogram can honestly report: the edges are where the
   * measured CDF is known exactly, and the gap there is bounded above by the
   * unrestricted statistic, whose distribution is what the tolerance is drawn
   * from. NaN before the first game.
   */
  cdfGap(): number {
    const games = this.games;
    if (games === 0) return NaN;
    let cumulative = 0;
    let worst = 0;
    for (let j = 0; j < this.bins - 1; j++) {
      cumulative += this.counts[j]!;
      const gap = Math.abs(cumulative / games - arcsineCdf((j + 1) / this.bins));
      if (gap > worst) worst = gap;
    }
    return worst;
  }

  reset(): void {
    this.counts.fill(0);
    this.dominated = 0;
    this.even = 0;
    this.moments.reset();
  }
}
