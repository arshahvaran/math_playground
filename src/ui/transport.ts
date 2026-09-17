/**
 * The transport cluster: Play/Pause, Step, Fast-forward, Reset, Shuffle, and
 * the speed control.
 *
 * Play/Pause is one key that swaps its label and its glyph, and it carries **no**
 * `aria-pressed`: it is not a toggle whose "off" state is a different mode, it is
 * the same key naming the action it will perform, which is what a screen reader
 * needs to hear. Running state lives on the container as `data-running`, which
 * the CSS reads to turn the cluster's ring vermilion — the one place on the page
 * where colour reports a state, backed by the Pause label saying the same thing
 * in words.
 *
 * **Every key carries its name in words.** They were glyph-only, with the name
 * in `aria-label` and a `title` tooltip, and the owner's report of the bench is
 * the whole argument against that: three of the five keys were read as broken
 * because nothing on them said what they would do and the tooltip only appears
 * to a mouse that already guessed. A five-key transport is not a media player
 * everyone has used since 1985 — Step and Fast-forward mean something specific
 * here — so the glyph is the mark and the word is the name.
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

/**
 * Speed multipliers, in the order they appear in the picker.
 *
 * The set is the old one — 0.5 through 8 — halved slot for slot, and each
 * option's multiplier is the number on its own face. The owner's report is that
 * every rate on offer ran far too fast to follow, so the range moves down
 * rather than being relabelled: the slot that used to run at 2× now runs at 1×,
 * and the ceiling is 4× rather than 8×. Relabelling instead would have been the
 * cheaper edit and the wrong one — the readouts are read against the wall
 * clock, and a picker whose "1×" is not one times the simulation's own rate
 * makes every number on the page unverifiable.
 *
 * Powers of two about the default, 2⁻² … 2², so the range is symmetric in the
 * exponent and the five factors are exact in binary — the engine multiplies a
 * frame's elapsed milliseconds by one of these and accumulates the product, and
 * a factor like 0.3 would bank a rounding error every frame.
 */
export const SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/**
 * The rate the picker opens at: the middle slot, two halvings above the floor
 * and two doublings below the ceiling. The engine starts here too, and
 * `teardown()` in main.ts returns it here between tabs, so a picker rebuilt for
 * the next visualization and the engine it drives agree without being told.
 */
export const DEFAULT_SPEED = 1;

/** Holding Fast-forward keeps skipping — one burst per press would be a stutter. */
const HOLD_REPEAT_MS = 100;

/**
 * Engine ticks one press of Step advances.
 *
 * The engine's own `stepOnce()` is exactly one fixed timestep, 1/120 s of
 * simulated time, and that is the right unit for the *engine*. It is the wrong
 * unit for a key: measured on the shipped defaults, one tick lands 0.2 of a
 * Galton ball and moves the coupled oscillators' order parameter by less than
 * the fourth significant figure the readouts print, so pressing Step changed
 * nothing on screen on two of the nine tabs and the key read as dead. Twelve
 * ticks is a tenth of a second of simulated time — still a discrete, repeatable
 * quantum a reader can count, and the smallest one that moves a reading on
 * every tab in the registry.
 */
export const STEP_TICKS = 12;

/**
 * A held key is re-armed from the end of the burst it just ran, never from a
 * clock, and never sooner than that burst cost.
 *
 * A burst is a fixed number of ticks and a tick is not a fixed cost: it is
 * 0.02 ms on the orchard and about 0.6 ms on the Ising sheet at 128², so one
 * burst measured 100–235 ms against a 100 ms interval. `setInterval` does not
 * care — it simply runs the next callback as soon as the previous one returns —
 * so on the five heaviest tabs the page got no idle slot at all while the key
 * was down, and answered clicks, hover and the Pause key one burst late. Waiting
 * out what the last burst actually cost bounds the hold at half the main thread
 * on any visualization at any slider position, which is the property a fixed
 * period cannot provide. `settle()` in main.ts sizes its batches the same way,
 * from measurement rather than from a constant.
 */
function holdDelay(spentMs: number): number {
  return Math.max(HOLD_REPEAT_MS, spentMs);
}

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
export function createPressGuard(
  defer: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0);
  },
): PressGuard {
  let armed = false;
  let press = 0;
  return {
    arm() {
      armed = true;
      press += 1;
    },
    end(clickFollows) {
      if (!clickFollows) {
        armed = false;
        return;
      }
      /**
       * Even when a click is expected, the bit is dropped at the end of the
       * task. Whether a click is coming cannot be known from where the release
       * landed: a touch pointer is implicitly captured at `pointerdown`, so
       * `pointerup` is delivered to the key even when the finger lifted
       * somewhere else entirely — and no click is synthesised. Geometry says
       * "a click is coming", nothing consumes the bit, and the next *bare*
       * click is swallowed instead. The synthesised click always arrives in the
       * same task as its release, so an armed bit that survives that task
       * belonged to a press whose click never came.
       */
      const issued = press;
      defer(() => {
        if (press === issued) armed = false;
      });
    },
    swallows() {
      const echo = armed;
      armed = false;
      return echo;
    },
  };
}

