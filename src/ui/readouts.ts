/**
 * The readouts: one number in plain words.
 *
 * The page is written for a reader with no statistics, and this region is now
 * one thing: the headline reading at 40 px, its plain-language label, and one
 * sentence that says whether the reading agrees with what the mathematics
 * predicts — "matches the prediction of 6", "within 2% of 3.1416", "still
 * settling". The "Show the exact numbers" disclosure that used to sit under it
 * is gone, and the Measured / Analytic / Error table went with it: a control
 * whose entire job is to reveal a second, more technical copy of the answer is
 * a question asked of every reader on every tab, and the owner's answer was no.
 *
 * The ledger itself survives, unrendered, because it is not decoration. A canvas
 * is opaque to assistive technology and ARCHITECTURE.md makes the readout list
 * the accessible representation of what a visualization actually produced — the
 * headline is one of a tab's five or six readings, and the other four are only
 * here. So the table is built exactly as before and clipped out of the visual
 * layer (`.readouts__ledger`, theme.css §8), which leaves it to a screen reader
 * and to print, where §16c lays the page out as a handout. Nothing on screen
 * refers to it and nothing opens it.
 *
 * One rule decides agreement. The verdict sentence, the ledger row's state and
 * the live-region sentence the shell speaks on pause all go through
 * `verdictOf()`, with the band each readout declares, so the spoken answer can
 * never disagree with the printed one.
 *
 * The band is the whole of the honesty of this page. It has to shrink as the
 * run gathers evidence, it has to be narrow enough to rule something out, and
 * where a visualization declares none the ledger invents nothing — it reports
 * the reading and makes no claim. `MAX_BAND_FRACTION` states the ceiling and
 * why it is where it is.
 *
 * Nothing here may move when a digit changes. Every number sits in a box whose
 * width is reserved up front from the digits the reading can need, and the
 * hero's three lines have fixed heights. Rows are keyed and reused, and writes
 * are throttled to ~10 Hz with a trailing flush so the frame a run pauses on
 * always reaches the page.
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

/** Standard errors a `sampled` band spans when the readout does not say. */
const DEFAULT_SIGMAS = 3;

/**
 * The widest band, as a fraction of the scale the reading is judged against,
 * that may still print the word "matches".
 *
 * The ceiling is the worst disagreement a check mark can ever sit beside, so it
 * is not a matter of taste; it is read off the two measurements that bound it.
 *
 * Above: the smallest band this app was caught certifying nonsense through was
 * Monte Carlo π's 16 % at the left stop of its fader, which printed 3.36000
 * under "matches the prediction of 3.14159" — a 6.9 % disagreement. A ceiling
 * that allows 6.9 % allows that sentence, so it has to be below it.
 *
 * Below: the Galton board's Mean bin is three standard errors wide at 3.87 % on
 * its default 12 rows and 500 balls, and no amount of running fixes that — it
 * is the honest resolution of the measurement. A ceiling under 3.87 % would
 * make a correct board read "still settling" for ever.
 *
 * A twentieth of the prediction is the round number between them, and it has a
 * plain meaning: the ledger says "matches" only where the reading and the
 * prediction are within five per cent of each other, which is what a reader
 * with no statistics takes the word to mean. Bands wider than this are not
 * wrong — three standard errors of a variance over 500 balls really is 19 % —
 * they are simply not tests, and the verdict says so instead.
 *
 * The ceiling lives here, with the one rule of agreement, rather than in each
 * visualization: a tab cannot ship a band nobody looked at.
 */
export const MAX_BAND_FRACTION = 0.05;

/** What the verdict says when there is no band to judge with at all. */
const UNRESOLVED_TEXT = 'not enough data to judge';

/** What it says when the run has not resolved the reading against its prediction yet. */
const SETTLING_TEXT = 'still settling';

/** Beyond this relative error the sentence stops quoting a percentage and says "still settling". */
const SETTLING_FROM = 0.1;

