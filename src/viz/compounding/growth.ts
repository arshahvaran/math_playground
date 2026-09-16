import { binomialPmf } from '../../core/stats';
import type { Rng } from '../../core/types';

/**
 * Compounding: the mathematics, with no canvas in sight.
 *
 * Every round, every player's pile is multiplied by `UP` on heads and by `DOWN`
 * on tails, each with probability ½. Write the pile after `r` rounds in terms of
 * the heads count `k ~ Binomial(r, ½)`:
 *
 *   W = UP^k · DOWN^(r−k)
 *
 * Two exact per-round factors follow, and they point in opposite directions.
 * Averaging over piles gives E[W] = ((UP + DOWN)/2)^r — the crowd's total grows
 * 5% a round, forever. Averaging over the *logarithms* of piles gives a random
 * walk whose drift is ½(ln UP + ln DOWN) = ½ ln 0.9 per step, so the middle of
 * the crowd is multiplied by √(UP·DOWN) = 0.9486833 a round — a 5.13% loss,
 * forever. Both are true of the same simulation at the same time: the average is
 * dragged up by the handful of players near k = r, whose piles are
 * astronomically large and correspondingly rare.
 *
 * A player is under the stake when UP^k · DOWN^(r−k) < 1, that is when
 *
 *   k / r  <  ln(1/DOWN) / ln(UP/DOWN)  =  0.5574930
 *
 * so a fair coin has to land heads 55.75% of the time just to break even, and
 * the share of the crowd that fails to manage it is an exact binomial tail.
 *
 * `UP` and `DOWN` are constants rather than controls: they are chosen so that
 * the average grows while the middle shrinks, and almost every other pair
 * destroys one half of that or the other.
 */

/** Heads: the pile grows by a half. */
export const UP = 1.5;
/** Tails: the pile shrinks by two fifths. */
export const DOWN = 0.6;

const LN_UP = Math.log(UP);
const LN_DOWN = Math.log(DOWN);

/** What the average pile is multiplied by each round: ½(UP + DOWN) = 1.05. */
export const MEAN_FACTOR = (UP + DOWN) / 2;

/** What the middle pile is multiplied by each round: √(UP·DOWN) = 0.9486833. */
export const MEDIAN_FACTOR = Math.sqrt(UP * DOWN);

/** The share of flips that must come up heads to break even: 0.5574930. */
export const BREAK_EVEN_HEADS = Math.log(1 / DOWN) / Math.log(UP / DOWN);

/**
 * Average vertical travel of one round on a base-10 log axis: ½(log UP − log
 * DOWN) = 0.198970 decades. It is also the standard deviation of log₁₀ W after
 * one round, so `spreadDecades()` and the painter's ink budget are the same
 * number used twice.
 */
export const STEP_DECADES = (Math.log10(UP) - Math.log10(DOWN)) / 2;

/** Share of the crowd whose piles are summed into the "luckiest few" reading. */
export const TOP_SLICE = 0.01;

/**
 * The pile after `rounds` rounds of which `heads` came up heads, as a multiple
 * of the stake. Written through `exp` rather than as `UP**k · DOWN**(r−k)` so a
 * half-integer `heads` is meaningful: that is how the middle pile is read off
 * when the crowd has an even number of players.
 */
export function wealth(heads: number, rounds: number): number {
  return Math.exp(heads * LN_UP + (rounds - heads) * LN_DOWN);
}

/** The same pile in decades, which is the coordinate the plate plots. */
export function decades(heads: number, rounds: number): number {
  return heads * Math.log10(UP) + (rounds - heads) * Math.log10(DOWN);
}

/**
 * Standard deviation of log₁₀ W after `rounds` rounds, in decades: the crowd
 * fans out as √r, because log W is a sum of `r` independent equal steps.
 */
export function spreadDecades(rounds: number): number {
  return STEP_DECADES * Math.sqrt(Math.max(0, rounds));
}

