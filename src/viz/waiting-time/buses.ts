import type { Rng } from '../../core/types';
import { Welford } from '../../core/stats';

/**
 * Why your bus is always late: the mathematics, with no canvas in sight.
 *
 * Buses leave gaps X₁, X₂, … drawn independently from one law with mean μ and
 * standard deviation σ. Somebody who turns up at a moment picked uniformly over
 * the timetable does *not* land in a gap drawn from that law. A gap of length x
 * covers x minutes of the timetable, so it is x times as likely to be the one
 * caught: the gap a random arrival lands in is drawn from the length-biased
 * density x·f(x)/μ, whose mean is
 *
 *   E[X²]/E[X] = μ + σ²/μ
 *
 * and the arrival is uniform inside whichever gap it caught, so
 *
 *   E[wait] = μ/2 + σ²/(2μ)
 *
 * The first term is the answer everybody gives. The second is the whole
 * surprise, and it is exactly zero when every gap is identical. For a Poisson
 * timetable σ = μ, the gap caught averages 2μ and the wait averages μ — double
 * the naive answer, for buses whose average gap never moved.
 *
 * Sourcing note. Wikipedia carries the paradox as a statement about the rider
 * seeing more delay than the operator, not the formula; μ + σ²/μ appears on the
 * friendship-paradox page, and the renewal-theory derivation from the
 * length-biased density is in Karl Sigman's Columbia notes. Same identity,
 * different setting: it is why your friends have more friends than you do.
 */

// ---------------------------------------------------------------------------
// The timetable law
// ---------------------------------------------------------------------------

/**
 * The average gap between buses, in minutes.
 *
 * Not a control. The entire argument is that the wait climbs while the average
 * gap stands still, and a reader who can move both has no way to see it: a
 * longer wait would always have the boring explanation available. Ten is the
 * number the story is told with everywhere.
 */
export const MEAN_GAP = 10;

/** Half the average gap — the answer everybody gives, and the line the measurement never reaches. */
export const NAIVE_WAIT = MEAN_GAP / 2;

/**
 * Top of the irregularity dial: σ/μ = 1, a Poisson timetable.
 *
 * It is also exactly where the gamma family below stops needing a second
 * algorithm — see `sampleGap` — so the dial's ceiling and the sampler's domain
 * are the same fact rather than two that have to be kept in step.
 */
export const MAX_IRREGULARITY = 1;

/** σ/μ, clamped to the dial. A non-finite value reads as a perfect timetable. */
function clampCv(cv: number): number {
  return Number.isFinite(cv) ? Math.min(MAX_IRREGULARITY, Math.max(0, cv)) : 0;
}

/**
 * Gamma shape k = 1/cv², the dial's other face.
 *
 * Gamma is the one family that runs from a perfect timetable to a Poisson one
 * along a single parameter: mean kθ, variance kθ², so σ/μ = 1/√k whatever θ is.
 * Fixing μ and turning k from ∞ down to 1 walks the timetable from clockwork
 * through mildly ragged to exponential without the average gap moving once,
 * which is the one thing this tab must be able to promise.
 *
 * Infinite at cv = 0: the degenerate gap is not a gamma and is handled apart.
 */
export function gapShape(cv: number): number {
  const c = clampCv(cv);
  return c === 0 ? Infinity : 1 / (c * c);
}

/** σ = μ·cv, the spread of the gaps themselves — not of the waits. */
export function gapStddev(cv: number): number {
  return MEAN_GAP * clampCv(cv);
}

/** The gap a random arrival lands in: E[X²]/E[X] = μ + σ²/μ = μ(1 + cv²). */
export function experiencedGap(cv: number): number {
  const c = clampCv(cv);
  return MEAN_GAP * (1 + c * c);
}

/** Half of it: μ/2 + σ²/(2μ). The naive answer plus the excess the tab is about. */
export function expectedWait(cv: number): number {
  return experiencedGap(cv) / 2;
}

