import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParamSpec } from '../src/core/types';
import {
  buildHash,
  coerceParams,
  createRouter,
  parseHash,
  serializeParams,
  type Route,
} from '../src/core/router';
import { registry } from '../src/viz/registry';

/** One of every control kind, shaped like the Galton board's panel. */
const specs: readonly ParamSpec[] = [
  { kind: 'int', key: 'rows', label: 'Rows', min: 3, max: 20, default: 12 },
  { kind: 'range', key: 'p', label: 'Bias', min: 0, max: 1, step: 0.01, default: 0.5 },
  { kind: 'range', key: 'rate', label: 'Drop rate', min: 1, max: 10_000, step: 1, default: 100, log: true },
  { kind: 'toggle', key: 'normal', label: 'Normal overlay', default: true },
  {
    kind: 'choice',
    key: 'mode',
    label: 'Mode',
    options: [
      { value: 'balls', label: 'Balls' },
      { value: 'bars', label: 'Bars' },
    ],
    default: 'balls',
  },
  { kind: 'seed', key: 'seed', label: 'Seed', default: 1 },
];

describe('parseHash', () => {
  it('parses a full permalink', () => {
    expect(parseHash('#/galton?rows=12&p=0.5&seed=42')).toEqual({
      id: 'galton',
      params: { rows: '12', p: '0.5', seed: '42' },
    });
  });

  it('tolerates a missing "#", a missing "/", or both', () => {
    const expected = { id: 'galton', params: { rows: '12' } };
    expect(parseHash('/galton?rows=12')).toEqual(expected);
    expect(parseHash('#galton?rows=12')).toEqual(expected);
    expect(parseHash('galton?rows=12')).toEqual(expected);
    expect(parseHash('#/galton/?rows=12')).toEqual(expected);
  });

  it('parses a route with no query', () => {
    expect(parseHash('#/galton')).toEqual({ id: 'galton', params: {} });
    expect(parseHash('#/galton?')).toEqual({ id: 'galton', params: {} });
  });

  it('decodes URL-encoded values', () => {
    expect(parseHash('#/fourier?wave=hand%20drawn&label=a%26b%3Dc').params).toEqual({
      wave: 'hand drawn',
      label: 'a&b=c',
    });
  });

  it('keeps "+" literal so exponent notation survives', () => {
    expect(parseHash('#/x?n=1e%2B5').params).toEqual({ n: '1e+5' });
    expect(parseHash('#/x?n=1e+5').params).toEqual({ n: '1e+5' });
  });

  it('resolves empty or unrecognizable fragments to no route', () => {
    const none = { id: null, params: {} };
    expect(parseHash('')).toEqual(none);
    expect(parseHash('#')).toEqual(none);
    expect(parseHash('#/')).toEqual(none);
    expect(parseHash('#/?rows=12')).toEqual(none);
    expect(parseHash('#/gal ton')).toEqual(none);
    expect(parseHash('#/a/b')).toEqual(none);
  });

  it('survives a malformed percent escape instead of throwing', () => {
    expect(parseHash('#/galton?x=%E0%A4%A').params).toEqual({ x: '%E0%A4%A' });
  });

  it('treats a bare key as an empty value, skips empty pairs, and lets the last duplicate win', () => {
    expect(parseHash('#/galton?a&&b=&c=1&c=2').params).toEqual({ a: '', b: '', c: '2' });
  });
});

describe('buildHash', () => {
  it('builds the documented permalink shape', () => {
    expect(buildHash('galton', { rows: 12, p: 0.5, seed: 42 })).toBe('#/galton?rows=12&p=0.5&seed=42');
  });

  it('omits the query when there are no params', () => {
    expect(buildHash('galton', {})).toBe('#/galton');
  });

  it('preserves insertion order', () => {
    expect(buildHash('x', { b: 1, a: 2 })).toBe('#/x?b=1&a=2');
    expect(buildHash('x', { a: 2, b: 1 })).toBe('#/x?a=2&b=1');
  });

  it('percent-encodes values and stringifies booleans', () => {
    expect(buildHash('fourier', { wave: 'hand drawn', label: 'a&b=c', overlay: false })).toBe(
      '#/fourier?wave=hand%20drawn&label=a%26b%3Dc&overlay=false',
    );
  });

  it('round-trips through parseHash', () => {
    const params = { rows: 12, p: 0.35, normal: false, mode: 'bars', seed: 42 };
    expect(parseHash(buildHash('galton', params))).toEqual({
      id: 'galton',
      params: { rows: '12', p: '0.35', normal: 'false', mode: 'bars', seed: '42' },
    });
  });
});

