/**
 * The visualization contract.
 *
 * Everything in src/viz/ implements `Viz`. The shell knows nothing about any
 * specific visualization: it reads `params` to build the control panel, `presets`
 * to build Story mode, `facts` to build the fact card, and calls `create()` to
 * get a running instance.
 *
 * Adding a visualization means adding one directory and one registry line.
 * It should never require touching the shell.
 */

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

/**
 * One span of a sentence the shell composes.
 *
 * A plain string is set upright in the body face. A `{ v }` segment is a
 * variable or a Greek letter and is rendered as `<var>` — Archivo italic 400 —
 * which is the one typographic signal DESIGN §2 uses to separate mathematics
 * from the prose around it. Without it `N(n·p, n·p·(1−p))` reads as ordinary
 * roman words in the middle of an English sentence.
 */
export type ProseSegment = string | { readonly v: string };

/**
 * A sentence, plain or marked up. Every field a visualization writes for a
 * human to read takes this: a bare string where nothing is a variable, an array
 * where something is.
 *
 * `ParamSpec.label`, `Readout.label`, `Preset.label` and `Viz.title` are
 * deliberately *not* prose — §2 keeps them upright.
 */
export type Prose = string | readonly ProseSegment[];

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * A declarative description of one tunable knob.
 *
 * The control panel is generated from these — there is no hand-written UI per
 * visualization. `kind` is a discriminant, so adding a new control type produces
 * a compile error at every site that must handle it.
 */
export type ParamSpec =
  | {
      kind: 'range';
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      default: number;
      /** Suffix shown after the value, e.g. 'px', '°', 'x'. */
      unit?: string;
      /** Distribute slider positions logarithmically. For wide ranges (1 → 1e6). */
      log?: boolean;
      /** Shown as a visible help row under the row. One sentence. */
      help?: Prose;
    }
  | {
      kind: 'int';
      key: string;
      label: string;
      min: number;
      max: number;
      default: number;
      unit?: string;
      help?: Prose;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      default: boolean;
      help?: Prose;
    }
  | {
      kind: 'choice';
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      default: string;
      help?: Prose;
    }
  | {
      kind: 'seed';
      key: string;
      label: string;
      default: number;
      help?: Prose;
    };

export type ParamValue = number | string | boolean;
export type ParamValues = Readonly<Record<string, ParamValue>>;

// ---------------------------------------------------------------------------
// Readouts — every number the animation "shows" must also exist as text
// ---------------------------------------------------------------------------

/**
 * How wide a band around `target` still counts as agreement.
 *
 * A band is one claim: *on the evidence this run has gathered so far, the
 * reading and the prediction are not distinguishable*. Two things follow, and
 * `src/ui/readouts.ts` enforces both rather than leaving them to a
 * visualization's good behaviour.
 *
 * It shrinks. A run that has thrown a hundred darts and one that has thrown a
 * million are not the same bet, so a band that does not move as the run
 * proceeds is almost always wrong — and wrong in the direction that certifies
 * nonsense, because the wide early band is the one that prints the check mark.
 * `sampled` is the form that cannot make that mistake: it takes the standard
 * deviation of *one* observation and the count so far, and the division is done
 * for it.
 *
 * And it is narrow enough to rule something out. A band that is a large
 * fraction of the prediction cannot be falsified by any reading the run could
 * produce, so the ledger refuses to say "matches" through one, whatever it was
 * derived from. The ceiling is stated and justified where it is applied.
 *
 * The `kind` discriminant is what stops the defect this replaced: a bare number
 * cannot tell "declared as exactly zero" from "not declared", and the arithmetic
 * that reads it — `t > 0 ? t : DEFAULT`, `t ?? DEFAULT` — silently substitutes a
 * percentage nobody computed. Here "exact" and "absent" are different shapes and
 * the compiler will not let one stand in for the other.
 */
