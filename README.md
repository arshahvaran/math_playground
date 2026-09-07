# Math Playground

Interactive, parameter-driven visualizations of classic results in probability,
chaos, and number theory. Every tab is a live simulation with sliders, a seeded
run you can share by URL, and a number that converges to something you can check
by hand.

**→ [arshahvaran.github.io/math_playground](https://arshahvaran.github.io/math_playground/)**

> **Status: Phase 0.** The contract, build, tests, and deployment are in place.
> Visualizations begin at Phase 1. See [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## What is in it

**Randomness** — Galton Board · Central Limit Machine · Buffon's Needle ·
Monte Carlo π · Random Walks

**Waves and curves** — Fourier Epicycles · Lissajous Figures

**Chaos and fractals** — Logistic Bifurcation · Mandelbrot and Julia

**Numbers** — Collatz Orbits

Full catalogue, with the parameters and the analytic target for each, in
[`docs/VISUALIZATIONS.md`](docs/VISUALIZATIONS.md).

## Ideas the app is built around

**Every run is reproducible.** Randomness comes from a seeded generator, and the
seed is in the URL. `#/galton?rows=12&p=0.5&seed=42` shows you the same run it
showed the person who sent it — which is what makes a link worth pasting into a
lecture.

**Every simulation is checkable.** Buffon's needle has to produce π. The Galton
board has to produce a binomial mean of `n·p`. Those are automated tests with
fixed seeds, not claims in a README.

**Parameters are the explanation.** The Galton board at `p = 0.5` teaches that
the normal distribution is symmetric. Dragging `p` to `0.7` teaches that it was
never about symmetry. The second lesson only exists because the slider does.

**Story mode.** Each tab ships an ordered set of presets that walks from the
obvious configuration to the surprising one.

## Development

```bash
npm install
npm run dev        # vite dev server
npm test           # vitest
npm run build      # typecheck + production build
```

Requires Node 20+. No runtime dependencies.

## Repository layout

```
src/core/     contract, engine, seeded RNG, stats, router
src/ui/       shell, generated controls, theme
src/viz/      one directory per visualization + the ordered registry
tests/        determinism and convergence tests
docs/         architecture, workflow, catalogue, decision records
```

## Contributing

New visualizations are welcome, and the bar is specific: the simulation has to
converge to a value that can be checked in closed form. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## License

MIT © Ali Reza Shahvaran