/**
 * Only the gesture that activates a button starts a hold. A secondary or middle
 * press is not an activation in any platform's button semantics, and binding it
 * fired a burst, armed the repeat and announced `aria-pressed` for a right-click
 * that was on its way to the context menu — which no listener would have ended.
 * A pointer whose `button` or `isPrimary` the environment does not report is
 * treated as primary: the property being absent is not evidence of a secondary
 * press.
 *
 * Exported because the tab strip holds its arrows the same way, and one
 * definition of "was that an activation?" is what keeps the two answering alike.
 */
export function isPrimaryPress(event: PointerEvent): boolean {
  const button = (event as Partial<PointerEvent>).button;
  const primary = (event as Partial<PointerEvent>).isPrimary;
  return (button === undefined || button === 0) && primary !== false;
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
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
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

  // Skip-to-next: a triangle against a bar. One press advances the simulation by
  // STEP_TICKS and paints, which is what makes it visible at all.
  const step = namedKey(
    'transport__step',
    'Step',
    () => {
      for (let i = 0; i < STEP_TICKS; i++) cb.onStep();
    },
    'M2 2 L10 8 L2 14 Z',
    'M11.5 2h2.5v12h-2.5z',
  );

  const ff = h(
    'button',
    {
      class: 'key transport__ff',
      type: 'button',
      // The visible word is the accessible name; the attribute restates it so
      // the two can never drift, which is SC 2.5.3 read forwards.
      'aria-label': 'Fast-forward',
      title: 'Fast-forward',
      'aria-pressed': 'false',
    },
    glyph('M1 2 L7.5 8 L1 14 Z', 'M8.5 2 L15 8 L8.5 14 Z'),
    h('span', { class: 'key__name' }, 'Fast-forward'),
  );

  // A circular arrow. `RESET_GLYPH` documents the arithmetic behind the path,
  // which is a 300° annular sector with a solid head on its leading edge — the
  // one mark everybody reads as "start again". The skip-to-start bar-and-
  // triangle it replaces is a *transport* symbol, and this key does not rewind
  // a recording, it throws the run away and begins another.
  const reset = namedKey('transport__reset', 'Reset', () => cb.onReset(), ...RESET_GLYPH);

  // A die: a hollow square with three pips on the diagonal. Even-odd fill, so
  // the pips and the hollow are holes in one solid shape rather than strokes.
  const shuffle = namedKey('transport__shuffle', 'Shuffle', () => cb.onShuffle(), {
    d:
      'M2 2h12v12H2zm1.5 1.5v9h9v-9z' +
      'M5.5 4.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z' +
      'M8 6.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z' +
      'M10.5 9.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z',
    'fill-rule': 'evenodd',
  });

  const speed = createSegmented((multiplier) => cb.onSpeed(multiplier));

  host.append(play, step, ff, reset);
  // A visualization with no seed has nothing to shuffle, and a key that cannot
  // change anything is worse than no key.
  if (opts.seeded) host.append(shuffle);
  host.append(speed.root);

  // --- Fast-forward, held ---------------------------------------------------

  /** One burst, then the next one scheduled from what this one cost. */
  function burst(): void {
    const before = clock();
    cb.onFastForward();
    if (!holding) return;
    holdTimer = setTimeout(burst, holdDelay(clock() - before));
  }

  function beginHold(): void {
    if (holding) return;
    holding = true;
    heldPress.arm();
    ff.setAttribute('aria-pressed', 'true');
    burst();
  }

  function endHold(): void {
    if (!holding) return;
    holding = false;
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
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

  ff.addEventListener('pointerdown', (event) => {
    if (!isPrimaryPress(event)) return;
    beginHold();
  });
  ff.addEventListener('pointerleave', endHold);
  // The menu takes the pointer with it: no `pointerup` is guaranteed to follow.
  ff.addEventListener('contextmenu', () => {
    endHold();
    heldPress.end(false);
  });
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
      h('span', { class: 'key__name' }, playing ? 'Pause' : 'Play'),
    );
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    host.dataset['running'] = playing ? 'true' : 'false';
  }

  setPlaying(playing);

  return {
    setPlaying,
    setSpeed(mult) {
      speed.set(mult);
    },
    destroy() {
      endHold();
      heldPress.end(false);
      document.removeEventListener('pointerup', onPointerRelease);
      document.removeEventListener('pointercancel', onPointerRelease);
      speed.destroy();
      clear(host);
    },
  };
}

// ---------------------------------------------------------------------------
// The speed control
// ---------------------------------------------------------------------------

interface Segmented {
  root: HTMLElement;
  set(multiplier: number): void;
  destroy(): void;
}

