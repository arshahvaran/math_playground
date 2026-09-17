import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byLabel, fire, installDom, makeEvent, type Harness, type MElement } from './dom-harness';
import {
  DEFAULT_SPEED,
  SPEEDS,
  STEP_TICKS,
  createPressGuard,
  createTransport,
  type PressGuard,
  type TransportCallbacks,
  type TransportHandle,
} from '../src/ui/transport';

/**
 * Fast-forward answers a press as it begins — that is what makes holding the key
 * skip — and then has to ignore the `click` the browser synthesises at the end of
 * that press, or every press fires two bursts.
 *
 * The trap is the press that ends without producing a click: released away from
 * the key, cancelled by a scroll, or blurred. `click` goes to the common ancestor
 * of the two pointer targets, so none of those reach the key, and a guard left
 * armed swallows the *next* activation instead. A bare click is how assistive
 * technology presses a button, and under `prefers-reduced-motion` Fast-forward is
 * the documented way a reader advances at all, so that is the whole control
 * silently dying until it is activated twice.
 *
 * `swallows()` answers "is this click the press's own echo?", so a burst is fired
 * whenever it comes back false.
 */
describe('press guard', () => {
  it('swallows the click a press on the key ends with', () => {
    const guard = createPressGuard();
    guard.arm(); // pointerdown fired the burst
    guard.end(true); // pointerup on the key: a click is coming
    expect(guard.swallows()).toBe(true);
  });

  it('lets a bare click through — nothing was pressed', () => {
    expect(createPressGuard().swallows()).toBe(false);
  });

  it('lets the next activation through after a press released off the key', () => {
    const guard = createPressGuard();
    guard.arm();
    guard.end(false); // dragged off and released outside: no click reaches the key
    expect(guard.swallows()).toBe(false);
  });

  it('lets the next activation through after a cancelled press', () => {
    // A scroll started on the key: pointercancel, and no click at all.
    const guard = createPressGuard();
    guard.arm();
    guard.end(false);
    expect(guard.swallows()).toBe(false);
  });

  it('lets the next activation through after the key is blurred', () => {
    const guard = createPressGuard();
    guard.arm();
    guard.end(false); // blur: a key that lost focus receives no click
    expect(guard.swallows()).toBe(false);
  });

  it('swallows one click, not two', () => {
    const guard = createPressGuard();
    guard.arm();
    guard.end(true);
    expect(guard.swallows()).toBe(true);
    expect(guard.swallows()).toBe(false);
  });

  it('holds through a press that leaves the key and comes back', () => {
    // pointerleave stops the repeat but the pointer is still down; releasing
    // over the key does produce a click, and that one is still the echo.
    const guard = createPressGuard();
    guard.arm();
    guard.end(true);
    expect(guard.swallows()).toBe(true);
  });

  it('re-arms for the press after the one it dropped', () => {
    const guard = createPressGuard();
    guard.arm();
    guard.end(false);
    expect(guard.swallows()).toBe(false);
    guard.arm();
    guard.end(true);
    expect(guard.swallows()).toBe(true);
  });
});

/**
 * The press whose click never comes.
 *
 * `end(true)` is called from geometry — the release landed on the key — and
 * geometry is not evidence. A touch pointer is implicitly captured at
 * `pointerdown`, so `pointerup` is delivered to the key even when the finger
 * lifted somewhere else entirely, and no click is synthesised at all. The bit
 * therefore has to be dropped at the end of the task whatever the release looked
 * like, or the next *bare* click — the one assistive technology sends — is eaten
 * instead, which is the failure the guard exists to prevent.
 *
 * The deferral is injected so the boundary between the two tasks is a call and
 * not a wait.
 */
