# Visualization Catalogue

The planned contents of the app, in tab order. Order is pedagogical: the
randomness group builds one idea across five tabs, then the remaining groups
provide contrast.

Each entry states the **analytic target** — the closed-form value the simulation
must converge to. That target is what the Definition of Done tests against. A
visualization without a checkable target does not belong in this app.

Status: `planned` until built, then `done`.

---

## Group 1 — Randomness

The spine of the app. Every tab here is a different route to the same
destination, and the fifth one shows the destination is not guaranteed.

### 1. Galton Board — `galton` *(planned, Phase 1)*

The hero. A ball falls through a triangular lattice of pegs, going left or right
at each one. Where it lands is the sum of `n` coin flips.

- **Parameters:** rows (3–20), ball count (1–50,000), bias `p` (0–1), drop rate,
  restitution, show normal overlay, show binomial bars, seed.
- **Analytic target:** landing bin ~ `Binomial(n, p)`, mean `n·p`, variance
  `n·p·(1−p)`. With the overlay on, the normal approximation `N(np, np(1−p))`.
- **The moment:** at `p = 0.5` the bell is symmetric and obvious. Drag `p` to 0.7
  and the whole distribution slides right while staying bell-shaped — which is
  the actual lesson. The bell is not about fairness.
- **Facts:** Galton called it a *quincunx* and built it to argue that inherited
  traits would still produce a stable population distribution.

### 2. Central Limit Machine — `clt` *(planned)*

Sum `N` samples from a distribution you choose, plot the standardized sum, repeat.

- **Parameters:** source distribution (uniform / exponential / bimodal / lognormal
  / Pareto / **Cauchy**), summands `N` (1–100), sample count, show source density, seed.
- **Analytic target:** the standardized sum converges to `N(0, 1)` for every
  source with finite variance. Cauchy has none, and the standardized sum of `N`
  Cauchy samples is still exactly Cauchy — it never narrows, no matter how large `N` gets.
- **The moment:** the bimodal source. Two humps, obviously not normal, and at
  `N = 30` it is a clean bell. Then switch to Cauchy and watch it refuse.
- **Why it sits next to the Galton board:** the board is this machine with a
  fixed Bernoulli source. This tab is the general statement.

### 3. Buffon's Needle — `buffon` *(planned)*

Drop needles on ruled lines. Count crossings. Recover π.

- **Parameters:** needle length `ℓ`, line spacing `d`, drop rate, total drops,
  show crossing angle field, seed.
- **Analytic target:** for `ℓ ≤ d`, crossing probability is `2ℓ / (πd)`, so
  `π ≈ 2ℓ·N / (d·C)` for `C` crossings in `N` drops. Convergence is `O(1/√N)`,
  which is slow enough to be worth seeing: expect roughly two correct digits at
  10,000 drops, not five.
- **Facts:** in 1901 Lazzarini reported 3,408 throws giving π to six decimals —
  precisely `355/113`. The throw count was almost certainly chosen after the fact
  to land on that known approximation.

### 4. Monte Carlo π — `montecarlo-pi` *(planned)*

Throw darts at a square, count the ones inside the inscribed circle.

- **Parameters:** dart count, show error curve, show `1/√n` reference, seed.
- **Analytic target:** `π ≈ 4 · inside / total`; absolute error shrinks as `1/√n`.
- **The moment:** the error plot with the `1/√n` envelope drawn over it. Getting
  one more decimal place costs a hundred times the darts. This is the honest
  reason Monte Carlo integration is not how anyone computes π.

### 5. Random Walks — `random-walk` *(planned)*

One drunkard, or ten thousand.

- **Parameters:** dimension (1D / 2D / 3D), step count, walker count, show `√n`
  envelope, show return-to-origin count, seed.
- **Analytic target:** RMS displacement grows as `√n`. Pólya's theorem: a random
  walk on ℤ and ℤ² returns to the origin with probability 1; on ℤ³ the return
  probability is about 0.3405.
- **Facts:** stated by Kakutani as — a drunk man will find his way home, but a
  drunk bird may get lost forever.

---

## Group 2 — Waves and Curves

Deterministic, periodic, and immediately legible. The visual break from Group 1.

### 6. Fourier Epicycles — `fourier` *(planned)*

Nested rotating circles, tip tracing a curve.

- **Parameters:** term count (1–200), target waveform (square / sawtooth /
  triangle / hand-drawn path), speed, show partial sums.
- **Analytic target:** partial sums converge to the target in `L²`. At a jump
  discontinuity the overshoot approaches **8.9490%** of the jump and does not
  shrink as terms are added — the Gibbs phenomenon.
- **The moment:** adding terms makes the ringing narrower but never shorter.

### 7. Lissajous Figures — `lissajous` *(planned)*

Two perpendicular oscillations.

- **Parameters:** frequency ratio `a:b`, phase offset `δ`, damping, trail length.
- **Analytic target:** the curve closes if and only if `a/b` is rational; the
  figure has `a` horizontal and `b` vertical lobes.
- **The moment:** set the ratio slightly off an integer and the closed figure
  begins to precess. Rational and irrational become something you can watch.

---

## Group 3 — Chaos and Fractals

### 8. Logistic Bifurcation — `bifurcation` *(planned)*

Iterate `xₙ₊₁ = r·xₙ·(1 − xₙ)` and plot the attractor against `r`.

- **Parameters:** `r` range, iterations per column, transient skip, zoom region.
- **Analytic target:** period doubling at `r ≈ 3, 3.449, 3.544, …`, accumulating
  at `r ≈ 3.5699`. The ratio of successive interval lengths approaches the
  **Feigenbaum constant δ ≈ 4.6692**.
- **Facts:** δ is universal. Every smooth map with a single quadratic maximum
  period-doubles at the same rate, which is why the constant shows up in dripping
  taps and convecting fluids.

### 9. Mandelbrot and Julia — `mandelbrot` *(planned)*

- **Parameters:** center, zoom, max iterations, Julia constant `c`, smooth
  colouring, palette.
- **Analytic target:** escape-time with the standard smooth-iteration correction;
  boundary is where the Julia set for `c` stops being connected.
- **Implementation note:** the only tab that needs WebGL. Per-pixel escape-time
  in a 2D canvas loop cannot hold 55 fps while zooming. See
  `docs/adr/0002-webgl-for-escape-time.md` when it is written.

---

## Group 4 — Numbers

### 10. Collatz Orbits — `collatz` *(planned)*

Halve if even, `3n + 1` if odd. Draw the tree of paths back to 1.

- **Parameters:** maximum start value, branch angle, colour by stopping time,
  highlight a single orbit.
- **Analytic target:** none — that is the point, and it is the one exception to
  the rule at the top of this file. Verified instead against known values: 27
  takes 111 steps and peaks at 9,232.
- **The moment:** every path terminates, nobody can prove they all do, and the
  tree is beautiful.

---

## Backlog

Not in v1. Recorded here so ideas leave the current branch.

Birthday problem · Bertrand's paradox · Sierpiński chaos game · percolation
threshold · Poisson process · Benford's law · Monty Hall · sandpile automaton ·
Ulam spiral · continued-fraction convergents · Lorenz attractor · Penrose tiling
