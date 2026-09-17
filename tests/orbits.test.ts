import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { MAX_BAND_FRACTION, agrees, bandOf, testable, verdictOf } from '../src/ui/readouts';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import { MAX_CHIPS } from '../src/ui/story';
import { registry } from '../src/viz/registry';
import { bodyRadius, formatDrift, orbits, viewFor } from '../src/viz/orbits/index';
import {
  FIGURE_EIGHT_PERIOD,
  NBody,
  SCENARIOS,
  SOFTENED_PERIOD_COEFF,
  SOFTENING,
  STEP,
  accelerationsOf,
  angularMomentum,
  centreOfMass,
  cloneBodies,
  energy,
  keplerPeriod,
  scenarioById,
  totalMomentum,
  type Body,
  type Scenario,
} from '../src/viz/orbits/gravity';

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** `MAX_TIME` in the module: where a run stops, in simulated time units. */
const MAX_TIME = 60;

/** Engine ticks that take a run from zero to `MAX_TIME` at 1×. */
const FULL_RUN_TICKS = Math.ceil(MAX_TIME * 120);

/** The published figure-eight energy, from Chenciner and Montgomery. */
const EIGHT_ENERGY = -1.287141987;

/**
 * Words a visitor would have to look up, banned from every surface a visitor
 * reads without asking for it: the blurb, the simple view, the rail's help and
 * the story captions. `Readout.label` is deliberately outside this — types.ts
 * reserves it for the precise name the exact table shows.
 */
const JARGON =
  /\b(symplectic|hamiltonian|verlet|integrator|secular|lyapunov|eccentricity|perturbation|analytic|converged|estimator|asymptotic|phase space)\b/i;

/** A second sentence, for the fields that are allowed exactly one. */
const SECOND_SENTENCE = /[.!?]\s+\S/;

function flatten(prose: Prose | undefined): string {
  if (prose === undefined) return '';
  if (typeof prose === 'string') return prose;
  return prose.map((seg) => (typeof seg === 'string' ? seg : seg.v)).join('');
}

// ---------------------------------------------------------------------------
// Helpers over a set of bodies
// ---------------------------------------------------------------------------

function minSeparation(bodies: readonly Body[]): number {
  let smallest = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      if (!a || !b) continue;
      smallest = Math.min(smallest, Math.hypot(b.x - a.x, b.y - a.y));
    }
  }
  return smallest;
}

function furthestApart(a: readonly Body[], b: readonly Body[]): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (!p || !q) continue;
    worst = Math.max(worst, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return worst;
}

interface Survey {
  /** Largest |ΔE/E₀| reached at any point in the run. */
  drift: number;
  extentX: number;
  extentY: number;
  minSeparation: number;
  bodies: Body[];
}

/** Integrate a scenario for `time` units at the shipped step, watching everything that is claimed about it. */
function survey(scenario: Scenario, time = MAX_TIME): Survey {
  const sim = new NBody(scenario.bodies());
  const start = energy(sim.bodies);
  let drift = 0;
  let extentX = 0;
  let extentY = 0;
  let closest = Infinity;
  for (let i = 0; i < Math.round(time / STEP); i++) {
    sim.step(STEP);
    for (const b of sim.bodies) {
      extentX = Math.max(extentX, Math.abs(b.x));
      extentY = Math.max(extentY, Math.abs(b.y));
    }
    closest = Math.min(closest, minSeparation(sim.bodies));
    drift = Math.max(drift, Math.abs((energy(sim.bodies) - start) / start));
  }
  return { drift, extentX, extentY, minSeparation: closest, bodies: sim.bodies };
}

// ---------------------------------------------------------------------------
// The force law
// ---------------------------------------------------------------------------

describe('Newtonian gravity', () => {
  it('pulls each body towards the other by G·m/r², with G = 1', () => {
    const pair: Body[] = [
      { mass: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { mass: 1, x: 1, y: 0, vx: 0, vy: 0 },
    ];
    const [a, b] = accelerationsOf(pair, 0);
    expect(a?.x).toBeCloseTo(1, 12);
    expect(a?.y).toBeCloseTo(0, 12);
    expect(b?.x).toBeCloseTo(-1, 12);

    // Inverse square: twice as far is a quarter of the pull.
    pair[1] = { mass: 1, x: 2, y: 0, vx: 0, vy: 0 };
    expect(accelerationsOf(pair, 0)[0]?.x).toBeCloseTo(0.25, 12);

    // And it is the *other* body's mass that appears, not your own.
    pair[1] = { mass: 3, x: 1, y: 0, vx: 0, vy: 0 };
    const [light, heavy] = accelerationsOf(pair, 0);
    expect(light?.x).toBeCloseTo(3, 12);
    expect(heavy?.x).toBeCloseTo(-1, 12);
  });

  it('sums the pull of every other body, not just the nearest', () => {
    // Two unit masses either side at distance 1 cancel exactly; a third above
    // is the only pull left.
    const three: Body[] = [
      { mass: 1, x: -1, y: 0, vx: 0, vy: 0 },
      { mass: 1, x: 1, y: 0, vx: 0, vy: 0 },
      { mass: 1, x: 0, y: 2, vx: 0, vy: 0 },
    ];
    const a = accelerationsOf(three, 0)[2];
    expect(a?.x).toBeCloseTo(0, 12);
    // Each of the two is at distance √5, and only the vertical component survives.
    const r = Math.sqrt(5);
    expect(a?.y).toBeCloseTo((-2 * 2) / (r * r * r), 12);
  });

  it('keeps every pair equal and opposite, so momentum cannot leak', () => {
    // Evaluated once per pair, the shared 1/r³ makes the two forces exactly
    // antisymmetric before either mass is applied: equal masses cancel to the
    // last bit rather than to the difference of two rounded square roots.
    const equal: Body[] = [
      { mass: 1.5, x: -0.4, y: 0.3, vx: 0, vy: 0 },
      { mass: 1.5, x: 0.9, y: -0.2, vx: 0, vy: 0 },
    ];
    const pair = accelerationsOf(equal);
    expect(pair[0]?.x).toBe(-(pair[1]?.x ?? 0));
    expect(pair[0]?.y).toBe(-(pair[1]?.y ?? 0));

    // With three unequal masses the products m·a round separately, and that is
    // all that is left: a total force of 10⁻¹⁶ rather than a bias that would
    // walk the whole system across the plate over a million steps.
    const bodies: Body[] = [
      { mass: 2, x: -0.4, y: 0.3, vx: 0, vy: 0 },
      { mass: 0.5, x: 0.9, y: -0.2, vx: 0, vy: 0 },
      { mass: 1.25, x: 0.1, y: 1.4, vx: 0, vy: 0 },
    ];
    const acc = accelerationsOf(bodies);
    let px = 0;
    let py = 0;
    bodies.forEach((b, i) => {
      px += b.mass * (acc[i]?.x ?? 0);
      py += b.mass * (acc[i]?.y ?? 0);
    });
    expect(Math.hypot(px, py)).toBeLessThan(1e-15);
  });

  it('survives a collision instead of returning NaN', () => {
    // The whole job of the softening. Two bodies at the same point pull with
    // 0/ε³, which is zero and not NaN…
    const same: Body[] = [
      { mass: 1, x: 0.5, y: -0.25, vx: 0, vy: 0 },
      { mass: 1, x: 0.5, y: -0.25, vx: 0, vy: 0 },
    ];
    for (const a of accelerationsOf(same)) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.y)).toBe(true);
    }
    // …and a pair a billionth apart pulls hard, but finitely: the softened
    // force peaks at 0.385·m/ε², which is where it can be bounded.
    const near: Body[] = [
      { mass: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { mass: 1, x: 1e-9, y: 0, vx: 0, vy: 0 },
    ];
    const pull = Math.abs(accelerationsOf(near)[0]?.x ?? Infinity);
    expect(Number.isFinite(pull)).toBe(true);
    expect(pull).toBeLessThan(0.4 / (SOFTENING * SOFTENING));
    // Unsoftened, the same pair is 10¹⁸ — the number this guard exists to stop.
    expect(Math.abs(accelerationsOf(near, 0)[0]?.x ?? 0)).toBeGreaterThan(1e17);
  });

  it('costs 1.5·(ε/r)² of the force at the separations the tab actually uses', () => {
    // The price of the guard, stated rather than assumed. At the closest
    // approach of the busiest scenario it is five parts in a hundred thousand.
    const closest = 0.18;
    const pair: Body[] = [
      { mass: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { mass: 1, x: closest, y: 0, vx: 0, vy: 0 },
    ];
    const exact = accelerationsOf(pair, 0)[0]?.x ?? 0;
    const softened = accelerationsOf(pair)[0]?.x ?? 0;
    const cost = (exact - softened) / exact;
    expect(cost).toBeCloseTo(1.5 * (SOFTENING / closest) ** 2, 8);
    expect(cost).toBeLessThan(5e-5);
  });
});

