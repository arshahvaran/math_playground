# Design system — Plotter Bench

The visual system for Math Playground. It is written so that every screen can be
built from it without a follow-up question: the tokens, the type, the layout at
four widths, every component with its states and its ARIA, the motion budget,
the rules the canvas code must obey so the data stays legible, and the contract
the shell must honour. `src/ui/theme.css` implements it verbatim; class names
below are the class names there.

**This is revision 2.** Revision 1 certified a system it had not built: three of
its own canvas rules were normative in §7 and demoted to "recommended" in §8, so
the shipped code drew exactly the failing cases they were invented to fix; and
`body`'s `font:` shorthand silently reset `font-variant-numeric`, killing the
tabular figures the whole document leans on. Everything a section states as a
rule here is either implemented in `theme.css` or listed in §8 as a **required**
contract change that lands with this revision. Nothing in this document is a
suggestion.

Contents: [Concept](#1-concept) · [Typography](#2-typography) · [Color](#3-color)
· [Layout](#4-layout) · [Components](#5-components) · [Motion](#6-motion)
· [Canvas conventions](#7-canvas-conventions) · [Shell contract](#8-shell-contract)
· [Accessibility conformance](#9-accessibility-conformance)
· [Known costs](#10-known-costs) · [Do not](#11-do-not)

---

## 1. Concept

The page is a benchtop instrument. A machined, cool-grey faceplate (anodised
aluminium, not paper) holds a bright white plotter bed. A pen plotter draws with
a fixed rack of pens, so the data palette is literally three pens: a **vermilion
signal pen** for whatever is live and random (the balls, the walkers, the current
estimate), a **blue-black drafting pen** for whatever is analytic (the fitted
Gaussian, the π line, the bifurcation envelope), and a **graphite pen** for areas
(histogram silhouettes and their wash, envelopes).

Every quantity a person can turn is a fader with an engraved, graduated scale.
Every quantity the instrument measures sits in a white display window or a ruled
ledger next to its analytic target and its error, the way a bench meter shows
reading, reference and tolerance. That is why the language fits a mathematics
playground: an instrument makes *measurement and convergence* the visible
subject. "Playful" is the vermilion streaming across the bed; "rigorous" is the
tabular numerals, the ticks, and the error column that never lies.

It is crafted and contemporary — Teenage Engineering / Braun geometry, zero
radius, 1 px seams, one signal colour — with no bevels, glows, gradients or CRT
kitsch. Depth comes only from three grounds stepping up in brightness and from
the seams between them. Revision 1 made both steps too small to see (1.12:1
grounds, 1.35:1 seams) and the bench read as one flat grey field; the ladder is
now 1.20:1 → 1.16:1 with 2.04:1 seams, which is a visible lattice on an
uncalibrated laptop.

Four signature details carry the identity at thumbnail scale:

1. **Graduated faders.** Every range slider has an engraved scale sized to the
   thumb's real travel, a ring thumb, and a 2 × 7 px vermilion index line
   pointing at the scale.
2. **Display windows, the null meter, and the ledger.** Every measured number is
   Martian Mono, tabular, in a white 1 px-stroked zero-radius window or in a
   booktabs-ruled ledger with Measured / Analytic / Error columns. The headline
   quantity is a 40 px hero numeral beside its analytic target, over a
   **galvanometer band** whose needle rests dead centre when the reading agrees
   with theory.
3. **The peg-row tab strip.** Every tab carries a small peg on its bottom edge;
   the vermilion ball rests on the active one. No pictograms, no artwork per tab.
4. **The plotter bed.** A white plate with a 16 px margin and four 10 px
   registration marks painted in CSS, always the brightest surface on the page.

The null meter replaces revision 1's hero delta chip on purpose. A big number
next to a comparison value next to a colour-coded signed delta in parentheses is
the KPI tile of every generated dashboard with the radius zeroed; a needle that
walks off centre as an estimate diverges is an instrument.

---

## 2. Typography

Two families, both variable, both from Google Fonts. Hierarchy comes from width
and weight extremes (300 against 800, wdth 88 against wdth 125), not from
400-versus-600.

| Role | Family | Axes requested | Notes |
|---|---|---|---|
| Display and body | **Archivo** | wdth 87–125, wght 400–800, italic 400 @ wdth 100 | Every word in the interface. Never uppercase, never tracked. |
| Numerals and measurement | **Martian Mono** | wdth 87.5–100, wght 300–500 | Every digit that is a measurement. |

The axis ranges are trimmed to what the stylesheet actually asks for (revision 1
requested Archivo wdth 62–125 / wght 400–900 and Martian Mono wdth 75–112.5 /
wght 300–700 and used none of the extremes). See §10 for what these two files
cost and how to remove the third-party request without changing a token.

### The `font:` shorthand is banned

`font:` resets `font-variant-numeric` **and** `font-stretch` to `normal`. In
revision 1 `body { font: 400 15px/24px … }` wiped the `:root` tabular-figures
declaration for the whole document and thirty further rules re-wiped it locally,
so the live-rewritten caption ("2,000 balls have fallen at 40/s, seed 42") was
proportional-figure Archivo and jittered on every parameter change — the exact
defect §6 claimed to prevent — and the ledger lost `slashed-zero` in every cell.

Every rule in `theme.css` uses longhands. `font-variant-numeric: var(--num)` is
declared on `body` **after** the font longhands and repeated explicitly on every
element that renders a digit. The single surviving shorthand is the form-control
reset `font: inherit`, immediately followed by `font-variant-numeric: inherit`.

`--num` is `tabular-nums lining-nums slashed-zero`. On a monospace face
`tabular-nums` is a no-op and `slashed-zero` renders only if the face ships a
`zero` feature; both degrade silently, and `--num` is one token so the request
can be changed in one place if Martian Mono turns out not to carry it.

### Sizes are rem

`html { font-size: 15px }` is gone. It hard-coded the root against the reader's
browser preference — a student who sets 20 px for readability still got 15 px —
and it quietly shrank the one `rem` in the file, inside the title's `clamp()`.
The scale is now rem against the browser default (`--t-13: 0.8125rem`,
`--t-15: 0.9375rem`, …), as are spacing, component heights, the rail width and
the label column, so the whole bench scales with the reader's setting. Only
machined geometry stays in px: 1 px seams, 2 px rules, the fader's track, thumb,
index line and graduations, the plate margin and registration marks.

### The rule: words in Archivo, measurements in Martian Mono

Control labels, readout labels, tab labels, keys, captions, facts and the credit
are Archivo. Slider values, steppers, the seed, ledger cells, the hero,
story-step numerals, scale numerals, footer meta and in-canvas labels are Martian
Mono. A number in prose (a fact, a caption sentence) stays in Archivo and aligns
because `font-variant-numeric` is set on `body` and on each prose class. A
readout or slider value is never routed through the body face.

Variables and Greek letters (`n`, `p`, `π`, `μ`, `σ`) are set in Archivo italic
400 wherever the shell composes text — the blurb, captions, story captions,
facts — via the `<var>` element (or `.var`). `ParamSpec.label` and
`Readout.label` are plain strings and stay upright.

**The minus sign.** Prose uses U+2212 in Archivo. Mono cells use U+2212 only if
it is present and metric-compatible in Martian Mono; the shell decides once at
startup with `ctx.measureText('−').width === ctx.measureText('0').width`
(a missing glyph falls back to another face and measures differently) and uses
U+002D otherwise. A fallback glyph mid-column would break the tabular alignment
the ledger is built on, which is worse than a hyphen.

### Link tags for `index.html`

Place these in `<head>` before the stylesheet. No `@import` anywhere in CSS.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,87..125,400..800;1,100,400&family=Martian+Mono:wdth,wght@87.5..100,300..500&display=swap" rel="stylesheet">
```

Fallback stacks: `"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif` and
`"Martian Mono", ui-monospace, "Cascadia Mono", Consolas, monospace`.

### Scale

| Token (px at a 16 px root) | Face | Weight · width | Used for |
|---|---|---|---|
| `--t-11` 11 / 16 | Martian Mono | 500 · 87.5 | Scale numerals under faders; in-canvas labels at wdth 100 (`--canvas-label-font`) |
| `--t-12` 12 / 16 | Martian Mono | 400 · 87.5 | Analytic column, error column, fact source, footer meta |
| `--t-12` 12 / 16 | Archivo | 500–600 · 88–100 | Ledger head, group labels, control help, credit, hero meta |
| `--t-13` 13 / 20 | Archivo | 600 · 88 | Tab labels, key labels, "Copy permalink" |
| `--t-13` 13 / 20 | Archivo | 500 · 100 | Control labels, readout labels, select text |
| `--t-13` 13 / 20 | Martian Mono | 500 · 100 | Windows: slider values, stepper, seed, story-step numerals |
| `--t-15` 15 / 24 | Archivo | 400 · 100 | Body: blurb, story caption, sources |
| `--t-15` 15 / 20 | Martian Mono | 500 · 100 | Ledger measured values |
| `--t-17` 17 / 24 | Archivo | 600 · 100 | Fact text (it is the heading), story step label, Sources title |
| `--t-18` 18 / 24 | Archivo | 800 · 125 | Wordmark "Math Playground" |
| `--title-size` clamp(28, 1.1rem + 2.6vw, 44) / 1.1 | Archivo | 700 · 90, −0.01em, `text-wrap: balance` | The visualization title — the page's one display step |
| `--t-hero` 40 / 44 | Martian Mono | 500 (measured) and 300 (analytic) | Hero numeral pair; 32 / 36 below 600 px |

Letter-spacing is 0 everywhere except the title (−0.01em). No small caps, no
uppercase labels, no italics in Martian Mono (none exist). `text-wrap: balance`
is used on exactly three elements (the title, the story label, the sources
title), not blanket-applied to `h1, h2, h3`. Paragraphs get `text-wrap: pretty`.
Measure ≤ 62ch.

---

## 3. Color

All neutrals carry a green-blue bias strong enough to see (surface
`hsl(146 12% 85%)`, ink `hsl(197 12% 10%)`). Canvas-contract tokens are 6-digit
hex literals — visualizations parse them.

### Tokens

| Token | Hex | Role |
|---|---|---|
| `--surface` | `#D6DDD8` | Faceplate: masthead, footer, page ground |
| `--surface-raised` | `#EDEFEC` | Rails, plates, the tab bar, every section in the figure column |
| `--canvas` | `#FFFFFF` | The plotter bed and every display window |
| `--line` | `#A2ABA6` | 1 px seams — 2.04:1 on raised, so the lattice is visible |
| `--stroke` | `#657069` | Control outlines and the fader track on grey grounds (≥ 3.7:1) |
| `--tick` | `#6F7975` | Engraved graduations, inactive pegs, dotted leaders (≥ 3.2:1 on every ground) |
| `--ink` | `#171B1D` | Text, key borders, switch, booktabs rules |
| `--ink-muted` | `#4E5750` | Secondary text: blurb, help, labels, analytic column |
| `--accent` | `#D53619` | The signal colour (see the rubrication rule) |
| `--accent-hover` | `#BD2F16` | Primary key hover |
| `--accent-ink` | `#FFFFFF` | Text on the accent |
| `--agree` | `#24467A` | A reading that matches its reference, on grey grounds |
| `--window-ink` / `--window-ink-muted` | `#171B1D` / `#4E5750` | Text inside white windows and the hero |
| `--window-stroke` / `--window-stroke-hover` | `#657069` / `#171B1D` | Borders **on white** — resting and hover |
| `--window-agree` | `#24467A` | Agreement inside a white window |
| `--data-1` | `#D53619` | Signal pen: particles, walkers, needles, the live estimate |
| `--data-2` | `#24467A` | Drafting pen: analytic overlays **and every thin mark** |
| `--data-3` | `#7F8985` | Graphite pen: area **silhouettes** at full opacity |
| `--data-3-fill` | `#D2D6D4` | Graphite wash: area **fills**, opaque — never a `globalAlpha` |
| `--grid` | `#23292B` | The experiment's own geometry: pegs, needles, Buffon's ruled lines |
| `--grid-soft` | `#8A938F` | Containers: bin dividers, axes, floors, frames, registration marks |
| `--wash-1` / `--wash-2` | `rgb(23 27 29 / .06 / .14)` | Hover and pressed washes for themed picker options |

**Why there is no green/amber pair.** Revision 1 used `#1f6f4a` /`#8a5a00`, which
is the Bootstrap success/warning reflex — banning indigo while adopting stock
green-and-amber is the same instinct in a different hue. Here, a reading that
agrees with theory is printed in the theory's own ink (`--agree`, the drafting
pen) and its convergence square fills. A reading that has not converged is not a
fault — it is the resting state of an estimate with more samples to draw — so it
stays `--ink` and is marked, not coloured, by a dotted underline under the
absolute error and a hollow square. Three redundant channels, one fewer colour,
and a truer statement about what the number means.

### The `--window-*` tokens exist because the plate does not invert

Every rule that paints onto `--canvas` — window borders, window hover, select
borders, the hero's rule and needle — uses `--window-*`, which is identical to
the chrome tokens in the light scheme and **unchanged** in the dark one. In
revision 1 these rules used `--ink` and `--stroke`, so in dark mode
`.select:hover { border-color: var(--ink) }` resolved to `#ECEFED` on `#FFFFFF`
— 1.16:1, an affordance that simply disappeared on every select, seed field and
stepper.

### Rubrication rule

Vermilion is spent only on what is **current or moving**: the particles and the
live estimate on the plate, the Play/Pause key, the ball on the active tab, the
index line on every fader thumb and the border of the control being adjusted, the
current story step, the transport's top rule while the simulation runs, and focus
rings on neutral controls. It never colours links, seams, static borders or text
on the grey grounds (3.48:1 on `--surface` fails AA for text). The only accent
text is white on the accent key. Links are ink with a 1 px underline that
thickens to 2 px on hover — no colour change.

### Contrast (WCAG 2.x relative luminance, recomputed for every token)

Text, 4.5:1 required:

| Pair | on `--surface` | on `--surface-raised` | on `--canvas` |
|---|---|---|---|
| `--ink` | 12.55 | 15.00 | 17.34 |
| `--ink-muted` | 5.42 | 6.48 | 7.49 |
| `--agree` | 6.81 | 8.14 | 9.41 |
| `--accent-ink` on `--accent` / `--accent-hover` | 4.80 / 5.86 | | |

UI components and graphical objects, 3:1 required (SC 1.4.11):

| Pair | on `--surface` | on `--surface-raised` | on `--canvas` |
|---|---|---|---|
| `--stroke` / `--window-stroke` | 3.73 | 4.46 | 5.15 |
| `--tick` (graduations, inactive peg) | 3.25 | 3.89 | 4.50 |
| `--accent` as a mark (ball, index line, focus ring) | 3.48 | 4.15 | 4.80 |
| `--ink` (key border, switch, needle) | 12.55 | 15.00 | 17.34 |
| `--ink` focus ring on `--accent` | 3.61 | | |
| `--line` (seam) | 1.57 | 1.88 | decorative, exempt |

Revision 1's `--tick` was 2.70:1 and failed as an informative mark; it now clears
3:1 on all three grounds. Seams remain decorative — the lattice they draw is
never the only cue for a boundary — but they are now visible.

Marks on the plate:

| Mark | Ratio | Note |
|---|---|---|
| `--data-1` 2 px particle on `--canvas` | 4.80 | Holds only if positions snap to device pixels (§7) |
| `--data-2` 2 px curve on `--canvas` | 9.41 | A 50 % anti-aliasing smear still reads at 2.56 |
| `--data-2` 2 px thin mark on `--canvas` | 9.41 | Every hairline in the system is this pen now |
| `--data-3` 2 px area silhouette on `--canvas` | 3.61 | The bar's outline is the graphical object |
| `--data-3-fill` area on `--canvas` | 1.47 | **Decorative wash only.** Never the sole encoding |
| `--grid` peg on `--canvas` | 14.75 | The video's black pegs |
| `--grid-soft` divider / axis on `--canvas` | 3.16 | Recessive but conformant |
| `--data-1` particle on `--data-3-fill` | 3.27 | Balls landing on the pile stay visible |
| `--data-2` curve on `--data-3-fill` | 6.41 | Plus the halo where it crosses the pile |
| `--data-3` silhouette against `--data-3-fill` | 2.46 | Its other side is the plate at 3.61 — conformant |
| `--grid` peg on `--data-3-fill` | 10.05 | |
| `--ink-muted` 11 px canvas label on `--data-3-fill` | 5.11 | Was 4.46 and failing in revision 1 |
| `--data-1` vs `--data-2` | 1.96 | Hue-separated colour-blind-safe pair; the halo (§7) separates them wherever they cross |

**The histogram, honestly.** Revision 1 certified `--data-3` at 3.61:1 full
opacity while §7 mandated the 0.35 alpha the code actually draws, which
composites to `#D2D6D4` = **1.47:1** — the least visible object on the page, and
the entire content of tab one. There is no single colour that is both 3:1 against
the white plate and 3:1 under vermilion dots (the first needs L ≤ 0.30, the
second L ≥ 0.61), so the bar is two marks: an opaque **wash** at 1.47:1 that the
dots read against at 3.27:1, and a full-opacity 2 px **silhouette** in `--data-3`
that is the 3.61:1 graphical object carrying the bell's shape — including the
part above the dot cap, where revision 1 left nothing but the wash.

### Dark scheme (opt-in, and now reachable)

`html[data-theme="dark"]` inverts the chrome only. `--canvas`, `--grid`,
`--grid-soft`, `--data-*` and every `--window-*` token do not change, so the
plate and every window stay white and no canvas ratio needs revalidating. It is
never selected from `prefers-color-scheme` — the light faceplate is the identity
— which is exactly why the **masthead scheme toggle in §5 is mandatory**.
Revision 1 shipped forty lines of dark tokens with nothing anywhere that could
set the attribute; a reader in an OS dark mode had no recourse at all.

| Dark token | Hex | Check |
|---|---|---|
| `--surface` / `--surface-raised` | `#191D1F` / `#282E30` | ground step 1.23:1 |
| `--ink` | `#ECEFED` | 14.66 on surface, 11.90 on raised |
| `--ink-muted` | `#AEB7B2` | 8.26 / 6.70 |
| `--line` | `#4A5255` | 2.13 / 1.73 — visible seam |
| `--stroke` | `#8A948F` | 4.41 on raised |
| `--tick` | `#6E7873` | 3.02 on raised (revision 1's `#5E6764` was 2.52 and failed) |
| `--accent` / `--accent-ink` | `#E8502F` / `#171B1D` | 4.64 text; 3.69 as a mark on raised; 3.74 as a focus ring on a white window |
| `--agree` | `#8FB4E8` | 6.47 on raised |
| every `--window-*` | unchanged | 17.34 / 7.49 / 5.15 / 17.34 / 9.41 on white |

---

## 4. Layout

### Page anatomy

```
.page                         grid rows: masthead / tabs / bench / footer, 1 px seams
  header.masthead             48 px on --surface, wordmark · credit · scheme toggle
  nav.tabs                    grid: scrolling peg strip + pinned index, on --surface-raised
  main.bench                  grid: minmax(0,1fr) + --rail-w, gap 1 px, ground --line
    div.figure                vertical lattice on --surface-raised
      header.figure__head     title + blurb (one row ≥ 1280 px)
      div.plate               white bed, registration marks, holds .stage
      p.caption               "Figure n." sentence + Copy permalink
      section.readouts        .hero window (capped) + .ledger-wrap > .ledger
      section.story           tape + label + caption
      section.fact            fact as heading + source + Another fact
    div.rail                  --surface-raised column
      div.rail__panel         sticky, max-height 100dvh, own scroll, 1 px lattice
        div.transport         Play/Pause · Step · Fast-forward · Reset, 2 px ink rule on top
        form.controls         one .control row per ParamSpec, seed last
  footer.footer               Sources list + meta + shortcuts switch, on --surface
```

The whole page sits on one lattice: containers are `gap: 1px` grids or flex
columns with `background: var(--line)`, and every child paints its own ground.
No panel carries a border. Only display windows (1 px `--window-stroke`), keys
(1 px `--ink`) and the ledger's booktabs rules (2 px / 1 px `--ink`) have rules
of their own. Radius is 0 on every panel, window, key, select, switch, tab and
the plate; 50 % on the fader thumb and the tab peg. Shadows: none.

### Keeping the readouts above the fold

Measured at 1024 × 800 in revision 1, `.readouts` began at y = 800 — the fold
exactly — on a design whose stated subject is measurement and convergence. Three
changes buy it back, and any future change must keep the sum under ~700 px at
that viewport:

| Item | Revision 1 | Now |
|---|---|---|
| masthead + tab row | 48 + 44 | 48 + 44 |
| `.figure__head` | 24 top padding, title, blurb on its own row, 16 bottom ≈ 144 | 16 / 16 padding, blurb on the title's row ≥ 1280 px ≈ 100 |
| plate | `min(72vh, 900px)` + 32 ≈ 608 | `--viz-max-h: min(58dvh, 720px)` + 32 ≈ 496 |
| caption | 36 | 36 |
| **readouts begin at** | **800** | **~724** |

`dvh`, not `vh`, everywhere the viewport is measured: `vh` measures the *large*
viewport on mobile Safari, so the cap was systematically too tall on the device
that needed it most.

### Desktop (≥ 1100 px)

`.bench` is `minmax(0, 1fr) 20rem` (`22.5rem` at ≥ 1440). Left column, top to
bottom: figure head, plate, caption, readouts (hero left, ledger right), story,
fact; the last section grows to fill the column. Right column: `.rail__panel` is
`position: sticky; top: 0; max-height: 100dvh; overflow-y: auto` so the transport
stays reachable while the page scrolls; scroll chaining is left on. Page
max-width 100rem, centred; gutters 24 px.

**The readouts grid is `minmax(15rem, 22rem) minmax(0, 1fr)`, and `.hero` carries
`max-width: 22rem`.** Revision 1's `max-content` hero ignored the hero's own
`flex-wrap` and claimed 444 px with a realistic label ("Fraction of needles
crossing a line" + "analytic 2L/(πd)" + the error), leaving the ledger a 220 px
track for content that wants 360 px with three `nowrap` `ch`-reserved columns and
no scroller anywhere in the file. The ledger now also lives in `.ledger-wrap`
(`overflow-x: auto`), so the page body never scrolls sideways.

### Tablet (600–1099 px)

Below 1100 px the readouts stack (hero over ledger) — the squeeze band is gone
rather than merely narrowed. Below 1024 px the bench becomes one column:
`.figure`, `.rail` and `.rail__panel` become `display: contents` and the sections
interleave by `order`: head, plate, caption, **transport**, readouts,
**controls**, story, fact. Nothing is sticky.

### Handheld (≤ 599 px)

Gutters 16 px, header 40 px (wordmark + scheme toggle). The peg strip is hidden
and `.tabs__index` — Previous key, `<select>` with `<optgroup>`s, Next key —
spans the row. The plate goes edge to edge with an 8 px margin and 8 px marks.
The ledger collapses to almanac lines (label … dotted leader … value; analytic
and error on a second line separated by a ruled edge; a readout with no target is
one line). The transport becomes a fixed bottom deck, 56 px on
`--surface-raised` with its 2 px rule on top, keys 44 px; `body` gets 64 px
bottom padding. `--key-s` rises to 44 px so stepper keys meet SC 2.5.8 without
relying on the spacing exception.

**Portrait experiments get a portrait aspect, not a taller cap.** Revision 1's
`--viz-max-h: 80vh` on handheld was inert: `width: min(100%, …)` binds at 344 px
on a 360 px screen and `aspect-ratio` then fixes the height, so the height cap
never engages for any aspect ≥ 1 and the Galton board rendered as a 258 px
letterbox. `.stage` therefore reads `--viz-aspect-narrow` below 600 px:

```css
.stage { --stage-aspect: var(--viz-aspect); aspect-ratio: var(--stage-aspect); }
@media (max-width: 37.4375rem) {
  .stage { --stage-aspect: var(--viz-aspect-narrow, var(--viz-aspect)); }
}
```

Galton declares `--viz-aspect: 0.8` (4 / 5) and `--viz-aspect-narrow: 0.75`
(3 / 4). **`--viz-aspect` is a unitless number (width ÷ height)**, not a
`<ratio>`: `@property` has no `<ratio>` syntax, and a number is valid in both
`aspect-ratio` and `calc()`. `--viz-aspect-narrow` is deliberately *not*
registered, so `var(--viz-aspect-narrow, …)` can fall back.

### Spacing

4 px base at a 16 px root: `--s-1` … `--s-12`. Control rows are 44 px minimum (a
range row is label row 20 + fader 40 + scale 16 + help 16, padded 8); the hero
window is 96 px; ledger rows 32 px; keys 40 px (44 on touch); windows 22 px
(inputs 32 px). Control labels share an 8 rem column (`--label-col`) so every
value window right-aligns on one vertical line down the rail.

### Tab navigation

The tab row is a two-column grid: a scrolling **peg strip** and a pinned
**index**, separated by a seam.

`.tabs__strip` is `role="tablist"`, `overflow-x: auto`, `scroll-padding-inline:
24px`, with **a visible thin scrollbar** (`scrollbar-width: thin` +
`scrollbar-color`). Revision 1 hid the scrollbar, offered no arrows, refused to
wrap and explicitly declined a jump menu — yet ten tabs already overflow a
1280 px viewport by 234 px (measured: `scrollWidth` 1499 vs `clientWidth` 1265)
and by 490 px at 1024 px. At the stated 25-tab target roughly two thirds of the
tabs were undiscoverable to a mouse-only desktop user while the sub-600 px
`<select>` handled 25 fine — the design was worse on desktop than on phones.

`.tabs__index` fixes that at every width, not just on phones: a Previous key, a
`<select class="select tabs__select">` whose `<optgroup>`s are the groups and
whose options are every visualization in registry order, and a Next key. It is
outside the tablist, so it does not violate tablist ownership, and it is the
complete index at 10 tabs or 25.

Tabs are 44 px `<button role="tab">`s, `padding 0 14px`, Archivo 600 / 13 px at
wdth 88, sentence case. Each `.tabs__group` is a flex run preceded by a 1 px
vertical seam and a 12 px Archivo 600 group label in the same row.

**Group runs are decoration, in ARIA terms.** `role="tablist"` may own only
`role="tab"` elements; revision 1 put `<div>` and `<span>` wrappers inside it, so
assistive technology drops the grouping and mis-reports set position. Each
`.tabs__group` therefore carries `role="presentation"`, each
`.tabs__group-label` carries `aria-hidden="true"`, and the group name is carried
into the accessibility tree through each tab's own `aria-label` ("Galton board,
Randomness") plus explicit `aria-setsize` / `aria-posinset`.

States: inactive `--ink-muted` text with a 4 px `--tick` peg centred on the
bottom edge; hover `--ink` text and peg (inside `@media (hover: hover)`); active
`aria-selected="true"` gives `--ink` text and the peg becomes the ball —
`--accent`, scaled ×2 to 8 px (4.15:1 on the strip). There is **no
`.tab--active`**; the ARIA attribute is the only state. Focus-visible:
`outline: 2px solid var(--ink); outline-offset: -4px`.

Keyboard: roving tabindex, Left / Right / Home / End move, Enter / Space
activate; the URL hash is the route, so every tab is a permalink. The shell
scrolls the active tab into view with `scrollIntoView({ inline: 'nearest' })`.

From 10 to 25 tabs nothing changes but the strip's scroll width and the index's
option count. A new group is one entry in the `GROUPS` array (§8) — revision 1
called it "a new run" while `VizGroup` was a closed union, which made it a type
change and a DOM change.

### Canvas frame

`.plate`: `background: var(--canvas)`, radius 0, no border, no shadow; the seams
frame it. `padding: var(--plate-pad)` (16 px, 8 below 600) is the plotter margin;
in it, four 10 px L-shaped registration marks (1 px `--grid-soft`, 6 px in from
each corner) are painted with eight `background-image` gradients, so they are
CSS, never canvas pixels. They are `--grid-soft`, not `--grid`: the frame is not
part of the experiment.

`.stage` is the host `core/canvas.ts` fills with the two canvases:
`width: min(100%, calc(var(--viz-max-h) * var(--stage-aspect)))`, `aspect-ratio:
var(--stage-aspect)`, `min-height: 10rem`, centred. The width clamp keeps the
declared aspect when the height cap bites. The `min-height` is a guard: a
collapsed stage makes `createStage` floor the backing store at one device pixel
and render a 1 × 1 canvas with no error anywhere.

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

### Tab index (all widths)

```html
<div class="tabs__index">
  <button class="key key--icon tabs__prev" type="button" aria-label="Previous visualization">
    <svg class="key__glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2 4.5 8l6 6z"/></svg>
  </button>
  <label class="visually-hidden" for="viz-index">Jump to visualization</label>
  <select class="select tabs__select" id="viz-index">
    <optgroup label="Randomness">
      <option value="galton" selected>Galton board</option>
      <option value="buffon">Buffon's needle</option>
    </optgroup>
    <optgroup label="Waves">…</optgroup>
  </select>
  <button class="key key--icon tabs__next" type="button" aria-label="Next visualization">…</button>
</div>
```

### Scheme toggle (masthead)

```html
<button class="key key--icon theme-toggle" type="button"
        aria-pressed="false" aria-label="Dark scheme">
  <svg class="key__glyph" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 2h12v12H2z" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8 2h6v12H8z"/>
  </svg>
</button>
```
A half-filled square: the plate with one half inked. Pressed writes
`data-theme="dark"` on `<html>` and persists to `localStorage`; released writes
`data-theme="light"`. Both values are honoured by the stylesheet, so the toggle
wins in both directions. This is the only path into the dark scheme.

### Control rail and control row

```html
<div class="rail"><div class="rail__panel">
  <div class="transport" role="group" aria-label="Transport" data-running="false">…</div>
  <form class="controls" aria-label="Parameters">
    <div class="control control--range">…</div>
  </form>
</div></div>
```
`.control` is a grid: `var(--label-col) minmax(0, 1fr)` with areas
`label value / input input / scale scale / help help`. Modifiers per
`ParamSpec.kind`: `.control--range` (add `.control--log` when `log: true`),
`.control--int`, `.control--toggle`, `.control--choice`, `.control--seed`.
`.control__help` (the spec's `help`) is a visible 12 px muted row beneath — this
is a teaching tool, help is content.

Disabled rows are targeted, not inherited:
`.control:has(:disabled) :is(.control__label, .control__help, .control__scale,
.control__value) { color: var(--ink-muted) }`. Revision 1 set `color` on
`.control` and every one of those children overrode it with its own, so a
disabled row was indistinguishable from an enabled one. **There is no
`.control--disabled`** — `:has(:disabled)` needs no JS bookkeeping.

The accent border on the control being adjusted targets the primitive:
`.control:focus-within :is(.window, .select) { border-color: var(--accent) }`.
Revision 1 targeted `.control__value`, a class only the range row renders, so the
rule was silently false for the stepper, the seed field and the select.

### Range slider (the graduated fader)

```html
<div class="control control--range">
  <label class="control__label" for="p">Bias <var>p</var></label>
  <output class="window control__value" for="p" aria-live="off">0.50</output>
  <input class="range" id="p" type="range" min="0" max="1" step="0.01" value="0.5"
         style="--ticks: 10">
  <div class="control__scale" aria-hidden="true">
    <span class="control__min">0</span><span class="control__max">1</span>
  </div>
  <p class="control__help">Probability of going right at a peg. ½ is a fair coin.</p>
</div>
```
Anatomy: the value window (right, updated on every `input` event; unit in a
`.window__unit` span); the fader — 40 px hit area, a 2 px `--stroke` track with
**no fill** (a fader shows position, the window shows the number); the engraved
scale above the track: three 8 px majors at 0 / 50 / 100 % of thumb travel and
5 px minors every `1 / --ticks` of travel, all `--tick`, drawn as background
gradients sized `calc(100% − 22px + 1px)` so they align with the real travel; min
and max numerals centred under the end majors in Martian Mono 11 px.

Thumb: 22 px circle, 2 px `--ink` border, `--surface-raised` fill, a 2 × 7 px
`--accent` index line at the top pointing at the scale. WebKit `margin-top:
calc(var(--track-h) / 2 − var(--thumb) / 2)` (−10 px); Firefox no margin. Every
rule is duplicated for `::-webkit-slider-runnable-track` /
`::-webkit-slider-thumb` and `::-moz-range-track` / `::-moz-range-thumb`, never
comma-joined.

States: hover — ring thickens (`inset 0 0 0 1px --ink`), inside
`@media (hover: hover) and (pointer: fine)`. Dragging — thumb inverts to `--ink`,
index line `--canvas`, cursor grabbing. Focus-visible — a round ring on the thumb
in both engines (`0 0 0 2px --surface-raised, 0 0 0 4px --accent`) and the value
window's border turns `--accent`. Disabled — opacity .5, index line
`--ink-muted`. `touch-action: pan-y` so a page still scrolls from a fader.

`--ticks` is **registered** (`@property`, `<number>`, initial 10). Unregistered
it was a divisor inside `calc((100% - 1px) / var(--ticks))`, so an empty or
malformed value from the shell would invalidate the whole `background-size` at
computed-value time and the entire engraved scale would vanish with no error.
The shell sets it inline when `(max − min) / step ≤ 20` (one minor per step);
for `log: true` it adds `.control--log` and sets `--ticks` to `log10(max / min)`
— majors at the ends only, minors at the decades.

### Stepper (int)

```html
<div class="stepper">
  <button class="stepper__key" type="button" aria-label="Decrease rows">−</button>
  <input class="window stepper__input" type="number" min="3" max="20" value="12">
  <button class="stepper__key" type="button" aria-label="Increase rows">+</button>
</div>
```
Keys and window share seams (`margin-inline: -1px`), max-width 12 rem,
right-aligned in the value column; `height: max(var(--input-h), var(--key-s))`,
which is 32 px on a pointer device and **44 px on handheld** where `--key-s`
rises. Native spin buttons are hidden; the focused element rises with
`z-index: 1`.

### Select (choice)

`<select class="select">`: `appearance: none`, 32 px, Archivo 500 / 13 px, white
window, 1 px `--window-stroke`, and a **solid 9 × 5 triangle** as an SVG data URI
at `right 9px center`. Revision 1 used a 12 px, 1.5 px, round-capped, round-joined
chevron — the shadcn/Radix mark verbatim, inside a document that forbids
shadcn-style controls. A bench instrument silk-screens a filled index mark.

Hover border `--window-stroke-hover`; focus border accent; disabled on
`--surface` in muted ink. `option` and `optgroup` are styled in both the legacy
path and inside `@supports (appearance: base-select)`, where the picker stays a
white display window (`--canvas` ground, `--window-ink` text, checked option
inverted) in both schemes — `optgroup` is the mobile grouping mechanism and was
styled nowhere in revision 1.

### Toggle (switch)

```html
<label class="switch-row">
  <span class="control__label">Show trails</span>
  <input class="switch" type="checkbox" role="switch" checked>
</label>
```
The `<label>` wraps the input, so the 44 px row genuinely is the hit target —
§5 claimed this in revision 1 and nothing implemented it. The switch is
36 × 18 px, 1 px `--ink` border, radius 0. `::before` is a 12 px ink square at
2 px inset; when `:checked` the track fills ink and the square translates 18 px
and turns `--surface-raised`. State is carried by position and inversion, not
colour. Travel is `--dur-2`.

(The revision-1 `.check` class, styled "for any future multi-select kind" that
does not exist in `ParamSpec`, is deleted. Add it back with the kind.)

### Seed field

```html
<div class="seed">
  <input class="window seed__input" type="number" inputmode="numeric" value="42">
  <button class="key seed__random" type="button">Randomize</button>
</div>
```
A 32 px window and a 32 px secondary key sharing a seam (44 px each on touch,
where `--key-s` rises); last row of the rail.

### Transport

```html
<div class="transport" role="group" aria-label="Transport" data-running="true">
  <button class="key key--primary transport__play" aria-label="Pause">…Pause</button>
  <button class="key key--icon transport__step" aria-label="Step" aria-keyshortcuts=".">…</button>
  <button class="key key--icon transport__ff" aria-label="Fast-forward" aria-keyshortcuts="Shift+.">…</button>
  <button class="key key--icon transport__reset" aria-label="Reset">…</button>
</div>
```
Keys 40 × 40 (44 on the deck) sharing 1 px seams. `.transport__play`, `__step`,
`__ff` and `__reset` are **JS hooks only** — `.key`, `.key--icon` and
`.key--primary` carry all the styling except `.transport__play`'s `min-width`.

Glyphs are inline `<svg class="key__glyph" aria-hidden="true">` at 16 px, **solid
`fill: currentColor`, no stroke**: Play (filled triangle), Pause (two filled
bars), Step (bar + filled triangle), Fast-forward (two filled triangles), Reset
(filled triangle against a bar, pointing back to the start). Revision 1's 16 px /
1.5 px / round-cap / round-join spec is Feather-Lucide's house style exactly —
"no icon library" satisfied by rebuilding the icon library's look.

Play/Pause is the one primary key on the page; it swaps its label and glyph and
never uses `aria-pressed`. Fast-forward while held is `aria-pressed` (inverted).
The cluster's 2 px top rule is ink and turns `--accent` while running — read from
`[data-running="true"]` alone, with no parallel `.transport--running` class.
Disabled keys: muted text, `--line` border, opacity 1.

### Readouts: hero window and ledger

```html
<section class="readouts" aria-label="Readouts">
  <p class="readouts__summary visually-hidden" aria-live="polite"></p>

  <div class="hero" data-state="agree" style="--err: 0.52">
    <div class="hero__row">
      <output class="hero__value" aria-live="off">6.012</output>
      <span class="hero__target">6.000</span>
    </div>
    <div class="hero__band" aria-hidden="true"><span class="hero__needle"></span></div>
    <div class="hero__meta">
      <span class="hero__label">Mean bin</span>
      <span>analytic <var>n</var>·<var>p</var></span>
      <span class="hero__error">+0.012</span>
    </div>
  </div>

  <div class="ledger-wrap">
    <table class="ledger">
      <thead><tr>
        <th class="ledger__head" scope="col"><span class="visually-hidden">Quantity</span></th>
        <th class="ledger__head" scope="col">Measured</th>
        <th class="ledger__head" scope="col">Analytic</th>
        <th class="ledger__head" scope="col">Error</th>
      </tr></thead>
      <tbody role="rowgroup">
        <tr class="readout" role="row" data-state="off">
          <td class="readout__label" role="cell">Variance</td>
          <td class="readout__value" role="cell">2.971<span class="readout__unit"></span></td>
          <td class="readout__target" role="cell">3.000</td>
          <td class="readout__error" role="cell">
            <span class="readout__abs">−0.029</span><span class="readout__rel">(1.0%)</span>
            <span class="readout__state"></span><span class="visually-hidden">not yet converged</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</section>
```

The explicit `role="row"` / `"cell"` / `"rowgroup"` and `scope="col"` are not
decoration: `.ledger`, `tbody`, `tr` and `td` all take a new `display` at
≤ 599 px, which strips table semantics in Chrome and Firefox at exactly the width
where revision 1 promised them.

**Hero**: 96 px white window, 1 px `--window-stroke`, `max-width: 22rem`. The
measured value at Martian Mono 500 / 40 px and its analytic target at 300 / 40 px
on one baseline — observed against theory carried by weight, not by a label.
Beneath it the **null meter**: a 12 rem band with a centre major and a 2 × 9 px
needle at `left: clamp(0%, calc(var(--err) * 100%), 100%)`. Beneath that at
12 px: the label, the word "analytic" with the target's formula if the viz gives
one, and the signed error. `[data-state="agree"]` colours the error and the
needle `--window-agree` and drops the dotted underline. If the hero readout has
no target, `.hero__target` and `.hero__band` are omitted (not "—" at 40 px).
`.hero__unit` is a Martian Mono 15 px muted suffix after the measured value, for
readouts that carry one.

**Ledger**: booktabs rules — 2 px ink top and bottom, 1 px under the head, no
vertical rules, no zebra. Columns: label (Archivo 500 / 13 px, left), Measured
(Martian Mono 500 / 15 px, right, unit after in muted 12 px, width reserved
10ch), Analytic (Martian Mono 400 / 12 px wdth 87.5, muted, 8ch), Error (12 px
mono, 12ch; absolute error with an explicit sign, then the relative error in
muted parentheses). Tolerance state is carried three ways, none of them a
green/amber pair: colour (`--agree` when converged, `--ink` otherwise), a dotted
underline on the absolute error **until** it converges, and an 8 px
`.readout__state` square that is hollow until converged and filled `--agree`
after, with visually-hidden "converged" / "not yet converged" text.
`.readout--none` marks a readout with no target — and for such a row the shell
emits **no target and no error content at all**, not an em dash, so the handheld
collapse really is one line.

Every number is text in the DOM; widths are reserved in `ch` so a font swap
cannot reflow the ledger.

### Story stepper (the program tape)

```html
<section class="story">
  <h2 class="visually-hidden">Story mode</h2>
  <div class="story__tape">
    <button class="key key--small" type="button">Prev</button>
    <ol class="story__steps">
      <li><button class="story__step story__step--visited" type="button">1</button></li>
      <li><button class="story__step" type="button" aria-current="step">2</button></li>
    </ol>
    <button class="key key--small" type="button">Next</button>
  </div>
  <h3 class="story__label">Ten thousand</h3>
  <p class="story__caption">…</p>
</section>
```
Steps are 28 × 28 px keys numbered 1…n in Martian Mono 500 / 13 px. Unvisited:
muted numeral, 1 px `--stroke` border. Visited: ink numeral and border
(`.story__step--visited` is genuine state the DOM cannot otherwise express).
Current is `aria-current="step"` **only** — there is no `.story__step--current`.
Selecting a step writes its values to the controls and the URL.

### Fact card (a data plate)

```html
<section class="fact">
  <h2 class="fact__text">Abraham de Moivre derived the bell curve in 1733 …</h2>
  <p class="fact__source">Source: <a href="…">de Moivre, Approximatio… (1733)</a></p>
  <button class="key key--small fact__next" type="button">Another fact</button>
</section>
```
The fact text **is** the heading; no "Fact" or "Did you know" label above it. The
source is Martian Mono 400 / 12 px muted with the label as an ink-underlined
link. No emoji, icon, coloured stripe or quotation ornament.

### Caption

```html
<p class="caption" data-permalink="https://…/#galton?rows=12&p=0.5&seed=42">
  <span class="caption__figure">Figure 1.</span>
  <span class="caption__text">A Galton board with 12 rows and bias <var>p</var> = 0.5; 2,000 balls have fallen at 40/s, seed 42.</span>
  <button class="caption__copy" type="button">Copy permalink</button>
</p>
```
Archivo 13 px muted under the plate; "Figure n." in ink 600 where n is the
visualization's registry position. The sentence is rewritten from the live
parameters and seed — which is why the tabular-figures fix in §2 matters here
above all. `data-permalink` is what the print stylesheet prints.

### Masthead and footer

Masthead: wordmark "Math Playground" (Archivo 800 / 18 px wdth 125, a link to the
default route) left; right, `.masthead__end` holds the credit as two spans —
"Ali Reza Shahvaran" in ink, "University of Toronto" muted — a "Source" link, and
the scheme toggle. The credit is hidden below 600 px; the toggle is not.

Footer (`.footer`, on `--surface`): `.sources` — a "Sources" heading and a list
aggregating every fact's source across the registry (each `.sources__item`
prefixed by the visualization's title in `.sources__viz`), 1 px seams between
items; `.footer__meta` — version, licence, author in Martian Mono 12 px muted,
and `.footer__shortcuts`, a `<label>` wrapping a `.switch` that turns the
single-character keyboard shortcuts off (§9).

### Windows

`.window` is the display-window primitive: white, 1 px `--window-stroke`, 22 px
tall (32 px as an input), Martian Mono 500 / 13 px, tabular slashed-zero, right
aligned, min-width 7ch, unit in `.window__unit`. Text inside uses `--window-ink`.

---

## 6. Motion

The simulation is the only continuous motion on the page. Chrome moves only in
answer to a person's action and only to show what changed; nothing floats,
breathes, fades in on scroll, counts up, or plays a load choreography. Values
change instantly and in place — tabular numerals prevent jitter, now that they
actually apply — and the first frame of every tab already shows the bed drawn and
real readouts.

| Token | Value | Used for |
|---|---|---|
| `--dur-1` | 80 ms | hover, press, checked, window border, the transport rule going vermilion |
| `--dur-2` | 160 ms | switch travel, the ball settling on the active tab, the hero needle |
| `--ease-snap` | `cubic-bezier(0.2, 0, 0, 1)` | every transition above |
| `--ease-flip` | `steps(1, start)` | key inversion — a switch flips, it does not fade |

Transitions are declared only on `transform`, `opacity`, `background-color`,
`border-color`, `outline-color` and the needle's `left`; never on width, height
or box-shadow.

**Tab transition.** Route change is an in-place swap, not a page transition. The
bench stays; the incoming visualization paints its background layer on the first
frame; the title, blurb, caption, readouts, story and fact are re-rendered. The
peg on the new tab becomes the ball over `--dur-2`; the strip scrolls it into
view. The canvas never crossfades: an instrument switches channels instantly.

**Revision 1's readout "re-arm" is deleted.** It asked the shell to toggle a
class for exactly one frame to trigger an opacity fade, which needs a
forced-reflow dance between add and remove and is precisely the frame-timing
fragility CSS animations exist to avoid — and a fade-in on every route change is
load choreography, which §11 forbids. Readouts now appear with the swap.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` sets both durations
to 0, forces `scroll-behavior: auto`, and zeroes every transition and animation
duration, **delay**, and iteration count (revision 1 zeroed only the two
durations, so the guard would not have held the first time a delay was added).
The shell does the rest: every visualization opens on the **completed state of
its default configuration** — histogram filled, curve fitted, readouts real — and
waits for Play; a user-triggered run is permitted. Fast-forward renders batches
without intermediate frames. Focus and pressed states remain fully visible.

---

## 7. Canvas conventions

The plate is white (`--canvas`) and always the brightest surface on the page;
`core/canvas.ts` reads the tokens named in `CANVAS_THEME_VARS` **off the
`.plate` element** and hands them to every visualization as `VizContext.theme`.
No visualization hardcodes a colour.

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
  `withAlpha(theme.data3, …)` and never a `globalAlpha` on an area.** A 1 px mark
  is never `--data-3` — it is the worst pen in the rack for the thinnest mark,
  1.77:1 at 50 % coverage on the plate and 1.51:1 over the wash.

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
This is `strokeWithHalo()` in `core/canvas.ts` (§8) — a shared helper, not a
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
this is optional and none of it is "recommended".** The four contract changes at
the top land with this revision; the theme is not conformant without them.

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
}

export const GROUPS = ['randomness', 'waves', 'chaos', 'numbers'] as const;
export type VizGroup = (typeof GROUPS)[number];   // a new group is one array entry
```

```ts
// src/core/canvas.ts
export const CANVAS_THEME_VARS = {
  …
  gridSoft: '--grid-soft',
  data3Fill: '--data-3-fill',
} as const satisfies Record<keyof CanvasTheme, `--${string}`>;

// DEFAULT_CANVAS_THEME gains gridSoft: '#8a938f', data3Fill: '#d2d6d4'.

/** Stroke `path` in the plate colour first, then in `pen`, so a thin mark never
 *  lands directly on a data area. §7 requires this wherever a curve or a mark
 *  crosses the pile. */
export function strokeWithHalo(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  pen: string,
  width: number,
  plate: string,
  halo = 4,
): void {
  ctx.save();
  ctx.lineWidth = width + halo;
  ctx.strokeStyle = plate;
  ctx.stroke(path);
  ctx.lineWidth = width;
  ctx.strokeStyle = pen;
  ctx.stroke(path);
  ctx.restore();
}
```

Galton's `drawBackground()` moves its bin dividers and floor from `theme.grid` to
`theme.gridSoft` and shortens the dividers to 4 px floor ticks; `draw()` replaces
`globalAlpha = BAR_ALPHA; fillStyle = theme.data3` with an opaque
`theme.data3Fill` fill plus a `theme.data3` silhouette at `2 × lineWidth`; its
expectation marks move from 1 px `theme.data3` to 2 px `theme.data2` through
`strokeWithHalo`.

### Fonts

- `await document.fonts.load('500 11px "Martian Mono"')` **before the first
  `drawBackground()`**, and re-run `drawBackground()` once on
  `document.fonts.ready`. Canvas silently falls back when a webfont has not
  loaded, and a background layer is repainted only on init, resize and parameter
  change — so with `display=swap` a cold load painted every axis numeral in
  Consolas and never repainted them.
- Decide the minus sign once at startup (§2) and use the result everywhere.

### Layout and controls

- Set `--viz-aspect` (a **unitless number**) inline on `.plate`, and
  `--viz-aspect-narrow` when the visualization is better portrait on a phone.
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
  `document.documentElement` and persists it. Default is light with no key
  stored: the light faceplate is the identity, and the toggle is the recourse.

---

## 9. Accessibility conformance

| Criterion | How it is met |
|---|---|
| 1.4.3 Contrast (AA) | Every text pair in §3, recomputed; the lowest is `--ink-muted` at 5.42:1 |
| 1.4.11 Non-text contrast | Every border, mark, peg, track and data pen in §3; the histogram wash is explicitly not a sole encoding |
| 1.4.1 Use of colour | Convergence carries colour + a dotted underline + a hollow/filled square + hidden text; switch state carries position + inversion; running state carries a rule that is also the Pause label |
| 1.4.4 Resize text | The whole scale is rem against the browser default; no `html { font-size }` |
| 1.4.10 Reflow | 360 px single column, no horizontal page scroll; the ledger scrolls inside `.ledger-wrap` |
| 1.4.12 Text spacing | No fixed heights on text blocks; `ch`-reserved ledger columns |
| 2.1.4 Character key shortcuts | Target-filtered, no Space binding, and switchable off in the footer |
| 2.5.8 Target size | 44 px keys, tab buttons and stepper keys on touch; the switch row is a 44 px `<label>` |
| 4.1.2 Name, role, value | `role="tablist"` owns only tabs; groups are `role="presentation"`; the ledger carries explicit row/cell roles that survive the ≤ 599 px `display` change |
| 2.3.3 Animation from interactions | `prefers-reduced-motion` zeroes durations, delays and iteration counts; visualizations open on the completed state |
| Forced colors | A `@media (forced-colors: active)` block remaps every chrome token to system keywords, keeps `forced-color-adjust: none` on the marks whose backgrounds are the message (tab peg, switch, convergence square, hero needle, fader), and opts `.plate` out entirely with its canvas tokens restated as literals — `readCanvasTheme()` hands them to `ctx.fillStyle`, which cannot take a system keyword |

Print (`@media print`) is a conformance-adjacent feature this audience will
actually use: the page is a titled figure, a numbered caption, a table of
measurements against analytic targets and a sources list — a handout. The block
hides the tab bar, transport, controls, story tape, copy key, scheme toggle and
shortcuts switch, forces one column, caps the plate at 4 in, prints the permalink
from `data-permalink` after the caption, and keeps the ledger and the sources.

---

## 10. Known costs

Stated here rather than left implicit, because both were unacknowledged in
revision 1.

**Two variable webfonts from `fonts.googleapis.com`.** The identity rests on
Archivo and Martian Mono, requested render-blocking from a third party on a page
whose premise is zero runtime dependencies — and a third-party request leaks
visitor IPs from a tool published under a university affiliation. Mitigations in
place: the axis ranges are trimmed to what is used, `preconnect` is declared,
`display=swap` prevents invisible text, and the canvas font-loading rule in §8
makes the swap deterministic instead of leaving axis labels in Consolas forever.
The documented hardening path, which changes no token and no class: drop two
woff2 files into `public/fonts`, declare them with `@font-face` in `theme.css`
(the ban is on `@import`, not `@font-face`), add `unicode-range` Latin subsets,
and delete the three `<link>` tags. Take it if the privacy question is ever
answered "no third parties".

**The plate stays white in the dark scheme.** A large white rectangle in a dark
room is a deliberate trade: it keeps every canvas contrast ratio in §3 valid
across both schemes, keeps one set of pens, and matches the instrument — paper is
paper. If that ever becomes unacceptable, it is a second full canvas palette and
a second contrast audit, not a token flip.

---

## 11. Do not

The default AI web aesthetic, and this project's own tells, spelled out:

- No Inter, system-ui, Space Grotesk, Geist, Fraunces or Instrument Serif. Two
  families only: Archivo and Martian Mono.
- **No `font:` shorthand.** It resets `font-variant-numeric` and `font-stretch`.
- No near-white slate or slate-950 grounds, no cream paper, no purple-to-blue or
  any gradient. The only "gradients" are opaque 1 px ticks and marks.
- No indigo, violet or teal accents. One signal colour, vermilion, spent by the
  rubrication rule; never as text on grey, never on links or borders.
- **No green/amber semantic pair.** Agreement is the drafting pen; deviation is
  ink plus a dotted underline plus a hollow square.
- No cards. No rounded-xl — radius 0 on every panel, window, key, select, switch,
  tab and plate; 50 % on the thumb and the peg.
- No shadows of any kind, including hover lifts, focus glows and modal shadows.
  No blur, backdrop-filter, glassmorphism, grain, noise or texture.
- No shadcn-style tracks, pills or toggles — **and no shadcn chevron**: the
  select's index mark is a solid triangle. No icon library — **and no
  16 px / 1.5 px / round-cap glyph spec**, which is that library's look rebuilt
  by hand; transport glyphs are solid fills.
- No hero-plus-three-feature-cards, no bento grid, no centred landing layout, no
  KPI stat tile — the hero is a null meter, not a big number with a green delta
  chip.
- No `:hover` outside `@media (hover: hover) and (pointer: fine)`. Hover here is
  a full inversion and inversion means "pressed"; a latched hover on iOS would
  leave the Play key reading as pressed after every tap.
- No uppercase or tracked eyebrows, no middle-dot meta strings, no arrows
  appended to buttons, no coloured left or top stripes, no "Did you know", no
  "Get started" pairs, no blinking live dot, no fps counter shown to students.
- No numbering except story steps and figure numbers.
- No motion that is not the simulation or a direct answer to a user action: no
  scroll reveals, count-ups, staggered load-ins, canvas crossfades, overshoot
  easing, and no one-frame class toggles standing in for an animation.
- No measurement set in Archivo, no paragraph set in Martian Mono.
- No per-visualization hex values, no `globalAlpha` on a data area, no thin mark
  in `--data-3`, no container line in `--grid`. A needed colour is a new token,
  and a new token is a line in `CANVAS_THEME_VARS` in the same commit.
- No rule stated as normative in one section and "recommended" in another. If it
  is not shipped, it is not in this document.
