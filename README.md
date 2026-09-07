# Math Playground

[![Live app](https://img.shields.io/badge/Live%20app-math__playground-2ea44f)](https://arshahvaran.github.io/math_playground/)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/arshahvaran/math_playground/releases)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)

A client-side web tool presenting interactive, parameter-driven visualizations of
classic results in probability, chaos, and number theory. Every tab is a live
simulation with adjustable parameters, a seeded run that can be shared by URL, and
a numerical result that converges to a value verifiable in closed form.

**Live app:** https://arshahvaran.github.io/math_playground/

> **Status: Phase 0.** The visualization contract, build pipeline, test suite, and
> deployment are in place. Visualizations begin at Phase 1. See
> [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## Contents

- [Key features](#key-features)
- [Visualizations](#visualizations)
- [Getting started](#getting-started)
- [Technical validation](#technical-validation)
- [Repository layout](#repository-layout)
- [Contributing](#contributing)
- [How to cite](#how-to-cite)
- [License](#license)

## Key features

**Reproducible runs.** Randomness is drawn from a seeded generator, and the seed
travels in the URL. `#/galton?rows=12&p=0.5&seed=42` renders for the recipient the
same run the sender saw, which is what makes a link worth pasting into a lecture
or a thread.

**Verifiable simulations.** Each visualization converges to a closed-form value —
Buffon's needle to π, the Galton board to a binomial mean of `n·p`, the random walk
to `√n` growth. These are asserted in fixed-seed automated tests rather than claimed.

**Parameters as explanation.** The Galton board at `p = 0.5` shows that the normal
distribution is symmetric; moving `p` to `0.7` shows that symmetry was never the
point. The second lesson exists only because the control does.

**Story mode.** Each tab ships an ordered set of presets that walks from the
obvious configuration to the surprising one, with a caption for each step.

**Accessible by construction.** Every number drawn on canvas is also published as
text for assistive technology, controls are native form elements, and
`prefers-reduced-motion` switches continuous animation for explicit step and
fast-forward controls.

**No backend and no runtime dependencies.** Static files on GitHub Pages.

## Visualizations

| Group | Tabs |
|---|---|
| Randomness | Galton Board · Central Limit Machine · Buffon's Needle · Monte Carlo π · Random Walks |
| Waves and curves | Fourier Epicycles · Lissajous Figures |
| Chaos and fractals | Logistic Bifurcation · Mandelbrot and Julia |
| Numbers | Collatz Orbits |

Each entry's parameters, analytic target, and sourced facts are catalogued in
[`docs/VISUALIZATIONS.md`](docs/VISUALIZATIONS.md).

## Getting started

The live app requires no installation. To run it locally:

```bash
git clone https://github.com/arshahvaran/math_playground.git
cd math_playground
npm install
npm run dev
```

Then open the URL Vite prints. Other commands:

```bash
npm test          # vitest — determinism and convergence tests
npm run typecheck # tsc --noEmit
npm run build     # typecheck + production build to dist/
```

Requires Node 20 or newer. TypeScript, Vite, and Vitest are the only
dependencies, and all three are development-only.

## Technical validation

A visualization is accepted only when six conditions hold, each measured rather
than asserted:

1. **Convergence.** A fixed-seed test shows the simulation reaching its analytic
   target within a tolerance derived from theory — for Monte Carlo methods, the
   standard error at the given trial count, which scales as `1/√N`.
2. **Determinism.** Identical seed and parameters produce identical readouts.
   `Math.random()` is prohibited in `src/viz/` and the prohibition is tested.
3. **Performance.** 55 fps or better at maximum parameter values, measured and
   recorded, against a 16 ms frame budget.
4. **Accessibility.** Keyboard operation, labelled controls, a text equivalent for
   every on-canvas number, and a reduced-motion path.
5. **Sourcing.** Every stated fact carries a citation.
6. **Shareability.** Permalinks round-trip.

The full procedure is in [`docs/WORKFLOW.md`](docs/WORKFLOW.md); the design
rationale is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```
src/core/     visualization contract, frame engine, seeded RNG, statistics, router
src/ui/       application shell, generated control panel, theme
src/viz/      one directory per visualization, plus the ordered registry
tests/        determinism and convergence tests
docs/         architecture, workflow, catalogue, and decision records
```

The application shell contains no per-visualization code. Controls are generated
from each visualization's declared parameter list, so adding a tab means adding one
directory and one registry entry.

## Contributing

New visualizations are welcome. The requirement is specific: the simulation must
converge to a value checkable in closed form. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## How to cite

Shahvaran, A. R. (2026). *Math Playground: interactive visualizations of classic
mathematical results* (Version 0.1.0) [Computer software].
https://github.com/arshahvaran/math_playground

Machine-readable metadata is in [`CITATION.cff`](CITATION.cff).

## License

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)

This work is licensed under a
[Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/).

[![CC BY-NC 4.0](https://licensebuttons.net/l/by-nc/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc/4.0/)

© 2026 Ali Reza Shahvaran
