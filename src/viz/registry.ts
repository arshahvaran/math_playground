import type { Viz } from '../core/types';
import { galton } from './galton';
import { buffon } from './buffon';
import { montecarloPi } from './montecarlo-pi';
import { arcsine } from './arcsine';
import { dla } from './dla';
import { orbits } from './orbits';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical, and the shell builds its group runs from *consecutive*
 * entries, so the two facts are one fact: the order below is both the argument
 * and the strip. Do not sort this alphabetically.
 *
 * The run escalates what a random process is asked to produce. The board makes
 * a *distribution* out of coin flips. Buffon makes a *constant* out of geometry,
 * and Monte Carlo pi reaches the same constant by the cheapest possible rule,
 * which is where the 1/sqrt(n) price of every estimator is admitted out loud.
 * The Long Lead then turns those same coin flips against the intuition the board
 * just built: a fair game spends almost all of itself lopsided. DLA asks for a
 * *shape*, and its dimension has no closed form at all.
 *
 * Orbits closes the run by taking the randomness away. The first five tabs all
 * make the same trade: throw enough dice and something exact falls out — a bell,
 * a constant, a dimension — so a reader could leave with the idea that chance is
 * what makes a thing hard to predict. Two bodies under gravity have no chance in
 * them at all and repeat for ever, which is why an eclipse can be dated
 * centuries ahead; add a third and the same arithmetic, with the same seed and
 * nothing random anywhere, stops being predictable the moment you cannot measure
 * the start perfectly. That is the other half of the subject, and it belongs
 * last because it only lands once the first half has been made.
 */
export const registry: readonly Viz[] = [
  galton,
  buffon,
  montecarloPi,
  arcsine,
  dla,
  orbits,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
