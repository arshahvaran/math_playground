import type { Viz } from '../core/types';

/**
 * Every visualization in the app, in tab order.
 *
 * Order is pedagogical: Galton Board first because it motivates the whole
 * randomness group, then breadth. Do not sort this alphabetically.
 */
export const registry: readonly Viz[] = [
  // Populated in Phase 1+. See docs/VISUALIZATIONS.md for the planned catalogue
  // and .claude/skills/add-visualization/SKILL.md for the procedure.
];

export function findViz(id: string): Viz | undefined {
  return registry.find((v) => v.id === id);
}
