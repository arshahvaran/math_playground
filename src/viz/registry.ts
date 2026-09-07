import type { Viz } from '../core/types';
import { galton } from './galton';
import { buffon } from './buffon';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical: Galton Board first because it motivates the whole
 * randomness group, then breadth. Do not sort this alphabetically.
 */
export const registry: readonly Viz[] = [
  galton,
  // `clt` (Central Limit Machine) belongs here once built: the board is that
  // machine with a fixed Bernoulli source, so the general statement sits between
  // the hero and the first route to π.
  buffon,
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