// ---------------------------------------------------------------------------
// The conserved quantities and Kepler
// ---------------------------------------------------------------------------

describe('the conserved quantities', () => {
  it('adds kinetic to potential, with the softening it was given', () => {
    const pair: Body[] = [
      { mass: 2, x: -1, y: 0, vx: 0, vy: 1 },
      { mass: 2, x: 1, y: 0, vx: 0, vy: -1 },
    ];
    // ½·2·1 twice, less G·2·2/2.
    expect(energy(pair, 0)).toBeCloseTo(2 - 2, 12);
    // Softening makes the well shallower, so the energy goes up, by
    // G·m₁m₂·ε²/(2r³) to leading order.
    expect(energy(pair) - energy(pair, 0)).toBeCloseTo((4 * SOFTENING ** 2) / (2 * 8), 12);
  });

  it('reads angular momentum and the centre of mass off the configuration', () => {
    const bodies: Body[] = [
      { mass: 3, x: 0, y: 2, vx: 1, vy: 0 },
      { mass: 1, x: 4, y: -2, vx: 0, vy: 0 },
    ];
    // m·(x·vy − y·vx) = 3·(0 − 2·1) = −6.
    expect(angularMomentum(bodies)).toBeCloseTo(-6, 12);
    expect(centreOfMass(bodies)).toEqual({ x: 1, y: 1 });
    expect(totalMomentum(bodies)).toEqual({ x: 3, y: 0 });
    expect(centreOfMass([])).toEqual({ x: 0, y: 0 });
  });

  it('gives Kepler’s third law, and the 2^1.5 that follows from it', () => {
    expect(keplerPeriod(1, 1)).toBeCloseTo(6.283185, 6);
    expect(keplerPeriod(2, 1)).toBeCloseTo(17.771532, 6);
    expect(keplerPeriod(2, 1) / keplerPeriod(1, 1)).toBeCloseTo(2 ** 1.5, 12);
    expect(2 ** 1.5).toBeCloseTo(2.828427, 6);
    // Four times the mass halves the period, whatever the axis.
    expect(keplerPeriod(3, 4)).toBeCloseTo(keplerPeriod(3, 1) / 2, 12);
  });
});

// ---------------------------------------------------------------------------
// Why velocity Verlet and not RK4
// ---------------------------------------------------------------------------

/** One classical RK4 step over the same softened force, for the comparison below. */
function rk4Step(bodies: Body[], h: number): void {
  const state = bodies.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy }));
  const at = (scale: number, k: ReturnType<typeof slope> | null): Body[] =>
    bodies.map((b, i) => {
      const s = state[i] as (typeof state)[number];
      const d = k?.[i];
      return {
        mass: b.mass,
        x: s.x + (d ? scale * d.dx : 0),
        y: s.y + (d ? scale * d.dy : 0),
        vx: s.vx + (d ? scale * d.dvx : 0),
        vy: s.vy + (d ? scale * d.dvy : 0),
      };
    });
  function slope(at: readonly Body[]): { dx: number; dy: number; dvx: number; dvy: number }[] {
    const acc = accelerationsOf(at);
    return at.map((b, i) => ({ dx: b.vx, dy: b.vy, dvx: acc[i]?.x ?? 0, dvy: acc[i]?.y ?? 0 }));
  }
  const k1 = slope(bodies);
  const k2 = slope(at(h / 2, k1));
  const k3 = slope(at(h / 2, k2));
  const k4 = slope(at(h, k3));
  bodies.forEach((b, i) => {
    const s = state[i] as (typeof state)[number];
    const a = k1[i] as (typeof k1)[number];
    const c = k2[i] as (typeof k2)[number];
    const d = k3[i] as (typeof k3)[number];
    const e = k4[i] as (typeof k4)[number];
    b.x = s.x + (h / 6) * (a.dx + 2 * c.dx + 2 * d.dx + e.dx);
    b.y = s.y + (h / 6) * (a.dy + 2 * c.dy + 2 * d.dy + e.dy);
    b.vx = s.vx + (h / 6) * (a.dvx + 2 * c.dvx + 2 * d.dvx + e.dvx);
    b.vy = s.vy + (h / 6) * (a.dvy + 2 * c.dvy + 2 * d.dvy + e.dvy);
  });
}

