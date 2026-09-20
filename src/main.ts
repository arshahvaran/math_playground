import './ui/theme.css';

import { createStage, readCanvasTheme, type Stage } from './core/canvas';
import { createEngine } from './core/engine';
import { ensureCanvasFont } from './core/paint';
import { createRng, randomSeed } from './core/rng';
import {
  buildHash,
  coerceParams,
  createRouter,
  serializeParams,
  type Route,
} from './core/router';
import type {
  ParamValue,
  Preset,
  Readout,
  Viz,
  VizContext,
  VizInstance,
} from './core/types';
import { createControls, type ControlsHandle } from './ui/controls';
import { clear, h, setProse } from './ui/dom';
import { createFacts, type FactsHandle } from './ui/facts';
import { createReadouts, headlineOf, sentenceOf, type ReadoutsHandle } from './ui/readouts';
import { createShell } from './ui/shell';
import { createStory, type StoryHandle } from './ui/story';
import { createTransport, DEFAULT_SPEED, type TransportHandle } from './ui/transport';
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
 * build a mutable `VizContext`, create the instance, paint both layers once,
 * and start the loop unless the reader has asked for reduced motion. It is
 * synchronous end to end: the canvas label face is asked for alongside the
 * first paint and repaints it when it lands, so nothing on screen — and nothing
 * the transport claims — waits on the network.
 */

/**
 * Simulation ticks per Fast-forward press: two seconds at the engine's 120 Hz
 * fixed step, rendered as one frame. This is the "skip to ten thousand trials"
 * control, and it is also how a reduced-motion reader advances in bulk.
 */
const FAST_FORWARD_TICKS = 240;

/**
 * Ticks between paints inside one Fast-forward press.
 *
 * A press is a bulk skip and paints a frame, not a film — but a visualization
 * that renders incrementally has to be handed the chance to. 24 ticks is one
 * 60 Hz frame of simulated time at 24× — comfortably past the 4× ceiling the
 * transport offers, which is the point: it bounds the backlog whatever the
 * picker is set to. It keeps the chaos game's un-painted
 * backlog inside the 32,768-point ring its incremental path needs. `settle()`
 * deliberately does not pass it: nobody is watching a cold start, and a paint
 * per 24 ticks over a 36,000-tick settle would be 1,500 of them.
 */
const FAST_FORWARD_PAINT_TICKS = 24;

/**
 * Ticks in the first batch while settling a reduced-motion cold start, the
 * largest batch that follows, and the ceiling and wall-clock budget on the
 * whole settle.
 *
 * DESIGN §6 requires every tab to open on the *completed* state of its default
 * configuration, and for a reduced-motion reader — who gets no autoplay — that
 * opening state is also the resting state: without this the bed is empty, the
 * ledger reads NaN against its analytic target, and nothing on the page is a
 * measurement. The shell cannot know when a visualization is "finished", so it
 * runs Fast-forward batches until the readouts stop moving. 300 s of simulated
 * time is enough for every shipped default (Galton needs 50 s, Buffon 167 s).
 *
 * A tick is not a fixed cost, which is what makes every batch a measured
 * quantity rather than a constant — *including the first*. A tick of the Galton
 * board is a few dozen balls; a tick of the coupled oscillators is four
 * mean-field passes over the crowd, a tick of the Ising sheet is two passes over
 * 128², and a tick of arcsine at the top of both its faders is a whole batch of
 * games. A fixed first batch of 600 was calibrated at default parameters on one
 * desktop and ran to completion before the deadline below was consulted even
 * once: 576 ms on arcsine at `flips=10000&games=5000` here, and 3.7 s on a
 * four-times-slower phone — a frozen white page, with no spinner and no partial
 * frame, on a URL the tab itself writes into the address bar, for the audience
 * that asked for *less* motion.
 *
 * So the first batch is one tick, timed, and every batch including the second is
 * sized from what the last one actually cost against the time that is left. That
 * removes the only unbounded step and costs one extra `draw()`. The cap is the
 * old batch doubled: a cheap tab reaches the ceiling in seven batches instead of
 * fifteen, and each batch costs a full `draw()`.
 *
 * The budget is spent in slices rather than in one go. 400 ms is a fifth of a
 * second past the 200 ms at which a gesture stops feeling connected to the
 * page, and the settle runs on a *tab click* as well as on a cold load, so
 * holding the main thread for the whole of it made every tab in the strip feel
 * broken for the reader who had asked for less motion — nothing could scroll,
 * nothing could focus, and the first frame of the new tab could not paint
 * because the paint was queued behind the settle. `SETTLE_SLICE_MS` is the
 * longest the thread is held at a stretch; between slices the page is live, the
 * plate shows the run as far as it has got, and anything that restarts the
 * experiment — a knob, a chip, a resize, a route change — simply cancels the
 * slices that were still to come.
 */
const SETTLE_PROBE_TICKS = 1;
/**
 * The rungs an unmeasurable settle batch climbs, rather than jumping to
 * `SETTLE_MAX_BATCH_TICKS` on the strength of a clock that resolved nothing.
 * 64 → 512 → 4,096 → the cap.
 */
