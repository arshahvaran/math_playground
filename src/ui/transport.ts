/**
 * The transport cluster: Play/Pause, Step, Fast-forward, Reset, speed
 * (DESIGN §5, §8).
 *
 * Play/Pause is one key that swaps its label and its glyph, and it carries **no**
 * `aria-pressed`: it is not a toggle whose "off" state is a different mode, it is
 * the same key naming the action it will perform, which is what a screen reader
 * needs to hear. Running state lives on the container as `data-running`, which
 * the CSS reads to turn the cluster's 2 px top rule vermilion — the one place on
 * the page where colour reports a state, backed by the Pause label saying the
 * same thing in words.
 *
 * The glyphs are inline SVG, solid `fill: currentColor`. A 16 px, 1.5 px,
 * round-capped stroke is the Feather/Lucide house style, which DESIGN §11 rules
 * out by name — a bench instrument silk-screens filled shapes.
 *
 * The `.` and `Shift+.` shortcuts satisfy SC 2.1.4 three ways: they are ignored
 * while the focus is in a text field (`.` is a legal keystroke in the seed and
 * stepper), there is no single-key Space binding (Space is the native activation
 * key for a focused button and the page-scroll key), and they can be switched
 * off entirely from the footer, persisted across visits.
 */

import { clear, h, svg } from './dom';

export interface TransportCallbacks {
  onPlay(): void;
  onPause(): void;
  onStep(): void;
  onFastForward(): void;
  onReset(): void;
  onSpeed(multiplier: number): void;
}

export interface TransportOptions {
  reducedMotion: boolean;
}

export interface TransportHandle {
  setPlaying(playing: boolean): void;
  setSpeed(mult: number): void;
  /** Wired to the footer's shortcuts switch (SC 2.1.4). Persists across visits. */
  setShortcutsEnabled(enabled: boolean): void;
  destroy(): void;
}

/** Speed multipliers, in the order they appear in the picker. */
export const SPEEDS: readonly number[] = [0.5, 1, 2, 4, 8];

export const SHORTCUTS_STORAGE_KEY = 'mp:shortcuts';

/** Fired on `window` when the footer switch flips, so every live transport hears it. */
export const SHORTCUTS_EVENT = 'mp:shortcuts-change';

/** Holding Fast-forward keeps skipping — one burst per press would be a stutter. */
const HOLD_REPEAT_MS = 100;

export interface PressGuard {
  /** A press has begun and has already fired its burst. */
  arm(): void;
  /** The press has ended. `clickFollows` is false when no click can reach the key. */
  end(clickFollows: boolean): void;
  /** True when this click is the press's own echo and must not fire a second burst. */
  swallows(): boolean;
}

/**
 * Whether the `click` now arriving at a key is a press's own echo.
 *
 * A held key fires its burst on `pointerdown` (or `keydown`), and the browser
 * synthesises a `click` at the end of that press which must not fire a second.
 * The state is one bit — but the bit has to be *dropped* whenever the press ends
 * somewhere the click cannot follow: released away from the key, cancelled by a
 * scroll, or blurred. Left armed, it swallows the next bare click instead, and a
 * bare click is exactly how assistive technology activates a button — NVDA on
 * the virtual cursor, VO-Space, Dragon, switch access — so the key would look
 * pressed and do nothing.
 */
export function createPressGuard(): PressGuard {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    end(clickFollows) {
      if (!clickFollows) armed = false;
    },
    swallows() {
      const echo = armed;
      armed = false;
      return echo;
    },
  };
}

/** Are the single-character shortcuts on? Default yes; the footer switch turns them off. */
export function shortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'off';
  } catch {
    // Storage can throw outright in a private window; the shortcuts still work.
    return true;
  }
}

/** Persist the switch and tell every mounted transport. */
export function setShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Nothing to persist to; the live state below still changes.
  }
  window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT, { detail: { enabled } }));
}

