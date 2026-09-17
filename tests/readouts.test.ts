import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byClass, installDom, type Harness, type MElement } from './dom-harness';
import { DEFAULT_CANVAS_THEME } from '../src/core/canvas';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, Viz, VizContext } from '../src/core/types';
import { registry } from '../src/viz/registry';
import {
  agrees,
  bandOf,
  createReadouts,
  headlineOf,
  MAX_BAND_FRACTION,
  sentenceOf,
  testable,
  verdictOf,
  type ReadoutsHandle,
} from '../src/ui/readouts';

/**
 * The readouts, as a visitor with no statistics meets them: one number, one
 * plain label, one sentence. That is the whole region — the "Show the exact
 * numbers" disclosure is gone, and the table it opened is now clipped out of
 * the visual layer and left to a screen reader and to print.
 *
 * Two things here are contracts with the rest of the page. The verdict under
 * the number and the state of the ledger row come from one rule, so what is
 * spoken can never disagree with what is printed. And nothing lays out when a
 * digit changes: the number's box is reserved before the first frame from the
 * digits the reading can need, and only ever grows.
 */

/** Words the simple view must never print. */
const BANNED = /\b(mean|variance|analytic|converged|estimator|standard error|bin|residual|tolerance|asymptotic)\b/i;

let dom: Harness;
let handle: ReadoutsHandle | null = null;

function mount(): ReadoutsHandle {
  const host = dom.document.createElement('section');
  dom.app.appendChild(host);
  handle = createReadouts(host as unknown as HTMLElement);
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  dom = installDom();
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  dom.teardown();
});

/**
 * The Galton board's readouts, with the plain-language fields the simple view
 * reads.
 *
 * The mean bin declares a real band, because there is no longer any such thing
 * as a reading with a prediction and no band: one ball through twelve rows has
 * a standard deviation of √(12·¼) = √3, so three standard errors over the 500
 * the board drops is 0.067 bins, or 1.1 % of the six it is aimed at.
 */
function galton(mean: number, landed: number): Readout[] {
  return [
    { key: 'landed', label: 'Balls landed', value: landed, digits: 6, plain: 'balls landed' },
    {
      key: 'mean',
      label: 'Mean bin',
      value: mean,
      target: 6,
      band: { kind: 'sampled', sigma: Math.sqrt(3), samples: 6_000 },
      range: [0, 12],
      plain: 'average landing spot',
      headline: true,
      formula: [{ v: 'n' }, '·', { v: 'p' }],
    },
    { key: 'bins', label: 'Bins', value: 13, digits: 2, expertOnly: true },
  ];
}

function hero(): MElement {
  const el = byClass(dom, 'hero')[0];
  if (!el) throw new Error('no hero');
  return el;
}

function verdict(): string {
  return (byClass(dom, 'hero__verdict')[0]?.textContent ?? '').replace('✓', '').trim();
}

function numberBox(): MElement {
  const el = byClass(dom, 'hero__number')[0];
  if (!el) throw new Error('no number box');
  return el;
}

function row(label: string): MElement {
  const found = byClass(dom, 'readout').find((tr) => tr.children[0]?.textContent === label);
  if (!found) throw new Error(`no row for ${label}`);
  return found;
}