/** Counts get thousands separators from here up; `fmt()` deliberately emits none. */
const GROUP_FROM = 10_000;

/** Stands in for a reading that does not exist yet, rather than a 40 px "NaN". */
const EM_DASH = '—';

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
 * A declared `Band`, resolved against the ceiling.
 *
 * Three outcomes, and the two that are not a band are not the same thing. A
 * band the run has not sharpened enough to test anything is a statement about
 * *this moment* — keep going and it becomes one. No band at all is a statement
 * about the tab: nothing was declared, or what was declared is not a number, so
 * there is nothing to judge with and no amount of running changes that.
 */
type Resolved =
  | { kind: 'usable'; half: number }
  | { kind: 'too-wide' }
  | { kind: 'undeclared' };

/**
 * The half-width the readout declares, in the reading's own units, before the
 * ceiling is applied. `null` where nothing was declared.
 */
function declaredHalfWidth(readout: Readout, target: number): number | null {
  const size = Math.abs(target);
  const band = readout.band;
  const tolerance = readout.tolerance;
  // Declaring both is a contradiction, not a fallback. Choosing one of them
  // here would be the ledger deciding which of two numbers a tab meant, which
  // is the whole family of defect this rule exists to remove.
  if (band !== undefined && tolerance !== undefined) return Number.NaN;
  // The bare number is relative, except against a zero target where a relative
  // band states nothing at all and an absolute one is the only reading that
  // means anything. `relative` keeps the first half of that and refuses the
  // second, so a tab that means ± 0.02 has to say so.
  if (tolerance !== undefined) return size > 0 ? tolerance * size : tolerance;
  if (band === undefined) return null;
  switch (band.kind) {
    case 'exact':
      return 0;
    case 'absolute':
      return band.half;
    case 'relative':
      return size > 0 ? band.fraction * size : Number.NaN;
    case 'sampled': {
      // Standard errors of the mean of `samples` observations. The division is
      // done here rather than in the visualization so the band cannot fail to
      // shrink: it falls as 1/√n for every tab, on every frame, with no way to
      // declare a constant by accident.
      const sigmas = band.sigmas ?? DEFAULT_SIGMAS;
      const n = Math.floor(band.samples);
      return n >= 1 ? (sigmas * Math.abs(band.sigma)) / Math.sqrt(n) : Number.NaN;
    }
  }
}

/**
 * The scale the band is judged against: the prediction's own size, never larger
 * than the span the quantity is allowed to occupy.
 *
 * The smaller of the two, always. Taking the prediction alone lets a reading
 * bounded in [0, 1] carry a band of 0.74; taking the range alone would let a
 * tab buy itself any ceiling it liked by declaring a wide enough one.
 *
 * Where the prediction is exactly zero it is no scale at all — every band is
 * infinitely many times it — so the range is the only thing left, and a tab
 * predicting zero without declaring one gets no verdict. That is the honest
 * answer: "0 ± 0.02" says nothing until something on the page says what 0.02 is
 * a fraction of.
 */
function scaleOf(readout: Readout, target: number): number {
  const span = spanOf(readout);
  const size = Math.abs(target);
  if (size > 0) return Math.min(size, span);
  return Number.isFinite(span) ? span : 0;
}

/** The width of the declared range, or Infinity where there is none to speak of. */
function spanOf(readout: Readout): number {
  const range = readout.range;
  if (range === undefined) return Infinity;
  const width = range[1] - range[0];
  // A reversed or empty range is a mistake in the declaration, not a claim that
  // the quantity is pinned: it is ignored rather than certifying everything.
  return Number.isFinite(width) && width > 0 ? width : Infinity;
}

