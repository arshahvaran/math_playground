---
name: verify-visualization
description: Check a math_playground visualization against the six-point Definition of Done — convergence, determinism, performance, accessibility, sourcing, and permalinks. Use before opening a PR for any tab, or when asked whether a visualization is finished.
---

# Verifying a visualization

Six criteria. Five of six is not done. Report measured numbers, not adjectives.

## 1. Converges

Run the fixed-seed test. The measured value must reach the analytic target within
the stated tolerance.

Derive the tolerance from theory rather than from whatever the run produced. For
`N` Monte Carlo trials the standard error goes as `1/√N`; a tolerance far tighter
than that is a test that will fail randomly in CI, and one far looser is a test
that would pass on a broken simulation.

Record: seed, parameters, trial count, measured, expected, tolerance.

## 2. Deterministic

- `grep -rn "Math.random" src/viz/` returns nothing.
- Same seed and parameters, twice, produce identical readouts.
- Reloading a permalink reproduces the run.

## 3. Fast

Measure frame time at **maximum** slider values, not defaults. Budget is 16 ms
(55+ fps). Use the browser profiler and record the number in the PR.

If it is over budget, check in this order: static geometry on the wrong layer,
per-particle style changes, allocation inside `step()`.

## 4. Reachable

- Every control is keyboard-operable and labelled.
- Every number on the canvas also appears in the readouts via `emit()`.
- With `prefers-reduced-motion: reduce` the tab does not autoplay and offers step
  and fast-forward instead.
- Text and canvas foreground meet 4.5:1 contrast against their background.

## 5. Sourced

Every `Fact` has a source. Check the claim, not just the presence of a citation —
these are the parts of the app most likely to be quoted.

## 6. Shareable

Change several parameters, copy the URL, open it in a fresh tab. The controls
must restore and the run must be identical.

## Reporting

> `buffon` — 10,000 drops, seed 42, ℓ/d = 0.8. π estimate 3.1387 against 3.14159,
> error 0.0029, tolerance 0.02 (2σ at n=10⁴). Deterministic across two runs.
> 58 fps at 500 needles/s. Keyboard and reduced-motion paths verified.
> Both facts sourced.

Not: "Buffon's needle is working well."