export function createTransport(
  host: HTMLElement,
  cb: TransportCallbacks,
  opts: TransportOptions,
): TransportHandle {
  // Idempotent with the shell, which builds `div.transport` as a region.
  host.classList.add('transport');
  if (!host.hasAttribute('role')) host.setAttribute('role', 'group');
  if (!host.hasAttribute('aria-label')) host.setAttribute('aria-label', 'Transport');
  clear(host);

  // Reduced motion opens on the completed state of the default configuration and
  // waits: the key reads Play, and the shell does not autoplay (DESIGN §6).
  let playing = !opts.reducedMotion;
  let holding = false;
  let holdTimer: ReturnType<typeof setInterval> | null = null;
  const heldPress = createPressGuard();

  const play = h('button', {
    class: 'key key--primary transport__play',
    type: 'button',
    onclick: () => {
      // Flip immediately: chrome answers the person, and the shell's own
      // setPlaying() is idempotent if it disagrees.
      const next = !playing;
      setPlaying(next);
      if (next) cb.onPlay();
      else cb.onPause();
    },
  });

  const step = h(
    'button',
    {
      class: 'key key--icon transport__step',
      type: 'button',
      'aria-label': 'Step',
      onclick: () => cb.onStep(),
    },
    glyph('M2 2 L9.5 8 L2 14 Z', 'M11.5 2h2.5v12h-2.5z'),
  );

  const ff = h(
    'button',
    {
      class: 'key key--icon transport__ff',
      type: 'button',
      'aria-label': 'Fast-forward',
      'aria-pressed': 'false',
    },
    glyph('M1 2 L7.5 8 L1 14 Z', 'M8.5 2 L15 8 L8.5 14 Z'),
  );

  const reset = h(
    'button',
    {
      class: 'key key--icon transport__reset',
      type: 'button',
      'aria-label': 'Reset',
      onclick: () => cb.onReset(),
    },
    glyph('M2 2h2.5v12H2z', 'M14 2 L6.5 8 L14 14 Z'),
  );

  const speedId = `transport-speed-${++uid}`;
  const speed = h('select', { class: 'select transport__speed', id: speedId });
  for (const multiplier of SPEEDS) {
    speed.append(h('option', { value: String(multiplier) }, `${multiplier}×`));
  }
  speed.value = '1';
  speed.addEventListener('change', () => cb.onSpeed(Number(speed.value)));

  host.append(
    play,
    step,
    ff,
    reset,
    h('label', { class: 'visually-hidden', for: speedId }, 'Speed'),
    speed,
  );

  // --- Fast-forward, held ---------------------------------------------------

  function beginHold(): void {
    if (holding) return;
    holding = true;
    heldPress.arm();
    ff.setAttribute('aria-pressed', 'true');
    cb.onFastForward();
    holdTimer = setInterval(() => cb.onFastForward(), HOLD_REPEAT_MS);
  }

  function endHold(): void {
    if (!holding) return;
    holding = false;
    if (holdTimer !== null) {
      clearInterval(holdTimer);
      holdTimer = null;
    }
    ff.setAttribute('aria-pressed', 'false');
  }

  /**
   * A release is watched on the document because a press does not have to end on
   * the key it started on: drag off and let go, and `click` is dispatched to the
   * common ancestor of the two pointer targets, not to the key. Only the ending
   * that does produce a click keeps the guard armed.
   */
  function onPointerRelease(event: Event): void {
    endHold();
    const target = event.target;
    heldPress.end(
      event.type !== 'pointercancel' && target instanceof Node && ff.contains(target),
    );
  }

  ff.addEventListener('pointerdown', beginHold);
  ff.addEventListener('pointerleave', endHold);
  ff.addEventListener('blur', () => {
    // A key that has lost focus is not going to receive the pending click.
    endHold();
    heldPress.end(false);
  });
  document.addEventListener('pointerup', onPointerRelease);
  document.addEventListener('pointercancel', onPointerRelease);
  ff.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    // Swallowing the default also swallows the click the browser would
    // synthesise, so a held key cannot fire the burst twice.
    event.preventDefault();
    beginHold();
  });
  ff.addEventListener('keyup', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    endHold();
    // The keydown was prevented, so no click follows this press either.
    heldPress.end(false);
  });
  ff.addEventListener('click', () => {
    // Only a click with no press behind it — an assistive technology activating
    // the key directly — still needs its single burst.
    if (heldPress.swallows()) return;
    cb.onFastForward();
  });

  // --- Keyboard shortcuts ---------------------------------------------------

  let enabled = shortcutsEnabled();

  function applyShortcutHints(): void {
    if (enabled) {
      step.setAttribute('aria-keyshortcuts', '.');
      ff.setAttribute('aria-keyshortcuts', 'Shift+.');
    } else {
      step.removeAttribute('aria-keyshortcuts');
      ff.removeAttribute('aria-keyshortcuts');
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (isTyping(event.target)) return;
    if (event.shiftKey) {
      // Shift+. is '>' on a US layout and something else on many others, so the
      // physical key is the fallback test.
      if (event.key === '>' || event.code === 'Period') {
        event.preventDefault();
        cb.onFastForward();
      }
      return;
    }
    if (event.key === '.') {
      event.preventDefault();
      cb.onStep();
    }
  }

  function onShortcutsChange(event: Event): void {
    const detail = (event as CustomEvent<{ enabled?: unknown }>).detail;
    enabled = typeof detail?.enabled === 'boolean' ? detail.enabled : shortcutsEnabled();
    applyShortcutHints();
  }

  function onStorage(event: StorageEvent): void {
    // Another tab of the same page flipped the switch.
    if (event.key === SHORTCUTS_STORAGE_KEY) {
      enabled = shortcutsEnabled();
      applyShortcutHints();
    }
  }

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener(SHORTCUTS_EVENT, onShortcutsChange);
  window.addEventListener('storage', onStorage);
  applyShortcutHints();

  // --- State ----------------------------------------------------------------

  function setPlaying(next: boolean): void {
    playing = next;
    clear(play);
    play.append(
      playing ? glyph('M3 2h3.5v12H3z', 'M9.5 2H13v12H9.5z') : glyph('M3 2 L13 8 L3 14 Z'),
      playing ? 'Pause' : 'Play',
    );
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    host.dataset['running'] = playing ? 'true' : 'false';
  }

  setPlaying(playing);

  return {
    setPlaying,
    setSpeed(mult) {
      const nearest = SPEEDS.reduce(
        (best, candidate) => (Math.abs(candidate - mult) < Math.abs(best - mult) ? candidate : best),
        SPEEDS[0] ?? 1,
      );
      speed.value = String(nearest);
    },
    setShortcutsEnabled(next) {
      // Persists and notifies every mounted transport, this one included,
      // through SHORTCUTS_EVENT.
      persistShortcuts(next);
    },
    destroy() {
      endHold();
      heldPress.end(false);
      document.removeEventListener('pointerup', onPointerRelease);
      document.removeEventListener('pointercancel', onPointerRelease);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(SHORTCUTS_EVENT, onShortcutsChange);
      window.removeEventListener('storage', onStorage);
      clear(host);
    },
  };
}

/** Solid 16 px glyphs, no stroke — the fill comes from `.key__glyph`. */
function glyph(...paths: readonly string[]): SVGElement {
  return svg(
    'svg',
    { class: 'key__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    ...paths.map((d) => svg('path', { d })),
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

const persistShortcuts = setShortcutsEnabled;

let uid = 0;
