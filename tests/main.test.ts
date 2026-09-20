import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  byClass,
  byLabel,
  fire,
  installDom,
  type FakeContext,
  type Harness,
  type MElement,
} from './dom-harness';

/**
 * The route lifecycle.
 *
 * These are the defects that are sequences rather than values — a first paint
 * that waits on the network, a selection that tears the route down, a control
 * change that resets a run it did not change, a fallback that pushes where it
 * must replace. None of them is visible in a pure function, so they are
 * asserted against the real `src/main.ts`, booted on the small document in
 * `dom-harness.ts`.
 */

let dom: Harness;

/** Let every queued microtask run, so an asynchronous route would have landed. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Boot the app on a fresh document at `hash`, with the label face available. */
async function boot(hash: string, prepare?: (harness: Harness) => void): Promise<void> {
  vi.resetModules();
  dom = installDom({ hash });
  dom.fonts.resolve();
  prepare?.(dom);
  await import('../src/main');
  // The first paint is synchronous; the font repaint is a microtask behind it.
  await tick();
}

/**
 * Advance the simulation. `requestAnimationFrame` never fires here, and it is
 * not supposed to: Fast-forward is the shell's own motion-free advance and the
 * one a reduced-motion reader uses.
 */
function fastForward(times = 4): void {
  const key = byLabel(dom, 'Fast-forward');
  if (!key) throw new Error('no Fast-forward key');
  for (let i = 0; i < times; i++) fire(key, 'click');
  // The ledger writes at 10 Hz with a trailing edge, so the last batch is
  // sitting in its throttle timer — and Fast-forward is a gesture, so the live
  // region narrates it on a trailing debounce of its own. Both have to land
  // before the readouts are read, or the next timer advance moves them.
  vi.advanceTimersByTime(600);
}

// The router coalesces its URL writes behind a 150 ms timer. Under real timers
// that timer outlives the test and fires into a document that has been taken
// away, so the clock is ours for the duration.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // A stubbed clock left in place would decide the next test's scheduler.
  vi.unstubAllGlobals();
  // The harness's `window` is one object across installs, so a stub left on it
  // would silently decide the next test's environment.
  const history = dom?.window.history as unknown as Record<string, unknown> | undefined;
  if (history) delete history['back'];
  dom?.teardown();
});

// ---------------------------------------------------------------------------
// Reading the page back
// ---------------------------------------------------------------------------

function layer(name: 'stage__bg' | 'stage__fg'): FakeContext {
  const canvas = byClass(dom, name)[0];
  if (!canvas) throw new Error(`no .${name} on the stage`);
  return canvas.getContext('2d') as FakeContext;
}

/** The ledger's text — the accessible representation of every drawn number. */
function ledger(): string {
  return byClass(dom, 'readouts')[0]?.textContent ?? '';
}

/** The hero count, read back out of the ledger the way a reader would. */
function ballsLanded(): number {
  const match = /Balls landed\s*([\d,]+)/.exec(ledger());
  if (!match?.[1]) throw new Error('no "Balls landed" row in the ledger');
  return Number(match[1].replace(/,/g, ''));
}

/**
 * The permalink the page is currently naming. The Share key that used to carry
 * it is gone — the address bar already holds the link — so the attribute now
 * rides a carrier that paints nothing on screen and is rendered only by print.
 */
function permalink(): string {
  return byClass(dom, 'permalink')[0]?.getAttribute('data-permalink') ?? '';
}

function tab(title: string): MElement {
  const found = dom.findAll((el) => el.getAttribute('role') === 'tab').find((el) =>
    (el.getAttribute('aria-label') ?? '').startsWith(title),
  );
  if (!found) throw new Error(`no tab for ${title}`);
  return found;
}

/** The "Try:" chip carrying `label`. */
function chip(label: string): MElement {
  const found = byClass(dom, 'story__chip').find((el) => el.textContent === label);
  if (!found) throw new Error(`no chip for ${label}`);
  return found;
}