/**
 * P(pile < stake) after `rounds` rounds — the exact binomial tail below the
 * break-even heads count.
 *
 * Not monotonic in `rounds`, and that is arithmetic rather than a bug: the
 * boundary 0.5574930·r sweeps past a whole number of heads at its own pace, so
 * the tail is 0.7483 at twenty rounds and 0.7077 at thirty. A pile is never
 * *exactly* the stake — UP^k·DOWN^(r−k) = 1 would need 3^r = 2^k·5^(r−k) — so
 * the strict inequality loses nothing.
 */
export function shareBelowStake(rounds: number): number {
  const r = Math.floor(rounds);
  if (r < 1) return 0;
  const limit = BREAK_EVEN_HEADS * r;
  let sum = 0;
  for (let k = 0; k <= r && k < limit; k++) sum += binomialPmf(r, k, 0.5);
  return sum;
}

/**
 * Relative tolerance for the measured per-round factor of the average.
 *
 * The sample average M of N piles has E[M] = μ = MEAN_FACTOR^r and, because the
 * piles are independent, Var(M) = σ²/N with σ² = E[W²] − μ² and
 * E[W²] = ((UP² + DOWN²)/2)^r. So its coefficient of variation is
 *
 *   c = √( (((UP²+DOWN²)/2) / MEAN_FACTOR²)^r − 1 ) / √N
 *
 * which grows like 1.1837^(r/2): past about forty rounds a crowd of a few
 * thousand no longer reliably contains the winners that carry μ, and the plain
 * delta method (SD(log M) ≈ c) stops being a bound at all — it claims ±218% at
 * a hundred rounds where the reading actually lands within 3%.
 *
 * The published reading is the r-th root, so what matters is the spread of
 * log M, and for that the variance-stabilised form is the right one: a
 * lognormal with coefficient of variation c has SD(log M) = √(ln(1 + c²))
 * exactly. Dividing by r gives the relative spread of the factor, and three of
 * those is the bar the rest of the app uses. Measured over the whole shipped
 * slider grid at ten seeds — six hundred runs — the reading used 16% of its
 * allowance on average and went outside it once, which is what a
 * three-standard-deviation bar is supposed to do.
 */
export function meanFactorTolerance(players: number, rounds: number): number {
  if (rounds < 1 || players < 1) return 1;
  const ratio = (UP * UP + DOWN * DOWN) / 2 / (MEAN_FACTOR * MEAN_FACTOR);
  const cv2 = Math.max(0, ratio ** rounds - 1) / players;
  return (3 * Math.sqrt(Math.log1p(cv2))) / rounds;
}

/**
 * Relative tolerance for the measured per-round factor of the middle pile.
 *
 * Two terms, because two different things are going on.
 *
 * **Noise.** At an even round count the middle of the crowd is not
 * approximately √(UP·DOWN) per round, it is exactly that: the median of
 * Binomial(r, ½) is exactly r/2, and UP^(r/2)·DOWN^(r/2) = (UP·DOWN)^(r/2). All
 * that is left is sampling error, and the sample median of N draws from a
 * lattice carrying mass f = P(k = r/2) at its centre has SD ≈ 1/(2f√N) heads,
 * while one head moves the factor by ln(UP/DOWN)/r.
 *
 * Six of those standard deviations, not the usual three, because the reading is
 * discrete: it is exactly on target or a whole head out, never in between, and a
 * whole head is 2f√N standard deviations. Six is the multiple at which the
 * allowance covers that whole-head jump for every crowd in which the jump has a
 * probability above 0.3% of happening at all — at 500 players and fifty rounds
 * it does, about once in eighty runs — and for a larger crowd it is again a
 * tight bound around a median that does not move. Over the shipped grid at ten
 * seeds the middle landed exactly on r/2 in 596 of 600 runs, and the four
 * misses used 85% of this allowance.
 *
 * **Definition.** At an *odd* r the binomial puts exactly half its mass on each
 * side of the gap between (r−1)/2 and (r+1)/2 heads, so the middle is an
 * interval rather than a point and √(UP·DOWN)^r is merely its geometric
 * midpoint; a sample median has to land on one end or the other, 4.25% out at
 * eleven rounds and 1.12% at forty-one. That is how well the quantity is
 * *defined* at an odd count, so it is added rather than hidden. The fader offers
 * only even counts, which is why this term is normally zero — but a run passes
 * through every odd round on its way, and a row that flickered out of agreement
 * on the way to each even one would be reporting arithmetic as if it were
 * evidence.
 */
