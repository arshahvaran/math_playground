import type { Viz } from '../core/types';
import { galton } from './galton';
import { maxwellBoltzmann } from './maxwell-boltzmann';
import { buffon } from './buffon';
import { montecarloPi } from './montecarlo-pi';
import { arcsine } from './arcsine';
import { dla } from './dla';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical, and the shell builds its group runs from *consecutive*
 * entries, so the two facts are one fact: the order below is both the argument
 * and the strip. Do not sort this alphabetically.
 *
 * The run escalates what a random process is asked to produce. The board makes
 * a *distribution* out of coin flips. Maxwell–Boltzmann takes three of the
 * board's bells, one for each direction a molecule can move, and asks how long
 * the arrow they make is — a second distribution, lopsided and no bell at all,
 * and the one every gas in the room obeys. Buffon makes a *constant* out of geometry,
 * and Monte Carlo pi reaches the same constant by the cheapest possible rule,
 * which is where the 1/sqrt(n) price of every estimator is admitted out loud.
 * The Long Lead then turns those same coin flips against the intuition the board
 * just built: a fair game spends almost all of itself lopsided. DLA asks for a
 * *shape*, and its dimension has no closed form at all.
 */
export const registry: readonly Viz[] = [
  galton,
  maxwellBoltzmann,
  buffon,
  montecarloPi,
  arcsine,
  dla,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
