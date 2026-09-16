import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byClass, fire, installDom, type Harness, type MElement } from './dom-harness';
import { DEFAULT_CANVAS_THEME } from '../src/core/canvas';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, Viz, VizContext } from '../src/core/types';
import { registry } from '../src/viz/registry';
import {
  createReadouts,
  headlineOf,
  sentenceOf,
  verdictOf,
  type ReadoutsHandle,
} from '../src/ui/readouts';

/**
 * The readouts, as a visitor with no statistics meets them: one number, one
 * plain label, one sentence — and, behind a disclosure, the exact table the
 * convergence tests read.
 *
 * Two things here are contracts with the rest of the page. The verdict under
 * the number and the state of the table row come from one rule, so the simple
 * view can never disagree with the exact one. And nothing lays out when a
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

/** The Galton board's readouts, with the plain-language fields the simple view reads. */
function galton(mean: number, landed: number): Readout[] {
  return [
    { key: 'landed', label: 'Balls landed', value: landed, digits: 6, plain: 'balls landed' },
    {
      key: 'mean',
      label: 'Mean bin',
      value: mean,
      target: 6,
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

  it('keeps the precise table, every row of it, behind the disclosure', () => {
    mount().update(galton(5.981, 10_723));
    const table = byClass(dom, 'ledger')[0];
    expect(table?.textContent).toContain('Mean bin');
    expect(table?.textContent).toContain('Balls landed');
    expect(table?.textContent).toContain('Bins');
    expect(table?.textContent).toContain('10,723');
    expect(byClass(dom, 'exact__summary')[0]?.textContent).toBe('Show the exact numbers');
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
    const at = (value: number, tolerance?: number): Readout => ({
      key: 'k',
      label: 'K',
      value,
      target: 6,
      ...(tolerance === undefined ? {} : { tolerance }),
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
    const share: Readout = { key: 'below', label: 'Below the stake', value: 78.7, digits: 3, unit: '%', target: 78.5 };
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

  it('is what the live region speaks', () => {
    expect(sentenceOf(galton(5.981, 1)[1] as Readout)).toBe(
      'average landing spot 5.981, matches the prediction of 6.',
    );
    expect(sentenceOf(galton(Number.NaN, 0)[1] as Readout)).toBe('average landing spot not measured yet.');
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

describe('the disclosure', () => {
  const details = (): MElement & { open?: boolean } => {
    const el = byClass(dom, 'exact')[0];
    if (!el) throw new Error('no disclosure');
    return el;
  };

  it('is collapsed by default and remembers being opened', () => {
    mount().update(galton(6, 1));
    expect(details().open).toBe(false);

    details().open = true;
    fire(details(), 'toggle');

    handle?.destroy();
    mount().update(galton(6, 1));
    expect(details().open).toBe(true);
  });

  it('survives a storage that throws', () => {
    dom.breakStorage();
    mount().update(galton(6, 1));
    details().open = true;
    expect(() => fire(details(), 'toggle')).not.toThrow();
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