function bandFor(readout: Readout): Resolved {
  const target = readout.target;
  if (target === undefined || !Number.isFinite(target)) return { kind: 'undeclared' };
  const declared = declaredHalfWidth(readout, target);
  // A band that is not a number — a standard error over zero samples, a fit
  // with no residual degrees of freedom, a negative width — cannot judge
  // anything, and quietly substituting a percentage here is the whole defect.
  if (declared === null || !Number.isFinite(declared) || declared < 0) return { kind: 'undeclared' };
  if (declared > MAX_BAND_FRACTION * scaleOf(readout, target)) return { kind: 'too-wide' };
  return { kind: 'usable', half: declared };
}

/**
 * The half-width of the band `agrees()` applies, or `null` where the reading
 * has none that could test anything.
 *
 * Two properties fall out of the ceiling and are worth naming, because the tabs
 * were breaking both. The band is at most a twentieth of the span the quantity
 * can occupy, so it can never be most of the answer. And it is at most a
 * twentieth of the prediction, so it cannot reach zero from a non-zero
 * prediction: Parrondo's whole result is that each game on its own *loses*, and
 * no interval that also contains a winning game can be used to certify it.
 */
export function bandOf(readout: Readout): number | null {
  const band = bandFor(readout);
  return band.kind === 'usable' ? band.half : null;
}

/** Does a reading agree with its prediction, inside the band the readout declares? */
export function agrees(readout: Readout): boolean {
  const target = readout.target;
  if (target === undefined || !Number.isFinite(readout.value)) return false;
  const half = bandOf(readout);
  return half !== null && Math.abs(readout.value - target) <= half;
}

/**
 * Can this reading test its prediction at all? A band inside the ceiling is a
 * test; a wider one cannot produce the word "matches", whatever it measures,
 * and a reading with no prediction or no band has nothing to test.
 */