/**
 * Five fixed rates as a segmented control.
 *
 * A `<select>` was the wrong instrument for this: it hides four of the five
 * choices behind a press, it renders as the operating system's own menu rather
 * than as part of the bench, and there is nothing to discover in it — the whole
 * set is five short labels and fits on the row. A radio group shows all five,
 * says which one is in force without being opened, and gets its keyboard model
 * from the platform pattern rather than from a listbox nobody can see.
 *
 * The selection is a single travelling tile behind the labels — `--seg-i` is the
 * index and the tile is one slot wide, so the move is a `translate` of a
 * percentage of its own width and nothing lays out. The columns are equal by
 * construction (`repeat(n, 1fr)` in §11), which is what makes that arithmetic
 * exact at any width and any text size.
 */
function createSegmented(onChange: (multiplier: number) => void): Segmented {
  const options: HTMLButtonElement[] = [];
  let index = SPEEDS.indexOf(DEFAULT_SPEED);
  if (index < 0) index = 0;

  const tile = h('span', { class: 'segmented__tile', 'aria-hidden': 'true' });

  const root = h('div', {
    class: 'segmented transport__speed',
    role: 'radiogroup',
    'aria-label': 'Speed',
  });
  root.append(tile);
  root.style.setProperty('--seg-n', String(SPEEDS.length));

  for (const [i, multiplier] of SPEEDS.entries()) {
    const option = h(
      'button',
      {
        class: 'segmented__option',
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        tabindex: '-1',
        'aria-label': `${multiplier} times speed`,
      },
      `${multiplier}×`,
    );
    option.addEventListener('click', () => commit(i, false));
    options.push(option);
    root.append(option);
  }

  /**
   * Arrows move the selection, not just the focus: that is the radio-group
   * model, and it is the one a reader gets from every other segmented control.
   * Home and End are the ends of the range rather than of the widget, which here
   * are the same thing.
   */
  function onKeyDown(event: KeyboardEvent): void {
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = SPEEDS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const count = SPEEDS.length;
    commit(((next % count) + count) % count, true);
  }

  root.addEventListener('keydown', onKeyDown);

  /** Write the selection. `focus` moves the focus with it, for the keyboard path. */
  function show(next: number, focus: boolean): void {
    index = next;
    root.style.setProperty('--seg-i', String(next));
    for (const [i, option] of options.entries()) {
      const on = i === next;
      option.setAttribute('aria-checked', String(on));
      // Roving tabindex: the checked radio is the group's one stop in the tab
      // order, so tabbing in lands on the rate that is actually running.
      option.tabIndex = on ? 0 : -1;
    }
    if (focus) options[next]?.focus();
  }

  function commit(next: number, focus: boolean): void {
    const multiplier = SPEEDS[next];
    if (multiplier === undefined) return;
    const moved = next !== index;
    show(next, focus);
    if (moved) onChange(multiplier);
  }

  show(index, false);

  return {
    root,
    set(multiplier) {
      // The engine is the source of truth for the rate and it is not restricted
      // to the five offered here — a permalink can carry any number — so the
      // control shows the nearest one it can represent rather than nothing.
      let best = 0;
      for (const [i, candidate] of SPEEDS.entries()) {
        const incumbent = SPEEDS[best] ?? 1;
        if (Math.abs(candidate - multiplier) < Math.abs(incumbent - multiplier)) best = i;
      }
      show(best, false);
    },
    destroy() {
      root.removeEventListener('keydown', onKeyDown);
    },
  };
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/**
 * The Reset mark: a 300° annulus with a solid arrowhead on its leading edge.
 *
 * Built from a circle of radius 6 and a hole of radius 3.5 about (8, 8), swept
 * clockwise from −60° to 240°, which leaves the gap at the top where the head
 * goes. The head's base is the radial chord at 240°, widened to r ± 1.2 so it
 * overhangs the ring, and its apex is 3 px along the tangent there. Every
 * number in the path is that construction evaluated — it is not eyeballed, and
 * it is written out rather than computed so the file ships literal path data.
 */
const RESET_GLYPH: readonly Attrs[] = [
  { d: 'M11 2.804 A6 6 0 1 1 5 2.804 L6.25 4.969 A3.5 3.5 0 1 0 9.75 4.969 Z' },
  { d: 'M4.4 1.765 L8.223 2.386 L6.85 6.008 Z' },
];

/** A key carrying a glyph and its name in words. The tooltip repeats it for a mouse. */
function namedKey(
  className: string,
  name: string,
  onClick: () => void,
  ...paths: readonly (string | Attrs)[]
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `key ${className}`,
      type: 'button',
      'aria-label': name,
      title: name,
      onclick: onClick,
    },
    glyph(...paths),
    h('span', { class: 'key__name' }, name),
  );
}

function clock(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

/** Solid 16 px glyphs, no stroke — the fill comes from `.key__glyph`. */
function glyph(...paths: readonly (string | Attrs)[]): SVGElement {
  return svg(
    'svg',
    { class: 'key__glyph', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    ...paths.map((path) => svg('path', typeof path === 'string' ? { d: path } : path)),
  );
}