const SETTLE_FREE_BATCH_START = 64;
const SETTLE_FREE_BATCH_GROWTH = 8;
const SETTLE_MAX_BATCH_TICKS = 4_800;
const SETTLE_MAX_TICKS = 36_000;
const SETTLE_BUDGET_MS = 400;
const SETTLE_SLICE_MS = 24;

/**
 * Frames of unchanged readings after which a run that is still "playing" is
 * stopped.
 *
 * A finished experiment does not announce itself. Nothing in `VizInstance` says
 * "done", and a flag there would be one more thing fifteen tabs can forget to
 * set — so the last ball landed, the cluster reached its particle ceiling, and
 * the tab went on holding the vermilion running rule lit and repainting the
 * identical picture sixty times a second for as long as it stayed open.
 *
 * What a finished run does do is stop producing numbers, and every number this
 * app draws also goes through `emit()`, so the shell can see it without being
 * told. The count is in frames of our own rather than in milliseconds on a
 * timer: a backgrounded tab is handed no frames, emits nothing new, and would
 * otherwise be mistaken for a finished one and stopped behind the reader's
 * back. Two seconds at 60 Hz, against tabs whose slowest reading moves several
 * times a second — a Galton board at one ball per six frames, a sweep at one
 * column per frame — so no experiment that is still running can reach it.
 */
const IDLE_FRAMES_BEFORE_STOP = 120;

/** Fallback for a visualization that declares no seed parameter. */
const FALLBACK_SEED = 1;

/** Trailing delay before a Step or Fast-forward gesture narrates its result. */
const ANNOUNCE_DEBOUNCE_MS = 400;

/**
 * How long the label face is allowed to keep a repaint waiting.
 *
 * `document.fonts.ready` and `fonts.load()` are promises the app does not own,
 * and a webfont request that is blackholed rather than refused never settles at
 * all. Racing them against a timer means nothing in the app is ever waiting on
 * an unbounded request.
 */
const FONT_WAIT_MS = 5_000;

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('main: #app is missing from index.html');

const router = createRouter();

/**
 * index.html ships a legible failure message inside `#app`, and it is removed
 * only once the shell has actually been built. So a throw anywhere in
 * `createShell()` — a `matchMedia` wrapper from an extension, a future mistake
 * in that function — leaves the reader a sentence instead of a masthead with
 * fifteen inert tabs and nothing under them, and it costs no try/catch that
 * could hide the throw from the console.
 */
const bootFallback = [...root.children].find((el) => el.classList.contains('boot-fallback'));
const shell = createShell(
  root,
  registry,
  (id) => {
    router.navigate(id);
  },
  repaintForScheme,
);
bootFallback?.remove();
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
 * Bumped on every route change. Anything that resumes on a promise compares it
 * before touching the canvas: a fast tab switch would otherwise let a font
 * promise from the previous visualization repaint the new one's background.
 */
let generation = 0;

// ---------------------------------------------------------------------------
// Live region
// ---------------------------------------------------------------------------

/**
 * The page's only live region, written through the readouts that own it: one
 * sentence, on pause, preset change and route change, never during a run — a
 * drag or a running simulation must not narrate every throttled update.
 *
 * The sentence is the headline in the same plain words the page shows, with
 * the same verdict: `headlineOf()` and `sentenceOf()` are the readouts' own
 * rules, so what is spoken can never disagree with what is printed.
 */
function announce(prefix: string): void {
  announceTimer = clearTimer(announceTimer);
  // A settle in flight is a measurement in progress, and the sentence is built
  // from `latest`. Speaking now would narrate the partial run and then never
  // correct itself, which is the failure this whole file exists to avoid on the
  // one path where the reader has no other way to see the number arrive. The
  // prefix waits for the slices it describes; `endSettle()` speaks it.
  if (settleTimer !== null) {
    pendingAnnouncement = prefix;
    return;
  }
  const hero = headlineOf(latest);
  readouts?.announce(hero ? `${prefix} ${sentenceOf(hero)}`.trim() : prefix);
}

let announceTimer: ReturnType<typeof setTimeout> | null = null;

/** The prefix of an announcement waiting on the settle it describes. */
let pendingAnnouncement: string | null = null;

/**
 * Announce the result of a discrete gesture, once the gesture has stopped.
 *
 * Step and Fast-forward are gestures, not frames — every other key in the
 * transport announces — and under `prefers-reduced-motion` they are the *only*
 * way to advance anything, because there is no autoplay. Without this the page's
 * one live region reported "not measured yet" for the life of the tab while the
 * hero showed a converged reading and the ledger showed five hundred balls
 * landed; the only way to hear a number was Reset, which throws the run away
 * first. The trailing delay is what keeps a held key from narrating every burst.
 */
function announceSoon(): void {
  if (announceTimer !== null) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    announce('');
  }, ANNOUNCE_DEBOUNCE_MS);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

// ---------------------------------------------------------------------------
// Transport state
// ---------------------------------------------------------------------------

/**
 * The transport's key swaps its label and writes `data-running` on the cluster,
 * which is the whole running indicator: the CSS reads that attribute and turns
 * the 2 px rule vermilion. There is no parallel class for it.
 *
 * It is also the one place the run starts and stops being observed, so the
 * watchdog below cannot be armed for a stopped engine or left armed over a
 * running one.
 */