describe('coerceParams', () => {
  it('returns every spec default when nothing is supplied', () => {
    expect(coerceParams(specs, {})).toEqual({
      rows: 12,
      p: 0.5,
      rate: 100,
      normal: true,
      mode: 'balls',
      seed: 1,
    });
  });

  it('parses well-formed values of every kind', () => {
    expect(coerceParams(specs, { rows: '8', p: '0.7', rate: '2500', normal: 'false', mode: 'bars', seed: '42' })).toEqual({
      rows: 8,
      p: 0.7,
      rate: 2500,
      normal: false,
      mode: 'bars',
      seed: 42,
    });
  });

  it('clamps range and int values to [min, max]', () => {
    const v = coerceParams(specs, { rows: '99', p: '-3', rate: '1e9' });
    expect(v['rows']).toBe(20);
    expect(v['p']).toBe(0);
    expect(v['rate']).toBe(10_000);
  });

  it('rounds int values, then clamps', () => {
    expect(coerceParams(specs, { rows: '7.6' })['rows']).toBe(8);
    expect(coerceParams(specs, { rows: '2.4' })['rows']).toBe(3);
  });

  it('snaps range values onto the step grid, the same grid serializeParams writes', () => {
    expect(coerceParams(specs, { p: '0.333' })['p']).toBe(0.33);
    expect(coerceParams(specs, { p: '0.3333' })['p']).toBe(0.33);
    expect(coerceParams(specs, { p: '0.336' })['p']).toBe(0.34);
    expect(coerceParams(specs, { rate: '1234.7' })['rate']).toBe(1235);
  });

  it('snaps before clamping, so a value just outside the range lands on the bound', () => {
    // 0.4 on a step-1 grid is 0, below `rate`'s minimum of 1.
    expect(coerceParams(specs, { rate: '0.4' })['rate']).toBe(1);
    expect(coerceParams(specs, { p: '1.004' })['p']).toBe(1);
    expect(coerceParams(specs, { p: '-0.4' })['p']).toBe(0);
  });

  it('accepts true/1 and false/0 for toggles, case-insensitively', () => {
    for (const t of ['true', '1', 'TRUE']) expect(coerceParams(specs, { normal: t })['normal']).toBe(true);
    for (const f of ['false', '0', 'False']) expect(coerceParams(specs, { normal: f })['normal']).toBe(false);
    expect(coerceParams(specs, { normal: 'yes' })['normal']).toBe(true);
  });

  it('falls back to the default for a choice outside the options', () => {
    expect(coerceParams(specs, { mode: 'pegs' })['mode']).toBe('balls');
  });

  it('reduces seeds with >>> 0, exactly as the RNG does', () => {
    expect(coerceParams(specs, { seed: '42' })['seed']).toBe(42);
    expect(coerceParams(specs, { seed: '3.9' })['seed']).toBe(3);
    expect(coerceParams(specs, { seed: '-1' })['seed']).toBe(0xffffffff);
    expect(coerceParams(specs, { seed: '4294967296' })['seed']).toBe(0);
    expect(coerceParams(specs, { seed: '4294967295' })['seed']).toBe(0xffffffff);
  });

  it('falls back to the default for empty, blank, or unparsable values', () => {
    const v = coerceParams(specs, { rows: '', p: '  ', rate: 'fast', normal: '', mode: '', seed: 'abc' });
    expect(v).toEqual({ rows: 12, p: 0.5, rate: 100, normal: true, mode: 'balls', seed: 1 });
    expect(coerceParams(specs, { p: 'Infinity' })['p']).toBe(0.5);
    expect(coerceParams(specs, { p: 'NaN' })['p']).toBe(0.5);
  });

  it('ignores keys with no spec', () => {
    const v = coerceParams(specs, { rows: '5', bogus: '1', __proto__: 'x' } as Record<string, string>);
    expect(Object.keys(v).sort()).toEqual(['mode', 'normal', 'p', 'rate', 'rows', 'seed']);
  });
});

