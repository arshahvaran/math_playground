# Design system — Linen Bench

The visual system for Math Playground. It is written so that every screen can be
built from it without a follow-up question: the tokens, the type, the layout at
four widths, every component with its states and its ARIA, the motion budget,
the rules the canvas code must obey so the data stays legible, and the contract
the shell must honour. `src/ui/theme.css` implements it verbatim; class names
below are the class names there.

**This is revision 3.** Nothing in this document is a suggestion; everything
stated as a rule is either implemented in `theme.css` or listed in §8 as a
required contract change.

Contents: [What changed and why](#what-changed-and-why) · [Concept](#1-concept)
· [Typography](#2-typography) · [Color](#3-color) · [Layout](#4-layout)
· [Components](#5-components) · [Motion](#6-motion)
· [Canvas conventions](#7-canvas-conventions) · [Shell contract](#8-shell-contract)
· [Accessibility conformance](#9-accessibility-conformance)
· [Known costs](#10-known-costs) · [Do not](#11-do-not)

---

## What changed and why

Revision 2 was called "Plotter Bench" and it was, in the owner's words, a page
that "looks like Windows 98". It was right about that, and its own §1 predicted
it: depth was carried entirely by a 1.20:1 ground step and 1 px seams at ~2:1,
every radius was zero, spacing was tight, and the primary action was a flat
vermilion rectangle. A machined lattice of hairlines rendered as one flat grey
slab with sharp corners — which is exactly what a 1998 control panel is.

The diagnosis is not "it needed rounded corners". It is that **one device was
being asked to do the work of four**. Revision 3 inverts that:

| | Revision 2 | Revision 3 |
|---|---|---|
| Depth | a value step, plus 1 px seams | a hairline **ring** + a layered tinted **shadow** + a real **radius scale** + **air** |
| Ground step, page → panel | 1.20:1 | **1.08:1** |
| Ground step, page → plate | 1.16:1 | **1.19:1** |
| Between panels | `gap: 1px` on `--line` | **24 px** of page ground |
| Radius | `--radius-0: 0` everywhere | **5 / 8 / 11 / 16 / 22**, with nested-radius arithmetic |
| Shadows | none, by rule | two regimes, warm-tinted, negative spread on every blurred layer |
| Visible hairlines per screen | the whole lattice — ~30 | **three** |
| Press feedback | `steps(1, start)` full ink inversion | a 90 ms wash plus a 1 px depress |
| Motion tokens | 2 durations, 2 curves | 5 durations by scope, 4 eases by intent, 1 reserved overshoot |

The grounds got **closer together** and the page reads far more layered. That is
the whole point: Linear ships 1.02–1.06:1 steps and reads layered; revision 2
read flat because a 1 px seam was the only device in it.

### The ground

`--surface` moves from `#D6DDD8` to **`#E8ECEF`** — hsl(206 20% 93%), a pale
cold-pressed linen with real chroma. Two reasons, and both are measurable.

1. `#D6DDD8` sits at Radix sage step 5, which is a **border** value being used as
   a page. Every contemporary tool puts the page at 92–100% lightness. This is
   the single change the owner will see first.
2. The hue is chosen as the optical complement of the vermilion's 32°, so the one
   signal colour reaches maximum apparent saturation against the chrome instead
   of blending into it. A warm cream ground — the reflex answer when a design is
   told to stop being cold and grey — would put ground and accent in the same
   hue family, which is precisely what makes that look soft. It is also on this
   document's own §11 do-not list.

Side effect that pays for the change on its own: vermilion goes from 3.48:1 to
**4.04:1** on the page ground, so the signal colour is easier to see, not harder,
and it now clears 3:1 as a focus ring on every plane including the sunken trough
(3.66:1).

Shadows are tinted `rgb(23 40 54)` = hsl(207 40% 15%) — one step deeper than the
ground and adjacent to it in hue, **never `rgb(0 0 0)`**: black layered over a
chromatic ground desaturates it and goes dusty.

### The bug the redesign had to fix

`@property --err` was declared `inherits: false`. The shell writes `--err` on
`.hero` and the stylesheet reads it on `.hero__needle`, a **descendant** — so the
needle computed the initial value `0.5` for every reading in every tab. Dead
centre on a null meter is the one position that means *this agrees with theory*.
The instrument at the intellectual heart of the tool was welded to a convergence
claim nothing had been tested for.

One word — `inherits: true` — unpins it. Verified in the running app: with a real
reading the needle now computes `--err: 0.176538` and sits well left of centre.
Because a registered custom property is animatable, the needle also stopped
animating `left` (which laid out every frame) and now interpolates the number
while a `translate` moves it.

### What did not change

Everything on the keep list, and it is all load-bearing in the new scheme:
Archivo for words with its width axis as a real density instrument, Martian Mono
for every measurement, tabular figures throughout, the vermilion `#D53619`, the
three CVD-validated pens on a white plate, the peg-row tab strip where the peg
swells into the ball, and the Measured / Analytic / Error ledger.

**The white plate never changes value in either scheme**, so §7's canvas contract
and its CVD validation (adjacent-pair separation dE 18.7 protan, dE 24.4 normal
vision, every pen ≥ 3:1 on the plate) carry over with nothing to re-run.

---

## 1. Concept

The page is a sheet of pale cold-pressed linen holding a white plotter bed that
floats on layered, blue-black shadow. A pen plotter draws with a fixed rack of
pens, so the data palette is literally three pens: a **vermilion signal pen** for
whatever is live and random (the balls, the walkers, the current estimate), a
**blue-black drafting pen** for whatever is analytic (the fitted Gaussian, the π
line, the bifurcation envelope), and a **graphite pen** for areas (histogram
silhouettes and their wash, envelopes).

Every quantity a person can turn is a fader with a filled channel and a carriage.
Every quantity the instrument measures sits in a white display window or a ruled
ledger next to its analytic target and its error, the way a bench meter shows
reading, reference and tolerance. That is why the language fits a mathematics
playground: an instrument makes *measurement and convergence* the visible
subject. "Playful" is the vermilion streaming across the bed; "rigorous" is the
tabular numerals and the error column that never lies.

**There are exactly three elevated objects on the page**: the plate, the rail
panel, and the fact card. The sections inside the figure column — head, caption,
readouts, story — have no container fill, no ring and no shadow at all. They are
ruled bands separated by 24 px of ground. This restraint is deliberate and it is
what keeps the redesign from turning into a grid of rounded cards, which would be
the same mistake revision 2 made with seams, in a softer coat.

Four signature details carry the identity at thumbnail scale:

1. **The filled fader.** A 14 px channel with a vermilion filled portion and a
   20 × 12 white **carriage** riding in it, with the vermilion index line painted
   into the carriage. The carriage is not a circle, which leaves exactly **one
   circle in the whole system** — the Galton ball on the active tab.
2. **Display windows, the null meter, and the ledger.** Every measured number is
   Martian Mono, tabular, in a white 8 px-radius window or in a ledger with
   Measured / Analytic / Error columns under a sunken head band. The headline
   quantity is a 40 px hero numeral beside its analytic target, over a
   **galvanometer band** whose needle rests dead centre when the reading agrees
   with theory — and which now actually moves.
3. **The peg-row tab strip.** A sunken trough holding pill tabs; each carries a
   small peg on its bottom edge, and on the active tab the peg turns vermilion
   and swells into the ball over 200 ms on `--ease-settle`. That curve — the one
   restrained overshoot in the file — is used here and nowhere else.
4. **The plotter bed.** A white plate with a 16 px margin, a 16 px radius, four
   12 px registration marks painted in CSS, and a four-layer cast. Always the
   brightest surface on the page.

The null meter replaces a hero delta chip on purpose. A big number next to a
comparison value next to a colour-coded signed delta in parentheses is the KPI
tile of every generated dashboard with the radius zeroed; a needle that walks off
centre as an estimate diverges is an instrument.

---

## 2. Typography

Two families, both variable, both from Google Fonts. Hierarchy comes from width
and weight, not from 400-versus-600.

| Role | Family | Axes requested | Notes |
|---|---|---|---|
| Display and body | **Archivo** | wdth 87–125, wght 400–800, italic 400 @ wdth 100 | Every word in the interface. Never uppercase, never tracked. |
| Numerals and measurement | **Martian Mono** | wdth 87.5–100, wght 300–500 | Every digit that is a measurement. |

### The `font:` shorthand is banned

`font:` resets `font-variant-numeric` **and** `font-stretch` to `normal`, which
silently kills tabular figures and the width axis. Every rule in `theme.css` uses
longhands, and `font-variant-numeric: var(--num)` is declared on `body` **after**
the font longhands. The single surviving shorthand is the form-control reset
`font: inherit`, immediately followed by `font-variant-numeric: inherit`.

`--num` is `tabular-nums lining-nums slashed-zero`.

### The width axis is the density instrument

Uppercase-plus-tracking applied uniformly to every label is both a 2015 dashboard
tell and a generated-interface tell. It is not used anywhere. Dense labels — tab
labels, key labels, control labels, group labels, ledger column heads — are
sentence case at **`font-stretch: 92%`**. The visualization title is 96%; the
wordmark is 125%; body and prose are 100%.

This is the one typographic move in the system that an Inter-based interface
literally cannot perform, and it costs nothing: `index.html` already requests
Archivo's `wdth` axis at 87..125. **Trimming that axis range to shrink the font
payload would silently snap every label to 100% with no error anywhere.** There
is a comment beside the `<link>` saying so.

Weights are intermediate variable values rather than 400/500/600/700:

| Token | Value | Used for |
|---|---|---|
| `--wght-body` | 420 | body, blurb, help |
| `--wght-ui` | 460 | UI text, tab labels, key labels, readout labels |
| `--wght-label` | 560 | control labels, ledger column heads, "Figure n." |
| `--wght-title` | 620 | section titles |
| `--wght-display` | 700 | the visualization title |

### Sizes are rem

The scale is rem against the browser default, so a reader who sets a 20 px root
gets the whole bench at 20 px. Only machined geometry stays in px: the fader's
channel, carriage, index line and graduations, the plate margin and registration
marks, and the sub-pixel bevel.

| Token (px at a 16 px root) | Face | Weight · width | Used for |
|---|---|---|---|
| `--t-11` 11 / 16 | Archivo | 560 · 92 | Ledger column heads. Nothing else is this small. |
| `--t-11` 11 / 16 | Martian Mono | 500 · 87.5 | Fader scale numerals; in-canvas labels at wdth 100 (`--canvas-label-font`) |
| `--t-12` 12 / 18 | Martian Mono | 400 · 87.5 | Analytic column, error column, fact source, footer meta |
| `--t-13` 13 / 20 | Archivo | 460 · 92 | Tab labels, key labels, "Copy permalink", speed picker |
| `--t-13` 13 / 20 | Archivo | 560 · 92 | Control labels |
| `--t-13` 13 / 20 | Martian Mono | 500 · 100 | Windows: fader values, stepper, seed, story-step numerals |
| `--t-14` 14 / 22 | Archivo | 420 · 100 | **Control help** and readout labels — was 12 px |
| `--t-15` 15 / 24 | Martian Mono | 500 · 100 | Ledger measured values |
| `--t-16` 16 / 26 | Archivo | 420 · 100 | Body: blurb, story caption, sources |
| `--t-18` 18 / 26 | Archivo | 460 · 100 | Fact text (it is the heading); wordmark at 800 · 125 |
| `--t-20` 20 / 27 | Archivo | 620 · 100, −0.011em | Story step label, Sources title |
| `--title-size` clamp(30, 1.2rem + 2.4vw, 42) / 1.1 | Archivo | 700 · 96, −0.021em | The visualization title |
| `--t-hero` 40 / 44 | Martian Mono | 500 (measured) and 300 (analytic) | Hero numeral pair; 32 / 36 below 600 px |

**Help text got bigger, not smaller.** 12 → 14 px. This is a teaching tool; the
sentence explaining what a parameter does is content, not a footnote. The fix for
"this is secondary" is a quieter colour, never a smaller size.

`clamp()` appears **exactly once** in the whole stylesheet, on the title.
`text-wrap: balance` appears exactly once, on the same element. The prose measure
is 68ch and applies to two elements — the blurb and the story caption — never as
a universal wrapper. The three are deliberately not deployed as a set.

### Measurements

Every mono run carries `letter-spacing: var(--tracking-mono)` = **−0.04em**.
Martian Mono is unusually wide; without this the ledger's three `ch`-reserved
columns sprawl and force the rail wider than it needs to be.

Variables and Greek letters (`n`, `p`, `π`, `μ`, `σ`) are Archivo italic 420
through `<var>` (or `.var`) wherever the shell composes text. `ParamSpec.label`
and `Readout.label` are plain strings and stay upright.

**The minus sign.** Prose uses U+2212 in Archivo. Mono cells use U+2212 only if
it is metric-compatible in Martian Mono; the shell decides once at startup with
`ctx.measureText('−').width === ctx.measureText('0').width` and uses U+002D
otherwise.

### Link tags for `index.html`

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,87..125,400..800;1,100,400&family=Martian+Mono:wdth,wght@87.5..100,300..500&display=swap" rel="stylesheet">
```

Fallbacks: `"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif` and
`"Martian Mono", ui-monospace, "Cascadia Mono", Consolas, monospace`. No
`@import` anywhere in CSS.

---

## 3. Color

### How the two schemes are written

**Every scheme-varying token is a `light-dark()` pair written once.** There is no
duplicated dark block, and therefore no class of bug where the two schemes drift
apart. `:root` declares `color-scheme: light dark`, so a reader arriving from an
OS in dark mode gets the dark scheme on first paint; the masthead toggle writes
`data-theme` on `<html>` and `:root[data-theme="dark"] { color-scheme: dark }` /
`[data-theme="light"] { color-scheme: light }` make it win in both directions.

The shadow ladder varies by scheme through its **colour** tokens
(`--ring-c`, `--shade-1…5`, `--lift`), not through duplicated geometry. `--lift`
— the inset white top highlight a dark plane needs because a drop shadow does
almost nothing on a near-black ground — is fully `transparent` in light, so one
shadow string serves both schemes.

### RULE 0 — the canvas contract stays literal hex

`core/canvas.ts` reads the thirteen properties named in `CANVAS_THEME_VARS` with
`getComputedStyle` and hands them to `ctx.fillStyle`. **An unregistered custom
property is not resolved at computed-value time**, so a `light-dark()` or a
`color-mix()` there arrives at the canvas as the literal string
`light-dark(#…, #…)` and paints nothing. Verified in the running app.

They are therefore **pinned as literal hex on `.plate`, unconditionally, in both
schemes** — not restated under `[data-theme="dark"]`. Same computed result, one
fewer conditional, and the pens are scheme-independent *by construction* rather
than by a restatement someone has to remember. `color-mix()` and `light-dark()`
are for chrome only.

`light-dark()` nested inside `color-mix()` is also avoided: one resolves at
used-value time and the other at computed-value time, and a wash that silently
produces nothing is every hover state in the file. The washes are written as
`light-dark()` pairs of the ink at alpha.

### Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--surface` | `#E8ECEF` | `#15181B` | Page ground: masthead, bench gutter, footer |
| `--surface-raised` | `#F1F5F8` | `#1E2225` | Rail panel, fact card, the active tab pill |
| `--surface-sunk` | `#DDE1E5` | `#0C0F11` | Tab trough, fader channel, ledger head band, transport |
| `--canvas` | `#FFFFFF` | `#FFFFFF` | The plotter bed and every display window |
| `--mat` | `transparent` | `#282D30` | The bezel that mats the plate at night |
| `--ink` | `#14181B` | `#EEF2F4` | Body, headings, labels, key labels |
| `--ink-muted` | `#4D585F` | `#B0BABF` | Blurb, control help, sources, ledger heads |
| `--ink-soft` | `#5E696F` | `#939EA3` | Captions, footer meta, scale numerals, disabled |
| `--stroke` / `--tick` | `#737E85` | `#818C92` | Control boundaries; graduations and inactive pegs |
| `--line` | `#D2D9DE` | `#333A3E` | **Decorative only.** Budget: three per screen |
| `--accent` | `#D53619` | `#EF5B33` | The signal colour (see the rubrication rule) |
| `--accent-hover` | `#BD2F16` | `#F7714B` | |
| `--accent-press` | `#A72913` | `#D94E26` | Also the primary key's own ring |
| `--accent-ink` | `#FFFFFF` | `#17110D` | Text on the accent — **it flips in dark** |
| `--accent-text` | `#B8300F` | `#EF5B33` | The one legal accent-coloured text token |
| `--agree` | `#24467A` | `#8FB4E8` | A reading that matches its reference |
| `--focus-line` | `#14181B` | `#FFFFFF` | The 2 px focus outline |
| `--focus-window` | `#D53619` | `#D53619` | Ring and halo for controls with a **white** face |
| `--window-ink` / `--window-ink-muted` | `#171B1D` / `#4E5750` | unchanged | Text inside white windows and the hero |
| `--window-stroke` / `--window-stroke-hover` | `#657069` / `#171B1D` | unchanged | Boundaries **on white** — resting and hover |
| `--window-agree` | `#24467A` | unchanged | Agreement inside a white window |
| `--data-1` | `#D53619` | pinned | Signal pen: particles, walkers, needles, the live estimate |
| `--data-2` | `#24467A` | pinned | Drafting pen: analytic overlays **and every thin mark** |
| `--data-3` | `#7F8985` | pinned | Graphite pen: area **silhouettes** at full opacity |
| `--data-3-fill` | `#D2D6D4` | pinned | Graphite wash: area **fills**, opaque — never `globalAlpha` |
| `--grid` | `#23292B` | pinned | The experiment's own geometry: pegs, needles, ruled lines |
| `--grid-soft` | `#8A938F` | pinned | Containers: bin dividers, axes, floors, frames, reg marks |

### Three ink tiers, not two

Revision 2 asked `--ink-muted` to carry the blurb, the help text, the captions,
the footer meta **and** the ledger heads, which flattened exactly the hierarchy
it wanted. `--ink-soft` is the third, quieter voice.

`--ink-soft` is AA on `--surface` (4.74) and `--surface-raised` (5.14). On
`--surface-sunk` it measures 4.29 and the only thing it colours there is a
disabled transport key, which SC 1.4.3 exempts as an inactive component. **Nothing
else may use it on the sunk ground.** The ledger's head band is sunk, so its
column heads take `--ink-muted` at 5.55.

### Rubrication rule

Vermilion is spent only on what is current or moving: particles and the live
estimate on the plate (`--data-1`), the Play/Pause key, the ball on the active
tab, the filled portion of the fader and its index line, the current story step,
the transport's ring while the simulation runs, and the focus halo. It never
colours links, static borders, or text on the grey grounds. The only
accent-coloured **text** is `--accent-ink` on `--accent` and `--accent-text`.

### Contrast (WCAG 2.x relative luminance; every value computed, none eyeballed)

**Ground steps.** Deliberately small, because ring + shadow + radius + air carry
the depth now.

| Step | Light | Dark |
|---|---|---|
| page → raised | 1.08 | 1.11 |
| raised → plate | **1.10** | 16.02 |
| page → plate | 1.19 | 17.82 |
| page → sunk | 1.11 | 1.08 |
| mat → plate | — | **13.92** |

**The plate is the brightest surface on the page and must stay so.** The floor is
`raised → plate ≥ 1.09:1`; it currently measures 1.10. This is written down as a
tripwire because it is an easy constraint to lose: two competing proposals for
this revision independently drifted the panel to 1.03:1 from the plate, at which
point the panel and the bed are the same colour and the one property the canvas
contract exists to protect is gone.

**Text, light** (measured off the rendered DOM, not from the token table):

| Pair | Ratio |
|---|---|
| Title / page | 15.03 |
| Blurb, sources / page | 6.14 |
| Caption, footer meta, "no target" cells / page | 4.74 |
| Control label, fact text, key label / panel | 16.29 |
| Control help / panel | 6.66 |
| Fader scale numerals, fact source / panel | 5.14 |
| Ledger column heads / head band | 5.55 |
| Inactive tab label / trough | 5.55 |
| Active tab label / pill | 16.29 |
| Readout label and value / page | 15.03 |
| Hero meta / white window | 7.49 |
| Window and select ink / white | 17.34 |
| `--accent-ink` on `--accent` / `--accent-hover` / `--accent-press` | 4.80 / 5.86 / 7.07 |

**Text, dark:**

| Pair | Ratio |
|---|---|
| Title / page | 15.82 |
| Blurb, story step / page | 9.01 |
| Caption / page | 6.50 |
| Control label, fact text, active tab / panel | 14.22 |
| Control help / panel | 8.10 |
| Fader scale numerals / panel | 5.84 |
| Ledger heads, inactive tab / band, trough | 9.73 |
| Window and select ink / white | 17.34 |
| `--accent-ink` `#17110D` on `--accent` | **5.54** |

**Why the dark primary key flips its ink.** White on `#EF5B33` is 3.38:1 and
**fails** AA as text. Near-black on it is 5.54:1. That flip is the difference
between a designed dark scheme and an inverted light one.

**Non-text (SC 1.4.11), light:**

| Pair | on page | on raised | on sunk | on canvas |
|---|---|---|---|---|
| `--stroke` / `--tick` | 3.50 | 3.79 | **3.16** | 4.16 |
| `--accent` as a mark (ball, index line, fader fill) | 4.04 | 4.38 | 3.66 | 4.80 |
| `--focus-line` (the 2 px outline) | 15.03 | 16.29 | 13.58 | 17.85 |
| `--focus-line` on `--accent` (the primary key) | 3.72 | | | |
| `--line` (a rule) | 1.20 | 1.30 | decorative, exempt | |

`--stroke` on `--surface-sunk` is a pass by 0.16. `--surface-sunk` is used for
exactly four things — the tab trough, the fader channel, the ledger head band and
the transport group — and nothing may be added to that list without recomputing.

**Non-text, dark:** `--stroke` 5.18 / 4.65 / 5.59 and 3.44 on a white window;
`--accent` 5.27 / 4.74 / 5.69 and **3.38 on a white window**, so the chrome
accent is still a conformant ring out on the plate; `--focus-line` (white) 3.38
on `--accent`. The switch's ON fill measures 4.74 against the panel.

**One focus construction, no per-context variant.** A 2 px `--focus-line` outline
at 2 px offset inside a 5 px vermilion halo. `--ink` clears 3:1 on every ground
*and* on the vermilion fill itself, which deletes the "ring on accent" special
case revision 2 needed — an all-vermilion outline is invisible on a vermilion key
by construction. Controls with a white face (`.window`, `.select`) take
`--focus-window` `#D53619` for their ring and halo instead, 4.80:1 on white in
both schemes: the same architecture the `--window-*` family already establishes,
applied to focus.

### The `--window-*` tokens exist because the plate does not invert

The plate and every display window stay `#FFFFFF` in both schemes, so anything
painting onto them uses `--window-*`, never `--ink` / `--stroke`. This is what
made revision 1's dark hover states vanish. In dark, the plate is matted in a
`#282D30` bezel drawn as a spread-only shadow layer, which takes the local step
from 17.82:1 down to 13.92:1 and turns a glare cliff into a framed sheet. The
plate is never dimmed and never filtered — that would break §7.

---

## 4. Layout

### Page anatomy

```
.page                         grid rows: masthead / tabs / bench / footer, on --surface
  header.masthead             56 px, wordmark · credit · Source · scheme toggle
  nav.tabs                    grid: sunken peg-strip trough + pinned index
  main.bench                  grid: minmax(0,1fr) + --rail-w, gap 24 px of ground
    div.figure                flex column, gap 24 px, NO fill, NO ring, NO shadow
      header.figure__head     title + blurb (one row >= 1024 px)
      div.plate               ELEVATED: white bed, 16 px radius, reg marks, --e-plate
      p.caption               "Figure n." sentence + Copy permalink
      section.readouts        .hero window (capped) + .ledger-wrap > .ledger
      section.story           tape + label + caption
      section.fact            ELEVATED: fact as heading + source + Another fact
    div.rail                  container-type: inline-size
      div.rail__panel         ELEVATED: sticky, 20 px padding, radius 16, --e-2
        div.transport         a 5 px-padded sunken group holding 44 px keys
        form.controls         one .control row per ParamSpec, 20 px apart
  footer.footer               Sources list + meta + shortcuts switch
```

**No panel carries a border and no container is a `gap: 1px` lattice.** Depth is
`box-shadow: var(--ring), var(--e-N)`. Boundaries are drawn as **outer rings**
(`0 0 0 1px`), which compose with elevation in one declaration and can thicken on
hover with zero layout shift — the thing `border: 1px solid` could not do, and
the reason revision 2's hover states had to be colour-only and felt dead.

`inset` box-shadow survives in exactly three places: the fader's channel well,
the tab trough, and the transport group.

### Elevation

Two regimes, one light source (zero horizontal offset, vertical ≈ half the blur),
negative spread on every blurred layer over 4 px so the penumbra is narrower than
the box.

| Token | Strength | Used for |
|---|---|---|
| `--e-1` | 5–8% | display windows, chips, resting keys, the active tab pill |
| `--e-2` | 5–10% | rail panel, fact card |
| `--e-3` | 5–13% | the select picker, popovers |
| `--e-float` | 10–16% | the handheld transport deck |
| `--e-plate` | inset hairline + mat + 8–16% out to 40 px | the plate |
| `--e-hover` | one **added** layer, 13% | hover — it adds, it does not swap |
| `--bevel` | sub-pixel inset, ±16–22% | the primary key and the fader carriage **only** |

A shadow beside a bright white bed needs 3–5× the alpha a card on a grey page
needs; a 5% shadow next to the plate is invisible, which is part of how revision
2 ended up flat. That is what `--e-float` is for.

### Geometry

Five radius steps, non-power-of-two so they cannot be mistaken for a framework
default, with real nested-radius arithmetic (outer = inner + padding):

| Token | Value | Used for |
|---|---|---|
| `--radius-1` | 5px | unit chips, small marks |
| `--radius-2` | 8px | display window, number input, story step, ledger head band |
| `--radius-3` | 11px | key, select, transport key, tab pill |
| `--radius-4` | 16px | rail panel, fact card, plate, tab trough, transport group |
| `--radius-5` | 22px | the handheld transport deck |
| `--radius-pill` | 999px | fader channel, switch track |
| `--radius-thumb` | 50% | the tab ball — the only circle in the system |

The three joins that actually occur are concentric by construction:
tab trough 16 − 5 padding = 11 tab · transport group 16 − 5 = 11 key ·
stepper group 11 − 3 = 8 window.

Where the arithmetic would drive an inner radius below 4 px — the rail panel is
16 with 20 px padding — the inner element gets **no radius at all**. Control rows
are separated by space, not boxed. That is a feature: it is what stops the rail
becoming a stack of nested cards.

### Keeping the readouts above the fold

Measured in the running app at 1024 × 800 on a landscape visualization:

| Item | Revision 2 | Revision 3 |
|---|---|---|
| masthead | 48 | 56 |
| tab row | 44 | 80 (a 48 px trough with 12/20 padding) |
| `.figure__head` | ~100 | 97 (blurb on the title's row from **1024 px**, was 1280) |
| plate | ~496 | 368 + a 24 px gap |
| caption | 36 | 40, pulled 8 px closer to its figure |
| **readouts begin at** | **~724** | **705** |

The budget is met and slightly improved, in spite of a taller masthead, a taller
hero and 24 px gaps replacing 1 px seams, because the blurb moves onto the
title's row 256 px earlier. Any future change must keep this under ~720 px at
that viewport.

A **portrait** experiment (Galton declares `--viz-aspect: 0.8`) pushes the
readouts to ~830 px at that viewport, as it did in revision 2. The plate's height
cap, not the chrome, is the lever there.

`dvh`, not `vh`, everywhere the viewport is measured.

### Spacing

4 px base. Revision 2 declared a scale and did not spend it; these are the
amounts that stop the rail feeling cramped.

| Amount | Where |
|---|---|
| 12 px | inside a control (padding-inline on keys, selects, windows) |
| 16 px | label → input; hero padding-block |
| 20 px | between control **rows**; rail panel padding |
| 24 px | between figure sections; `--bench-gap`; between hero and ledger |
| 28 px | between control **groups** (transport → controls) |
| 32 px | above the footer |
| 8 px | minimum between a control and its help text (was 4) |

Page gutters by breakpoint: 16 / 24 / 32 / 40 px. `--page-max` 100rem, centred.
Prose measure 68ch, applied to the blurb and the story caption only.

`--rail-w` is **23rem** (25rem at ≥ 1440), up from 20/22.5. The extra 48 px is
spent on 14 px help text, 20 px of panel padding and a transport that fits five
44 px controls and its rate picker on one row — not on more controls.

`container-type: inline-size` on `.rail`, so the control grid restacks by the
rail's own width rather than the viewport's: below 17rem of rail the label column
collapses and every control takes the full width. That is what matters when a
reader zooms.

### Control and hit-target sizes

| Token | Value | Notes |
|---|---|---|
| `--header-h` | 56 | was 48 |
| `--tab-h` | 38 | pill inside a 48 px trough; 44 on a coarse pointer |
| `--key-h` | 36 | secondary key; 44 on coarse |
| `--key-h-lg` | 44 | Play/Pause and every transport key, at every width |
| `--key-s` | 30 | **visual only** — stepper key, story step; 44 on coarse |
| `--window-h` | 28 | was 22, which is a 98.css text field |
| `--input-h` | 36 | was 32 |
| `--range-h` | 44 | hit area; the channel is 14 px, the rest is transparent border |
| `--switch` | 44 × 26 | was 36 × 18, an SC 2.5.8 failure on its short axis |
| `--hero-h` | 112 | was 96 |
| `--deck-h` | 64 | handheld transport deck, was 56 |
| ledger row | 40 | was 32 |

**The 44 px rule, in one block and one pattern.**

```css
@media (pointer: coarse) {
  :root { --key-h: 2.75rem; --key-s: 2.75rem; --input-h: 2.75rem; --tab-h: 2.75rem }
}
.story__step::after,
.stepper__key::after,
.key--small::after,
.caption__copy::after { content: ""; position: absolute; inset: -6px }  /* -7px for the 30 px keys */
```

This decouples target from ink, which is what lets the bench look precise on a
mouse and still be tappable. Named revision-2 failures fixed: the switch at
36 × 18, story steps at 28 × 28, "Copy permalink" at 78 × 20, and `.window` at
22 px tall. SC 2.5.8's spacing exception is not relied on anywhere.

### Breakpoints

- **≥ 1024 px** — two-column bench, sticky rail, `align-items: start` so the rail
  column does not stretch. The blurb sits on the title's baseline row.
- **≤ 1099 px** — the readouts stack (hero over ledger); the squeeze band where a
  23rem hero and a 360 px ledger fought over one track is gone rather than
  narrowed.
- **≤ 1023 px** — one column. `.figure`, `.rail` and `.rail__panel` become
  `display: contents` and the sections interleave by `order`: head, plate,
  caption, **transport**, readouts, **controls**, story, fact. `.bench` restates
  `align-items: stretch` — in a *column*, `start` means "shrink to content", which
  collapses the plate to the stage's intrinsic width.
- **≤ 599 px** — handheld. Gutters 16 px, header 48 px, the peg strip hidden and
  `.tabs__index` spanning the row. The plate takes an 8 px margin and 10 px marks.
  The ledger collapses to almanac lines. The transport becomes a **floating**
  rounded deck, 64 px, `inset-inline: 8px`, above `env(safe-area-inset-bottom)`,
  on `--e-float`; `body` gets bottom padding for it. `--key-s` rises to 44.
- **Portrait experiments** take `--viz-aspect-narrow` below 600 px:

```css
.stage { --stage-aspect: var(--viz-aspect); aspect-ratio: var(--stage-aspect) }
@media (max-width: 37.4375rem) {
  .stage { --stage-aspect: var(--viz-aspect-narrow, var(--viz-aspect)) }
}
```

`--viz-aspect` is a unitless number (width ÷ height), registered;
`--viz-aspect-narrow` is deliberately **not** registered so the `var()` fallback
works.

### Canvas frame

**The radius lives on `.plate`, never on the pixels.** `.stage` and both canvases
carry no `border-radius` and `.plate` carries no `overflow: hidden`. The canvas is
already inset by `--plate-pad`, so its corners never reach the plate's 16 px
radius and no datum can ever be clipped. `core/canvas.ts` is untouched by the
radius change.

`--reg-inset` rises **6 → 14 px** (10 px handheld) and `--reg-mark` 10 → 12 px, so
all eight registration-mark strokes fall on the straight run outside the curve.
This is the one place the radius change touches an existing decorative
construction, and it was checked at 360, 768 and 1440.

---

## 5. Components

### Tab

```html
<div class="tabs__group" role="presentation">
  <span class="tabs__group-label" aria-hidden="true">Randomness</span>
  <button class="tab" role="tab" id="tab-galton" aria-controls="panel-viz"
          aria-selected="true" aria-label="Galton board, Randomness"
          aria-setsize="10" aria-posinset="1" tabindex="0">
    <span class="tab__label">Galton board</span>
  </button>
</div>
```

`.tabs__strip` is a **trough**: `--surface-sunk`, `--radius-4`, 5 px block padding
and 10 px inline padding, `box-shadow: inset var(--ring)`, `scroll-snap-type: x
proximity`. Tabs are `--radius-3` pills at `--tab-h`, Archivo 13 / 460 / 92%.
Inactive: transparent with an `--ink-muted` label. Active: `--surface-raised`
plus `var(--ring), var(--e-1)` and an `--ink` label. Hover is a `--wash-1`
background that appears in 0 ms and fades out over 140 ms.

**The peg and the ball are kept exactly as built.** There is no separate ball
element — `.tab::after` *is* the peg, a 4 px `--tick` dot 7 px above the pill's
bottom edge, and on `[aria-selected="true"]` it turns `--accent` and
`transform: scale(2)`. State is read from ARIA alone; there is no class for the
shell to desynchronise. What changed is the execution: the swell runs 200 ms on
`--ease-settle` `cubic-bezier(0.5, 1, 0.75, 1.2)` — the one restrained overshoot
in the file, spent on the one moment that deserves it.

Group runs are separated by 12 px of space, not by a 1 px seam. Tab focus is the
standard ring at 2 px offset, replacing revision 2's `outline-offset: -4px` inset
rectangle, which read as a Win98 focus box.

**The strip's scrollbar is gone.** A 10 px `mask-image` edge fade — exactly the
width of the strip's own inline padding, so nothing sits in the fade at rest —
softens the clip when the row genuinely scrolls. The index beside it lists every
visualization at every width, so nothing here is a sole affordance.

### Tab index (all widths)

Unchanged in markup: a `.key.key--icon.tabs__prev`, a `.select.tabs__select` with
`<optgroup>`s, and a `.key.key--icon.tabs__next`, pinned outside the scroller.

### Scheme toggle (masthead)

A `.key.key--icon.theme-toggle` with `aria-pressed`; a half-filled square, the
plate with one half inked. Pressed writes `data-theme="dark"` on `<html>` and
persists to `localStorage`; released writes `data-theme="light"`. Both values are
honoured. **It is no longer the only path into the dark scheme** — `:root` now
declares `color-scheme: light dark`, so the OS preference is honoured on first
visit and the toggle overrides it in both directions.

### Control rail and control row

`.control` is a grid: `minmax(0, var(--label-col)) minmax(0, 1fr)` with areas
`label value / input input / scale scale / help help`, 4 px row gap, and **20 px
between rows**. It has no fill, no ring and no padding of its own — the panel
provides those. Modifiers per `ParamSpec.kind`: `.control--range` (add
`.control--log` when `log: true`), `.control--int`, `.control--toggle`,
`.control--choice`, `.control--seed`.

Three explicit hierarchy levels replace revision 2's SCADA faceplate where
everything competed at similar size and weight:

| Level | Spec |
|---|---|
| Control | label Archivo 13 / 560 / 92% `--ink`; value window Martian Mono 13 `--window-ink` |
| Help | Archivo 14 / 420 `--ink-muted`, 8 px below the control, **never smaller than 14 px** |
| Scale | Martian Mono 11 / 87.5% `--ink-soft` |

Disabled rows are targeted, not inherited:
`.control:has(:disabled) :is(.control__label, .control__help, .control__scale,
.control__value) { color: var(--ink-soft) }`. There is no `.control--disabled`.

The accent ring on the control being adjusted targets the primitive and steps
aside for the focused element's own halo:

```css
.control:focus-within :is(.window, .select):not(:focus-visible) {
  box-shadow: 0 0 0 1px var(--focus-window), var(--e-1);
}
```

### Range slider (the fader)

```html
<input class="range" id="p" type="range" min="0" max="1" step="0.01" value="0.5"
       style="--ticks: 10">
```

A **14 px channel with a vermilion filled portion** and a 20 × 12 white
**carriage** riding in it, index line painted into the carriage. The channel is
`--surface-sunk` with `inset 0 0 0 1px var(--stroke)` — the ring is what makes it
a conformant graphical object, since the fill alone is 1.20:1 against the panel.

**The fill needs no JavaScript.** WebKit takes a negative-offset box-shadow on
`::-webkit-slider-thumb`:

```css
box-shadow: calc(-1 * var(--range-w)) 0 0 calc(var(--range-w) - var(--thumb) / 2) var(--accent);
```

The shadow's right edge lands at `thumbLeft + thumb − W + (W − thumb/2)` =
`thumbLeft + thumb/2`, exactly the carriage's centre line. Firefox uses
`::-moz-range-progress`. `--range-w: 480px` is a constant **upper bound** on the
input's width; `--rail-w` tops out at 25rem = 400 px, of which the fader gets
~344, so there is headroom — **raise it if the rail ever grows past 480 px.**

Two consequences follow from the `overflow: hidden` that confines the fill, and
both are load-bearing:

1. **The clip edge is the input's padding box, not the track.**
   `border-block: 15px solid transparent` with `border-inline-width: 0` makes the
   padding box exactly `--channel` tall while the hit box stays 44 px. Without
   this the fill paints as a 44 px vermilion slab. (This is why the thumb is a
   12 px carriage and not a 22 px circle: a circle overhanging a 14 px channel is
   sliced by the same clip.)
2. **A ring drawn on the thumb is sliced flat top and bottom**, so the focus ring
   lives on the **input**, where it renders complete and follows the input's pill
   radius. This supersedes revision 2's `0 0 0 2px --surface-raised, 0 0 0 4px
   --accent` on the thumb.

The engraved major/minor scale is **deleted** — `--major-h` and `--minor-h` are
gone with it, and so is the JSlider faceplate look. `--ticks` is still written by
the shell and still registered; it renders as one quiet row of 1 × 3 px `--tick`
marks below the channel, sized to the carriage's real travel
(`calc(100% - var(--thumb) + 1px)`). Min, max and the live value are printed as
text, which is the modern replacement for engraving them.
`background-origin: border-box` so the marks are positioned against the 44 px
box; an element's own background is not clipped by its own `overflow`.

States: hover and active scale the carriage 1.06 over 140 ms on `--ease-tactile`;
`cursor: grab` / `grabbing`; disabled sets `--accent: var(--tick)` locally so the
fill goes graphite rather than translucent and the control still reads as a
fader. `touch-action: pan-y` so a page still scrolls from a fader. Every engine
pseudo-element gets its own rule, never comma-joined.

### Stepper (int)

A **group container** at `--radius-3` with 3 px padding and 3 px gaps on
`--surface-sunk` with `inset var(--ring)`, holding a `--radius-2` window (11 − 3 =
8, concentric) and two `--radius-2` ghost keys. No shared 1 px seams — that was a
Motif idiom. Keys are 30 px of ink on a mouse with a `::after { inset: -7px }`
44 px target, and a real 44 px box on a coarse pointer. Native spin buttons are
hidden; the focused child rises with `z-index: 1`.

### Select (choice)

`appearance: none`, `--radius-3`, white window, `0 0 0 1px var(--window-stroke)`
plus `--e-1`, Archivo 13 / 460 / 92%, and a **solid 10 × 6 triangle** as an SVG
data URI at `right 11px center` — the deliberate opposite of the 12 px, 1.5 px,
round-cap, round-join chevron that is the Radix/Lucide house mark. The URI is
literal rather than `currentColor`-through-a-mask because a select's face is
white in **both** schemes, so the mark's colour is a constant by construction; a
second URI in `--window-ink-muted` covers `:disabled`.

Inside `@supports (appearance: base-select)` the picker stays a white display
window in both schemes, gains `--radius-3`, 4 px padding, `--radius-2` options at
a 36 px minimum height, styled `optgroup`s, and a 140 ms opacity fade driven by
`@starting-style` with `transition-behavior: allow-discrete` on `overlay` and
`display`. `option::checkmark` is removed.

`.select.transport__speed` and `.select.tabs__select` need **two class
selectors**: `.select` is a full-width control declared later in the file, and a
single-class override loses to it — which in the transport grows the picker to
300 px and crushes the icon keys to their glyphs.

### Toggle (switch)

```html
<label class="switch-row">
  <span class="control__label">Show trails</span>
  <input class="switch" type="checkbox" role="switch" checked>
</label>
```

44 × 26 track at `--radius-pill`, 20 px white knob at 3 px inset, travel
`translate: 18px 0` — **translate, never `left`**. Off: `--surface-sunk` with
`inset 0 0 0 1px var(--stroke)` at 3.16:1, so the control is identifiable when
off, which is where most toggles fail. On: `--accent` at 4.38:1 (light) / 4.74:1
(dark) against the panel, with an `--accent-press` inset ring. State is carried
by position **and** fill, so colour is never the sole cue.

The tactile detail: `:active` stretches the knob to 24 px over 120 ms and the
checked knob translates 14 px instead of 18, so it squashes under the finger.
The `<label>` wraps the input and is `min-height: 44px`, so the whole row
genuinely is the target.

### Seed field

A `--radius-2` window and a `--radius-3` ghost key **8 px apart**, not sharing a
seam. The input takes `field-sizing: content` with a `min-width: 7ch` floor, so a
4-digit seed does not sit in a field sized for 10.

### Transport

```html
<div class="transport" role="group" aria-label="Transport" data-running="true">
  <button class="key key--primary transport__play" aria-label="Pause">…Pause</button>
  <button class="key key--icon transport__step" aria-label="Step" aria-keyshortcuts=".">…</button>
  <button class="key key--icon transport__ff" aria-label="Fast-forward" aria-keyshortcuts="Shift+.">…</button>
  <button class="key key--icon transport__reset" aria-label="Reset">…</button>
  <label class="visually-hidden" for="transport-speed-1">Speed</label>
  <select class="select transport__speed" id="transport-speed-1">…</select>
</div>
```

A **group container**: `--radius-4`, 5 px padding, 4 px gaps, `--surface-sunk`,
`inset var(--ring)`, holding `--radius-3` keys at 44 px (16 − 5 = 11,
concentric). It **wraps**: five 44 px controls plus a picker want 292 px and a
23rem rail gives ~296 px of panel, so wrapping is the only version of this that
cannot overflow.

**Play/Pause is the one primary key on the page.** 44 px tall, 5.5rem minimum,
`--accent` fill, `--accent-ink` label, its own darker `--accent-press` ring, a
contact shadow and the sub-pixel `--bevel`. Hover **adds** `--e-hover` rather
than swapping a layer; active takes `--accent-press` and a 1 px `translate`.

**Step, Fast-forward and Reset are ghosts** — no fill and no ring at rest, so
nothing competes with Play for a newcomer's eye. They take `--wash-1` on hover,
`--wash-2` plus a 1 px depress on press, and `--ring-strong` while
`aria-pressed` (Fast-forward held).

The 2 px ink rule on top is gone; `[data-running="true"]` turns the group's own
inset ring `--accent` and nothing else changes — read from the data attribute
alone, no parallel class.

Glyphs stay inline 16 px SVG, **solid `fill: currentColor`, no stroke**: filled
triangle, two filled bars, bar + triangle, two triangles, triangle against a bar.

The speed picker keeps its `margin-inline-start: auto`; that gap is still the
point — it sets a rate, it is not a transport key. The shell still resets the
engine to 1× when it tears a route down.

### Readouts: hero window and ledger

Markup is unchanged from revision 2, including the complete
`table` / `rowgroup` / `row` / `columnheader` / `cell` role chain, which must stay
explicit because `.ledger`, `tbody`, `tr` and `td` all take a new `display` at
≤ 599 px and engines drop the implicit table role when they do.

**Hero**: 112 px white window at `--radius-3`, `0 0 0 1px var(--window-stroke)`
plus `--e-1`, `max-width: 23rem`. The measured value at Martian Mono 500 / 40 px
and its analytic target at 300 / 40 px on one baseline — observed against theory
carried by weight, not by a label.

**The null meter.** A band of fixed width `--band-w: 12rem` with the baseline and
the centre tick drawn as two background layers of a single `::before`, and a
2 × 10 px needle positioned with

```css
.hero__needle { left: 50%; translate: calc((clamp(0, var(--err), 1) - 0.5) * var(--band-w)) 0 }
.hero        { transition: --err var(--dur-4) var(--ease-std) }
```

`--err` is registered `inherits: true` (see [What changed and why](#what-changed-and-why)),
so the needle reads what the shell writes on `.hero`, and because a registered
`<number>` is animatable the transition interpolates the value instead of
animating a layout property. `::before` carries both marks so `::after` is free
to speak in the empty state.

**No reading yet is not a reading**, and it now says so. Where
`Number.isFinite(value)` is false the shell prints an em dash and hides the
needle (`.hero__needle[hidden]`) — dead centre is the one position that means
"agrees with theory". The stylesheet dresses that with `:has()` and **no DOM
change**:

```css
.hero:has(.hero__needle[hidden]) .hero__band::before { /* the centreline goes dashed */ }
.hero:has(.hero__needle[hidden]) .hero__band::after  { content: "waiting for the first sample" }
.hero:has(.hero__needle[hidden]) .hero__value        { color: var(--window-ink-muted) }
```

`.hero__band` already carries `aria-hidden="true"`, so the sentence is added for
sighted readers with **zero duplication** in the live region, which already
announces "not measured yet". Three redundant cues: a quiet value, a dashed
centreline, and words. The analytic target still prints in full — it is known
whether or not anything has been measured against it.

**Ledger**: the lattice is gone. No vertical rules, no inter-cell seams, no
zebra, and no booktabs 2 px ink rules. Exactly **one** 1 px `--line` rule, under
the head. The head band sits on `--surface-sunk` with `--radius-2` end corners
and column heads in Archivo 11 / 560 / 92% `--ink-muted`. Rows are 40 px (was 32)
with a `--wash-1` hover that arrives in 0 ms and fades out over 140 ms, so
following one quantity across four columns stops being an act of concentration.

Columns keep their `ch` reservations so a value change cannot reflow. Tolerance
state keeps all three cues — `--agree` colour, the dotted underline until
convergence, and the 8 px `.readout__state` square, hollow → filled. No
green/amber pair, no delta chips.

**No convergence animation.** A settle wash on `[data-state="agree"]` was
considered and dropped: `converged()` in `readouts.ts` is a plain threshold with
no hysteresis, so a reading sitting near the tolerance boundary during a run
would flip the attribute repeatedly and strobe the ledger. Liveness is carried by
the null meter, which is continuous, and by the row hover. See §8 for the one
change that would make it safe.

### Story stepper (the program tape)

Steps are 30 px of ink at `--radius-2` with a 44 px target from
`::after { inset: -7px }`, numbered in Martian Mono 500 / 13 px. Unvisited: muted
numeral, `--ring`. Visited: `--ink` numeral, `--ring-strong`
(`.story__step--visited` is genuine state the DOM cannot otherwise express).
Current is `aria-current="step"` **only** — `--accent` fill, `--accent-ink`
numeral, `--e-1`. Prev and Next at the ends are `aria-disabled`, not `disabled`.

### Fact card (a data plate)

The second elevated object in the figure column: `--surface-raised`,
`--radius-4`, `var(--ring), var(--e-2)`, 20 px padding. The fact text **is** the
heading at 18 px — no "Fact" or "Did you know" label. It fades in once on mount
through `@starting-style`; that is the only entrance animation in the file.

### Caption

Archivo 13 px `--ink-soft` 16 px under the plate — closer than the 24 px section
rhythm, because a caption belongs to its figure. "Figure n." in `--ink` at 560.
"Copy permalink" is a ghost pill with a hover wash and a 44 px target, and turns
`--accent-text` on success. `data-permalink` is what the print stylesheet prints.

### Masthead and footer

Masthead 56 px: wordmark left; right, the credit as two spans, a "Source" link
and the scheme toggle. The credit is hidden below 600 px; the toggle is not.

Footer: `.sources` with 8 px between items and no seams, `.footer__meta` in
Martian Mono 12 px `--ink-soft`, and `.footer__shortcuts`, a `<label>` wrapping a
`.switch` that turns the single-character shortcuts off.

### Windows

`.window` is the display-window primitive: white, `--radius-2`,
`0 0 0 1px var(--window-stroke)` plus `--e-1`, 28 px tall (36 px as an input,
44 px on a coarse pointer), Martian Mono 500 / 13 px at −0.04em, tabular
slashed-zero, right aligned, min-width 7ch. Text uses `--window-ink`; focus takes
`--focus-window`.

---

## 6. Motion

The simulation is the only continuous motion on the page. Chrome moves only in
answer to a person's action and only to show what changed. **Nothing animates on
first paint** except the fact card's `@starting-style` fade.

| Token | Value | Scope |
|---|---|---|
| `--dur-1` | 90 ms | colour and opacity: hover wash, press, ledger row hover |
| `--dur-2` | 140 ms | transform and box-shadow: carriage scale, key depress, rings |
| `--dur-3` | 200 ms | travel: switch knob, the peg swelling into the ball |
| `--dur-4` | 280 ms | the null-meter needle |
| `--dur-5` | 420 ms | the fact card's entrance |
| `--ease-std` | `cubic-bezier(0.2, 0, 0, 1)` | moving in place (revision 2's `--ease-snap` value, kept, renamed) |
| `--ease-out` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | arriving |
| `--ease-in` | `cubic-bezier(0.3, 0, 0.8, 0.15)` | leaving |
| `--ease-tactile` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | keys and the carriage |
| `--ease-settle` | `cubic-bezier(0.5, 1, 0.75, 1.2)` | **the ball landing on the active peg. Nowhere else.** |
| `--hover-in` / `--hover-out` | 0 ms / 140 ms | hover appears instantly and fades out |

`--ease-flip: steps(1, start)` is **deleted**, and with it
`.key:active { background: var(--ink); color: var(--surface-raised) }`. An instant
full inversion is not a fast transition; it is the deliberate absence of one, and
black/white inversion is exactly how a 1998 toolbar button reported "pressed".

**What may animate:** `transform` / `translate` / `scale`, `opacity`,
`box-shadow`, `background-color`, `background-image`, `color`, `border-color`,
`outline-color`, and the registered custom property `--err`. **Banned:** `left`,
`top`, `right`, `bottom`, `width`, `height`, `padding`, `margin`, `font-size`. A
grep for `transition: left|top|width|height` must return zero, and does.
Independent `translate:` and `scale:` are preferred over `transform:` so a hover
scale and a state translate cannot clobber each other.

Every transition is enumerated per rule. `transition: all` appears nowhere.

**Tab transition.** Route change is an in-place swap, not a page transition. The
canvas never crossfades: an instrument switches channels instantly.

**Reduced motion.**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
    animation-duration: 0.01ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

Two deliberate choices. **0.01 ms rather than `none`**, so `transitionend` still
fires and nothing listening for it hangs. And **durations are collapsed while
colour, background and box-shadow state changes are preserved** — hover, focus
and pressed feedback all survive, they simply arrive instantly. A blanket
`transition: none !important` would be a regression, not a fix.

Every state in the design is legible with all motion removed, by construction:
the active tab is fill + ring + shadow + ink weight, not the ball's arrival; the
switch is knob position + fill; the fader is the filled channel; the needle is
its position. The ball's swell and the needle's glide are confirmation, never the
encoding.

The shell does the rest: every visualization opens on the **completed state of
its default configuration** and waits for Play; Fast-forward renders batches
without intermediate frames.

---
## 7. Canvas conventions

The plate is white (`--canvas`) and always the brightest surface on the page —
1.10:1 above the raised panels, which is the documented floor (§3);
`core/canvas.ts` reads the tokens named in `CANVAS_THEME_VARS` **off the
`.plate` element** and hands them to every visualization as `VizContext.theme`.
No visualization hardcodes a colour.

Two rules from §3 and §4 restated here, because this is the section a person
reads before touching canvas code:

- **RULE 0.** Every `CANVAS_THEME_VARS` token is a literal hex, pinned on
  `.plate` in both schemes. Not `light-dark()`, not `color-mix()`, not a derived
  value. An unregistered custom property is not resolved at computed-value time,
  so `getComputedStyle` would hand `ctx.fillStyle` the literal function text and
  it would paint nothing.
- **The radius lives on `.plate`, never on the pixels.** `.stage` and both
  canvases carry no `border-radius`, and `.plate` carries no `overflow: hidden`.
  The canvas is inset by `--plate-pad`, so its corners never reach the plate's
  radius and no datum can ever be clipped.

Because the plate never changes value in either scheme, every ratio in this
section and the CVD validation behind it survive the revision-3 re-level with
nothing to re-run.

### The three pens

- **`--data-1` (signal, vermilion)** — everything random and live: balls,
  needles, darts, walkers, epicycle tips, the live estimate. Particles are
  ≥ 2 CSS px (`--canvas-particle-radius: 2`, `arc()` with r ≥ 1.5) and snap to
  device pixels. **A 1 px line is never drawn in `--data-1`**: a hairline in the
  particle colour drops to 2.20:1 after anti-aliasing.
- **`--data-2` (drafting, blue-black)** — the analytic overlay (fitted Gaussian,
  the π reference, the √n envelope, the bifurcation envelope) **and every thin
  mark in the system**, including expectation marks. Curves are
  `lineWidth = 2 × theme.lineWidth` (9.41:1, still 2.56 when smeared).
- **`--data-3` / `--data-3-fill` (graphite)** — areas, as two marks:
  `ctx.fillStyle = theme.data3Fill` at `globalAlpha = 1` for the wash, then
  `ctx.strokeStyle = theme.data3` at `2 × lineWidth` for the silhouette. **Never
  a translucent `--data-3` and never a `globalAlpha` on an area.** A 1 px mark
  is never `--data-3` — it is the worst pen in the rack for the thinnest mark,
  1.77:1 at 50 % coverage on the plate and 1.51:1 over the wash.

### The pens are roles, not categories

The three pens were validated as a **hierarchy of salience** — signal, analytic,
area — and not as a categorical palette. Run against a categorical validator
they pass CVD separation (ΔE 18.7 protan, target ≥ 8), the normal-vision floor
(ΔE 24.4, floor 15) and contrast against the plate (all ≥ 3:1), and they fail
the lightness band and the chroma floor. Those two failures are correct and are
ignored here: they are rules for palettes in which every hue is a peer of equal
salience, and the graphite pen reading nearly grey is the whole point.

**So a visualization that needs several *peer* series must not spend the three
pens as categories.** Three random walks, or five distributions in the CLT
mixer, are peers; `--data-1` for the first, `--data-2` for the second and
`--data-3` for the third would rank them, and would put the least visible pen on
a series with no claim to be quietest. Use **one pen plus a second encoding**
instead: direct labels at the end of each trace, dash patterns, small multiples,
or opacity steps of `--data-1` over the plate.

Adding a fourth and fifth hue is not the escape hatch. It breaks the instrument
— a bench plotter has a pen carousel, not a highlighter set — and neither hue
has been checked for contrast against the plate or for CVD separation from the
three that exist.

### Structure: `--grid` versus `--grid-soft`

`--grid` (`#23292B`, 14.75:1) is **the experiment's own geometry only** — the
pegs, Buffon's ruled floorboards, a needle. `--grid-soft` (`#8A938F`, 3.16:1) is
**everything that merely contains the experiment** — bin dividers, axes, floor
lines, frames, the plate's registration marks.

Revision 1 promoted `--grid` to near-black for "the video's black pegs" and then
let the Galton code use the same token for its fourteen full-height bin dividers
and its floor, so the histogram sat behind a cage of near-black rules exactly as
loud as the pegs, slicing the distribution into strips — and its own answer,
`--grid-soft`, was declared in CSS and unreachable from canvas code because it
was not in `CANVAS_THEME_VARS`. It is now (§8).

Two further rules follow from that render:

- **Bin dividers are 4 px ticks on the floor line, not full-height rules.** A
  histogram needs a baseline and a scale, not a grid of cells.
- Bin indices and axis numerals use `--ink-muted` in `--canvas-label-font`
  (`500 11px "Martian Mono"`). `ctx.font` carries no `font-variation-settings`,
  so **an in-canvas label can never use a variable width axis** — do not add one
  to `--canvas-label-font`.

### Line widths and snapping

`--canvas-line-width: 1`. **The rule is half-pixel centring for odd CSS line
widths:** `Math.round(x) + 0.5`, which is correct at DPR 1 and at DPR 2 (a 1 CSS
px line centred on a half CSS pixel covers whole device pixels at 2×). At
fractional ratios (1.25, 1.5) a 1 CSS px line cannot be crisp at all and the
softness is accepted. The shipped `snap = lineWidth % 2 === 1 ? 0.5 : 0` is that
rule and is correct; revision 1 specified a DPR-aware formula
`(round(x·dpr − dpr/2) + dpr/2)/dpr` that no code implements and that buys
nothing at 1× or 2×. Curves are 2 px, particles ≥ 2 px, pegs are filled discs.

### Halo

Wherever a `--data-2` curve or any thin mark crosses the pile, stroke it first in
`--canvas` at `lineWidth + 4` (curves) or `+ 2` (marks), then in its own pen.
This is `strokeWithHalo()` in `core/paint.ts` (§8) — a shared helper, not a
per-visualization habit. It is what makes `--data-1` vs `--data-2` at 1.96:1
safe: the two pens never touch, because the plate colour is always between them.
Revision 1 declared the halo normative here, filed it under "recommended" in §8,
never shipped it, and then claimed in §3 that the pens "never overlap over
areas" — which is false the moment a fitted Gaussian crosses its own histogram.

### Contrast check for thin marks

Any mark thinner than 3 CSS px is checked at 50 % coverage against the plate:
`--data-2` 2.56, `--grid` 3.06, `--grid-soft` 1.82, `--data-1` 2.20 (hence
particles only), `--data-3` 1.77 (hence never a thin mark). Marks that fall below
3:1 at 50 % coverage are either drawn at 2 px, drawn snapped so they are not
smeared, or given the halo.

**Trails and fades** remove alpha from the foreground layer
(`destination-out`), never paint the canvas colour over the background layer.

---

## 8. Shell contract

What `src/ui/*.ts` and `src/core/*.ts` must do for the theme to hold. **None of
this is optional and none of it is "recommended".** These landed with revision 2
and are restated here unchanged; revision 3 is a stylesheet-only change and adds
no shell requirement. The one thing it *removes* is a bug that lived in
`theme.css` rather than in the shell — see [What changed and why](#what-changed-and-why).

### Required contract changes

```ts
// src/core/types.ts
export interface CanvasTheme {
  …
  /** Containers: bin dividers, axes, floors, frames. NOT the experiment's geometry. */
  gridSoft: string;
  /** Opaque wash for area fills. Never composite --data-3 with globalAlpha. */
  data3Fill: string;
}

export interface Readout {
  …
  /** Relative error inside which this reading counts as converged. Default 0.01. */
  tolerance?: number;
  /** The closed form the target comes from — `n·p`, `2L/(πd)`. Shown in the hero. */
  formula?: Prose;
}

export const GROUPS = ['randomness', 'waves', 'chaos', 'numbers'] as const;
export type VizGroup = (typeof GROUPS)[number];   // a new group is one array entry

/** §2's variables rule, made a type. A plain string is upright; a `{ v }`
 *  segment is rendered as `<var>` — Archivo italic 400. */
export type ProseSegment = string | { readonly v: string };
export type Prose = string | readonly ProseSegment[];

// Every field the shell renders as a sentence takes Prose: Viz.blurb,
// Fact.text, Preset.caption and ParamSpec.help. Labels do not —
// ParamSpec.label, Readout.label, Preset.label and Viz.title stay upright (§2).

export interface Viz {
  …
  /** Plate shape, width ÷ height, unitless. Omitted takes the registered 1.6. */
  aspect?: number;
  /** Plate shape below 600 px, when the experiment is better portrait there. */
  aspectNarrow?: number;
}
```

```ts
// src/core/canvas.ts
export const CANVAS_THEME_VARS = {
  …
  gridSoft: '--grid-soft',
  data3Fill: '--data-3-fill',
} as const satisfies Record<keyof CanvasTheme, `--${string}`>;

// DEFAULT_CANVAS_THEME gains gridSoft: '#8a938f', data3Fill: '#d2d6d4'.
```

```ts
// src/core/paint.ts — the painting rules that belong to the design system
// rather than to any one visualization. They live here and not in canvas.ts
// because the shell needs them too: it paints the first frame of every tab and
// it owns font loading.

/** Stroke in the plate colour first, then in `pen`, so a thin mark never lands
 *  directly on a data area. §7 requires this wherever a curve or a mark crosses
 *  the pile. `path` may be `undefined`, in which case the context's CURRENT path
 *  is stroked twice — the shape a visualization already has after batching
 *  hundreds of segments through `beginPath()` / `lineTo()`, with no `Path2D` to
 *  allocate per frame. Both strokes take the same path, so the halo can never be
 *  a pixel out of register with the mark it sits under. */
export function strokeWithHalo(
  ctx: CanvasRenderingContext2D,
  path: Path2D | undefined,
  pen: string,
  haloColor: string,
  lineWidth: number,
  haloWidth = 4,
): void;

/** Await the in-canvas label face before the first `drawBackground()`. Resolves
 *  immediately, and never rejects, where the API is missing or the shorthand is
 *  one the font parser refuses. */
export function ensureCanvasFont(labelFont: string): Promise<void>;
```

Galton's `drawBackground()` moves its bin dividers and floor from `theme.grid` to
`theme.gridSoft` and shortens the dividers to 4 px floor ticks; `draw()` replaces
`globalAlpha = BAR_ALPHA; fillStyle = theme.data3` with an opaque
`theme.data3Fill` fill plus a `theme.data3` silhouette at `2 × lineWidth`; its
expectation marks move from 1 px `theme.data3` to 2 px `theme.data2` through
`strokeWithHalo`.

### Fonts

- `await ensureCanvasFont(theme.labelFont)` **before the first
  `drawBackground()`**, and re-run `drawBackground()` once on
  `document.fonts.ready`. Canvas silently falls back when a webfont has not
  loaded, and a background layer is repainted only on init, resize and parameter
  change — so with `display=swap` a cold load painted every axis numeral in
  Consolas and never repainted them.
- Decide the minus sign once at startup (§2) and use the result everywhere.

### Layout and controls

- Set `--viz-aspect` (a **unitless number**) inline on `.plate` from `Viz.aspect`,
  and `--viz-aspect-narrow` from `Viz.aspectNarrow`. Both come off the contract,
  not off a structural cast: read through `viz as Viz & { aspect?: unknown }` the
  compiler cannot tell that no visualization declares either, and the shipped
  `.plate` carried no inline value at all — every tab rendered 1.6 at every
  width, and the portrait-handheld fix above was inert.
- Render `Prose` with `<var>` for every marked segment, through the shared
  `prose()` / `setProse()` helpers in `ui/dom.ts` — never `innerHTML`. §2's rule
  is unimplemented and `theme.css`'s `var, .var` rule is dead code without it.
- On each `.range`, set `--ticks` when `(max − min) / step ≤ 20`; for `log: true`
  add `.control--log` and set `--ticks: log10(max / min)`; fill `.control__min` /
  `.control__max` with the formatted ends.
- Keep `.tabs__select` in sync with the route, both ways; `scrollIntoView` the
  active tab; set `aria-setsize` / `aria-posinset` / `aria-label` on every tab.
- State classes the shell must **not** write, because CSS already reads them:
  `.tab--active`, `.story__step--current`, `.transport--running`,
  `.control--disabled`, `.readouts--re-arm`. Write `aria-selected`,
  `aria-current="step"`, `data-running`, `disabled` — nothing else.

### Readouts

- Promote to the hero the **first readout that carries a `target`**, else the
  first readout. Render the rest in the ledger in emitted order.
- Derive convergence: `|value − target| / |target| ≤ (tolerance ?? 0.01)`. Set
  `data-state="agree"` or `"off"` on the hero and on each `.readout` row, plus
  `.readout--none` where there is no target, and write the visually-hidden
  "converged" / "not yet converged" text.
- Write `--err` on `.hero` as `0.5 + 0.5 · clamp(−1, signedError / (3 ·
  tolerance · |target|), 1)` so the needle saturates at three tolerances.
- Emit **no content at all** in `.readout__target` / `.readout__error` for a
  readout with no target.
- Where the hero's value is not finite, write an em dash instead of the numeral,
  empty the error, and hide `.hero__needle` — never park it at 0.5, which reads
  as agreement.
- Format with `Readout.digits` (default 4 significant), an explicit `+` in the
  error column, thousands separators on counts.

### Live regions

Revision 1 put `aria-live="polite"` on `.readouts` while nesting `<output>`
elements (implicitly polite) inside it, and put another `<output>` on every
fader — a live region inside a live region, plus one per slider, so a drag
announced every intermediate value and a run announced every throttled update.

- Every `<output>` used as a display window carries `aria-live="off"`. They are
  read on focus, not on change.
- The only live region is `.readouts__summary`, visually hidden and
  `aria-live="polite"`. The shell writes **one sentence** into it on pause,
  preset change and route change — never during a run:
  "Paused after 2,000 balls. Mean bin 6.012, analytic 6.000, converged."

### Keyboard shortcuts (SC 2.1.4, Level A)

- **The global Space binding is deleted.** Space is the native activation key for
  any focused `<button>` — on a focused Reset it would both reset and toggle Play
  — and the page-scroll key. Play already responds to Space when focused.
- `.` (step) and `Shift+.` (fast-forward) are handled only when the event target
  is not an `<input>`, `<select>`, `<textarea>` or `isContentEditable` element.
  `.` is a legal keystroke inside the seed and stepper number fields.
- `.footer__shortcuts` is a switch that disables them entirely, persisted to
  `localStorage`. `aria-keyshortcuts` is present on the transport keys only while
  they are enabled.

### Scheme

- The masthead toggle writes `data-theme="dark"` / `"light"` on
  `document.documentElement` and persists it. **With no key stored the OS
  preference decides**, because `:root` declares `color-scheme: light dark` and
  every scheme-varying token is a `light-dark()` pair; the toggle wins in both
  directions through `:root[data-theme="dark"|"light"] { color-scheme: … }`.
  Revision 2 made dark reachable only through the toggle on the argument that the
  light faceplate was the identity. That argument is gone with the faceplate: the
  light scheme is now a warm-lit page, not a machined plate, and a reader
  arriving from an OS in dark mode should not get a bright page while hunting for
  an icon. No `.ts` change is needed — `shell.ts` already writes both values.

### One optional change, not shipped

The ledger would teach more if a reading visibly **settled** when it started
agreeing with theory — a 420 ms wash in the analytic ink on
`.readout[data-state="agree"]`. The shell already writes `data-state`, so the CSS
is one `@keyframes` and one rule and needs no new hook.

It is not shipped because `converged()` in `readouts.ts` is a bare threshold:

```ts
return scale === 0 ? Math.abs(value) <= tolerance
                   : Math.abs(value - target) / scale <= tolerance;
```

A reading sitting near the tolerance boundary during a run flips the attribute on
consecutive updates, and the animation restarts every time — a strobing
convergence indicator in a tool built for watching convergence, which is worse
than none. **The prerequisite is hysteresis**: enter `agree` at `tolerance` and
leave it at, say, `1.5 × tolerance`, so the state cannot chatter. With that in
place the animation is safe to add.

---

## 9. Accessibility conformance

| Criterion | How it is met |
|---|---|
| 1.4.3 Contrast (AA) | Every text pair in §3, computed from the rendered DOM. The lowest is `--ink-soft` at 4.74:1 on the page ground; the lowest on a panel is 5.14:1 |
| 1.4.11 Non-text contrast | Every ring, mark, peg, channel, fill and data pen in §3. `--stroke` is 3.16:1 at its worst (on `--surface-sunk`); the fader's fill is 3.66:1 against its channel and the channel carries its own 3.16:1 ring; the switch reads 3.16:1 when **off** |
| 1.4.1 Use of colour | Convergence carries colour + a dotted underline + a hollow/filled square + hidden text; switch state carries position + fill; running state carries a ring that is also the Pause label; the empty hero carries a quiet value + a dashed centreline + the words "waiting for the first sample" |
| 1.4.4 Resize text | The whole scale is rem against the browser default; no `html { font-size }` |
| 1.4.10 Reflow | 360 px single column with **zero** horizontal page scroll, verified in the browser; the ledger scrolls inside `.ledger-wrap`; the tab strip inside `.tabs__strip` |
| 1.4.12 Text spacing | No fixed heights on text blocks; `ch`-reserved ledger columns |
| 2.1.4 Character key shortcuts | Target-filtered, no Space binding, switchable off in the footer |
| 2.4.11 Focus not obscured / focus appearance | One construction everywhere: a 2 px `--focus-line` outline at 2 px offset, fully enclosing the control, plus a 5 px vermilion halo. The **outline** is what conforms — `box-shadow` is dropped in forced-colors mode, and a ≥ 2 px solid enclosing line needs no separate contrast check against the control |
| 2.5.5 / 2.5.8 Target size | One `@media (pointer: coarse)` block lifts keys, stepper keys, story steps, inputs and tabs to 44 px; three `::after { inset: −6/−7px }` extensions give the 30–32 px keys a 44 px target on a fine pointer without growing the ink. The transport is 44 px at **every** width. The spacing exception is not relied on anywhere |
| 4.1.2 Name, role, value | `role="tablist"` owns only tabs; groups are `role="presentation"`; the ledger carries the complete `table` / `rowgroup` / `row` / `columnheader` / `cell` chain, so its semantics survive the ≤ 599 px `display` change |
| 2.4.3 Focus order | No control removes itself from the tab order under the keypress that operated it: a key at the end of its range is `aria-disabled`, not `disabled` |
| 2.3.3 Animation from interactions | `prefers-reduced-motion` collapses every duration, delay and iteration count while preserving state feedback; visualizations open on the completed state |
| Forced colors | `@media (forced-colors: active)` remaps every chrome token to system keywords **and hands every boundary back to `border`**, because `box-shadow` — which this design draws all of its rings with — is not rendered in that mode. `forced-color-adjust: none` is kept on the marks whose backgrounds are the message (tab peg, switch, convergence square, hero needle, fader channel, fill and track), and `.plate` opts out entirely with its canvas tokens restated as literals — `readCanvasTheme()` hands them to `ctx.fillStyle`, which cannot take a system keyword |

---

## 10. Known costs

**Two variable webfonts from `fonts.googleapis.com`.** The identity rests on
Archivo and Martian Mono, requested render-blocking from a third party on a page
whose premise is zero runtime dependencies — and a third-party request leaks
visitor IPs from a tool published under a university affiliation. Mitigations in
place: the axis ranges are trimmed to what is used, `preconnect` is declared,
`display=swap` prevents invisible text, and the canvas font-loading rule in §8
makes the swap deterministic. The documented hardening path, which changes no
token and no class: drop two woff2 files into `public/fonts`, declare them with
`@font-face` in `theme.css` (the ban is on `@import`, not `@font-face`), add
`unicode-range` Latin subsets, and delete the three `<link>` tags.

**`light-dark()` has no fallback.** The two-scheme palette is written as
`light-dark()` pairs with no `@supports not` duplicate, deliberately: a
hand-synced second palette is exactly the drift this construction exists to
delete. The cost is that a browser older than Chrome 123 / Safari 17.5 /
Firefox 120 (all shipped in 2023–24) gets a page with unresolved colour tokens.
If that ever matters, the fix is a `@supports not (color: light-dark(#000, #fff))`
block containing the **light** literals only — never a second dark palette.

**The plate stays white in the dark scheme.** A large white rectangle in a dark
room is a deliberate trade: it keeps every canvas contrast ratio in §3 valid
across both schemes, keeps one set of pens, and matches the instrument — paper is
paper. The `#282D30` mat takes the local step from 17.82:1 to 13.92:1, which is a
real improvement and not a comfortable one. Dropping the plate to an off-white is
rejected because the three-pen CVD validation was measured against `#FFFFFF` and
would have to be re-run; matting is the cheaper and safer choice, and the residual
glare is a stated cost of keeping §7 intact.

**`--range-w` is a constant.** The fader's zero-JavaScript fill depends on
`--range-w: 480px` exceeding the input's real width. `--rail-w` tops out at 25rem
= 400 px, so there is headroom — but it is a constant that must be raised if the
rail ever grows past 480 px, and nothing will warn you.

**A ledger value-change flash is not shipped.** Making the ledger something you
watch rather than audit wants an animation on convergence, and the honest version
needs hysteresis the CSS cannot express. See §8.

---

## 11. Do not

The default AI web aesthetic, the second-order "escape from it", and this
project's own tells, spelled out:

- No Inter, system-ui, Space Grotesk, Geist, Fraunces or Instrument Serif. Two
  families only: Archivo and Martian Mono.
- **No `font:` shorthand.** It resets `font-variant-numeric` and `font-stretch`.
- No indigo, violet, purple or teal accents; no gradient of any kind; no
  glassmorphism, `backdrop-filter`, blur, grain, noise or texture. One signal
  colour, vermilion, spent by the rubrication rule.
- **No cream paper and no warm beige ground**, and equally no `#fafafa`,
  zinc or slate-950. The ground is a specific low-chroma hue chosen as the
  optical complement of the accent, and the shadow tint is matched to it.
- **No green/amber semantic pair.** Agreement is the drafting pen; deviation is
  ink plus a dotted underline plus a hollow square.
- **No card grid.** Three elevated objects on the page, and only three: the
  plate, the rail panel, the fact card. The sections inside the figure column get
  no fill, no ring and no shadow. Boxing every section at 12 px radius on 5% grey
  is the generic answer, and it is the same mistake revision 2 made with seams.
- No `border-radius: 0` and no `--radius-0`. Radius is by role from a five-step,
  non-power-of-two scale, and nested radii are computed, not guessed.
- No `border: 1px solid` for a panel or control boundary — boundaries are rings
  (`box-shadow: 0 0 0 1px`) so hover can thicken them with no layout shift.
  `border` survives only where a ring cannot go: the fader carriage and the
  ledger's single head rule.
- No uniform-alpha black shadows. Shadows are tinted to the ground's hue, layered
  with per-layer alphas, and every blurred layer over 4 px carries negative
  spread.
- No shadcn-style tracks, pills or toggles — **and no shadcn chevron**: the
  select's index mark is a solid triangle. No icon library — **and no
  16 px / 1.5 px / round-cap glyph spec**, which is that library's look rebuilt
  by hand; transport glyphs are solid fills.
- No hero-plus-three-feature-cards, no bento grid, no centred landing layout, no
  KPI stat tile — the hero is a null meter, not a big number with a delta chip.
- No `:hover` outside `@media (hover: hover) and (pointer: fine)`.
- No uppercase or tracked eyebrows — density comes from Archivo's **width axis**.
  No middle-dot meta strings, no arrows appended to buttons, no coloured left or
  top stripes, no "Did you know", no "Get started" pairs, no blinking live dot,
  no fps counter shown to students.
- No numbering except story steps and figure numbers.
- No `clamp()`, `text-wrap: balance` and a prose measure deployed as a set.
  `clamp()` appears once, on the title; `balance` once, on the same element; the
  measure applies to two elements.
- No motion that is not the simulation or a direct answer to a user action: no
  scroll reveals, count-ups, staggered load-ins, canvas crossfades, or one-frame
  class toggles standing in for an animation. Exactly one overshoot curve exists
  and it is spent on exactly one element.
- No animation of a layout property. Not `left`, not `width`, not the needle.
- No measurement set in Archivo, no paragraph set in Martian Mono.
- **No `color-mix()` or `light-dark()` in a `CANVAS_THEME_VARS` token**, and no
  `light-dark()` nested inside `color-mix()`. See §3 RULE 0.
- No per-visualization hex values, no `globalAlpha` on a data area, no thin mark
  in `--data-3`, no container line in `--grid`. A needed colour is a new token,
  and a new token is a line in `CANVAS_THEME_VARS` in the same commit.
- No rule stated as normative in one section and "recommended" in another. If it
  is not shipped, it is not in this document.
