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

### 1. Galton Board — `galton` *(done)*

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

### 3. Buffon's Needle — `buffon` *(done)*

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
- **Analytic target:** `π ≈ 4 · inside / total`. The estimator's standard error is
  `4·√(p(1−p)/n)` with `p = π/4`, which is **1.64218/√n** — verified: 0.0519 at
  n = 1e3, 0.00519 at n = 1e5, 0.00164 at n = 1e6. The running error must sit
  inside that envelope.
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
- **Analytic target:** period doubling at `r = 3`, `1+√6 = 3.449490`, `3.544090`,
  `3.564407`, accumulating at `r∞ ≈ 3.5699456`. Successive interval ratios go
  **4.7514 → 4.6563 → 4.6682** — verified — approaching the **Feigenbaum constant
  δ = 4.669201609**. The readout shows the running ratio against it.
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

---

## Group 5 — Iteration and Convergence

The thesis of this group in one line: **run a simple rule an absurd number of
times and an exact, beautiful object appears.** Each tab is a loop you can watch
converge, and each converges to something with a closed-form description — a
dimension, a constant, a rate.

These are the tabs to reach for when someone asks what is fun about mathematics.

### 11. Chaos Game — `chaos-game` *(planned)*

Pick a random vertex of a polygon. Jump a fraction of the way toward it. Plot the
point. Repeat a million times. A fractal appears — the same one every time,
from any starting point.

- **Parameters:** system (Sierpiński triangle / Sierpiński pentagon / square /
  Barnsley fern / dragon curve / custom n-gon), vertices `n` (3–8), jump ratio
  `r` (0.1–0.9), restriction rule (none / no repeat / not a neighbour / not the
  opposite), points (1e3–2e6, log), points per frame, colour by vertex, seed.
- **Analytic target:** for `n` similarities of ratio `r` satisfying the open set
  condition, the attractor has Hausdorff dimension `log n / log(1/r)`. Verified:
  `n = 3, r = 0.5` gives **1.5850** (Sierpiński triangle); `n = 5,
  r = 1/(1+2cos(π/5)) = 0.381966` gives **1.6723**. A box-counting estimate over
  the rendered points must converge to that value.
- **The moment:** `n = 4, r = 0.5` fills the square solid — dimension exactly 2,
  because the four half-squares tile it with no gaps. Then switch the restriction
  rule to "no repeat" and a fractal snaps out of the noise. The restriction, not
  the randomness, is what creates the structure.
- **Why it earns its place:** it is the cleanest demonstration in mathematics
  that a random process can have a completely deterministic outcome. Every point
  after the first few lands *on* the attractor, and the picture is exact.
- **Facts:** Barnsley named it in *Fractals Everywhere* (1988); the attractor is
  independent of the starting point, which is why the first ~20 points are
  discarded; the Barnsley fern uses four affine maps chosen with probabilities
  0.01 / 0.85 / 0.07 / 0.07, and the 1% map draws the stem.

### 12. Diffusion-Limited Aggregation — `dla` *(planned)*

Release a particle far away. Let it random-walk until it touches the cluster.
Freeze it. Repeat. Coral, frost, lightning and copper deposits all grow this way.

- **Parameters:** particles (100–50 000, log), stickiness (0.05–1), launch radius
  margin, lattice (off-lattice / square / hexagonal), colour by arrival order,
  seed.
- **Analytic target:** the cluster is a fractal of dimension **D ≈ 1.71** in two
  dimensions (Witten and Sander, 1981). Measured by radius-of-gyration scaling
  `N ~ R_g^D`, the running estimate of `D` must approach 1.71 — at N = 10 000,
  expect `R_g` of order 218 particle radii.
- **The moment:** lower the stickiness to 0.05. Walkers now bounce off the tips
  many times before sticking, so they penetrate the fjords, and the cluster grows
  visibly *denser*. Screening is the whole mechanism, and one slider exposes it.
- **Facts:** the tips grow fastest because a wandering particle is overwhelmingly
  likely to hit an exposed branch before it reaches an interior gap — the same
  screening that makes lightning branch.

