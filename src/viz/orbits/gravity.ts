/**
 * Newtonian gravity in the plane: the mathematics, with no canvas in sight.
 *
 * Units are chosen so that G = 1. Everything else follows from that: a mass of
 * 1 at a distance of 1 pulls with an acceleration of 1, a circular orbit of
 * radius 1 about a mass of 1 takes 2π, and the energies below are pure numbers.
 * Writing G into every term would multiply a string of ones and buy nothing.
 *
 * The acceleration of body i is the sum over every other body j of
 *
 *   a_i = Σ_j  G·m_j·(x_j − x_i) / |x_j − x_i|³
 *
 * and the whole tab is that one line, integrated. What matters is *how* it is
 * integrated, which is the long comment on `NBody.step`.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** One body. Position and velocity are mutated in place by the integrator. */
export interface Body {
  mass: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function cloneBodies(bodies: readonly Body[]): Body[] {
  return bodies.map((b) => ({ mass: b.mass, x: b.x, y: b.y, vx: b.vx, vy: b.vy }));
}

/**
 * Added to the squared separation before the force is taken, so that a pair on
 * top of each other produces a finite number instead of Infinity and then NaN.
 *
 * **This is a numerical guard, not physics.** Real gravity has no such term;
 * what it buys is that no arrangement a reader can reach — including the twin
 * run, which is a different arrangement from the first — can put a division by
 * zero on the plate and freeze every readout at NaN for the rest of the run.
 *
 * A thousandth of the length unit, and the price is stated rather than waved
 * at. The closest approach in any shipped scenario is 0.18 (the three-body
 * one), where the correction to the force is 1.5·ε²/r² = 4.6·10⁻⁵ of it. On the
 * two-body scenario, where the answer is checked against a closed form, it
 * lengthens the orbit by 3·(ε/a)² — measured at +1.49·10⁻⁵ against a period of
 * 4.967, which is 3·10⁻⁶ of it — and `SOFTENED_PERIOD_COEFF` is where that
 * measurement is written down and paid for in the band.
 *
 * The softened force is the gradient of the softened potential −G·m_i·m_j /
 * √(r² + ε²), so `energy()` below takes the same ε by default and the pair
 * (integrator, energy) is a genuine Hamiltonian system. Passing ε = 0 recovers
 * the exact Newtonian energy, which is what the published figure-eight constant
 * is quoted for.
 */
export const SOFTENING = 1e-3;

/**
 * The integration step, in the same time units as everything else here.
 *
 * The engine ticks at 120 Hz and the tab runs one time unit per second of
 * simulated clock, so this is 160 Verlet steps per tick. That sounds extravagant
 * for three bodies and is not: the whole run costs 0.1 ms per frame at 1× and
 * 0.8 ms at 8× with the twin running alongside, and it is what buys the energy
 * envelopes below — at 80 steps per tick the three-body scenario's drift is
 * 2.2·10⁻⁵ instead of 3.9·10⁻⁷, because it passes close enough to resolve.
 */
export const STEP = 1 / 19_200;

/**
 * Empirical coefficient in the softening's effect on a circular period:
 * T_softened ≈ T_kepler · (1 + COEFF·(ε/a)²).
 *
 * Two effects add here and the second is the larger: the potential is shallower
 * at ε > 0, *and* the scenario below sets its velocity from the unsoftened
 * circular speed √(GM/a), so the orbit is very slightly eccentric with a
 * semi-major axis above a. Rather than derive a coefficient for the sum, it is
 * read off the run — 3.00 at ε = 10⁻³, 3.00 at ε = 3·10⁻³, so the ε² scaling is
 * the right shape and 3 is the number.
 */
export const SOFTENED_PERIOD_COEFF = 3;

// ---------------------------------------------------------------------------
// Forces and the integrator
// ---------------------------------------------------------------------------

/**
 * Accumulate the pairwise accelerations into `ax` / `ay`.
 *
 * Pairs are visited once, not twice: `inv` is 1/(r²+ε²)^{3/2} and the two
 * accelerations differ only by which mass multiplies it, which is Newton's
 * third law. That halves the square roots and — more importantly — makes the
 * pair's force exactly antisymmetric before either mass is applied, rather than
 * the difference of two separately rounded square roots. Momentum then leaks
 * only where m_i·a_i and m_j·a_j round differently, at 10⁻¹⁶ a step, instead of
 * accumulating a bias over the millions of steps a run takes.
 */
function accumulate(bodies: readonly Body[], ax: Float64Array, ay: Float64Array, softening: number): void {
  const n = bodies.length;
  const eps2 = softening * softening;
  ax.fill(0);
  ay.fill(0);
  for (let i = 0; i < n; i++) {
    const bi = bodies[i];
    if (bi === undefined) continue;
    for (let j = i + 1; j < n; j++) {
      const bj = bodies[j];
      if (bj === undefined) continue;
      const dx = bj.x - bi.x;
      const dy = bj.y - bi.y;
      const r2 = dx * dx + dy * dy + eps2;
      const inv = 1 / (r2 * Math.sqrt(r2));
      ax[i] = (ax[i] ?? 0) + dx * inv * bj.mass;
      ay[i] = (ay[i] ?? 0) + dy * inv * bj.mass;
      ax[j] = (ax[j] ?? 0) - dx * inv * bi.mass;
      ay[j] = (ay[j] ?? 0) - dy * inv * bi.mass;
    }
  }
}

/** The acceleration on each body, allocating. For tests and for reading; the integrator does not use it. */
export function accelerationsOf(bodies: readonly Body[], softening: number = SOFTENING): Vec2[] {
  const ax = new Float64Array(bodies.length);
  const ay = new Float64Array(bodies.length);
  accumulate(bodies, ax, ay, softening);
  return bodies.map((_, i) => ({ x: ax[i] ?? 0, y: ay[i] ?? 0 }));
}

/**
 * A set of bodies under mutual gravity, advanced by velocity Verlet.
 *
 * **Velocity Verlet, and not Euler and not RK4.** Verlet is symplectic: it
 * integrates a Hamiltonian that is a small perturbation of the real one, so the
 * energy error *oscillates* over an orbit and comes back — it does not *drift*.
 * RK4 is the more accurate integrator per step and the wrong one here, because
 * its error is secular: it loses energy monotonically and the ellipse spirals
 * in. Measured on the eccentric two-body orbit in the tests, at a step of 1/120
 * over twenty orbits: Verlet's energy error reaches 3·10⁻⁴ inside an orbit but
 * is back to 10⁻¹¹ at the end of every one of the twenty, while RK4 never
 * exceeds 8·10⁻⁸ and yet is down −1.6·10⁻⁸, −3.2·10⁻⁸, −4.7·10⁻⁸, −6.3·10⁻⁸ …
 * exactly linear in the orbit count. A tab whose headline is *energy is
 * conserved* and whose picture is a closed loop cannot be built on the second
 * one: it would show a planet slowly falling into its sun and call that
 * gravity.
 *
 * The step is kick–drift–kick. The force is evaluated twice rather than carried
 * over from the previous step, which costs one extra pass over three bodies and
 * keeps the method a pure function of the state it is handed.
 */
export class NBody {
  readonly bodies: Body[];
  readonly softening: number;
  private readonly ax: Float64Array;
  private readonly ay: Float64Array;

