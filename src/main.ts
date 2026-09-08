import './ui/theme.css';

import { createStage, readCanvasTheme, type Stage } from './core/canvas';
import { createEngine } from './core/engine';
import { ensureCanvasFont } from './core/paint';
import { createRng } from './core/rng';
import {
  buildHash,
  coerceParams,
  createRouter,
  serializeParams,
  type Route,
} from './core/router';
import { fmt } from './core/stats';
import type {
  ParamValue,
  Preset,
  Readout,
  Viz,
  VizContext,
  VizInstance,
} from './core/types';
import { createControls, type ControlsHandle } from './ui/controls';
import { clear, setProse } from './ui/dom';
import { createFacts, type FactsHandle } from './ui/facts';
import { createReadouts, type ReadoutsHandle } from './ui/readouts';
import { createShell } from './ui/shell';
import { createStory, type StoryHandle } from './ui/story';
import { createTransport, type TransportHandle } from './ui/transport';
import { findViz, registry } from './viz/registry';

/**
 * Bootstrap.
 *
 * Builds the shell once, then drives one visualization at a time from the URL
 * fragment. Nothing here names a visualization: every branch reads the registry
 * and the `Viz` contract, so a new tab is a directory and a registry line.
 *
 * The lifecycle for one route is: tear the previous instance down in order
 * (engine, instance, stage, then every component handle), create the stage,
 * read the theme off the plate, coerce the URL parameters against the specs,
 * build a mutable `VizContext`, create the instance, wait for the canvas label
 * face, paint both layers once, and start the loop unless the reader has asked
 * for reduced motion.
 */

/**
 * Simulation ticks per Fast-forward press: two seconds at the engine's 120 Hz
 * fixed step, rendered as one frame. This is the "skip to ten thousand trials"
 * control, and it is also how a reduced-motion reader advances in bulk.
 */
const FAST_FORWARD_TICKS = 240;

/**
 * Ticks per batch while settling a reduced-motion cold start, and the ceiling
 * and wall-clock budget on the whole settle.
 *
 * DESIGN §6 requires every tab to open on the *completed* state of its default
 * configuration, and for a reduced-motion reader — who gets no autoplay — that
 * opening state is also the resting state: without this the bed is empty, the
 * ledger reads NaN against its analytic target, and nothing on the page is a
 * measurement. The shell cannot know when a visualization is "finished", so it
 * runs Fast-forward batches until the readouts stop moving. The batch is large
 * because every batch costs a full `draw()`, and the two limits are what keep a
 * one-drop-per-second configuration from hanging the load: 300 s of simulated
 * time is enough for both shipped defaults (Galton needs 50 s, Buffon 167 s).
 */
const SETTLE_BATCH_TICKS = 2_400;
const SETTLE_MAX_TICKS = 36_000;
const SETTLE_BUDGET_MS = 400;

/** Fallback for a visualization that declares no seed parameter. */
const FALLBACK_SEED = 1;

/** Relative error inside which a reading counts as converged, per the contract. */
const DEFAULT_TOLERANCE = 0.01;

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('main: #app is missing from index.html');

const router = createRouter();
const shell = createShell(root, registry, (id) => {
  router.navigate(id);
});
const regions = shell.regions;
const engine = createEngine(() => instance);

const motionQuery =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
let reducedMotion = motionQuery?.matches ?? false;

let activeViz: Viz | null = null;
let instance: VizInstance | null = null;
let stage: Stage | null = null;
let vizCtx: VizContext | null = null;
let controls: ControlsHandle | null = null;
let readouts: ReadoutsHandle | null = null;
let story: StoryHandle | null = null;
let facts: FactsHandle | null = null;
let transport: TransportHandle | null = null;
let unResize: (() => void) | null = null;

/** The most recent emission, for the live-region sentence written on pause. */
let latest: readonly Readout[] = [];

/**
 * Bumped on every route change. Anything resumed after an `await` compares it
 * before touching the canvas: a fast tab switch would otherwise let a font
 * promise from the previous visualization repaint the new one's background.
 */
let generation = 0;

// ---------------------------------------------------------------------------
// Live region
// ---------------------------------------------------------------------------

function converged(readout: Readout, target: number): boolean {
  const declared = readout.tolerance;
  const tolerance = declared !== undefined && declared >= 0 ? declared : DEFAULT_TOLERANCE;
  const error = Math.abs(readout.value - target);
  // A target of exactly zero has no relative error; compare absolutely.
  return target === 0 ? error <= tolerance : error / Math.abs(target) <= tolerance;
}

/**
 * The page's only live region, written through the ledger that owns it: one
 * sentence, on pause, preset change and route change, never during a run — a
 * drag or a running simulation must not narrate every throttled update.
 */