### 13. Lorenz Attractor — `lorenz` *(planned)*

Three simple differential equations, no randomness at all, and a trajectory that
never repeats and never escapes.

- **Parameters:** σ (default 10), ρ (default 28), β (default 8/3), integration
  step, trail length, twin trajectory with an adjustable initial gap
  (1e-12–1e-3), projection (xz / xy / yz / 3-D rotation), seed.
- **Analytic target:** for the classic parameters the non-trivial fixed points sit
  at `(±√(β(ρ−1)), ±√(β(ρ−1)), ρ−1)` = **(±8.4853, ±8.4853, 27)** — verified —
  and the largest Lyapunov exponent is **≈ 0.9056**, so any initial separation
  doubles every **0.765** time units. A 1e-9 gap therefore reaches order 1 in
  about **22.9** time units, and the readout must show that.
- **The moment:** the twin trajectory. Two paths starting 1e-9 apart trace each
  other exactly, for a while, and then diverge completely — on screen, in about
  twenty seconds. That is the butterfly effect as an event rather than a slogan.
- **Facts:** Lorenz found it in 1963 after restarting a weather simulation from a
  printout rounded to three decimals instead of six; ρ = 28 is chaotic but
  ρ = 14 is not, and the slider crosses that boundary.

---

---

## Group 6 — Convergence You Would Not Predict

Group 5 says: run a simple rule a lot and an exact object appears. This group
says something harder. **Run a simple rule a lot and the exact object that
appears is not the one anybody guesses.** Every tab here converges to a number
you can write down in closed form, and every one of those numbers contradicts
the first answer a reasonable person gives.

These are the tabs to reach for when someone says mathematics is just
arithmetic with more steps.

Each entry below states the analytic target **with its numeric value and how the
simulation measures it**, because a formula alone is not a test. Where a
browser-scale run cannot actually reach the target, the entry says so.

### 14. The Long Lead — `arcsine` *(planned)*

Flip a fair coin ten thousand times, and one side is usually ahead for almost
the whole game. Same coin flips as the Galton board, opposite shape.

- **Parameters:** flips per game (20–20,000, log), games (100–200,000, log),
  bias `p` (0.35–0.65, default 0.5), statistic (time in the lead / when the
  scores were last level / when the biggest lead happened), bins, show the exact
  curve, keep the trace fan, seed.
- **Analytic target:** the fraction of time spent in the lead follows the
  arcsine law, `F(x) = (2/π)·arcsin(√x)`. Verified: one side is ahead for more
  than 90% of the game with probability `2·F(0.1)` = **0.409666**; the lead
  fraction lands between 0.45 and 0.55 with probability only **0.063769**; the
  mean is exactly **0.5** and the variance exactly **1/8**; and the density is at
  its *minimum* at ½, where it equals `2/π` = **0.636620**. There is an exact
  finite-`n` law too — at **20 flips**, one side leads the entire game with
  probability **0.352394** and the two split it evenly with probability
  **0.060562**. **Measured** by binning lead fractions over `M` games and
  emitting the two tail probabilities, the mean, the variance, and the largest
  gap between the measured and analytic CDFs — at `M` = 40,000 games of 4,000
  flips that gap measured **0.0088**, mean 0.4948, variance 0.12449. Compare
  binned CDF differences, never the raw density, which diverges at both ends.
- **The moment:** everybody expects more flips to pile the histogram into the
  middle. It hollows out instead — more flips makes the valley *deeper*, because
  ties get rarer as the game lengthens, so whoever is ahead tends to stay ahead.
  Verified: over 10,000 flips the lead changes about **40** times, not 5,000.
- **Facts:** Paul Lévy published the law in 1939, and the same distribution
  governs three questions that sound unrelated — how long you led, when you were
  last level, and when your lead peaked. Feller gave it a chapter and warned
  that it shocks common sense: the most probable number of lead changes in a
  long game is zero.

### 15. Two Losing Games — `parrondo` *(planned)*

Two games that each lose money, played in alternation, win money.

