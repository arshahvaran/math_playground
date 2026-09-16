/**
 * The readouts: one number in plain words, and the exact table behind a
 * disclosure.
 *
 * The default view is written for a reader with no statistics. It shows the
 * headline reading at 40 px, its plain-language label, and one sentence that
 * says whether the reading agrees with what the mathematics predicts —
 * "matches the prediction of 6", "within 2% of 3.1416", "still settling". The
 * full Measured / Analytic / Error table is still here, unchanged, under
 * "Show the exact numbers"; it is the accessible representation of the plate
 * and the text the convergence tests read, so nothing is lost by demoting it.
 *
 * One rule decides agreement. The verdict sentence, the table row's state and
 * the live-region sentence the shell speaks on pause all go through
 * `agrees()`, with the tolerance each readout declares, so the simple view can
 * never disagree with the exact one.
 *
 * Nothing here may move when a digit changes. Every number sits in a box whose
 * width is reserved up front from the digits the reading can need, the hero's
 * three lines have fixed heights, and the table is laid out with fixed columns.
 * Rows are keyed and reused, and writes are throttled to ~10 Hz with a trailing
 * flush so the frame a run pauses on always reaches the page.
 */

import type { Readout } from '../core/types';
import { fmt } from '../core/stats';
import { clear, h, monoMinus, prose, proseText, withMinus } from './dom';

export interface ReadoutsHandle {
  update(readouts: readonly Readout[]): void;
  /**
   * Write the one live region on the page: a single sentence, on pause,
   * preset change and route change — never during a run.
   */
  announce(sentence: string): void;
  destroy(): void;
}

/** ~10 Hz. Faster is illegible; the trailing flush is what matters. */
const WRITE_INTERVAL_MS = 100;

/** Relative error inside which a reading counts as agreeing, when none is declared. */
const DEFAULT_TOLERANCE = 0.01;

/** Beyond this relative error the sentence stops quoting a percentage and says "still settling". */
const SETTLING_FROM = 0.1;

/** Counts get thousands separators from here up; `fmt()` deliberately emits none. */
const GROUP_FROM = 10_000;

/** Stands in for a reading that does not exist yet, rather than a 40 px "NaN". */
const EM_DASH = '—';

/** Namespaced like the scheme preference, so a sibling project on the same origin cannot collide. */
const EXACT_KEY = 'mp:exact';

// ---------------------------------------------------------------------------
// The one rule of agreement — shared with the live region in main.ts
// ---------------------------------------------------------------------------

export type Verdict = 'agree' | 'near' | 'far' | 'none';

export interface Reading {
  /** The sentence under the headline. Empty when there is nothing to say. */
  text: string;
  state: Verdict;
}

/**
 * The reading a newcomer should look at first: the one the visualization marks
 * as its headline, else the first with a prediction to compare against, else
 * the first that is not an internal.
 */
export function headlineOf(readouts: readonly Readout[]): Readout | undefined {
  const shown = readouts.filter((r) => r.expertOnly !== true);
  return (
    readouts.find((r) => r.headline === true) ??
    shown.find((r) => r.target !== undefined) ??
    shown[0]
  );
}

/** The plain-language label where the visualization gives one, else its precise name. */
export function plainLabel(readout: Readout): string {
  return readout.plain ?? readout.label;
}

/**
 * Does a reading agree with its prediction, to the tolerance the readout
 * declares? A target of exactly zero has no relative error, so the tolerance
 * is read as an absolute one there — the only reading that means anything.
 */
export function agrees(readout: Readout, target: number): boolean {
  const tolerance = toleranceOf(readout);
  const scale = Math.abs(target);
  const error = Math.abs(readout.value - target);
  return scale === 0 ? error <= tolerance : error / scale <= tolerance;
}

/**
 * The sentence under the headline. Never a signed residual: a reader with no
 * statistics is told whether the number agrees, how close it is when it does
 * not yet, and nothing else.
 */
export function verdictOf(readout: Readout): Reading {
  if (!Number.isFinite(readout.value)) return { text: 'not measured yet', state: 'none' };
  const target = readout.target;
  if (target === undefined) return { text: readout.hint ?? '', state: 'none' };
  const shown = num(target, readout.digits ?? 4);
  if (agrees(readout, target)) return { text: `matches the prediction of ${shown}`, state: 'agree' };
  const off = target === 0 ? Infinity : Math.abs((readout.value - target) / target);
  if (off < SETTLING_FROM) return { text: `within ${percent(off)} of ${shown}`, state: 'near' };
  return { text: 'still settling', state: 'far' };
}