export function medianFactorTolerance(players: number, rounds: number): number {
  if (rounds < 1 || players < 1) return 1;
  const centre = binomialPmf(rounds, Math.floor(rounds / 2), 0.5);
  if (!(centre > 0)) return 1;
  const noise = (3 * Math.log(UP / DOWN)) / (centre * Math.sqrt(players) * rounds);
  // Half of ln(UP/DOWN)/r in the exponent is the distance from the midpoint of
  // the median interval to either end, as a ratio.
  const interval = rounds % 2 === 0 ? 0 : Math.expm1(Math.log(UP / DOWN) / (2 * rounds));
  return noise + interval;
}

/**
 * Relative tolerance for the share of the crowd under the stake: three standard
 * errors of a proportion, √(p(1−p)/N), over p itself. Before the first round
 * the share is exactly zero and so is its prediction, which the ledger reads as
 * an absolute tolerance — any positive number does there.
 */
export function shareTolerance(players: number, rounds: number): number {
  const p = shareBelowStake(rounds);
  if (!(p > 0) || players < 1) return 0.01;
  return (3 * Math.sqrt((p * (1 - p)) / players)) / p;
}

/**
 * The decades the plate spans, as whole powers of ten.
 *
 * Fixed by the round count alone, never by the piles measured so far: the axis
 * is drawn once on the background layer, and an axis that rescaled itself as
 * the luckiest player pulled away would make every earlier frame a lie. The
 * window holds the average (r·log MEAN_FACTOR), the middle (r·log
 * MEDIAN_FACTOR) and `SPREAD_SIGMAS` standard deviations of the fan either side
 * of the middle, with at least one decade above and below the stake so the
 * stake line is never on an edge.
 */
export interface WealthWindow {
  /** Decades above the stake at the top of the plot. Always ≥ 1. */
  top: number;
  /** Decades below the stake at the bottom of the plot. Always ≤ −1. */
  bottom: number;
}

/**
 * How much of the fan the window holds.
 *
 * At 2.2 standard deviations 1.4% of players fall through the floor, which on
 * the few dozen paths the ink budget paints is about one thread a run, and the
 * painter lets that thread leave rather than opening the axis. The temptation is
 * to hold the whole fan, and it costs the picture its point: every extra
 * standard deviation rounds up to another empty decade at each end, and the gap
 * between the two curves — which is the thing to look at — is what shrinks.
 */
const SPREAD_SIGMAS = 2.2;

export function wealthWindow(rounds: number): WealthWindow {
  const r = Math.max(1, Math.floor(rounds));
  const spread = SPREAD_SIGMAS * spreadDecades(r);
  const middle = r * Math.log10(MEDIAN_FACTOR);
  const average = r * Math.log10(MEAN_FACTOR);
  return {
    top: Math.ceil(Math.max(average, middle + spread, 1)),
    bottom: Math.floor(Math.min(middle - spread, -1)),
  };
}

// ---------------------------------------------------------------------------
// The crowd
// ---------------------------------------------------------------------------

/** Everything the readouts publish, recomputed once per round rather than per frame. */
export interface CrowdStats {
  /** Rounds played so far. */
  round: number;
  /** The average pile, as a multiple of the stake. */
  meanWealth: number;
  /** The middle pile, as a multiple of the stake. */
  medianWealth: number;
  /** `meanWealth^(1/round)`. NaN before the first round, where there is no rate to read. */
  meanFactor: number;
  /** `medianWealth^(1/round)`. NaN before the first round. */
  medianFactor: number;
  /** Share of players holding less than they started with. */
  shareBelow: number;
  /** Share of all the money held by the luckiest `TOP_SLICE` of the crowd. */
  topShare: number;
  /** The largest pile, as a multiple of the stake. */
  richest: number;
}

