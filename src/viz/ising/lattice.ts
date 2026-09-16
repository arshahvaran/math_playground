import type { Rng } from '../../core/types';

/**
 * The two-dimensional Ising model on a square lattice: the mathematics, with no
 * canvas in sight.
 *
 * Every site of a torus carries a spin sᵢ = ±1, and the energy is
 *
 *   E = −J Σ⟨ij⟩ sᵢ sⱼ
 *
 * over nearest-neighbour pairs. J = 1 and Boltzmann's constant is 1 throughout,
 * so `temperature` below is kT/J and nothing here carries a unit.
 *
 * Metropolis proposes flipping one spin. Flipping sᵢ changes the energy by
 * ΔE = 2 sᵢ h, where h is the sum of the four neighbours, and the move is
 * accepted with probability min(1, e^(−ΔE/T)). h is one of {−4, −2, 0, 2, 4}
 * and sᵢ is ±1, so ΔE takes exactly five values and the exponential is a
 * five-entry table rebuilt on a temperature change — `sweep()` never calls
 * `exp()`, which is the whole reason a 128² lattice holds the frame budget.
 *
 * Onsager solved the model exactly in 1944. The sheet loses its direction at
 *
 *   T_c = 2/ln(1 + √2) = 2.269185314213022,
 *
 * and below it the magnetisation per spin is
 *
 *   m(T) = [1 − sinh(2/T)^(−4)]^(1/8).
 *
 * That is the rare analytic target that is a whole *curve* rather than a single
 * number, so the tab compares its measurement against the curve at whatever
 * temperature the reader has dialled in rather than at one blessed point.
 */

/** kT_c/J = 2/ln(1 + √2) = 2.269185314213022. Onsager (1944). */
export const CRITICAL_TEMPERATURE = 2 / Math.log(1 + Math.SQRT2);

/**
 * Onsager's exact magnetisation per spin, m(T) = [1 − sinh(2/T)^(−4)]^(1/8),
 * and exactly zero at and above T_c.
 *
 * The bracket is written with a guard because it crosses zero *at* T_c: a
 * temperature an ulp below it evaluates the difference of two numbers that
 * agree to fifteen digits, and the eighth root of the resulting −1e-17 is NaN
 * rather than the 1e-3 the curve is really worth there.
 */
export function onsagerMagnetisation(temperature: number): number {
  if (!(temperature > 0)) return 1;
  if (temperature >= CRITICAL_TEMPERATURE) return 0;
  const s = Math.sinh(2 / temperature);
  const inner = 1 - 1 / (s * s * s * s);
  return inner <= 0 ? 0 : inner ** 0.125;
}

/**
 * Half-width, in temperature, of the window a grid of side `size` cannot
 * resolve.
 *
 * The correlation length diverges as ξ ~ |t|^(−ν) with t = (T − T_c)/T_c and
 * ν = 1 exactly in two dimensions. A grid of side L stops being able to tell
 * the transition apart from a smooth crossover once ξ reaches L, which is at
 * |t| = 1/L taking the microscopic length as one lattice spacing — so the
 * transition is rounded over |T − T_c| ≲ T_c/L.
 *
 * One lattice spacing is the conservative choice: the true amplitudes of ξ for
 * this model are below one in both phases, so the real rounding window is
 * narrower than this and nothing is being flattered by it.
 */
export function roundingHalfWidth(size: number): number {
  return CRITICAL_TEMPERATURE / Math.max(1, size);
}

/**
 * How far the exact curve moves across that window — the finite-size error the
 * measurement is entitled to, in units of magnetisation.
 *
 * A finite lattice does not sit on the infinite-lattice curve at T; it sits
 * somewhere on the curve smeared across [T − w, T + w]. The largest the
 * smearing can displace the reading is the largest the curve itself moves over
 * that interval, and since m is monotone the extremes are at the ends.
 */
export function roundingAllowance(temperature: number, size: number): number {
  const w = roundingHalfWidth(size);
  const m = onsagerMagnetisation(temperature);
  return Math.max(
    Math.abs(onsagerMagnetisation(temperature - w) - m),
    Math.abs(onsagerMagnetisation(temperature + w) - m),
  );
}

/**
 * Relative rounding beyond which the comparison with Onsager's curve is
 * withheld outright.
 *
 * Near T_c the allowance above runs away — at the transition itself a finite
 * lattice reads about L^(−1/8), which is 0.59 at L = 64 against an exact value
 * of zero — and a "prediction" the reading cannot miss is not a measurement.
 * The tab publishes no target inside that band and says so, exactly as the
 * bifurcation tab withholds a Feigenbaum ratio it cannot resolve.
 */