- **Parameters:** bias `ε` (0–0.05, default 0.005), modulus `M` (2–6, default
  3), rule (A / B / random / AABB / ABB / ABAB), mix probability `γ` (0–1),
  players (1–5,000, log), rounds, show the predicted drift, show the mod-`M`
  occupancy, seed.
- **Analytic target:** the drift per round, **solved live in the browser from
  the Markov chain on capital mod `M`** rather than pasted in — so the analytic
  side is right for every slider position. Verified at `ε` = 0.005, `M` = 3:
  Game A alone **−0.010000**, Game B alone **−0.008695** with stationary
  distribution (**0.3836**, 0.1543, 0.4621), the random 50/50 mix
  **+0.015704**, AABB **+0.014651**, ABB **+0.057431**, and ABAB **−0.006738**,
  which still loses. At `ε` = 0 both games are exactly fair and the mix still
  earns **+0.025388**. *Correction to the circulating figure:* +0.0147 is the
  AABB cycle, not the random mix. **Measured** as the least-squares slope of the
  capital curves over many parallel players, against the chain's drift, plus the
  measured mod-`M` occupancy against the stationary vector.
- **The moment:** the three occupancy bars. If capital were spread evenly across
  the remainders, Game B's bad coin would come up a third of the time. It comes
  up **38.36%** of the time, because B's own losses keep pushing the capital
  back onto the multiples of three where the bad coin lives. Game A is too weak
  to win on its own and strong enough to knock the capital off those squares.
- **Facts:** Juan Parrondo devised the paradox in 1996 while working on the
  Brownian ratchet, Feynman's thought experiment about extracting work from
  random heat motion. Three is the only modulus that works: at `M` = 2 the
  mixture loses (−0.0850) and at `M` = 4 Game B already wins on its own
  (+0.0527), so there is no paradox left to show.

### 16. The Prisoners and the Boxes — `prisoners` *(planned)*

A hundred people each get fifty guesses, and one free rule takes them from no
chance at all to roughly one run in three.

- **Parameters:** people (6–200, default 100), boxes each may open (10–100% of
  `people`, default 50%), strategy (follow the numbers / open at random),
  trials, highlight the longest loop, speed, seed.
- **Analytic target:** for `k ≥ n/2`, exactly `1 − (Hₙ − H_k)`. Verified:
  **0.3118278** at `n` = 100, **0.354365** at `n` = 10, **0.307353** at
  `n` = 1000, limit `1 − ln 2` = **0.3068528**; against **7.89 × 10⁻³¹** for
  guessing. Simulation agrees — 0.3114 over 50,000 shuffles at `n` = 100.
  **There is no cliff at `k = n/2`, and the tab must say so:** the closed form
  simply stops being valid below half, and the exact answer from the recursion
  `q(m) = (1/m)·Σ q(m−j)` runs straight through it — **0.292028** at `k` = 49,
  **0.311828** at 50, **0.331436** at 51. Half is where the tidy formula
  *begins*. **Measured** as the fraction of shuffles whose longest loop is at
  most `k`, plus the running mean longest-loop length.
- **The moment:** the loop that decides the run is visible before the counter
  is. One loop is always the longest; if it is longer than `k`, everybody in it
  fails and nothing anyone else does can save the run. A hundred people are not
  a hundred separate bets — they all live or die on one object, and you can see
  which one.
- **Facts:** Anna Gál and Peter Bro Miltersen posed the problem in 2003; Eugene
  Curtin and Max Warshauer proved in 2006 that no strategy does better. The
  answer barely depends on how many people there are — 0.3544 for ten, 0.3118
  for a hundred, 0.3074 for a thousand.

### 17. Why Your Bus Is Always Late — `waiting-time` *(planned)*

Buses come every ten minutes on average, and the average passenger still waits
ten minutes.

- **Parameters:** mean gap (2–30 min, default 10), spread `σ/μ` (0–2, default 1
  — 1 is a Poisson process), gap shape (gamma / uniform / lognormal /
  two-speed), observers (100–500,000, log), show the timeline, overlay both
  histograms, seed.