/**
 * The whole crowd, plus the history the plate draws.
 *
 * A player's entire state is the number of heads they have seen, so the crowd
 * is one `Uint16Array` and every statistic comes off a histogram of it — the
 * middle pile without a sort, the share under the stake without a scan, the
 * luckiest slice by walking the histogram down from the top. All of it is
 * allocated once at the ceiling and never again.
 *
 * Only the first `painted` players keep a per-round history, because only they
 * are ever drawn. It is stored in heads counts rather than pixels, the way
 * Buffon stores its needles as the draws that made them: a resize re-places
 * every path on the new plate instead of stranding it at coordinates the plate
 * no longer has.
 */
export class Crowd {
  readonly capacity: number;
  readonly maxRounds: number;
  /** Players whose whole path is recorded, whatever the crowd size. */
  readonly painted: number;

  private readonly heads: Uint16Array;
  /** Players per heads count, rebuilt each round. Indices 0…round are live. */
  private readonly counts: Uint32Array;
  /** `trail[i·(maxRounds+1) + r]` is painted player `i`'s heads count after round `r`. */
  private readonly trail: Uint16Array;
  /** Decades of the average and the middle pile after each round, for the two curves. */
  private readonly meanTrack: Float64Array;
  private readonly medianTrack: Float64Array;

  private size: number;
  private target: number;
  private played = 0;
  private stats: CrowdStats;

  constructor(capacity: number, maxRounds: number, painted: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.maxRounds = Math.max(1, Math.floor(maxRounds));
    this.painted = Math.max(1, Math.floor(painted));
    this.heads = new Uint16Array(this.capacity);
    this.counts = new Uint32Array(this.maxRounds + 1);
    this.trail = new Uint16Array(this.painted * (this.maxRounds + 1));
    this.meanTrack = new Float64Array(this.maxRounds + 1);
    this.medianTrack = new Float64Array(this.maxRounds + 1);
    this.size = this.capacity;
    this.target = this.maxRounds;
    this.stats = zeroStats();
  }

  /** Players in the crowd, clamped to the ceiling the arrays were built at. */
  get players(): number {
    return this.size;
  }

  /** Rounds this run will play. */
  get rounds(): number {
    return this.target;
  }

  /** Rounds played so far. */
  get round(): number {
    return this.played;
  }

  get finished(): boolean {
    return this.played >= this.target;
  }

  /** Paths actually recorded: the whole crowd when it is smaller than the budget. */
  get paths(): number {
    return Math.min(this.painted, this.size);
  }

  /**
   * Take the next parameter set. Does not restart the run on its own — the
   * shell calls `reset()` after every change, the way it does for the board.
   */
  setParams(players: number, rounds: number): void {
    this.size = Math.max(1, Math.min(this.capacity, Math.floor(players)));
    this.target = Math.max(1, Math.min(this.maxRounds, Math.floor(rounds)));
  }

  /** Every player back on the stake, every counter at zero. Nothing reallocates. */
  reset(): void {
    this.heads.fill(0);
    this.counts.fill(0);
    this.trail.fill(0);
    this.meanTrack[0] = 0;
    this.medianTrack[0] = 0;
    this.played = 0;
    this.stats = zeroStats();
  }

  /**
   * One round: exactly one draw per player, in player order, so the sequence a
   * seed produces does not depend on how the driver batched its ticks.
   */
  play(rng: Rng): void {
    if (this.finished) return;
    const n = this.size;
    const r = this.played + 1;
    for (let i = 0; i < n; i++) {
      if (rng.bool()) this.heads[i] = (this.heads[i] ?? 0) + 1;
    }
    this.played = r;

    // One pass for the histogram, which every statistic below then reads
    // instead of touching the crowd again.
    this.counts.fill(0, 0, r + 1);
    for (let i = 0; i < n; i++) {
      const k = this.heads[i] ?? 0;
      this.counts[k] = (this.counts[k] ?? 0) + 1;
    }

    const stride = this.maxRounds + 1;
    const paths = this.paths;
    for (let i = 0; i < paths; i++) this.trail[i * stride + r] = this.heads[i] ?? 0;

    this.stats = this.summarise(r, n);
    this.meanTrack[r] = Math.log10(this.stats.meanWealth);
    this.medianTrack[r] = Math.log10(this.stats.medianWealth);
  }