describe('press guard across tasks', () => {
  function controllable(): { guard: PressGuard; endTask: () => void } {
    const queue: Array<() => void> = [];
    return {
      guard: createPressGuard((fn) => queue.push(fn)),
      endTask(): void {
        for (const fn of queue.splice(0)) fn();
      },
    };
  }

  it('swallows the echo that arrives in the press’s own task', () => {
    const { guard } = controllable();
    guard.arm();
    guard.end(true);
    expect(guard.swallows()).toBe(true);
  });

  it('lets the next activation through when no click ever arrived', () => {
    // Touch-drag off the key: the captured pointer still reports `pointerup` on
    // it, so the release looks exactly like a click is coming, and none is.
    const { guard, endTask } = controllable();
    guard.arm();
    guard.end(true);
    endTask();
    expect(guard.swallows()).toBe(false);
  });

  it('does not let a finished press disarm the one that followed it', () => {
    const { guard, endTask } = controllable();
    guard.arm();
    guard.end(true);
    guard.arm(); // a second press begins before the first deferral runs
    endTask();
    expect(guard.swallows()).toBe(true);
  });
});

describe('speeds', () => {
  it('offers 1x and is ordered', () => {
    expect(SPEEDS).toContain(1);
    expect([...SPEEDS]).toEqual([...SPEEDS].sort((a, b) => a - b));
  });

  /**
   * The set is pinned, value by value, because the failure it guards against is
   * silent. The picker used to run 0.5× to 8×, and the owner's report of every
   * tab was that it moved far too fast to follow anything: the whole range is
   * that one halved, slot for slot, so the ceiling is 4× and the slot that ran
   * at 2× now runs at 1×. Nothing on screen says which range is in force — a
   * later edit that puts 8 back, or that relabels rather than slows, looks
   * exactly like this one in a diff and reads as "faster" only to someone
   * watching the tab. So the numbers are asserted here rather than derived, and
   * a change to them has to be a change to this test as well.
   */
  it('runs the halved set, 0.25× to 4×, with 1× the middle slot and the default', () => {
    expect([...SPEEDS]).toEqual([0.25, 0.5, 1, 2, 4]);
    expect(DEFAULT_SPEED).toBe(1);
    // The middle of five, so the range is symmetric about the default: two
    // halvings below it and two doublings above.
    expect(SPEEDS.indexOf(DEFAULT_SPEED)).toBe(2);
    expect(SPEEDS).toHaveLength(5);
    expect(Math.max(...SPEEDS)).toBe(4);
    expect(Math.min(...SPEEDS)).toBe(0.25);
  });

  /** Each rate is its neighbour doubled, which is what keeps the factors exact. */
  it('steps by factors of two', () => {
    expect(SPEEDS.map((rate) => rate * 2).slice(0, -1)).toEqual([...SPEEDS].slice(1));
  });
});

/**
 * Fast-forward under a held key.
 *
 * Two properties, and neither of them is about the burst itself. The repeat has
 * to be re-armed from what the last burst *cost* — a fixed 100 ms period against
 * a burst that measured up to 235 ms on the Ising sheet meant the next callback
 * ran the moment the previous one returned, and the page answered clicks, hover
 * and the Pause key one whole burst late. And only the gesture that activates a
 * button may start it: a right-click fired a burst, armed the repeat and
 * announced `aria-pressed`, then left for the context menu, which no listener
 * would have ended.
 *
 * The clock is a spy rather than the real one, so "what the burst cost" is an
 * input to the test instead of a race against the machine it runs on.
 */