describe('serializeParams', () => {
  it('emits nothing when every value is at its default', () => {
    expect(serializeParams(specs, coerceParams(specs, {}))).toEqual({});
  });

  it('emits only the values that differ from the default', () => {
    expect(serializeParams(specs, { rows: 12, p: 0.7, rate: 100, normal: false, mode: 'balls', seed: 42 })).toEqual({
      p: '0.7',
      normal: 'false',
      seed: '42',
    });
  });

  it('rounds range values to the step precision, hiding binary float drift', () => {
    expect(serializeParams(specs, { p: 0.1 + 0.2 })['p']).toBe('0.3');
    expect(serializeParams(specs, { p: 3 * 0.1 })['p']).toBe('0.3');
    expect(serializeParams(specs, { p: 1.1 * 0.1 })['p']).toBe('0.11');
    expect(serializeParams(specs, { rate: 2500.4 })['rate']).toBe('2500');
  });

  it('handles steps written in exponent notation', () => {
    const fine: readonly ParamSpec[] = [{ kind: 'range', key: 'dt', label: 'dt', min: 0, max: 1, step: 1e-7, default: 0 }];
    // 3 * 1e-7 is 3.0000000000000004e-7 in binary; seven places is the step's precision.
    const out = serializeParams(fine, { dt: 3 * 1e-7 })['dt'];
    expect(out).toBe('3e-7');
    expect(Number(out)).toBe(3e-7);
  });

  it('omits a value that only differs from the default below the step precision', () => {
    expect(serializeParams(specs, { p: 0.5 + 1e-12 })).toEqual({});
    expect(serializeParams(specs, { p: 0.5 - 1e-12 })).toEqual({});
  });

  it('treats a value of the wrong type, or a choice outside the options, as the default', () => {
    expect(serializeParams(specs, { rows: 'ten', p: true, normal: 'false', mode: 'pegs', seed: 'x' })).toEqual({});
  });

  it('writes seeds through >>> 0 so they match what coerceParams will read', () => {
    expect(serializeParams(specs, { seed: -1 })).toEqual({ seed: '4294967295' });
    expect(serializeParams(specs, { seed: 4294967297 })).toEqual({});
  });

  it('round-trips through the URL and back to identical typed values', () => {
    const values = coerceParams(specs, { rows: '15', p: '0.35', rate: '2500', normal: 'false', mode: 'bars', seed: '42' });
    const hash = buildHash('galton', serializeParams(specs, values));
    expect(hash).toBe('#/galton?rows=15&p=0.35&rate=2500&normal=false&mode=bars&seed=42');
    const back = parseHash(hash);
    expect(back.id).toBe('galton');
    expect(coerceParams(specs, back.params)).toEqual(values);
  });

  it('advertises the run that is actually in force, for an off-step hand-typed link', () => {
    // The permalink the page rewrites itself to must open the same experiment:
    // p=0.3333 running while the bar, the caption and the copied link say 0.33
    // is a different distribution from the one the sender is looking at.
    const values = coerceParams(specs, { p: '0.3333', rate: '1234.7', rows: '12.6', seed: '-1' });
    const advertised = serializeParams(specs, values);
    expect(advertised).toEqual({ rows: '13', p: '0.33', rate: '1235', seed: '4294967295' });
    expect(coerceParams(specs, advertised)).toEqual(values);
  });

  it('is idempotent over the whole range: coerce -> serialize -> coerce is a fixed point', () => {
    const base = coerceParams(specs, {});
    for (let i = 0; i <= 199; i++) {
      // i/199 misses the 0.01 grid almost everywhere.
      const values = { ...base, p: coerceParams(specs, { p: String(i / 199) })['p'] as number };
      expect(coerceParams(specs, serializeParams(specs, values))).toEqual(values);
    }
  });

  it('round-trips a drifted float without growing the URL', () => {
    const values = coerceParams(specs, {});
    const drifted = { ...values, p: 0.7 + 0.1 }; // 0.7999999999999999
    const hash = buildHash('galton', serializeParams(specs, drifted));
    expect(hash).toBe('#/galton?p=0.8');
    expect(coerceParams(specs, parseHash(hash).params)['p']).toBe(0.8);
  });
});

/**
 * The step grid — this file's one regression, fixed once and back within two
 * commits.
 *
 * The first fix rounded a URL value to the step's number of DECIMAL PLACES,
 * which is a snap only while every step is a power of ten and every minimum is
 * a multiple of it. Both were true of the four parameters that existed when it
 * was written, and the tests above were written against those four, so nothing
 * failed when tabs arrived with steps of 5, 100 and 0.05 and with minima of
 * 0.4 and 500. `temp=2.27` then ran while the fader, the address bar and the
 * copied link all said 2.25.
 *
 * So the specs below are chosen for the two properties that tell one quantiser
 * from the other, and the sweep after them is read off the registry rather than
 * written out — a parameter added tomorrow is covered the day it is added,
 * which is the only version of this test that could have held.
 */
