import type { Rng } from '../../core/types';

/**
 * Coupled oscillators: the mathematics, with no canvas in sight.
 *
 * `N` oscillators, each turning at its own natural speed `ωᵢ`, each pulled a
 * little towards every other one:
 *
 *   dθᵢ/dt = ωᵢ + (K/N)·Σⱼ sin(θⱼ − θᵢ)
 *
 * Write the average of the unit phase vectors as one complex number,
 * `r·e^{iψ} = (1/N)·Σⱼ e^{iθⱼ}`. Expanding the sine and substituting collapses
 * the double sum to a single mean field,
 *
 *   dθᵢ/dt = ωᵢ + K·r·sin(ψ − θᵢ)
 *
 * which is the same dynamics at O(N) instead of O(N²) — and it is what lets
 * this tab carry two thousand oscillators instead of a hundred. `r` is the
 * length of that average vector: 0 when the phases are spread evenly round the
 * circle, 1 when they all coincide. It is the number the tab measures and the
 * arrow the tab draws, which are the same object.
 *
 * With natural speeds drawn from a Lorentzian (Cauchy) density of half-width γ
 * the whole transition is exact. Kuramoto's self-consistency condition
 * `r = ∫ √(1 − (ω/Kr)²)·g(ω) dω` over the locked band `|ω| ≤ K·r` integrates in
 * closed form for that density to
 *
 *   Φ(r) = (√(γ² + K²r²) − γ) / (K·r)
 *
 * and `Φ(r) = r` gives `r² = 1 − 2γ/K`. So the threshold is `Kc = 2γ` and above
 * it `r = √(1 − Kc/K)` exactly — 0.707107 at γ = 1, K = 4. Below it `r` is zero
 * in the infinite limit only; a finite crowd always reads a floor of order
 * 1/√N, which `incoherentFloor` states and the tolerances here allow for.
 */

export const TAU = 2 * Math.PI;

/**
 * Half-width of the Lorentzian the natural speeds are drawn from.
 *
 * Pinned rather than offered as a control. It is the one quantity besides the
 * coupling that moves the answer, and fixing it at 1 puts the threshold on
 * `Kc = 2γ` = 2 — a landmark a reader can watch the coupling cross without
 * first having to work out where it is. Everything below still takes γ as an
 * argument, so the mathematics is general if it is ever wanted back.
 */
export const HALF_WIDTH = 1;

/**
 * Mean length of the average of N unit vectors with independent uniform
 * phases, in units of 1/√N: the sum is a two-dimensional random walk, so each
 * component is normal with variance N/2, the length is Rayleigh with σ = √(N/2),
 * and E|R| = σ·√(π/2) = √(πN)/2. Divided by N that is 0.886227/√N.
 */
export const INCOHERENT_MEAN = Math.sqrt(Math.PI) / 2;

/**
 * One natural speed by inverse CDF, `ω = γ·tan(π(u − ½))` for `u` uniform in
 * [0, 1).
 *
 * Drawn this way — one uniform in, one speed out — rather than by rejection, so
 * the crowd is a pure function of the seed and the draw order, which is what
 * makes a permalink reproduce the run someone else saw.
 *
 * The Lorentzian's tails are heavy by construction: the fastest speed in a
 * crowd of N is of order γ·N/π, and one draw in 10⁹ is faster still. Those
 * oscillators are integrated with a large phase error per step and it does not
 * matter — a drifter contributes a phase-averaged zero to the mean field
 * whether its phase is right or not, and it carries 1/N of the sum.
 */
export function naturalSpeed(u: number, gamma: number): number {
  return gamma * Math.tan(Math.PI * (u - 0.5));
}

/** The coupling at which the crowd starts to fall into step: `Kc = 2γ`. */
export function criticalCoupling(gamma: number): number {
  return 2 * gamma;
}

/**
 * `√(1 − Kc/K)` above the threshold, exactly 0 below it.
 *
 * The square root leaves zero with infinite slope, which is why the reading
 * lifts off almost vertically rather than easing away from the axis.
 */
export function analyticOrder(coupling: number, gamma: number): number {
  const kc = criticalCoupling(gamma);
  return coupling > kc ? Math.sqrt(1 - kc / coupling) : 0;
}