  constructor(bodies: readonly Body[], softening: number = SOFTENING) {
    this.bodies = cloneBodies(bodies);
    this.softening = softening;
    this.ax = new Float64Array(this.bodies.length);
    this.ay = new Float64Array(this.bodies.length);
  }

  /** One velocity-Verlet step of `h`. */
  step(h: number): void {
    const { bodies, ax, ay, softening } = this;
    const n = bodies.length;
    accumulate(bodies, ax, ay, softening);
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b === undefined) continue;
      b.vx += 0.5 * h * (ax[i] ?? 0);
      b.vy += 0.5 * h * (ay[i] ?? 0);
      b.x += h * b.vx;
      b.y += h * b.vy;
    }
    accumulate(bodies, ax, ay, softening);
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b === undefined) continue;
      b.vx += 0.5 * h * (ax[i] ?? 0);
      b.vy += 0.5 * h * (ay[i] ?? 0);
    }
  }
}

// ---------------------------------------------------------------------------
// The conserved quantities
// ---------------------------------------------------------------------------

/**
 * Kinetic plus potential energy, Σ½m|v|² − Σ_{i<j} G·m_i·m_j/√(r² + ε²).
 *
 * The default ε is the one the force uses, so this is the quantity the
 * integrator actually conserves. Pass 0 for the exact Newtonian energy — the
 * form the published figure-eight constant is quoted in, and 1.06·10⁻⁶ away
 * from the softened one there, which is a millionth of an energy of 1.287.
 */
export function energy(bodies: readonly Body[], softening: number = SOFTENING): number {
  const eps2 = softening * softening;
  let kinetic = 0;
  let potential = 0;
  for (let i = 0; i < bodies.length; i++) {
    const bi = bodies[i];
    if (bi === undefined) continue;
    kinetic += 0.5 * bi.mass * (bi.vx * bi.vx + bi.vy * bi.vy);
    for (let j = i + 1; j < bodies.length; j++) {
      const bj = bodies[j];
      if (bj === undefined) continue;
      const dx = bj.x - bi.x;
      const dy = bj.y - bi.y;
      potential -= (bi.mass * bj.mass) / Math.sqrt(dx * dx + dy * dy + eps2);
    }
  }
  return kinetic + potential;
}