/** An eccentric two-body orbit: a = 1, e = 0.5, started at apoapsis. Verlet's error is largest here. */
function eccentricPair(): Body[] {
  const m1 = 1;
  const m2 = 0.6;
  const total = m1 + m2;
  const e = 0.5;
  const r = 1 + e;
  const v = Math.sqrt((total * (1 - e)) / r);
  return [
    { mass: m1, x: (-m2 / total) * r, y: 0, vx: 0, vy: (-m2 / total) * v },
    { mass: m2, x: (m1 / total) * r, y: 0, vx: 0, vy: (m1 / total) * v },
  ];
}

describe('velocity Verlet against RK4', () => {
  /**
   * The reason the tab uses the less accurate method, measured.
   *
   * Twenty orbits of an eccentric pair at a deliberately coarse 1/120 step —
   * coarse so that both methods are visibly imperfect and the *shape* of the
   * imperfection is what separates them. Verlet's energy error is far larger
   * inside an orbit, because it peaks where the pair swings through periapsis,
   * and it comes back to nothing at the end of every single orbit. RK4's is
   * tiny and one-directional: it loses energy on every orbit and never gives
   * any back, so the ellipse it draws is slowly spiralling in. On a tab whose
   * headline is "energy is conserved" and whose picture is a closed loop, the
   * second one would be a lie that looks better.
   */
  it('oscillates without drifting, where RK4 drifts without oscillating', () => {
    const h = 1 / 120;
    const period = keplerPeriod(1, 1.6);
    const perOrbit = Math.round(period / h);
    const orbitsRun = 20;

    function run(stepper: (bodies: Body[], h: number) => void): { peak: number; ends: number[] } {
      const bodies = eccentricPair();
      const start = energy(bodies);
      const ends: number[] = [];
      let peak = 0;
      for (let i = 0; i < orbitsRun * perOrbit; i++) {
        stepper(bodies, h);
        const relative = (energy(bodies) - start) / Math.abs(start);
        peak = Math.max(peak, Math.abs(relative));
        if ((i + 1) % perOrbit === 0) ends.push(relative);
      }
      return { peak, ends };
    }

    const verlet = run((bodies, step) => {
      const sim = new NBody(bodies);
      sim.step(step);
      bodies.forEach((b, i) => Object.assign(b, sim.bodies[i]));
    });
    const rk4 = run(rk4Step);

    // RK4 really is the more accurate method per step, by three and a half
    // orders of magnitude. That is not the question being asked.
    expect(rk4.peak).toBeLessThan(1e-6);
    expect(verlet.peak).toBeGreaterThan(1e-5);

    // Verlet, read at the same point of every orbit, has given all of it back.
    for (const [i, end] of verlet.ends.entries()) {
      expect(Math.abs(end), `verlet orbit ${i + 1}`).toBeLessThan(1e-9);
    }

    // RK4, read at the same point of every orbit, is down — every time, by
    // more than the time before, and in proportion to how long it has run.
    for (const end of rk4.ends) expect(end).toBeLessThan(0);
    const fifth = rk4.ends[4] ?? 0;
    const twentieth = rk4.ends[19] ?? 0;
    expect(twentieth).toBeLessThan(fifth);
    expect(twentieth / fifth).toBeGreaterThan(3);
  });

  it('runs backwards to where it came from', () => {
    // Time reversibility is the structural property the energy behaviour above
    // comes out of: the map is its own inverse under v → −v.
    const h = 1 / 960;
    const forward = new NBody(eccentricPair());
    const start = cloneBodies(forward.bodies);
    for (let i = 0; i < 2_000; i++) forward.step(h);
    for (const b of forward.bodies) {
      b.vx = -b.vx;
      b.vy = -b.vy;
    }
    for (let i = 0; i < 2_000; i++) forward.step(h);
    for (const [i, b] of forward.bodies.entries()) {
      const was = start[i] as Body;
      expect(Math.hypot(b.x - was.x, b.y - was.y), `body ${i}`).toBeLessThan(1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

describe('the two-body scenario', () => {
  const two = scenarioById('two');

  it('starts at rest overall, on a circle about the common centre', () => {
    const bodies = two.bodies();
    const p = totalMomentum(bodies);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-15);
    const c = centreOfMass(bodies);
    expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-15);
    // Masses 1 and 0.6 at a separation of exactly a = 1, so both move: the
    // heavier one on a circle of 0.375 and the lighter on one of 0.625.
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.x).toBeCloseTo(-0.375, 12);
    expect(bodies[1]?.x).toBeCloseTo(0.625, 12);
    expect(Math.hypot((bodies[1]?.x ?? 0) - (bodies[0]?.x ?? 0), 0)).toBeCloseTo(1, 12);
    // L = μ·a·v_rel, with μ the reduced mass.
    const vrel = Math.sqrt(1.6);
    expect(angularMomentum(bodies)).toBeCloseTo((0.6 / 1.6) * 1 * vrel, 12);
    expect(two.kepler).toEqual({ a: 1, gm: 1.6 });
  });

  it('holds the separation at a for twelve orbits', () => {
    const run = survey(two);
    expect(run.minSeparation).toBeCloseTo(1, 4);
    // Nothing wanders: the two circles are 0.375 and 0.625 and stay there.
    expect(run.extentX).toBeCloseTo(0.625, 4);
    expect(run.extentY).toBeCloseTo(0.625, 4);
  });

  it('takes the period Kepler predicts, inside the band the readout declares', () => {
    const predicted = keplerPeriod(1, 1.6);
    expect(predicted).toBeCloseTo(4.967294133, 9);

    // The same zero-crossing detector the tab uses, run to the end of a run.
    const sim = new NBody(two.bodies());
    let previous = (sim.bodies[1]?.y ?? 0) - (sim.bodies[0]?.y ?? 0);
    const crossings: number[] = [];
    for (let i = 1; i <= Math.round(MAX_TIME / STEP); i++) {
      sim.step(STEP);
      const a = sim.bodies[0] as Body;
      const b = sim.bodies[1] as Body;
      const dy = b.y - a.y;
      if (previous < 0 && dy >= 0 && b.x - a.x > 0) {
        crossings.push((i - 1) * STEP + (previous / (previous - dy)) * STEP);
      }
      previous = dy;
    }
    expect(crossings).toHaveLength(12);
    const measured = (crossings[11] ?? 0) / 12;

    // The residual is the softening's own bias and nothing else: the guard
    // lengthens a circular orbit by COEFF·(ε/a)² of it, and the coefficient in
    // gravity.ts is what that measurement says.
    const shift = SOFTENED_PERIOD_COEFF * SOFTENING ** 2 * predicted;
    expect(measured - predicted).toBeCloseTo(shift, 7);
    expect((measured - predicted) / predicted).toBeLessThan(4e-6);
    // And the band the tab declares at twelve turns covers it with room over.
    expect(Math.abs(measured - predicted)).toBeLessThan(2 * shift + STEP / 12);
  });
});

describe('the figure-eight choreography', () => {
  const eight = scenarioById('figure-eight');

  it('starts with zero momentum, zero centre of mass and zero angular momentum', () => {
    const bodies = eight.bodies();
    const p = totalMomentum(bodies);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-15);
    const c = centreOfMass(bodies);
    expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-15);
    expect(angularMomentum(bodies)).toBe(0);
    expect(bodies.every((b) => b.mass === 1)).toBe(true);
  });

  it('carries the published energy of −1.287141987', () => {
    // Quoted for exact Newtonian gravity, so the softening is switched off to
    // read it: the published figures are truncated at eight digits, and this
    // lands 9·10⁻⁹ from the value they name.
    expect(energy(eight.bodies(), 0)).toBeCloseTo(EIGHT_ENERGY, 7);
    // With the guard in place it moves by a millionth of itself: one pair at
    // r = 2 and two at r = 1, each shallower by ε²/(2r³).
    expect(energy(eight.bodies()) - energy(eight.bodies(), 0)).toBeCloseTo(1.0625e-6, 9);
  });

  it('is back where it started after the published period of 6.32591398', () => {
    expect(FIGURE_EIGHT_PERIOD).toBe(6.32591398);
    const start = cloneBodies(eight.bodies());
    const sim = new NBody(eight.bodies());
    // An exact whole number of steps that sums to the period, so the
    // comparison is made at the period and not a step either side of it.
    const steps = Math.round(FIGURE_EIGHT_PERIOD / STEP);
    const h = FIGURE_EIGHT_PERIOD / steps;
    for (let i = 0; i < steps; i++) sim.step(h);
    // Every body, not just one: a choreography that has slipped a third of a
    // period along its own path would put *a* body at each starting point.
    for (const [i, b] of sim.bodies.entries()) {
      const was = start[i] as Body;
      expect(Math.hypot(b.x - was.x, b.y - was.y), `body ${i}`).toBeLessThan(1e-4);
      expect(Math.hypot(b.vx - was.vx, b.vy - was.vy), `body ${i}`).toBeLessThan(1e-4);
    }
    // Half way round it is somewhere else entirely, so the test above is not
    // passing because nothing moved.
    const halfway = new NBody(eight.bodies());
    for (let i = 0; i < Math.round(steps / 2); i++) halfway.step(h);
    expect(furthestApart(halfway.bodies, start)).toBeGreaterThan(0.5);
  });

  it('keeps all three on one path, a third of a period apart', () => {
    const sim = new NBody(eight.bodies());
    const start = cloneBodies(sim.bodies);
    const steps = Math.round(FIGURE_EIGHT_PERIOD / (3 * STEP));
    const h = FIGURE_EIGHT_PERIOD / (3 * Math.round(FIGURE_EIGHT_PERIOD / (3 * STEP)));
    for (let i = 0; i < steps; i++) sim.step(h);
    // A third of a period on, each body sits where another one started. That
    // is what makes it a choreography rather than three separate orbits.
    for (const b of sim.bodies) {
      const nearest = Math.min(...start.map((s) => Math.hypot(b.x - s.x, b.y - s.y)));
      expect(nearest).toBeLessThan(1e-3);
    }
  });
});

describe('the three-body scenario', () => {
  const three = scenarioById('three');

  it('starts at rest overall, with its centre of mass at the origin', () => {
    const bodies = three.bodies();
    const p = totalMomentum(bodies);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(1e-15);
    const c = centreOfMass(bodies);
    expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-15);
    expect(bodies.every((b) => b.mass === 1)).toBe(true);
    // Unlike the eight, it has angular momentum — which is what stops the
    // triple collapsing onto a point however chaotic it gets.
    expect(Math.abs(angularMomentum(bodies))).toBeGreaterThan(1);
  });

  it('stays on the plate and clear of a deep encounter for the whole run', () => {
    const run = survey(three);
    // Nothing is ejected: the extent is what `Scenario.view` was sized from.
    expect(run.extentX).toBeLessThan(three.view.x);
    expect(run.extentY).toBeLessThan(three.view.y);
    expect(run.extentX).toBeCloseTo(2.9973, 3);
    expect(run.extentY).toBeCloseTo(2.5895, 3);
    // And it never gets close enough to blow the step up.
    expect(run.minSeparation).toBeGreaterThan(0.17);
  });

  it('never repeats, which is the whole reason it is offered', () => {
    const start = cloneBodies(three.bodies());
    const sim = new NBody(three.bodies());
    let closest = Infinity;
    // Sampled every tenth of a time unit over the run: if there were a period
    // anywhere in it, one of these six hundred configurations would be near
    // the one it started from.
    for (let i = 0; i < Math.round(MAX_TIME / STEP); i++) {
      sim.step(STEP);
      if (i % Math.round(0.1 / STEP) === 0 && i * STEP > 1) {
        closest = Math.min(closest, furthestApart(sim.bodies, start));
      }
    }
    expect(closest).toBeGreaterThan(0.3);
  });
});