/** The headline as one spoken sentence, for the live region. */
export function sentenceOf(readout: Readout): string {
  const label = plainLabel(readout);
  if (!Number.isFinite(readout.value)) return `${label} not measured yet.`;
  let text = `${label} ${num(readout.value, readout.digits ?? 4)}`;
  if (readout.unit) text += ` ${readout.unit}`;
  if (readout.target !== undefined) text += `, ${verdictOf(readout).text}`;
  return `${text}.`;
}

function toleranceOf(readout: Readout): number {
  const declared = readout.tolerance;
  return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_TOLERANCE;
}

/**
 * A fraction as a percentage rounded UP to one significant figure — 0.0011 is
 * "0.2%", 0.023 is "3%" — so "within 3%" is always true of the number it
 * describes and never carries a fourth decimal a reader would have to parse.
 */
function percent(fraction: number): string {
  const p = fraction * 100;
  if (!(p > 0)) return '0%';
  const magnitude = 10 ** Math.floor(Math.log10(p));
  const rounded = Math.ceil(p / magnitude - 1e-9) * magnitude;
  const decimals = Math.max(0, -Math.floor(Math.log10(rounded)));
  return `${rounded.toFixed(decimals)}%`;
}

// ---------------------------------------------------------------------------
// createReadouts
// ---------------------------------------------------------------------------

export function createReadouts(host: HTMLElement): ReadoutsHandle {
  // Idempotent with the shell, which builds `section.readouts` as a region.
  host.classList.add('readouts');
  if (!host.hasAttribute('aria-label')) host.setAttribute('aria-label', 'Readouts');
  clear(host);

  const summary = h('p', { class: 'readouts__summary visually-hidden', 'aria-live': 'polite' });
  const hero = buildHero();
  const exact = buildExact();
  host.append(summary, hero.root, exact.root);

  let structure = '';
  const rows = new Map<string, RowParts>();

  let lastWrite = 0;
  let pending: readonly Readout[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rebuild(readouts: readonly Readout[], signature: string): void {
    structure = signature;
    rows.clear();
    clear(exact.tbody);

    const first = headlineOf(readouts);
    hero.root.hidden = first === undefined;
    // A new headline is a new budget: the width reserved for the last one
    // belongs to a different quantity.
    hero.reserved = 0;
    setText(hero.unit, first?.unit ?? '');

    for (const readout of readouts) {
      const parts = buildRow(readout);
      rows.set(readout.key, parts);
      exact.tbody.append(parts.tr);
    }
    exact.root.hidden = readouts.length === 0;
  }

  function write(readouts: readonly Readout[]): void {
    lastWrite = clock();
    pending = null;
    const first = headlineOf(readouts);
    if (first) writeHero(hero, first);
    for (const readout of readouts) {
      const parts = rows.get(readout.key);
      if (parts) writeRow(parts, readout);
    }
  }

  function flush(): void {
    timer = null;
    if (pending) write(pending);
  }

  return {
    update(readouts) {
      const signature = signatureOf(readouts);
      if (signature !== structure) {
        // A structural change is a route, parameter or preset change — never a
        // frame — so it is written immediately, throttle or no throttle.
        rebuild(readouts, signature);
        write(readouts);
        return;
      }
      const wait = WRITE_INTERVAL_MS - (clock() - lastWrite);
      if (wait <= 0) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        write(readouts);
        return;
      }
      // Trailing, not leading-only: the frame the simulation pauses on has to
      // reach the page even though it arrived inside the throttle window.
      pending = readouts;
      if (timer === null) timer = setTimeout(flush, wait);
    },

    announce(sentence) {
      summary.textContent = sentence;
    },

    destroy() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      rows.clear();
      structure = '';
      exact.destroy();
      clear(host);
    },
  };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Everything that changes the DOM rather than the text inside it. The record
 * separator is U+241E, a printable glyph no key, unit or formula contains.
 */
function signatureOf(readouts: readonly Readout[]): string {
  return readouts
    .map(
      (r) =>
        `${r.key}|${r.target === undefined ? '' : 'T'}|${r.unit ?? ''}|${proseText(r.formula)}|` +
        `${r.headline === true ? 'H' : ''}|${r.expertOnly === true ? 'X' : ''}`,
    )
    .join('␞');
}

interface Hero {
  root: HTMLElement;
  /** The box the digits sit in. Its `min-width` is the reservation. */
  number: HTMLElement;
  value: Text;
  unit: Text;
  label: Text;
  verdict: Text;
  /** Glyphs currently reserved for the number, in ch. Only ever grows within a structure. */
  reserved: number;
}

