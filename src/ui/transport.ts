/**
 * The transport cluster: Play/Pause, Step, Fast-forward, Reset, Shuffle, and
 * the speed picker.
 *
 * Play/Pause is one key that swaps its label and its glyph, and it carries **no**
 * `aria-pressed`: it is not a toggle whose "off" state is a different mode, it is
 * the same key naming the action it will perform, which is what a screen reader
 * needs to hear. Running state lives on the container as `data-running`, which
 * the CSS reads to turn the cluster's ring vermilion — the one place on the page
 * where colour reports a state, backed by the Pause label saying the same thing
 * in words.
 *
 * Shuffle is where the seed went. The rail no longer carries a seed field —
 * a thirty-two-bit integer is not a control a newcomer can do anything with —
 * so "the same experiment, another draw" is one key here, and the shell answers
 * it with a fresh seed from `randomSeed()`.
 *
 * The glyphs are inline SVG, solid `fill: currentColor`. A 16 px, 1.5 px,
 * round-capped stroke is the Feather/Lucide house style, which DESIGN §11 rules
 * out by name — a bench instrument silk-screens filled shapes.
 */

import { clear, h, svg, type Attrs } from './dom';

export interface TransportCallbacks {
  onPlay(): void;
  onPause(): void;
  onStep(): void;
  onFastForward(): void;
  onReset(): void;
  /** Draw a fresh seed and restart. Only wired when the visualization has a seed. */
  onShuffle(): void;
  onSpeed(multiplier: number): void;
}

export interface TransportOptions {
  reducedMotion: boolean;
  /** Whether the visualization draws from a seed, and so has something to shuffle. */
  seeded: boolean;
}

export interface TransportHandle {
  setPlaying(playing: boolean): void;
  setSpeed(mult: number): void;
  destroy(): void;
}

/** Speed multipliers, in the order they appear in the picker. */
export const SPEEDS: readonly number[] = [0.5, 1, 2, 4, 8];

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
  // waits: the key reads Play, and the shell does not autoplay.
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

  const step = iconKey('transport__step', 'Step', () => cb.onStep(), 'M2 2 L9.5 8 L2 14 Z', 'M11.5 2h2.5v12h-2.5z');

  const ff = h(
    'button',
    {
      class: 'key key--icon transport__ff',
      type: 'button',
      'aria-label': 'Fast-forward',
      title: 'Fast-forward',
      'aria-pressed': 'false',
    },
    glyph('M1 2 L7.5 8 L1 14 Z', 'M8.5 2 L15 8 L8.5 14 Z'),
  );

  const reset = iconKey('transport__reset', 'Reset', () => cb.onReset(), 'M2 2h2.5v12H2z', 'M14 2 L6.5 8 L14 14 Z');

  // A die: a hollow square with three pips on the diagonal. Even-odd fill, so
  // the pips and the hollow are holes in one solid shape rather than strokes.
  const shuffle = iconKey('transport__shuffle', 'Shuffle', () => cb.onShuffle(), {
    d:
      'M2 2h12v12H2zm1.5 1.5v9h9v-9z' +
      'M5.5 4.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z' +
      'M8 6.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z' +
      'M10.5 9.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z',
    'fill-rule': 'evenodd',
  });

  const speedId = `transport-speed-${++uid}`;
  const speed = h('select', { class: 'select transport__speed', id: speedId, title: 'Speed' });
  for (const multiplier of SPEEDS) {
    speed.append(h('option', { value: String(multiplier) }, `${multiplier}×`));
  }
  speed.value = '1';
  speed.addEventListener('change', () => cb.onSpeed(Number(speed.value)));

  host.append(play, step, ff, reset);
  // A visualization with no seed has nothing to shuffle, and a key that cannot
  // change anything is worse than no key.
  if (opts.seeded) host.append(shuffle);
  host.append(h('label', { class: 'visually-hidden', for: speedId }, 'Speed'), speed);

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
    destroy() {
      endHold();
      heldPress.end(false);
      document.removeEventListener('pointerup', onPointerRelease);
      document.removeEventListener('pointercancel', onPointerRelease);
      clear(host);
    },
  };
}

/** A ghost key carrying only a glyph. The name is the label, and the tooltip repeats it for a mouse. */
function iconKey(
  className: string,
  name: string,
  onClick: () => void,
  ...paths: readonly (string | Attrs)[]
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `key key--icon ${className}`,
      type: 'button',
      'aria-label': name,
      title: name,
      onclick: onClick,
    },
    glyph(...paths),
  );
}

/** Solid 16 px glyphs, no stroke — the fill comes from `.key__glyph`. */
function glyph(...paths: readonly (string | Attrs)[]): SVGElement {
  return svg(
    'svg',
    { class: 'key__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    ...paths.map((path) => svg('path', typeof path === 'string' ? { d: path } : path)),
  );
}

let uid = 0;
