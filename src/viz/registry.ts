import type { Viz } from '../core/types';
import { galton } from './galton';
import { buffon } from './buffon';
import { montecarloPi } from './montecarlo-pi';
import { dla } from './dla';
import { chaosGame } from './chaos-game';
import { bifurcation } from './bifurcation';
import { lorenz } from './lorenz';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical, and the shell builds its group runs from *consecutive*
 * entries, so the two facts are one fact: the order below is both the argument
 * and the strip. Do not sort this alphabetically.
 *
 * The randomness run is a single escalation in what a random process is asked to
 * produce. The board makes a distribution out of coin flips. Buffon makes a
 * *constant* out of geometry, at the O(1/√N) rate that is the honest price of
 * every estimator after it. Monte Carlo π reaches the same constant by the
 * cheapest possible rule, which is what makes it the place to draw the 1.64/√n
 * envelope and admit the rate out loud. Then DLA asks for a *shape*, and the
 * answer — dimension 1.71 — is the first target here with no closed form at all,
 * which is the bridge out of the group: a random rule can converge on an object
 * whose constant we can only measure.
 *
 * The chaos run then removes the randomness one tab at a time. The chaos game
 * still draws from the seeded stream, but its limit is exact and independent of
 * every draw — the point where randomness stops mattering to the answer. The
 * bifurcation diagram has no randomness left and produces chaos anyway. Lorenz
 * makes that continuous, and its twin trajectory is the reason any of it matters
 * outside a screen.
 */
export const registry: readonly Viz[] = [
  galton,
  // `clt` (Central Limit Machine) belongs here once built: the board is that
  // machine with a fixed Bernoulli source, so the general statement sits between
  // the hero and the first route to π.
  buffon,
  montecarloPi,
  dla,
  chaosGame,
  bifurcation,
  lorenz,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