export function testable(readout: Readout): boolean {
  return bandFor(readout).kind === 'usable';
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
  const band = bandFor(readout);
  // Nothing was declared, or what was declared cannot judge. The prediction is
  // not quoted, because quoting it is what makes the sentence a claim.
  if (band.kind === 'undeclared') return { text: UNRESOLVED_TEXT, state: 'none' };
  // A band too wide to rule anything out is a run that has not got there yet,
  // and that is what the reader is told. "matches the prediction of 3.14159"
  // under a printed 3.36000 is read as a claim about π, never as a claim about
  // a 16 % band.
  if (band.kind === 'too-wide') return { text: SETTLING_TEXT, state: 'far' };
  // With its unit, where there is one: the hero prints "79.3 %" above this
  // line, and a prediction of "78.5" under it is a different quantity.
  const shown = num(target, readout.digits ?? 4) + (readout.unit ? ` ${readout.unit}` : '');
  if (Math.abs(readout.value - target) <= band.half) {
    return { text: `matches the prediction of ${shown}`, state: 'agree' };
  }
  const off = target === 0 ? Infinity : Math.abs((readout.value - target) / target);
  if (off < SETTLING_FROM) return { text: `within ${percent(off)} of ${shown}`, state: 'near' };
  return { text: SETTLING_TEXT, state: 'far' };
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
  const ledger = buildLedger();
  host.append(summary, hero.root, ledger.root);

  let structure = '';
  const rows = new Map<string, RowParts>();

  let lastWrite = 0;
  let pending: readonly Readout[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rebuild(readouts: readonly Readout[], signature: string): void {
    structure = signature;
    rows.clear();
    clear(ledger.tbody);

    const first = headlineOf(readouts);
    hero.root.hidden = first === undefined;
    // A new headline is a new budget: the width reserved for the last one
    // belongs to a different quantity.
    hero.reserved = 0;
    setText(hero.unit, first?.unit ?? '');

    for (const readout of readouts) {
      const parts = buildRow(readout);
      rows.set(readout.key, parts);
      ledger.tbody.append(parts.tr);
    }
    ledger.root.hidden = readouts.length === 0;
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
  hint: Text;
  /** Glyphs currently reserved for the number, in ch. Only ever grows within a structure. */
  reserved: number;
}

function buildHero(): Hero {
  const value = document.createTextNode('');
  const unit = document.createTextNode('');
  const label = document.createTextNode('');
  const verdict = document.createTextNode('');
  const hint = document.createTextNode('');
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
    // The hint is context, not a comparison, so it gets a line of its own under
    // the verdict rather than taking its place. The row collapses to nothing
    // when the reading carries no hint, and a hint belongs to the reading
    // rather than to its value, so nothing here moves as a digit changes.
    h('p', { class: 'hero__hint' }, hint),
  );
  return { root, number, value, unit, label, verdict, hint, reserved: 0 };
}

interface Ledger {
  root: HTMLElement;
  tbody: HTMLElement;
}

/**
 * Every reading the visualization publishes, as a table — clipped out of the
 * visual layer and left to a screen reader and to print.
 *
 * There is no disclosure and no control of any kind here any more. What is left
 * is the obligation the disclosure happened to be discharging: every number a
 * tab draws on its canvas also goes through `emit()` precisely so that a reader
 * who cannot see the canvas still has them, and the hero shows exactly one of
 * them. Dropping the table would have taken "Balls landed", "Bins", "Crossings"
 * and every analytic target off the page for that reader entirely.
 */
function buildLedger(): Ledger {
  const tbody = h('tbody', { role: 'rowgroup' });
  const head = (text: string): HTMLElement =>
    h('th', { class: 'ledger__head', role: 'columnheader', scope: 'col' }, text);
  // The whole role chain is explicit, the `<table>` included: the table, its
  // `tbody`, its rows and its cells all take a new `display` at ≤ 599 px, and
  // Chrome and Firefox drop the implicit table role from an element whose
  // display is not a table display — orphaning every row and cell role below.
  const root = h(
    'div',
    { class: 'ledger-wrap readouts__ledger' },
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
  );

  return { root, tbody };
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
  // Where there is no prediction the verdict line is already carrying the hint
  // — that is what `verdictOf()` falls back to — so printing it again here
  // would say the same sentence twice.
  setText(hero.hint, readout.target === undefined ? '' : (readout.hint ?? ''));
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
 * so `ch` counts glyphs exactly.
 *
 * A unit is the exception, because the box is invisible only while nothing
 * follows it: the unit is parked at the reservation's end, so slack that costs
 * nothing on a bare number strands `min` 196 px from `10.05` at a 1,440 px
 * viewport. A reading that carries a unit is a measurement in something — a
 * wait in minutes, a share in per cent — and those are quoted plainly rather
 * than in exponent form, so the reservation is the significant figures plus a
 * sign and a point. A reading that outgrows even that widens the box once,
 * which is the one move `reserve()` has always allowed.
 */
function budgetOf(readout: Readout): number {
  const digits = Math.max(1, Math.round(readout.digits ?? 4));
  return digits + (readout.unit ? 2 : 8);
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

  // One rule, one call: the row's state is the hero's verdict translated into
  // the ledger's vocabulary, so what a screen reader is told and what the hero
  // prints cannot disagree about whether a number arrived.
  const reading = verdictOf(readout);
  const ok = reading.state === 'agree';
  setText(parts.target, num(target, digits));
  setText(parts.abs, measured ? signed(readout.value - target, digits) : '');
  setText(parts.rel, measured ? relative(readout.value, target) : '');
  // The state is carried three ways — colour, the dotted underline the CSS drops
  // on agreement, and the square — plus text, because none of the three is
  // available to a screen reader. "not there yet" is a claim of its own — that
  // the run is still arriving — so a row with no band to judge by says the
  // other thing rather than borrowing it.
  setText(
    parts.stateText,
    ok
      ? 'agrees with the prediction'
      : !measured
        ? 'not measured yet'
        : reading.state === 'none'
          ? UNRESOLVED_TEXT
          : 'not there yet',
  );
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