function buildHero(): Hero {
  const value = document.createTextNode('');
  const unit = document.createTextNode('');
  const label = document.createTextNode('');
  const verdict = document.createTextNode('');
  const number = h('span', { class: 'hero__number' }, value);
  const root = h(
    'div',
    { class: 'hero', 'data-state': 'none', 'data-measured': 'false' },
    h(
      'output',
      { class: 'hero__value', 'aria-live': 'off' },
      number,
      h('span', { class: 'hero__unit' }, unit),
    ),
    h('p', { class: 'hero__label' }, label),
    // The check is decoration: the sentence beside it says the same thing in
    // words, and the mark keeps its box whether or not it is showing so the
    // words never shift when agreement arrives.
    h('p', { class: 'hero__verdict' }, h('span', { class: 'hero__mark', 'aria-hidden': 'true' }, '✓'), verdict),
  );
  return { root, number, value, unit, label, verdict, reserved: 0 };
}

interface Exact {
  root: HTMLDetailsElement;
  tbody: HTMLElement;
  destroy(): void;
}

/**
 * The disclosure and the table inside it. Built once per mount, so the open
 * state survives every rebuild within a route; across routes it is read back
 * from storage, which is allowed to be missing or to throw.
 */
function buildExact(): Exact {
  const tbody = h('tbody', { role: 'rowgroup' });
  const head = (text: string): HTMLElement =>
    h('th', { class: 'ledger__head', role: 'columnheader', scope: 'col' }, text);
  // The whole role chain is explicit, the `<table>` included: at ≤ 599 px the
  // table, its `tbody`, its rows and its cells all take a new `display`, and
  // Chrome and Firefox drop the implicit table role from an element whose
  // display is not a table display — orphaning every row and cell role below.
  const root = h(
    'details',
    { class: 'exact' },
    h('summary', { class: 'exact__summary' }, 'Show the exact numbers'),
    h(
      'div',
      { class: 'ledger-wrap' },
      h(
        'table',
        { class: 'ledger', role: 'table' },
        h(
          'colgroup',
          null,
          h('col', { class: 'ledger__col ledger__col--label' }),
          h('col', { class: 'ledger__col ledger__col--value' }),
          h('col', { class: 'ledger__col ledger__col--target' }),
          h('col', { class: 'ledger__col ledger__col--error' }),
        ),
        h(
          'thead',
          { role: 'rowgroup' },
          h(
            'tr',
            { role: 'row' },
            h(
              'th',
              { class: 'ledger__head', role: 'columnheader', scope: 'col' },
              h('span', { class: 'visually-hidden' }, 'Quantity'),
            ),
            head('Measured'),
            head('Analytic'),
            head('Error'),
          ),
        ),
        tbody,
      ),
    ),
  );

  root.open = readStore(EXACT_KEY) === 'open';
  const onToggle = (): void => writeStore(EXACT_KEY, root.open ? 'open' : 'closed');
  root.addEventListener('toggle', onToggle);

  return {
    root,
    tbody,
    destroy() {
      root.removeEventListener('toggle', onToggle);
    },
  };
}

interface RowParts {
  tr: HTMLElement;
  label: Text;
  value: Text;
  target: Text | null;
  abs: Text | null;
  rel: Text | null;
  stateText: Text | null;
}