function announce(prefix: string): void {
  // The hero is the first readout carrying a target, else the first readout —
  // the same promotion rule the ledger uses.
  const hero = latest.find((r) => r.target !== undefined) ?? latest[0];
  let sentence = prefix;
  if (hero && !Number.isFinite(hero.value)) {
    // A mean over zero samples is NaN, which is the honest value and a useless
    // thing to hear read out.
    sentence += ` ${hero.label} not measured yet.`;
  } else if (hero) {
    const digits = hero.digits ?? 4;
    sentence += ` ${hero.label} ${fmt(hero.value, digits)}`;
    if (hero.unit) sentence += ` ${hero.unit}`;
    if (hero.target !== undefined) {
      sentence += `, analytic ${fmt(hero.target, digits)}`;
      sentence += converged(hero, hero.target) ? ', converged' : ', not yet converged';
    }
    sentence += '.';
  }
  readouts?.announce(sentence);
}

// ---------------------------------------------------------------------------
// Transport state
// ---------------------------------------------------------------------------

/**
 * The transport's key swaps its label and writes `data-running` on the cluster,
 * which is the whole running indicator: the CSS reads that attribute and turns
 * the 2 px rule vermilion. There is no parallel class for it.
 */
function setRunning(running: boolean): void {
  transport?.setPlaying(running);
}

const transportCallbacks = {
  onPlay(): void {
    engine.start();
    setRunning(true);
  },
  onPause(): void {
    engine.stop();
    setRunning(false);
    instance?.draw();
    announce('Paused.');
  },
  onStep(): void {
    engine.stepOnce();
  },
  onFastForward(): void {
    engine.fastForward(FAST_FORWARD_TICKS);
  },
  onReset(): void {
    const inst = instance;
    if (!inst) return;
    inst.reset();
    inst.drawBackground?.();
    // Unconditionally, running or not: `latest` is written by ctx.emit and emit
    // is only reached from draw(), so skipping this paint would compose the
    // announcement below from the readouts of the run that was just zeroed.
    inst.draw();
    announce('Reset.');
  },
  onSpeed(multiplier: number): void {
    engine.setSpeed(multiplier);
  },
};

// ---------------------------------------------------------------------------
// URL and presets
// ---------------------------------------------------------------------------

/**
 * Mirror the live parameters into the URL and the permalink. The hash is built
 * here rather than read back from `location`, because `replaceParams()`
 * coalesces its writes — during a slider drag the address bar is up to 150 ms
 * behind the string a reader would be copying.
 */
function syncUrl(): void {
  const viz = activeViz;
  const ctx = vizCtx;
  if (!viz || !ctx) return;
  const serialized = serializeParams(viz.params, ctx.params);
  router.replaceParams(serialized);
  shell.setPermalink(buildHash(viz.id, serialized));
}

/** The preset whose every value is currently in force, if any. */
function matchingPresetId(): string | null {
  const viz = activeViz;
  const ctx = vizCtx;
  if (!viz || !ctx) return null;
  for (const preset of viz.presets ?? []) {
    const entries = Object.entries(preset.values);
    if (entries.every(([key, value]) => ctx.params[key] === value)) return preset.id;
  }
  return null;
}

function onControlChange(key: string, value: ParamValue): void {
  const ctx = vizCtx;
  const inst = instance;
  if (!ctx || !inst) return;

  ctx.params = { ...ctx.params, [key]: value };
  // Cosmetic parameters absorb; structural ones restart the experiment. A
  // visualization that does not implement onParamChange resets on every knob.
  if (inst.onParamChange?.(key, value) !== true) {
    inst.reset();
    inst.drawBackground?.();
  }
  // While the engine runs it will paint on the next frame anyway.
  if (!engine.running) inst.draw();

  syncUrl();
  story?.setActive(matchingPresetId());
}

function applyPreset(preset: Preset): void {
  const viz = activeViz;
  const ctx = vizCtx;
  const inst = instance;
  if (!viz || !ctx || !inst) return;

  // Every value first, then one reset: applying them one at a time would
  // restart the run once per key and leave the first ones simulated under the
  // wrong configuration.
  const next: Record<string, ParamValue> = { ...ctx.params };
  for (const spec of viz.params) {
    const value = preset.values[spec.key];
    if (value !== undefined) next[spec.key] = value;
  }
  ctx.params = next;
  controls?.setValues(next);

  inst.reset();
  inst.drawBackground?.();
  // Same reason as onReset(): the sentence below is built from `latest`, which
  // only a draw() refreshes. Without this the page's one live region reports the
  // previous configuration's numbers under the new preset's name.
  inst.draw();

  syncUrl();
  story?.setActive(preset.id);
  announce(`${preset.label}.`);
}

// ---------------------------------------------------------------------------
// Route lifecycle
// ---------------------------------------------------------------------------

function teardown(): void {
  engine.stop();
  // The multiplier is engine state and the picker is per-route DOM, rebuilt at
  // 1×. Without this a tab left at 8× hands the next visualization eight times
  // the rate its own transport says it is running at.
  engine.setSpeed(1);
  instance?.destroy();
  instance = null;
  unResize?.();
  unResize = null;
  stage?.destroy();
  stage = null;

  controls?.destroy();
  controls = null;
  readouts?.destroy();
  readouts = null;
  story?.destroy();
  story = null;
  facts?.destroy();
  facts = null;
  transport?.destroy();
  transport = null;

  // A component's destroy() is not required to empty its host, and a stale row
  // from the previous tab would be indistinguishable from a live one.
  clear(regions.controls);
  clear(regions.transport);
  clear(regions.readouts);
  clear(regions.story);
  clear(regions.facts);

  vizCtx = null;
  activeViz = null;
  latest = [];
}