describe('every scenario', () => {
  it('conserves energy inside the envelope it declares, for a full run', () => {
    // The headline claim of the tab, for all three arrangements at once.
    for (const scenario of SCENARIOS) {
      const run = survey(scenario);
      expect(run.drift, scenario.id).toBeLessThan(scenario.energyEnvelope);
      // The envelope is the measurement plus an order of magnitude, not a
      // number picked to be comfortable: a scenario whose drift is a thousand
      // times inside it has an envelope nobody re-measured.
      expect(run.drift, `${scenario.id}: envelope too generous`).toBeGreaterThan(
        scenario.energyEnvelope / 100,
      );
    }
  });

  it('keeps total momentum and the centre of mass at zero through a full run', () => {
    for (const scenario of SCENARIOS) {
      const run = survey(scenario);
      const p = totalMomentum(run.bodies);
      expect(Math.hypot(p.x, p.y), scenario.id).toBeLessThan(1e-10);
      const c = centreOfMass(run.bodies);
      expect(Math.hypot(c.x, c.y), scenario.id).toBeLessThan(1e-8);
    }
  });

  it('declares a view box the run fits inside', () => {
    for (const scenario of SCENARIOS) {
      const run = survey(scenario);
      expect(run.extentX, scenario.id).toBeLessThanOrEqual(scenario.view.x);
      expect(run.extentY, scenario.id).toBeLessThanOrEqual(scenario.view.y);
      // Not three times too big either, or the picture is a dot in a field.
      expect(scenario.view.x, `${scenario.id}: view too loose`).toBeLessThan(2 * run.extentX);
    }
  });

  it('hands out fresh initial conditions every time, because the integrator eats them', () => {
    for (const scenario of SCENARIOS) {
      const first = scenario.bodies();
      const sim = new NBody(first);
      for (let i = 0; i < 1_000; i++) sim.step(STEP);
      // The array the scenario handed out is untouched by the integrator — the
      // constructor copies — and a second call gives the same numbers again.
      expect(scenario.bodies(), scenario.id).toEqual(first);
    }
  });

  it('is reproducible to the last bit from the same initial conditions', () => {
    for (const scenario of SCENARIOS) {
      const a = new NBody(scenario.bodies());
      const b = new NBody(scenario.bodies());
      for (let i = 0; i < 20_000; i++) {
        a.step(STEP);
        b.step(STEP);
      }
      expect(a.bodies, scenario.id).toEqual(b.bodies);
    }
  });
});