export type Band =
  /**
   * `sigmas` (3 unless stated) standard errors of the reading: the half-width
   * is `sigmas · sigma / √samples`.
   *
   * `sigma` is the standard deviation of one observation — an analytic
   * constant, taken at the *target* rather than at the noisy estimate — and
   * `samples` is the number of observations behind `value` **now**, not the
   * number the run will finish on. Passing the final count is the bug this
   * form exists to prevent: it yields a band that is honest only on the last
   * frame and absurdly generous on every frame before it.
   */
  | { kind: 'sampled'; sigma: number; samples: number; sigmas?: number }
  /**
   * ± `half`, in the reading's own units.
   *
   * For a band that is not σ/√n: the standard error of a log–log fit, a
   * rounding allowance, the residual of a solved chain. It must still be
   * computed from the evidence in hand and still shrink as that evidence
   * accumulates — a constant here is a fixed percentage wearing a hat.
   */
  | { kind: 'absolute'; half: number }
  /** ± `fraction` × |target|. Meaningless where the target is zero, and refused there. */
  | { kind: 'relative'; fraction: number }
  /**
   * No band at all: the reading must equal the prediction. For the identities —
   * a count against the count that was asked for, shares that must sum to one —
   * where anything but equality is a defect rather than noise.
   */
  | { kind: 'exact' };

/**
 * A single named result. Readouts are the visualization's honest output: they
 * are what screen readers announce, what tests assert on, and what proves the
 * simulation converges to the analytic answer.
 *
 * `target` is the known closed-form value where one exists (π, 1/e, n·p …).
 * Supplying it makes the UI render live absolute error for free.
 */
export interface Readout {
  key: string;
  label: string;
  value: number;
  /** Significant digits to display. Default 4. */
  digits?: number;
  unit?: string;
  /** Analytic value this should converge to, if known. */
  target?: number;

  /**
   * Plain-language label for the simple view, lower case: "average landing
   * spot", not "Mean bin". `label` stays the precise name for the expert table.
   */
  plain?: string;
  /** The one number a newcomer should read first. Mark exactly one per visualization. */
  headline?: boolean;
  /**
   * One short sentence of context, shown under the headline reading and
   * nowhere else — the simple view shows one reading, so a hint on any other
   * one has no surface to appear on and a test rejects it.
   *
   * It answers "why does this matter?", never "what should it be?": the
   * verdict line above it already prints the prediction the reading is being
   * held to, so a hint that quotes the same number again says it twice.
   */
  hint?: string;
  /** Internals — bin counts, index of the mode — that only the expert table shows. */
  expertOnly?: boolean;
  /**
   * The band inside which this reading counts as agreeing with `target`.
   *
   * There is no default and there must not be one. Estimators converge at
   * different rates — a mean over n samples and a π recovered from a crossing
   * fraction are not the same bet — so a band the ledger invented would be a
   * verdict nobody computed. A reading that declares none is reported as a
   * reading, with no claim attached.
   */
  band?: Band;
  /**
   * The relative band, as a bare number: |value − target| / |target|, read as
   * an absolute band where the target is exactly zero.
   *
   * The original form of `band`, and the one every tab still uses. It cannot
   * express a band that shrinks with the run, so it is on its way out; declare
   * `band` instead, and declare only one of the two. Both at once is a
   * contradiction rather than a fallback, and the ledger says so instead of
   * picking one.
   *
   * A declared zero means exact and is honoured. `tolerance > 0 ? tolerance :
   * DEFAULT` could not tell that from "not declared" and shipped, handing a
   * `3·cv/√gaps` that is legitimately 0 at cv = 0 a 1 % bar it never asked for.
   */
  tolerance?: number;
  /**
   * The interval this quantity can occupy, where it is bounded by its own
   * definition: `[0, 1]` for a share, `[0, rows]` for a landing bin, `[-1, 1]`
   * for a correlation.
   *
   * A band is judged against the smaller of the prediction and this span, so a
   * quantity that can only be somewhere in [0, 1] can never be certified
   * through a band of 0.74 — which is not a measurement of anything, it is
   * three quarters of everything the number was ever allowed to be.
   */
  range?: readonly [min: number, max: number];
  /**
   * The closed-form the target comes from, shown in the hero after the word
   * "analytic" (DESIGN §5): `n·p`, `2L/(πd)`, `1/e`. Marked-up prose, so the
   * variables in it are set in italic like every other variable on the page.
   */
  formula?: Prose;
}