- **Analytic target:** the gap a random observer lands in averages
  `E[X²]/E[X] = μ + σ²/μ`, and the wait is half of that — so the bias is exactly
  `σ²/μ`. Verified by simulation at `μ` = 10 across five gap laws
  (simulated → analytic): exact gaps **10.000 → 10.000**; uniform 5–15
  **10.832 → 10.836**; gamma shape 4 **12.516 → 12.528**; exponential
  **19.957 → 19.957**, which is exactly `2μ`; lognormal
  **31.790 → 31.810**. A two-speed timetable (2-minute gaps 90% of the time,
  40-minute gaps 10%) has a mean gap of **5.80** and an observed gap of
  **28.218** against analytic 28.207 — and **69.0%** of passengers land in a
  40-minute gap that only one bus in ten follows. **Measured** as the mean of
  the gaps observers landed in, against both the mean of all gaps and
  `μ + σ²/μ` computed from that same run's gap sample.
- **The moment:** the geometry is the proof. Long gaps are wide targets, so most
  of the falling observer arrows land in them and short gaps get skipped. You
  watch the bias happen instead of being told about it — and it vanishes
  completely, on screen, the instant the spread slider reaches zero.
- **Facts:** Wikipedia states the bus waiting time paradox directly — the
  average rider observes more delay than the average operator, because the
  interval you sample is chosen in proportion to its own length.
  **Sourcing note for the code comment:** Wikipedia carries only the
  stochastic-dominance statement, *not* `μ + σ²/μ`; the identical formula is on
  the friendship-paradox page, and the renewal-theory derivation with the
  length-biased density is in Karl Sigman's Columbia notes. Same formula,
  different setting: Scott Feld showed in 1991 that your friends have more
  friends than you do, for exactly this reason.

### 18. Compounding — `compounding` *(planned)*

A game whose average grows five per cent a round sends almost everyone who plays
it broke.

- **Parameters:** up factor (default 1.5), down factor (default 0.6), stake
  fraction `f` (0–1, default 1), players (10–5,000, log), rounds, show the
  median beside the average, show the percentile band, seed.
- **Analytic target:** two exact numbers pointing in opposite directions, both
  true forever. The **average** grows by `½(1.5) + ½(0.6)` = **1.05** per round.
  The **typical** pile grows by `√(1.5 × 0.6)` = **0.94868330** — a 5.13% loss.
  Verified consequences: after 100 rounds the average is **131.5**, the median
  is **0.005154**, and **13.563%** of players are still above their starting
  pile; after 1000 rounds, **1.55 × 10²¹**, **1.3 × 10⁻²³**, and **0.014%**.
  Breaking even needs heads on **55.749%** of flips — of a fair coin. With a
  stake slider, `g(f) = ½ln(1 + 0.5f) + ½ln(1 − 0.4f)` and the average per round
  is exactly `1 + 0.05f`, giving four exact landmarks: `f = 0` → exactly **1**;
  `f = ¼` (the exact optimum) → **√1.0125 = 1.0062306**; `f = ½` → exactly
  **1**, zero growth while the average still climbs 2.5% a round; `f = 1` →
  **√0.9 = 0.9486833**. **Measured** by emitting the mean, the median, the 10th
  and 90th percentiles and the fraction above the starting pile every frame,
  each against its closed form.
- **The moment:** the average line and the middle line leaving in opposite
  directions on one log axis, from the same paths in the same run — with the
  handful of runaway threads carrying the whole average countable by eye. Then
  the stake slider: growth peaks at exactly a quarter and returns to exactly
  zero at a half. You can steer a favourable game to a dead stop.
- **Facts:** John L. Kelly Jr., a colleague of Claude Shannon at Bell Labs,
  derived the growth-optimal stake from information theory in 1956; for an
  even-money bet it is `2p − 1`. The +50%/−40% coin is the standard illustration
  of the gap between an average and an individual over time, set out by Ole
  Peters in *Nature Physics* in 2019. Staking exactly half gives a long-run
  growth rate of exactly zero — `1.25 × 0.8 = 1` — while the average still grows
  exactly 2.5% every round.