describe('holding Fast-forward', () => {
  let dom: Harness | null = null;
  let ff: MElement;
  let now = 0;
  /** What one burst costs the main thread, in fake milliseconds. */
  let cost = 0;
  let calls = 0;

  beforeEach(() => {
    now = 0;
    cost = 0;
    calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.useFakeTimers();
    dom = installDom();
    const host = dom.document.createElement('div');
    dom.app.appendChild(host);
    const cb: TransportCallbacks = {
      onPlay: () => undefined,
      onPause: () => undefined,
      onStep: () => undefined,
      onFastForward: () => {
        calls += 1;
        now += cost;
      },
      onReset: () => undefined,
      onShuffle: () => undefined,
      onSpeed: () => undefined,
    };
    createTransport(host as unknown as HTMLElement, cb, { reducedMotion: false, seeded: true });
    ff = byLabel(dom, 'Fast-forward') as MElement;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    dom?.teardown();
    dom = null;
  });

  /** A primary press, unless the test is about one of the other buttons. */
  function press(init: Record<string, unknown> = { button: 0, isPrimary: true }): void {
    fire(ff, 'pointerdown', init);
  }

  /** The release is watched on the document, not on the key. */
  function release(): void {
    (dom as Harness).document.dispatchEvent(makeEvent('pointerup', { target: ff }));
  }

  it('waits out what the last burst cost before running the next', () => {
    cost = 250; // the Ising sheet at 128², the heaviest burst in the registry
    press();
    expect(calls).toBe(1);
    // A fixed 100 ms period fired here, and again at 200: the main thread never
    // reached an idle slot for as long as the key was down.
    vi.advanceTimersByTime(249);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
    release();
  });

  it('still paces a burst that costs nothing at the repeat period', () => {
    cost = 0; // the orchard: a tick is 0.02 ms and a burst is under a millisecond
    press();
    vi.advanceTimersByTime(99);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
    release();
  });

  it('gives the main thread at least as long as it just took', () => {
    // The property behind both numbers above, stated once: over a long hold the
    // page is never busy for more than half the time.
    cost = 231;
    press();
    for (let i = 0; i < 20; i++) vi.advanceTimersByTime(cost);
    const idle = 20 * cost;
    expect(calls * cost).toBeLessThanOrEqual(idle + cost);
    release();
  });

  it('stops on release, and takes the pending burst with it', () => {
    cost = 250;
    press();
    expect(ff.getAttribute('aria-pressed')).toBe('true');
    release();
    expect(ff.getAttribute('aria-pressed')).toBe('false');
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(1);
  });

  it('refuses a secondary or middle press', () => {
    press({ button: 2, isPrimary: true });
    expect(calls).toBe(0);
    expect(ff.getAttribute('aria-pressed')).toBe('false');
    // The context menu takes the pointer with it; nothing may still be running.
    fire(ff, 'contextmenu');
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(0);

    press({ button: 1, isPrimary: true });
    expect(calls).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(0);

    // And the gesture that does activate a button still works.
    press();
    expect(calls).toBe(1);
    release();
  });

  it('treats a pointer that reports no button as primary', () => {
    // A synthetic event from a test harness, an automation tool or an older
    // pointer polyfill carries no `button`; absence is not evidence of a
    // secondary press, and refusing it would kill the key.
    press({});
    expect(calls).toBe(1);
    release();
  });

  it('ends a hold the context menu interrupts', () => {
    press();
    expect(calls).toBe(1);
    fire(ff, 'contextmenu');
    expect(ff.getAttribute('aria-pressed')).toBe('false');
    vi.advanceTimersByTime(5000);
    expect(calls).toBe(1);
  });

  it('answers the bare click after a press whose click never came', () => {
    press();
    expect(calls).toBe(1);
    release(); // a touch that lifted off the key: the release lands, no click does
    vi.advanceTimersByTime(0); // end of that task
    fire(ff, 'click'); // NVDA, VO-Space, Dragon, switch access
    expect(calls).toBe(2);
  });

  it('still swallows the click the browser synthesises for a mouse press', () => {
    press();
    release();
    fire(ff, 'click'); // same task as the release: this one is the echo
    expect(calls).toBe(1);
  });
});

/**
 * The cluster itself. The seed field left the rail, so Shuffle is the only way
 * a reader asks for another draw — it has to be there for every seeded
 * visualization and absent for one with nothing to shuffle. And every key says
 * in words what it will do.
 */