// ---------------------------------------------------------------------------
// Presets ("Story mode") and facts
// ---------------------------------------------------------------------------

/**
 * A named parameter set. Presets are ordered pedagogically, not alphabetically:
 * stepping through them in order should walk a newcomer to the insight.
 */
export interface Preset {
  id: string;
  label: string;
  /** What this configuration is meant to reveal. One sentence. */
  caption: Prose;
  values: Readonly<Record<string, ParamValue>>;
}

/** A surprising, checkable claim. Every fact carries a source. */
export interface Fact {
  text: Prose;
  source: { label: string; url?: string };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** Standard normal, mean 0, variance 1. */
  normal(): number;
  bool(p?: number): boolean;
  /** Restart the stream from `seed`. */
  reseed(seed: number): void;
}

/**
 * Two stacked canvases share one coordinate system.
 *
 * `background` holds everything that does not move between parameter changes —
 * the Galton board's pegs, Buffon's ruled lines, the Mandelbrot escape field.
 * It is repainted only on resize or parameter change.
 *
 * `foreground` belongs to `draw()`, which clears it — or fades it with a
 * translucent fill of the canvas colour, for persistent trails — every frame.
 * The shell never clears it for you.
 *
 * Painting static geometry into `foreground` every frame is the single easiest
 * way to lose the frame budget here.
 */
export interface Layers {
  background: CanvasRenderingContext2D;
  foreground: CanvasRenderingContext2D;
}

/**
 * Colors and metrics the shell reads from the active CSS theme and hands to
 * every visualization, so no canvas code ever hardcodes a color.
 *
 * One theme serves every tab. A visualization that needs a color not listed
 * here should ask for a new token rather than inventing a hex value.
 */
export interface CanvasTheme {
  /** Canvas ground. */
  canvas: string;
  ink: string;
  inkMuted: string;
  /**
   * The experiment's own geometry, and only that: the pegs a ball bounces off,
   * Buffon's ruled floorboards, a needle. It is near-black and deliberately as
   * loud as the apparatus in the video this is modelled on.
   */
  grid: string;
  /**
   * The furniture around the experiment: bin dividers, axes, floors, frames,
   * registration marks. Recessive but still a conformant graphical object.
   *
   * The split matters because it is easy to get backwards. Painting a container
   * in `grid` puts a cage of apparatus-black rules around the data — fourteen
   * full-height bin dividers slicing a distribution into strips — and painting
   * the apparatus in `gridSoft` hides the experiment itself.
   */
  gridSoft: string;
  /** Primary data mark — particles, the live estimate. */
  data1: string;
  /** Secondary data mark — the analytic overlay, and every thin mark. */
  data2: string;
  /** Tertiary data mark — the full-opacity *silhouette* of an area. */
  data3: string;
  /**
   * The opaque wash an area is filled with, under its `data3` silhouette.
   *
   * No single colour is both 3:1 against the white plate and 3:1 under
   * vermilion particles — the first needs L ≤ 0.30, the second L ≥ 0.61 — so an
   * area is two marks: this wash, which particles read against, and the
   * silhouette, which is the conformant graphical object carrying the shape.
   * **Never applied through `globalAlpha`.** A translucent `data3` composites to
   * roughly this colour and then nothing in the figure carries 3:1.
   */
  data3Fill: string;
  accent: string;
  /** CSS font shorthand for in-canvas labels, e.g. `12px "IBM Plex Mono"`. */
  labelFont: string;
  /** Hairline width in CSS px. The DPR transform scales it. */
  lineWidth: number;
  /** Default particle radius in CSS px. */
  particleRadius: number;
}