- **Copy note:** every label stays on multiplication, growth rate, average and
  median. This is a tab about what compounding does to a distribution, and any
  financial framing turns it into something else.

### 19. Coupled Oscillators — `kuramoto` *(planned)*

Give a crowd of clocks the faintest nudge toward one another and at one exact
strength they all start ticking together.

- **Parameters:** coupling `K` (0–4, default 2), speed spread `γ` (0.1–1,
  default 0.5), oscillators (50–4,000, log), speed distribution (Cauchy — the
  exactly solvable one / normal / uniform), show the order arrow, show the speed
  histogram, integration step, seed.
- **Analytic target:** with Cauchy speeds of half-width `γ` the whole transition
  is exact. Wikipedia gives `Kc = 2/(π·g(0))`; for a Lorentzian that is
  **`Kc = 2γ`**, so `γ = 0.5` puts the threshold on **1.000**. Above it,
  `r = √(1 − Kc/K)` — verified to solve Kuramoto's self-consistency integral to
  eight decimals: **0.408248 / 0.577350 / 0.707107 / 0.816497 / 0.866025** at
  `K` = 1.2 / 1.5 / 2 / 3 / 4. Verified by simulation at `N` = 4000: measured
  **0.4061 / 0.5745 / 0.7053 / 0.8148 / 0.8644** — every one within **0.003**.
  Below threshold the reading does *not* reach zero: measured floor **0.024** at
  `K` = 0.5 and **0.041** at 0.8, so the test must allow for it. **Measured** as
  the time-averaged length of the order arrow after an excluded transient —
  the rare case where the measured number *is* a drawn object.
- **The moment:** drag `K` up from zero and nothing happens, and nothing
  happens, and then at exactly 1.000 the arrow starts growing and never stops,
  tracking a curve drawn under it so closely the overlay looks like a rendering
  fault.
- **Facts:** Kuramoto built the model for chemical and biological oscillators;
  it is one of very few models of collective behaviour solvable exactly in the
  infinite limit. London's Millennium Bridge opened on 10 June 2000, swayed
  under crowds of up to 2,000 who unconsciously fell into step with it, closed
  on 12 June, and reopened on 22 February 2002 — Strogatz and colleagues
  modelled the walkers as coupled oscillators with a critical crowd size in
  *Nature* in 2005. The threshold does not depend on how many oscillators there
  are, only on how spread out their speeds are.
- **Implementation note:** the naive double sum is `O(N²)`. Use the mean-field
  form — compute `r` and `ψ` once per step, then
  `dθᵢ = ωᵢ + K·r·sin(ψ − θᵢ)` — which is `O(N)` and holds 2,000 oscillators.
  Draw the speeds once at reset by inverse CDF, `ω = γ·tan(π(u − ½))`, or
  permalinks will not reproduce.

### 20. The Ising Magnet — `ising` *(planned)*

A grid of tiny magnets, each copying its neighbours, turns from static into a
solid block at one exact temperature.

- **Parameters:** temperature (1.0–4.0, default 2.0), grid size (32–160, default
  96), external field (−0.5–0.5, default 0), sweeps per frame, burn-in sweeps,
  show Onsager's curve, colour by domain age, seed.
- **Analytic target:** the one candidate whose exact solution gives a whole
  **curve**, so measured-against-analytic runs along the entire temperature
  axis. `kT_c/J = 2/ln(1+√2)` = **2.269185314213022**, and below it
  `M = [1 − sinh⁻⁴(2J/kT)]^(1/8)` = **0.986500 / 0.911319 / 0.868748 /
  0.784755** at `T` = 1.5 / 2.0 / 2.1 / 2.2. (The widely repeated 0.6779 for
  `T` = 2.2 is wrong — that belongs to `T ≈ 2.248`.) At `T_c` the neighbour
  correlation is `1/√2` = **0.707107** and the energy per square is `−√2` =
  **−1.414214**. Verified on a 64×64 lattice: measured **0.9562 / 0.9111 /
  0.8659 / 0.7551** at `T` = 1.8 / 2.0 / 2.1 / 2.2 — inside 0.003 up to 2.1.
  **Measured** as time-averaged `|M|` per square after an excluded burn-in,
  compared point by point in the ordered phase only.