describe('a whisker apart', () => {
  /** How far two runs of `scenario` are apart after `time`, started `offset` apart. */
  function peel(scenario: Scenario, offset: number, time: number): number {
    const a = new NBody(scenario.bodies());
    const nudged = scenario.bodies();
    const first = nudged[0];
    if (first) first.x += offset;
    const b = new NBody(nudged);
    for (let i = 0; i < Math.round(time / STEP); i++) {
      a.step(STEP);
      b.step(STEP);
    }
    return furthestApart(a.bodies, b.bodies);
  }

  it('leaves two bodies where they were and throws three bodies apart', () => {
    const offset = 1e-3;
    // Two bodies: a different start is a slightly different ellipse, and it
    // stays a slightly different ellipse, drifting along the same loop. After a
    // whole run the gap is a tenth of the picture it is drawn in.
    const two = scenarioById('two');
    const apartTwo = peel(two, offset, MAX_TIME);
    expect(apartTwo).toBeLessThan(0.2 * 2 * two.view.x);

    // Three bodies: the same whisker, and by the end the two runs are further
    // apart than the picture is wide.
    const three = scenarioById('three');
    const apartThree = peel(three, offset, MAX_TIME);
    expect(apartThree).toBeGreaterThan(2 * three.view.x);
    expect(apartThree / apartTwo).toBeGreaterThan(30);
  });

  it('grows the gap steadily on two bodies and exponentially on three', () => {
    const offset = 1e-3;
    // The same comparison as a shape rather than a size, which is the part that
    // does not depend on how long anybody watches. Doubling the time doubles
    // the two-body gap — it is a phase drift along a loop that is still closed.
    // On three bodies it multiplies it by twenty-odd, and that factor is what
    // "no matter how precisely you measure where they started" means: every
    // extra digit of precision buys the same fixed amount of extra time.
    const growth = (id: string): number =>
      peel(scenarioById(id), offset, 30) / peel(scenarioById(id), offset, 15);
    expect(growth('two')).toBeGreaterThan(1.8);
    expect(growth('two')).toBeLessThan(3);
    expect(growth('figure-eight')).toBeLessThan(3);
    expect(growth('three')).toBeGreaterThan(8);
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
  segments: readonly Seg[];
}

interface Disc {
  pen: string;
  x: number;
  y: number;
  r: number;
}

/**
 * A canvas context that records the strokes and the arcs it is asked for and
 * accepts everything else. The trails and the bodies are what is under test;
 * the readout window paints through fillRect / strokeRect / fillText, which
 * record nothing.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  discs: Disc[];
  texts: string[];
} {
  const strokes: Stroke[] = [];
  const discs: Disc[] = [];
  const texts: string[] = [];
  let segments: Seg[] = [];
  let arcs: Disc[] = [];
  let x = 0;
  let y = 0;
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (t: string) => ({ width: 6 * String(t).length }),
    fillText(t: string): void {
      texts.push(t);
    },
    beginPath(): void {
      segments = [];
      arcs = [];
    },
    moveTo(px: number, py: number): void {
      x = px;
      y = py;
    },
    lineTo(px: number, py: number): void {
      segments.push([x, y, px, py]);
      x = px;
      y = py;
    },
    arc(cx: number, cy: number, r: number): void {
      arcs.push({ pen: '', x: cx, y: cy, r });
    },
    stroke(): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        segments: [...segments],
      });
      for (const a of arcs) discs.push({ ...a, pen: String(api.strokeStyle) });
    },
    fill(): void {
      for (const a of arcs) discs.push({ ...a, pen: String(api.fillStyle) });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, discs, texts };
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

const DEFAULTS: Record<string, ParamValue> = { scenario: 'two', twin: 0.02, seed: 42 };

function stubViz(overrides: Record<string, ParamValue> = {}, width = 705, height = 440) {
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
  const instance = orbits.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, ticks: number): void {
  for (let i = 0; i < ticks; i++) v.instance.step(TICK);
}

/** One frame, with the paint log cleared first so it holds exactly that frame. */
function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.fg.discs.length = 0;
  v.fg.texts.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.strokes.length = 0;
    v.bg.discs.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Exactly what src/main.ts does on a resize. */
function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.bg.discs.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function readout(v: Viz, key: string): Readout {
  const found = (v.emitted.at(-1) ?? []).find((r) => r.key === key);
  expect(found, key).toBeDefined();
  return found as Readout;
}

describe('orbits instance: readouts', () => {
  it('publishes an energy drift that agrees with a prediction of exactly zero', () => {
    for (const scenario of SCENARIOS) {
      const v = stubViz({ scenario: scenario.id });
      tick(v, 1_200);
      paint(v);
      const drift = readout(v, 'drift');
      expect(drift.headline, scenario.id).toBe(true);
      expect(drift.target, scenario.id).toBe(0);
      expect(Math.abs(drift.value), scenario.id).toBeLessThan(scenario.energyEnvelope);
      expect(testable(drift), scenario.id).toBe(true);
      expect(agrees(drift), scenario.id).toBe(true);
      expect(verdictOf(drift).text, scenario.id).toBe('matches the prediction of 0');
    }
  });

  it('still agrees at the end of a full run, which is the claim that matters', () => {
    // A tab can conserve energy for a second and lose it over a minute; that is
    // exactly what a non-symplectic method does. The band is fixed, so this is
    // a real test at t = 60 and not a formality.
    for (const scenario of SCENARIOS) {
      const v = stubViz({ scenario: scenario.id });
      tick(v, FULL_RUN_TICKS);
      paint(v);
      expect(ledger(v)['time'], scenario.id).toBeCloseTo(MAX_TIME, 2);
      expect(agrees(readout(v, 'drift')), scenario.id).toBe(true);
    }
  });

  it('declares a band the ledger will accept, against a range that gives zero a scale', () => {
    const v = stubViz();
    paint(v);
    const drift = readout(v, 'drift');
    expect(drift.range).toEqual([-1, 1]);
    const half = bandOf(drift);
    expect(half).not.toBeNull();
    // A prediction of exactly zero has no scale of its own, so readouts.ts
    // judges the band against the declared range instead — and refuses it
    // outright if the reading declares none.
    expect(half ?? 0).toBeLessThanOrEqual(MAX_BAND_FRACTION * 2);
    expect(
      bandOf({
        key: drift.key,
        label: drift.label,
        value: drift.value,
        target: 0,
        band: { kind: 'absolute', half: half ?? 0 },
      }),
    ).toBeNull();
  });

  it('measures the orbital period against Kepler, and only where there is one', () => {
    const v = stubViz({ scenario: 'two' });
    paint(v);
    // Before the first return there is no measurement, and the hero says so
    // rather than printing a number nothing has been measured.
    expect(Number.isNaN(ledger(v)['period'] ?? 0)).toBe(true);
    expect(verdictOf(readout(v, 'period')).text).toBe('not measured yet');

    tick(v, FULL_RUN_TICKS);
    paint(v);
    const period = readout(v, 'period');
    expect(ledger(v)['turns']).toBe(12);
    expect(period.target).toBeCloseTo(keplerPeriod(1, 1.6), 9);
    expect(period.value).toBeCloseTo(4.96730904, 7);
    expect(agrees(period)).toBe(true);
    // The band shrinks with the turns it averages over, down to the floor the
    // softening puts under it.
    const shift = SOFTENED_PERIOD_COEFF * SOFTENING ** 2 * keplerPeriod(1, 1.6);
    expect(bandOf(period)).toBeCloseTo(2 * shift + STEP / 12, 12);

    // The two arrangements with no period do not publish one.
    for (const id of ['figure-eight', 'three']) {
      const other = stubViz({ scenario: id });
      tick(other, 600);
      paint(other);
      expect(Object.keys(ledger(other)), id).not.toContain('period');
      expect(Object.keys(ledger(other)), id).not.toContain('turns');
    }
  });

  it('publishes the twin separation in the unit the knob is set in', () => {
    const v = stubViz({ scenario: 'three', twin: 0.02 });
    paint(v);
    const width = 2 * scenarioById('three').view.x;
    // It starts at the offset the rail asked for, read in the same per cent.
    expect(ledger(v)['separation']).toBeCloseTo(0.02, 6);
    expect(readout(v, 'separation').unit).toBe('%');

    tick(v, FULL_RUN_TICKS);
    paint(v);
    const grown = ledger(v)['separation'] ?? 0;
    // Three orders of magnitude, and past the whole width of the picture.
    expect(grown).toBeGreaterThan(100);
    expect((grown / 100) * width).toBeGreaterThan(width);
  });

  it('reports no separation at all when there is only one run', () => {
    const v = stubViz({ twin: 0 });
    tick(v, 600);
    paint(v);
    expect(Number.isNaN(ledger(v)['separation'] ?? 0)).toBe(true);
    // A reading that does not exist is an em dash, not a zero that would read
    // as "the two runs agree".
    expect(verdictOf(readout(v, 'separation')).text).toBe('not measured yet');
  });

  it('leaves the twin alone on two bodies and throws it off on three', () => {
    const settled: Record<string, number> = {};
    for (const id of ['two', 'three']) {
      const v = stubViz({ scenario: id, twin: 0.02 });
      tick(v, FULL_RUN_TICKS);
      paint(v);
      settled[id] = ledger(v)['separation'] ?? 0;
    }
    // The comparison the tab exists to make, in one pair of numbers: the same
    // whisker, on the same clock, with the same arithmetic. Two bodies end a
    // few per cent of the picture apart; three end further apart than the
    // picture is wide.
    expect(settled['two'] ?? 0).toBeLessThan(5);
    expect(settled['three'] ?? 0).toBeGreaterThan(100);
    expect(settled['three'] ?? 0).toBeGreaterThan(20 * (settled['two'] ?? 1));
  });

  it('stops the run at its ceiling instead of drifting on for ever', () => {
    const v = stubViz();
    tick(v, FULL_RUN_TICKS + 2_000);
    paint(v);
    expect(ledger(v)['time']).toBeCloseTo(MAX_TIME, 2);
    expect(ledger(v)['turns']).toBe(12);
  });

  it('publishes every number it draws on the plate', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    // The canvas is aria-hidden, so the in-canvas window is the sighted
    // reader's copy of a number the ledger has to carry as well.
    const window = v.fg.texts.find((t) => t.startsWith('ΔE/E'));
    expect(window).toBeDefined();
    expect(window).toBe(`ΔE/E ${formatDrift(ledger(v)['drift'] ?? Number.NaN)}`);
  });

  it('reproduces a run exactly from the same seed, and moves the twin with a new one', () => {
    const a = stubViz({ scenario: 'three' });
    const b = stubViz({ scenario: 'three' });
    tick(a, 2_400);
    tick(b, 2_400);
    paint(a);
    paint(b);
    expect(ledger(a)).toEqual(ledger(b));

    // The seed picks the direction the twin is nudged in and nothing else, so
    // the first run is identical and only the second one moves.
    const other = stubViz({ scenario: 'three', seed: 7 });
    tick(other, 2_400);
    paint(other);
    expect(ledger(other)['drift']).toBe(ledger(a)['drift']);
    expect(ledger(other)['separation']).not.toBe(ledger(a)['separation']);
  });
});

describe('orbits instance: the contract', () => {
  it('never mutates the simulation from draw()', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    const once = ledger(v);
    paint(v);
    paint(v);
    expect(ledger(v)).toEqual(once);
  });

  it('never paints from step()', () => {
    const v = stubViz();
    paint(v);
    v.fg.strokes.length = 0;
    v.fg.discs.length = 0;
    v.bg.strokes.length = 0;
    tick(v, 600);
    expect(v.fg.strokes).toEqual([]);
    expect(v.fg.discs).toEqual([]);
    expect(v.bg.strokes).toEqual([]);
  });

  it('repaints the background only when the geometry it drew for has changed', () => {
    const v = stubViz();
    v.bg.strokes.length = 0;
    // A repaint at the same size is what the label face's arrival looks like,
    // and it must cost nothing rather than throw a finished diagram away.
    v.instance.drawBackground?.();
    expect(v.bg.strokes).toEqual([]);
    resize(v, 705, 441);
    expect(v.bg.strokes.length).toBeGreaterThan(0);
  });

  it('repaints the background when the scheme changes, not only when it moves', () => {
    // The pens are part of what the layer was painted with, and this is the one
    // layer nothing else repaints. Caching on size and scenario alone meant the
    // shell's scheme repaint was skipped and the axes and centre of mass stayed
    // in the previous scheme's ink on the new bed — the owner's report, arriving
    // on this tab through a guard rather than through a token.
    const v = stubViz();
    v.bg.strokes.length = 0;
    v.instance.drawBackground?.();
    expect(v.bg.strokes).toEqual([]);

    // Exactly what src/main.ts does on a scheme change: swap the pens in place,
    // then ask for the repaint.
    v.ctx.theme = { ...THEME, gridSoft: '#6e797f' };
    v.instance.drawBackground?.();

    expect(v.bg.strokes.length).toBeGreaterThan(0);
    expect(v.bg.strokes.every((s) => s.pen === '#6e797f')).toBe(true);

    // And still free when nothing at all has changed.
    v.bg.strokes.length = 0;
    v.instance.drawBackground?.();
    expect(v.bg.strokes).toEqual([]);
  });

  it('restarts on either knob, because both are a different experiment', () => {
    const v = stubViz();
    tick(v, 1_200);
    paint(v);
    expect(ledger(v)['time']).toBeGreaterThan(0);

    expect(setParam(v, 'twin', 0.1)).toBe(false);
    expect(ledger(v)['time']).toBe(0);

    tick(v, 1_200);
    paint(v);
    expect(setParam(v, 'scenario', 'figure-eight')).toBe(false);
    expect(ledger(v)['time']).toBe(0);
    expect(Object.keys(ledger(v))).not.toContain('period');
  });

  it('survives a scenario it has never heard of', () => {
    // A stale permalink names a scenario that was renamed or removed. The tab
    // opens on the first one rather than on a blank plate.
    const v = stubViz({ scenario: 'lorenz' });
    tick(v, 600);
    paint(v);
    expect(ledger(v)['turns']).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ledger(v)['drift'] ?? Number.NaN)).toBe(true);
  });
});