function seedFor(viz: Viz, params: Readonly<Record<string, ParamValue>>): number {
  for (const spec of viz.params) {
    if (spec.kind !== 'seed') continue;
    const value = params[spec.key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return FALLBACK_SEED;
}

async function activate(viz: Viz, route: Route): Promise<void> {
  const token = ++generation;
  teardown();

  activeViz = viz;
  regions.title.textContent = viz.title;
  setProse(regions.blurb, viz.blurb);
  shell.setActiveTab(viz.id);

  const host = regions.stage;
  const st = createStage(host);
  stage = st;

  const params = coerceParams(viz.params, route.params);
  // Read off the stage, which inherits the plate's custom properties: under
  // forced colors the plate restates the canvas tokens as literals, because
  // ctx.fillStyle cannot be given a system keyword like `Canvas`.
  const theme = readCanvasTheme(host);

  const ctx: VizContext = {
    layers: st.layers,
    width: st.width,
    height: st.height,
    rng: createRng(seedFor(viz, params)),
    params,
    theme,
    emit(values) {
      latest = values;
      readouts?.update(values);
    },
    reducedMotion,
  };
  vizCtx = ctx;

  // The ledger exists before create(), because create() runs the first reset()
  // and that reset emits: mounting afterwards would drop the opening numbers.
  readouts = createReadouts(regions.readouts);

  const inst = viz.create(ctx);
  instance = inst;

  controls = createControls(regions.controls, viz.params, ctx.params, onControlChange);
  const presets = viz.presets ?? [];
  story = createStory(regions.story, presets, applyPreset);
  regions.story.hidden = presets.length === 0;
  facts = createFacts(regions.facts, viz.facts);
  regions.facts.hidden = viz.facts.length === 0;
  transport = createTransport(regions.transport, transportCallbacks, { reducedMotion });

  unResize = st.onResize((width, height) => {
    // The resize already wiped both bitmaps; the background is ours to repaint.
    ctx.width = width;
    ctx.height = height;
    inst.drawBackground?.();
    inst.draw();
  });

  // §7: the background layer is repainted only on init, resize and parameter
  // change, so with `display=swap` a cold load would otherwise leave every axis
  // numeral in the fallback face for the life of the tab.
  await ensureCanvasFont(theme.labelFont);
  if (token !== generation) return;

  inst.drawBackground?.();
  inst.draw();

  // A face can still arrive after the first paint on a cold load.
  void document.fonts?.ready.then(() => {
    if (token !== generation) return;
    inst.drawBackground?.();
    if (!engine.running) inst.draw();
  });

  // Reduced motion opens on the completed state of the default configuration
  // and waits for Play; a run the reader starts is still permitted.
  if (reducedMotion) {
    settle();
    setRunning(false);
  } else {
    engine.start();
    setRunning(true);
  }

  syncUrl();
  story?.setActive(matchingPresetId());
  // After the settle, so the opening sentence carries the numbers that are on
  // screen rather than the zeros the first reset() emitted.
  announce(`${viz.title}.`);
}

/**
 * Run the current instance forward until its readouts stop changing.
 *
 * Fast-forward renders batches without intermediate frames, which §6 permits
 * explicitly, so this is the same motion-free advance the Fast-forward key
 * performs — just repeated until the experiment has finished or the budget is
 * spent. A visualization that never settles (an attractor, a walk with no stop
 * condition) simply stops at the ceiling with a real, partial measurement,
 * which is still a reading rather than a NaN.
 */
function settle(): void {
  if (!instance) return;
  const deadline = now() + SETTLE_BUDGET_MS;
  let previous = emitted();
  for (let ticks = 0; ticks < SETTLE_MAX_TICKS; ticks += SETTLE_BATCH_TICKS) {
    engine.fastForward(SETTLE_BATCH_TICKS);
    const current = emitted();
    if (current === previous) return;
    previous = current;
    if (now() >= deadline) return;
  }
}

/** The last emission as one comparable string — "has anything moved?". */
function emitted(): string {
  return latest.map((r) => `${r.key}=${r.value}`).join('\u0000');
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

function onRoute(route: Route): void {
  const viz = route.id === null ? undefined : findViz(route.id);
  if (!viz) {
    // An unknown or absent id resolves to the first tab, and the URL is
    // rewritten so the fragment always names the visualization on screen.
    const fallback = registry[0];
    if (fallback) router.navigate(fallback.id);
    return;
  }
  void activate(viz, route);
}

router.subscribe(onRoute);
onRoute(router.route);

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

motionQuery?.addEventListener('change', (event) => {
  reducedMotion = event.matches;
  if (vizCtx) vizCtx.reducedMotion = reducedMotion;
  if (reducedMotion && engine.running) {
    engine.stop();
    setRunning(false);
  }
});