/**
 * One gap, in minutes: Gamma(k = 1/cv², θ = μ·cv²), by Marsaglia and Tsang
 * (2000), "A simple method for generating gamma variables".
 *
 * The dial stops at cv = 1, so k ≥ 1 and d = k − 1/3 ≥ 2/3 throughout; the
 * boost step that method needs for k < 1 is therefore unreachable and is not
 * written. Acceptance is above 95% at every k in range, and the squeeze on the
 * first line takes most draws without a logarithm.
 *
 * At cv = 0 the gap is exactly μ and **no draw is taken at all**. That is not a
 * shortcut: a degenerate timetable has nothing to draw, and spending a uniform
 * on it would make the passenger stream for a seed depend on a parameter that
 * is meant to have removed all the randomness from the buses.
 *
 * The number of draws per gap varies, because rejection sampling. Determinism
 * does not care — the stream is still a pure function of the seed — but it does
 * mean the timetable must be generated in one pass before any passenger is
 * dropped, which is what `Timetable.generate` is for.
 */
export function sampleGap(rng: Rng, cv: number): number {
  const c = clampCv(cv);
  if (c === 0) return MEAN_GAP;
  const k = 1 / (c * c);
  const scale = MEAN_GAP * c * c;
  const d = k - 1 / 3;
  const spread = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = rng.normal();
      v = 1 + spread * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    const xx = x * x;
    // The squeeze: accepts on a polynomial, so the logarithms below are only
    // reached by a few draws in a hundred.
    if (u < 1 - 0.0331 * xx * xx) return d * v * scale;
    if (Math.log(u) < 0.5 * xx + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/**
 * Standard error of the average wait after `passengers` arrivals onto a
 * timetable of `gaps` gaps. Two independent sources, and the second one does
 * not shrink with the passenger count — which is why the tab publishes what
 * this run's own gaps predict alongside what the law predicts.
 *
 * **Passenger sampling.** Given the timetable, each arrival is an independent
 * draw of U·X*, with X* the length-biased gap and U uniform on [0, 1). Writing
 * A = 1 + cv², B = 1 + 2cv² and using the gamma moments
 * E[Xʲ] = μʲ·∏(1 + (i−1)cv²):
 *
 *   E[wait²] = E[X³]/(3E[X]) = μ²AB/3      E[wait] = μA/2
 *   Var(wait) = μ²(AB/3 − A²/4)
 *
 * which is μ²/12 at cv = 0 (uniform over a fixed gap) and μ² at cv = 1, where
 * the memoryless property makes the wait itself exponential with mean μ.
 *
 * **Timetable sampling.** The measurement converges, for a fixed seed, on that
 * timetable's own M₂/(2M₁). By the delta method on the sample moments, with
 * R = μA and E = 1 + 3cv²:
 *
 *   Var ≈ Var(X² − R·X) / (4μ²·G) = μ²·A·(BE + A − 2AB + A·cv²) / (4G)
 *
 * which is exactly 0 at cv = 0 — every timetable is the same timetable — and
 * 2μ²/G at cv = 1.
 *
 * Infinite with no passengers or no timetable: no draws, no information.
 */
export function waitStandardError(cv: number, passengers: number, gaps: number): number {
  const n = Math.floor(passengers);
  const g = Math.floor(gaps);
  if (!(n > 0) || !(g > 0)) return Infinity;
  const c2 = clampCv(cv) ** 2;
  const a = 1 + c2;
  const b = 1 + 2 * c2;
  const e = 1 + 3 * c2;
  const mu2 = MEAN_GAP * MEAN_GAP;
  const perPassenger = mu2 * ((a * b) / 3 - (a * a) / 4);
  const perTimetable = (mu2 * a * (b * e + a - 2 * a * b + a * c2)) / 4;
  return Math.sqrt(perPassenger / n + perTimetable / g);
}

// ---------------------------------------------------------------------------
// The timetable
// ---------------------------------------------------------------------------

/**
 * One drawn timetable: the bus times, and the moments of the gaps between them.
 *
 * Bus times rather than gap lengths, because the experiment is "drop a
 * passenger at a uniformly random moment and find the next bus", and that is a
 * search over a sorted array of times. The gap lengths are one subtraction
 * away; the moments are accumulated as the gaps are drawn.
 *
 * `Float64Array`, not `Float32Array`. A 25,000-gap timetable runs to a quarter
 * of a million minutes, and single precision there quantises a bus time to
 * about 0.02 minutes — a full second of error on a gap that can itself be a few
 * seconds long at cv = 1, which would show up as a passenger waiting a
 * negative amount of time.
 */
export class Timetable {
  /** Most gaps this can hold. The array is allocated here once and never again. */
  readonly capacity: number;

  /** `count + 1` bus times in minutes, the first at zero, strictly increasing. */
  private readonly times: Float64Array;
  private count = 0;

  /**
   * The gaps' own mean and variance, by Welford: the timetable's honest
   * self-report, which is what the measured wait actually converges to.
   */
  private readonly moments = new Welford();

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.times = new Float64Array(this.capacity + 1);
  }

  /** Gaps currently drawn, at most `capacity`. */
  get gaps(): number {
    return this.count;
  }

  /** Length of the whole timetable, minutes. Zero before the first `generate`. */
  get totalMinutes(): number {
    return this.times[this.count] ?? 0;
  }

  /** This timetable's own average gap. NaN before the first `generate`. */
  get gapMean(): number {
    return this.moments.mean;
  }

  /** This timetable's own gap spread, σ. NaN before the first `generate`. */
  get gapStddev(): number {
    return this.moments.stddev;
  }

  /**
   * What *this* timetable predicts a passenger waits: M₂/(2M₁), with
   * M₂ = Var + Mean² taken from the Welford accumulator rather than from a
   * running Σx², which cancels catastrophically once the mean is large beside
   * the spread — the regular end of the dial is exactly that case.
   */
  get predictedWait(): number {
    const m1 = this.moments.mean;
    const m2 = this.moments.variance + m1 * m1;
    return m2 / (2 * m1);
  }

  /**
   * Draw a fresh timetable of `gaps` gaps. One pass, one rng, allocating
   * nothing: the array is the one the constructor made.
   */
  generate(rng: Rng, cv: number, gaps: number): void {
    const n = Math.min(this.capacity, Math.max(1, Math.floor(gaps)));
    this.count = n;
    this.moments.reset();
    this.times[0] = 0;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const gap = sampleGap(rng, cv);
      t += gap;
      this.times[i + 1] = t;
      this.moments.push(gap);
    }
  }

  /** Time of bus `i`, minutes. Clamped to the drawn timetable at both ends. */
  busTime(i: number): number {
    const k = Math.min(this.count, Math.max(0, Math.floor(i)));
    return this.times[k] ?? 0;
  }

  /** Length of gap `i`, minutes: the wait of somebody who just missed bus `i`. */
  gapLength(i: number): number {
    return this.busTime(i + 1) - this.busTime(i);
  }

  /**
   * Which gap the moment `t` falls in — the largest `i` with `busTime(i) ≤ t`.
   *
   * Binary search rather than a walk, because a passenger lands anywhere in a
   * timetable of up to 25,000 gaps and there is no locality between one
   * passenger and the next. Fifteen comparisons; a walk would be twelve
   * thousand.
   */
  gapAt(t: number): number {
    if (!(t > 0)) return 0;
    if (t >= this.totalMinutes) return this.count - 1;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.times[mid] ?? 0) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

// ---------------------------------------------------------------------------
// The passengers
// ---------------------------------------------------------------------------

/** One arrival at the stop, in minutes of timetable rather than in pixels. */
export interface Arrival {
  /** Minutes after the first bus. Uniform over the whole timetable. */
  time: number;
  /** Index of the gap it landed in. */
  gap: number;
  /** Minutes until the next bus — what this passenger actually waits. */
  wait: number;
  /** Where in the band the dot sits, in [0, 1). A painting draw, nothing more. */
  lane: number;
}

/**
 * One passenger. Two draws from `rng`, always in this order — the moment, then
 * the lane — so a seed reproduces the crowd exactly, and the lane is taken for
 * every passenger rather than only for the painted ones so that the stream does
 * not depend on which stretch of timetable the plate happens to show.
 *
 * The moment is uniform over the whole timetable, which is the entire
 * experiment: nothing here picks a gap, and that is why a long gap ends up with
 * more passengers in it than a short one. Length-biasing is not modelled, it is
 * what happens.
 */
export function dropPassenger(rng: Rng, table: Timetable): Arrival {
  const time = rng.next() * table.totalMinutes;
  const lane = rng.next();
  const gap = table.gapAt(time);
  // The subtraction is exact in double precision and `gapAt` is exclusive at
  // the top, so this is positive; the clamp is against a zero-length timetable.
  return { time, gap, wait: Math.max(0, table.busTime(gap + 1) - time), lane };
}

// ---------------------------------------------------------------------------
// The settling curve
// ---------------------------------------------------------------------------

/** Samples per decade of the passenger count kept in the history. */
const SAMPLES_PER_DECADE = 48;

/**
 * Slots in the history: six decades of passengers.
 *
 * The settling chart has a logarithmic x axis, so its points are wanted at
 * equal *ratios* of the count, not at equal counts — 48 per decade is about a
 * pixel apart on a 300 px axis. The passengers fader stops at 50,000, which
 * measures 174 points: twenty ungated at the head and 3.38 decades of ratio
 * steps after them. So a run in the app never wraps the ring, and the wrap is
 * the guarantee that a longer one would degrade by forgetting its left end
 * rather than by growing without bound.
 */
const HISTORY_CAPACITY = 6 * SAMPLES_PER_DECADE;

/** Ratio between consecutive sampled counts: 10^(1/48) = 1.04914. */
const HISTORY_STEP = 10 ** (1 / SAMPLES_PER_DECADE);

/**
 * The running average wait against the passenger count, sampled logarithmically.
 *
 * The gate is `ceil(n · 10^(1/48))` with a floor of one passenger, so the first
 * twenty arrivals are all recorded — below n = 21 the ratio step is under one
 * whole passenger — and the sampling thins after that. That keeps the left end
 * of the curve, which is where the wandering that the chart exists to show
 * actually happens, and still fits fifty thousand passengers in a few hundred
 * points.
 */
export class WaitHistory {
  readonly capacity: number;

  private readonly ns: Float64Array;
  private readonly waits: Float64Array;

  private head = 0;
  private stored = 0;
  /** The next passenger count that will be recorded. */
  private gate = 1;

  constructor(capacity: number = HISTORY_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.ns = new Float64Array(this.capacity);
    this.waits = new Float64Array(this.capacity);
  }

  /** Samples held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Record the running average if `passengers` has reached the next gate. */
  sample(passengers: number, meanWait: number): void {
    if (passengers < this.gate) return;
    const i = this.head;
    this.ns[i] = passengers;
    this.waits[i] = meanWait;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
    this.gate = Math.max(passengers + 1, Math.ceil(passengers * HISTORY_STEP));
  }

  /** Visit the samples oldest first, which on a log axis is left to right. */
  forEach(cb: (n: number, meanWait: number, index: number) => void): void {
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.ns[slot] ?? 0, this.waits[slot] ?? 0, i);
    }
  }

  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.gate = 1;
  }
}

