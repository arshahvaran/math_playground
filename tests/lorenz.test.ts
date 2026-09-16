import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import { gapInWords, lorenz, plateTransform, tickStep } from '../src/viz/lorenz/index';
import {
  CLASSIC,
  DOUBLING_CLASSIC,
  LAMBDA_1_CLASSIC,
  SeparationLog,
  Trail,
  derivative,
  doublingTime,
  fixedPoints,
  hasClassicParameters,
  hopfThreshold,
  initialState,
  lyapunovEstimate,
  lyapunovStandardError,
  rk4Step,
  separation,
  viewBox,
  volumeContraction,
  type LorenzParams,
  type Vec3,
} from '../src/viz/lorenz/system';

const SEED = 42;

/** The tab's fixed step and its defaults, mirrored here so the tests measure what the tab runs. */
const H = 0.005;
const SEPARATION_SAMPLE = 0.05;
const GAP = 1e-9;
const JITTER = 0.5;

/** The engine's tick: 120 Hz. The tab advances one time unit per second. */
const TICK = 1000 / 120;

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe('rk4Step', () => {
  it('leaves every fixed point exactly where it is', () => {
    for (const p of [CLASSIC, { sigma: 16, rho: 45, beta: 4 }, { sigma: 3, rho: 8, beta: 0.5 }]) {
      for (const q of fixedPoints(p)) {
        const d = derivative(q, p);
        expect(Math.hypot(d.x, d.y, d.z), `derivative at ${JSON.stringify(q)}`).toBeLessThan(1e-12);
        const next = rk4Step(q, H, p);
        expect(separation(next, q), `step from ${JSON.stringify(q)}`).toBeLessThan(1e-12);
      }
    }
  });

  it('is fourth order: halving the step divides the error by sixteen', () => {
    // The one axis the system solves in closed form. x = y = 0 makes ẋ = ẏ = 0
    // and ż = −βz, so z(t) = z₀·e^{−βt} exactly, and the global error of a
    // p-th-order method over a fixed interval scales as hᵖ.
    const errorAt = (h: number): number => {
      let s: Vec3 = { x: 0, y: 0, z: 10 };
      for (let k = 0; k < Math.round(1 / h); k++) s = rk4Step(s, h, CLASSIC);
      return Math.abs(s.z - 10 * Math.exp(-CLASSIC.beta));
    };
    const coarse = errorAt(0.02);
    const medium = errorAt(0.01);
    const fine = errorAt(0.005);
    // 2⁴ = 16, and the measured ratios are 16.4 and 16.2 — the 10% window is
    // the higher-order terms, not slack.
    expect(coarse / medium).toBeGreaterThan(14.4);
    expect(coarse / medium).toBeLessThan(17.6);
    expect(medium / fine).toBeGreaterThan(14.4);
    expect(medium / fine).toBeLessThan(17.6);
    // And it is accurate, not merely convergent: 5e-10 over one time unit.
    expect(fine).toBeLessThan(1e-9);
  });

  it('keeps the orbit inside the attractor for a hundred thousand steps', () => {
    // Forward Euler is out of the trapping region well before this, which is
    // the reason the integrator is RK4 and the reason this test exists.
    let s: Vec3 = initialState(CLASSIC);
    let inside = true;
    for (let k = 0; k < 100_000; k++) {
      s = rk4Step(s, H, CLASSIC);
      if (k > 2_000 && (Math.abs(s.x) > 25 || Math.abs(s.y) > 35 || s.z < 0 || s.z > 55)) inside = false;
    }
    expect(inside).toBe(true);
    expect(Number.isFinite(s.x + s.y + s.z)).toBe(true);
  });

  it('traces one orbit at any step size, until its own truncation error grows at λ₁', () => {
    // Why the tab's step is fixed at 0.005 rather than offered as a fader, and
    // the limit of that choice. A fifth of the step lands on the same point two
    // time units in — 6·10⁻⁶ out of an attractor forty units across — and then
    // cannot stay there, because the truncation error is a perturbation like
    // any other: 6·10⁻⁶ reaches order 1 after a further ln(10⁵)/0.906 ≈ 13
    // time units, and it does.
    const at = (h: number, until: number): Vec3 => {
      let s: Vec3 = initialState(CLASSIC);
      for (let k = 0; k < Math.round(until / h); k++) s = rk4Step(s, h, CLASSIC);
      return s;
    };
    expect(separation(at(0.005, 2), at(0.001, 2))).toBeLessThan(1e-5);
    expect(separation(at(0.005, 20), at(0.001, 20))).toBeGreaterThan(1);
    // The coarse end of the slider is worse by about the fourth power: 2⁴ = 16.
    const coarse = separation(at(0.01, 2), at(0.001, 2));
    const fine = separation(at(0.005, 2), at(0.001, 2));
    expect(coarse / fine).toBeGreaterThan(8);
  });

  it('reproduces a run exactly from the same starting point', () => {
    const run = (): Vec3 => {
      let s: Vec3 = { x: 1, y: 1, z: 19.6 };
      for (let k = 0; k < 5_000; k++) s = rk4Step(s, H, CLASSIC);
      return s;
    };
    expect(run()).toEqual(run());
  });
});

describe('fixedPoints', () => {
  it('puts C± at (±√(β(ρ−1)), ±√(β(ρ−1)), ρ−1)', () => {
    const [origin, plus, minus] = fixedPoints(CLASSIC);
    expect(origin).toEqual({ x: 0, y: 0, z: 0 });
    // √(8/3 · 27) = √72 = 8.485281.
    expect(plus?.x).toBeCloseTo(8.4853, 4);
    expect(plus?.y).toBeCloseTo(8.4853, 4);
    expect(plus?.z).toBeCloseTo(27, 12);
    expect(minus?.x).toBeCloseTo(-8.4853, 4);
    expect(minus?.y).toBeCloseTo(-8.4853, 4);
    expect(minus?.z).toBeCloseTo(27, 12);
  });

  it('leaves only the origin below ρ = 1, where nothing is convecting', () => {
    expect(fixedPoints({ ...CLASSIC, rho: 1 })).toHaveLength(1);
    expect(fixedPoints({ ...CLASSIC, rho: 0.5 })).toHaveLength(1);
    expect(fixedPoints({ ...CLASSIC, rho: 1.0001 })).toHaveLength(3);
  });
});

