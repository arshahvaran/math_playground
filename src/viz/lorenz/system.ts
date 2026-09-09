/**
 * The Lorenz system: the mathematics, with no canvas in sight.
 *
 * Three coupled ordinary differential equations, published by Edward Lorenz in
 * 1963 as a drastically truncated model of thermal convection:
 *
 *   ẋ = σ(y − x)        ẏ = x(ρ − z) − y        ż = xy − βz
 *
 * Nothing in them is random. The trajectory is a deterministic function of its
 * initial condition, it never repeats, and it never leaves a bounded region —
 * and two initial conditions a billionth apart end up on opposite wings inside
 * twenty-odd time units. That gap between "deterministic" and "predictable" is
 * the whole subject, and the numbers that measure it all live here.
 *
 * Three exact facts about the flow hold for every parameter set and are what
 * this tab checks itself against:
 *
 *   - The fixed points are the origin and C± = (±√(β(ρ−1)), ±√(β(ρ−1)), ρ−1);
 *     for σ = 10, ρ = 28, β = 8/3 that is (±8.4853, ±8.4853, 27).
 *   - Volume contracts everywhere at ∇·f = −(σ + 1 + β), a constant. For the
 *     classic parameters that is −13.667 per time unit, so a blob of initial
 *     conditions loses a factor of a million every time unit: the attractor has
 *     zero volume.
 *   - On the attractor, ⟨x²⟩ = β⟨z⟩ exactly. Time-average ẋ² and ż over any
 *     bounded orbit — d(x²)/dt = 2σ(xy − x²) averages to zero, so ⟨xy⟩ = ⟨x²⟩,
 *     and ż = xy − βz averages to zero, so ⟨xy⟩ = β⟨z⟩. It is the one closed
 *     form a run on this tab converges to from below, at the usual 1/√t.
 */

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export interface LorenzParams {
  readonly sigma: number;
  readonly rho: number;
  readonly beta: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Lorenz's own parameters, and the only ones with published invariants. */
export const CLASSIC: LorenzParams = Object.freeze({ sigma: 10, rho: 28, beta: 8 / 3 });

/**
 * Largest Lyapunov exponent at the classic parameters, 0.9056 nats per time
 * unit. There is no closed form for it — it is a measured property of the
 * attractor, computed to many digits by Viswanath (2004) and reproduced
 * everywhere since — which is why it is a pinned constant rather than a formula.
 */
export const LAMBDA_1_CLASSIC = 0.9056;

/** ln 2 / λ₁ = 0.7654 time units: how long any separation takes to double. */
export const DOUBLING_CLASSIC = Math.LN2 / LAMBDA_1_CLASSIC;

/**
 * How close a parameter set has to be to Lorenz's own for `LAMBDA_1_CLASSIC` to
 * be the honest analytic target for it. The tolerance on β is the rail's own
 * step: β = 8/3 is not on a 0.01 grid, so the control shows 2.67 and the
 * default carries 2.6667, and both have to count as classic.
 */
export function hasClassicParameters(p: LorenzParams): boolean {
  return (
    Math.abs(p.sigma - CLASSIC.sigma) <= 0.05 &&
    Math.abs(p.rho - CLASSIC.rho) <= 0.05 &&
    Math.abs(p.beta - CLASSIC.beta) <= 0.01
  );
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** The right-hand side of the three equations at `s`. */
export function derivative(s: Vec3, p: LorenzParams): Vec3 {
  return {
    x: p.sigma * (s.y - s.x),
    y: s.x * (p.rho - s.z) - s.y,
    z: s.x * s.y - p.beta * s.z,
  };
}

/**
 * One step of classical fourth-order Runge–Kutta, and deliberately not forward
 * Euler.
 *
 * The distinction is not academic here. Euler's error at each step points
 * *outward* along the spiral around each wing centre — it adds the energy the
 * flow is contracting away — so at the step sizes this tab uses (h = 0.005,
 * and up to 0.01 at the coarse end of the slider) an Euler trajectory visibly
 * winds off the wings within a few dozen time units. The picture would stop
 * being the Lorenz attractor while still being labelled as one, which makes the
 * tab a lie about the mathematics rather than merely an inaccurate one. RK4 at
 * h = 0.005 stays on the attractor indefinitely.
 *
 * Its own truncation error still pulls it away from the exact orbit, at rate
 * λ₁ — that is unavoidable and it is a statement about the system, not about
 * the integrator. It is exactly what the twin trajectory on this tab shows.
 *
 * The four stage derivatives are held as twelve local numbers rather than as
 * `Vec3`s, so a step allocates exactly one object: the state it returns.
 */
export function rk4Step(s: Vec3, h: number, p: LorenzParams): Vec3 {
  const { sigma, rho, beta } = p;
  const { x, y, z } = s;

  const k1x = sigma * (y - x);
  const k1y = x * (rho - z) - y;
  const k1z = x * y - beta * z;

  const ax = x + 0.5 * h * k1x;
  const ay = y + 0.5 * h * k1y;
  const az = z + 0.5 * h * k1z;
  const k2x = sigma * (ay - ax);
  const k2y = ax * (rho - az) - ay;
  const k2z = ax * ay - beta * az;

  const bx = x + 0.5 * h * k2x;
  const by = y + 0.5 * h * k2y;
  const bz = z + 0.5 * h * k2z;
  const k3x = sigma * (by - bx);
  const k3y = bx * (rho - bz) - by;
  const k3z = bx * by - beta * bz;

  const cx = x + h * k3x;
  const cy = y + h * k3y;
  const cz = z + h * k3z;
  const k4x = sigma * (cy - cx);
  const k4y = cx * (rho - cz) - cy;
  const k4z = cx * cy - beta * cz;

  const sixth = h / 6;
  return {
    x: x + sixth * (k1x + 2 * k2x + 2 * k3x + k4x),
    y: y + sixth * (k1y + 2 * k2y + 2 * k3y + k4y),
    z: z + sixth * (k1z + 2 * k2z + 2 * k3z + k4z),
  };
}

/**
 * The equilibria: the origin, then C₊ and C₋ at (±√(β(ρ−1)), ±√(β(ρ−1)), ρ−1).
 *
 * Below ρ = 1 the square root is imaginary and the origin is the only fixed
 * point and is globally stable — the fluid is not convecting at all — so the
 * array is length 1 there and length 3 above.
 */
export function fixedPoints(p: LorenzParams): readonly Vec3[] {
  const origin: Vec3 = { x: 0, y: 0, z: 0 };
  if (!(p.rho > 1) || !(p.beta > 0)) return [origin];
  const c = Math.sqrt(p.beta * (p.rho - 1));
  return [origin, { x: c, y: c, z: p.rho - 1 }, { x: -c, y: -c, z: p.rho - 1 }];
}

/**
 * The ρ at which C± lose stability, σ(σ+β+3)/(σ−β−1).
 *
 * A subcritical Hopf bifurcation: below it the wing centres are attracting and
 * every trajectory spirals into one of them, above it nothing local is stable
 * and the orbit is left wandering between the wings forever. For the classic
 * σ and β it is 24.7368, which is why ρ = 28 is chaotic and ρ = 14 is not.
 * Infinite when σ ≤ β + 1, where C± never lose stability.
 */
export function hopfThreshold(p: LorenzParams): number {
  const d = p.sigma - p.beta - 1;
  return d > 0 ? (p.sigma * (p.sigma + p.beta + 3)) / d : Infinity;
}

/** ∇·f = −(σ + 1 + β): the rate every phase-space volume shrinks at, everywhere. */
export function volumeContraction(p: LorenzParams): number {
  return -(p.sigma + 1 + p.beta);
}

/**
 * Euclidean distance between the twin trajectories.
 *
 * `Math.sqrt` of the sum of squares rather than `Math.hypot`, which is equally
 * accurate here and pays for a scaling pass and a variadic call that buy
 * nothing: hypot's guard is against a component near the ends of the double
 * range, and nothing here comes within 150 orders of magnitude of either. The
 * attractor is forty units across and the smallest gap the tab offers is 10⁻¹².
 *
 * Note that a twin placed at x + ε does not sit exactly ε away — for x of order
 * 1 and ε = 10⁻¹², (x + ε) − x is out by about 10⁻⁴ of ε, because the sum has
 * to round to a double. What this returns is the separation the twins really
 * have, which is the honest first sample for the fit.
 */
export function separation(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Time for a separation to double under exponential growth at `lambda`. */
export function doublingTime(lambda: number): number {
  return Math.LN2 / lambda;
}

// ---------------------------------------------------------------------------
// The viewing box
// ---------------------------------------------------------------------------

/**
 * Extent of the box the attractor is drawn inside, in units of its own scale:
 * c = √(β(ρ−1)) — the wing centres' own x — across, and ρ up.
 *
 * These are *viewing* bounds, not the rigorous trapping region. The trapping
 * ellipsoid of the Lyapunov function ρx² + σy² + σ(z−2ρ)² is honest and about
 * three times too large in every direction: drawing to it would leave the
 * butterfly a smudge in the middle of the plate. The multipliers below are the
 * measured extent of the classic attractor (|x| ≤ 19.4, |y| ≤ 26.5, z ≤ 47.8
 * against c = 8.485 and ρ = 28) with about 12% of margin, and they scale with
 * the parameters because c and ρ are the only lengths the system has.
 */
const X_SPAN = 2.6;
const Y_SPAN = 3.6;
const Z_SPAN = 1.9;

export interface ViewBox {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly zMin: number;
  readonly zMax: number;
}

export function viewBox(p: LorenzParams): ViewBox {
  // Floored, so ρ at its own minimum of 1 — where c collapses to zero and the
  // origin is all there is — still has a box with an inside.
  const c = Math.max(1, Math.sqrt(Math.max(0, p.beta * (p.rho - 1))));
  return {
    xMin: -X_SPAN * c,
    xMax: X_SPAN * c,
    yMin: -Y_SPAN * c,
    yMax: Y_SPAN * c,
    zMin: 0,
    zMax: Math.max(2, Z_SPAN * p.rho),
  };
}

/**
 * Where a run starts, before the seed's jitter.
 *
 * The attractor is the same object from any starting point in its basin, so the
 * initial condition is a matter of taste rather than of mathematics — but it
 * has to be on the plate and it has to reach the attractor quickly, so z scales
 * with ρ rather than sitting at a fixed 20 that would be off the top of the box
 * at ρ = 5.
 */
export function initialState(p: LorenzParams): Vec3 {
  return { x: 1, y: 1, z: 0.7 * p.rho };
}

// ---------------------------------------------------------------------------
// The Lyapunov exponent, fitted from one divergence episode
// ---------------------------------------------------------------------------

/**
 * A (time, separation) log, read by `lyapunovEstimate`. Backed by typed arrays
 * with a live `count`, so nothing allocates to ask for the fit.
 */
export interface SeparationHistory {
  readonly times: ArrayLike<number>;
  readonly separations: ArrayLike<number>;
  /** Leading entries to read. */
  readonly count: number;
}

export interface LyapunovFit {
  /** Slope of ln(separation) against t over the exponential phase, in nats per time unit. */
  lambda: number;
  /** The line's value at t = 0, in nats. */
  intercept: number;
  /** RMS residual of ln(separation) about the line, in nats. */
  residual: number;
  /**
   * Ordinary-least-squares standard error of the slope, σ_r / √(Σ(t−t̄)²).
   *
   * Optimistic by construction, and by a large factor: OLS assumes independent
   * residuals and consecutive samples of one trajectory are anything but. With
   * a correlation time τ the effective sample count is the span over τ rather
   * than the sample count, and the honest figure is
   *
   *   SE(λ₁) ≈ σ_r · √(12 τ / T³)
   *
   * — 0.040 at σ_r = 1.02 nats, T = 20 time units and τ = 1 (about one circuit
   * of a wing), against a measured episode-to-episode spread of 0.045. That is
   * the number the readout's convergence band and the test tolerances are built
   * from; this field is the straightness diagnostic underneath it.
   */
  stderr: number;
  /** Samples inside the fitted window. */
  samples: number;
  /** First and last time in the fitted window. */
  from: number;
  to: number;
}

/**
 * Nats of divergence discarded at the top of the fit.
 *
 * The last two decades before the largest separation seen are where the twin is
 * folding back onto the attractor and the growth has stopped being exponential
 * at all: the separation saturates at the attractor's own diameter, about 40 at
 * the classic parameters, and the approach to it bends the line flat. Two
 * decades below that is 0.4, comfortably inside the regime where the
 * linearisation still holds.
 *
 * **Nothing is discarded at the bottom**, which is not the obvious choice: an
 * arbitrary initial perturbation is not yet along the leading Lyapunov
 * direction, and burning the couple of time units it takes to rotate onto one
 * is the textbook move. Measured over 300 independent episodes it makes the
 * estimate worse on both counts — burning two nats moves the mean from 0.8978
 * to 0.8942, further from the 0.9056 it is chasing, and widens the spread from
 * 0.047 to 0.050. The first entry in the log is the one point on it with no
 * measurement error at all: it is the gap the twins were given, and it anchors
 * the left end of the line. Replacing it with an arbitrary point of a diffusing
 * log-separation gives the fit a noisy pivot and buys nothing back.
 */
const TRIM_NATS = Math.log(100);

/** Fewer samples than this is a slope through noise, not a measurement. */
const MIN_FIT_SAMPLES = 16;

const NO_FIT: LyapunovFit = Object.freeze({
  lambda: NaN,
  intercept: NaN,
  residual: NaN,
  stderr: NaN,
  samples: 0,
  from: NaN,
  to: NaN,
});

/**
 * Least-squares slope of ln(separation) against t over the exponential phase.
 * That slope is the largest Lyapunov exponent: d(t) ≈ d(0)·e^{λ₁t} while the
 * separation is small enough for the linearisation to hold.
 *
 * The window runs from the first sample to the first crossing of the trim
 * bound — a contiguous stretch, not the set of samples whose own value happens
 * to fall inside a band. Selecting individual samples by their separation would
 * clip the residual distribution at the edges of the window and tilt the line;
 * cutting at one crossing leaves every interior residual alone.
 *
 * The sign of the last sample against the first decides which way the bound
 * points, so one rule covers both regimes: above the Hopf threshold the twins
 * separate and the fit returns a positive λ₁, below it they spiral into the
 * same wing centre and it returns a negative one. NaN before there is enough of
 * an episode to fit.
 *
 * One episode is a *biased* measurement of λ₁, low by about C/T with C ≈ 0.17
 * nats and T the fitted span — the nats the perturbation spends rotating onto
 * the leading Lyapunov direction are a fixed offset in ln d, and a slope fitted
 * across a finite window absorbs a share of them. At the default gap that is
 * −0.009, under a percent, and it shrinks with a smaller gap exactly as 1/T
 * (measured at 1e-9 and 1e-12 in tests/lorenz.test.ts: spans of 20.0 and 27.5
 * time units give biases of −0.0089 and −0.0056, so C is 0.179 and 0.153).
 * Watching one pair of trajectories come apart is a one-sample experiment, and
 * this is what a one-sample experiment is worth.
 */
export function lyapunovEstimate(history: SeparationHistory): LyapunovFit {
  const { times, separations } = history;
  const logged = Math.min(
    Math.max(0, Math.floor(history.count)),
    times.length,
    separations.length,
  );

  // Below the Hopf threshold the twins do not merely converge, they *arrive*:
  // both trajectories reach the same wing centre and become the same double,
  // after which every sample is exactly zero. ln 0 is not a data point, so the
  // log is read up to the first one and no further — the samples after it are
  // all the same non-measurement.
  let n = logged;
  for (let i = 0; i < logged; i++) {
    if (!((separations[i] ?? 0) > 0)) {
      n = i;
      break;
    }
  }
  if (n < MIN_FIT_SAMPLES) return NO_FIT;

  const first = Math.log(separations[0] ?? 0);
  const last = Math.log(separations[n - 1] ?? 0);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return NO_FIT;

  // u runs upward whichever way the twins are going, so one bound serves the
  // chaotic and the stable case both.
  const dir = last >= first ? 1 : -1;
  let uMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const u = dir * Math.log(separations[i] ?? 0);
    if (u > uMax) uMax = u;
  }
  const uHigh = uMax - TRIM_NATS;
  if (!(uHigh > dir * first)) return NO_FIT;

  const lo = 0;
  let hi = n;
  for (let i = 0; i < n; i++) {
    if (dir * Math.log(separations[i] ?? 0) > uHigh) {
      hi = i;
      break;
    }
  }
  const m = hi - lo;
  if (m < MIN_FIT_SAMPLES) return NO_FIT;

  let sumT = 0;
  let sumS = 0;
  for (let i = lo; i < hi; i++) {
    sumT += times[i] ?? 0;
    sumS += Math.log(separations[i] ?? 0);
  }
  const meanT = sumT / m;
  const meanS = sumS / m;

  // Deviations from the means rather than Σt² − (Σt)²/n: the times here run to
  // hundreds while their spread is tens, and the one-pass form cancels away
  // most of the digits of exactly the quantity being divided by.
  let stt = 0;
  let sts = 0;
  for (let i = lo; i < hi; i++) {
    const dt = (times[i] ?? 0) - meanT;
    stt += dt * dt;
    sts += dt * (Math.log(separations[i] ?? 0) - meanS);
  }
  if (!(stt > 0)) return NO_FIT;

  const lambda = sts / stt;
  const intercept = meanS - lambda * meanT;

  let rss = 0;
  for (let i = lo; i < hi; i++) {
    const t = times[i] ?? 0;
    const r = Math.log(separations[i] ?? 0) - (intercept + lambda * t);
    rss += r * r;
  }

  return {
    lambda,
    intercept,
    residual: Math.sqrt(rss / m),
    stderr: m > 2 ? Math.sqrt(rss / (m - 2) / stt) : NaN,
    samples: m,
    from: times[lo] ?? NaN,
    to: times[hi - 1] ?? NaN,
  };
}

/**
 * Correlation time of the fluctuations in ln(separation), in time units.
 *
 * The local expansion rate along a Lorenz orbit is set by which wing the point
 * is on and where around it, so its memory is about one circuit — roughly 0.7
 * time units at the classic parameters, taken as 1. It is what turns the fit's
 * own residual into an honest error bar.
 */
const CORRELATION_TIME = 1;

/**
 * Standard error of a single episode's λ₁, from the straightness of its own
 * line: σ_r·√(12·τ/T³).
 *
 * The 12/T³ is ordinary least squares — Var(slope) = σ²/Σ(t−t̄)², and Σ(t−t̄)²
 * for n points evenly spaced over T is n·T²/12 — with the effective sample
 * count T/τ in place of n, because the residuals of one trajectory are
 * correlated over τ and not independent. At the tab's defaults (σ_r ≈ 1.02
 * nats, T ≈ 20) it gives 0.040 against a measured episode-to-episode spread of
 * 0.045, so it is right to about 13%: an error bar, not a p-value.
 *
 * NaN in, NaN out — there is no error bar before there is a fit.
 */
export function lyapunovStandardError(residual: number, span: number): number {
  if (!(span > 0)) return NaN;
  return residual * Math.sqrt((12 * CORRELATION_TIME) / (span * span * span));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The trajectory's recent history, as a ring buffer over typed arrays allocated
 * once at the budget.
 *
 * Points are stored in world coordinates, not in pixels: the projection is a
 * live control and a resize re-lays-out the whole trail, so the painter turns
 * these into pixels every time it repaints rather than the pusher doing it once.
 * Float32 carries seven significant digits, which over an attractor forty units
 * across is a resolution of a few millionths of a unit — four orders of
 * magnitude below a pixel.
 */
export class Trail {
  readonly capacity: number;

  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly zs: Float32Array;

  /** Slot the next push writes to. */
  private head = 0;
  /** Live entries, ≤ capacity. */
  private stored = 0;
  private total = 0;

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);
    this.zs = new Float32Array(this.capacity);
  }

  /** Points currently held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Every point ever pushed since the last reset, overwritten ones included. */
  get pushed(): number {
    return this.total;
  }

  push(s: Vec3): void {
    const i = this.head;
    this.xs[i] = s.x;
    this.ys[i] = s.y;
    this.zs[i] = s.z;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
    this.total++;
  }

  /**
   * Visit `count` held points starting `from` the given chronological position
   * (0 = oldest held), oldest first, so a painter following this order draws
   * the polyline forwards.
   */
  forEach(from: number, count: number, cb: (x: number, y: number, z: number) => void): void {
    // Until the buffer wraps the oldest entry is slot 0; afterwards it is the
    // slot `head` is about to overwrite.
    const start = this.stored < this.capacity ? 0 : this.head;
    const lo = Math.max(0, Math.floor(from));
    const hi = Math.min(this.stored, lo + Math.max(0, Math.floor(count)));
    for (let i = lo; i < hi; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(this.xs[slot] ?? 0, this.ys[slot] ?? 0, this.zs[slot] ?? 0);
    }
  }

  /** Forget every point. The arrays are kept; nothing reallocates. */
  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.total = 0;
  }
}

/**
 * The (time, separation) log the Lyapunov fit reads.
 *
 * It fills and then *stops*, rather than wrapping. A ring would eventually
 * throw away the exponential phase and leave the fit staring at a saturated
 * separation rattling around the attractor's diameter, which has no slope worth
 * reporting; keeping the first `capacity` samples instead freezes the estimate
 * on the episode it was measured from, which is the honest thing for a number
 * that describes one divergence.
 */
export class SeparationLog implements SeparationHistory {
  readonly capacity: number;
  readonly times: Float64Array;
  readonly separations: Float64Array;

  private stored = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.times = new Float64Array(this.capacity);
    this.separations = new Float64Array(this.capacity);
  }

  get count(): number {
    return this.stored;
  }

  get full(): boolean {
    return this.stored >= this.capacity;
  }

  push(t: number, d: number): void {
    if (this.stored >= this.capacity) return;
    this.times[this.stored] = t;
    this.separations[this.stored] = d;
    this.stored++;
  }

  reset(): void {
    this.stored = 0;
  }
}