describe('the cluster', () => {
  let dom: Harness | null = null;

  afterEach(() => {
    dom?.teardown();
    dom = null;
  });

  function mountWith(seeded: boolean): { calls: string[]; host: MElement } {
    dom = installDom();
    const host = dom.document.createElement('div');
    dom.app.appendChild(host);
    const calls: string[] = [];
    const cb: TransportCallbacks = {
      onPlay: () => calls.push('play'),
      onPause: () => calls.push('pause'),
      onStep: () => calls.push('step'),
      onFastForward: () => calls.push('ff'),
      onReset: () => calls.push('reset'),
      onShuffle: () => calls.push('shuffle'),
      onSpeed: (m) => calls.push(`speed ${m}`),
    };
    createTransport(host as unknown as HTMLElement, cb, { reducedMotion: false, seeded });
    return { calls, host };
  }

  it('offers Shuffle to a seeded visualization, and it draws a fresh seed', () => {
    const { calls } = mountWith(true);
    const shuffle = byLabel(dom as Harness, 'Shuffle');
    expect(shuffle).toBeDefined();
    fire(shuffle as MElement, 'click');
    expect(calls).toEqual(['shuffle']);
  });

  it('offers no Shuffle where there is nothing to shuffle', () => {
    mountWith(false);
    expect(byLabel(dom as Harness, 'Shuffle')).toBeUndefined();
    expect(byLabel(dom as Harness, 'Reset')).toBeDefined();
  });

  it('gives every key its name in words, not just a tooltip', () => {
    mountWith(true);
    // They were 44 px glyph squares whose names lived in `aria-label` and a
    // `title`, and the owner read three of the five as broken: nothing on a key
    // said what it would do, and a tooltip only reaches a mouse that has
    // already guessed. The visible word and the accessible name are the same
    // string, which is SC 2.5.3 read forwards.
    for (const name of ['Step', 'Fast-forward', 'Reset', 'Shuffle']) {
      const key = byLabel(dom as Harness, name);
      expect(key, name).toBeDefined();
      expect(key?.textContent, name).toBe(name);
      expect(key?.getAttribute('title'), name).toBe(name);
    }
    expect(byLabel(dom as Harness, 'Pause')?.textContent).toBe('Pause');
  });

  /**
   * Step advanced the engine by exactly one fixed timestep — 1/120 s — which is
   * the right unit for the engine and the wrong one for a key. Measured on the
   * shipped defaults, one tick lands 0.2 of a Galton ball and moves the coupled
   * oscillators' order parameter below the fourth significant figure the
   * readouts print, so the key changed nothing on screen on two of the nine
   * tabs and was reported as dead. A press is a tenth of a second of simulated
   * time instead: still a discrete, countable quantum, and the smallest one
   * that moves a reading on every tab in the registry.
   */
  it('advances a countable quantum of simulated time per press of Step', () => {
    const { calls } = mountWith(true);
    const step = byLabel(dom as Harness, 'Step');
    expect(step).toBeDefined();
    fire(step as MElement, 'click');
    expect(calls).toHaveLength(STEP_TICKS);
    expect(new Set(calls)).toEqual(new Set(['step']));
    expect(STEP_TICKS).toBeGreaterThan(1);
  });
});

/**
 * The speed control.
 *
 * A bare `<select>` was the wrong instrument for five fixed rates: it hides
 * four of the five behind a press, it paints the operating system's own menu
 * over the bench, and there is nothing to discover inside it. A radio group
 * shows the whole range, shows where in it the run is without being opened, and
 * takes its keyboard model from the platform pattern rather than from a listbox
 * nobody can see.
 */