describe('the step grid', () => {
  const offGrid: readonly ParamSpec[] = [
    // The Ising sheet: a step that is not a power of ten, on a minimum that is
    // not a multiple of it.
    { kind: 'range', key: 'temp', label: 'Temperature', min: 0.4, max: 4, step: 0.05, default: 2 },
    // The bus timetable's spread, in fives.
    { kind: 'range', key: 'spread', label: 'Spread', min: 0, max: 100, step: 5, default: 40 },
    // Passengers, in hundreds, from a minimum of 500.
    { kind: 'range', key: 'crowd', label: 'Passengers', min: 500, max: 20_000, step: 100, default: 2000 },
  ];

  it('snaps a hand-typed value onto the grid, not to the step’s decimal places', () => {
    // Rounding to two places leaves 2.27 exactly where it was, and 2.27 is not
    // a temperature this fader can hold.
    expect(coerceParams(offGrid, { temp: '2.27' })['temp']).toBe(2.25);
    expect(coerceParams(offGrid, { temp: '2.28' })['temp']).toBe(2.3);
    expect(coerceParams(offGrid, { spread: '12' })['spread']).toBe(10);
    expect(coerceParams(offGrid, { spread: '13' })['spread']).toBe(15);
    expect(coerceParams(offGrid, { crowd: '1234' })['crowd']).toBe(1200);
    expect(coerceParams(offGrid, { crowd: '1250' })['crowd']).toBe(1300);
  });

  it('honours a minimum that is not a multiple of the step', () => {
    // The grid is min + k·step, so 0.4, 0.45, 0.5 … — never 0.35 or 2.00.
    for (const raw of ['0.41', '1.99', '2.01', '3.87']) {
      const value = coerceParams(offGrid, { temp: raw })['temp'] as number;
      expect(Number.isInteger(Math.round((value - 0.4) / 0.05))).toBe(true);
      expect(Math.abs((value - 0.4) / 0.05 - Math.round((value - 0.4) / 0.05))).toBeLessThan(1e-6);
    }
  });

  it('advertises the value it is running, for every off-grid parameter', () => {
    const values = coerceParams(offGrid, { temp: '2.27', spread: '12', crowd: '1234' });
    const advertised = serializeParams(offGrid, values);
    expect(advertised).toEqual({ temp: '2.25', spread: '10', crowd: '1200' });
    expect(coerceParams(offGrid, advertised)).toEqual(values);
  });

  /** Off-grid numbers a reader could type, or a stale link could carry. */
  function probes(spec: { min: number; max: number; step: number; default: number }): number[] {
    const { min, max, step } = spec;
    const mid = min + Math.floor((max - min) / step / 2) * step;
    return [
      min + step * 0.49,
      min + step * 0.51,
      mid - step / 3,
      mid + step / 3,
      mid + step * 0.7,
      max - step / 3,
      min - step,
      max + step,
      spec.default + step / 2,
    ];
  }

  it('lands every range parameter in the registry on its own grid, and inside its own ends', () => {
    for (const viz of registry) {
      for (const spec of viz.params) {
        if (spec.kind !== 'range') continue;
        for (const probe of probes(spec)) {
          const where = `${viz.id}.${spec.key} from ${probe}`;
          const value = coerceParams([spec], { [spec.key]: String(probe) })[spec.key] as number;
          expect(Number.isFinite(value), where).toBe(true);
          expect(value, where).toBeGreaterThanOrEqual(spec.min);
          expect(value, where).toBeLessThanOrEqual(spec.max);
          const k = Math.round((value - spec.min) / spec.step);
          // A thousandth of a step: the defect put values half a step out, and
          // binary noise never reaches this far.
          expect(Math.abs(value - (spec.min + k * spec.step)), where).toBeLessThanOrEqual(
            spec.step * 1e-3,
          );
        }
      }
    }
  });

  it('reproduces, for every range parameter in the registry, the run its own permalink names', () => {
    for (const viz of registry) {
      for (const spec of viz.params) {
        if (spec.kind !== 'range') continue;
        for (const probe of probes(spec)) {
          const where = `${viz.id}.${spec.key} from ${probe}`;
          const running = coerceParams(viz.params, { [spec.key]: String(probe) });
          // What the page rewrites the address bar to, read back as the run it
          // opens: the permalink and the experiment have to be the same thing.
          const reopened = coerceParams(viz.params, serializeParams(viz.params, running));
          expect(reopened, where).toEqual(running);
        }
      }
    }
  });
});

