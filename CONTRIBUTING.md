# Contributing

## Adding a visualization

1. Add an entry to `docs/VISUALIZATIONS.md` first, including the **analytic
   target** — the closed-form value your simulation converges to. If there is no
   such value, say why the visualization is still worth including. Collatz is the
   only current exception.
2. Create `src/viz/<id>/` implementing `Viz` from `src/core/types.ts`.
3. Register it in `src/viz/registry.ts` at the position its subject matter earns.
   The list is not alphabetical.
4. Add `tests/<id>.test.ts` asserting convergence with a fixed seed.
5. Meet every item in the Definition of Done in `docs/WORKFLOW.md`.

## Rules that will fail review

- `Math.random()` anywhere in `src/viz/`.
- Drawing inside `step()`, or mutating simulation state inside `draw()`.
- Static geometry repainted every frame instead of on the background layer.
- Hand-written controls instead of a `ParamSpec`.
- A number shown on canvas that never reaches `emit()`.
- A `Fact` without a source.
- Renaming an existing `Viz.id`.

## Pull requests

State the evidence, not the effort. A visualization PR should report the seed,
the parameters, the measured value against the analytic one, and the frame rate
at maximum slider settings.

Commits follow Conventional Commits: `feat(buffon): estimate pi from crossing fraction`.
