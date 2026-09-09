/**
 * The control rail: one row per `ParamSpec`, generated, never hand-written.
 *
 * DESIGN §5 gives each row its anatomy and its states; this file is the DOM and
 * the arithmetic behind them. The switch on `spec.kind` is exhaustive, so adding
 * a variant to the union in `core/types.ts` is a compile error here rather than
 * a control that silently fails to render.
 *
 * Two things are worth knowing before reading:
 *
 * - A log fader does not slide over its own values. Its `<input type="range">`
 *   runs over integer positions and the value is computed from the position,
 *   because a range input distributes its steps uniformly and a 1 → 200,000
 *   parameter spends 199,900 of its 200,000 steps in the last decade otherwise.
 *   The position grid is deliberately *finer* than the value grid, so travel
 *   and keyboard travel are two different units — see `logPositions`.
 * - An `int` row carries both a fader and the stepper from DESIGN §5. §1 is
 *   explicit that *every* quantity a person can turn is a fader with an engraved
 *   scale, and the stepper is that fader's numeric mirror — the exact value, and
 *   ±1 for a reader who cannot land a 22 px thumb on row 13 of 20.
 *
 * Every row commits through a guard: a control that clamps its way back to the
 * value already in force must not report a change. `onChange` on a structural
 * parameter tears the simulation down and rebuilds it, so a stepper key at its
 * own limit, or a drag that lands on the value it started from, would otherwise
 * throw the reader's run away while nothing on screen moved.
 */

import type { ParamSpec, ParamValue, ParamValues, Prose } from '../core/types';
import { randomSeed } from '../core/rng';
import { clear, h, monoMinus, prose, withMinus } from './dom';

export interface ControlsHandle {
  /** Apply a whole parameter set at once — Story mode writes every value, then resets once. */
  setValues(values: ParamValues): void;
  setValue(key: string, value: ParamValue): void;
  destroy(): void;
}

/**
 * Notches of travel on a log fader: the unit one arrow press moves, and the
 * grain the thumb is drawn against. 1000 over the widest range in the registry
 * (1 → 200,000) is about a percent of a decade per notch, which is finer than
 * the thumb can be placed at any realistic rail width.
 */
const LOG_NOTCHES = 1000;

/** A slider with more positions than this is an attribute nobody benefits from. */
const MAX_LOG_POSITIONS = 1_000_000;

/** Above this many steps the engraved minor graduations would be a solid bar. */
const MAX_ENGRAVED_TICKS = 20;

// ---------------------------------------------------------------------------
// The value grid — pure, and the part of this file a test can reach
// ---------------------------------------------------------------------------

/**
 * Slider position in [0, 1] → parameter value, distributed by decade:
 * `min · (max/min)^pos`, so equal travel is equal ratio.
 *
 * **Linear fallback when `min <= 0`.** The mapping is a ratio of the ends, and a
 * range containing or starting at zero has no ratio: `log(0)` is −∞ and any
 * negative end makes `max/min` negative. Rather than reject the spec — a
 * visualization declaring `log: true` on a range from 0 is asking for a fader,
 * not an error — the position maps linearly, which is exactly what the plain
 * fader would have done. The same fallback covers a degenerate `max <= min`.
 */
export function mapLogPosition(pos01: number, min: number, max: number): number {
  const t = clamp01(pos01);
  // The ends are returned verbatim. Both forms are a rounding away from the
  // declared bound — `1e-3 · (1e3/1e-3)` is not `1e3`, and `min + (max − min)`
  // is not `max` — and a fader at its stop must report the number the spec
  // declares, because that number is what the URL and the clamp compare against.
  if (t <= 0) return min;
  if (t >= 1) return max;
  if (!(min > 0) || !(max > min)) return min + t * (max - min);
  return min * (max / min) ** t;
}