/**
 * Typical reading below the threshold for a crowd of `n`.
 *
 * `INCOHERENT_MEAN/√n` is the floor with no coupling at all. Coupling that is
 * not yet enough to lock anything still amplifies the fluctuation, by the
 * linear-response factor `1/√(1 − K/Kc)` — the same divergence that makes the
 * threshold a threshold. Verified against the catalogue's measurements at
 * N = 4000, γ = 0.5: this gives 0.0198 at K = 0.5 and 0.0313 at K = 0.8 against
 * measured 0.024 and 0.041, so it is the right size and mildly optimistic,
 * which is why the readout allows three of it and the tests four.
 *
 * Infinite at and above the threshold, where there is no floor to state.
 */
export function incoherentFloor(coupling: number, gamma: number, n: number): number {
  const kc = criticalCoupling(gamma);
  const damping = 1 - coupling / kc;
  if (!(n > 0) || !(damping > 0)) return Infinity;
  return INCOHERENT_MEAN / Math.sqrt(n * damping);
}

/**
 * Spread of the locked-band summand at the solution: √(E[f²] − r²) where
 * `f(ω) = √(1 − (ω/Kr)²)` on `|ω| ≤ Kr` and 0 outside.
 *
 * The same integral as the self-consistency condition, with the square root
 * squared, which for a Lorentzian is elementary:
 *
 *   E[f²] = (2/π)·[ arctan(s/γ)·(1 + γ²/s²) − γ/s ],  s = K·r
 *
 * This is the spread of one oscillator's contribution to the sum that defines
 * `r`, and it is what the sampling error below is built from. NaN at or below
 * the threshold, where there is no locked band.
 */
export function lockedSpread(coupling: number, gamma: number): number {
  const r = analyticOrder(coupling, gamma);
  if (!(r > 0)) return NaN;
  const s = coupling * r;
  const second = (2 / Math.PI) * (Math.atan(s / gamma) * (1 + (gamma * gamma) / (s * s)) - gamma / s);
  return Math.sqrt(Math.max(0, second - r * r));
}

/**
 * Standard error of the settled reading above the threshold, for a crowd of `n`.
 *
 * Averaging over time kills the dynamical jitter but not this: the `n` natural
 * speeds are drawn once and then never change, so their empirical density is a
 * fixed sample of the Lorentzian and the `r` it supports is a fixed distance
 * from the exact one. That quenched error is what the bar has to cover.
 *
 * The self-consistency condition is `r = Φ(r)`; with an empirical density it is
 * `r̂ = Φ(r̂) + ε` where ε is a sample mean of `n` draws of `f`, so
 * `sd(ε) = lockedSpread/√n`. Linearising, `r̂ − r ≈ ε/(1 − Φ′(r))`, and for the
 * Lorentzian `Φ′(r) = γ/(K − γ)`, so the amplification is exactly
 * `(K − γ)/(K − Kc)`:
 *
 *   sd(r̂) ≈ (lockedSpread/√n)·(K − γ)/(K − Kc)
 *
 * It diverges at the threshold, which is the physics rather than a defect — the
 * response to a perturbation is infinite there — so it is capped at 1, past
 * which `r` itself cannot go and the bar has stopped saying anything.
 *
 * Checked against the catalogue's simulated readings at N = 4000, γ = 0.5: this
 * gives 0.0054 at K = 4 and 0.0242 at K = 1.2, against measured errors of
 * 0.0016 and 0.0021.
 */
export function lockedStandardError(coupling: number, gamma: number, n: number): number {
  const kc = criticalCoupling(gamma);
  if (!(n > 0) || !(coupling > kc)) return Infinity;
  const amplify = (coupling - gamma) / (coupling - kc);
  return Math.min(1, (lockedSpread(coupling, gamma) / Math.sqrt(n)) * amplify);
}

/**
 * How far the settled reading may honestly sit from `analyticOrder`, either
 * side of the threshold: the finite-crowd floor below, the quenched sampling
 * error above. One number, so the readout's tolerance and the tests derive from
 * the same statement.
 */