- **Four honest limits, all measured rather than assumed:** (1) above `T_c` a
  finite lattice never reads zero — **0.0537 / 0.0259 / 0.0127** at 32² / 64² /
  128², all at `T` = 4; (2) within ~0.1 of `T_c` plain Metropolis does not
  settle in a browser run — at `T_c` on 64² it measured 0.64 where Onsager gives
  0.17; (3) **do not advertise the 1/8 exponent** — fitting it from seven points
  across `T` = 2.00–2.22 gave **0.0886**, not 0.125; (4) the energy at `T_c` is
  better behaved but still ~1.5% high (**−1.4355** at 64², **−1.4346** at 96²).
- **The moment:** drag the temperature down through 2.269. The number sits at
  nothing, sits at nothing, then lifts off almost vertically — because the exact
  curve leaves zero as an eighth power, far steeper than anyone expects a
  physical quantity to be.
- **Facts:** Wilhelm Lenz invented the model in 1920 and gave it to his student
  Ernst Ising, who solved the one-dimensional case in his 1924 thesis and found
  no phase transition at all. Onsager solved the two-dimensional square lattice
  in 1944, announced the magnetisation formula in 1949 without a derivation, and
  C. N. Yang published the first proof in 1952.
- **Implementation note:** the most expensive and most RNG-hungry tab in the
  app — check the seeded generator's throughput first. Precompute the five
  possible `exp(−ΔE/T)` values (`ΔE ∈ {−8,−4,0,4,8}J`) into a lookup so `step()`
  never calls `exp()`; use a checkerboard sweep; blit one `ImageData`. Decide
  the measurement protocol *before* writing the visualization — a burn-in the
  readout excludes, an excluded band around `T_c`, and a stated finite-size
  floor above it. Without those three the tab displays a disagreement and calls
  it convergence.

### 21. Visible Stars — `coprime` *(planned)*

Stand at the corner of an endless orchard and about six trees in ten are not
hidden behind another.

- **Parameters:** grid size (50–1,200, log, default 400), mode (light the whole
  orchard / throw random pairs), numbers `k` (2–5, default 2), sieve one prime
  at a time, primes sieved (0–40), pairs (1e3–5e6, log), show the error
  envelope, seed.
- **Analytic target:** the visible fraction is exactly `1/ζ(2) = 6/π²` =
  **0.6079271018540266**, so `π = √(6/p)` — a second road to π entirely
  independent of the needle tab, with nothing round in the picture. Verified:
  10⁶ random pairs gave `p` = **0.608442** and `π` = **3.14026**. The error
  envelope is the same `√n` bargain: `sd(p) = 0.4882/√N` and `|dπ/dp| = 2.5839`,
  so `sd(π) = 1.2615/√N` — **0.0126 / 0.00399 / 0.00126** at 10⁴ / 10⁵ / 10⁶,
  against a measured error of 0.0013 at a million. For `k` numbers the target
  walks the zeta values: `1/ζ(3)` = **0.8319074**, `1/ζ(4)` = **0.9239384**,
  `1/ζ(5)` = **0.9643873**. Euler's product is the better readout: sieving one
  prime at a time the running product goes **0.750000, 0.666667, 0.640000,
  0.626939, 0.621757, 0.618078, …**, standing at **0.610289** after every prime
  below 50. **Measured** two ways at once — the exactly counted lit fraction of
  the drawn grid, and the running fraction of thrown pairs — both against
  `6/π²`, with `π` recovered from each.
- **The moment:** the sieve overlay. Euler's product is normally a line of
  symbols; here it is a picture going dark one prime at a time with the number
  falling in step beneath it. An infinite product converging, as a picture.
- **Facts:** Ernesto Cesàro proved in 1881 that two random whole numbers share
  no common factor with probability `6/π²`, about 61%. The `π²` comes from the
  Basel problem — Euler showed in 1735 that `1 + 1/4 + 1/9 + 1/16 + …` sums to
  `π²/6`, so both the picture and the constant are downstream of that one sum.
  Ask `k` numbers instead of two and the answer is `1/ζ(k)`.
