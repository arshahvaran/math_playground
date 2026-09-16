import type { Rng } from '../../core/types';

/**
 * The prisoners and the boxes: the mathematics, with no canvas in sight.
 *
 * A warden hides the numbers 0…n−1 in n boxes in a uniformly random order —
 * that is, he picks a permutation σ, and box i holds σ(i). Each prisoner may
 * open k boxes and must find his own number. Under the rule, prisoner p opens
 * box p, reads σ(p), opens box σ(p), and keeps following the chain. That chain
 * is the cycle of σ containing p, and it closes on the box holding p itself —
 * so p succeeds exactly when his cycle is at most k long, and *everybody*
 * succeeds exactly when σ has no cycle longer than k.
 *
 * That is the whole of the puzzle's surprise. A hundred prisoners are not a
 * hundred separate bets; they are one bet on one object, and the rule is what
 * couples them.
 *
 * For k ≥ n/2 the probability is exactly 1 − (Hₙ − H_k), in two lines. At most
 * one cycle can be longer than half, so the events "σ has a cycle of length ℓ"
 * are disjoint for ℓ > n/2. And the permutations of n with a cycle of exactly ℓ
 * number C(n, ℓ)·(ℓ−1)!·(n−ℓ)! = n!/ℓ, so each such event has probability 1/ℓ.
 * Summing ℓ = k+1 … n gives Hₙ − H_k. At n = 100, k = 50 that is 0.3118278 —
 * against (1/2)¹⁰⁰ = 7.9 × 10⁻³¹ for guessing.
 *
 * Nothing here knows what a pixel is; tests/prisoners.test.ts runs all of it
 * under node.
 */

// ---------------------------------------------------------------------------
// The closed form, and the recursion that proves where it starts
// ---------------------------------------------------------------------------

/** Hₙ = 1 + 1/2 + … + 1/n, and H₀ = 0. */
export function harmonic(n: number): number {
  // Smallest term first. The success probability is a *difference* of two
  // harmonic numbers of similar size, so the digits this order keeps are the
  // digits the answer is made of.
  let sum = 0;
  for (let i = Math.floor(n); i >= 1; i--) sum += 1 / i;
  return sum;
}

/**
 * P(σ has no cycle longer than k) = 1 − (Hₙ − H_k).
 *
 * NaN below k = n/2 rather than a plausible wrong number: the disjointness the
 * derivation rests on is exactly what fails there, and `exactSuccessProbability`
 * is the general answer. The tab never asks — it fixes k at ⌈n/2⌉.
 */
export function successProbability(n: number, k: number): number {
  const total = Math.floor(n);
  const limit = Math.min(Math.floor(k), total);
  if (!(total >= 1) || !(limit >= total / 2)) return NaN;
  return 1 - (harmonic(total) - harmonic(limit));
}

/**
 * The same probability for every k, from the recursion
 *
 *   q(m) = (1/m)·Σ_{j=1..min(k,m)} q(m−j),   q(0) = 1,
 *
 * which splits on the length j of the cycle containing the first element: there
 * are (m−1)!/(m−j)! ways to build that cycle, and dividing through by m! leaves
 * 1/m times the answer for the m−j elements left over.
 *
 * It is here because half is where the tidy *formula* begins, not where the
 * problem changes: at n = 100 the recursion gives 0.2920278 at k = 49,
 * 0.3118278 at 50 and 0.3314357 at 51 — a smooth climb with no cliff at the
 * point the closed form takes over. Not on the frame path; it allocates.
 */
export function exactSuccessProbability(n: number, k: number): number {
  const total = Math.max(0, Math.floor(n));
  const limit = Math.max(0, Math.floor(k));
  if (limit <= 0) return total === 0 ? 1 : 0;
  const q = new Float64Array(total + 1);
  q[0] = 1;
  // The sum in the recursion is a window of the last min(k, m) entries, so it
  // is carried rather than re-summed: O(n) instead of O(n·k).
  let window = 1;
  for (let m = 1; m <= total; m++) {
    q[m] = window / m;
    window += q[m]!;
    if (m >= limit) window -= q[m - limit]!;
  }
  return q[total] ?? 1;
}

/**
 * (k/n)ⁿ — the same n prisoners, each opening k boxes at random.
 *
 * A prisoner opening k of the n boxes meets his own number with probability
 * k/n, and the choices are independent across prisoners, so the room goes free
 * with probability (k/n)ⁿ. At n = 100 that is 2⁻¹⁰⁰: a room playing once a
 * second since the Big Bang would still be waiting.
 */
export function guessingProbability(n: number, k: number): number {
  const total = Math.floor(n);
  if (!(total >= 1)) return 0;
  return Math.min(1, Math.max(0, k / total)) ** total;
}

/**
 * Boxes each prisoner may open: half of them, rounded up.
 *
 * Rounded *up* so that k ≥ n/2 holds for odd n too and the closed form stays
 * valid at every slider position. The rounding is visible in the answer and
 * should be: 101 people opening 51 boxes each do slightly better (0.3215) than
 * 100 opening 50 (0.3118), because 51 is a little more than half.
 */
export function boxesAllowed(n: number): number {
  return Math.ceil(Math.max(1, Math.floor(n)) / 2);
}

// ---------------------------------------------------------------------------
// One shuffle of the boxes
// ---------------------------------------------------------------------------