/** The label of the lit chip, if any. */
function currentChip(): string | undefined {
  return byClass(dom, 'story__chip')
    .filter((el) => el.getAttribute('aria-pressed') === 'true')
    .map((el) => el.textContent)[0];
}

// ---------------------------------------------------------------------------

describe('first paint', () => {
  it('paints both layers and fills the ledger before the label face settles', async () => {
    // A blackholed fonts.gstatic.com is a promise that never settles, not a
    // rejection, so a try/catch cannot rescue an `await` in front of the first
    // paint: both canvases stayed blank and the ledger empty for the life of
    // the tab, while the transport read "Pause" over a running engine.
    await boot('#/galton', (harness) => harness.fonts.hang());

    expect(layer('stage__bg').calls.length).toBeGreaterThan(0);
    expect(layer('stage__fg').calls.length).toBeGreaterThan(0);
    expect(ledger()).toMatch(/Balls landed/);
    // The transport's claim and what is on the plate have to agree.
    expect(byClass(dom, 'transport')[0]?.dataset['running']).toBe('true');
  });

  it('does not start the engine over a Pause pressed while the face is in flight', async () => {
    // The transport is mounted before the face is asked for, so it is live for
    // the whole wait. With the paint behind an `await`, a Pause pressed in that
    // window was discarded: the tail of activate() ran `engine.start()` when the
    // font landed and the tab started running by itself.
    vi.resetModules();
    dom = installDom({ hash: '#/galton' });
    const deliverFace = dom.fonts.defer();
    await import('../src/main');
    const transport = byClass(dom, 'transport')[0];
    const play = byClass(dom, 'transport__play')[0];

    fire(play as MElement, 'click');
    expect(transport?.dataset['running']).toBe('false');

    deliverFace();
    await tick();

    expect(transport?.dataset['running']).toBe('false');
  });

  it('repaints the background once the face arrives', async () => {
    await boot('#/galton');
    const before = layer('stage__bg').calls.length;
    // `fonts.load()` resolving is the shell's cue to repaint the axis numerals,
    // which are painted on the background layer and nowhere else.
    await Promise.resolve();
    expect(layer('stage__bg').calls.length).toBeGreaterThanOrEqual(before);
  });
});