describe('the simple view', () => {
  it('shows one headline number, its plain label and one sentence', () => {
    mount().update(galton(5.981, 10_723));
    const text = hero().textContent;
    expect(text).toContain('5.981');
    expect(text).toContain('average landing spot');
    expect(verdict()).toBe('matches the prediction of 6');
    // The precise names stay in the table, not in the window.
    expect(text).not.toContain('Mean bin');
  });

  it('never prints a word a newcomer would have to ask about', () => {
    const h = mount();
    for (const readouts of [galton(5.981, 10_723), galton(6.4, 40), galton(9, 3), galton(Number.NaN, 0)]) {
      h.update(readouts);
      vi.advanceTimersByTime(250);
      expect(hero().textContent).not.toMatch(BANNED);
    }
  });

  it('prints the hint under the verdict rather than instead of it', () => {
    const h = mount();
    const withHint: Readout[] = [
      {
        key: 'below',
        label: 'Below the stake',
        value: 78.7,
        digits: 3,
        target: 78.5,
        tolerance: 0.01,
        headline: true,
        plain: 'players poorer than when they started',
        hint: 'the coin has to land heads 56% of the time just to break even',
      },
    ];
    h.update(withHint);
    expect(verdict()).toBe('matches the prediction of 78.5');
    expect(byClass(dom, 'hero__hint')[0]?.textContent).toBe(
      'the coin has to land heads 56% of the time just to break even',
    );

    // With no prediction the verdict line is already carrying the hint, so the
    // line below it stays empty and the sentence is not said twice.
    h.update([
      {
        key: 'below',
        label: 'Below the stake',
        value: 78.7,
        digits: 3,
        headline: true,
        plain: 'players poorer than when they started',
        hint: 'nothing settles here',
      },
    ]);
    vi.advanceTimersByTime(250);
    expect(verdict()).toBe('nothing settles here');
    expect(byClass(dom, 'hero__hint')[0]?.textContent).toBe('');
  });

  /**
   * The disclosure is gone and there is no control in this region at all. What
   * is NOT gone is the obligation it happened to be discharging: a canvas is
   * opaque to assistive technology, ARCHITECTURE.md makes the readout list the
   * accessible representation of what a tab produced, and the hero shows one of
   * a tab's five or six readings. Dropping the table would have taken "Balls
   * landed", "Bins" and every analytic target off the page for a reader who
   * cannot see the plate.
   */
  it('publishes every reading to assistive technology, with nothing to open', () => {
    mount().update(galton(5.981, 10_723));
    expect(byClass(dom, 'exact')).toEqual([]);
    expect(byClass(dom, 'exact__summary')).toEqual([]);
    expect(dom.findAll((el) => el.tagName === 'details')).toEqual([]);
    expect(dom.findAll((el) => el.tagName === 'summary')).toEqual([]);

    const table = byClass(dom, 'ledger')[0];
    expect(table?.textContent).toContain('Mean bin');
    expect(table?.textContent).toContain('Balls landed');
    expect(table?.textContent).toContain('Bins');
    expect(table?.textContent).toContain('10,723');
    // Clipped, not display:none and not aria-hidden — the construction that
    // keeps a table in the accessibility tree while taking it out of layout.
    const wrap = byClass(dom, 'readouts__ledger')[0];
    expect(wrap).toBeDefined();
    expect(wrap?.hidden).toBe(false);
    expect(wrap?.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('the headline', () => {
  it('is the marked readout, else the first with a prediction, else the first that is not an internal', () => {
    expect(headlineOf(galton(6, 1))?.key).toBe('mean');
    const byTarget: Readout[] = [
      { key: 'a', label: 'A', value: 1 },
      { key: 'b', label: 'B', value: 2, target: 2 },
    ];
    expect(headlineOf(byTarget)?.key).toBe('b');
    const plain: Readout[] = [
      { key: 'x', label: 'X', value: 1, expertOnly: true },
      { key: 'y', label: 'Y', value: 2 },
    ];
    expect(headlineOf(plain)?.key).toBe('y');
    expect(headlineOf([])).toBeUndefined();
  });
});

describe('the verdict', () => {
  it('agrees, is close, or is still settling — never a signed error', () => {
    const at = (value: number, tolerance = 0.01): Readout => ({
      key: 'k',
      label: 'K',
      value,
      target: 6,
      tolerance,
    });
    expect(verdictOf(at(5.981))).toEqual({ text: 'matches the prediction of 6', state: 'agree' });
    expect(verdictOf(at(6.5))).toEqual({ text: 'within 9% of 6', state: 'near' });
    expect(verdictOf(at(9))).toEqual({ text: 'still settling', state: 'far' });
    expect(verdictOf(at(Number.NaN))).toEqual({ text: 'not measured yet', state: 'none' });
    // The declared tolerance, not a second rule: 0.3% off is agreement at 1%
    // and "close" at a tenth of a percent.
    expect(verdictOf(at(5.981, 0.001))).toEqual({ text: 'within 0.4% of 6', state: 'near' });
  });

  it('quotes the prediction to the readout digits, and a percentage rounded up', () => {
    const pi: Readout = { key: 'pi', label: 'π estimate', value: 3.138, digits: 6, target: Math.PI, tolerance: 0.0001 };
    expect(verdictOf(pi)).toEqual({ text: 'within 0.2% of 3.14159', state: 'near' });
    expect(verdictOf({ ...pi, tolerance: 0.02 })).toEqual({ text: 'matches the prediction of 3.14159', state: 'agree' });
  });

  it('prints the prediction with its unit, so the sentence names the same quantity as the number', () => {
    const share: Readout = {
      key: 'below',
      label: 'Below the stake',
      value: 78.7,
      digits: 3,
      unit: '%',
      target: 78.5,
      tolerance: 0.01,
    };
    expect(verdictOf(share).text).toBe('matches the prediction of 78.5 %');
  });

  it('falls back to the hint where there is no prediction', () => {
    expect(verdictOf({ key: 'n', label: 'N', value: 12, hint: 'Each one wandered until it touched.' })).toEqual({
      text: 'Each one wandered until it touched.',
      state: 'none',
    });
    expect(verdictOf({ key: 'n', label: 'N', value: 12 })).toEqual({ text: '', state: 'none' });
  });

  it('is the same rule the table row uses', () => {
    const h = mount();
    for (const mean of [5.9, 5.95, 5.99, 6.05, 6.2, 7]) {
      h.update(galton(mean, 100));
      vi.advanceTimersByTime(250);
      const agree = hero().dataset['state'] === 'agree';
      expect(row('Mean bin').dataset['state'] === 'agree').toBe(agree);
    }
  });

  it('says the same thing in the table when there is no band and when the band is too wide', () => {
    // The two ways a row can fail to be a test are not the same sentence, and
    // neither of them may borrow "not there yet" — that one claims the run is
    // arriving somewhere.
    const h = mount();
    const bare: Readout = { key: 'k', label: 'K', value: 5, target: 6, headline: true };
    h.update([bare]);
    expect(verdict()).toBe('not enough data to judge');
    expect(hero().dataset['state']).toBe('none');
    expect(row('K').textContent).toContain('not enough data to judge');

    h.update([{ ...bare, key: 'k2', label: 'K2', tolerance: 2 }]);
    expect(verdict()).toBe('still settling');
    expect(hero().dataset['state']).toBe('far');
    expect(row('K2').textContent).toContain('not there yet');
  });

  it('is what the live region speaks', () => {
    expect(sentenceOf(galton(5.981, 1)[1] as Readout)).toBe(
      'average landing spot 5.981, matches the prediction of 6.',
    );
    expect(sentenceOf(galton(Number.NaN, 0)[1] as Readout)).toBe('average landing spot not measured yet.');
  });
});

// ---------------------------------------------------------------------------
// The band — what a verdict may claim, and on what evidence
// ---------------------------------------------------------------------------

/**
 * Six properties, and the app was breaking all six.
 *
 * A tolerance is not a taste. It is the width of the interval inside which the
 * reading and the prediction are not distinguishable *on the evidence gathered
 * so far*, and that fixes almost everything about it: it shrinks as the
 * evidence accumulates, it is never most of the answer, it never spills outside
 * the values the quantity is allowed to take, it never reaches across zero when
 * the sign is the whole result, a declared zero is a real claim of exactness,
 * and where a tab declares nothing the page invents nothing.
 *
 * The numbers below are the ones measured on the shipped app, so every case
 * here is a sentence a reader was shown and not a hypothetical.
 */
describe('the band', () => {
  /**
   * The standard deviation of one dart's contribution to the estimate. The
   * estimate is 4·(share inside), so one dart contributes 4·Bernoulli(π/4),
   * whose standard deviation is √(π(4 − π)) = 1.6427.
   */
  const DART_SIGMA = Math.sqrt(Math.PI * (4 - Math.PI));

  const pi = (samples: number, value = Math.PI): Readout => ({
    key: 'pi',
    label: 'π estimate',
    value,
    digits: 6,
    target: Math.PI,
    band: { kind: 'sampled', sigma: DART_SIGMA, samples },
  });

  it('shrinks as the run gathers evidence, as 1/√n', () => {
    // A hundred times the darts is a band ten times narrower. The visualization
    // declares the spread of one observation and the count so far; the division
    // is the ledger's, so there is no way to hand it the count the run will
    // *finish* on and hold a wide early band for the whole run.
    const wide = bandOf(pi(10_000));
    const narrow = bandOf(pi(1_000_000));
    expect(wide).not.toBeNull();
    expect(narrow).toBeCloseTo((wide as number) / 10, 12);

    let previous = Infinity;
    for (const samples of [1_000, 10_000, 100_000, 1_000_000]) {
      const half = bandOf(pi(samples));
      expect(half, `${samples} darts`).not.toBeNull();
      expect(half as number).toBeLessThan(previous);
      previous = half as number;
    }
  });

  it('refuses to certify through a band too wide to rule anything out', () => {
    // The Monte Carlo tab at the left stop of its fader: a hundred darts is a
    // 16 % band, and 3.36000 was printed under "matches the prediction of
    // 3.14159".
    const loose = pi(100, 3.36);
    expect(testable(loose)).toBe(false);
    expect(bandOf(loose)).toBeNull();
    expect(agrees(loose)).toBe(false);
    expect(verdictOf(loose)).toEqual({ text: 'still settling', state: 'far' });

    // The same reading once the run can test it: a million darts resolves π to
    // 0.16 %, and 3.36 then fails on the evidence rather than for want of it.
    expect(testable(pi(1_000_000, 3.36))).toBe(true);
    expect(agrees(pi(1_000_000, 3.36))).toBe(false);
    expect(agrees(pi(1_000_000, 3.1417))).toBe(true);
  });

  it('will not certify by luck what it has no power to test', () => {
    // Galton's Variance row declared 424 % at one ball and printed "agrees with
    // the prediction" beside a 100 % error. A band that wide accepts every
    // reading the board can produce — including the right one, which is why the
    // reading landing on the answer does not rescue it.
    const variance = (value: number, tolerance: number): Readout => ({
      key: 'variance',
      label: 'Variance',
      value,
      target: 3,
      tolerance,
    });
    expect(agrees(variance(0, 4.24))).toBe(false);
    expect(agrees(variance(3, 4.24))).toBe(false);
    expect(verdictOf(variance(3, 4.24)).state).not.toBe('agree');
    // Three standard errors of a variance over 500 balls is 19 %, which is
    // honest statistics and still not a test; over 200,000 it is 0.95 %, which
    // is.
    expect(agrees(variance(3.01, 3 * Math.sqrt(2 / 500)))).toBe(false);
    expect(agrees(variance(3.01, 3 * Math.sqrt(2 / 200_000)))).toBe(true);
  });

  it('is never more than a twentieth of the range the quantity can occupy', () => {
    // Kuramoto's order parameter lives in [0, 1] by construction, and at the
    // fewest fireflies its row accepted 0.74 of that — three quarters of
    // everything the number was ever allowed to be.
    const order = (value: number, half: number): Readout => ({
      key: 'order',
      label: 'Order parameter r',
      value,
      target: 0.707,
      range: [0, 1],
      band: { kind: 'absolute', half },
    });
    expect(bandOf(order(0.35, 0.74))).toBeNull();
    expect(verdictOf(order(0.35, 0.74))).toEqual({ text: 'still settling', state: 'far' });
    expect(bandOf(order(0.7, 0.03))).toBe(0.03);

    // The range binds where it is tighter than the prediction, which is the
    // case the prediction alone cannot catch: a critical temperature of 2.269
    // on a fader that runs from 2.0 to 2.5 has half a degree of room, not
    // 2.269, so a band of 0.05 covers a fifth of the interval in question.
    const critical = (range?: readonly [number, number]): Readout => ({
      key: 'tc',
      label: 'Critical temperature',
      value: 2.28,
      target: 2.269,
      band: { kind: 'absolute', half: 0.05 },
      ...(range === undefined ? {} : { range }),
    });
    expect(bandOf(critical())).toBe(0.05);
    expect(bandOf(critical([2, 2.5]))).toBeNull();
  });

  it('never reaches across zero, so a sign is never certified by its opposite', () => {
    // Parrondo's Game A: the claim is that the game *loses*, at −1.000 coins
    // per hundred rounds, and the shipped band was 52.7 % of that — an interval
    // reaching to −0.47, and one widening of the fader away from admitting a
    // game that wins. Every band the ledger will use is a twentieth of the
    // prediction at most, so target ± band cannot change sign.
    const gain = (value: number, tolerance: number): Readout => ({
      key: 'gainA',
      label: 'Game A, coins per 100 rounds',
      value,
      digits: 4,
      target: -1,
      tolerance,
    });
    expect(agrees(gain(-1.527, 0.527))).toBe(false);
    expect(verdictOf(gain(-1.527, 0.527)).text).not.toContain('matches');
    for (const tolerance of [0.01, 0.02, 0.04, 0.05, 0.5, 2]) {
      const half = bandOf(gain(-1, tolerance));
      if (half === null) continue;
      expect(Math.sign(-1 - half), `tolerance ${tolerance}`).toBe(-1);
      expect(Math.sign(-1 + half), `tolerance ${tolerance}`).toBe(-1);
    }
  });

  it('honours a declared zero as exact and never swaps a default in for it', () => {
    // 3·cv/√gaps is legitimately zero at cv = 0 — a timetable with no spread
    // has nothing to be uncertain about — and the old test read that as "not
    // declared" and handed the row a 1 % bar it never asked for.
    const gap = (value: number, tolerance: number): Readout => ({
      key: 'gapAverage',
      label: 'Average gap on the timetable',
      value,
      digits: 4,
      unit: 'min',
      target: 10,
      tolerance,
    });
    expect(agrees(gap(10, 0))).toBe(true);
    expect(agrees(gap(10.000000001, 0))).toBe(false);
    // The 1 % it used to be given would have called this one a match.
    expect(agrees(gap(10.05, 0))).toBe(false);
    expect(agrees(gap(10.05, 0.01))).toBe(true);
    // And the same statement in the form that cannot be confused with a number.
    const exact: Readout = { key: 'n', label: 'Balls landed', value: 500, target: 500, band: { kind: 'exact' } };
    expect(agrees(exact)).toBe(true);
    expect(agrees({ ...exact, value: 499 })).toBe(false);
  });

  it('invents nothing where a visualization declares nothing', () => {
    // Buffon's π estimate and its crossing fraction both ship a prediction and
    // no band, and both were being judged against a 1 % nobody chose. A reading
    // with nothing to judge it by is reported as a reading: no check mark, and
    // the prediction is not quoted, because quoting it is what turns the
    // sentence into a claim.
    const bare: Readout = { key: 'pi', label: 'π estimate', value: 3.1416, digits: 5, target: Math.PI };
    expect(bandOf(bare)).toBeNull();
    expect(agrees(bare)).toBe(false);
    expect(verdictOf(bare)).toEqual({ text: 'not enough data to judge', state: 'none' });
    expect(sentenceOf({ ...bare, plain: 'the estimate of π' })).toBe(
      'the estimate of π 3.1416, not enough data to judge.',
    );

    // Declaring both forms is a contradiction rather than a fallback: the
    // ledger does not get to pick which of two numbers a tab meant.
    expect(bandOf({ ...bare, tolerance: 0.01, band: { kind: 'relative', fraction: 0.5 } })).toBeNull();

    // A band that is not a number — a standard error over zero observations, a
    // fit with no residual degrees of freedom — is not a band either.
    expect(bandOf({ ...bare, band: { kind: 'sampled', sigma: DART_SIGMA, samples: 0 } })).toBeNull();
    expect(bandOf({ ...bare, tolerance: Number.NaN })).toBeNull();
    expect(bandOf({ ...bare, tolerance: -0.01 })).toBeNull();

    // A relative band on a prediction of zero states nothing — every band is
    // infinitely many times zero — so it has to be declared absolutely, and
    // against a range, since there is no other scale on the page to read it
    // against.
    const gap: Readout = { key: 'gap', label: 'Largest gap to the curve', value: 0.004, target: 0 };
    expect(bandOf({ ...gap, band: { kind: 'relative', fraction: 0.1 } })).toBeNull();
    expect(bandOf({ ...gap, band: { kind: 'absolute', half: 0.01 } })).toBeNull();
    expect(bandOf({ ...gap, range: [0, 1], band: { kind: 'absolute', half: 0.01 } })).toBe(0.01);
  });
});

describe('nothing moves when a digit changes', () => {
  const count = (value: number): Readout[] => [
    { key: 'n', label: 'Balls landed', value, digits: 6, headline: true, plain: 'balls landed' },
  ];

  it('reserves the number box from the digits before the first frame, and never shrinks it', () => {
    const h = mount();
    h.update(count(9));
    // Six figures, plus the eight a measurement can need for a sign, a point
    // and the leading zeros of a reading just above 10⁻⁶.
    expect(numberBox().style.getPropertyValue('min-width')).toBe('14ch');
    // Each frame lands after the throttle's trailing flush.
    for (const value of [10, 100, 1_000, 20_000, 999_999, 12_345_678]) {
      h.update(count(value));
      vi.advanceTimersByTime(250);
      expect(numberBox().style.getPropertyValue('min-width')).toBe('14ch');
    }
    // A reading past the budget widens the box once…
    h.update(count(123_456_789_012_345));
    vi.advanceTimersByTime(250);
    expect(numberBox().style.getPropertyValue('min-width')).toBe('19ch');
    // …and a smaller one after it does not take the width back.
    h.update(count(3));
    vi.advanceTimersByTime(250);
    expect(numberBox().style.getPropertyValue('min-width')).toBe('19ch');
  });

  it('holds the box through every form a measurement takes on its way up', () => {
    // The Lorenz separation: exponent form, then leading zeros, then a plain
    // decimal. The digits alone reserved seven glyphs and the box grew twice.
    const separation = (value: number): Readout[] => [
      { key: 's', label: 'Twin separation', value, digits: 3, headline: true, plain: 'how far apart the twins are now' },
    ];
    const h = mount();
    h.update(separation(1e-9));
    const reserved = numberBox().style.getPropertyValue('min-width');
    for (const value of [8.81e-8, 0.0000512, 0.000117, 0.0412, 3.64, 41.7]) {
      h.update(separation(value));
      vi.advanceTimersByTime(250);
      expect(numberBox().style.getPropertyValue('min-width')).toBe(reserved);
      expect(byClass(dom, 'hero__number')[0]?.textContent.length).toBeLessThanOrEqual(Number.parseInt(reserved, 10));
    }
  });

  it('keeps the unit beside its digits rather than at the end of a Lorenz-sized reservation', () => {
    // The reservation is what stops the unit shifting as digits change, so it
    // is made from the form a measurement in something actually takes: the
    // significant figures plus a sign and a point. The eight glyphs a bare
    // reading gets — for `1.00e-9` on its way to `3.64` — stranded `min` seven
    // glyphs past `10.05`, which reads as a broken layout and not a promise.
    const h = mount();
    const wait = (value: number): Readout[] => [
      { key: 'wait', label: 'Average wait', value, digits: 4, unit: 'min', target: 10, headline: true, plain: 'average wait' },
    ];
    h.update(wait(10.05));
    expect(numberBox().style.getPropertyValue('min-width')).toBe('6ch');
    expect(byClass(dom, 'hero__unit')[0]?.textContent).toBe('min');
    for (const value of [5.5, 10.05, 100.5]) {
      h.update(wait(value));
      vi.advanceTimersByTime(250);
      expect(numberBox().style.getPropertyValue('min-width')).toBe('6ch');
    }
  });

  it('keeps the check mark in the line whether or not it shows', () => {
    const h = mount();
    h.update(galton(9, 1));
    const mark = byClass(dom, 'hero__mark')[0];
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(hero().dataset['state']).toBe('far');
    h.update(galton(6, 1));
    vi.advanceTimersByTime(250);
    expect(byClass(dom, 'hero__mark')[0]).toBe(mark);
    expect(hero().dataset['state']).toBe('agree');
  });
});

describe('writes', () => {
  it('reuse rows by key and rebuild only when the structure changes', () => {
    const h = mount();
    h.update(galton(5.9, 1));
    const before = row('Mean bin');
    h.update(galton(5.95, 2));
    vi.advanceTimersByTime(250);
    expect(row('Mean bin')).toBe(before);
    expect(before.children[1]?.textContent).toBe('5.950');

    h.update([{ key: 'other', label: 'Other', value: 1 }]);
    expect(byClass(dom, 'readout')).toHaveLength(1);
    expect(byClass(dom, 'readout')[0]).not.toBe(before);
  });

  it('are throttled to ten a second with a trailing flush', () => {
    const h = mount();
    h.update(galton(5.9, 1));
    h.update(galton(5.95, 2));
    // Inside the window: the second frame waits.
    expect(row('Mean bin').children[1]?.textContent).toBe('5.900');
    vi.advanceTimersByTime(100);
    // …and lands, because the frame a run pauses on has to reach the page.
    expect(row('Mean bin').children[1]?.textContent).toBe('5.950');
  });
});

// ---------------------------------------------------------------------------
// The contract every tab's readouts are held to
// ---------------------------------------------------------------------------

/**
 * A recording 2D context, enough for any tab to paint one frame into. Every
 * method is a no-op and the two whose return value is read back — `measureText`
 * and `createImageData` — answer plausibly, so nothing here depends on a real
 * canvas being present.
 */
function stubContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    measureText: (text: string) => ({ width: 6 * String(text).length }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getContext: () => null,
  };
  return new Proxy(state, {
    get: (target, key) => (key in target ? target[key as string] : () => undefined),
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** Every tab's readouts, taken from one painted frame of its default configuration. */
function readoutsOf(viz: Viz): readonly Readout[] {
  const params: Record<string, ParamValue> = {};
  for (const spec of viz.params) params[spec.key] = spec.default;
  let emitted: readonly Readout[] = [];
  const ctx: VizContext = {
    layers: { background: stubContext(), foreground: stubContext() },
    width: 640,
    height: 400,
    rng: createRng(1),
    params,
    theme: DEFAULT_CANVAS_THEME,
    emit: (readouts) => {
      emitted = readouts;
    },
    reducedMotion: false,
  };
  const instance = viz.create(ctx);
  instance.drawBackground?.();
  instance.draw();
  instance.destroy();
  return emitted;
}

/** The span a readout says its quantity can occupy, or 0 where it says nothing. */
function rangeWidth(readout: Readout): number {
  const range = readout.range;
  return range === undefined ? 0 : range[1] - range[0];
}

describe('every tab in the registry', () => {
  it('marks exactly one headline reading', () => {
    for (const viz of registry) {
      const marked = readoutsOf(viz).filter((r) => r.headline === true);
      expect(marked.map((r) => r.key), viz.id).toHaveLength(1);
    }
  });

  it('declares a hint only on that headline, where the hero has a line to print it on', () => {
    // The simple view shows one reading. A hint on any other one is a sentence
    // written for a surface that does not exist — eleven of them shipped this
    // way across the new tabs, and the reader never saw one.
    for (const viz of registry) {
      const stranded = readoutsOf(viz)
        .filter((r) => r.hint !== undefined && r.headline !== true)
        .map((r) => r.key);
      expect(stranded, `${viz.id}: a hint belongs on the headline reading`).toEqual([]);
    }
  });

  it('never says in a hint what the verdict line above it already prints', () => {
    // "matches the prediction of 3.14159" with "the real value is 3.14159"
    // under it is the same sentence twice. A hint says why the reading
    // matters, not what it should have been.
    for (const viz of registry) {
      for (const r of readoutsOf(viz)) {
        if (r.hint === undefined || r.target === undefined) continue;
        const shown = verdictOf(r).text;
        const quoted = shown.replace(/^.*?of /, '');
        expect(r.hint, `${viz.id}/${r.key}`).not.toContain(quoted);
      }
    }
  });

  it('never puts a check mark beside a reading a twentieth away from its prediction', () => {
    // The ceiling is what the reader actually sees: the widest disagreement a
    // check mark can ever sit beside. It holds whatever a tab declares, so a
    // band nobody looked at can cost a verdict but can never buy a false one.
    for (const viz of registry) {
      for (const r of readoutsOf(viz)) {
        const target = r.target;
        if (target === undefined || verdictOf(r).state !== 'agree') continue;
        const scale = Math.abs(target) > 0 ? Math.abs(target) : rangeWidth(r);
        expect(Math.abs(r.value - target), `${viz.id}/${r.key}`).toBeLessThanOrEqual(
          MAX_BAND_FRACTION * scale,
        );
      }
    }
  });

  it('declares one band per reading, never two', () => {
    // `band` and `tolerance` say the same thing in two notations, and a tab
    // part-way through moving from one to the other would otherwise have the
    // ledger silently pick a winner. It refuses instead, and this is what stops
    // that refusal reaching a reader.
    for (const viz of registry) {
      for (const r of readoutsOf(viz)) {
        const both = r.band !== undefined && r.tolerance !== undefined;
        expect(both, `${viz.id}/${r.key}: declare band or tolerance, not both`).toBe(false);
      }
    }
  });

  it('declares a range that contains the value it predicts', () => {
    // A range is the span the quantity can occupy, so a prediction outside it
    // is one of the two wrong — and the band is measured against that span, so
    // the mistake would be quietly paid for in the verdict.
    for (const viz of registry) {
      for (const r of readoutsOf(viz)) {
        if (r.range === undefined) continue;
        const [lo, hi] = r.range;
        expect(hi, `${viz.id}/${r.key}: an empty range`).toBeGreaterThan(lo);
        if (r.target === undefined) continue;
        expect(r.target, `${viz.id}/${r.key}: the prediction is outside the range`).toBeGreaterThanOrEqual(lo);
        expect(r.target).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('never prints a word a sixteen-year-old would have to ask about', () => {
    for (const viz of registry) {
      for (const r of readoutsOf(viz)) {
        if (r.expertOnly === true) continue;
        for (const text of [r.plain, r.hint]) {
          if (text !== undefined) expect(text, `${viz.id}/${r.key}`).not.toMatch(BANNED);
        }
      }
    }
  });
});