/**
 * A uniformly random permutation of 0…n−1 into the first n slots of `perm`,
 * by Fisher–Yates from the top.
 *
 * Exactly n−1 draws, whatever permutation comes out, so the run a seed produces
 * does not depend on how the engine batched its ticks.
 */
export function shuffle(rng: Rng, perm: Int32Array, n: number): void {
  const m = Math.min(Math.max(0, Math.floor(n)), perm.length);
  for (let i = 0; i < m; i++) perm[i] = i;
  for (let i = m - 1; i >= 1; i--) {
    const j = rng.int(0, i);
    const held = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = held;
  }
}

/**
 * The longest cycle of `perm[0…n−1]`. `seen` is scratch the caller owns, so a
 * round allocates nothing.
 *
 * Only the longest cycle decides a round, so the counting path stops here: the
 * full cycle type costs a sort and is worked out only for the one permutation
 * that is actually painted.
 */
export function longestCycle(perm: Int32Array, n: number, seen: Uint8Array): number {
  const m = Math.min(Math.max(0, Math.floor(n)), perm.length, seen.length);
  seen.fill(0, 0, m);
  let longest = 0;
  for (let start = 0; start < m; start++) {
    if (seen[start] === 1) continue;
    let length = 0;
    let at = start;
    // `shuffle` leaves a permutation of [0, m), so the walk stays in range and
    // closes. The bound makes that a checked fact rather than a hope: an
    // out-of-range entry would otherwise be an endless loop, not a wrong number.
    while (at < m && seen[at] !== 1) {
      seen[at] = 1;
      length++;
      at = perm[at]!;
    }
    if (length > longest) longest = length;
  }
  return longest;
}

/**
 * The cycle lengths of `perm[0…n−1]`, longest first, into `out`. Returns how
 * many there are.
 *
 * Descending because the painter packs the loops in this order, and the loop
 * that decides the round is then the first thing on the plate. Insertion sort:
 * a permutation of n has Hₙ cycles on average — about five at n = 100 — and
 * the worst case, n fixed points, is already sorted.
 */
export function cycleLengths(perm: Int32Array, n: number, seen: Uint8Array, out: Int32Array): number {
  const m = Math.min(Math.max(0, Math.floor(n)), perm.length, seen.length, out.length);
  seen.fill(0, 0, m);
  let count = 0;
  for (let start = 0; start < m; start++) {
    if (seen[start] === 1) continue;
    let length = 0;
    let at = start;
    while (at < m && seen[at] !== 1) {
      seen[at] = 1;
      length++;
      at = perm[at]!;
    }
    let i = count++;
    for (; i > 0 && (out[i - 1] ?? 0) < length; i--) out[i] = out[i - 1]!;
    out[i] = length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// The counters for a run
// ---------------------------------------------------------------------------

/**
 * What a run of rounds accumulates, plus the history of the two running shares.
 *
 * The two `Float32Array`s are allocated once at the ceiling and are the only
 * memory a round costs. `rounds`, `wins` and `guessWins` are counters rather
 * than array lengths: a run past the history's capacity keeps counting and only
 * the curve stops gaining points — the same split between what is counted and
 * what is painted that the rest of the plate is built on.
 */
export class RunTally {
  readonly capacity: number;

  /** Running share of rounds won, one entry per round, in order. */
  private readonly chain: Float32Array;
  private readonly guess: Float32Array;

  private played = 0;
  private won = 0;
  private guessed = 0;
  private longestSum = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.chain = new Float32Array(this.capacity);
    this.guess = new Float32Array(this.capacity);
  }

  get rounds(): number {
    return this.played;
  }

  /** Rounds in which every prisoner found his own number by following the chain. */
  get wins(): number {
    return this.won;
  }

  /** Rounds in which every prisoner found his own number by opening boxes at random. */
  get guessWins(): number {
    return this.guessed;
  }

  /** Share of rounds the rule freed the room. NaN before the first round. */
  get share(): number {
    return this.won / this.played;
  }

  get guessShare(): number {
    return this.guessed / this.played;
  }

  /** Average longest loop over the run. NaN before the first round. */
  get averageLongest(): number {
    return this.longestSum / this.played;
  }

  record(longest: number, limit: number, guessWon: boolean): void {
    if (longest > 0 && longest <= limit) this.won++;
    if (guessWon) this.guessed++;
    this.longestSum += longest;
    const i = this.played++;
    if (i < this.capacity) {
      this.chain[i] = this.won / this.played;
      this.guess[i] = this.guessed / this.played;
    }
  }

  /**
   * Visit at most `maxSamples` evenly spaced rounds of the run, always
   * including the first and the last.
   *
   * This is the painted cap, and it is independent of the counters: a curve
   * drawn one vertex per round over a 650 px box would overstrike every pixel
   * three times at the 2,000-round ceiling and be no more legible for it.
   */
  forEach(maxSamples: number, cb: (round: number, share: number, guessShare: number) => void): void {
    const n = Math.min(this.played, this.capacity);
    if (n === 0) return;
    const stride = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(maxSamples))));
    for (let i = 0; i < n; i += stride) cb(i + 1, this.chain[i]!, this.guess[i]!);
    // The last round closes the curve whatever the stride stepped over.
    if ((n - 1) % stride !== 0) cb(n, this.chain[n - 1]!, this.guess[n - 1]!);
  }

  /** Forget every round. The arrays are kept; nothing reallocates. */
  reset(): void {
    this.played = 0;
    this.won = 0;
    this.guessed = 0;
    this.longestSum = 0;
  }
}