describe('hopfThreshold and volumeContraction', () => {
  it('puts the stability boundary at 24.7368 for Lorenz’s σ and β', () => {
    // 10·(10 + 8/3 + 3)/(10 − 8/3 − 1) = 156.667/6.3333.
    expect(hopfThreshold(CLASSIC)).toBeCloseTo(24.7368, 4);
    expect(hopfThreshold(CLASSIC)).toBeGreaterThan(14);
    expect(hopfThreshold(CLASSIC)).toBeLessThan(28);
  });

  it('is infinite where C± never lose stability', () => {
    expect(hopfThreshold({ sigma: 2, rho: 28, beta: 8 / 3 })).toBe(Infinity);
  });

  it('contracts volume at −(σ + 1 + β), a constant', () => {
    expect(volumeContraction(CLASSIC)).toBeCloseTo(-13.6667, 4);
    // e^{−13.667} — the factor a blob of initial conditions loses per time unit.
    expect(Math.exp(volumeContraction(CLASSIC))).toBeLessThan(2e-6);
  });
});

describe('separation and doublingTime', () => {
  it('is the Euclidean distance, exactly, down to the smallest gap the tab offers', () => {
    expect(separation({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 })).toBe(13);
    expect(separation({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(0);
    expect(separation({ x: 0, y: 0, z: 0 }, { x: 1e-12, y: 0, z: 0 })).toBe(1e-12);
    // A twin placed at x + ε is not ε away: the sum rounds to a double, and at
    // x ≈ 1.3 that costs 10⁻⁴ of a 10⁻¹² gap. What comes back is the separation
    // the twins really have, which is the number the fit should be anchored on.
    const drift = separation({ x: 1.3277, y: 0, z: 0 }, { x: 1.3277 + 1e-12, y: 0, z: 0 }) / 1e-12 - 1;
    expect(Math.abs(drift)).toBeLessThan(1e-3);
    expect(Math.abs(drift)).toBeGreaterThan(0);
  });

  it('turns the published exponent into the published doubling time', () => {
    expect(doublingTime(LAMBDA_1_CLASSIC)).toBeCloseTo(0.7654, 4);
    expect(DOUBLING_CLASSIC).toBe(doublingTime(LAMBDA_1_CLASSIC));
    // 22.9 time units to carry 10⁻⁹ up to order 1: ln(10⁹)/0.9056.
    expect(Math.log(1e9) / LAMBDA_1_CLASSIC).toBeCloseTo(22.88, 2);
  });
});

// ---------------------------------------------------------------------------
// The fit, on data whose answer is known exactly
// ---------------------------------------------------------------------------

/** A log of d = d₀·e^{λt}, sampled the way the tab samples. */
function syntheticLog(d0: number, lambda: number, until: number): SeparationLog {
  const log = new SeparationLog(4_096);
  for (let t = 0; t <= until + 1e-9; t += SEPARATION_SAMPLE) log.push(t, d0 * Math.exp(lambda * t));
  return log;
}

describe('lyapunovEstimate', () => {
  it('recovers an exact exponential to twelve digits, with no residual', () => {
    const fit = lyapunovEstimate(syntheticLog(1e-9, 0.9056, 25));
    expect(fit.lambda).toBeCloseTo(0.9056, 12);
    expect(fit.residual).toBeLessThan(1e-12);
    expect(fit.samples).toBeGreaterThan(100);
    expect(fit.from).toBe(0);
  });

  it('returns a negative slope when the twins merge instead of separating', () => {
    const fit = lyapunovEstimate(syntheticLog(1e-3, -0.4, 40));
    expect(fit.lambda).toBeCloseTo(-0.4, 12);
  });

  it('discards the top two decades, where growth is no longer exponential', () => {
    // Exponential to d = 1, then pinned at the attractor's diameter. The window
    // has to stop two decades under that ceiling, so none of the flat part
    // reaches the fit and the slope stays the one the exponential had.
    const log = new SeparationLog(4_096);
    for (let t = 0; t <= 40 + 1e-9; t += SEPARATION_SAMPLE) {
      log.push(t, Math.min(40, 1e-9 * Math.exp(0.9 * t)));
    }
    const fit = lyapunovEstimate(log);
    expect(fit.lambda).toBeCloseTo(0.9, 9);
    // ln 40 − ln 100 = 0.4, so the last sample fitted sits at d ≈ 0.4.
    expect(fit.to).toBeLessThan(Math.log(0.4 / 1e-9) / 0.9 + SEPARATION_SAMPLE);
  });

  it('is NaN until there is an episode to fit', () => {
    expect(lyapunovEstimate(new SeparationLog(64)).lambda).toBeNaN();
    expect(lyapunovEstimate(syntheticLog(1e-9, 0.9, 0.4)).lambda).toBeNaN();
    // A twin that never moved: ln 0 is not a data point.
    const zeroes = new SeparationLog(64);
    for (let i = 0; i < 40; i++) zeroes.push(i * SEPARATION_SAMPLE, 0);
    expect(lyapunovEstimate(zeroes).lambda).toBeNaN();
  });

  it('turns a fit residual into an error bar the OLS one does not give', () => {
    // σ_r·√(12τ/T³) with τ = 1: at the tab's own numbers, 0.040.
    expect(lyapunovStandardError(1.02, 20)).toBeCloseTo(0.0395, 4);
    // Halving the span costs almost three times the precision, T^{−3/2}.
    expect(lyapunovStandardError(1, 10) / lyapunovStandardError(1, 20)).toBeCloseTo(2 ** 1.5, 9);
    expect(lyapunovStandardError(1, 0)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Convergence: the exponent, measured the way the tab measures it
// ---------------------------------------------------------------------------

interface Episode {
  log: SeparationLog;
  end: Vec3;
  /** Time average of x², and of z. */
  meanX2: number;
  meanZ: number;
  final: number;
}

/**
 * One twin run, reproducing `create()`'s own arithmetic: the same jittered
 * start, the same whole-gap-in-x twin, the same RK4 step and the same sampling
 * interval. What this measures is what the tab reports.
 */
function episode(seed: number, gap: number, until: number, p: LorenzParams = CLASSIC): Episode {
  const rng = createRng(seed);
  const base = initialState(p);
  let a: Vec3 = {
    x: base.x + rng.range(-JITTER, JITTER),
    y: base.y + rng.range(-JITTER, JITTER),
    z: base.z + rng.range(-JITTER, JITTER),
  };
  let b: Vec3 = { x: a.x + gap, y: a.y, z: a.z };
  const log = new SeparationLog(16_384);
  log.push(0, separation(a, b));
  let sumX2 = a.x * a.x;
  let sumZ = a.z;
  let n = 1;
  let t = 0;
  let since = 0;
  while (t < until) {
    a = rk4Step(a, H, p);
    b = rk4Step(b, H, p);
    t += H;
    sumX2 += a.x * a.x;
    sumZ += a.z;
    n++;
    since += H;
    if (since >= SEPARATION_SAMPLE - 1e-9) {
      since = 0;
      log.push(t, separation(a, b));
    }
  }
  return { log, end: a, meanX2: sumX2 / n, meanZ: sumZ / n, final: separation(a, b) };
}

function stats(xs: readonly number[]): { mean: number; sd: number; se: number } {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { mean, sd, se: sd / Math.sqrt(n) };
}

/** Episodes are the expensive part of this file; every describe below shares one set. */
const EPISODES = 100;
const UNTIL = 60;

function slopes(gap: number): { lambdas: number[]; spans: number[]; residuals: number[] } {
  const lambdas: number[] = [];
  const spans: number[] = [];
  const residuals: number[] = [];
  for (let seed = 1; seed <= EPISODES; seed++) {
    const fit = lyapunovEstimate(episode(seed, gap, UNTIL).log);
    if (!Number.isFinite(fit.lambda)) continue;
    lambdas.push(fit.lambda);
    spans.push(fit.to - fit.from);
    residuals.push(fit.residual);
  }
  return { lambdas, spans, residuals };
}

const NINE = slopes(1e-9);

describe('lorenz convergence: the largest Lyapunov exponent', () => {
  it('measures 0.9056 from one divergence episode, inside the error bar its own fit gives', () => {
    const fit = lyapunovEstimate(episode(SEED, GAP, UNTIL).log);
    // The tolerance is the fit's own: σ_r·√(12τ/T³) with the residual and the
    // span this episode actually produced, at three standard errors. Nothing
    // here is tuned — the same expression is what the ledger's convergence band
    // is built from, live.
    const se = lyapunovStandardError(fit.residual, fit.to - fit.from);
    expect(se).toBeLessThan(0.06);
    expect(Math.abs(fit.lambda - LAMBDA_1_CLASSIC)).toBeLessThan(3 * se);
    // ln 2 / λ follows for free, and is the number the tab labels the twin with.
    expect(Math.abs(doublingTime(fit.lambda) - DOUBLING_CLASSIC)).toBeLessThan(
      (3 * se * DOUBLING_CLASSIC) / LAMBDA_1_CLASSIC,
    );
  });

  it('averages to 0.9056 over a hundred episodes, within the estimator’s bias and 3 SE', () => {
    const s = stats(NINE.lambdas);
    expect(NINE.lambdas).toHaveLength(EPISODES);
    // Two contributions, both stated before the test was run:
    //   bias — the perturbation loses C ≈ 0.15 nats rotating onto the leading
    //          Lyapunov direction, a fixed offset in ln d that a slope fitted
    //          over a span T absorbs as −C/T. Budgeted at C ≤ 0.2 over the
    //          T ≈ 20 the default gap gives: 0.010.
    //   noise — 3 standard errors of the mean, computed here from the sample's
    //          own spread rather than assumed.
    const bias = 0.2 / stats(NINE.spans).mean;
    expect(3 * s.se).toBeLessThan(0.02);
    expect(Math.abs(s.mean - LAMBDA_1_CLASSIC)).toBeLessThan(bias + 3 * s.se);
    // And the spread of a single episode is what the ledger's band claims it
    // is: σ_r·√(12τ/T³) against the measured episode-to-episode standard
    // deviation, which agree to about 15%.
    const predicted = lyapunovStandardError(stats(NINE.residuals).mean, stats(NINE.spans).mean);
    expect(s.sd / predicted).toBeGreaterThan(0.7);
    expect(s.sd / predicted).toBeLessThan(1.4);
  });

  it('shrinks that bias as 1/T when the twins start closer together', () => {
    // The bias model is testable rather than fitted: a smaller gap buys a
    // longer fitted span, and if the offset C is a constant then bias·T is too.
    const twelve = slopes(1e-12);
    const nine = stats(NINE.lambdas);
    const deep = stats(twelve.lambdas);
    const spanNine = stats(NINE.spans).mean;
    const spanDeep = stats(twelve.spans).mean;
    expect(spanDeep).toBeGreaterThan(spanNine + 4);
    expect(Math.abs(deep.mean - LAMBDA_1_CLASSIC)).toBeLessThan(Math.abs(nine.mean - LAMBDA_1_CLASSIC));
    const cNine = (LAMBDA_1_CLASSIC - nine.mean) * spanNine;
    const cDeep = (LAMBDA_1_CLASSIC - deep.mean) * spanDeep;
    expect(cNine / cDeep).toBeGreaterThan(0.6);
    expect(cNine / cDeep).toBeLessThan(1.6);
  });

  it('carries a 10⁻⁹ gap to order 1 in about 22.9 time units', () => {
    // ln(10⁹)/0.9056 = 22.88. The episode-to-episode spread of a first passage
    // is the same 5% the exponent has, so 4 time units either side is generous
    // for a median and tight enough to be a claim.
    const crossings: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const { log } = episode(seed, GAP, 60);
      for (let i = 0; i < log.count; i++) {
        if ((log.separations[i] ?? 0) >= 1) {
          crossings.push(log.times[i] ?? NaN);
          break;
        }
      }
    }
    expect(crossings).toHaveLength(40);
    const median = [...crossings].sort((a, b) => a - b)[20] ?? NaN;
    expect(median).toBeGreaterThan(18.9);
    expect(median).toBeLessThan(26.9);
  });
});

describe('lorenz convergence: ⟨x²⟩ = β⟨z⟩', () => {
  it('closes the exact time-average identity to within the boundary term', () => {
    // Averaging d(x²)/dt = 2σ(xy − x²) and ż = xy − βz over [0, T] and
    // subtracting gives ⟨x²⟩ − β⟨z⟩ = (Δz − Δ(x²)/2σ)/T exactly. On the
    // attractor |z| ≤ 48 and x² ≤ 380, so the relative error is at most
    // (48 + 380/20)/(β⟨z⟩ ≈ 62.9)/T = 1.07/T — no statistics involved.
    const T = 200;
    const bound = 1.07 / T;
    for (let seed = 1; seed <= 12; seed++) {
      const { meanX2, meanZ } = episode(seed, GAP, T);
      const ratio = meanX2 / (CLASSIC.beta * meanZ);
      expect(Math.abs(ratio - 1), `seed ${seed}`).toBeLessThan(bound);
    }
  });

  it('tightens as 1/T', () => {
    const at = (T: number): number => {
      const { meanX2, meanZ } = episode(SEED, GAP, T);
      return Math.abs(meanX2 / (CLASSIC.beta * meanZ) - 1);
    };
    expect(at(400)).toBeLessThan(at(50));
    expect(at(400)).toBeLessThan(1.07 / 400);
  });
});

describe('lorenz convergence: below the Hopf threshold', () => {
  it('merges the twins and returns the wing centre’s own decay rate at ρ = 14', () => {
    const p: LorenzParams = { ...CLASSIC, rho: 14 };
    expect(p.rho).toBeLessThan(hopfThreshold(p));
    const { log, end, final } = episode(SEED, GAP, 60, p);
    // Not merely smaller: the two trajectories arrive at the same wing centre
    // and become the same double, so the separation is exactly zero.
    expect(final).toBe(0);

    // The analytic answer below the threshold is the leading eigenvalue of the
    // Jacobian at C±, whose characteristic polynomial is
    // λ³ + (σ+β+1)λ² + β(σ+ρ)λ + 2σβ(ρ−1) = λ³ + 13.667λ² + 64λ + 693.33.
    // Its real root is −12.877695 and the surviving complex pair is
    // −0.394486 ± 7.326953i — the sum and the two symmetric functions below
    // check that against the polynomial's own coefficients — so the twins
    // converge at 0.3945 nats per time unit and ring at a period of
    // 2π/7.327 = 0.8575 while they do it.
    const real = -12.877694962632553;
    const a = -(p.sigma + p.beta + 1 + real) / 2;
    const modulus = (-2 * p.sigma * p.beta * (p.rho - 1)) / real;
    expect(a).toBeCloseTo(-0.394486, 6);
    expect(2 * a * real + modulus).toBeCloseTo(p.beta * (p.sigma + p.rho), 9);
    expect(Math.sqrt(modulus - a * a)).toBeCloseTo(7.326953, 6);

    const fit = lyapunovEstimate(log);
    expect(fit.lambda).toBeLessThan(0);
    // The fitted window still contains the approach to C±, which decays faster,
    // so the slope comes out a few percent shallow of the asymptotic rate.
    expect(fit.lambda / a).toBeGreaterThan(0.85);
    expect(fit.lambda / a).toBeLessThan(1.15);

    // And the trajectory has arrived: √(8/3 · 13) = 5.888.
    const [, plus, minus] = fixedPoints(p);
    expect(plus?.x).toBeCloseTo(5.8878, 4);
    const reached = Math.min(separation(end, plus ?? end), separation(end, minus ?? end));
    expect(reached).toBeLessThan(1e-9);
  });

  it('keeps the classic parameters above it', () => {
    expect(CLASSIC.rho).toBeGreaterThan(hopfThreshold(CLASSIC));
    expect(episode(SEED, GAP, 60).final).toBeGreaterThan(1);
  });
});

describe('hasClassicParameters', () => {
  it('accepts β at the rail’s own two decimals but nothing further out', () => {
    expect(hasClassicParameters(CLASSIC)).toBe(true);
    expect(hasClassicParameters({ ...CLASSIC, beta: 2.67 })).toBe(true);
    expect(hasClassicParameters({ ...CLASSIC, beta: 2.7 })).toBe(false);
    expect(hasClassicParameters({ ...CLASSIC, rho: 14 })).toBe(false);
    expect(hasClassicParameters({ ...CLASSIC, sigma: 12 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage and geometry
// ---------------------------------------------------------------------------

describe('Trail', () => {
  const point = (i: number): Vec3 => ({ x: i / 8, y: i / 16, z: i / 32 });

  function collect(trail: Trail, from: number, count: number): number[] {
    const out: number[] = [];
    trail.forEach(from, count, (x) => out.push(x * 8));
    return out;
  }

  it('keeps the newest `budget` points and counts every push', () => {
    const trail = new Trail(5);
    for (let i = 0; i < 8; i++) trail.push(point(i));
    expect(trail.capacity).toBe(5);
    expect(trail.count).toBe(5);
    expect(trail.pushed).toBe(8);
    expect(collect(trail, 0, 5)).toEqual([3, 4, 5, 6, 7]);
  });

  it('serves a window from the newest end, which is what a fading trail paints', () => {
    const trail = new Trail(6);
    for (let i = 0; i < 10; i++) trail.push(point(i));
    expect(collect(trail, trail.count - 3, 3)).toEqual([7, 8, 9]);
    expect(collect(trail, -5, 2)).toEqual([4, 5]);
    expect(collect(trail, 4, 99)).toEqual([8, 9]);
    expect(collect(trail, 99, 3)).toEqual([]);
  });

  it('reset clears the points and the counter, and reallocates nothing', () => {
    const trail = new Trail(4);
    for (let i = 0; i < 10; i++) trail.push(point(i));
    trail.reset();
    expect(trail.count).toBe(0);
    expect(trail.pushed).toBe(0);
    trail.push(point(1));
    expect(collect(trail, 0, 4)).toEqual([1]);
  });

  it('never allocates below one slot', () => {
    const trail = new Trail(0);
    trail.push(point(1));
    trail.push(point(2));
    expect(trail.count).toBe(1);
    expect(trail.pushed).toBe(2);
  });
});

describe('SeparationLog', () => {
  it('fills and then stops, so the fit keeps the episode it measured', () => {
    const log = new SeparationLog(4);
    for (let i = 0; i < 10; i++) log.push(i, 2 ** i);
    expect(log.count).toBe(4);
    expect(log.full).toBe(true);
    expect([...log.times.slice(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([...log.separations.slice(0, 4)]).toEqual([1, 2, 4, 8]);
    log.reset();
    expect(log.count).toBe(0);
    expect(log.full).toBe(false);
  });
});

describe('viewBox and plateTransform', () => {
  it('holds the classic attractor with margin to spare', () => {
    const box = viewBox(CLASSIC);
    // Measured extent of the attractor: |x| ≤ 19.4, |y| ≤ 26.5, z ≤ 47.8.
    expect(box.xMax).toBeGreaterThan(19.4);
    expect(box.yMax).toBeGreaterThan(26.5);
    expect(box.zMax).toBeGreaterThan(47.8);
    expect(box.xMin).toBe(-box.xMax);
    expect(box.zMin).toBe(0);
    // …and not by so much that the butterfly is a smudge: under 40% of slack.
    expect(box.xMax).toBeLessThan(19.4 * 1.4);
    expect(box.zMax).toBeLessThan(47.8 * 1.4);
  });

  it('still has an inside at ρ = 1, where the fixed points collapse', () => {
    const box = viewBox({ ...CLASSIC, rho: 1 });
    expect(box.xMax).toBeGreaterThan(0);
    expect(box.zMax).toBeGreaterThan(box.zMin);
  });

  it('scales both axes together, so a run is the same shape on any plate', () => {
    const box = viewBox(CLASSIC);
    const proj = { id: 'xz', label: 'x – z', h: 'x', v: 'z' } as const;
    for (const [w, h] of [[720, 448], [343, 343], [1_280, 720]] as const) {
      const plate = plateTransform(w, h, box, proj, 14);
      expect(plate.ox).toBe(w / 2);
      expect(plate.oy).toBe(h / 2);
      // The box fits inside the plate in both directions.
      expect((box.xMax - box.xMin) * plate.scale).toBeLessThanOrEqual(w - 27.9);
      expect((box.zMax - box.zMin) * plate.scale).toBeLessThanOrEqual(h - 27.9);
      // …and binds in one of them.
      const slackW = w - 28 - (box.xMax - box.xMin) * plate.scale;
      const slackH = h - 28 - (box.zMax - box.zMin) * plate.scale;
      expect(Math.min(slackW, slackH)).toBeLessThan(1e-6);
    }
  });
});

describe('tickStep', () => {
  it('graduates on 1, 2 or 5 times a power of ten', () => {
    for (const span of [1, 3, 7, 40, 56, 100, 480, 0.4]) {
      const step = tickStep(span);
      const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
      expect([1, 2, 5], `span ${span} → step ${step}`).toContain(Math.round(mantissa * 1e6) / 1e6);
      // Between four and sixteen graduations across the axis.
      expect(span / step).toBeGreaterThanOrEqual(4);
      expect(span / step).toBeLessThanOrEqual(16);
    }
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  composite: string;
  segments: readonly Seg[];
}

interface Fill {
  style: string;
  alpha: number;
  composite: string;
  rect: readonly [number, number, number, number];
}

/**
 * A canvas context that records what it was asked to paint. The trails are the
 * only thing under test here, so paths are kept as segment lists; the display
 * window and the fade record as fills, which is how the compositing rules below
 * are checked.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  fills: Fill[];
  clears: Array<readonly [number, number, number, number]>;
} {
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const clears: Array<readonly [number, number, number, number]> = [];
  let segments: Seg[] = [];
  let x = 0;
  let y = 0;
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: (a: number, b: number, w: number, h: number): void => {
      clears.push([a, b, w, h]);
    },
    fillRect: (a: number, b: number, w: number, h: number): void => {
      fills.push({
        style: String(api.fillStyle),
        alpha: api.globalAlpha,
        composite: String(api.globalCompositeOperation),
        rect: [a, b, w, h],
      });
    },
    strokeRect: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (t: string) => ({ width: 7 * t.length }),
    arc: () => undefined,
    beginPath(): void {
      segments = [];
    },
    moveTo(a: number, b: number): void {
      x = a;
      y = b;
    },
    lineTo(a: number, b: number): void {
      segments.push([x, y, a, b]);
      x = a;
      y = b;
    },
    stroke(): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        composite: String(api.globalCompositeOperation),
        segments: [...segments],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, fills, clears };
}

/** The pinned canvas contract from theme.css §RULE 0 — the plate is white in both schemes. */
const THEME = {
  canvas: '#ffffff',
  ink: '#171b1d',
  inkMuted: '#4e5750',
  grid: '#23292b',
  gridSoft: '#8a938f',
  data1: '#d53619',
  data2: '#24467a',
  data3: '#7f8985',
  data3Fill: '#d2d6d4',
  accent: '#d53619',
  labelFont: '500 11px "Martian Mono", monospace',
  lineWidth: 1,
  particleRadius: 2,
};

const DEFAULTS: Record<string, ParamValue> = {
  rho: 28,
  twinGap: 1e-9,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 640, height = 674) {
  const bg = recordingContext();
  const fg = recordingContext();
  const emitted: Readout[][] = [];
  const ctx: VizContext = {
    layers: { background: bg.ctx, foreground: fg.ctx },
    width,
    height,
    rng: createRng(1),
    params: { ...DEFAULTS, ...overrides },
    theme: THEME,
    emit: (readouts) => {
      emitted.push([...readouts]);
    },
    reducedMotion: false,
  };
  const instance = lorenz.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Stub = ReturnType<typeof stubViz>;

function tick(v: Stub, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with the stroke log cleared first so it holds exactly that frame. */
function paint(v: Stub): void {
  v.fg.strokes.length = 0;
  v.fg.fills.length = 0;
  v.fg.clears.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Stub, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.strokes.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Exactly what src/main.ts does on a resize: both bitmaps are already wiped. */
function resize(v: Stub, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Stub): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function keys(v: Stub): string[] {
  return (v.emitted.at(-1) ?? []).map((r) => r.key);
}

/** Every trail point painted in the last frame, as plate coordinates. */
function painted(v: Stub): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const stroke of v.fg.strokes) {
    for (const [x0, y0, x1, y1] of stroke.segments) {
      if (out.length === 0) out.push([x0, y0]);
      out.push([x1, y1]);
    }
  }
  return out;
}

describe('lorenz instance: readouts', () => {
  it('publishes the exponent against its analytic target, and every number it draws', () => {
    const v = stubViz();
    // 2,760 ticks is 23 simulated time units at one per second: the gap has
    // reached order 1 and the fit has an episode behind it.
    tick(v, 2_760);
    paint(v);
    expect(keys(v)).toEqual(['time', 'separation', 'lyapunov', 'doubling', 'balance', 'x', 'y', 'z']);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));

    expect(by['time']?.value).toBeCloseTo(23, 1);
    // The two numbers the canvas itself prints are both here.
    expect(by['separation']?.value).toBeGreaterThan(0.01);
    expect(by['balance']?.target).toBe(1);
    expect(by['lyapunov']?.target).toBe(LAMBDA_1_CLASSIC);
    expect(by['doubling']?.target).toBe(DOUBLING_CLASSIC);

    // The same fit the pure module gives, up to the refit stride: the instance
    // refits once per time unit rather than on every sample, so its cached
    // slope is at most one time unit behind the episode's.
    const fit = lyapunovEstimate(episode(SEED, GAP, 23).log);
    expect(Math.abs((by['lyapunov']?.value ?? 0) - fit.lambda)).toBeLessThan(0.01);
    expect(Math.abs((by['lyapunov']?.value ?? 0) - LAMBDA_1_CLASSIC)).toBeLessThan(0.2);
  });

  it('headlines the twins’ separation in plain words, and keeps the exponent and the state for the exact table', () => {
    const v = stubViz();
    paint(v);
    const rows = v.emitted.at(-1) ?? [];
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    // Exactly one headline, and it is the number the tab is about.
    expect(rows.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['separation']);
    expect(by['separation']?.plain).toBe('how far apart the twins are now');
    expect(by['separation']?.hint).toBe('they started a billionth apart');
    expect(by['time']?.plain).toBe('seconds elapsed');
    // Internals: a reader with no statistics is not shown a Lyapunov exponent
    // or the raw state; both stay in the exact table.
    for (const key of ['lyapunov', 'x', 'y', 'z']) expect(by[key]?.expertOnly, key).toBe(true);
    for (const key of ['time', 'separation', 'doubling', 'balance']) {
      expect(by[key]?.expertOnly, key).toBeUndefined();
      expect(by[key]?.plain, key).toBeTruthy();
    }
    // The hint follows the starting gap the reader actually chose.
    const close = stubViz({ twinGap: 1e-12 });
    paint(close);
    expect((close.emitted.at(-1) ?? []).find((r) => r.key === 'separation')?.hint).toBe(
      'they started a trillionth apart',
    );
  });

  it('offers no analytic exponent away from Lorenz’s own parameters', () => {
    // Thirty time units: below the threshold the gap has to fall two decades
    // under its own start before the trimmed window has anything in it, and it
    // falls at 0.394 per time unit rather than rising at 0.906.
    const v = stubViz({ rho: 14 });
    tick(v, 3_600);
    paint(v);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(by['lyapunov']?.target).toBeUndefined();
    expect(by['doubling']?.target).toBeUndefined();
    expect(by['balance']?.target).toBe(1);
    // The twins merge below the Hopf threshold, and the fit says so.
    expect(by['separation']?.value).toBeLessThan(1e-9);
    expect(by['lyapunov']?.value).toBeLessThan(0);
    expect(by['doubling']?.value).toBeLessThan(0);
  });

  it('converges the exact identity ⟨x²⟩ = β⟨z⟩ on the plate’s own clock', () => {
    const v = stubViz();
    // 150 time units. The boundary-term bound is 1.07/T = 0.7%.
    tick(v, 18_000);
    paint(v);
    expect(Math.abs((ledger(v)['balance'] ?? 0) - 1)).toBeLessThan(1.07 / 150);
  });

  it('draws without mutating the simulation, and resets to an empty run', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['time']).toBe(0);
    expect((ledger(v)['separation'] ?? 0) / 1e-9).toBeCloseTo(1, 6);
    v.instance.destroy();
  });

  it('reproduces a run exactly from the same seed, and differs from another', () => {
    const a = stubViz();
    const b = stubViz();
    const c = stubViz({ seed: 7 });
    for (const v of [a, b, c]) {
      tick(v, 1_800);
      paint(v);
    }
    expect(ledger(b)).toEqual(ledger(a));
    expect(ledger(c)['x']).not.toBe(ledger(a)['x']);
  });

  it('gives the same ledger on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({}, 1_280, 720);
    const narrow = stubViz({}, 320, 320);
    for (const v of [wide, narrow]) {
      tick(v, 1_800);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
  });

  it('keeps the clock at one time unit per second, exact to one step', () => {
    // 18,000 ticks is 150 seconds of simulation clock, and the fixed step is
    // the only slack the clock may have: one step, plus the rounding of adding
    // h to a running total thirty thousand times.
    const v = stubViz();
    tick(v, 18_000);
    paint(v);
    expect(Math.abs((ledger(v)['time'] ?? 0) - 150)).toBeLessThan(H + 1e-9);
    expect(Math.abs((ledger(v)['balance'] ?? 0) - 1)).toBeLessThan(1.07 / 150);
  });
});

describe('lorenz instance: painting', () => {
  it('draws both trails at 2 px in the two data pens, at full strength', () => {
    const v = stubViz();
    tick(v, 1_200);
    paint(v);
    const drawn = v.fg.strokes.filter((s) => s.segments.length > 0);
    expect(drawn).toHaveLength(2);
    for (const s of drawn) {
      // A hairline in the signal pen drops to 2.20:1 after anti-aliasing, and a
      // translucent one composites through the 3:1 a graphical object owes the
      // plate whatever pen it is in.
      expect(s.width).toBe(2 * THEME.lineWidth);
      expect(s.alpha).toBe(1);
      expect(s.composite).toBe('source-over');
    }
    // The twin goes down first: while the two coincide, the path on screen is
    // the signal pen and not the drafting one.
    expect(drawn[0]?.pen).toBe(THEME.data2);
    expect(drawn[1]?.pen).toBe(THEME.data1);
  });

  it('fades the foreground by removing alpha, never by painting the plate colour over it', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    // Enough frames for the owed fade to reach a payable quantum.
    let fades = 0;
    for (let f = 0; f < 60; f++) {
      tick(v, 4);
      paint(v);
      const full = (r: readonly [number, number, number, number]): boolean =>
        r[2] === v.ctx.width && r[3] === v.ctx.height;
      const wash = v.fg.fills.filter((fill) => full(fill.rect));
      for (const fill of wash) {
        expect(fill.composite).toBe('destination-out');
        expect(fill.style).not.toBe(THEME.canvas);
        expect(fill.alpha).toBe(1);
      }
      // A frame that fades never also wipes the layer it is fading.
      if (wash.length > 0) {
        fades++;
        expect(v.fg.clears.some(full)).toBe(false);
      }
    }
    expect(fades).toBeGreaterThan(0);
  });

  it('never paints more points than the budget, however long it runs', () => {
    const v = stubViz();
    tick(v, 18_000);
    paint(v);
    // A full repaint after the fast-forward: two trails, each capped at the ring.
    const budget = lorenz.budget?.maxEntities ?? 0;
    expect(painted(v).length).toBeLessThanOrEqual(2 * budget + 2);
    // …and the trail really is at its ceiling by now — 150 time units at one
    // point per 0.005 is 30,000 pushes into a 4,000-point ring, so both trails
    // are full and together exceed one ring.
    expect(painted(v).length).toBeGreaterThan(budget);
  });

  it('keeps every painted point on the plate, and uses the plate it is given', () => {
    const v = stubViz({}, 700, 700);
    tick(v, 12_000);
    paint(v);
    const points = painted(v);
    expect(points.length).toBeGreaterThan(1_000);
    for (const [px, py] of points) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(700);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(700);
    }
    // The attractor uses the plate it is given rather than sitting in a corner.
    const xs = points.map(([px]) => px);
    const ys = points.map(([, py]) => py);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5 * 700);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5 * 700);
  });

  it('re-lays-out the trail on a resize instead of stranding it', () => {
    const v = stubViz({}, 400, 400);
    tick(v, 4_000);
    paint(v);
    const before = ledger(v);

    resize(v, 1_000, 1_000);
    expect(ledger(v)).toEqual(before);
    const big = painted(v);
    expect(big.length).toBeGreaterThan(1_000);
    const spanBig = Math.max(...big.map(([px]) => px)) - Math.min(...big.map(([px]) => px));
    expect(spanBig).toBeGreaterThan(400);

    resize(v, 300, 300);
    for (const [px, py] of painted(v)) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(300);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(300);
    }
  });

  it('marks the three fixed points and both axes on the background, in the container pen', () => {
    const v = stubViz();
    const pens = new Set(v.bg.strokes.map((s) => s.pen));
    expect(pens).toEqual(new Set([THEME.gridSoft]));
    // The axes and their graduations are one path; the fixed points are another.
    expect(v.bg.strokes.length).toBe(2);
    expect(v.bg.strokes[0]?.width).toBe(THEME.lineWidth);
    expect(v.bg.strokes[1]?.width).toBe(2 * THEME.lineWidth);
  });
});

describe('lorenz instance: parameters', () => {
  it('defers both knobs, and the seed, to a reset — each one is a different experiment', () => {
    const v = stubViz();
    tick(v, 600);
    for (const key of ['rho', 'twinGap', 'seed']) {
      expect(v.instance.onParamChange?.(key, 1), key).toBe(false);
    }
    // And the reset the shell then performs really starts over: the clock is
    // back at zero and the twins are a fresh gap apart.
    setParam(v, 'twinGap', 1e-6);
    expect(ledger(v)['time']).toBe(0);
    expect((ledger(v)['separation'] ?? 0) / 1e-6).toBeCloseTo(1, 6);
  });

  it('reads a gap the rail has rounded to zero as the declared minimum', () => {
    // The fader's value grid bottoms out at ten decimals, so every position
    // under 5·10⁻¹¹ arrives here as 0 — and a zero gap is one trajectory drawn
    // twice, with ln 0 in the ledger.
    const v = stubViz({ twinGap: 0 });
    paint(v);
    // Not exactly 10⁻¹²: (x + ε) − x rounds, and at x ≈ 1.3 that is a part in
    // ten thousand of the gap. The point is that it is a gap at all.
    expect((ledger(v)['separation'] ?? 0) / 1e-12).toBeCloseTo(1, 3);
    tick(v, 3_600);
    paint(v);
    expect(ledger(v)['separation']).toBeGreaterThan(1e-6);
    expect(Number.isFinite(ledger(v)['lyapunov'] ?? NaN)).toBe(true);
  });
});

/** Prose, with its `<var>` segments flattened back into the sentence. */
function flatten(text: Prose): string {
  return typeof text === 'string'
    ? text
    : text.map((seg) => (typeof seg === 'string' ? seg : seg.v)).join('');
}

describe('lorenz metadata', () => {
  it('declares two knobs and an unrendered seed, nothing more', () => {
    // The heat crosses the chaos threshold; the gap is what the twins are
    // about. The seed has no control on the rail but stays a spec so a
    // permalink's seed is honoured and Shuffle has something to write.
    expect(lorenz.params.map((p) => p.key)).toEqual(['rho', 'twinGap', 'seed']);
    expect(lorenz.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(lorenz.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    const rho = lorenz.params.find((p) => p.key === 'rho');
    expect(rho?.kind).toBe('range');
    if (rho?.kind === 'range') {
      expect(rho.min).toBeLessThan(hopfThreshold(CLASSIC));
      expect(rho.max).toBeGreaterThan(hopfThreshold(CLASSIC));
      expect(rho.default).toBe(CLASSIC.rho);
    }
    expect(lorenz.id).toBe('lorenz');
    expect(lorenz.group).toBe('chaos');
    expect(lorenz.budget?.maxEntities).toBe(4_000);
  });

  it('sets every preset value from a declared parameter, and from its own range', () => {
    expect(lorenz.presets).toHaveLength(3);
    for (const preset of lorenz.presets ?? []) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = lorenz.params.find((p) => p.key === key);
        expect(spec, `preset ${preset.id} sets unknown param ${key}`).toBeDefined();
        if (spec?.kind === 'range' && typeof value === 'number') {
          expect(value, `preset ${preset.id}: ${key}`).toBeGreaterThanOrEqual(spec.min);
          expect(value, `preset ${preset.id}: ${key}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec?.kind === 'choice') {
          expect(spec.options.map((o) => o.value)).toContain(value);
        }
      }
    }
  });

  it('sources both facts, and keeps every sentence to one', () => {
    // A sentence ends at a full stop, exclamation or question mark followed by
    // whitespace — the same test the fact card applies — so a decimal point
    // inside a number does not count.
    const oneSentence = (text: string): boolean => !/[.!?]\s/.test(text.trim());
    expect(lorenz.facts).toHaveLength(2);
    for (const fact of lorenz.facts) {
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
      expect(oneSentence(flatten(fact.text)), flatten(fact.text)).toBe(true);
    }
    for (const spec of lorenz.params) expect(flatten(spec.help ?? ''), spec.key).not.toBe('');
    for (const preset of lorenz.presets ?? []) {
      expect(oneSentence(flatten(preset.caption)), preset.id).toBe(true);
    }
    expect(oneSentence(flatten(lorenz.blurb))).toBe(true);
  });

  it('quotes only numbers the mathematics module actually produces', () => {
    // Every number the prose asserts is computed, not recalled, so a change to
    // the function behind it has to break this rather than leave the prose
    // quietly wrong.
    const said = lorenz.facts.map((f) => flatten(f.text)).join(' ');
    expect(hopfThreshold(CLASSIC).toFixed(2)).toBe('24.74');
    expect(said).toContain('24.74');
    // The heat fader's help rounds the same threshold to one decimal.
    const help = lorenz.params.map((p) => flatten(p.help ?? '')).join(' ');
    expect(hopfThreshold(CLASSIC).toFixed(1)).toBe('24.7');
    expect(help).toContain('24.7');
    // "Every ten times closer buys about 2.5 more seconds": ln 10 / λ₁.
    expect((Math.log(10) / LAMBDA_1_CLASSIC).toFixed(1)).toBe('2.5');
    expect(help).toContain('2.5');
    // The captions: 10⁻⁹ to order 1 in about twenty seconds, and a thousand
    // times closer buys ln 1000 / λ₁ ≈ 7.6 more — "about eight".
    const captions = (lorenz.presets ?? []).map((p) => flatten(p.caption)).join(' ');
    expect(Math.log(1e9) / LAMBDA_1_CLASSIC).toBeGreaterThan(20);
    expect(Math.log(1e9) / LAMBDA_1_CLASSIC).toBeLessThan(25);
    expect(captions).toContain('twenty seconds');
    expect(Math.round(Math.log(1e3) / LAMBDA_1_CLASSIC)).toBe(8);
    expect(captions).toContain('eight more seconds');
    // The volume contraction is still computed; it is just no longer quoted.
    expect(volumeContraction(CLASSIC).toFixed(2)).toBe('-13.67');
  });

  it('says the starting gap in words a reader can hear', () => {
    expect(gapInWords(1e-9)).toBe('a billionth');
    expect(gapInWords(1e-12)).toBe('a trillionth');
    expect(gapInWords(1e-6)).toBe('a millionth');
    expect(gapInWords(1e-3)).toBe('a thousandth');
    expect(gapInWords(2.5e-10)).toBe('250 trillionths');
    expect(gapInWords(3.7e-8)).toBe('37 billionths');
    // The rail rounds to ten decimals, so a gap can arrive a rounding under a
    // power of a thousand; that is still "a billionth", not "1000 trillionths".
    expect(gapInWords(9.999999999e-10)).toBe('a billionth');
    expect(gapInWords(9.99e-10)).toBe('999 trillionths');
  });
});
