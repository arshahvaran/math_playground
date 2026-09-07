---
name: add-visualization
description: Build a new visualization tab for math_playground end to end — directory, Viz implementation, registry entry, convergence test, and presets. Use when adding any new tab or when asked to implement an entry from docs/VISUALIZATIONS.md.
---

# Adding a visualization

## Before writing code

Read the entry in `docs/VISUALIZATIONS.md`. If there is none, write it first —
specifically the **analytic target**. A visualization whose convergence target is
unknown cannot pass the Definition of Done, and discovering that after the
animation is built is an expensive way to learn it.

## Steps

1. **Directory.** `src/viz/<id>/` with `index.ts` exporting a `Viz`. Split the
   mathematics into its own module (`geometry.ts`, `sim.ts`) so it can be tested
   without a canvas. This is the difference between a testable visualization and
   one that can only be checked by looking at it.

2. **Parameters.** Declare every knob as a `ParamSpec`. Include a `seed` param.
   Set `budget.maxEntities` so no slider combination can hang the tab.

3. **`create(ctx)`.** Return a `VizInstance`. Allocate typed arrays up front at
   `budget.maxEntities` rather than growing arrays per frame.

4. **`step(dt)`.** Advance the simulation. Never touch a canvas here. Draw
   randomness from `ctx.rng`, never `Math.random()`.

5. **`drawBackground()`.** Paint everything that only changes when parameters do.

6. **`draw()`.** Clear `layers.foreground` and paint the moving parts. Do not
   mutate simulation state.

7. **`emit()`.** Publish every number the visualization shows, with `target` set
   to the analytic value where one exists. The UI renders live error for free,
   and the tests read these.

8. **Presets.** Three to five, ordered so that stepping through them walks a
   newcomer to the insight. Each needs a one-sentence caption saying what it reveals.

9. **Facts.** Two or three, each with a source.

10. **Register.** Add to `src/viz/registry.ts` in the position its subject matter
    earns. The list is not alphabetical.

11. **Test.** `tests/<id>.test.ts` with a fixed seed, asserting convergence to the
    analytic target within a stated tolerance. Test the extracted mathematics
    module, not the canvas.

## Traps

- **Frame-rate-dependent physics.** `x += v` instead of `x += v * dt` looks fine
  at 60 Hz and runs at double speed on a 120 Hz display.
- **Growing arrays per frame.** Allocate at the budget ceiling once.
- **Leaking on tab switch.** `destroy()` must remove every listener, timer, and worker.
- **Per-particle `ctx.fillStyle`.** Group by colour and batch the path instead.
- **Tolerances tuned until the test passes.** State the tolerance from the theory
  — the standard error at the trial count — and then meet it.

## Done

Run the `verify-visualization` skill. Six criteria, all of them.