export interface VizContext {
  layers: Layers;
  /**
   * CSS pixels, not device pixels. Draw in these units; the DPR transform is
   * applied for you. The shell updates these in place on resize and then calls
   * `drawBackground()`.
   */
  width: number;
  height: number;
  rng: Rng;
  /** Updated in place by the shell before `onParamChange()` / `reset()`. */
  params: ParamValues;
  theme: CanvasTheme;
  /** Publish results. Call at most once per frame; the shell throttles rendering. */
  emit(readouts: readonly Readout[]): void;
  /** True when the user has asked for reduced motion. Skip continuous animation. */
  reducedMotion: boolean;
}

export interface VizInstance {
  /**
   * Advance the simulation by exactly `dt` milliseconds.
   *
   * Called zero or more times per frame by the fixed-timestep driver. Must be
   * pure with respect to rendering: never touch a canvas here.
   */
  step(dt: number): void;

  /**
   * Repaint `layers.background`.
   *
   * **It must paint and nothing else.** It is idempotent with respect to
   * simulation state: calling it twice in a row must leave the readouts exactly
   * where one call left them, and a visualization must be able to survive it
   * being called at any moment. The shell calls it on init, on resize, on
   * parameter change — and when the in-canvas label face arrives, which is a
   * repaint and not a change of anything.
   *
   * A tab that used it as an invalidation hook broke all three: the font
   * promise's continuation lands one microtask after `activate()`, so on every
   * single load it deleted the sweep the reduced-motion settle had just
   * computed, leaving an empty plate and a 40 px em dash under a live region
   * announcing the number the page had just thrown away. A resize of one pixel
   * — which a mobile URL bar collapsing produces sixty times a second — did the
   * same to a finished diagram. Work that must happen when the *geometry*
   * changes belongs behind a comparison against the geometry it was last done
   * for, so a repaint that changes nothing costs nothing.
   */
  drawBackground?(): void;

  /** Repaint `layers.foreground`. Called once per frame. Must not mutate simulation state. */
  draw(): void;

  /**
   * React to one parameter changing. Return `true` if the change was absorbed
   * live; return `false` (or omit the method) to have the shell call `reset()`.
   *
   * Cosmetic parameters absorb — toggling a Gaussian overlay must not restart
   * ten thousand balls. Structural ones reset — a new row count is a new board.
   */
  onParamChange?(key: string, value: ParamValue): boolean;

  /** Return to the initial state, reusing the current parameters and reseeding the RNG. */
  reset(): void;

  /** Release timers, workers, and listeners. */
  destroy(): void;
}

/**
 * The tab-strip runs, in the order they may appear.
 *
 * The array is the source of truth and the union is derived from it, so adding
 * a group is one entry here: the shell derives its run label from the group
 * name rather than looking it up in a table, and the compiler lists every site
 * that must handle the new member.
 */
export const GROUPS = ['randomness', 'waves', 'chaos', 'numbers'] as const;

export type VizGroup = (typeof GROUPS)[number];

export interface Viz {
  /** URL slug. Stable forever — it appears in shared permalinks. */
  id: string;
  title: string;
  group: VizGroup;
  /** One sentence, present tense, shown under the title. */
  blurb: Prose;
  /**
   * Plate shape, as a unitless width ÷ height (DESIGN §4). The shell writes it
   * to `--viz-aspect` on `.plate`; omitting it takes the registered 1.6.
   *
   * It is the experiment that decides: a Galton board is a portrait lattice
   * (0.8) and rendering it on a 1.6 bed leaves half the plate blank, because
   * `layoutBoard()` takes the smaller of the width- and height-derived peg
   * spacings and the height then binds.
   */
  aspect?: number;
  /**
   * Plate shape below 600 px, when one is better portrait on a phone. A 1.6 bed
   * on a 375 px screen is a 224 px letterbox — this is the number that fixes it,
   * and `--viz-max-h` cannot, because the width clamp binds first.
   */
  aspectNarrow?: number;
  params: readonly ParamSpec[];
  presets?: readonly Preset[];
  facts: readonly Fact[];
  /** Hard ceiling on simulated entities, so no slider combination can hang the tab. */
  budget?: { maxEntities: number };
  create(ctx: VizContext): VizInstance;
}
