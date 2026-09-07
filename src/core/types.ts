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
      /** Shown as a tooltip / help row. One sentence. */
      help?: string;
    }
  | {
      kind: 'int';
      key: string;
      label: string;
      min: number;
      max: number;
      default: number;
      unit?: string;
      help?: string;
    }
  | {
      kind: 'toggle';
      key: string;
      label: string;
      default: boolean;
      help?: string;
    }
  | {
      kind: 'choice';
      key: string;
      label: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      default: string;
      help?: string;
    }
  | {
      kind: 'seed';
      key: string;
      label: string;
      default: number;
      help?: string;
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
  caption: string;
  values: Readonly<Record<string, ParamValue>>;
}

/** A surprising, checkable claim. Every fact carries a source. */
export interface Fact {
  text: string;
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
 * `foreground` is cleared and repainted every frame.
 *
 * Painting static geometry into `foreground` every frame is the single easiest
 * way to lose the frame budget here.
 */
export interface Layers {
  background: CanvasRenderingContext2D;
  foreground: CanvasRenderingContext2D;
}

export interface VizContext {
  layers: Layers;
  /** CSS pixels, not device pixels. Draw in these units; the DPR transform is applied for you. */
  width: number;
  height: number;
  rng: Rng;
  params: ParamValues;
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

  /** Return to the initial state, reusing the current parameters and reseeding the RNG. */
  reset(): void;

  /** Release timers, workers, and listeners. */
  destroy(): void;
}

export type VizGroup = 'randomness' | 'waves' | 'chaos' | 'numbers';

export interface Viz {
  /** URL slug. Stable forever — it appears in shared permalinks. */
  id: string;
  title: string;
  group: VizGroup;
  /** One sentence, present tense, shown under the title. */
  blurb: string;
  params: readonly ParamSpec[];
  presets?: readonly Preset[];
  facts: readonly Fact[];
  /** Hard ceiling on simulated entities, so no slider combination can hang the tab. */
  budget?: { maxEntities: number };
  create(ctx: VizContext): VizInstance;
}