/** Parameter value → slider position in [0, 1]. Inverse of `mapLogPosition`. */
export function unmapLogPosition(value: number, min: number, max: number): number {
  if (!(min > 0) || !(max > min)) {
    const span = max - min;
    return span === 0 ? 0 : clamp01((value - min) / span);
  }
  return clamp01(Math.log(value / min) / Math.log(max / min));
}

/**
 * How many integer positions a log fader's slider runs over.
 *
 * The thumb has to be able to land on the value it was mounted with: a fader
 * opening at 2,000 whose position decodes to 1,990 turns a drag that ends where
 * it began — or a single arrow press — into a parameter change and a lost run.
 * Rounding a value to the nearest position costs at most half a position, a
 * relative error of `ln(max/min) / 2N`, and at the top of the range that has to
 * stay under half a step: `N > max·ln(max/min)/step`. The factor of two is
 * margin. Galton's 1 → 20,000 balls asks for ~400,000 positions, which costs
 * nothing — the keyboard walks the value grid (`LOG_NOTCHES`), not this one.
 */
export function logPositions(min: number, max: number, step: number): number {
  if (!(min > 0) || !(max > min) || !(step > 0)) return LOG_NOTCHES;
  const needed = Math.ceil((2 * max * Math.log(max / min)) / step);
  return Math.min(MAX_LOG_POSITIONS, Math.max(LOG_NOTCHES, needed));
}

/**
 * A value on the grid the parameter actually takes: on `step`, inside the ends,
 * and rounded back out of the binary noise snapping accumulates — the number is
 * about to be printed, compared against a default and put in a URL.
 */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  return quantize(value, min, max, step, decimalsForStep(step));
}

/** Log fader: value → the integer slider position that decodes back to it. */
export function logPositionFor(value: number, min: number, max: number, step: number): number {
  return Math.round(unmapLogPosition(value, min, max) * logPositions(min, max, step));
}

/**
 * Log fader: integer slider position → value. The step is honoured after the
 * mapping, never before — the position is uniform, the value it lands on is not.
 */
export function logValueFor(position: number, min: number, max: number, step: number): number {
  const positions = logPositions(min, max, step);
  return snapToStep(mapLogPosition(position / positions, min, max), min, max, step);
}

/**
 * The value `notches` of travel from `value` — what one arrow press moves.
 *
 * A notch is a constant ratio, because that is the fader's whole claim, but over
 * the lower decades a notch is finer than the parameter's own step: 41 arrow
 * presses in a row land back on 1 ball. So a notch that does not move the value
 * falls back to one step, and the result differs from `value` except at the end
 * it is being pushed against.
 */
export function nudgeLogValue(
  value: number,
  min: number,
  max: number,
  step: number,
  notches: number,
): number {
  const ratio = min > 0 && max > min ? (max / min) ** (notches / LOG_NOTCHES) : 1;
  const moved = snapToStep(value * ratio, min, max, step);
  return moved === value ? snapToStep(value + Math.sign(notches) * step, min, max, step) : moved;
}

/**
 * What an int row makes of an entry — a typed number, a stepper key, a fader
 * position. `null` means "put the value already in force back on screen and
 * report nothing".
 *
 * Two entries resolve to nothing. A cleared field is not a zero: select-all-then-
 * retype passes through `""`, and a blur in that gap must leave the parameter
 * alone rather than collapse the board to its minimum. And a key at its own
 * limit, or a number typed past it, clamps to the value already in force — the
 * stepper keys deliberately stay enabled at the ends, so this is reachable on
 * the first click, and `onChange` on a structural parameter costs the run.
 */
export function intEntry(
  raw: string | number,
  current: number,
  min: number,
  max: number,
): number | null {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '') return null;
  const typed = Number(text);
  if (!Number.isFinite(typed)) return null;
  const value = clampInt(typed, min, max);
  return value === current ? null : value;
}

