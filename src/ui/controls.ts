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
 *   runs over `LOG_POSITIONS` integer positions and the value is computed from
 *   the position, because a range input distributes its steps uniformly and a
 *   1 → 200,000 parameter spends 199,900 of its 200,000 steps in the last
 *   decade otherwise.
 * - An `int` row carries both a fader and the stepper from DESIGN §5. §1 is
 *   explicit that *every* quantity a person can turn is a fader with an engraved
 *   scale, and the stepper is that fader's numeric mirror — the exact value, and
 *   ±1 for a reader who cannot land a 22 px thumb on row 13 of 20.
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
 * Slider positions on a log fader. 1000 gives about three positions per percent
 * of a decade over the widest range in the registry (1 → 200,000), which is
 * finer than the thumb can be placed at any realistic rail width.
 */
const LOG_POSITIONS = 1000;

/** Above this many steps the engraved minor graduations would be a solid bar. */
const MAX_ENGRAVED_TICKS = 20;

// ---------------------------------------------------------------------------
// Log mapping — pure, and the only part of this file a test can reach
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
    max: isLog ? LOG_POSITIONS : spec.max,
    step: isLog ? 1 : spec.step,
    'aria-describedby': helpId,
  });

  // A log fader's own value is a position — 630 of 1000 — so the number it
  // stands for has to be published, or the slider announces nothing meaningful.
  // A unit is announced for the same reason: the window shows it, the input does
  // not carry it.
  const publish = (value: number): void => {
    valueText.data = withMinus(value.toFixed(decimals));
    if (isLog || spec.unit) {
      input.setAttribute('aria-valuetext', spec.unit ? `${valueText.data} ${spec.unit}` : valueText.data);
    }
  };

  const positionFor = (value: number): number =>
    isLog ? Math.round(unmapLogPosition(value, spec.min, spec.max) * LOG_POSITIONS) : value;

  const valueFor = (position: number): number =>
    isLog
      ? quantize(mapLogPosition(position / LOG_POSITIONS, spec.min, spec.max), spec.min, spec.max, spec.step, decimals)
      : quantize(position, spec.min, spec.max, spec.step, decimals);

  input.value = String(positionFor(initial));
  publish(initial);

  input.addEventListener('input', () => {
    // The step is honoured after the log mapping, never before: the position is
    // uniform, the value it lands on is not.
    const value = valueFor(input.valueAsNumber);
    publish(value);
    onChange(spec.key, value);
  });

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
      const n = quantize(asNumber(value, initial), spec.min, spec.max, spec.step, decimals);
      input.value = String(positionFor(n));
      publish(n);
    },
  };
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

  const show = (value: number): void => {
    field.value = String(value);
    fader.value = String(value);
  };

  const commit = (raw: number): void => {
    const value = clampInt(raw, spec.min, spec.max);
    show(value);
    onChange(spec.key, value);
  };

  // The number field commits on `change`, not `input`: mid-typing, "1" on the
  // way to "12" is a legal number and clamping it would fight the typist.
  field.addEventListener('change', () => commit(Number(field.value)));
  fader.addEventListener('input', () => commit(fader.valueAsNumber));

  // The keys never go `disabled` at the ends. `.control:has(:disabled)` mutes
  // the whole row, so a board sitting at its maximum would read as switched off.
  const stepBy = (delta: number) => () => commit(Number(field.value) + delta);

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

  show(clampInt(initial, spec.min, spec.max));
  engrave(fader, spec.min, spec.max, 1);

  const row = h(
    'div',
    { class: 'control control--int' },
    h('label', { class: 'control__label', for: id }, spec.label),
    stepper,
    fader,
    scale(spec.min, spec.max, 0),
    help(spec.help, helpId),
  );

  return {
    row,
    set(value) {
      show(clampInt(asNumber(value, initial), spec.min, spec.max));
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

function scale(min: number, max: number, decimals: number): HTMLElement {
  return h(
    'div',
    { class: 'control__scale', 'aria-hidden': 'true' },
    h('span', { class: 'control__min' }, endLabel(min, decimals)),
    h('span', { class: 'control__max' }, endLabel(max, decimals)),
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