describe('the speed control', () => {
  let dom: Harness | null = null;
  let speeds: number[] = [];

  beforeEach(() => {
    dom = installDom();
    speeds = [];
    const host = dom.document.createElement('div');
    dom.app.appendChild(host);
    const cb: TransportCallbacks = {
      onPlay: () => undefined,
      onPause: () => undefined,
      onStep: () => undefined,
      onFastForward: () => undefined,
      onReset: () => undefined,
      onShuffle: () => undefined,
      onSpeed: (m) => speeds.push(m),
    };
    handle = createTransport(host as unknown as HTMLElement, cb, {
      reducedMotion: false,
      seeded: true,
    });
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    dom?.teardown();
    dom = null;
  });

  let handle: TransportHandle | null = null;

  function options(): MElement[] {
    return (dom as Harness).findAll((el) => el.getAttribute('role') === 'radio');
  }

  function checked(): string | undefined {
    return options().find((o) => o.getAttribute('aria-checked') === 'true')?.textContent;
  }

  /** The option by the rate on its face, so no test pins a rate to a slot number. */
  function optionFor(multiplier: number): MElement {
    const option = options().find((o) => o.textContent === `${multiplier}×`);
    expect(option, `${multiplier}×`).toBeDefined();
    return option as MElement;
  }

  it('shows every rate at once, with the one in force marked', () => {
    expect(options().map((o) => o.textContent)).toEqual(['0.25×', '0.5×', '1×', '2×', '4×']);
    expect((dom as Harness).findAll((el) => el.tagName === 'select')).toEqual([]);
    expect(checked()).toBe('1×');
    // Roving tabindex: tabbing in lands on the rate that is actually running.
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
    expect(options().find((o) => o.tabIndex === 0)?.textContent).toBe('1×');
  });

  /**
   * The label is the multiplier, not a name for it. Halving the range would be
   * worth nothing if the slot marked 1× still handed the engine the old 2× —
   * the tab would run at the rate it always did and the readouts, which a
   * reader times against the clock, would be quoting a rate nobody is running.
   */
  it('hands the engine exactly the rate written on the option pressed', () => {
    for (const multiplier of SPEEDS) fire(optionFor(multiplier), 'click');
    expect(speeds).toEqual([...SPEEDS]);
    // And the accessible name says the same number as the visible one.
    expect(options().map((o) => o.getAttribute('aria-label'))).toEqual(
      SPEEDS.map((m) => `${m} times speed`),
    );
  });

  it('reports a rate once when it changes, and never for the one already set', () => {
    fire(optionFor(2), 'click');
    expect(speeds).toEqual([2]);
    expect(checked()).toBe('2×');

    // Pressing the option already in force is a no-op, as it is in every radio
    // group: the engine must not be handed a rate it is already running at.
    fire(optionFor(2), 'click');
    expect(speeds).toEqual([2]);

    fire(optionFor(0.5), 'click');
    fire(optionFor(1), 'click');
    expect(speeds).toEqual([2, 0.5, 1]);
  });

  it('moves the selection with the arrow keys, and the ends with Home and End', () => {
    const group = (dom as Harness).find((el) => el.getAttribute('role') === 'radiogroup');
    expect(group).toBeDefined();
    fire(group as MElement, 'keydown', { key: 'ArrowRight' });
    expect(checked()).toBe('2×');
    expect(speeds).toEqual([2]);

    fire(group as MElement, 'keydown', { key: 'ArrowLeft' });
    expect(checked()).toBe('1×');

    fire(group as MElement, 'keydown', { key: 'End' });
    expect(checked()).toBe(`${SPEEDS[SPEEDS.length - 1]}×`);
    fire(group as MElement, 'keydown', { key: 'Home' });
    expect(checked()).toBe(`${SPEEDS[0]}×`);
    // It is a radio group, so the arrows carry the selection and not just the
    // focus — and the focus follows it.
    expect((dom as Harness).document.activeElement).toBe(options()[0]);
  });

  it('shows the nearest rate it can when the engine is set to one it has no slot for', () => {
    // A permalink can carry any multiplier; the control still has to say
    // something true rather than nothing.
    handle?.setSpeed(5);
    expect(checked()).toBe('4×');
    // 8 is the ceiling this picker used to offer; it now pins to the new one.
    handle?.setSpeed(8);
    expect(checked()).toBe('4×');
    handle?.setSpeed(0.1);
    expect(checked()).toBe('0.25×');
    handle?.setSpeed(1);
    expect(checked()).toBe('1×');
    // setSpeed is the shell telling the control what the engine is doing, so it
    // must not report back and start a loop.
    expect(speeds).toEqual([]);
  });

  it('moves the tile by index rather than by laying out five columns', () => {
    const group = (dom as Harness).find((el) => el.getAttribute('role') === 'radiogroup');
    expect(group?.style.getPropertyValue('--seg-n')).toBe('5');
    // The tile opens over the middle slot, which is where the default rate sits.
    expect(group?.style.getPropertyValue('--seg-i')).toBe('2');
    expect(SPEEDS.indexOf(DEFAULT_SPEED)).toBe(2);
    fire(optionFor(4), 'click');
    expect(group?.style.getPropertyValue('--seg-i')).toBe('4');
  });
});
