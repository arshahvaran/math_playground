# math_playground

Ten interactive math visualizations behind one tab bar. Client-side, no backend,
deployed to GitHub Pages.

Design in `docs/ARCHITECTURE.md`. Process in `docs/WORKFLOW.md`. What each tab
must do, and the analytic value it must converge to, in `docs/VISUALIZATIONS.md`.

## Gotchas

These are the things the file tree will not tell you.

- **`Math.random()` is banned in `src/viz/`.** Draw from the seeded `Rng` on
  `VizContext`. Permalinks and every convergence test depend on it. A test
  enforces this.
- **`step()` must not draw. `draw()` must not mutate simulation state.** The
  fixed-timestep driver calls `step()` a variable number of times per frame; a
  visualization that breaks this is non-deterministic in a way that only shows up
  on a different refresh rate.
- **Static geometry belongs on `layers.background`.** It repaints only on resize
  and parameter change. Pegs and ruled lines painted every frame are the usual
  cause of a dropped frame budget here.
- **`Viz.id` is permanent.** It appears in permalinks people have shared. Renaming
  one breaks them.
- **The registry is ordered pedagogically.** Do not sort it.
- **Never add a per-visualization control by hand.** Controls come from
  `ParamSpec[]`. If a needed control kind does not exist, add a variant to the
  union in `core/types.ts`; the compiler will list every site to update.
- **Every number drawn on canvas also goes through `emit()`.** A canvas is opaque
  to assistive technology, and the readouts are what tests assert on.

## Procedures

Loaded on demand, not read up front:

- `.claude/skills/add-visualization/` — building a new tab end to end.
- `.claude/skills/verify-visualization/` — the Definition of Done checklist.

## Working agreement

- Report status with evidence: seed, parameters, measured value against the
  analytic one, frame rate. Not "it works".
- Build the phase in progress. New ideas go to the backlog in
  `docs/VISUALIZATIONS.md`, not into the current branch.
- Match the surrounding code's idiom and comment density. Comments here explain
  the mathematics and the non-obvious performance choices; they do not narrate
  the syntax.