export const MAX_ROUNDING = 0.1;

/**
 * Is the exact curve worth comparing against at this temperature and size?
 *
 * False above T_c, where the exact answer is zero and a finite grid always
 * shows a little left over, and false inside the rounded band below it.
 */
export function comparable(temperature: number, size: number): boolean {
  const m = onsagerMagnetisation(temperature);
  return m > 0 && roundingAllowance(temperature, size) / m <= MAX_ROUNDING;
}

/**
 * Rounding half-widths either side of T_c that count as "right at the tipping
 * point" — four, which is where ξ has fallen to a quarter of the box.
 */
export const NEAR_TC_WIDTHS = 4;

/**
 * Is the reader standing close enough to T_c that a lattice this size cannot
 * give a straight answer on *either* side of it?
 *
 * Below T_c that is the rounded band `comparable()` already refuses. Above it
 * the exact answer is zero, but a finite lattice does not read anything like
 * zero until the correlation length is well inside the box: at T_c + 0.03 on a
 * 64² sheet it still reads about 0.4, because the patches are as big as the
 * plate and the whole sheet swings between them. Telling a reader the answer is
 * 0 while the number in front of them is 0.4 would be a worse lie than saying
 * the grid is too small to tell — which is the truth.
 */
export function nearCritical(temperature: number, size: number): boolean {
  return Math.abs(temperature - CRITICAL_TEMPERATURE) <= NEAR_TC_WIDTHS * roundingHalfWidth(size);
}

/**
 * Sweeps averaged into one block before the block mean joins the error
 * estimate.
 *
 * Successive sweeps are correlated, so the spread of the individual readings
 * understates the error of their average. Averaging in blocks much longer than
 * the correlation time and taking the spread of the *block* means fixes that.
 * Away from T_c single-spin-flip dynamics decorrelate the magnetisation in a
 * handful of sweeps, so twenty is several correlation times; within the
 * excluded band it is not — critical slowing down takes the correlation time to
 * roughly L^2.17 — which is one more reason the comparison is withheld there.
 */
export const BLOCK_SWEEPS = 20;

/**
 * Sweeps in the average — a trailing window, not a running total.
 *
 * The reader turns the temperature while the sheet is running, and the sheet
 * then has to cross from one equilibrium to another. A cumulative average
 * carries that crossing forever: measured against a lattice cooled from 2.6 to
 * 2.0, a cumulative mean over a thousand sweeps at L = 128 read 0.51 while the
 * sheet itself was sitting at 0.92, because most of those sweeps were spent
 * coarsening. A window forgets it instead, and the reading heals on its own
 * after `BURN_IN_SWEEPS + WINDOW_SWEEPS` — which is what an interactive knob
 * needs and is still a time average with an excluded burn-in.
 *
 * 400 sweeps is 3.3 seconds of animation, and at twenty per block it leaves
 * twenty block means for the error — enough for their spread to mean something.
 */
export const WINDOW_SWEEPS = 400;

/** Blocks the window holds. */
const WINDOW_BLOCKS = WINDOW_SWEEPS / BLOCK_SWEEPS;

/**
 * Sweeps thrown away after every temperature change, so the window is never a
 * mixture of two temperatures.
 *
 * From an ordered start the sheet relaxes in a handful of sweeps everywhere
 * outside the excluded band, so a hundred is many relaxation times. After a
 * deep quench it is not — nothing short of L² sweeps is — and that is what the
 * window rather than the burn-in is there for.
 */
export const BURN_IN_SWEEPS = 100;

/** Possible values of s·h, hence of ΔE = 2·s·h: {−4, −2, 0, 2, 4}. */
const ACCEPT_STATES = 5;

/**
 * A square lattice of spins under Metropolis dynamics, plus the time average of
 * |M| that the tab measures.
 *
 * The spin array is allocated once at `maxSize²` and never reallocated: a size
 * change re-reads the same buffer at a different stride. Everything the painter
 * needs is `spins` and `size`; everything the ledger needs is a getter.
 */
export class SpinLattice {
  readonly maxSize: number;

  /**
   * 1 for up, 0 for down, row-major with stride `size`. Stored as bytes rather
   * than as ±1 so the four neighbours add with three integer adds and the ±1
   * sum comes out as 2·sum − 4.
   */
  readonly spins: Uint8Array;

  /** e^(−ΔE/T) indexed by (s·h + 4)/2, and exactly 1 wherever ΔE ≤ 0. */
  private readonly accept = new Float64Array(ACCEPT_STATES);