/**
 * With no window, createRouter() runs on an in-memory fragment. These tests
 * cover the routing logic itself — notification, debouncing, teardown — without
 * a DOM; the browser binding is three one-line adapters over location/history.
 */
describe('createRouter (headless)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no route', () => {
    const router = createRouter();
    expect(router.route).toEqual({ id: null, params: {} });
    router.destroy();
  });

  it('navigate() updates the route synchronously and notifies subscribers exactly once', () => {
    const router = createRouter();
    const seen: Route[] = [];
    router.subscribe((r) => seen.push(r));

    router.navigate('galton', { rows: 12, seed: 42 });

    expect(router.route).toEqual({ id: 'galton', params: { rows: '12', seed: '42' } });
    expect(seen).toEqual([{ id: 'galton', params: { rows: '12', seed: '42' } }]);
    router.destroy();
  });

  it('navigating to the current location does not notify', () => {
    const router = createRouter();
    router.navigate('galton');
    const seen: Route[] = [];
    router.subscribe((r) => seen.push(r));

    router.navigate('galton');

    expect(seen).toEqual([]);
    router.destroy();
  });

  it('unsubscribe stops notifications', () => {
    const router = createRouter();
    const seen: Route[] = [];
    const off = router.subscribe((r) => seen.push(r));
    router.navigate('galton');
    off();
    router.navigate('buffon');
    expect(seen).toHaveLength(1);
    router.destroy();
  });

  it('replaceParams() updates the route without notifying subscribers', () => {
    const router = createRouter();
    const seen: Route[] = [];
    router.subscribe((r) => seen.push(r));
    router.navigate('galton', { rows: 12 });

    router.replaceParams({ rows: 12, p: 0.7 });

    expect(seen).toHaveLength(1);
    expect(router.route).toEqual({ id: 'galton', params: { rows: '12', p: '0.7' } });
    vi.runAllTimers();
    expect(seen).toHaveLength(1);
    router.destroy();
  });

  it('coalesces replaceParams() writes to one per 150 ms', () => {
    const router = createRouter();
    router.navigate('galton');

    for (let i = 0; i <= 9; i++) router.replaceParams({ p: i / 10 });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(149);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);

    expect(router.route.params).toEqual({ p: '0.9' });
    router.destroy();
  });

  it('ignores replaceParams() before any visualization is selected', () => {
    const router = createRouter();
    router.replaceParams({ p: 0.7 });
    expect(router.route).toEqual({ id: null, params: {} });
    expect(vi.getTimerCount()).toBe(0);
    router.destroy();
  });

  it('navigate() leaves no pending rewrite behind to clobber the new route', () => {
    const router = createRouter();
    router.navigate('galton');
    router.replaceParams({ p: 0.7 });
    router.navigate('buffon');
    vi.runAllTimers();
    expect(router.route).toEqual({ id: 'buffon', params: {} });
    router.destroy();
  });

  it('destroy() flushes the pending write and silences subscribers', () => {
    const router = createRouter();
    const seen: Route[] = [];
    router.subscribe((r) => seen.push(r));
    router.navigate('galton');
    router.replaceParams({ p: 0.7 });

    router.destroy();

    expect(vi.getTimerCount()).toBe(0);
    router.navigate('buffon');
    expect(seen).toHaveLength(1);
  });
});

/**
 * A fake `window` with the browser's real event timing: `location.hash` is
 * written synchronously, `hashchange` is delivered as a queued task afterwards.
 * That gap is what the tests below are about, and the in-memory source cannot
 * model it — its push notifies inline, so the race can never open.
 */
interface WindowOptions {
  /**
   * How many `replaceState` calls the bar takes before it starts throwing.
   * 0 is an opaque origin — a `sandbox="allow-scripts"` iframe, which is what
   * Notion and most LMSs embed with — where every call throws. A small number
   * stands in for WebKit's ceiling of 100 calls in 30 s, which a 15 s slider
   * drag at a 150 ms debounce reaches on its own.
   */
  replaceFailsAfter?: number;
  /** An embedder that refuses fragment navigation too. */
  hashWritesFail?: boolean;
}

