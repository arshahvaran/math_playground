# Development Workflow

How work on this repository is planned, executed, and verified. Read this before
starting a phase. It is the process; `ARCHITECTURE.md` is the design.

## Where this came from

Four sources shaped this process. Each contributed something specific, and the
attribution matters because it tells you which parts are negotiable.

| Source | What it contributed |
|---|---|
| Anthropic — *The New Rules of Context Engineering for Claude 5 Generation Models* | Progressive disclosure over front-loading. Expressive interfaces over worked examples. A thin `CLAUDE.md` carrying gotchas, not a tour of the file tree. |
| [obra/superpowers](https://github.com/obra/superpowers) | Phase discipline, small task sizing, two-stage review, and the rule that a claim of completion requires evidence. |
| [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) | Pedagogical ordering over alphabetical. Guided tours (here: Story mode). Adjustable explanation depth. |
| [disler/fixing-smartass-opus-5](https://github.com/disler/fixing-smartass-opus-5) | Communication discipline: state a fact once, no speculative architecture, stay inside the requested scope. |

## Operating principles

1. **Evidence over claims.** "The Galton board works" is not a status. "10,000 balls,
   12 rows, seed 42, sample mean 6.01 against a theoretical 6.00, 58 fps" is a status.
   Every visualization converges to a value we can check in closed form. Check it.
2. **Simplicity is the deliverable.** This is a teaching tool. A clever
   implementation nobody can read is a defect, not a flourish.
3. **The contract absorbs the variation.** If a visualization needs the shell
   changed, that is a signal the contract in `src/core/types.ts` is wrong. Fix the
   contract rather than special-casing the shell.
4. **Stay in scope.** Build the phase you are in. Ideas for later phases go to
   `docs/VISUALIZATIONS.md` as backlog entries, not into the current branch.
5. **Determinism is not optional.** Every run is reproducible from `seed` plus
   parameters, because a permalink that renders something different for the
   recipient is a broken permalink.

## Phases

Each phase has an exit criterion that is checkable by someone else. A phase is
not finished because the work feels finished.

### Phase 0 — Scaffold *(complete)*

Repository, contract, build, CI, documentation. No visualizations.

**Exit:** `npm run build` and `npm test` are green; Pages serves the placeholder;
`src/core/types.ts` defines the full `Viz` contract.

### Phase 1 — Engine and first vertical slice

The shell plus exactly one visualization: the Galton board. One visualization
built against the real shell surfaces contract mistakes that ten planned
visualizations on paper never will.

Deliverables: `core/canvas.ts`, `core/stats.ts`, `core/router.ts`, `ui/shell.ts`,
`ui/controls.ts`, `ui/facts.ts`, `ui/presets.ts`, `ui/theme.css`, `viz/galton/`.

**Exit:**
- Control panel is generated entirely from `ParamSpec[]`. Zero hand-written
  per-visualization UI.
- Galton board with `rows = 12`, `p = 0.5`, 20,000 balls lands within 1% of the
  binomial mean `n·p` and variance `n·p·(1−p)`, asserted in a test with a fixed seed.
- A permalink round-trips: copy the URL, open it cold, get a pixel-identical run.
- 55 fps or better at maximum slider values, measured and written down.

### Phase 2 — Breadth

The remaining visualizations, one per branch, in the order given in
`docs/VISUALIZATIONS.md`. Each is independently reviewable and independently
revertable. No phase-2 branch may modify `src/core/` without saying why in the PR.

**Exit:** every catalogued visualization meets the Definition of Done below.

### Phase 3 — Polish

Accessibility pass, reduced-motion paths, mobile layout, Story mode captions,
fact sourcing, performance budget enforcement.

**Exit:** keyboard-only operation of every tab; no fact without a source;
bundle under 150 KB gzipped.

### Phase 4 — Release

`v1.0.0` tag, `CITATION.cff`, README recordings, social preview image.

## The unit of work

One visualization. Not one file, not one sprint.

Inside a visualization, tasks are sized at **2–5 minutes** and name exact paths:

> Add `src/viz/buffon/geometry.ts` exporting `crossesLine(x, angle, length, spacing): boolean`.
> Verify with `npx vitest run tests/buffon.test.ts`.

Sizing tasks this way means a failed task is cheap to discard. A task that cannot
be described in one sentence with a path in it is not yet decomposed.

## Definition of Done

A visualization is done when all six hold. Five of six is not done.

1. **Converges.** A fixed-seed test asserts the simulation approaches its analytic
   value within a stated tolerance. π to two decimals for Buffon; `n·p` for Galton;
   `√n` growth for the random walk envelope.
2. **Deterministic.** Same seed and parameters produce byte-identical readouts on
   two consecutive runs. No `Math.random()` anywhere in `src/viz/`.
3. **Fast.** 55 fps minimum at maximum slider values on a mid-range laptop, with
   the number recorded in the PR.
4. **Reachable.** Every control is keyboard-operable and labelled; every number
   shown on the canvas also exists as text via `emit()`; a reduced-motion path
   exists that does not animate.
5. **Sourced.** Every entry in `facts` carries a citation.
6. **Shareable.** The permalink round-trips.

## Review

Two passes, in this order, because they fail differently:

- **Pass 1 — Specification.** Does it do what `docs/VISUALIZATIONS.md` says, and
  does it satisfy the Definition of Done? Verified against the checklist, not by reading.
- **Pass 2 — Quality.** Is it readable, is it consistent with neighbouring
  visualizations, does it leak state or listeners on tab switch?

Findings are reported by severity. A pass-1 failure blocks the merge; a pass-2
finding may be filed as follow-up if it is cosmetic.

## Conventions

- **Commits:** Conventional Commits. `feat(buffon): estimate pi from crossing fraction`.
- **Branches:** `phase-2/buffon-needle`.
- **Never rename a `Viz.id`.** It is in permalinks that people have shared.
- **Never sort the registry alphabetically.** Its order is the teaching order.

## Agent-assisted work

This repository is built with agent assistance, so the process is shaped for it:

- `CLAUDE.md` stays under roughly 60 lines and holds only what cannot be deduced
  from the code. Anything longer belongs in `docs/` or a skill.
- Repeatable procedures live in `.claude/skills/` and load only when relevant —
  `add-visualization` for building one, `verify-visualization` for checking one.
- The `ParamSpec` discriminated union is deliberately expressive so that the type
  system, rather than a page of examples, communicates how to use it. Adding a
  control kind produces a compile error at every site that must handle it.