export function orderUncertainty(coupling: number, gamma: number, n: number): number {
  const kc = criticalCoupling(gamma);
  const u = coupling > kc ? lockedStandardError(coupling, gamma, n) : incoherentFloor(coupling, gamma, n);
  return Math.min(1, u);
}

/**
 * Bars either side of the exact answer inside which a reading counts as
 * agreeing with it. Three, matching every other tab in the app, and exported
 * so the readout's tolerance and the band below cannot drift apart.
 */
export const BAND_SIGMAS = 3;

/**
 * How large the finite-crowd floor may be before the tab stops calling the
 * exact answer a prediction.
 *
 * Below the threshold the exact answer is zero and the floor is what a crowd of
 * `n` actually reads, so the floor *is* the bar. Past about an eighth of the
 * way up an axis that runs to one, the average vector is visibly lopsided on
 * the plate and quoting "matches the prediction of 0" beside it would be a lie
 * told by arithmetic. It is a display decision, and this is where it is made.
 *
 * The smallest crowd the tab offers never clears it — 0.886/√50 is 0.125 with
 * no coupling at all — and that is the control earning its place rather than a
 * bound set too tight: fifty oscillators cannot tell zero from their own
 * wobble, and the tab should say so instead of pretending otherwise.
 */
const FLOOR_CEILING = 0.12;

/**
 * Is the exact answer worth quoting at this coupling, for this crowd?
 *
 * Two different questions either side of the threshold, because the exact
 * answer is a different kind of thing on each side.
 *
 * **Above it** the answer is a number and the reading carries a sampling error,
 * so quoting it is worth doing only while the band the tab would accept is
 * narrower than the answer inside it. A reading of 0.22 that would be called
 * agreement anywhere from 0 to 0.5 is not a measurement of anything.
 *
 * **Below it** the answer is exactly zero and the reading is the floor, so the
 * accepted band is bound to be wider than the reading; the question there is
 * whether calling the floor "zero" is still honest, which is `FLOOR_CEILING`.
 *
 * Both fail in a band around `Kc` where the response to a perturbation diverges
 * and a finite crowd has no settled value at all. That band is not a gap to be
 * papered over — it *narrows as the crowd grows*, which is the second control
 * earning its place, and the transition being sharp only in the infinite limit
 * is the thing the tab is about. The readout drops its target there and says so.
 */
export function hasPrediction(coupling: number, gamma: number, n: number): boolean {
  const kc = criticalCoupling(gamma);
  if (coupling > kc) {
    return BAND_SIGMAS * lockedStandardError(coupling, gamma, n) < analyticOrder(coupling, gamma);
  }
  return incoherentFloor(coupling, gamma, n) < FLOOR_CEILING;
}

/**
 * Wrap a phase into [0, 2π).
 *
 * `floor` rather than `%`, so a backwards-running oscillator lands inside the
 * range instead of in (−2π, 0]. Phases are wrapped every step and not merely
 * for tidiness: the heavy tail of the Lorentzian sends the fastest oscillators
 * past 10¹⁴ radians within a minute, and the trig argument reduction — and the
 * painter, which maps the phase straight to an angle — both want a bounded one.
 */
export function wrapPhase(theta: number): number {
  const t = theta - TAU * Math.floor(theta / TAU);
  // For a large θ the product can round to either side of θ itself, so the two
  // ends are clamped rather than trusted to the algebra.
  if (!(t > 0)) return 0;
  return t < TAU ? t : 0;
}

/**
 * The crowd: natural speeds, phases, and the mean field they add up to.
 *
 * Typed arrays allocated once at the budget ceiling, with a live `count`, so
 * moving the crowd-size control never allocates and a step never does. Nothing
 * here paints; `forEach` hands the painter a phase and lets it decide where
 * that lands on a plate.
 */
export class Swarm {
  readonly capacity: number;

  private readonly omegas: Float64Array;
  private readonly phases: Float64Array;
  /**
   * A fixed offset in [−1, 1] per oscillator, carrying no quantity at all.
   *
   * The phases live on a circle, which is one-dimensional: a thousand dots of
   * radius 2 on a 900 px circumference paint a solid ring whatever they are
   * doing. The painter spreads them into a band using this, so the crowd reads
   * as a crowd and its density round the circle is visible. Drawn once per
   * oscillator at reset rather than per frame, or the band would boil.
   */
  private readonly offsets: Float32Array;

