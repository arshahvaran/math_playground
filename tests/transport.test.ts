import { describe, expect, it } from 'vitest';
import { SPEEDS, createPressGuard } from '../src/ui/transport';

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

describe('speeds', () => {
  it('offers 1x and is ordered', () => {
    expect(SPEEDS).toContain(1);
    expect([...SPEEDS]).toEqual([...SPEEDS].sort((a, b) => a - b));
  });
});