  /** The current readings. Cheap: computed once per round, not once per frame. */
  read(): CrowdStats {
    return this.stats;
  }

  /** Decades of the average pile after round `r`, for the curve. */
  meanAt(r: number): number {
    return this.meanTrack[r] ?? 0;
  }

  /** Decades of the middle pile after round `r`, for the curve. */
  medianAt(r: number): number {
    return this.medianTrack[r] ?? 0;
  }

  /** Decades of painted player `i` after round `r`, for the fan. */
  pathAt(i: number, r: number): number {
    return decades(this.trail[i * (this.maxRounds + 1) + r] ?? 0, r);
  }

  /**
   * Every statistic off the histogram.
   *
   * The middle pile is taken on the logarithm — the scale the process is
   * additive on — so an even crowd whose two central players differ by a head
   * reads the geometric middle of their two piles. Averaging them arithmetically
   * instead pulls the reading up by (√2.5 + 1/√2.5)/2 = 1.1068^(1/r), because
   * the two piles either side of the middle differ by a factor of UP/DOWN = 2.5
   * and an average of a ratio and its reciprocal is never 1.
   */
  private summarise(r: number, n: number): CrowdStats {
    let total = 0;
    for (let k = 0; k <= r; k++) {
      const c = this.counts[k] ?? 0;
      if (c > 0) total += c * wealth(k, r);
    }

    // The two central order statistics, by walking the histogram once.
    const loIndex = (n - 1) >> 1;
    const hiIndex = n >> 1;
    let cumulative = 0;
    let kLo = 0;
    let kHi = 0;
    let richestHeads = 0;
    for (let k = 0; k <= r; k++) {
      const before = cumulative;
      const c = this.counts[k] ?? 0;
      cumulative += c;
      if (before <= loIndex && loIndex < cumulative) kLo = k;
      if (before <= hiIndex && hiIndex < cumulative) kHi = k;
      if (c > 0) richestHeads = k;
    }
    const middleHeads = (kLo + kHi) / 2;

    let below = 0;
    const limit = BREAK_EVEN_HEADS * r;
    for (let k = 0; k <= r && k < limit; k++) below += this.counts[k] ?? 0;

    // The luckiest slice, walked down from the top of the histogram; the bucket
    // the slice ends inside contributes only the players it owes.
    const slice = Math.max(1, Math.round(n * TOP_SLICE));
    let taken = 0;
    let top = 0;
    for (let k = r; k >= 0 && taken < slice; k--) {
      const c = Math.min(this.counts[k] ?? 0, slice - taken);
      if (c > 0) {
        top += c * wealth(k, r);
        taken += c;
      }
    }

    const meanWealth = total / n;
    const medianWealth = wealth(middleHeads, r);
    return {
      round: r,
      meanWealth,
      medianWealth,
      // 10^(decades/r) rather than W^(1/r): the same number, without raising a
      // pile of 10¹⁸ to a fractional power.
      meanFactor: 10 ** (Math.log10(meanWealth) / r),
      medianFactor: 10 ** (decades(middleHeads, r) / r),
      shareBelow: below / n,
      topShare: total > 0 ? top / total : 0,
      richest: wealth(richestHeads, r),
    };
  }
}

/** Round zero: every pile is the stake, and no per-round rate has been seen yet. */
function zeroStats(): CrowdStats {
  return {
    round: 0,
    meanWealth: 1,
    medianWealth: 1,
    meanFactor: NaN,
    medianFactor: NaN,
    shareBelow: 0,
    topShare: 0,
    richest: 1,
  };
}