describe('the scheme key and the plate', () => {
  /**
   * Scheme-dependent pens, the way theme.css supplies them. Every colour token
   * answers with the scheme's own sentinel, so whichever pen a tab reaches for
   * last, its value says which scheme it was read in.
   */
  function stubSchemePens(harness: Harness): void {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals['getComputedStyle'] = () => ({
      position: '',
      getPropertyValue: (name: string): string => {
        if (name === '--canvas-label-font') return '12px system-ui, sans-serif';
        if (name === '--canvas-line-width') return '1';
        if (name === '--canvas-particle-radius') return '2';
        if (!name.startsWith('--')) return '';
        return harness.document.documentElement.getAttribute('data-theme') === 'dark'
          ? DARK_PEN
          : LIGHT_PEN;
      },
    });
  }

  const LIGHT_PEN = 'rgb(17, 17, 17)';
  const DARK_PEN = 'rgb(238, 238, 238)';

  /** Every pen currently loaded on the background layer. */
  function backgroundPens(): string[] {
    const bg = layer('stage__bg') as unknown as Record<string, unknown>;
    return [bg['strokeStyle'], bg['fillStyle']].filter(
      (pen): pen is string => typeof pen === 'string',
    );
  }

  it('repaints the apparatus in the new scheme instead of leaving it invisible', async () => {
    // The owner's report, in one test: he toggled to dark and the Galton pegs
    // went. A `<canvas>` keeps the pens it was painted with, the apparatus all
    // lives on the background layer, and that layer repaints only on init,
    // resize and parameter change — so the pens stayed light over a bed that
    // had gone to #0e1214. A page *loaded* dark was always right, which is why
    // the tokens looked innocent and the defect looked like a colour choice.
    await boot('#/galton', stubSchemePens);
    expect(backgroundPens().every((pen) => pen === LIGHT_PEN)).toBe(true);

    const before = backgroundPaints();
    fire(byLabel(dom, 'Dark scheme') as MElement, 'click');

    expect(dom.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(backgroundPaints()).toBeGreaterThan(before);
    expect(backgroundPens()).not.toHaveLength(0);
    expect(backgroundPens().every((pen) => pen === DARK_PEN)).toBe(true);
  });

  it('follows the OS, not only the masthead key, and on more than one tab', async () => {
    // The reader who has never pressed the key is still following the OS, and
    // that is a different code path through the shell. Arcsine rather than
    // Galton because the complaint was made about four tabs, and the axes here
    // are painted by the same once-only background pass.
    await boot('#/arcsine', stubSchemePens);
    expect(backgroundPens().every((pen) => pen === LIGHT_PEN)).toBe(true);

    const before = backgroundPaints();
    dom.setMedia('(prefers-color-scheme: dark)', true);

    expect(dom.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(backgroundPaints()).toBeGreaterThan(before);
    expect(backgroundPens()).not.toHaveLength(0);
    expect(backgroundPens().every((pen) => pen === DARK_PEN)).toBe(true);
  });

  it('does not restart a finished run over a change of ink', async () => {
    // A resize goes through advance(), because the geometry really did change
    // and what was computed for the old plate may be worthless. A scheme change
    // is not that: nothing about the simulation moved, and restarting would
    // throw away a measurement the reader was reading.
    await boot('#/galton?rows=12&balls=400');
    fastForward(8);
    const landed = ballsLanded();
    expect(landed).toBeGreaterThan(0);

    fire(byLabel(dom, 'Dark scheme') as MElement, 'click');
    vi.advanceTimersByTime(600);

    expect(ballsLanded()).toBe(landed);
  });
});

describe('selecting the visualization already on screen', () => {
  it('is a no-op: the parameters, the run and the permalink survive', async () => {
    await boot('#/galton?rows=16&balls=5000');
    fastForward();
    const landed = ledger();
    expect(landed).not.toMatch(/Balls landed\s*0(?!\d)/);
    const writes = dom.history.length;

    fire(tab('Galton Board'), 'click');
    await tick();
    vi.advanceTimersByTime(250);

    // Nothing was navigated, so nothing was torn down and coerced to defaults.
    expect(dom.history.length).toBe(writes);
    expect(ledger()).toBe(landed);
    expect(permalink()).toContain('rows=16');
    expect(permalink()).toContain('balls=5000');
  });

  it('is a no-op from the wordmark too', async () => {
    await boot('#/galton?rows=16&balls=5000');
    const wordmark = byClass(dom, 'masthead__wordmark')[0];
    expect(wordmark?.getAttribute('href')).toBe('#/galton');

    const event = fire(wordmark as MElement, 'click', { button: 0 });
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(permalink()).toContain('rows=16');
    expect(permalink()).toContain('balls=5000');
  });

  it('still switches to a different visualization', async () => {
    await boot('#/galton?rows=20');
    fire(tab("Buffon's Needle"), 'click');
    await tick();

    expect(permalink()).toContain('#/buffon');
    expect(ledger()).toMatch(/Drops/);
  });
});

describe('a control change that changes nothing', () => {
  it('leaves the run alone when a control re-reports the value in force', async () => {
    // A stepper key at its own limit clamps back to the value already in force
    // — the keys deliberately stay enabled at the ends — and a log fader's dead
    // travel reports the same non-change. Resetting for one throws a finished
    // run away for a keystroke that changed nothing.
    await boot('#/galton?rows=16&balls=5000');
    fastForward();
    const landed = ballsLanded();
    expect(landed).toBeGreaterThan(0);
    const writes = dom.history.length;

    // Sixteen is the board's ceiling; the key has nowhere to go.
    fire(byLabel(dom, 'Increase Rows') as MElement, 'click');
    fastForward(1);

    // The run carried on from where it was, and the URL was never rewritten.
    expect(ballsLanded()).toBeGreaterThan(landed);
    expect(dom.history.length).toBe(writes);
    expect(permalink()).toContain('rows=16');
  });

  it('carries no seed field in the rail', async () => {
    await boot('#/buffon?seed=7');
    expect(byClass(dom, 'seed__input')).toEqual([]);
    expect(byClass(dom, 'control').some((el) => el.textContent.includes('Seed'))).toBe(false);
    // The seed still names the run in the URL, and Shuffle is how it changes.
    expect(permalink()).toContain('seed=7');
    expect(byLabel(dom, 'Shuffle')).toBeDefined();
  });

  it('still restarts the run for a change that is a change', async () => {
    await boot('#/galton?rows=16&balls=5000');
    fastForward();
    const landed = ballsLanded();
    // Sixteen rows of pegs deal into seventeen bins.
    expect(ledger()).toMatch(/Bins\s*17(?!\d)/);

    fire(byLabel(dom, 'Decrease Rows') as MElement, 'click');
    // A running engine paints on its next frame; Fast-forward is that frame.
    fastForward(1);

    expect(permalink()).toContain('rows=15');
    expect(ledger()).toMatch(/Bins\s*16(?!\d)/);
    expect(ballsLanded()).toBeLessThan(landed);
  });
});

describe('an unknown route', () => {
  it('replaces the entry instead of pushing one', async () => {
    // registry.ts reserves `clt` for a tab that does not exist yet, so a stale
    // link for it is the ordinary way in. Pushing left history as
    // [#/clt, #/galton]: Back returned to #/clt, which pushed #/galton again.
    await boot('#/clt');

    const pushes = dom.history.filter((entry) => entry.kind === 'push');
    expect(pushes).toEqual([]);
    expect(dom.history[0]?.kind).toBe('replace');
    expect(dom.history[0]?.url).toContain('#/galton');
    expect(ledger()).toMatch(/Balls landed/);
  });
});

describe('focus across a route change', () => {
  it('lands on the tab, not on <body>', async () => {
    await boot('#/buffon');
    const shuffle = byLabel(dom, 'Shuffle');
    expect(shuffle, 'the transport has a Shuffle key').toBeDefined();
    shuffle?.focus();

    // The Back button: a hash change with the focus still in the rail.
    dom.window.location.hash = '#/dla';
    await Promise.resolve();

    expect(dom.document.activeElement).not.toBe(dom.document.body);
    expect(dom.document.activeElement?.getAttribute('role')).toBe('tab');
    expect(dom.document.activeElement?.getAttribute('aria-selected')).toBe('true');
  });

  it('leaves the focus alone when it was never inside the route', async () => {
    await boot('#/galton');
    const wordmark = byClass(dom, 'masthead__wordmark')[0];
    wordmark?.focus();

    dom.window.location.hash = '#/buffon';
    await Promise.resolve();

    expect(dom.document.activeElement).toBe(wordmark);
  });
});

describe('the "Try:" chips', () => {
  it('light the preset that is actually in force', async () => {
    await boot('#/buffon?ratio=0.3');
    expect(currentChip()).toBe('Short needle');
  });

  it('light nothing when the state is a preset plus an edit', async () => {
    // "Short needle" declares only `ratio`. With the line spacing edited as
    // well, a scan for "is every declared value in force?" would still answer
    // with that chip, and the caption would then describe an experiment that
    // is not the one on the plate.
    await boot('#/buffon?ratio=0.3&spacing=128');
    expect(currentChip()).toBeUndefined();
  });

  it('stay lit across a new draw of the same configuration', async () => {
    // A seed names the run, not the configuration: Shuffle is "the same preset
    // again, with another draw".
    await boot('#/buffon');
    fire(chip('Short needle'), 'click');
    expect(currentChip()).toBe('Short needle');

    fire(byLabel(dom, 'Shuffle') as MElement, 'click');

    expect(permalink()).toMatch(/seed=/);
    expect(currentChip()).toBe('Short needle');
  });

  it('go dark after an edit, whichever chip was lit before it', async () => {
    await boot('#/buffon');
    fire(chip('Short needle'), 'click');
    expect(currentChip()).toBe('Short needle');
    fire(chip('Full length'), 'click');
    expect(currentChip()).toBe('Full length');

    // Any control change rescans. The state is no longer any preset, so no
    // chip is lit — least of all an earlier one.
    fire(byLabel(dom, 'Increase Line spacing') as MElement, 'click');
    expect(currentChip()).toBeUndefined();
  });

  it('show at most three', async () => {
    await boot('#/galton');
    expect(byClass(dom, 'story__chip')).toHaveLength(3);
  });
});

const REDUCED = '(prefers-reduced-motion: reduce)';

/** Boot with the reader's motion preference already set, the way a cold load finds it. */
async function bootReduced(hash: string): Promise<void> {
  await boot(hash, (harness) => {
    harness.setMedia(REDUCED, true);
  });
}

/** Run every settle slice still owed, and the ledger's throttle behind them. */
function settleFully(): void {
  vi.advanceTimersByTime(3000);
}

/**
 * A clock that advances one millisecond per reading, replacing the machine's.
 *
 * `settleSlice()` reads the clock four times around each batch and decides
 * whether to yield from the difference, so under the real clock what it decides
 * is a property of how busy the machine is. One millisecond a reading is enough
 * for the 24 ms slice to expire after a fixed number of batches, which puts the
 * yield in the same place on a loaded CI box as on an idle laptop.
 */
function stepClock(): void {
  let reading = 0;
  vi.stubGlobal('performance', { now: () => (reading += 1) });
}

/**
 * A clock that never advances, so the settle spends no budget and runs to its
 * tick ceiling instead of its time ceiling.
 *
 * The settle is bounded by 400 ms of REAL wall time, so how much of a run it
 * finishes is a property of how busy the machine is. A test that asserts a
 * measurement exists afterwards is then asserting machine speed: under a
 * parallel suite the Galton board landed no balls at all and the test failed at
 * random. Freezing the clock removes the time ceiling and leaves
 * `SETTLE_MAX_TICKS`, which is a fixed number, so these tests measure what the
 * settle GUARANTEES rather than what a fast laptop happens to get through.
 *
 * Not for the slicing test above, which needs the budget to expire — that one
 * wants `stepClock()`.
 */
function frozenClock(): void {
  vi.stubGlobal('performance', { now: () => 0 });
}

/** The page's one live region. */
function summary(): string {
  return byClass(dom, 'readouts__summary')[0]?.textContent ?? '';
}

/** How many times the background layer has been repainted from the top. */
function backgroundPaints(): number {
  return layer('stage__bg').calls.filter((call) => call === 'clearRect').length;
}

describe('the reduced-motion settle', () => {
  it('runs in slices rather than holding the main thread for the whole budget', async () => {
    // The cluster grows on every tick, so this settle never finishes early: it
    // spends the entire budget, which is what makes it the honest case. The
    // opening sentence is the observable — it is held until the measurement it
    // describes exists — so finding it unspoken here means slices were still
    // owed when activate() returned, instead of 400 ms of frozen page.
    //
    // The clock is the test's, not the machine's. Read against real
    // `performance.now()` this asserted on how fast the box happened to be: the
    // settle scheduler decides when to yield by measuring itself, so on a
    // loaded machine one batch could outrun the 400 ms budget and the settle
    // finished inside activate() with nothing owed — a genuine failure of the
    // thing being asserted, arriving at random. A clock that advances a
    // millisecond per reading makes the slice boundary land in the same place
    // every run, on every machine.
    stepClock();
    await bootReduced('#/dla');
    expect(summary()).toBe('');

    settleFully();

    expect(summary()).toMatch(/^Diffusion/);
  });

  it('re-settles after a knob instead of leaving the page unmeasured', async () => {
    frozenClock();
    // A reduced-motion reader gets no autoplay, so a control that restarts the
    // run and walks away leaves an empty plate and a 40 px em dash — under a
    // permalink whose own fresh load settles. Same URL, two different screens.
    await bootReduced('#/galton?rows=12&balls=500');
    settleFully();
    expect(ballsLanded()).toBeGreaterThan(0);

    fire(byLabel(dom, 'Decrease Rows') as MElement, 'click');
    settleFully();

    expect(permalink()).toContain('rows=11');
    expect(ledger()).toMatch(/Bins\s*12(?!\d)/);
    expect(ballsLanded()).toBeGreaterThan(0);
  });

  it('re-settles after a story chip', async () => {
    frozenClock();
    await bootReduced('#/buffon');
    settleFully();

    fire(chip('Short needle'), 'click');
    settleFully();

    expect(currentChip()).toBe('Short needle');
    expect(ledger()).not.toMatch(/Drops\s*0(?!\d)/);
  });
});

describe('the live region', () => {
  it('reports a result reached with Fast-forward', async () => {
    // Step and Fast-forward are the only way a reduced-motion reader advances
    // anything, and they were the only transport keys that never spoke: the
    // region held "not measured yet" for the life of the tab while the hero
    // showed a converged reading and the ledger showed five hundred balls.
    await boot('#/galton');
    expect(summary()).toMatch(/not measured yet/);

    fastForward();

    expect(summary()).not.toMatch(/not measured yet/);
    expect(summary()).toMatch(/\d/);
  });
});

describe('a run that has finished', () => {
  it('stops the loop and puts the running indicator out', async () => {
    // A queued animation frame carries no elapsed time under this harness, so
    // the frames below advance nothing — which is exactly the "no new numbers"
    // a finished experiment produces, and what the watchdog counts.
    await boot('#/galton?rows=12&balls=100');
    const transport = byClass(dom, 'transport')[0];
    expect(transport?.dataset['running']).toBe('true');

    fastForward(24);
    const landed = ballsLanded();
    expect(landed).toBe(100);

    for (let i = 0; i < 60; i++) dom.flushFrames();
    expect(transport?.dataset['running'], 'one second of stillness is not a finish').toBe('true');

    for (let i = 0; i < 90; i++) dom.flushFrames();
    expect(transport?.dataset['running']).toBe('false');
    // Stopping is not resetting: the measurement stays on the page.
    expect(ballsLanded()).toBe(landed);
    expect(summary()).not.toMatch(/not measured yet/);
  });

  it('puts the loop back for the next experiment', async () => {
    // Stopping a finished run is not the same thing as the reader pausing it,
    // and a knob turned afterwards is a new experiment. Treating the two alike
    // left a fresh empty board under a key reading "Play" — the reduced-motion
    // defect this file has one rule for, handed to everybody else.
    await boot('#/galton?rows=12&balls=100');
    fastForward(24);
    for (let i = 0; i < 150; i++) dom.flushFrames();
    const transport = byClass(dom, 'transport')[0];
    expect(transport?.dataset['running']).toBe('false');

    fire(byLabel(dom, 'Decrease Rows') as MElement, 'click');
    // The ledger writes at 10 Hz with a trailing edge; the reset is in it.
    vi.advanceTimersByTime(200);

    expect(transport?.dataset['running']).toBe('true');
    expect(ballsLanded()).toBeLessThan(100);
  });

  it('stays stopped when the reader was the one who stopped it', async () => {
    await boot('#/galton?rows=12&balls=5000');
    fire(byClass(dom, 'transport__play')[0] as MElement, 'click');
    const transport = byClass(dom, 'transport')[0];
    expect(transport?.dataset['running']).toBe('false');

    fire(byLabel(dom, 'Decrease Rows') as MElement, 'click');

    expect(transport?.dataset['running']).toBe('false');
  });

  it('keeps running while the readings are still moving', async () => {
    await boot('#/galton?rows=12&balls=5000');
    const transport = byClass(dom, 'transport')[0];

    for (let i = 0; i < 100; i++) dom.flushFrames();
    fastForward(1);
    for (let i = 0; i < 100; i++) dom.flushFrames();

    expect(transport?.dataset['running']).toBe('true');
  });
});

describe('the label face', () => {
  it('asks for no repaint when the face is already loaded', async () => {
    // The shell may ask for a background repaint at any moment and every tab has
    // to survive one — but a tab that accumulates onto that layer, as the
    // bifurcation sweep does, has to rebuild every column it has drawn there to
    // honour it. On a warm cache the lettering it would be rebuilt for is the
    // lettering already on the plate.
    await boot('#/galton', (harness) => {
      harness.document.fonts = {
        load: () => Promise.resolve([]),
        ready: Promise.resolve(),
        check: () => true,
      };
    });
    const painted = backgroundPaints();
    expect(painted).toBeGreaterThan(0);

    await tick();

    expect(backgroundPaints()).toBe(painted);
  });

  it('repaints once, not twice, when the face was missing', async () => {
    let deliver = (): void => undefined;
    await boot('#/galton', (harness) => {
      deliver = harness.fonts.defer();
    });
    const once = backgroundPaints();
    expect(once).toBeGreaterThan(0);

    deliver();
    await tick();

    // `fonts.load()` and `fonts.ready` both resolve for one arriving face.
    expect(backgroundPaints()).toBe(once * 2);
  });
});

describe('a fragment that names the state already on screen', () => {
  it('keeps the run and the parameters when only the spelling is wrong', async () => {
    await boot('#/galton?rows=16&balls=5000');
    fastForward();
    const measured = ledger();
    expect(measured).not.toMatch(/Balls landed\s*0(?!\d)/);

    dom.window.location.hash = '#/Galton?rows=16&balls=5000';
    await tick();
    vi.advanceTimersByTime(250);

    expect(permalink()).toContain('rows=16');
    expect(ledger()).toBe(measured);
  });

  it('steps off the duplicate entry rather than leaving a dead Back press', async () => {
    // Typing junk while the fallback tab is open pushes an entry that the
    // correction then rewrites to the fragment the entry *behind* it already
    // holds. Back lands on that one, no hashchange fires, nothing moves, and the
    // press reads as broken.
    await boot('#/galton');
    const back = vi.fn();
    (dom.window.history as unknown as Record<string, unknown>)['back'] = back;
    const entries = dom.history.length;

    dom.window.location.hash = '#junk';
    await tick();

    expect(back).toHaveBeenCalledTimes(1);
    expect(dom.history).toHaveLength(entries + 1);
    expect(dom.history[entries]?.kind).toBe('push');
  });

  it('rewrites the entry where there is no way back', async () => {
    await boot('#/galton');
    const entries = dom.history.length;

    dom.window.location.hash = '#junk';
    await tick();

    const written = dom.history.slice(entries);
    expect(written.some((e) => e.kind === 'replace' && e.url.endsWith('#/galton'))).toBe(true);
    // And the tab that was already open was not torn down to arrive where it is.
    expect(ledger()).toMatch(/Balls landed/);
  });
});

describe('the readouts', () => {
  it('open on one plain sentence, with nothing left to open', async () => {
    await boot('#/galton');
    fastForward();
    const hero = byClass(dom, 'hero')[0];
    expect(hero?.textContent).not.toMatch(/analytic|converged|residual/i);
    // The disclosure is gone: no summary, no line offering to show anything.
    expect(byClass(dom, 'exact__summary')).toHaveLength(0);
    expect(byClass(dom, 'readouts')[0]?.textContent).not.toMatch(/Show the exact numbers/);
    // The table it used to open still exists, unrendered, because it is the
    // accessible representation of a canvas nothing else describes.
    expect(byClass(dom, 'ledger')[0]?.textContent).toMatch(/Balls landed/);
    expect(byClass(dom, 'ledger')[0]?.textContent).toMatch(/Bins/);
  });

  it('speak the same plain words on pause', async () => {
    await boot('#/galton');
    fastForward();
    fire(byClass(dom, 'transport__play')[0] as MElement, 'click');
    const spoken = byClass(dom, 'readouts__summary')[0]?.textContent ?? '';
    expect(spoken).toMatch(/^Paused\./);
    expect(spoken).not.toMatch(/analytic|converged/i);
  });
});