function buildRow(readout: Readout): RowParts {
  const label = document.createTextNode('');
  const value = document.createTextNode('');
  const hasTarget = readout.target !== undefined;
  const target = hasTarget ? document.createTextNode('') : null;
  const abs = hasTarget ? document.createTextNode('') : null;
  const rel = hasTarget ? document.createTextNode('') : null;
  const stateText = hasTarget ? document.createTextNode('') : null;

  // The explicit row / cell roles survive the ≤ 599 px `display` change, which
  // otherwise strips table semantics in Chrome and Firefox.
  const tr = h(
    'tr',
    { class: hasTarget ? 'readout' : 'readout readout--none', role: 'row', 'data-state': 'off' },
    h('td', { class: 'readout__label', role: 'cell' }, label),
    h(
      'td',
      { class: 'readout__value', role: 'cell' },
      value,
      readout.unit ? h('span', { class: 'readout__unit' }, readout.unit) : null,
    ),
    // A readout with no target emits no content at all in these two cells, so
    // the handheld collapse really is one line. The closed form the target
    // comes from — n·p, 2L/(πd) — sits beside the number it produced, its
    // variables in italic like every other variable on the page.
    h(
      'td',
      { class: 'readout__target', role: 'cell' },
      target,
      hasTarget && readout.formula ? h('span', { class: 'readout__formula' }, ...prose(readout.formula)) : null,
    ),
    h(
      'td',
      { class: 'readout__error', role: 'cell' },
      abs ? h('span', { class: 'readout__abs' }, abs) : null,
      rel ? h('span', { class: 'readout__rel' }, rel) : null,
      hasTarget ? h('span', { class: 'readout__state' }) : null,
      stateText ? h('span', { class: 'visually-hidden' }, stateText) : null,
    ),
  );

  return { tr, label, value, target, abs, rel, stateText };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function writeHero(hero: Hero, readout: Readout): void {
  const digits = readout.digits ?? 4;
  // A mean over zero samples is NaN — the honest value, and not a reading. At
  // 40 px "NaN" is the loudest thing on the page, so the hero degrades the way
  // the live region does: an em dash where the numeral goes, and a sentence
  // that says nothing has been measured.
  const measured = Number.isFinite(readout.value);
  const text = measured ? num(readout.value, digits) : EM_DASH;
  reserve(hero, Math.max(budgetOf(readout), text.length));
  setText(hero.value, text);
  setText(hero.label, plainLabel(readout));
  const reading = verdictOf(readout);
  setText(hero.verdict, reading.text);
  hero.root.dataset['state'] = reading.state;
  hero.root.dataset['measured'] = String(measured);
}

/**
 * Widen the number's box, never narrow it. The reservation is made from the
 * digits the reading can need before the first frame, so 9 → 10 → 100 → 1,000
 * lays out nothing; a reading that outgrows it anyway — a very small
 * non-integer — is the one move a run is allowed, and it happens once.
 */
function reserve(hero: Hero, glyphs: number): void {
  if (glyphs <= hero.reserved) return;
  hero.reserved = glyphs;
  hero.number.style.setProperty('min-width', `${glyphs}ch`);
}

/**
 * Glyphs a reading can occupy, whatever form `fmt()` gives it.
 *
 * A count is its significant figures plus a thousands separator per three. A
 * measurement is worse: below 1 it is printed with a sign, a point and up to
 * five leading zeros before `fmt()` switches to exponent form — `−0.00000512`
 * is the digits plus eight — and the exponent form is shorter than that. The
 * shell cannot know which forms a reading will pass through, so the box is
 * reserved for the widest of them from the first frame: the Lorenz separation
 * goes from `1.00e−9` through `0.0000512` to `3.64` in one run, and a box
 * reserved from the digits alone grew under it. Martian Mono is fixed pitch,
 * so `ch` counts glyphs exactly, and the box is invisible unless a unit
 * follows it.
 */
function budgetOf(readout: Readout): number {
  const digits = Math.max(1, Math.round(readout.digits ?? 4));
  return digits + 8;
}

function writeRow(parts: RowParts, readout: Readout): void {
  const digits = readout.digits ?? 4;
  // A ratio over nothing is NaN, and a fit over one point is NaN: honest
  // values, not readings. The table degrades the way the hero does — a dash
  // where the number goes, and no error against a prediction that nothing has
  // been measured against yet.
  const measured = Number.isFinite(readout.value);
  setText(parts.label, readout.label);
  setText(parts.value, measured ? num(readout.value, digits) : EM_DASH);

  const target = readout.target;
  if (target === undefined || !parts.target || !parts.abs || !parts.rel || !parts.stateText) {
    parts.tr.dataset['state'] = 'off';
    return;
  }

  const ok = measured && agrees(readout, target);
  setText(parts.target, num(target, digits));
  setText(parts.abs, measured ? signed(readout.value - target, digits) : '');
  setText(parts.rel, measured ? relative(readout.value, target) : '');
  // The state is carried three ways — colour, the dotted underline the CSS drops
  // on agreement, and the square — plus text, because none of the three is
  // available to a screen reader.
  setText(parts.stateText, ok ? 'agrees with the prediction' : measured ? 'not there yet' : 'not measured yet');
  parts.tr.dataset['state'] = ok ? 'agree' : 'off';
}

function relative(value: number, target: number): string {
  if (target === 0) return '';
  const percent = Math.abs((value - target) / target) * 100;
  if (!Number.isFinite(percent)) return '';
  const text = percent >= 1000 ? percent.toFixed(0) : percent >= 0.1 || percent === 0 ? percent.toFixed(1) : percent.toFixed(2);
  return `(${text}%)`;
}

function num(x: number, digits: number): string {
  const text = fmt(x, digits);
  return withMinus(Number.isInteger(x) && Math.abs(x) >= GROUP_FROM ? groupDigits(text) : text);
}

/** The error column always carries an explicit sign. */
function signed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return num(x, digits);
  return (x < 0 ? monoMinus() : '+') + num(Math.abs(x), digits);
}

function groupDigits(text: string): string {
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

function setText(node: Text, text: string): void {
  if (node.data !== text) node.data = text;
}

function clock(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}

/** localStorage throws outright in some privacy modes; a missing preference is not an error. */
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Session-only, then. The disclosure still opens and closes.
  }
}
