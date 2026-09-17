import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byLabel, fire, installDom, makeEvent, type Harness, type MElement } from './dom-harness';
import {
  SPEEDS,
  createPressGuard,
  createTransport,
  type PressGuard,
  type TransportCallbacks,
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
 * visualization and absent for one with nothing to shuffle. And every key but
 * Play/Pause is a glyph with a name: no captions to read, no ticks to count.
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

  it('labels every key but Play/Pause with a name and no caption', () => {
    mountWith(true);
    for (const name of ['Step', 'Fast-forward', 'Reset', 'Shuffle']) {
      const key = byLabel(dom as Harness, name);
      expect(key, name).toBeDefined();
      expect(key?.textContent).toBe('');
    }
    expect(byLabel(dom as Harness, 'Pause')?.textContent).toBe('Pause');
  });
});