/** NaN maps to 0: every comparison against it is false, which is the intent here. */
function clamp01(n: number): number {
  return n > 1 ? 1 : n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

type Setter = (value: ParamValue) => void;

export function createControls(
  host: HTMLElement,
  specs: readonly ParamSpec[],
  values: ParamValues,
  onChange: (key: string, value: ParamValue) => void,
): ControlsHandle {
  // Idempotent with the shell, which builds `form.controls` as a region: adding
  // a class it already carries costs nothing and keeps the component correct if
  // it is ever mounted somewhere plainer.
  host.classList.add('controls');
  if (!host.hasAttribute('aria-label')) host.setAttribute('aria-label', 'Parameters');
  clear(host);

  const setters = new Map<string, Setter>();

  for (const spec of orderedSpecs(specs)) {
    const initial = values[spec.key] ?? spec.default;
    const built = buildRow(spec, initial, onChange);
    setters.set(spec.key, built.set);
    host.append(built.row);
  }

  return {
    setValues(next) {
      for (const [key, set] of setters) {
        const value = next[key];
        if (value !== undefined) set(value);
      }
    },
    setValue(key, value) {
      setters.get(key)?.(value);
    },
    destroy() {
      setters.clear();
      clear(host);
    },
  };
}

/** DESIGN §4: the seed is the last row of the rail. Otherwise declared order. */
function orderedSpecs(specs: readonly ParamSpec[]): ParamSpec[] {
  const seeds = specs.filter((s) => s.kind === 'seed');
  return seeds.length === 0 ? [...specs] : [...specs.filter((s) => s.kind !== 'seed'), ...seeds];
}

interface Row {
  row: HTMLElement;
  set: Setter;
}

function buildRow(
  spec: ParamSpec,
  initial: ParamValue,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  switch (spec.kind) {
    case 'range':
      return rangeRow(spec, asNumber(initial, spec.default), onChange);
    case 'int':
      return intRow(spec, asNumber(initial, spec.default), onChange);
    case 'toggle':
      return toggleRow(spec, initial === true, onChange);
    case 'choice':
      return choiceRow(spec, typeof initial === 'string' ? initial : spec.default, onChange);
    case 'seed':
      return seedRow(spec, asNumber(initial, spec.default), onChange);
  }
}

// ---------------------------------------------------------------------------
// Range — the graduated fader
// ---------------------------------------------------------------------------

function rangeRow(
  spec: Extract<ParamSpec, { kind: 'range' }>,
  initial: number,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  const id = nextId(spec.key);
  const helpId = spec.help ? `${id}-help` : undefined;
  const decimals = decimalsForStep(spec.step);
  const isLog = spec.log === true && spec.min > 0 && spec.max > spec.min;
  const positions = isLog ? logPositions(spec.min, spec.max, spec.step) : 0;

  const valueText = document.createTextNode('');
  const output = h(
    'output',
    { class: 'window control__value', for: id, 'aria-live': 'off' },
    valueText,
    spec.unit ? h('span', { class: 'window__unit' }, spec.unit) : null,
  );

  const input = h('input', {
    class: 'range',
    id,
    type: 'range',
    min: isLog ? 0 : spec.min,
    max: isLog ? positions : spec.max,
    step: isLog ? 1 : spec.step,
    'aria-describedby': helpId,
  });

  // A log fader's own value is a position — 304,036 of 396,140 — so the number
  // it stands for has to be published, or the slider announces nothing at all.
  // A unit is announced for the same reason: the window shows it, the input does
  // not carry it.
  const publish = (value: number): void => {
    valueText.data = withMinus(value.toFixed(decimals));
    if (isLog || spec.unit) {
      input.setAttribute('aria-valuetext', spec.unit ? `${valueText.data} ${spec.unit}` : valueText.data);
    }
  };

  const snap = (value: number): number => snapToStep(value, spec.min, spec.max, spec.step);

  const positionFor = (value: number): number =>
    isLog ? logPositionFor(value, spec.min, spec.max, spec.step) : value;

  const valueFor = (position: number): number =>
    isLog ? logValueFor(position, spec.min, spec.max, spec.step) : snap(position);

  let current = snap(initial);
  input.value = String(positionFor(current));
  publish(current);

  const commit = (value: number): void => {
    // Most positions of a log fader decode to the value already in force — that
    // is the price of a position grid fine enough to land on every value — and
    // a change reported from one of them resets the run.
    if (value === current) return;
    current = value;
    publish(value);
    onChange(spec.key, value);
  };

  input.addEventListener('input', () => commit(valueFor(input.valueAsNumber)));

  if (isLog) {
    // The browser's own arrow moves one position, which over the lower decades
    // is no movement at all: 41 presses to get Galton's ball count off 1. A
    // press moves one notch of travel, or one step, whichever actually lands on
    // a different value.
    input.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const notches = nudgeNotches(event.key);
      if (notches === 0) return;
      event.preventDefault();
      const next = nudgeLogValue(current, spec.min, spec.max, spec.step, notches);
      input.value = String(positionFor(next));
      commit(next);
    });
  }

  const row = h(
    'div',
    { class: 'control control--range' },
    h('label', { class: 'control__label', for: id }, spec.label),
    output,
    input,
    scale(spec.min, spec.max, decimals),
    help(spec.help, helpId),
  );

  if (isLog) {
    row.classList.add('control--log');
    // Majors at the ends, one minor per decade.
    input.style.setProperty('--ticks', String(round4(Math.log10(spec.max / spec.min))));
  } else {
    engrave(input, spec.min, spec.max, spec.step);
  }

  return {
    row,
    set(value) {
      current = snap(asNumber(value, current));
      input.value = String(positionFor(current));
      publish(current);
    },
  };
}