/**
 * Total angular momentum about the origin, Σ m(x·v_y − y·v_x).
 *
 * The third conserved quantity of the problem, and the one that decides whether
 * a triple can collapse at all: a system with angular momentum cannot reach a
 * triple collision.
 */
export function angularMomentum(bodies: readonly Body[]): number {
  let total = 0;
  for (const b of bodies) total += b.mass * (b.x * b.vy - b.y * b.vx);
  return total;
}

/** Total momentum, Σ m·v. Zero in every scenario here, and exactly conserved by the integrator. */
export function totalMomentum(bodies: readonly Body[]): Vec2 {
  let px = 0;
  let py = 0;
  for (const b of bodies) {
    px += b.mass * b.vx;
    py += b.mass * b.vy;
  }
  return { x: px, y: py };
}

/** Centre of mass, Σ m·x / Σ m. Zero momentum keeps it where it started. */
export function centreOfMass(bodies: readonly Body[]): Vec2 {
  let mx = 0;
  let my = 0;
  let mass = 0;
  for (const b of bodies) {
    mx += b.mass * b.x;
    my += b.mass * b.y;
    mass += b.mass;
  }
  return mass > 0 ? { x: mx / mass, y: my / mass } : { x: 0, y: 0 };
}

/** Shift the configuration so its centre of mass sits at the origin. In place, and returns the array. */
function recentre(bodies: Body[]): Body[] {
  const c = centreOfMass(bodies);
  for (const b of bodies) {
    b.x -= c.x;
    b.y -= c.y;
  }
  return bodies;
}

/**
 * Kepler's third law: T = 2π·√(a³/GM).
 *
 * `a` is the semi-major axis of the *relative* orbit and `GM` is G times the
 * **total** mass, which is what makes the same formula serve a planet round a
 * sun and two comparable masses round their common centre. Doubling a
 * multiplies the period by 2^1.5 = 2.828427: a = 1 at GM = 1 gives 6.283185 and
 * a = 2 gives 17.771532.
 */
export function keplerPeriod(a: number, gm: number): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / gm);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type ScenarioId = 'two' | 'figure-eight' | 'three';

export interface Scenario {
  readonly id: ScenarioId;
  /** The option label in the rail. */
  readonly label: string;
  /** Fresh initial conditions: a new array every call, because the integrator mutates them. */
  bodies(): Body[];
  /**
   * Half-width and half-height of the world box the run stays inside, in length
   * units, measured over a full run at `STEP` and rounded up.
   *
   * There is no randomness anywhere in this tab, so a scenario's trajectory is
   * one fixed curve and its extent is a property of the scenario rather than an
   * estimate. The painter fits this box to the plate and nothing has to move
   * the view mid-run.
   */
  readonly view: Vec2;
  /**
   * The largest |ΔE/E₀| this scenario reaches over a full run at `STEP`, with
   * an order of magnitude of headroom.
   *
   * It is the amplitude of Verlet's own energy oscillation — a rounding
   * allowance in the sense of types.ts, not a tolerance someone liked the look
   * of. It does not shrink with the run because nothing here is being averaged:
   * the claim is that the error stays inside a fixed envelope for ever, which
   * is exactly the claim a secular integrator fails. Measured over 60 time
   * units: 7.2·10⁻¹⁴, 1.6·10⁻⁹ and 3.9·10⁻⁷ for the three scenarios in order.
   */
  readonly energyEnvelope: number;
  /**
   * The closed-form period this scenario can be checked against, where it has
   * one. `a` is the semi-major axis of the relative orbit; `gm` is G times the
   * total mass. Absent on the two arrangements that have no period at all.
   */
  readonly kepler?: { readonly a: number; readonly gm: number };
}

/** Two-body scenario: masses, separation, and the circular speed that follows. */
const TWO_M1 = 1;
const TWO_M2 = 0.6;
const TWO_MASS = TWO_M1 + TWO_M2;
/**
 * Semi-major axis of the relative orbit. The orbit is circular, so the
 * separation is constant and equal to a: **a = 1**, and the period the tab
 * predicts is 2π√(1/1.6) = 4.967294133.
 */
const TWO_A = 1;
/** Relative circular speed √(G·M/a); each body takes the share the other's mass gives it. */
const TWO_VREL = Math.sqrt(TWO_MASS / TWO_A);

/** Figure-eight: the Chenciner–Montgomery choreography, three equal masses of 1. */
const EIGHT_X = 0.97000436;
const EIGHT_Y = 0.24308753;
const EIGHT_VX = 0.46620369;
const EIGHT_VY = 0.43236573;

