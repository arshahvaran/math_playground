# Resilience

What this app was attacked with, what broke, what stops it breaking again, and —
the part that matters most — what is still true that you would rather it were not.

This is the record of one three-round adversarial crash hunt (85 findings, 84
distinct after de-duplication), seven concurrent repair passes, and one
integration pass that re-ran every finding rather than trusting the reports.

## What was attacked

Six attack surfaces, and the count of findings each produced.

| Attack | Findings | What it means |
| --- | ---: | --- |
| `numerical-robustness` | 23 | Does the number on screen mean what the sentence beside it says? |
| `environment-hostility` | 18 | Blocked storage, blackholed fonts, refused canvas contexts, legacy `MediaQueryList`, opaque origins |
| `param-fuzz` | 15 | Every knob at every extreme, and the combinations between them |
| `interaction-fuzz` | 14 | Held keys, non-primary buttons, touch drags off a control, typed entries never confirmed |
| `url-fuzz` | 9 | Mis-cased ids, junk fragments, off-grid values, stale permalinks |
| `resource-stress` | 6 | Two million points, 50,000 particles, a 128² Ising sheet, 8× speed with a held Fast-forward |

By severity: 6 blockers, 47 major, 32 minor.

## What broke

Three families, and they are not equally interesting.

**The verdict was decoration, not a claim.** Thirty-eight findings were
`silent-wrong`, and most of them were one mistake wearing different hats: a
visualization computed its agreement band at the sample count the run would
*finish* on, not the count behind the reading *now*. A band that never moves is
honest on the last frame of a run and absurdly generous on every frame before
it. Monte Carlo π printed **3.36000** under "✓ matches the prediction of
3.14159" — a 6.9 % disagreement certified through a 16 % band. The bus tab
printed 11.76 min under "matches the prediction of 10 min". Parrondo's
acceptance window ran from −2.22 to +0.22 coins around a −1.000 prediction, so
an interval that *contained winning games* was being used to certify that each
game loses. The Galton board's variance row had a tolerance of 424 %. The
prisoners' guessing row had one near 10³⁰, which no finite run could ever
falsify.

**The page could be blank, and say nothing about it.** Ten `blank-canvas`
findings. A blackholed Google Fonts stylesheet — a dropped request, not a
refused one — sat render-blocking above the module script and stopped the app
booting at all: no exception, no console message, no frame ever painted. The
fallback sentence lived in `<noscript>`, which renders only when scripting is
*disabled*, the one failure a modern visitor is least likely to have.
`getContext('2d')` returning null threw out of `activate()` past a teardown that
had already emptied the bench. At 1024–1200 px a grid track collapsed to 0 px
and pushed the plate below the fold.

**Work was unbounded.** Eight `hang` findings. The engine clamped the *clock* at
250 ms and then multiplied it straight back out by the 8× the transport offers —
2,000 ms of simulation, 240 ticks, in a frame that also had to paint. One
Fast-forward press on the chaos game repainted ~818,000 occupancy cells one
`fillRect` at a time and froze the tab for 4.4 s. Holding Fast-forward fired a
fixed burst every 100 ms while one burst cost up to 231 ms, so the main thread
never got an idle slot.

## What defends it now

The standard was prevention, not catching. A `try`/`catch` around a throw hides
a bug; making the bad state unrepresentable removes it. In rough order of how
much they buy:

**One rule of agreement, in one place, that a tab cannot opt out of.**
`src/ui/readouts.ts` owns the verdict. A visualization declares a `Band` —
`sampled`, `absolute`, `relative` or `exact` — and for the `sampled` form it
states the standard deviation of *one* observation and the count in hand; the
ledger does the `σ/√n` division. A tab can no longer declare a constant by
accident, because the division is not its to forget. `MAX_BAND_FRACTION = 0.05`
is the ceiling, and it is read off two measurements rather than chosen by taste:
below the smallest false certification caught (6.9 %) and above the honest
three-sigma band of a correct board (3.87 %). A band wider than the ceiling
produces "still settling" and **does not quote the prediction**, because quoting
it is what turns the sentence into a claim. There is no default band and there
must not be one: a reading that declares none is reported with no verdict
attached.

Two properties fall out and are pinned by tests rather than by second guards.
A band is at most a twentieth of `min(|prediction|, range)`, so a quantity
bounded in [0, 1] can never be certified through a band of 0.74; and a symmetric
band of at most a twentieth of a non-zero prediction cannot reach zero, so
Parrondo's losing game can never be certified by an interval containing a
winning one.