describe('orbits instance: painting', () => {
  it('draws each body as a filled disc, sized by mass and floored', () => {
    const v = stubViz({ scenario: 'two', twin: 0 });
    paint(v);
    const first = v.fg.discs.filter((d) => d.pen === THEME.data1);
    expect(first).toHaveLength(2);
    // Radius goes as the cube root of the mass: 0.6 of the mass is 84 % of the
    // width, not 60 % and not the same.
    const [heavy, light] = first;
    expect((light?.r ?? 0) / (heavy?.r ?? 1)).toBeCloseTo(Math.cbrt(0.6), 6);
    expect(bodyRadius(1, THEME.particleRadius)).toBe(6);
    // …and a body light enough to vanish is floored instead.
    expect(bodyRadius(1e-6, THEME.particleRadius)).toBe(3);
    expect(bodyRadius(1e-6, 12)).toBe(12);
  });

  it('draws the twin in the second pen, under the first run', () => {
    const v = stubViz({ scenario: 'three', twin: 0.1 });
    tick(v, 1_200);
    paint(v);
    expect(v.fg.discs.filter((d) => d.pen === THEME.data2)).toHaveLength(3);
    expect(v.fg.discs.filter((d) => d.pen === THEME.data1)).toHaveLength(3);
    // The twin goes down first, so where the runs still agree the reader sees
    // the one the readouts are about.
    const firstTwin = v.fg.discs.findIndex((d) => d.pen === THEME.data2);
    const firstPrimary = v.fg.discs.findIndex((d) => d.pen === THEME.data1);
    expect(firstTwin).toBeLessThan(firstPrimary);

    // With no twin there is no second pen on the plate at all.
    const alone = stubViz({ scenario: 'three', twin: 0 });
    tick(alone, 1_200);
    paint(alone);
    expect(alone.fg.discs.filter((d) => d.pen === THEME.data2)).toEqual([]);
    expect(alone.fg.strokes.filter((s) => s.pen === THEME.data2)).toEqual([]);
  });

  it('paints the centre of mass and its axes on the background, in the container pen', () => {
    const v = stubViz();
    // Static geometry belongs on the layer that repaints on resize, not on the
    // one that repaints sixty times a second — and with zero total momentum
    // the centre of mass is the one thing in the picture that never moves.
    expect(v.bg.strokes.every((s) => s.pen === THEME.gridSoft)).toBe(true);
    expect(v.bg.discs.every((d) => d.pen === THEME.gridSoft)).toBe(true);
    expect(v.bg.discs).toHaveLength(1);
    // Centred, and snapped to a half-pixel so the odd-width hairline covers
    // whole device pixels instead of smearing across two.
    expect(v.bg.discs[0]?.x).toBe(Math.round(705 / 2) + 0.5);
    expect(v.bg.discs[0]?.y).toBe(Math.round(440 / 2) + 0.5);
    expect(v.fg.discs.every((d) => d.pen !== THEME.gridSoft)).toBe(true);
  });

  it('bounds the painted trail however long the run has been going', () => {
    const v = stubViz({ scenario: 'two', twin: 0 });
    tick(v, 1_800);
    paint(v);
    const short = v.fg.strokes.reduce((n, s) => n + s.segments.length, 0);
    expect(short).toBeGreaterThan(100);

    tick(v, FULL_RUN_TICKS);
    paint(v);
    const long = v.fg.strokes.reduce((n, s) => n + s.segments.length, 0);
    // Ten times the run, the same ink. Buffon learned this at 20,000 needles.
    expect(long).toBe(short);
  });

  it('fades the trail from faint to full, with no gap where the bands meet', () => {
    const v = stubViz({ scenario: 'two', twin: 0 });
    tick(v, 1_800);
    paint(v);
    const trail = v.fg.strokes.filter((s) => s.pen === THEME.data1 && s.segments.length > 0);
    expect(trail.length).toBeGreaterThan(1);
    const alphas = [...new Set(trail.map((s) => s.alpha))].sort((a, b) => a - b);
    expect(alphas.length).toBeGreaterThan(4);
    expect(alphas[0]).toBeGreaterThan(0.1);
    // The newest band is at full strength, so at least one mark per body
    // carries the vermilion pen's own 4.80:1 against the plate.
    expect(alphas.at(-1)).toBe(1);

    // Bands share an endpoint, so the polyline has no holes in it: a hole in a
    // trail reads as the body having jumped.
    for (const body of [0, 1]) {
      const bands = trail.filter((_, i) => Math.floor(i / (trail.length / 2)) === body);
      for (let i = 1; i < bands.length; i++) {
        const previous = bands[i - 1]?.segments.at(-1);
        const next = bands[i]?.segments[0];
        if (!previous || !next) continue;
        expect(Math.hypot(next[0] - previous[2], next[1] - previous[3])).toBeLessThan(1e-6);
      }
    }
  });

  it('re-lays-out the trail already drawn when the plate changes size', () => {
    const v = stubViz({ scenario: 'two', twin: 0 }, 705, 440);
    tick(v, 1_800);
    paint(v);
    const before = v.fg.strokes.flatMap((s) => s.segments).length;
    const view = viewFor(705, 440, scenarioById('two'));

    resize(v, 352, 220);
    const after = v.fg.strokes.flatMap((s) => s.segments).length;
    const half = viewFor(352, 220, scenarioById('two'));
    // The samples are stored in world units, so the same trail is re-drawn at
    // the new scale rather than stranded at coordinates the plate no longer has.
    expect(after).toBe(before);
    expect(half.scale).toBeCloseTo(view.scale / 2, 9);

    // The orbit is centred on the plate and fills it: the scale is whichever of
    // the two axes binds.
    expect(view.cx).toBe(705 / 2);
    expect(view.cy).toBe(440 / 2);
    expect(view.scale).toBeCloseTo(440 / (2 * 0.75), 9);
    // The wide figure eight is bound by the width instead.
    expect(viewFor(705, 440, scenarioById('figure-eight')).scale).toBeCloseTo(705 / (2 * 1.2), 9);
  });

  it('prints the drift as an exponent, because a fixed point would be a row of zeros', () => {
    expect(formatDrift(0)).toBe('= 0');
    expect(formatDrift(3.92e-7)).toBe('≈ 3.9e-7');
    expect(formatDrift(-1.6e-9)).toBe('≈ -1.6e-9');
    expect(formatDrift(Number.NaN)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('orbits metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(orbits.params.map((p) => p.key)).toEqual(['scenario', 'twin', 'seed']);
    const seed = orbits.params.find((p) => p.key === 'seed');
    expect(seed?.kind).toBe('seed');
    // Exactly two controls a reader can turn, and the second is the moment.
    expect(orbits.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    const scenario = orbits.params.find((p) => p.key === 'scenario');
    expect(scenario?.kind).toBe('choice');
    expect(scenario?.kind === 'choice' ? scenario.options.map((o) => o.value) : []).toEqual(
      SCENARIOS.map((s) => s.id),
    );
  });

  it('keeps the identifiers a permalink was written with', () => {
    expect(orbits.id).toBe('orbits');
    expect(orbits.group).toBe('chaos');
    expect(orbits.title).toBe('Two Bodies, Three Bodies');
    expect(SCENARIOS.map((s) => s.id)).toEqual(['two', 'figure-eight', 'three']);
  });

  it('is the last tab in the registry, and the only one outside randomness', () => {
    expect(registry.at(-1)).toBe(orbits);
    expect(registry.filter((v) => v.group === 'chaos')).toEqual([orbits]);
    expect(registry.map((v) => v.id)).toEqual([
      'galton',
      'buffon',
      'montecarlo-pi',
      'arcsine',
      'dla',
      'orbits',
    ]);
  });

  it('walks the presets to the insight, and sets only parameters it declares', () => {
    const presets = orbits.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['two-bodies', 'figure-eight', 'a-whisker-apart']);
    // `ui/story.ts` renders the first MAX_CHIPS and no more, so a fourth preset
    // is one nobody can reach — and it would be the last one here, which is the
    // one the tab is for.
    expect(presets.length).toBeLessThanOrEqual(MAX_CHIPS);
    for (const preset of presets) {
      expect(flatten(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const key of Object.keys(preset.values)) {
        expect(orbits.params.some((p) => p.key === key), `${preset.id} sets ${key}`).toBe(true);
      }
      // Every chip keeps the twin, because the comparison is the argument.
      expect(preset.values['twin'], preset.id).toBe(0.02);
    }
    expect(presets.at(-1)?.values).toEqual({ scenario: 'three', twin: 0.02 });
  });

  it('states two facts, one sentence each, and sources both', () => {
    expect(orbits.facts.length).toBeGreaterThan(0);
    expect(orbits.facts.length).toBeLessThanOrEqual(2);
    for (const fact of orbits.facts) {
      expect(flatten(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(10);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('spends its blurb on the picture and the surprise', () => {
    const blurb = flatten(orbits.blurb);
    expect(blurb).toMatch(/two bodies/i);
    expect(blurb).toMatch(/third/i);
    expect(blurb).toMatch(/eclipse/i);
    expect(blurb).toMatch(/unpredictable/i);
    expect(blurb).not.toMatch(JARGON);
  });

  it('never prints a word a newcomer would have to ask about', () => {
    for (const preset of orbits.presets ?? []) {
      expect(flatten(preset.caption), preset.id).not.toMatch(JARGON);
    }
    for (const fact of orbits.facts) expect(flatten(fact.text)).not.toMatch(JARGON);
    for (const p of orbits.params) expect(flatten(p.help), p.key).not.toMatch(JARGON);

    const v = stubViz();
    tick(v, 600);
    paint(v);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(JARGON);
      expect(r.hint ?? '', r.key).not.toMatch(JARGON);
    }
  });

  it('is a landscape plate, and square where a landscape one would be a letterbox', () => {
    expect(orbits.aspect).toBe(1.6);
    expect(orbits.aspectNarrow).toBe(1);
    expect(orbits.budget).toEqual({ maxEntities: 6 });
  });
});