function setRunning(running: boolean): void {
  transport?.setPlaying(running);
  if (running) startWatching();
  else stopWatching();
}

/** The queued watchdog frame, and how many frames the readings have stood still. */
let watchFrame = 0;
let idleFrames = 0;

function startWatching(): void {
  idleFrames = 0;
  emissionMoved();
  if (watchFrame === 0) watchFrame = requestAnimationFrame(watchForFinish);
}

function stopWatching(): void {
  if (watchFrame !== 0) cancelAnimationFrame(watchFrame);
  watchFrame = 0;
}

/**
 * Stop a run that has stopped being one. See `IDLE_FRAMES_BEFORE_STOP`.
 *
 * The reading is spoken as the loop stops, with no prefix, exactly as a Step or
 * a Fast-forward speaks: the transition from running to stopped is the moment
 * the measurement is final, and every other way the loop stops says so. It is
 * deliberately not worded as "finished" — the shell knows that nothing has
 * moved for two seconds, which is not the same claim.
 */
function watchForFinish(): void {
  watchFrame = 0;
  if (!engine.running) return;
  idleFrames = emissionMoved() ? 0 : idleFrames + 1;
  if (idleFrames < IDLE_FRAMES_BEFORE_STOP) {
    watchFrame = requestAnimationFrame(watchForFinish);
    return;
  }
  engine.stop();
  autoStopped = true;
  setRunning(false);
  announce('');
}

/**
 * Was the loop stopped by the watchdog rather than by the reader?
 *
 * The two look identical on the transport and must not be treated alike: a
 * pause is a decision and survives everything, while a loop stopped because the
 * experiment had run out of numbers has to come back the moment there is a new
 * experiment to run. Without the distinction, the first knob turned after a run
 * finished reset the board and left it empty under a key reading "Play" — which
 * is the reduced-motion defect this file already has one rule for, reintroduced
 * for everybody else.
 */
let autoStopped = false;

