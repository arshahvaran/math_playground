import type { Viz } from '../core/types';
import { galton } from './galton';
import { buffon } from './buffon';
import { montecarloPi } from './montecarlo-pi';
import { arcsine } from './arcsine';
import { dla } from './dla';
import { lorenz } from './lorenz';
import { ising } from './ising';
import { kuramoto } from './kuramoto';
import { coprime } from './coprime';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical, and the shell builds its group runs from *consecutive*
 * entries, so the two facts are one fact: the order below is both the argument
 * and the strip. Do not sort this alphabetically.
 *
 * The randomness run escalates what a random process is asked to produce. The
 * board makes a distribution out of coin flips. Buffon makes a *constant* out of
 * geometry, and Monte Carlo pi reaches the same constant by the cheapest
 * possible rule, which is where the 1/sqrt(n) price of every estimator is drawn
 * out loud. The Long Lead then turns the same coin flips against the intuition
 * they just built: a fair game spends almost all of itself lopsided. DLA asks
 * for a *shape*, and its dimension has no closed form at all — the bridge out of
 * the group.
 *
 * The chaos run removes the randomness. Lorenz has none and is unpredictable
 * anyway; Ising puts randomness back as heat and gets order out of it at an
 * exact temperature. Kuramoto is the same transition in time rather than space.
 * Visible Stars closes on a second, independent road to pi with nothing round in
 * the picture.
 */
export const registry: readonly Viz[] = [
  galton,
  buffon,
  montecarloPi,
  arcsine,
  dla,
  lorenz,
  ising,
  kuramoto,
  coprime,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
