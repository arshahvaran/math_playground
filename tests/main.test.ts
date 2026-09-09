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
  // sitting in its throttle timer.
  vi.advanceTimersByTime(250);
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

function permalink(): string {
  return byClass(dom, 'caption')[0]?.getAttribute('data-permalink') ?? '';
}

function tab(title: string): MElement {
  const found = dom.findAll((el) => el.getAttribute('role') === 'tab').find((el) =>
    (el.getAttribute('aria-label') ?? '').startsWith(title),
  );
  if (!found) throw new Error(`no tab for ${title}`);
  return found;
}

function currentStep(): string | undefined {
  return dom
    .findAll((el) => el.getAttribute('aria-current') === 'step')
    .map((el) => el.getAttribute('aria-label') ?? '')[0];
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

describe('selecting the visualization already on screen', () => {
  it('is a no-op: the parameters, the run and the permalink survive', async () => {
    await boot('#/galton?rows=20&p=0.7&seed=7');
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
    expect(permalink()).toContain('rows=20');
    expect(permalink()).toContain('p=0.7');
    expect(permalink()).toContain('seed=7');
  });

  it('is a no-op from the wordmark too', async () => {
    await boot('#/galton?rows=20&seed=7');
    const wordmark = byClass(dom, 'masthead__wordmark')[0];
    expect(wordmark?.getAttribute('href')).toBe('#/galton');

    const event = fire(wordmark as MElement, 'click', { button: 0 });
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(permalink()).toContain('rows=20');
    expect(permalink()).toContain('seed=7');
  });

  it('is a no-op from the index select', async () => {
    await boot('#/galton?rows=20');
    const select = byClass(dom, 'tabs__select')[0];
    expect(select?.value).toBe('galton');

    fire(select as MElement, 'change');
    await tick();

    expect(permalink()).toContain('rows=20');
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
    // The seed field commits on `change` whether or not the number moved, which
    // is what select-all-and-retype produces; a stepper key at its own limit and
    // a log fader's dead travel report the same non-change. Resetting for one
    // throws a finished run away for a keystroke that changed nothing.
    await boot('#/galton?rows=20&balls=20000&dropRate=400&seed=7');
    fastForward();
    const landed = ballsLanded();
    expect(landed).toBeGreaterThan(0);
    const writes = dom.history.length;
    const seed = byClass(dom, 'seed__input')[0] as MElement;
    expect(seed.value).toBe('7');

    fire(seed, 'change');
    fastForward(1);

    // The run carried on from where it was, and the URL was never rewritten.
    expect(ballsLanded()).toBeGreaterThan(landed);
    expect(dom.history.length).toBe(writes);
    expect(permalink()).toContain('seed=7');
  });

  it('still restarts the run for a change that is a change', async () => {
    await boot('#/galton?rows=20&balls=20000&dropRate=400');
    fastForward();
    const landed = ballsLanded();
    // Twenty rows of pegs deal into twenty-one bins.
    expect(ledger()).toMatch(/Bins\s*21(?!\d)/);

    fire(byLabel(dom, 'Decrease Rows') as MElement, 'click');
    // A running engine paints on its next frame; Fast-forward is that frame.
    fastForward(1);

    expect(permalink()).toContain('rows=19');
    expect(ledger()).toMatch(/Bins\s*20(?!\d)/);
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
    await boot('#/galton');
    const randomize = byClass(dom, 'seed__random')[0];
    expect(randomize, 'the rail has a Randomize key').toBeDefined();
    randomize?.focus();

    // The Back button: a hash change with the focus still in the rail.
    dom.window.location.hash = '#/buffon';
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

describe('story mode', () => {
  it('lights the preset that is actually in force', async () => {
    await boot('#/buffon?ratio=0.3');
    expect(currentStep()).toBe('Step 2: Short needle');
  });

  it('lights nothing when the state is a preset plus an edit', async () => {
    // "Short needle" declares only `ratio`, on top of the two values "Slow
    // motion" sets. A scan for "is every declared value in force?" answers with
    // step 1 for a state that is really step 2 plus step 1's inheritance, and
    // the tape then captions the plate with the wrong experiment.
    await boot('#/buffon?ratio=0.3&dropRate=2&maxDrops=200');
    expect(currentStep()).toBeUndefined();
  });

  it('keeps the step lit across a new draw of the same configuration', async () => {
    // A seed names the run, not the configuration: Randomize is "the same
    // preset again, with another draw".
    await boot('#/galton');
    fire(byLabel(dom, 'Step 2: A hundred') as MElement, 'click');
    expect(currentStep()).toBe('Step 2: A hundred');

    fire(byClass(dom, 'seed__random')[0] as MElement, 'click');

    expect(permalink()).toMatch(/seed=/);
    expect(currentStep()).toBe('Step 2: A hundred');
  });

  it('never falls back to an earlier step whose values a later one inherited', async () => {
    await boot('#/buffon');
    fire(byLabel(dom, 'Step 1: Slow motion') as MElement, 'click');
    expect(currentStep()).toBe('Step 1: Slow motion');
    fire(byLabel(dom, 'Step 2: Short needle') as MElement, 'click');
    expect(currentStep()).toBe('Step 2: Short needle');

    // Any control change rescans. The state is no longer any preset, so the
    // tape says nothing — it must not caption the plate with step 1, whose two
    // values step 2 inherited.
    fire(byLabel(dom, 'Increase Line spacing') as MElement, 'click');
    expect(currentStep()).toBeUndefined();
  });
});
