# ADR 0001 — No UI framework

**Status:** accepted · **Date:** 2026-09-07

## Context

`hydrograph_metrics_explorer`, the most developed tool in this account, is React
plus Vite plus TypeScript. Consistency across a personal portfolio has real
value, so departing from it needs a reason.

## Decision

Build `math_playground` in TypeScript and Vite with no UI framework.

## Why

**The UI is small and the canvas is everything.** The entire chrome is a tab bar,
a generated control panel, a fact card, and a readout list. That is a few hundred
lines of DOM. React's value grows with the amount of state-driven UI, and here
there is very little.

**React and `requestAnimationFrame` pull in opposite directions.** Sixty frames a
second of simulation state has to live outside React — in refs, mutated
imperatively — or reconciliation runs 60 times a second for nothing. The result
is a React app whose interesting half deliberately escapes React. That is a
worse codebase to read than one that never set up the tension.

**Zero runtime dependencies is a feature of this particular tool.** It is a
teaching artifact meant to stay working and readable years from now, and every
dependency is a future migration. It also keeps the bundle budget easy to hold.

**`hydrograph_metrics_explorer` is a different kind of program.** It has data
ingestion, a grid editor, worker-backed metrics, and report generation — genuine
application state. Its choice was right for it, and copying that choice here
would be copying the conclusion instead of the reasoning.

## Consequences

- Roughly 400 lines of shell must be hand-written: tab switching, control
  generation, hash routing.
- No component ecosystem. Anything wanted is written or omitted.
- Contributors who know React find no familiar structure. `ARCHITECTURE.md`
  carries more weight as a result.
- Revisit if the app grows genuine cross-tab application state — saved sessions,
  comparison views, user accounts. None of those are in scope for v1.