  /** Runge–Kutta stage derivatives, and the stage phases they are evaluated at. */
  private readonly k1: Float64Array;
  private readonly k2: Float64Array;
  private readonly k3: Float64Array;
  private readonly stage: Float64Array;
  /** cos and sin of the stage phases, taken once and used twice: mean field, then drive. */
  private readonly cosines: Float64Array;
  private readonly sines: Float64Array;

  private live = 0;
  /** The mean field as Cartesian components, r·cos ψ and r·sin ψ. */
  private fieldX = 0;
  private fieldY = 0;
  private magnitude = 0;
  private direction = 0;

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.omegas = new Float64Array(this.capacity);
    this.phases = new Float64Array(this.capacity);
    this.offsets = new Float32Array(this.capacity);
    this.k1 = new Float64Array(this.capacity);
    this.k2 = new Float64Array(this.capacity);
    this.k3 = new Float64Array(this.capacity);
    this.stage = new Float64Array(this.capacity);
    this.cosines = new Float64Array(this.capacity);
    this.sines = new Float64Array(this.capacity);
  }

  /** Oscillators currently running, at most `capacity`. */
  get count(): number {
    return this.live;
  }

  /** `r`, the length of the average of the unit phase vectors. */
  get order(): number {
    return this.magnitude;
  }

  /** `ψ`, the direction that average points in, in radians. */
  get heading(): number {
    return this.direction;
  }

  /**
   * Draw a fresh crowd of `n` from `rng`.
   *
   * Three draws per oscillator, always in this order — speed, phase, painting
   * offset — so oscillator `i` is the same however many follow it. Raising the
   * crowd-size control therefore *extends* the crowd rather than replacing it,
   * and what a reader sees change is the floor rather than the faces.
   */
  populate(rng: Rng, n: number, gamma: number): void {
    const count = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    this.live = count;
    for (let i = 0; i < count; i++) {
      this.omegas[i] = naturalSpeed(rng.next(), gamma);
      this.phases[i] = TAU * rng.next();
      this.offsets[i] = 2 * rng.next() - 1;
    }
    this.measure(this.phases);
    this.publish();
  }

  /**
   * One step of classical fourth-order Runge–Kutta of size `h`, in the model's
   * own time units.
   *
   * RK4 rather than Euler, and for the ordinary reason: the collective
   * relaxation near the threshold runs on a timescale of order 1/(K − Kc), so
   * the step has to be small against something that grows without bound as the
   * coupling approaches it. Euler at a step coarse enough to be affordable
   * damps that relaxation and would read a settled `r` below the true one — the
   * tab would disagree with its own overlay and blame the mathematics. Every
   * stage recomputes the mean field, because the field is a function of the
   * stage phases and not a constant across the step.
   *
   * Each stage costs one cos and one sin per oscillator and nothing else: the
   * drive `K·r·sin(ψ − θᵢ)` expands to `K·(r sinψ·cos θᵢ − r cosψ·sin θᵢ)`, so
   * the two field components serve both the sum and the drive, and neither an
   * `atan2` nor a division by `r` appears anywhere — which also means the field
   * being exactly zero is not a special case.
   */
  advance(h: number, coupling: number): void {
    const n = this.live;
    if (n === 0) return;
    const { omegas, phases, k1, k2, k3, stage, cosines, sines } = this;
    const half = 0.5 * h;

    // Stage 1, at θ. This field is also the one the tab reads and draws, so the
    // published (r, ψ) always belongs to a state the crowd really passed through.
    this.measure(phases);
    this.publish();
    let fx = this.fieldX;
    let fy = this.fieldY;
    for (let i = 0; i < n; i++) {
      const d = (omegas[i] ?? 0) + coupling * (fy * (cosines[i] ?? 0) - fx * (sines[i] ?? 0));
      k1[i] = d;
      stage[i] = (phases[i] ?? 0) + half * d;
    }

    this.measure(stage);
    fx = this.fieldX;
    fy = this.fieldY;
    for (let i = 0; i < n; i++) {
      const d = (omegas[i] ?? 0) + coupling * (fy * (cosines[i] ?? 0) - fx * (sines[i] ?? 0));
      k2[i] = d;
      // Read then overwritten in the same iteration, so one scratch array
      // carries all three intermediate states.
      stage[i] = (phases[i] ?? 0) + half * d;
    }

    this.measure(stage);
    fx = this.fieldX;
    fy = this.fieldY;
    for (let i = 0; i < n; i++) {
      const d = (omegas[i] ?? 0) + coupling * (fy * (cosines[i] ?? 0) - fx * (sines[i] ?? 0));
      k3[i] = d;
      stage[i] = (phases[i] ?? 0) + h * d;
    }

    this.measure(stage);
    fx = this.fieldX;
    fy = this.fieldY;
    const sixth = h / 6;
    for (let i = 0; i < n; i++) {
      const k4 = (omegas[i] ?? 0) + coupling * (fy * (cosines[i] ?? 0) - fx * (sines[i] ?? 0));
      const delta = sixth * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + k4);
      phases[i] = wrapPhase((phases[i] ?? 0) + delta);
    }
  }

  /**
   * Visit every `stride`-th oscillator, oldest index first, handing the painter
   * its phase and its meaningless band offset.
   *
   * A stride rather than a prefix: the oscillators are in draw order, which is
   * independent of their speeds, so every `stride`-th one is an unbiased
   * thinning of the crowd and the painted band has the same shape as the crowd
   * it stands for.
   */
  forEach(cb: (phase: number, offset: number, index: number) => void, stride = 1): void {
    const step = Math.max(1, Math.floor(stride));
    for (let i = 0; i < this.live; i += step) {
      cb(this.phases[i] ?? 0, this.offsets[i] ?? 0, i);
    }
  }

  /** Read one oscillator's natural speed. For tests; the painter never needs it. */
  speedAt(index: number): number {
    return index >= 0 && index < this.live ? (this.omegas[index] ?? 0) : NaN;
  }

  /** Read one oscillator's phase. For tests; the painter goes through `forEach`. */
  phaseAt(index: number): number {
    return index >= 0 && index < this.live ? (this.phases[index] ?? 0) : NaN;
  }

  /** Forget the crowd. The arrays are kept; nothing reallocates. */
  reset(): void {
    this.live = 0;
    this.fieldX = 0;
    this.fieldY = 0;
    this.magnitude = 0;
    this.direction = 0;
  }

  /** Mean field of `source`, caching each cos and sin for the drive that follows. */
  private measure(source: Float64Array): void {
    const n = this.live;
    const { cosines, sines } = this;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      const p = source[i] ?? 0;
      const c = Math.cos(p);
      const s = Math.sin(p);
      cosines[i] = c;
      sines[i] = s;
      sx += c;
      sy += s;
    }
    this.fieldX = n > 0 ? sx / n : 0;
    this.fieldY = n > 0 ? sy / n : 0;
  }

  /** Publish the field just measured as the length and direction the tab shows. */
  private publish(): void {
    const x = this.fieldX;
    const y = this.fieldY;
    this.magnitude = Math.sqrt(x * x + y * y);
    this.direction = Math.atan2(y, x);
  }
}

/**
 * The settled reading: a running mean of `r` over the samples taken after the
 * transient, and the trail of readings already taken at other couplings.
 *
 * The mean is Welford's rather than a raw sum, for the usual reason — a run
 * left open for an hour accumulates a hundred thousand samples — and it is NaN
 * until the transient has been excluded, which is what puts "not measured yet"
 * under the headline instead of a number nobody should trust.
 */
export class SettledOrder {
  private samples = 0;
  private running = 0;

  get count(): number {
    return this.samples;
  }

  /** The time-averaged `r`, or NaN before the first sample past the transient. */
  get mean(): number {
    return this.samples > 0 ? this.running : NaN;
  }

  push(r: number): void {
    this.samples++;
    this.running += (r - this.running) / this.samples;
  }

  reset(): void {
    this.samples = 0;
    this.running = 0;
  }
}