const transportCallbacks = {
  onPlay(): void {
    // The engine is about to advance the run itself; a settle still handing out
    // slices would be a second driver on the same instance.
    cancelSettle();
    autoStopped = false;
    engine.start();
    setRunning(true);
  },
  onPause(): void {
    engine.stop();
    // From here the stopped loop is the reader's, whoever stopped it first.
    autoStopped = false;
    setRunning(false);
    instance?.draw();
    announce('Paused.');
  },
  onStep(): void {
    engine.stepOnce();
    announceSoon();
  },
  onFastForward(): void {
    engine.fastForward(FAST_FORWARD_TICKS, FAST_FORWARD_PAINT_TICKS);
    announceSoon();
  },
  onReset(): void {
    const inst = instance;
    if (!inst) return;
    inst.reset();
    inst.drawBackground?.();
    advance();
    announce('Reset.');
  },
  onShuffle(): void {
    // The rail carries no seed field, so this is the one way to ask for the
    // same experiment with another draw. It goes through the control path so
    // the URL, the "Try:" chips and the reset all follow as for any other knob.
    const seed = activeViz?.params.find((spec) => spec.kind === 'seed');
    if (seed) onControlChange(seed.key, randomSeed());
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

/**
 * Is `preset` exactly the configuration in force?
 *
 * Every value it declares has to be in force *and* every parameter it does not
 * declare has to be at its default — the state applying it to a fresh route
 * would produce. A plain subset test ("is every declared value in force?") is
 * not enough, because presets declare partial key sets: Buffon's "Short
 * needle" sets only `ratio` and "Wider boards" only `spacing`, so a subset scan
 * answers "Short needle" for a short needle on wide boards — a state that is
 * neither chip — and the caption then describes the wrong experiment.
 *
 * A seed a preset does not declare is exempt: a seed names the run, not the
 * configuration, and "the same preset with another draw" is what Shuffle is
 * for.
 */
function presetInForce(
  viz: Viz,
  preset: Preset,
  params: Readonly<Record<string, ParamValue>>,
): boolean {
  for (const spec of viz.params) {
    const declared = preset.values[spec.key];
    if (declared === undefined && spec.kind === 'seed') continue;
    if (params[spec.key] !== (declared === undefined ? spec.default : declared)) return false;
  }
  return true;
}

/** The preset the parameters in force are exactly, if any. */
function matchingPresetId(): string | null {
  const viz = activeViz;
  const ctx = vizCtx;
  if (!viz || !ctx) return null;
  let best: Preset | null = null;
  for (const preset of viz.presets ?? []) {
    if (!presetInForce(viz, preset, ctx.params)) continue;
    // Two presets can both be in force when one of them declares a value that
    // is also the default; the more specific one is the one that says more
    // about the state on screen.
    const keys = Object.keys(preset.values).length;
    if (best === null || keys > Object.keys(best.values).length) best = preset;
  }
  return best?.id ?? null;
}

/**
 * Advance the experiment to the state the reader is meant to be looking at.
 *
 * There is exactly one rule and it lives here: if nothing is going to advance
 * the run, this settles it. `activate()` used to be the only place that knew
 * that rule, so for a reduced-motion reader — who gets no autoplay — the first
 * control they touched, the first story chip they pressed and the Shuffle key
 * all replaced a settled measurement with an empty plate and a 40 px em dash,
 * while `syncUrl()` wrote a permalink whose *fresh* load would settle. Same URL,
 * two different screens, and the only one-click escape was Play — the motion
 * they had asked not to have.
 *
 * Every path that restarts or re-parameterises the run goes through here, so a
 * fourth path cannot be added that forgets. There are two ways for nothing to
 * be advancing the run and they need opposite answers: a reduced-motion reader,
 * who has no loop at all and gets a settle, and a loop the watchdog stopped
 * because the last experiment had finished, which simply starts again. The one
 * stopped state left alone is the one the reader asked for.
 */
/**
 * Repaint the plate in the scheme that is now on the page.
 *
 * The canvas pens are a snapshot of the CSS theme, and a bitmap keeps whatever
 * it was painted with. CSS restyles the plate's *bed* on a scheme change, but
 * the two bitmaps on it are ours, and every piece of apparatus a tab draws —
 * Galton's pegs, Buffon's floorboards, the Monte Carlo square and circle, the
 * arcsine axes, DLA's launch circle — lives on the
 * background layer, which by design repaints only on init, resize and parameter
 * change. So a reader who pressed the scheme key kept the light pens on a dark
 * bed and watched the apparatus disappear, while a page *loaded* in the dark
 * scheme was perfectly correct. That asymmetry is why the tokens looked
 * innocent: both schemes' values were right all along, and nothing re-read them.
 *
 * The shell calls this, rather than the shell being watched for it: `applyScheme()`
 * is the one place the scheme is decided — the masthead key and the OS both go
 * through it — so there is no second source to keep in step, and no
 * `MutationObserver` on an attribute that only this app ever writes.
 *
 * A repaint, not `advance()`: unlike a resize, nothing about the simulation has
 * changed, and restarting a finished run would throw its result away over a
 * change of ink.
 *
 * Both layers, unconditionally — not just the background, and not `draw()` only
 * when the loop is stopped. Scheme-coloured furniture is not all on the
 * background: DLA's launch circle and this tab's axes, centre of mass and key
 * are painted on the foreground every frame. Leaving those to the next frame
 * made the toggle non-atomic, and "the next frame" is not a promise the shell
 * can make — `requestAnimationFrame` does not run in a background tab, and is
 * throttled in several others, so the plate could sit half-converted for as
 * long as nobody was looking at it and then be correct the moment they were.
 * `draw()` is required not to mutate the simulation, so an extra one is free of
 * consequence, and this is a keypress, not a frame.
 */
function repaintForScheme(): void {
  const inst = instance;
  const ctx = vizCtx;
  // Called once during createShell(), before there is a route to repaint.
  if (!inst || !ctx) return;
  ctx.theme = readCanvasTheme(regions.stage);
  inst.drawBackground?.();
  inst.draw();
}

function advance(): void {
  const inst = instance;
  if (!inst) return;
  if (!engine.running) {
    if (reducedMotion) settle();
    else if (autoStopped) {
      // The loop was stopped because the run had nothing left to say, and the
      // caller has just given it something: a new parameter, a new preset, a
      // plate of a different shape. A pause the reader asked for is left alone.
      autoStopped = false;
      engine.start();
      setRunning(true);
    }
  }
  // Unconditionally, running or not: `latest` is written by ctx.emit and emit is
  // only reached from draw(), so a live-region sentence composed after this
  // would otherwise carry the readouts of the run that was just restarted.
  inst.draw();
}

function onControlChange(key: string, value: ParamValue): void {
  const ctx = vizCtx;
  const inst = instance;
  if (!ctx || !inst) return;
  // A control can report a change that is not one: a stepper key at its own
  // limit clamps back to the value already in force, and a log fader has
  // positions that decode to the same integer. Restarting the experiment for
  // one of those throws a finished run away for a keypress that changed
  // nothing, so the comparison happens before the reset, not inside it.
  if (ctx.params[key] === value) return;

  ctx.params = { ...ctx.params, [key]: value };
  // Cosmetic parameters absorb; structural ones restart the experiment. A
  // visualization that does not implement onParamChange resets on every knob.
  if (inst.onParamChange?.(key, value) !== true) {
    inst.reset();
    inst.drawBackground?.();
  }
  advance();

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
  //
  // The set is built from the spec defaults, not from what happens to be in
  // force, so applying a chip produces exactly the state `presetInForce()`
  // documents — "the state applying it to a fresh route would produce". Keeping
  // the reader's undeclared knobs instead lit the chip over a configuration that
  // is not the preset, printed its caption for an experiment that is not
  // running, and advertised a permalink that reopens with no chip lit at all.
  // The seed is the exception the matching rule already makes: a seed names the
  // run, not the configuration.
  const next: Record<string, ParamValue> = {};
  for (const spec of viz.params) {
    const declared = preset.values[spec.key];
    if (declared !== undefined) next[spec.key] = declared;
    else if (spec.kind === 'seed') next[spec.key] = ctx.params[spec.key] ?? spec.default;
    else next[spec.key] = spec.default;
  }
  ctx.params = next;
  controls?.setValues(next);

  inst.reset();
  inst.drawBackground?.();
  // Same reason as onReset(): the sentence below is built from `latest`, which
  // only a draw() refreshes. Without this the page's one live region reports the
  // previous configuration's numbers under the new preset's name.
  advance();

  syncUrl();
  // Through the one rule, never asserted: a chip is lit because the
  // configuration *is* the preset, which is now true by construction above.
  story?.setActive(matchingPresetId());
  announce(`${preset.label}.`);
}

// ---------------------------------------------------------------------------
// Route lifecycle
// ---------------------------------------------------------------------------

function teardown(): void {
  announceTimer = clearTimer(announceTimer);
  pendingAnnouncement = null;
  autoStopped = false;
  // Both of these hold a callback that would otherwise arrive on the next task
  // or the next frame and drive the instance this is about to destroy.
  cancelSettle();
  stopWatching();
  engine.stop();
  // The multiplier is engine state and the picker is per-route DOM, rebuilt at
  // `DEFAULT_SPEED`. Without this a tab left at 4× hands the next visualization
  // four times the rate its own transport says it is running at. Imported
  // rather than written as 1 so the two cannot drift apart.
  engine.setSpeed(DEFAULT_SPEED);
  instance?.destroy();
  instance = null;
  unResize?.();
  unResize = null;
  stage?.destroy();
  stage = null;
  // The stage host also carries the "no 2D canvas" message when there is one.
  clear(regions.stage);

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
  // The next tab's first emission is a different experiment, not a movement of
  // this one's.
  watchedKeys.length = 0;
  watchedValues.length = 0;
}

function seedFor(viz: Viz, params: Readonly<Record<string, ParamValue>>): number {
  for (const spec of viz.params) {
    if (spec.kind !== 'seed') continue;
    const value = params[spec.key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return FALLBACK_SEED;
}

/**
 * Is the focus inside something `teardown()` is about to destroy?
 *
 * A removed element takes the focus with it: `document.activeElement` falls
 * back to `<body>` and the next Tab restarts from the masthead, twenty controls
 * above where the reader was. It is the same failure shell.ts and story.ts
 * refuse `disabled` to avoid, and a hash change — the Back button, a pasted
 * link — reaches it with the focus still in the rail.
 */
function focusInsideRoute(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  const hosts = [
    regions.stage,
    regions.controls,
    regions.transport,
    regions.readouts,
    regions.story,
    regions.facts,
  ];
  return hosts.some((host) => host.contains(active));
}

function activate(viz: Viz, route: Route): void {
  const token = ++generation;
  const refocus = focusInsideRoute();
  // The reader has moved; a fragment stepped off before this is no longer the
  // one a Forward press would land on.
  steppedBackFrom = null;
  teardown();

  activeViz = viz;
  regions.title.textContent = viz.title;
  setProse(regions.blurb, viz.blurb);
  shell.setActiveTab(viz.id);

  const host = regions.stage;
  const st = createStage(host);
  if (!st) {
    // A browser that will not give out a 2D context — a canvas-blocking privacy
    // extension, iOS Safari past its canvas-memory ceiling, a crashed GPU
    // process. This used to throw out of createStage(), past a teardown() that
    // had already emptied the bench, and leave a blank white plate with no
    // message on this and every subsequent tab. Saying so is a first-class
    // outcome of a route; a dead shell is not.
    host.append(
      h(
        'p',
        { class: 'stage__unavailable' },
        'This visualization needs a 2D canvas, which this browser did not provide.',
      ),
    );
    syncUrl();
    announce(`${viz.title}.`);
    if (refocus) shell.focusActiveTab();
    return;
  }
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
  transport = createTransport(regions.transport, transportCallbacks, {
    reducedMotion,
    seeded: viz.params.some((spec) => spec.kind === 'seed'),
  });

  unResize = st.onResize((width, height) => {
    // The resize already wiped both bitmaps; the background is ours to repaint.
    ctx.width = width;
    ctx.height = height;
    inst.drawBackground?.();
    // Through `advance()`, not a bare draw: a visualization whose geometry
    // really did change may have had to discard what it had computed for the
    // old plate, and with nothing running — a reduced-motion reader — the plate
    // would then stay empty under a stopped transport with no way back except
    // a key the reader has to guess at.
    advance();
  });


  // The plate and the ledger before anything asynchronous: a webfont request
  // that is blackholed rather than refused is a promise that never settles, so
  // painting behind one leaves both canvases blank and the ledger empty for the
  // life of the tab, with the transport claiming a run is going. Whatever face
  // is available is legible; the network is not allowed to gate the first paint.
  inst.drawBackground?.();
  inst.draw();

  // §7: the background layer is repainted only on init, resize and parameter
  // change, so with `display=swap` the axis numerals would otherwise stay in the
  // fallback face for the life of the tab. `fonts.load()` is also what *asks*
  // for the face — canvas text never triggers a load — and `fonts.ready` covers
  // a face that arrives after it.
  // Reduced motion opens on the completed state of the default configuration
  // and waits for Play; a run the reader starts is still permitted.
  if (reducedMotion) {
    settle();
    setRunning(false);
  } else {
    engine.start();
    setRunning(true);
  }

  // Registered *after* the settle, only when the face is actually missing, and
  // at most one repaint whichever promise lands first.
  //
  // `drawBackground()` is a repaint and the shell may ask for one at any moment
  // (see `VizInstance`) — but "may" is not "should". A tab that accumulates onto
  // the background layer, as the bifurcation sweep does, has to rebuild
  // everything it has drawn there to honour the call, and the shell was asking
  // for that twice on every single load whether the lettering had changed or
  // not: `fonts.load()` and `fonts.ready` both resolve on a warm cache, one
  // microtask after the settle that had just computed 4.6 million iterations.
  // Asking only when the first paint actually went out in the fallback face
  // leaves nothing to rebuild on the common path, and the bifurcation tab's own
  // geometry comparison covers the cold one.
  //
  // Capturing `inst` here meant each promise held a strong reference to the
  // whole visualization — its context, both canvas bitmaps, every typed array —
  // until it settled, and a blackholed font request never settles. The
  // generation guard stopped the callback painting the wrong tab, but a guard
  // *inside* a callback cannot release the callback: twenty route changes
  // behind a hung fonts.gstatic.com retained forty canvases and 225 MB of
  // bitmap. Reading the module's own `instance` keeps the object collectable
  // the moment `teardown()` nulls it, whatever the network does.
  if (!faceIsLoaded(theme.labelFont)) {
    let repainted = false;
    const repaint = (): void => {
      if (token !== generation || repainted) return;
      const live = instance;
      if (!live) return;
      repainted = true;
      live.drawBackground?.();
      if (!engine.running) live.draw();
    };
    void withTimeout(ensureCanvasFont(theme.labelFont)).then(repaint);
    const ready = document.fonts?.ready;
    if (ready) void withTimeout(ready).then(repaint);
  }

  syncUrl();
  story?.setActive(matchingPresetId());
  // After the settle, so the opening sentence carries the numbers that are on
  // screen rather than the zeros the first reset() emitted. A settle that is
  // still running holds the sentence until it is not — see announce().
  announce(`${viz.title}.`);

  // The control the reader was in has just been destroyed with the old route.
  // The tab for the route that replaced it is where a tab widget puts focus
  // anyway, and it is one Tab away from the rail rather than twenty.
  if (refocus) shell.focusActiveTab();
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
 *
 * The first slice runs here, synchronously, so the opening state is never worse
 * than it was; the rest run a task apart, and calling this again cancels
 * whatever was still owed. That is what makes a knob turned during a settle one
 * settle rather than two of them interleaved on the same instance.
 */
function settle(): void {
  cancelSettle();
  if (!instance) return;
  settleTicks = 0;
  settleSpentMs = 0;
  settlePerTick = -1;
  settleFreeBatch = 0;
  // Baseline: the slices are measured against the state the run is in now, not
  // against whatever the previous settle left in the snapshot.
  emissionMoved();
  settleSlice();
}

/** Ticks and milliseconds spent so far, and the cost of a tick as last measured. */
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let settleTicks = 0;
let settleSpentMs = 0;
/** ms per tick: −1 before the probe has run, 0 for a batch that measured as free. */
let settlePerTick = -1;
/** The rung the free-batch escalation has reached; 0 before it has started. */
let settleFreeBatch = 0;

function cancelSettle(): void {
  settleTimer = clearTimer(settleTimer);
}

function settleSlice(): void {
  settleTimer = null;
  // Torn down, or the route replaced, between one slice and the next.
  if (!instance) {
    endSettle();
    return;
  }

  const sliceEnd = now() + Math.min(SETTLE_SLICE_MS, SETTLE_BUDGET_MS - settleSpentMs);
  while (settleTicks < SETTLE_MAX_TICKS && settleSpentMs < SETTLE_BUDGET_MS) {
    const left = sliceEnd - now();
    if (left <= 0) {
      // Out of slice but not out of budget: hand the thread back and carry on
      // in a later task. The plate already shows the run as far as it has got.
      settleTimer = setTimeout(settleSlice, 0);
      return;
    }

    const probing = settlePerTick < 0;
    const run = Math.min(batchFor(left), SETTLE_MAX_TICKS - settleTicks);
    const before = now();
    engine.fastForward(run);
    const spent = now() - before;
    settleSpentMs += spent;
    settleTicks += run;
    settlePerTick = spent > 0 ? spent / run : 0;

    // The probe is one tick, and one tick legitimately moves nothing on a tab
    // that lands a ball every few dozen of them — which is not the same
    // statement as "the experiment has finished". Its emission still becomes
    // the baseline the batch after it is measured against.
    if (!emissionMoved() && !probing) break;
  }
  endSettle();
}

/**
 * Nothing left to run. Whatever was waiting on the measurement — the route's
 * opening sentence, a preset's — is spoken here, against the numbers that are
 * now on the plate.
 */
function endSettle(): void {
  settleTimer = clearTimer(settleTimer);
  const prefix = pendingAnnouncement;
  pendingAnnouncement = null;
  if (prefix !== null) announce(prefix);
}

/**
 * What the last batch cost per tick is the only honest estimate of what the next
 * one will, so the next batch is whatever fits in the slice that is left.
 *
 * A batch that measured as free needs care, and used to get none: the one-tick
 * probe costs less than `performance.now()` can resolve on most tabs, so
 * `settlePerTick` came back 0 and the very next batch took the 4,800 cap — an
 * un-yielded run of 4,800 ticks chosen on the strength of a measurement that
 * said nothing. On a tab where that cost more than the 400 ms budget, the whole
 * settle happened inside it and the loop exited having never once handed the
 * thread back, which is the exact failure this scheduler exists to prevent. It
 * showed up as a test that passed on an idle machine and failed on a busy one.
 *
 * So an unmeasurable batch escalates instead of leaping: 64, 512, 4,096, cap.
 * Each rung is re-measured, and the first one the clock can actually see hands
 * over to the estimate above. Three rungs is enough to reach the cap on a tab
 * genuinely that cheap, and no single rung can spend a budget it has no evidence
 * it can afford.
 */
function batchFor(leftMs: number): number {
  if (settlePerTick < 0) return SETTLE_PROBE_TICKS;
  if (settlePerTick === 0) {
    settleFreeBatch =
      settleFreeBatch === 0
        ? SETTLE_FREE_BATCH_START
        : Math.min(SETTLE_MAX_BATCH_TICKS, settleFreeBatch * SETTLE_FREE_BATCH_GROWTH);
    return settleFreeBatch;
  }
  settleFreeBatch = 0;
  return Math.max(1, Math.min(SETTLE_MAX_BATCH_TICKS, Math.floor(leftMs / settlePerTick)));
}

/** The emission both "has anything moved?" tests are measured against. */
const watchedKeys: string[] = [];
const watchedValues: number[] = [];

/**
 * Has anything the visualization publishes changed since this was last asked?
 *
 * "Has the experiment finished?" is not a question the `Viz` contract answers,
 * and the readouts are the one thing every tab is required to produce — every
 * number drawn on a canvas also goes through `emit()` — so this is the shell's
 * only honest handle on it. The settle loop and the idle watchdog ask the same
 * question, and one definition of it is what keeps their answers the same.
 *
 * Allocation-free, because the watchdog asks once a frame. A reading that is NaN
 * counts as unchanged against itself: a tab that has not measured anything yet
 * emits NaN on every frame, and reading that as movement would keep both loops
 * running for a number that is never going to arrive.
 */
function emissionMoved(): boolean {
  let moved = latest.length !== watchedValues.length;
  for (let i = 0; i < latest.length; i++) {
    const readout = latest[i];
    if (!readout) continue;
    if (!moved && (watchedKeys[i] !== readout.key || !sameNumber(watchedValues[i], readout.value))) {
      moved = true;
    }
    watchedKeys[i] = readout.key;
    watchedValues[i] = readout.value;
  }
  watchedKeys.length = latest.length;
  watchedValues.length = latest.length;
  return moved;
}

function sameNumber(a: number | undefined, b: number): boolean {
  if (a === b) return true;
  return a !== undefined && Number.isNaN(a) && Number.isNaN(b);
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

/**
 * Is the in-canvas label face already available to paint with?
 *
 * The question is "will the first paint's lettering be the final lettering?",
 * and `fonts.check()` is the only thing that answers it without painting
 * twice to find out. False wherever the answer is not known — an engine with no
 * `FontFaceSet`, a shorthand its parser refuses — because asking for a repaint
 * that turns out to be unnecessary costs a repaint, while skipping one that was
 * necessary leaves the axis numerals in the fallback face for the life of the
 * tab.
 */
function faceIsLoaded(labelFont: string): boolean {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts || typeof fonts.check !== 'function') return false;
  try {
    return fonts.check(labelFont);
  } catch {
    return false;
  }
}

/** A promise the app does not own, bounded. See `FONT_WAIT_MS`. */
function withTimeout(promise: Promise<unknown>): Promise<void> {
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      setTimeout(resolve, FONT_WAIT_MS);
    }),
  ]);
}

/**
 * Put the reader on the canonical fragment for a route, without leaving a second
 * history entry that says what the entry before it already said.
 *
 * A fragment that names nothing, or names a real tab in the wrong case, arrives
 * as a *new* history entry: the browser pushed it the moment it was typed or
 * clicked, before any of this ran. Rewriting that entry in place is the obvious
 * correction and it is what `location.replace()` does — `router.navigate()`
 * cannot be used, because it pushes, and history would read
 * […, #/clt, #/galton] with Back landing on the unknown id and this branch
 * answering with another push, trapping the reader for the session.
 *
 * But when the corrected fragment is the one the previous entry already holds —
 * junk typed while the default tab is open, a stale `#/clt` link followed from
 * the tab it falls back to — the rewrite leaves two adjacent entries with the
 * same URL. Back then moves the reader onto the first of them and there is
 * nothing to change: no `hashchange` fires, nothing on the page moves, and the
 * press reads as broken. So the duplicate is stepped off instead of written.
 * Going back is safe here precisely because this path was reached from a
 * `hashchange`: a same-document navigation always has a same-document entry
 * behind it, and `syncUrl()` has kept that entry's fragment equal to the state
 * on screen. On the first route of a load there is no such guarantee, and the
 * entry is rewritten.
 *
 * A Forward press back into the fragment that was stepped off is not stepped off
 * a second time — that would be a reader pressing a key and nothing happening
 * again, in the other direction — so the second arrival takes the rewrite.
 */
function canonicalise(id: string, params: Record<string, string>, viaHistory: boolean): void {
  const hash = buildHash(id, params);
  const fragment = window.location.hash;
  if (viaHistory && hash === currentHash() && fragment !== steppedBackFrom && stepBack()) {
    steppedBackFrom = fragment;
    return;
  }
  const base = window.location.href.split('#')[0] ?? '';
  window.location.replace(`${base}${hash}`);
}

/** The fragment the last `stepBack()` moved off. Cleared by any real route change. */
let steppedBackFrom: string | null = null;

/**
 * Drop the current history entry by returning to the one behind it.
 *
 * `false` where there is nothing to call — an embedding that withholds
 * `history.back`, a host that is not a browser — so the caller can fall back to
 * rewriting the entry rather than leaving a fragment that names nothing.
 */
function stepBack(): boolean {
  const nav: Partial<History> | undefined = window.history;
  if (!nav || typeof nav.back !== 'function') return false;
  nav.back();
  return true;
}

/** The fragment the entry on screen holds — what `syncUrl()` last wrote. */
function currentHash(): string | null {
  const viz = activeViz;
  const ctx = vizCtx;
  if (!viz || !ctx) return null;
  return buildHash(viz.id, serializeParams(viz.params, ctx.params));
}

/**
 * The registry entry a fragment names, tolerating the ways a link gets mangled.
 *
 * `parseHash()` is deliberately tolerant of how a permalink is typed, pasted and
 * truncated, and the id deserves the same. `#/Lorenz` and `#/chaos_game` are
 * well-formed slugs that name a real visualization in every way except case and
 * punctuation, and resolving them as "unknown" sent the reader to a different
 * experiment *and* threw away every parameter in the query — `rho=40` and
 * `twinGap=1e-11` silently gone, with `location.replace()` destroying the
 * original fragment so they could not even see what they had typed.
 */
function resolveViz(id: string | null): Viz | undefined {
  if (id === null) return undefined;
  const exact = findViz(id);
  if (exact) return exact;
  const normalized = id.toLowerCase().replace(/_/g, '-');
  return registry.find((viz) => viz.id.toLowerCase() === normalized);
}

/**
 * Does this fragment describe the experiment that is already on screen?
 *
 * Asked of the *typed* parameters rather than of the two strings, because
 * `#/galton?rows=12` and `#/galton` are the same experiment when 12 is the
 * default: `coerceParams` then `serializeParams` is the one round trip the
 * router guarantees is a fixed point, so this answers for the run and not for
 * the spelling.
 */
function describesCurrentRoute(viz: Viz, params: Record<string, string>): boolean {
  const current = currentHash();
  if (current === null || viz.id !== activeViz?.id) return false;
  return buildHash(viz.id, serializeParams(viz.params, coerceParams(viz.params, params))) === current;
}

function onRoute(route: Route, viaHistory: boolean): void {
  const viz = resolveViz(route.id);
  if (!viz) {
    // An unknown or absent id resolves to the first tab, and the URL is
    // rewritten so the fragment always names the visualization on screen. A
    // stale link for an id that does not exist yet — registry.ts reserves
    // `clt` — is the ordinary way in.
    const fallback = registry[0];
    if (fallback) canonicalise(fallback.id, {}, viaHistory);
    return;
  }

  // Nothing to change: the Back press that lands on the entry a correction
  // stepped off, and the near-miss spelling of the tab already open, both arrive
  // here describing what is already running. Activating would tear a settled run
  // down and coerce every parameter back to its default to arrive where the page
  // already is.
  if (describesCurrentRoute(viz, route.params)) {
    if (viz.id !== route.id) canonicalise(viz.id, route.params, viaHistory);
    return;
  }

  // A near miss is canonicalised *carrying its parameters*: every key in the
  // query is a legal parameter of the visualization the reader named, so the
  // link still opens the run it was sent for.
  if (viz.id !== route.id) {
    canonicalise(viz.id, route.params, viaHistory);
    return;
  }
  activate(viz, route);
}

// Every later call comes from the router's own listener, which fires for a
// `hashchange` and for a navigation the address bar refused — both of them
// inside this document. The first call is the load, where there is no such
// guarantee about the entry behind us.
router.subscribe((route) => {
  onRoute(route, true);
});
onRoute(router.route, false);

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

motionQuery?.addEventListener('change', (event) => {
  reducedMotion = event.matches;
  if (vizCtx) vizCtx.reducedMotion = reducedMotion;
  if (reducedMotion && engine.running) {
    engine.stop();
    // The reader asked for the motion to stop; nothing may start it again.
    autoStopped = false;
    setRunning(false);
  }
});

