# Architecture

## The shape of the problem

Ten visualizations that share almost nothing mathematically, but share everything
structurally: a canvas, a set of tunable parameters, a simulation loop, and a
number that should converge somewhere.

The design puts all of that sameness in one place and lets each visualization be
only its own mathematics.

```
                    ┌──────────────────────────────────────┐
   registry.ts ───▶ │  shell: tabs · router · frame driver │
                    └───────────────┬──────────────────────┘
                                    │ reads Viz metadata
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     params: ParamSpec[]     presets: Preset[]      facts: Fact[]
              │                     │                     │
              ▼                     ▼                     ▼
      generated controls      Story mode steps       fact card
              │
              │ values
              ▼
        create(ctx) ──▶ VizInstance { step · draw · reset · destroy }
```

The shell imports the registry. Nothing imports the shell. A visualization that
needs the shell changed means the contract is wrong — fix `core/types.ts`.

## Modules

| Path | Responsibility |
|---|---|
| `src/core/types.ts` | The contract. `Viz`, `VizInstance`, `ParamSpec`, `Readout`, `Preset`, `Fact`. |
| `src/core/engine.ts` | Fixed-timestep frame driver. Owns `requestAnimationFrame`. |
| `src/core/rng.ts` | Seeded PRNG. The only source of randomness in the app. |
| `src/core/canvas.ts` | DPR-aware sizing of the two stacked canvases. *(Phase 1)* |
| `src/core/stats.ts` | Histograms, moments, normal PDF, convergence helpers. *(Phase 1)* |
| `src/core/router.ts` | Hash routing and parameter serialization. *(Phase 1)* |
| `src/ui/shell.ts` | Header, tab bar, layout, tab lifecycle. *(Phase 1)* |
| `src/ui/controls.ts` | `ParamSpec[]` → DOM. Exhaustive switch on `kind`. *(Phase 1)* |
| `src/viz/registry.ts` | Ordered list of visualizations. |
| `src/viz/<id>/` | One visualization. Imports from `core/`, never from `ui/`. |

## Four decisions worth knowing

### Fixed timestep, variable frame rate

`step(dt)` is called with a constant `dt` of 1/120 s, zero or more times per
frame, driven by an accumulator. Rendering happens once per frame regardless.

This buys three things: identical results on a 60 Hz and a 144 Hz display, a
speed multiplier that costs nothing (run more steps per frame), and a
fast-forward that reuses the same code path with rendering skipped.

Elapsed time is clamped to 250 ms per frame. Returning to a backgrounded tab
otherwise hands the loop a multi-second delta, which produces a longer frame,
which produces a longer delta — the spiral of death.

### Two canvases, not one

`background` holds geometry that only changes when parameters change: the Galton
board's pegs, Buffon's ruled lines. `foreground` is cleared every frame.

A 20-row Galton board has 210 pegs. Repainting them 60 times a second is roughly
12,600 wasted arc calls per second, and it is the most common way this kind of
app quietly loses half its frame budget.

### Seeded randomness, everywhere

`Math.random()` is banned in `src/viz/`. Every visualization draws from a `Rng`
seeded by a URL parameter.

This is what makes permalinks real. `#/galton?rows=12&p=0.5&seed=42` shows the
recipient the same run the sender saw, which matters for a tool meant to be
pasted into a lecture or a thread. It is also what makes the convergence tests
possible: an assertion on a random process is only meaningful if the process is
reproducible.

### Declarative parameters

Controls are generated from `ParamSpec[]`. There is no hand-written UI in any
visualization directory.

The cost is a slightly awkward type when a visualization wants something exotic.
The benefit is that every tab feels identical to operate, adding a visualization
touches no UI code, and the URL serializer works for new parameters without
being told about them. When a visualization genuinely needs a control kind that
does not exist, the fix is to add a variant to the union — the compiler then
lists every place that must handle it.

## Performance budget

| Metric | Budget |
|---|---|
| Frame time at max slider values | ≤ 16 ms (55+ fps) |
| Bundle, gzipped | ≤ 150 KB |
| Runtime dependencies | 0 |
| Time to interactive, cold, 4G | ≤ 1.5 s |

Enforced per visualization at review, not measured once at the end.

## Rendering

2D canvas for nine of the ten. WebGL only for `mandelbrot`, where per-pixel
escape-time in JavaScript cannot hold the frame budget while zooming.

SVG was considered and rejected: these scenes reach tens of thousands of moving
elements, and that is where retained-mode rendering stops being an advantage.

## Accessibility

Not a Phase 3 bolt-on. Two of the constraints are structural:

- Every number rendered on canvas must also be published through `emit()`. A
  canvas is opaque to a screen reader; the readout list is the accessible
  representation of the visualization's actual output.
- `prefers-reduced-motion` disables autoplay and reveals a step control plus a
  "run N trials instantly" control. Both are already supported by the engine —
  `stepOnce()` and `fastForward()` exist for this reason.

Controls are real `<input>` elements, so keyboard operation and screen reader
labelling come from the platform rather than from us reimplementing them.
