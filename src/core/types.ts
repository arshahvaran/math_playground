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
   * Relative error inside which this reading counts as converged. Default 0.01.
   *
   * A target of exactly zero has no relative error, so there it is read as an
   * absolute tolerance instead. Estimators converge at different rates — a mean
   * over n samples and a π recovered from a crossing fraction are not the same
   * bet — so the threshold belongs to the readout, not to the ledger.
   */
  tolerance?: number;
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

  /** Repaint `layers.background`. Called on init, resize, and parameter change only. */
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