// ---------------------------------------------------------------------------
// The crowd that gets painted
// ---------------------------------------------------------------------------

/**
 * The passengers that land inside the painted window, plus the statistics of
 * every passenger who ever turned up.
 *
 * The split is the point. `passengers`, `meanWait` and `meanGap` count the
 * whole run — tens of thousands of arrivals scattered over a timetable days
 * long — while only the handful who landed in the stretch of timetable on
 * screen are stored, in typed arrays allocated once at the budget. Buffon
 * learned this the expensive way: twenty thousand painted needles made its
 * plate unreadable while its counters were perfectly happy.
 */
export class Crowd {
  readonly capacity: number;

  /** Arrival moment in minutes, and the lane, for the painted passengers only. */
  private readonly times: Float32Array;
  private readonly lanes: Float32Array;

  private head = 0;
  private stored = 0;

  /** Waits and gaps landed in, over every passenger — painted or not. */
  private readonly waits = new Welford();
  private readonly gaps = new Welford();

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.times = new Float32Array(this.capacity);
    this.lanes = new Float32Array(this.capacity);
  }

  /** Painted passengers currently held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Every passenger since the last reset, painted or not. */
  get passengers(): number {
    return this.waits.n;
  }

  /** The measurement: average wait over every passenger. NaN before the first. */
  get meanWait(): number {
    return this.waits.mean;
  }

  /** Average length of the gap a passenger landed in. NaN before the first. */
  get meanGap(): number {
    return this.gaps.mean;
  }

  /**
   * Count one arrival, and keep it for painting when `paint` is true.
   *
   * `gapLength` is passed in rather than looked up, because the caller has the
   * timetable and this class deliberately does not.
   */
  push(a: Arrival, gapLength: number, paint: boolean): void {
    this.waits.push(a.wait);
    this.gaps.push(gapLength);
    if (!paint) return;
    const i = this.head;
    this.times[i] = a.time;
    this.lanes[i] = a.lane;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
  }

  /** Visit the painted passengers oldest first. */
  forEach(cb: (time: number, lane: number, index: number) => void): void {
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.times[slot] ?? 0, this.lanes[slot] ?? 0, i);
    }
  }

  /** Forget everybody and zero the statistics. The arrays are kept. */
  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.waits.reset();
    this.gaps.reset();
  }
}