function fakeWindow(options: WindowOptions = {}) {
  let hash = '';
  const listeners = new Set<() => void>();
  const queued: Array<() => void> = [];
  /** Every fragment written through `history.replaceState`, in order. */
  const replaced: string[] = [];
  const replaceLimit = options.replaceFailsAfter ?? Number.POSITIVE_INFINITY;
  let replaceCalls = 0;
  const securityError = (): Error =>
    Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
  return {
    location: {
      get hash(): string {
        return hash;
      },
      set hash(next: string) {
        if (options.hashWritesFail === true) throw securityError();
        if (next === hash) return;
        hash = next;
        for (const l of listeners) queued.push(l);
      },
    },
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, url: string): void {
        if (replaceCalls++ >= replaceLimit) throw securityError();
        hash = url;
        replaced.push(url);
      },
    },
    addEventListener(type: string, cb: () => void): void {
      if (type === 'hashchange') listeners.add(cb);
    },
    removeEventListener(type: string, cb: () => void): void {
      if (type === 'hashchange') listeners.delete(cb);
    },
    /** Run the queued hashchange tasks, as the event loop eventually would. */
    deliver(): void {
      for (const l of queued.splice(0)) l();
    },
    replaced,
  };
}

/**
 * The browser binding, where a hash navigation and a debounced rewrite can
 * overlap. Everything here turns on `hashchange` arriving after the fragment
 * has already changed.
 */
describe('createRouter (browser source)', () => {
  let w: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.useFakeTimers();
    w = fakeWindow();
    vi.stubGlobal('window', w);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('writes the first change of a gesture at once and coalesces the repeats', () => {
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    // Leading edge. The debounce exists so that one slider drag does not emit
    // sixty `replaceState` calls, not so that the first of them is withheld:
    // deferring it too meant a control moved less than 150 ms before a hash
    // navigation never reached the bar at all, and the entry the reader left
    // kept parameters the Share key had already stopped advertising.
    router.replaceParams({ p: 0.7 });
    expect(w.replaced).toEqual(['#/galton?p=0.7']);
    expect(w.location.hash).toBe('#/galton?p=0.7');

    router.replaceParams({ p: 0.8 });
    router.replaceParams({ p: 0.9 });
    expect(w.replaced).toEqual(['#/galton?p=0.7']);

    vi.advanceTimersByTime(150);
    expect(w.replaced).toEqual(['#/galton?p=0.7', '#/galton?p=0.9']);
    expect(w.location.hash).toBe('#/galton?p=0.9');
    router.destroy();
  });

  it('abandons the debounced rewrite when a hash navigation lands inside the window', () => {
    const router = createRouter();
    const routes: Route[] = [];
    router.subscribe((r) => routes.push(r));
    router.navigate('buffon');
    w.deliver();

    router.replaceParams({ ratio: 0.55 }); // leading edge: reaches the bar now
    router.replaceParams({ ratio: 0.6 }); // arms the 150 ms debounce
    w.replaced.length = 0;
    // The masthead wordmark, a pasted link, Back: the bar changes now, the
    // hashchange task runs later.
    w.location.hash = '#/galton';
    vi.advanceTimersByTime(150);

    // The stale rewrite must not put the old fragment back — nor mark it seen,
    // which would make the pending hashchange a no-op and strand the app.
    expect(w.replaced).toEqual([]);
    expect(w.location.hash).toBe('#/galton');

    w.deliver();
    expect(router.route).toEqual({ id: 'galton', params: {} });
    expect(routes.at(-1)).toEqual({ id: 'galton', params: {} });
    router.destroy();
  });

  it('navigate() lands the pending write on the entry it leaves, so Back keeps the edit', () => {
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    router.replaceParams({ p: 0.77 });
    vi.advanceTimersByTime(40); // still inside the debounce
    router.navigate('buffon');

    expect(w.replaced).toEqual(['#/galton?p=0.77']);
    expect(w.location.hash).toBe('#/buffon');
    expect(router.route).toEqual({ id: 'buffon', params: {} });

    vi.runAllTimers();
    expect(w.location.hash).toBe('#/buffon');
    router.destroy();
  });

  it('navigate() still abandons a pending write whose fragment already moved', () => {
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    router.replaceParams({ p: 0.77 }); // leading edge: reaches the bar now
    router.replaceParams({ p: 0.78 }); // arms the debounce
    w.replaced.length = 0;
    w.location.hash = '#/buffon'; // hashchange queued, not yet delivered
    router.navigate('mandelbrot');

    expect(w.replaced).toEqual([]);
    expect(w.location.hash).toBe('#/mandelbrot');
    expect(router.route).toEqual({ id: 'mandelbrot', params: {} });
    router.destroy();
  });
});

