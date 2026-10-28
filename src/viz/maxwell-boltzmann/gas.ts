import type { Rng } from '../../core/types';
import { Welford, normalCdf } from '../../core/stats';

/**
 * The Maxwell–Boltzmann law: the mathematics of the tab, canvas-free and
 * exercised by tests/maxwell-boltzmann.test.ts.
 *
 * Maxwell's 1860 argument, which is also how a bead's speed is drawn here: the
 * three components of a molecule's velocity are independent, and each is a
 * normal curve with mean zero and standard deviation
 *
 *   a = √(kT/m),
 *
 * the Galton board's bell, once per direction of space. The speed is the length
 * of the arrow the three make, so v/a is a chi variable with three degrees of
 * freedom and
 *
 *   f(v) = √(2/π) · v²/a³ · e^(−v²/2a²).
 *
 * Every speed in the file is a multiple of `a`, which is the only place the
 * temperature and the mass enter: a heavier molecule and a colder gas are the
 * same change. The moments are therefore constants times `a`:
 *
 *   most probable √2·a   mean √(8/π)·a   root-mean-square √3·a
 *
 * and the speed of sound in the same ideal gas is √γ·a, which is why the share
 * of molecules that outrun it depends on γ alone and not on the temperature.
 */

/** Boltzmann's constant, J/K. Exact since the 2019 redefinition of the SI. */
export const BOLTZMANN = 1.380649e-23;

/** The dalton (unified atomic mass unit), kg. CODATA 2018. */
export const DALTON = 1.6605390666e-27;

/**
 * One gas the tab offers. `mass` is the molecular mass in daltons; `gamma` is
 * the heat-capacity ratio of the ideal gas, 7/5 for a rigid diatomic molecule
 * and 5/3 for a single atom.
 *
 * The three are chosen for the machine's fixed speed scale rather than for
 * variety alone. Every one of them, at every temperature the fader offers,
 * puts all but a few beads in ten thousand under the 2,000 m/s the slots
 * cover, which helium and hydrogen at room temperature would not — a third of
 * their beads would pile against the far wall. And all three are gases at
 * 200 K, the bottom of the fader: xenon, the heaviest, boils at 165 K.
 */
export interface Gas {
  id: string;
  label: string;
  mass: number;
  gamma: number;
}

export const GASES: readonly Gas[] = [
  { id: 'nitrogen', label: 'Nitrogen', mass: 28.0134, gamma: 7 / 5 },
  { id: 'argon', label: 'Argon', mass: 39.948, gamma: 5 / 3 },
  { id: 'xenon', label: 'Xenon', mass: 131.293, gamma: 5 / 3 },
];

/** The gas with this id, or nitrogen for an id nobody declared (a hand-edited permalink). */
export function gasById(id: unknown): Gas {
  return GASES.find((g) => g.id === id) ?? (GASES[0] as Gas);
}

/** a = √(kT/m), m/s: the standard deviation of one velocity component. */
export function thermalScale(temperature: number, mass: number): number {
  return Math.sqrt((BOLTZMANN * temperature) / (mass * DALTON));
}

/** The moments, as multiples of `a`. */
export const MODE_FACTOR = Math.SQRT2;
export const MEAN_FACTOR = Math.sqrt(8 / Math.PI);
export const RMS_FACTOR = Math.sqrt(3);

/**
 * Standard deviation of one speed, as a multiple of `a`: E[v²] − E[v]² is
 * (3 − 8/π)·a². This is what the mean's band divides by √n.
 */
export const SPEED_SD_FACTOR = Math.sqrt(3 - 8 / Math.PI);

/**
 * Standard deviation of the root-mean-square estimate from one speed, as a
 * multiple of `a`. The square of one speed has variance E[v⁴] − E[v²]² =
 * 15a⁴ − 9a⁴ = 6a⁴, and the square root of the mean of n of them moves by
 * that over 2·√3·a — √6/(2√3) = 1/√2 — per √n.
 */
export const RMS_SD_FACTOR = Math.SQRT1_2;

const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);

/** Density of the speed at `v`, per m/s. Zero below zero. */
export function speedPdf(v: number, a: number): number {
  if (!(v > 0)) return 0;
  const z = v / a;
  return (SQRT_2_OVER_PI * z * z * Math.exp(-0.5 * z * z)) / a;
}

/**
 * P(V > v): the share of molecules faster than `v`.
 *
 * Written as the tail rather than as one minus the distribution function, so
 * the far tail keeps its digits: with z = v/a it is 2·Φ(−z) + 2·z·φ(z), both
 * terms small and positive where it is small. One at and below zero.
 */
export function speedTail(v: number, a: number): number {
  if (!(v > 0)) return 1;
  const z = v / a;
  return 2 * normalCdf(-z, 0, 1) + SQRT_2_OVER_PI * z * Math.exp(-0.5 * z * z);
}

/** P(V ≤ v). */
export function speedCdf(v: number, a: number): number {
  return 1 - speedTail(v, a);
}

/** P(lo ≤ V < hi), with `hi = Infinity` for an open-ended band. */
export function bandShare(lo: number, hi: number, a: number): number {
  return speedTail(lo, a) - (hi === Infinity ? 0 : speedTail(hi, a));
}

/**
 * The share of molecules faster than the speed of sound in their own gas.
 *
 * Sound in an ideal gas travels at √(γkT/m) = √γ·a, so in units of `a` the
 * threshold is √γ whatever the temperature or the mass:
 * erfc(√(γ/2)) + √(2γ/π)·e^(−γ/2). 0.7055 for a diatomic gas, 0.6444 for a
 * monatomic one.
 */
export function fasterThanSound(gamma: number): number {
  return speedTail(Math.sqrt(gamma), 1);
}

/**
 * One molecule's speed: the length of a velocity whose three components are
 * independent normals of standard deviation `a`. Three normals from the shared
 * stream, always, so the number of draws per bead is fixed by the seed alone.
 */
export function sampleSpeed(rng: Rng, a: number): number {
  const x = rng.normal();
  const y = rng.normal();
  const z = rng.normal();
  return a * Math.sqrt(x * x + y * y + z * z);
}

/**
 * The speeds measured so far: their mean, their root-mean-square, and how
 * many cleared a threshold. Welford for both moments, so a mean of five
 * thousand speeds of a few hundred m/s keeps every digit it is shown with.
 */
export class SpeedTally {
  readonly #speed = new Welford();
  readonly #square = new Welford();
  #above = 0;
  #threshold: number;

  constructor(threshold = Infinity) {
    this.#threshold = threshold;
  }

  push(v: number): void {
    this.#speed.push(v);
    this.#square.push(v * v);
    if (v > this.#threshold) this.#above++;
  }

  get n(): number {
    return this.#speed.n;
  }

  /** Mean speed, m/s. NaN before the first push. */
  get mean(): number {
    return this.#speed.mean;
  }

  /** Root-mean-square speed, m/s. NaN before the first push. */
  get rms(): number {
    return Math.sqrt(this.#square.mean);
  }

  /** Share of the speeds above the threshold. NaN before the first push. */
  get shareAbove(): number {
    const n = this.#speed.n;
    return n > 0 ? this.#above / n : Number.NaN;
  }

  /** Forget every speed, and count against `threshold` from now on. */
  reset(threshold: number = this.#threshold): void {
    this.#speed.reset();
    this.#square.reset();
    this.#above = 0;
    this.#threshold = threshold;
  }
}