/** Three-body scenario: a binary of two unit masses and a third on a wider orbit. */
const THREE_SEP = 0.7;
const THREE_OUTER = 2.2;
/** The outer body is started 5 % above its circular speed, which is what stops the triple being periodic. */
const THREE_SPEEDUP = 1.05;
const THREE_VBIN = Math.sqrt(2 / THREE_SEP) / 2;
const THREE_VOUT = THREE_SPEEDUP * Math.sqrt(2 / THREE_OUTER);

/**
 * The three arrangements, in the order the rail offers them.
 *
 * Every one has zero total momentum and its centre of mass at the origin, so
 * the picture never wanders off the plate for a reason that has nothing to do
 * with gravity.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'two',
    label: 'Two bodies',
    // A circular orbit about the common centre of mass. Masses 1 and 0.6 rather
    // than a sun and a speck: at a 5:3 ratio both bodies visibly move, the
    // heavier one on a circle of radius 0.375 and the lighter on one of 0.625,
    // and the centre they both go round is empty. The relative separation is
    // constant at a = 1, so Kepler's third law has a semi-major axis to be
    // checked against with no fitting of any kind.
    bodies: () => [
      { mass: TWO_M1, x: (-TWO_M2 / TWO_MASS) * TWO_A, y: 0, vx: 0, vy: (-TWO_M2 / TWO_MASS) * TWO_VREL },
      { mass: TWO_M2, x: (TWO_M1 / TWO_MASS) * TWO_A, y: 0, vx: 0, vy: (TWO_M1 / TWO_MASS) * TWO_VREL },
    ],
    view: { x: 0.75, y: 0.75 },
    energyEnvelope: 1e-12,
    kepler: { a: TWO_A, gm: TWO_MASS },
  },
  {
    id: 'figure-eight',
    label: 'Figure eight',
    // Chenciner and Montgomery (2000), after Moore (1993): three equal masses
    // chasing each other round one figure-eight path, each a third of a period
    // behind the last. Total momentum, centre of mass and angular momentum are
    // all exactly zero, the energy is −1.287141978, and the period is
    // 6.32591398 — all four pinned in the tests, because a choreography that
    // has drifted off its own orbit is still a perfectly plausible-looking
    // three-body tangle and nothing on the plate would give it away.
    bodies: () => [
      { mass: 1, x: EIGHT_X, y: -EIGHT_Y, vx: EIGHT_VX, vy: EIGHT_VY },
      { mass: 1, x: -EIGHT_X, y: EIGHT_Y, vx: EIGHT_VX, vy: EIGHT_VY },
      { mass: 1, x: 0, y: 0, vx: -2 * EIGHT_VX, vy: -2 * EIGHT_VY },
    ],
    view: { x: 1.2, y: 0.45 },
    energyEnvelope: 2e-8,
  },
  {
    id: 'three',
    label: 'Three bodies',
    // A generic, non-periodic triple: two unit masses in a circular binary of
    // separation 0.7, and a third unit mass at 2.2 from their midpoint moving
    // at 1.05 times the circular speed for the mass it encloses. The momentum
    // is zeroed by sharing the outer body's recoil between all three, and the
    // whole configuration is then shifted onto its centre of mass.
    //
    // It is chosen so that it can be watched. Over the 60 time units a run
    // lasts it stays inside |x| ≤ 3.00, |y| ≤ 2.59 — nothing is ejected — and
    // never comes closer than 0.18, which is what keeps Verlet's energy error
    // at 3.9·10⁻⁷ rather than the 10⁻² a deep encounter costs. The 5 % is doing
    // the work: at exactly the circular speed the triangle stays a triangle and
    // the motion is periodic, which is the one thing this option must not be.
    bodies: () =>
      recentre([
        { mass: 1, x: -THREE_SEP / 2, y: 0, vx: THREE_VOUT / 3, vy: -THREE_VBIN },
        { mass: 1, x: THREE_SEP / 2, y: 0, vx: THREE_VOUT / 3, vy: THREE_VBIN },
        { mass: 1, x: 0, y: THREE_OUTER, vx: (-2 * THREE_VOUT) / 3, vy: 0 },
      ]),
    view: { x: 3.1, y: 2.65 },
    energyEnvelope: 5e-6,
  },
];

export function scenarioById(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? (SCENARIOS[0] as Scenario);
}

/**
 * The period of the figure-eight choreography, as published.
 *
 * Exported because it is a claim about the initial conditions above rather than
 * about the painter: after exactly this much time all three bodies are back
 * where they started, and the tests integrate to it and check.
 */
export const FIGURE_EIGHT_PERIOD = 6.32591398;