/**
 * An address bar that refuses to be written.
 *
 * `history.replaceState` throws a SecurityError at an opaque origin and again
 * at WebKit's rate limit, and both are ordinary places to open this app: an
 * embed in a course page, and a fifteen-second slider drag. Unguarded, the
 * throw escaped a `setTimeout` as an uncaught error once per debounce tick and
 * — because `navigate()` flushes the pending write before it pushes — it also
 * swallowed the tab click that came after it, so the strip went dead.
 *
 * The rule these pin down: a refused write is a fact, not an exception, and it
 * costs the address bar and nothing else. The route still moves, because the
 * route is the app's state and the URL is a mirror of it.
 */
describe('createRouter (an address bar that refuses)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function install(options: WindowOptions): ReturnType<typeof fakeWindow> {
    const w = fakeWindow(options);
    vi.stubGlobal('window', w);
    return w;
  }

  it('keeps routing when every rewrite throws', () => {
    const w = install({ replaceFailsAfter: 0 });
    const router = createRouter();
    const routes: Route[] = [];
    router.subscribe((r) => routes.push(r));

    expect(() => {
      router.navigate('galton');
      w.deliver();
      router.replaceParams({ p: 0.7 }); // leading edge, refused
      router.replaceParams({ p: 0.8 }); // debounced, refused when it fires
      vi.runAllTimers();
      router.navigate('buffon');
      w.deliver();
    }).not.toThrow();

    expect(router.route).toEqual({ id: 'buffon', params: {} });
    expect(routes.map((r) => r.id)).toEqual(['galton', 'buffon']);
    router.destroy();
  });

  it('answers the tab click that follows a refused write', () => {
    // WebKit's ceiling, reached mid-drag: the first write lands, the rest throw.
    const w = install({ replaceFailsAfter: 1 });
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    router.replaceParams({ p: 0.7 }); // leading edge: this one lands
    vi.advanceTimersByTime(200);
    router.replaceParams({ p: 0.8 }); // this one throws

    const routes: Route[] = [];
    router.subscribe((r) => routes.push(r));
    router.navigate('buffon'); // flush() first — it must not take the click with it

    expect(router.route).toEqual({ id: 'buffon', params: {} });
    expect(routes).toEqual([{ id: 'buffon', params: {} }]);
    expect(w.location.hash).toBe('#/buffon');
    router.destroy();
  });

  it('never believes a fragment the bar did not take', () => {
    const w = install({ replaceFailsAfter: 0 });
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    router.replaceParams({ p: 0.7 });
    vi.runAllTimers();

    // A URL copied out of the bar has to open what the bar says. The router
    // re-anchors on what is really there rather than spending the session
    // composing against a fragment it never managed to write.
    expect(w.location.hash).toBe('#/galton');
    expect(router.route).toEqual(parseHash(w.location.hash));
    router.destroy();
  });

  it('survives a whole drag against the rate limit', () => {
    const w = install({ replaceFailsAfter: 3 });
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    expect(() => {
      for (let i = 0; i <= 60; i++) {
        router.replaceParams({ p: i / 100 });
        vi.advanceTimersByTime(20);
      }
      vi.runAllTimers();
    }).not.toThrow();

    expect(w.replaced).toHaveLength(3);
    expect(router.route.id).toBe('galton');
    router.destroy();
  });

  it('selects a tab even when the fragment itself cannot be written', () => {
    const w = install({ hashWritesFail: true });
    const router = createRouter();
    const routes: Route[] = [];
    router.subscribe((r) => routes.push(r));

    expect(() => router.navigate('galton', { seed: 42 })).not.toThrow();

    // Navigation is app state, not a URL cosmetic: the tab opens, and only the
    // permalink is lost.
    expect(router.route).toEqual({ id: 'galton', params: { seed: '42' } });
    expect(routes).toEqual([{ id: 'galton', params: { seed: '42' } }]);
    expect(w.location.hash).toBe('');
    router.destroy();
  });
});