**Refusals are values, not exceptions.** `createStage()` returns `Stage | null`,
so the compiler makes the caller handle what a throw let it ignore. The router's
`HashSource.replace()` returns a boolean, so an opaque origin or WebKit's
100-writes-in-30-s rate limit is a fact the caller acts on rather than an
uncaught `SecurityError`; `navigate()` notifies subscribers directly when the
bar refuses, because a tab must open whether or not the URL can be written.

**One quantiser, called by both layers.** `src/core/grid.ts` holds
`snapToStep(value, min, max, step)`; the router and the control rail both call
it. There were two definitions before, agreeing by coincidence while every step
was a power of ten — and when tabs arrived with steps of 5, 100 and 0.05 on
minima of 0.4 and 500 the coincidence ended silently, running `rho=2.27` while
the fader and the copied link both said something else. The test sweeps the
registry rather than a hand-written list, so a parameter added tomorrow is
covered the day it is added.

**Work is bounded in the unit that costs money.** The engine clamps
`MAX_TICKS_PER_FRAME = 32` — two 60 Hz frames of 8×, so an honest 8× never
touches it — and drops the simulation time it refused rather than owing it to
the next frame. The held Fast-forward measures its own burst and re-arms with
`max(HOLD_REPEAT_MS, spent)`, so the page is idle for at least as long as the
burst was busy, on any tab at any slider position. The chaos game keeps two
bitsets — what the layer carries and what it still owes — so a frame costs the
cells that *changed*, not the cells that exist.

**The page cannot be silently empty.** The font stylesheet is `media="print"`
with an `onload` swap, so a dropped request delays a typeface and nothing else.
A real `<p class="boot-fallback">` sits inside `#app`, styled inline because the
stylesheet may be exactly what is missing, and `main.ts` removes it only once
`createShell()` has returned.