  /** The trailing window of per-sweep |M|, oldest entry at `windowHead`. */
  private readonly window = new Float64Array(WINDOW_SWEEPS);
  /** Closed block means inside that window, for the error of the average. */
  private readonly blockMeans = new Float64Array(WINDOW_BLOCKS);

  private currentSize: number;
  private currentTemperature: number;

  /** Up spins in the live block; the magnetisation per spin is 2·ups/N − 1. */
  private ups = 0;
  /** Σ⟨ij⟩ sᵢsⱼ over the live block, carried by the accepted flips. */
  private bonds = 0;

  private sweepCount = 0;
  private burnLeft = 0;

  private windowHead = 0;
  private windowFill = 0;
  private windowSum = 0;

  private blockHead = 0;
  private blockFill = 0;
  private blockSum = 0;
  private blockCount = 0;

  constructor(maxSize: number, temperature: number) {
    this.maxSize = Math.max(2, Math.floor(maxSize));
    this.spins = new Uint8Array(this.maxSize * this.maxSize);
    this.currentSize = this.maxSize;
    this.currentTemperature = temperature > 0 ? temperature : CRITICAL_TEMPERATURE;
    this.buildTable();
    this.reset();
  }

  get size(): number {
    return this.currentSize;
  }

  /** Sites in the live block, L². */
  get spinCount(): number {
    return this.currentSize * this.currentSize;
  }

  get temperature(): number {
    return this.currentTemperature;
  }

  /** Sweeps run at the current temperature, burn-in included. */
  get sweeps(): number {
    return this.sweepCount;
  }

  /** Sweeps still to be thrown away before the average starts. */
  get burnInLeft(): number {
    return this.burnLeft;
  }

  /** Sweeps in the window, at most `WINDOW_SWEEPS`. */
  get measuredSweeps(): number {
    return this.windowFill;
  }

  /** |M| per spin right now. */
  get liveMagnetisation(): number {
    return Math.abs((2 * this.ups) / this.spinCount - 1);
  }

  /** |M| per spin averaged over the window. NaN before the first measured sweep. */
  get magnetisation(): number {
    return this.windowFill === 0 ? NaN : this.windowSum / this.windowFill;
  }

  /** E/N right now, in units of J. −2 for a perfectly ordered sheet. */
  get energyPerSpin(): number {
    return -this.bonds / this.spinCount;
  }

