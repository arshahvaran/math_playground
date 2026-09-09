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

  it('snaps range values to the step precision, the same rounding serializeParams applies', () => {
    expect(coerceParams(specs, { p: '0.333' })['p']).toBe(0.33);
    expect(coerceParams(specs, { p: '0.3333' })['p']).toBe(0.33);
    expect(coerceParams(specs, { p: '0.336' })['p']).toBe(0.34);
    expect(coerceParams(specs, { rate: '1234.7' })['rate']).toBe(1235);
  });

  it('snaps before clamping, so a value just outside the range lands on the bound', () => {
    // roundToStep(0.4, step 1) is 0, below `rate`'s minimum of 1.
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
function fakeWindow() {
  let hash = '';
  const listeners = new Set<() => void>();
  const queued: Array<() => void> = [];
  /** Every fragment written through `history.replaceState`, in order. */
  const replaced: string[] = [];
  return {
    location: {
      get hash(): string {
        return hash;
      },
      set hash(next: string) {
        if (next === hash) return;
        hash = next;
        for (const l of listeners) queued.push(l);
      },
    },
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, url: string): void {
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

  it('writes the debounced rewrite to the address bar when nothing moved under it', () => {
    const router = createRouter();
    router.navigate('galton');
    w.deliver();

    router.replaceParams({ p: 0.7 });
    expect(w.location.hash).toBe('#/galton');

    vi.advanceTimersByTime(150);
    expect(w.replaced).toEqual(['#/galton?p=0.7']);
    expect(w.location.hash).toBe('#/galton?p=0.7');
    router.destroy();
  });

  it('abandons the debounced rewrite when a hash navigation lands inside the window', () => {
    const router = createRouter();
    const routes: Route[] = [];
    router.subscribe((r) => routes.push(r));
    router.navigate('buffon');
    w.deliver();

    router.replaceParams({ ratio: 0.55 }); // arms the 150 ms debounce
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

    router.replaceParams({ p: 0.77 });
    w.location.hash = '#/buffon'; // hashchange queued, not yet delivered
    router.navigate('mandelbrot');

    expect(w.replaced).toEqual([]);
    expect(w.location.hash).toBe('#/mandelbrot');
    expect(router.route).toEqual({ id: 'mandelbrot', params: {} });
    router.destroy();
  });
});