**Boxes are bounded by the row they are in, not by `rem` alone.** `rem` in a
media query is the reader's *default* font size; `rem` in a declaration is the
root's *current* one, so enlarged text grew the rail without moving the
breakpoint that would have stacked it. The rail track is now
`min(var(--rail-w), 45%)`, the ledger's value column `min(11rem, calc(100% -
8ch))`, and the fader's scale row clips its own overflow with a gutter-wide clip
margin — clipped overflow never contributes to the scrollable area, so no label,
at any length or text size, can widen the document.

## Measured, after

Every number below was taken by this integration pass, not copied from a repair
report. Live figures come from a real Chrome driven over CDP, because
`requestAnimationFrame` does not fire in the in-app browser pane (62 frames/s
against 0), which is why several of these could not be checked there at all.

| Property | Before | After |
| --- | --- | --- |
| Check marks beside a reading > 5 % from its prediction | several | **0 of 227**, over 364 predicted rows at every knob extreme × 2 seeds |
| Headlines deliberately driven 5.1–25.2 % off | certified | **20 of 20 refuse to certify** ("still settling" / "within N %") |
| One 250 ms frame at 8× | 240 ticks | **32 ticks**, no debt carried |
| `fastForward(Infinity / NaN / −5)` | unbounded loop | **0 ticks** |
| Chaos game, 20 Fast-forward presses at 2 M points | 634 ms *per press*, 4.4 s freeze | **528 ms total**, worst 164 ms, median **0 ms** |
| Held Fast-forward, 3 s on a 128² Ising sheet | yields every ~390 ms | worst main-thread gap **74 ms**, median 16 ms, **0** gaps > 250 ms |
| Reduced-motion cold start (Lorenz, the worst case) | up to 7 s in one task | worst gap **122 ms**, one gap > 100 ms in 233 frames |
| Console errors, 15 tabs × {360, 768, 1440} px | — | **0**, and 0 document overflow |
| Sideways scroll at 320 px, text at 100 / 150 / 200 % | 139 px / 240 px | **0 / 0 / 0** |
| DLA at 50,000 particles, after 3 presses | one lit pixel | cluster covering **2.16 %** of the plate |
| Bundle, gzipped | — | **84.5 kB** against a 150 kB budget |

Suite: 1,143 tests across 28 files, all passing. No test was weakened to get
there — every deleted assertion was either restated onto the new `band` field,
replaced by a stricter one (the bifurcation λ check moved from 4σ to 3σ), or
removed because it *pinned the bug*: `piStandardError(0) === Infinity`, a
negative doubling time, a period printed as 0, and an Ising assertion whose
regex contained a literal U+0008 where `\b` was meant and which therefore
matched nothing and could not fail.

## The limits that remain

Being reassuring here would waste the pass. These are real.

**The rule catches a band that is too wide. It cannot catch a target that is
wrong.** This is the important one. The orchard tab certified π against a value
its 12×12 grid provably cannot reach — random checks with replacement converge
on *that corner's* exact share, 3.0813, and more data made the check mark
disappear rather than appear. No band rule could have caught that; the repair
was to make the configuration compute its own target. A tab that declares a
confidently wrong analytic constant will still get a confident check mark, and
nothing in `readouts.ts` will notice. The defence is the convergence tests and
the `facts` sourcing, both of which are review, not machinery.

**Five readings can never be certified at any setting the app offers.** They are
honest about it — they read "still settling" for ever — but a row that can never
agree is a row a reader will eventually stop trusting.

- **Parrondo's three gain rows.** Three standard errors inside a twentieth of
  −1.465 needs `players × rounds ≥ 3.6 × 10⁷`; the tab tops out far below that.
- **Galton's variance row.** Needs ~7,200 balls; `MAX_BALLS` is 5,000.
- **Kuramoto's headline at its defaults.** Needs ~2,600 oscillators at K = 3; the
  default crowd is 400. Strong coupling does certify.
- **Arcsine's headline.** Needs ~5,200 games; only the long end of the fader
  reaches it.
- **Prisoners' headline.** Needs ~8,000 rounds; only the long-run chip reaches it.

**DLA's default does not reach its own prediction.** At the shipped 2,000
particles the measured dimension is **1.581 against 1.710 — 7.5 % low** — and the
tab says so honestly ("within 8 % of 1.710", no check mark). But the seed-to-seed
spread at that count is 1.58 to 1.78, about 12 % of the answer, so the default is
a coin toss rather than a measurement. Measured means across three seeds: 1.616
at 700, 1.674 at 2,000, **1.710 at 5,000**, 1.728 at 10,000. Raising the default
to 5,000 would make the opening screen land on its analytic value; it is a
pedagogical default, so it was left for the owner rather than changed here.

**The 5 % ceiling is a judgement.** It is bracketed by two measurements — under
the smallest false certification found, over the honest resolution of a correct
board — but nothing derives it. Widen it and false certifications return; narrow
it and correct tabs stop agreeing. It is the single number the whole honesty
story rests on.

**The reduced-motion settle still hitches.** The worst single hold measured is
122 ms. That is a hundredfold improvement on 7 s and still perceptible, and the
budget is now spread over roughly seventeen tasks rather than one — so a tab that
never settles (Lorenz) still costs about 400 ms of CPU per activation.

**At 320 px the transport deck scrolls sideways.** Six controls with 44 px touch
targets cannot share 288 px of content box at any legal size. The deck scrolls
horizontally there by deliberate choice: a bounded failure (the deck is always
exactly `--deck-h`, nothing is painted outside it) preferred over an unbounded
one (six rows and a 528 px deck at 200 % text). At 360 px and above nothing
scrolls.

**Browser storage is per-viewer and may simply not work.** The expert table's
open/closed state is held in module scope with storage as a mirror, so an origin
where reads succeed and writes throw no longer re-opens the table on every tab
change — verified live. But nothing about that state survives a different
browser, a private window, or cleared site data, and it never should be relied on.

**The watchdog that stops a finished run counts frames, not seconds.** After 120
frames in which no emitted value changed, the loop stops and the indicator goes
out; a knob puts it back, and a pause the reader asked for survives one. Every
shipped tab moves a reading several times a second, so none can trip it mid-run.
A future tab whose only reading updates less often than once every two seconds
would be stopped early — the honest fix there is for the tab to emit something
that moves, which the project's own rules already require.

**The crash ledger this pass was checked against carried no reproductions.**
`crashes.json` has `key`, `kind`, `severity`, `title`, `file`, `attack` and
`round` — the `repro`, `observed`, `cause` and `prevention` fields were absent
from all 85 entries. Every reproduction here was reconstructed from the title and
the named file. The titles are precise enough that this was tractable, and it is
worth saying plainly that it was reconstruction rather than replay.