- **Why it earns its place:** Group 4 currently holds one tab. This is the first
  place in the app where a number-theoretic constant is the thing on screen
  rather than the thing described — and pairing it with `buffon` in the tab
  order stages two independent roads to π as a deliberate echo.

---

## Status

| Tab | id | Group | State |
|---|---|---|---|
| Galton Board | `galton` | randomness | **done** |
| Buffon's Needle | `buffon` | randomness | **done** |
| Chaos Game | `chaos-game` | chaos | planned |
| Monte Carlo π | `montecarlo-pi` | randomness | planned |
| Diffusion-Limited Aggregation | `dla` | randomness | planned |
| Logistic Bifurcation | `bifurcation` | chaos | planned |
| Lorenz Attractor | `lorenz` | chaos | planned |
| Central Limit Machine | `clt` | randomness | planned |
| Random Walks | `random-walk` | randomness | planned |
| Fourier Epicycles | `fourier` | waves | planned |
| Lissajous Figures | `lissajous` | waves | planned |
| Mandelbrot and Julia | `mandelbrot` | chaos | planned |
| Collatz Orbits | `collatz` | numbers | planned |
| The Long Lead | `arcsine` | randomness | planned |
| Two Losing Games | `parrondo` | randomness | planned |
| The Prisoners and the Boxes | `prisoners` | randomness | planned |
| Why Your Bus Is Always Late | `waiting-time` | randomness | planned |
| Compounding | `compounding` | randomness | planned |
| Coupled Oscillators | `kuramoto` | waves | planned |
| The Ising Magnet | `ising` | chaos | planned |
| Visible Stars | `coprime` | numbers | planned |


## Extensions to existing tabs

Two results from the Buffon neighbourhood are stronger as PARAMETERS on the
existing needle tab than as tabs of their own, because each is the same picture
and the same estimator with one thing varied:

- **Buffon's noodle** (Barbier). The expected number of crossings is `2L/(πd)`
  for *any* plane curve of length `L`, not just a straight needle — shape is
  irrelevant. Add a shape control (straight / arc / zigzag / closed loop) and
  the headline estimate should sit still while the shape changes underneath it,
  which is a far better demonstration than a duplicate tab. A circle of diameter
  `d` crosses exactly 2 lines every time, which is the proof in one picture.
- **Buffon–Laplace**. Rule a second set of lines at right angles and the
  crossing probability becomes `(2L(a+b) − L²)/(πab)` for spacings `a` and `b`.
  It roughly halves the variance of the π estimate, so a slider that adds the
  second ruling and visibly tightens the error is a free lesson in variance
  reduction.

## Backlog changes these entries imply

- **`random-walk`** and `arcsine` share a kernel and must not ship adjacent
  without differentiated framing. Gambler's ruin folds into `arcsine` as an
  absorbing-barrier mode; it does not deserve a slot.
- **Poisson process** should *become* `waiting-time` rather than sit beside it.
  The exponential preset is the Poisson process, and here it has a theorem
  attached.
- **Do not build:** Gray-Scott reaction–diffusion (no closed-form target — the
  regimes are labelled regions of a parameter plane, and the one computable
  quantity disagrees with the measurement), Erdős–Kac (the Gaussian appears near
  n ≈ 10¹⁰⁰; any reachable histogram is six lumpy bars under a curve that does
  not fit), the law of the iterated logarithm (a limsup, and the envelope sits
  far above every drawable trajectory, so the animation teaches the opposite of
  the theorem), balls-into-bins (both targets carry explicit `Θ(1)` slop, so
  there is no value to land on), Simpson's paradox (a static table — nothing
  iterates and nothing converges).

## Backlog

Not in v1. Recorded here so ideas leave the current branch.

Birthday problem · Bertrand's paradox · Sierpiński chaos game · percolation
threshold · Poisson process · Benford's law · Monty Hall · sandpile automaton ·
Ulam spiral · continued-fraction convergents · Lorenz attractor · Penrose tiling