  /**
   * Error of the average, from the spread of the closed block means: for n of
   * them the standard error of their mean is √(Σ(x − x̄)²/(n(n − 1))). NaN
   * until two blocks have closed.
   *
   * It is the error of the *block* mean rather than of the window mean, which
   * also carries a partial block; the two differ by less than the figure itself
   * and this is the one with a derivation behind it.
   */
  get averageError(): number {
    const n = this.blockCount;
    if (n < 2) return NaN;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.blockMeans[i]!;
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = this.blockMeans[i]! - mean;
      ss += d * d;
    }
    return Math.sqrt(ss / (n * (n - 1)));
  }

  /** A new lattice: a new experiment, so the sheet is re-laid and the average cleared. */
  setSize(size: number): void {
    const clamped = Math.max(2, Math.min(this.maxSize, Math.floor(size)));
    if (clamped === this.currentSize) return;
    this.currentSize = clamped;
    this.reset();
  }

  /**
   * Warm or cool the sheet *without* re-laying it.
   *
   * The spins carry over on purpose: turning the temperature down through T_c
   * and watching the domains coarsen until one of them owns the sheet is the
   * whole point of the tab, and that only happens if the configuration the
   * reader is looking at is the one that gets cooled. Only the measurement
   * restarts — the sweeps taken at the old temperature say nothing about the
   * new one.
   */
  setTemperature(temperature: number): void {
    if (!(temperature > 0) || temperature === this.currentTemperature) return;
    this.currentTemperature = temperature;
    this.buildTable();
    this.restartMeasurement();
  }

  /**
   * Lay every spin up, and clear the average.
   *
   * An ordered start, not a random one, and the difference is not cosmetic. A
   * random sheet is the equilibrium state at infinite temperature; quenched
   * straight to a low temperature it coarsens diffusively, so the domains need
   * of order L² sweeps to reach the size of the box — 4,000 sweeps at L = 64 —
   * and about a third of the time it freezes into a stripe that wraps the torus
   * and never decays at all. Either way the reading would be a number the
   * reader watches disagree with the exact curve for a minute. From an ordered
   * start the sheet relaxes to equilibrium in a handful of sweeps everywhere
   * except inside the excluded band, and it relaxes *down* to the right answer
   * rather than crawling up to it.
   */
  reset(): void {
    const n = this.spinCount;
    this.spins.fill(1, 0, n);
    this.ups = n;
    // Every one of the 2N bonds on the torus is satisfied.
    this.bonds = 2 * n;
    this.restartMeasurement();
  }

  /**
   * One sweep: two checkerboard half-passes over the lattice.
   *
   * Sites of one colour have no neighbour of the same colour, so each half-pass
   * updates a set of conditionally independent spins and the composite is a
   * correct Metropolis chain. It is also half the random draws of picking L²
   * sites at random, and it touches memory in row order.
   *
   * The draw is taken only when the move can be refused — ΔE ≤ 0 is accepted
   * outright — which is deterministic given the configuration, so a seed still
   * reproduces the run exactly.
   */
  sweep(rng: Rng): void {
    const L = this.currentSize;
    const spins = this.spins;
    const accept = this.accept;
    let ups = this.ups;
    let bonds = this.bonds;

    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < L; y++) {
        const row = y * L;
        const above = (y === 0 ? L - 1 : y - 1) * L;
        const below = (y + 1 === L ? 0 : y + 1) * L;
        // (x + y) even is one colour, odd the other.
        for (let x = (y + parity) & 1; x < L; x += 2) {
          const i = row + x;
          const s = spins[i]!;
          const sum4 =
            spins[above + x]! +
            spins[below + x]! +
            spins[row + (x === 0 ? L - 1 : x - 1)]! +
            spins[row + (x + 1 === L ? 0 : x + 1)]!;
          // Neighbours are bytes, so their ±1 sum h is 2·sum4 − 4; s·h carries
          // the sign of this spin.
          const sh = s === 1 ? 2 * sum4 - 4 : 4 - 2 * sum4;
          const p = accept[(sh + 4) >> 1]!;
          if (p < 1 && rng.next() >= p) continue;
          spins[i] = s ^ 1;
          ups += s === 1 ? -1 : 1;
          // E = −Σ sᵢsⱼ and the four bonds at this site carry s·h, so the bond
          // sum moves by −2·s·h and the energy by +2·s·h.
          bonds -= 2 * sh;
        }
      }
    }

    this.ups = ups;
    this.bonds = bonds;
    this.sweepCount++;
    this.record();
  }

  /** Rebuild the five-entry acceptance table for the current temperature. */
  private buildTable(): void {
    const t = this.currentTemperature;
    for (let k = 0; k < ACCEPT_STATES; k++) {
      const sh = 2 * k - 4;
      const dE = 2 * sh;
      this.accept[k] = dE <= 0 ? 1 : Math.exp(-dE / t);
    }
  }

  private restartMeasurement(): void {
    this.sweepCount = 0;
    this.burnLeft = BURN_IN_SWEEPS;
    this.windowHead = 0;
    this.windowFill = 0;
    this.windowSum = 0;
    this.blockHead = 0;
    this.blockFill = 0;
    this.blockSum = 0;
    this.blockCount = 0;
  }

  /**
   * Fold this sweep into the window, or spend it on the burn-in.
   *
   * The window is a ring: once full, the sweep entering pushes the oldest one
   * out of the running sum, so the average always covers exactly the last
   * `WINDOW_SWEEPS`. Every entry is in [0, 1] and positive, so the running sum
   * loses about n·ε relative — 2e-10 after a million sweeps — and never needs
   * rebuilding.
   */
  private record(): void {
    if (this.burnLeft > 0) {
      this.burnLeft--;
      return;
    }
    const m = this.liveMagnetisation;

    if (this.windowFill === WINDOW_SWEEPS) this.windowSum -= this.window[this.windowHead]!;
    else this.windowFill++;
    this.window[this.windowHead] = m;
    this.windowSum += m;
    this.windowHead = this.windowHead + 1 === WINDOW_SWEEPS ? 0 : this.windowHead + 1;

    this.blockSum += m;
    this.blockFill++;
    if (this.blockFill === BLOCK_SWEEPS) {
      this.blockMeans[this.blockHead] = this.blockSum / BLOCK_SWEEPS;
      this.blockHead = this.blockHead + 1 === WINDOW_BLOCKS ? 0 : this.blockHead + 1;
      if (this.blockCount < WINDOW_BLOCKS) this.blockCount++;
      this.blockSum = 0;
      this.blockFill = 0;
    }
  }
}