/**
 * Arrows move a notch, Page keys a tenth of the travel. Both are handled here
 * rather than left to the browser because a log fader's positions are finer
 * than its values; Home and End are not, because the ends are exact positions.
 */
function nudgeNotches(key: string): number {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return 1;
    case 'ArrowLeft':
    case 'ArrowDown':
      return -1;
    case 'PageUp':
      return LOG_NOTCHES / 10;
    case 'PageDown':
      return -LOG_NOTCHES / 10;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Int — fader plus the stepper that mirrors it
// ---------------------------------------------------------------------------

function intRow(
  spec: Extract<ParamSpec, { kind: 'int' }>,
  initial: number,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  const id = nextId(spec.key);
  const faderId = `${id}-fader`;
  const helpId = spec.help ? `${id}-help` : undefined;

  const field = h('input', {
    class: 'window stepper__input',
    id,
    type: 'number',
    inputmode: 'numeric',
    min: spec.min,
    max: spec.max,
    step: 1,
    'aria-describedby': helpId,
  });

  const fader = h('input', {
    class: 'range',
    id: faderId,
    type: 'range',
    min: spec.min,
    max: spec.max,
    step: 1,
    // The row's <label> names the field, which is the exact value; the fader is
    // the same quantity by another means and carries the name itself.
    'aria-label': spec.label,
    'aria-describedby': helpId,
  });

  let current = clampInt(initial, spec.min, spec.max);

  const show = (value: number): void => {
    field.value = String(value);
    fader.value = String(value);
    // The window carries no unit — the stepper is a three-column group with no
    // room for one — so the fader announces it and the scale is engraved with
    // it below. Without this the row is the only place the quantity appears
    // unitless, while the caption under the plate reads "Line spacing 64px".
    if (spec.unit !== undefined) fader.setAttribute('aria-valuetext', `${value} ${spec.unit}`);
  };

  const commit = (raw: string | number): void => {
    const value = intEntry(raw, current, spec.min, spec.max);
    if (value === null) {
      // Nothing to report — but the entry may still be on screen ("", or a
      // number past the end), so the row is put back to the value in force.
      show(current);
      return;
    }
    current = value;
    show(value);
    onChange(spec.key, value);
  };

  // The number field commits on `change`, not `input`: mid-typing, "1" on the
  // way to "12" is a legal number and clamping it would fight the typist.
  field.addEventListener('change', () => commit(field.value));
  fader.addEventListener('input', () => commit(fader.valueAsNumber));

  // The keys never go `disabled` at the ends. `.control:has(:disabled)` mutes
  // the whole row, so a board sitting at its maximum would read as switched off.
  // They step from the committed value, not the field text, which may be a
  // half-typed number or nothing at all.
  const stepBy = (delta: number) => () => commit(current + delta);

  const stepper = h(
    'div',
    { class: 'stepper' },
    h(
      'button',
      { class: 'stepper__key', type: 'button', 'aria-label': `Decrease ${spec.label}`, onclick: stepBy(-1) },
      monoMinus(),
    ),
    field,
    h(
      'button',
      { class: 'stepper__key', type: 'button', 'aria-label': `Increase ${spec.label}`, onclick: stepBy(1) },
      '+',
    ),
  );

  show(current);
  engrave(fader, spec.min, spec.max, 1);

  const row = h(
    'div',
    { class: 'control control--int' },
    h('label', { class: 'control__label', for: id }, spec.label),
    stepper,
    fader,
    scale(spec.min, spec.max, 0, spec.unit),
    help(spec.help, helpId),
  );

  return {
    row,
    set(value) {
      current = clampInt(asNumber(value, current), spec.min, spec.max);
      show(current);
    },
  };
}

// ---------------------------------------------------------------------------
// Toggle, choice, seed
// ---------------------------------------------------------------------------

function toggleRow(
  spec: Extract<ParamSpec, { kind: 'toggle' }>,
  initial: boolean,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  const id = nextId(spec.key);
  const helpId = spec.help ? `${id}-help` : undefined;

  const input = h('input', {
    class: 'switch',
    id,
    type: 'checkbox',
    role: 'switch',
    'aria-describedby': helpId,
  });
  input.checked = initial;
  input.addEventListener('change', () => onChange(spec.key, input.checked));

  // The <label> wraps the input, so the whole 44 px row is the hit target.
  const row = h(
    'div',
    { class: 'control control--toggle' },
    h(
      'label',
      { class: 'switch-row', for: id },
      h('span', { class: 'control__label' }, spec.label),
      input,
    ),
    help(spec.help, helpId),
  );

  return {
    row,
    set(value) {
      input.checked = value === true;
    },
  };
}

function choiceRow(
  spec: Extract<ParamSpec, { kind: 'choice' }>,
  initial: string,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  const id = nextId(spec.key);
  const helpId = spec.help ? `${id}-help` : undefined;

  const select = h('select', { class: 'select', id, 'aria-describedby': helpId });
  for (const option of spec.options) {
    select.append(h('option', { value: option.value }, option.label));
  }
  select.value = spec.options.some((o) => o.value === initial) ? initial : spec.default;
  select.addEventListener('change', () => onChange(spec.key, select.value));

  const row = h(
    'div',
    { class: 'control control--choice' },
    h('label', { class: 'control__label', for: id }, spec.label),
    select,
    help(spec.help, helpId),
  );

  return {
    row,
    set(value) {
      const text = String(value);
      if (spec.options.some((o) => o.value === text)) select.value = text;
    },
  };
}

function seedRow(
  spec: Extract<ParamSpec, { kind: 'seed' }>,
  initial: number,
  onChange: (key: string, value: ParamValue) => void,
): Row {
  const id = nextId(spec.key);
  const helpId = spec.help ? `${id}-help` : undefined;

  const field = h('input', {
    class: 'window seed__input',
    id,
    type: 'number',
    inputmode: 'numeric',
    min: 0,
    step: 1,
    'aria-describedby': helpId,
  });
  field.value = String(toSeed(initial));

  field.addEventListener('change', () => {
    const seed = toSeed(Number(field.value));
    field.value = String(seed);
    onChange(spec.key, seed);
  });

  const randomize = h(
    'button',
    {
      class: 'key seed__random',
      type: 'button',
      onclick: () => {
        const seed = randomSeed();
        field.value = String(seed);
        onChange(spec.key, seed);
      },
    },
    'Randomize',
  );

  const row = h(
    'div',
    { class: 'control control--seed' },
    h('label', { class: 'control__label', for: id }, spec.label),
    h('div', { class: 'seed' }, field, randomize),
    help(spec.help, helpId),
  );

  return {
    row,
    set(value) {
      field.value = String(toSeed(asNumber(value, initial)));
    },
  };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function help(text: Prose | undefined, id: string | undefined): HTMLElement | null {
  // Help is content, not a tooltip: this is a teaching tool and the sentence
  // explaining what a parameter means belongs on the page (DESIGN §5). It is
  // also where the mathematics is densest — `N(n·p, n·p·(1−p))` — so it is
  // prose, and its variables come out in italic rather than as roman words.
  if (text === undefined || text === '') return null;
  return h('p', { class: 'control__help', id }, ...prose(text));
}

/**
 * The engraved ends. A row whose value window cannot carry the unit — the int
 * row's stepper — engraves it on the top of the scale instead, the way an
 * instrument marks a dial once at its end.
 */
function scale(min: number, max: number, decimals: number, unit?: string): HTMLElement {
  const top = endLabel(max, decimals);
  return h(
    'div',
    { class: 'control__scale', 'aria-hidden': 'true' },
    h('span', { class: 'control__min' }, endLabel(min, decimals)),
    h('span', { class: 'control__max' }, unit === undefined ? top : `${top} ${unit}`),
  );
}

/** Scale numerals are read at a glance, so they lose trailing zeros: 0.1, not 0.10. */
function endLabel(value: number, decimals: number): string {
  if (Number.isInteger(value)) return withMinus(String(value));
  const text = value.toFixed(decimals);
  return withMinus(text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);
}

/**
 * Engrave one minor graduation per step, but only while the steps are countable.
 * `--ticks` is registered as a `<number>`, so writing it is safe; writing 1000
 * of them would just paint the track grey.
 */
function engrave(input: HTMLInputElement, min: number, max: number, step: number): void {
  if (!(step > 0)) return;
  const steps = (max - min) / step;
  if (steps >= 1 && steps <= MAX_ENGRAVED_TICKS) input.style.setProperty('--ticks', String(round4(steps)));
}

function quantize(value: number, min: number, max: number, step: number, decimals: number): number {
  const clamped = value < min ? min : value > max ? max : value;
  if (!Number.isFinite(clamped)) return min;
  if (!(step > 0)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  const bounded = snapped < min ? min : snapped > max ? max : snapped;
  // Snapping accumulates the usual binary noise — 0.1 + 0.2 — and the value is
  // about to be printed, compared against a default and put in a URL.
  return decimals > 0 ? Number(bounded.toFixed(decimals)) : Math.round(bounded);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.round(value);
  return n < min ? min : n > max ? max : n;
}

/** Same 32-bit reduction the RNG applies, so the field shows the stream it will get. */
function toSeed(value: number): number {
  return Number.isFinite(value) ? value >>> 0 : 0;
}

function asNumber(value: ParamValue, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0;
  const text = String(step);
  const e = text.indexOf('e');
  if (e < 0) return Math.min(10, (text.split('.')[1] ?? '').length);
  // 1e-7 prints in exponent form; the exponent is where the decimals went.
  const exponent = Number(text.slice(e + 1));
  const mantissa = (text.slice(0, e).split('.')[1] ?? '').length;
  return Math.min(10, Math.max(0, mantissa - exponent));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

let uid = 0;

/** Ids must survive a tab swap: two visualizations can both declare `seed`. */
function nextId(key: string): string {
  uid += 1;
  return `ctl-${uid}-${key.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
