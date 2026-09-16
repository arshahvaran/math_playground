import { afterEach, describe, expect, it } from 'vitest';
import { byClass, installDom, type Harness } from './dom-harness';
import type { ParamSpec } from '../src/core/types';
import { registry } from '../src/viz/registry';
import {
  createControls,
  intEntry,
  logPositionFor,
  logPositions,
  logValueFor,
  mapLogPosition,
  nudgeLogValue,
  snapToStep,
  unmapLogPosition,
} from '../src/ui/controls';

/**
 * The log fader's mapping. It is the only part of the control rail that is
 * arithmetic rather than DOM, and it is the part that can be wrong silently: a
 * fader whose thumb sits a percent off its value still looks like a fader.
 *
 * These are the properties the rail depends on — the ends are exact, so a slider
 * dragged to its stop reports the declared minimum and maximum rather than
 * 1.0000000000000002; the round trip is stable, so `setValues()` from a preset
 * puts the thumb back where the same value left it; and a range that starts at
 * or below zero degrades to a linear fader instead of producing NaN.
 */

const RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 200_000], // Buffon's total drops
  [1, 2000], // drop rate
  [0.5, 8], // a speed-like span under 2 decades
  [1e-3, 1e3], // a symmetric six-decade span
];

/**
 * Every integer-stepped log fader in the registry, as `[label, min, max, step]`.
 *
 * Read off the registry rather than listed by hand. The hand-written list was
 * four entries and went stale the moment a tab was added — and a fader missing
 * from it is exactly a fader nobody checked. The filter is the whole grid being
 * integers: the Lorenz starting gap (10⁻¹² → 10⁻³ on a 10⁻¹² step) drops out on
 * its own, which is what we want, because walking its value grid a step at a
 * time is a billion iterations.
 */
const LOG_SPECS: ReadonlyArray<readonly [string, number, number, number]> = registry.flatMap(
  (viz) =>
    viz.params
      .filter(
        (spec): spec is Extract<ParamSpec, { kind: 'range' }> =>
          spec.kind === 'range' &&
          spec.log === true &&
          Number.isInteger(spec.min) &&
          Number.isInteger(spec.max) &&
          Number.isInteger(spec.step),
      )
      .map((spec) => [`${viz.id} ${spec.key}`, spec.min, spec.max, spec.step] as const),
);

describe('mapLogPosition', () => {
  it('maps the ends exactly', () => {
    for (const [min, max] of RANGES) {
      expect(mapLogPosition(0, min, max)).toBe(min);
      expect(mapLogPosition(1, min, max)).toBe(max);
    }
  });

  it('puts the geometric mean at the midpoint', () => {
    // Equal travel is equal ratio: that is the whole point of a log fader.
    expect(mapLogPosition(0.5, 1, 10_000)).toBeCloseTo(100, 10);
    expect(mapLogPosition(0.25, 1, 10_000)).toBeCloseTo(10, 10);
    expect(mapLogPosition(0.75, 1, 10_000)).toBeCloseTo(1000, 10);
  });

  it('is monotone increasing across the travel', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const value = mapLogPosition(i / 100, 1, 200_000);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('clamps positions outside [0, 1] to the ends', () => {
    expect(mapLogPosition(-0.5, 1, 1000)).toBe(1);
    expect(mapLogPosition(1.5, 1, 1000)).toBe(1000);
    // NaN is a missing reading, not a position past the end.
    expect(mapLogPosition(Number.NaN, 1, 1000)).toBe(1);
  });
});

describe('unmapLogPosition', () => {
  it('maps min to 0 and max to 1', () => {
    for (const [min, max] of RANGES) {
      expect(unmapLogPosition(min, min, max)).toBe(0);
      expect(unmapLogPosition(max, min, max)).toBe(1);
    }
  });

  it('clamps values outside the range', () => {
    expect(unmapLogPosition(0.5, 1, 1000)).toBe(0);
    expect(unmapLogPosition(5000, 1, 1000)).toBe(1);
    // log(0) is −∞ and log of a negative is NaN; both mean "at the bottom".
    expect(unmapLogPosition(0, 1, 1000)).toBe(0);
    expect(unmapLogPosition(-4, 1, 1000)).toBe(0);
  });
});

describe('round trip', () => {
  it('returns the position it was given', () => {
    for (const [min, max] of RANGES) {
      for (let i = 0; i <= 1000; i += 25) {
        const position = i / 1000;
        const value = mapLogPosition(position, min, max);
        expect(unmapLogPosition(value, min, max)).toBeCloseTo(position, 12);
      }
    }
  });

  it('returns the value it was given', () => {
    for (const value of [1, 7, 100, 4321, 199_999, 200_000]) {
      const position = unmapLogPosition(value, 1, 200_000);
      expect(mapLogPosition(position, 1, 200_000)).toBeCloseTo(value, 8);
    }
  });

  it('survives the 1000-position quantisation the slider actually uses', () => {
    // The fader is an integer slider; a preset's value has to land within one
    // position of where it started or the thumb visibly drifts on every apply.
    const [min, max] = [1, 200_000];
    for (const value of [1, 10, 137, 20_000, 200_000]) {
      const position = Math.round(unmapLogPosition(value, min, max) * 1000) / 1000;
      const back = mapLogPosition(position, min, max);
      expect(Math.abs(Math.log(back / value))).toBeLessThan(Math.log(max / min) / 1000 + 1e-12);
    }
  });
});

describe('linear fallback', () => {
  // Documented behaviour, not an accident: a ratio needs a positive minimum, and
  // a spec declaring `log: true` from 0 is asking for a fader, not an exception.
  it('maps linearly when min is zero', () => {
    expect(mapLogPosition(0, 0, 10)).toBe(0);
    expect(mapLogPosition(0.5, 0, 10)).toBe(5);
    expect(mapLogPosition(1, 0, 10)).toBe(10);
    expect(unmapLogPosition(0, 0, 10)).toBe(0);
    expect(unmapLogPosition(2.5, 0, 10)).toBe(0.25);
    expect(unmapLogPosition(10, 0, 10)).toBe(1);
  });

  it('maps linearly when min is negative', () => {
    expect(mapLogPosition(0.5, -10, 10)).toBe(0);
    expect(mapLogPosition(0, -10, 10)).toBe(-10);
    expect(mapLogPosition(1, -10, 10)).toBe(10);
    expect(unmapLogPosition(0, -10, 10)).toBe(0.5);
    expect(unmapLogPosition(-10, -10, 10)).toBe(0);
    expect(unmapLogPosition(10, -10, 10)).toBe(1);
  });

  it('round trips through the linear fallback', () => {
    for (let i = 0; i <= 10; i++) {
      const position = i / 10;
      const value = mapLogPosition(position, -5, 15);
      expect(unmapLogPosition(value, -5, 15)).toBeCloseTo(position, 12);
    }
  });

  it('degenerate ranges collapse to the minimum rather than dividing by zero', () => {
    expect(mapLogPosition(0.5, 4, 4)).toBe(4);
    expect(unmapLogPosition(4, 4, 4)).toBe(0);
    expect(Number.isFinite(unmapLogPosition(9, 4, 4))).toBe(true);
  });
});

/**
 * The position grid, and the reason it is not the value grid.
 *
 * A fader mounted at 2,000 whose thumb decodes to 1,990 is a trap: grabbing it
 * and letting go where it was, or pressing an arrow and pressing it back, spends
 * a parameter change and — on a structural parameter — the reader's whole run.
 * So every value the parameter can take has to be a position the thumb can hold.
 */
describe('logPositions', () => {
  it('never goes below the notch count, whatever the range', () => {
    for (const [min, max] of RANGES) expect(logPositions(min, max, 1)).toBeGreaterThanOrEqual(1000);
    expect(logPositions(0, 10, 1)).toBe(1000);
    expect(logPositions(5, 5, 1)).toBe(1000);
    expect(logPositions(1, 10, 0)).toBe(1000);
  });

  it('is finer for a range whose values are finer', () => {
    // Same span, a hundredth of the step: a hundred times the positions.
    const coarse = logPositions(1, 20_000, 100);
    expect(logPositions(1, 20_000, 1) / coarse).toBeCloseTo(100, 0);
  });
});

describe('mount round trip', () => {
  it('decodes every representable value back to itself', () => {
    for (const [label, min, max, step] of LOG_SPECS) {
      const off: number[] = [];
      for (let v = min; v <= max; v += step) {
        if (logValueFor(logPositionFor(v, min, max, step), min, max, step) !== v) off.push(v);
      }
      expect({ [label]: off.slice(0, 8) }).toEqual({ [label]: [] });
    }
  });

  it('holds at the shipped defaults and Story presets', () => {
    // These are the values a cold load and every preset chip mount at; 2,000 was
    // the one that decoded to 1,990 and rewrote the URL on the first touch.
    const mounted = (v: number, min: number, max: number, step: number): number =>
      logValueFor(logPositionFor(v, min, max, step), min, max, step);
    for (const v of [2000, 5000, 10_000, 20_000]) expect(mounted(v, 1, 20_000, 1)).toBe(v);
    expect(mounted(120, 1, 2000, 1)).toBe(120);
    for (const v of [200, 20_000, 200_000]) expect(mounted(v, 100, 200_000, 100)).toBe(v);
  });

  it('keeps the ends on the ends', () => {
    for (const [, min, max, step] of LOG_SPECS) {
      expect(logPositionFor(min, min, max, step)).toBe(0);
      expect(logPositionFor(max, min, max, step)).toBe(logPositions(min, max, step));
      expect(logValueFor(0, min, max, step)).toBe(min);
      expect(logValueFor(logPositions(min, max, step), min, max, step)).toBe(max);
    }
  });

  it('decodes positions in order', () => {
    for (const [, min, max, step] of LOG_SPECS) {
      const positions = logPositions(min, max, step);
      let previous = min;
      for (let p = 0; p <= positions; p += Math.ceil(positions / 5000)) {
        const value = logValueFor(p, min, max, step);
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value).toBeLessThanOrEqual(max);
        previous = value;
      }
    }
  });
});

describe('nudgeLogValue', () => {
  it('moves on every press, all the way up and all the way down', () => {
    // The bug this replaces: the first 41 ArrowRight presses on Galton's ball
    // count all decoded back to 1, so the fader looked broken and each dead
    // press still reset the simulation.
    for (const [, min, max, step] of LOG_SPECS) {
      let value = min;
      let presses = 0;
      while (value < max) {
        const next = nudgeLogValue(value, min, max, step, 1);
        expect(next).toBeGreaterThanOrEqual(value + step);
        expect(next).toBeLessThanOrEqual(max);
        value = next;
        presses += 1;
        expect(presses).toBeLessThan(2000);
      }
      while (value > min) {
        const next = nudgeLogValue(value, min, max, step, -1);
        expect(next).toBeLessThanOrEqual(value - step);
        expect(next).toBeGreaterThanOrEqual(min);
        value = next;
        presses += 1;
        expect(presses).toBeLessThan(4000);
      }
    }
  });

  it('steps by one where a notch is finer than the step', () => {
    expect(nudgeLogValue(1, 1, 20_000, 1, 1)).toBe(2);
    expect(nudgeLogValue(2, 1, 20_000, 1, -1)).toBe(1);
    expect(nudgeLogValue(100, 100, 200_000, 100, 1)).toBe(200);
  });

  it('moves by a ratio where the notch is the coarser of the two', () => {
    // A notch is (max/min)^(1/1000) — a shade under 1% over Galton's range.
    const up = nudgeLogValue(10_000, 1, 20_000, 1, 1);
    expect(up / 10_000).toBeCloseTo((20_000 / 1) ** (1 / 1000), 3);
  });

  it('comes back to where it started', () => {
    for (const [, min, max, step] of LOG_SPECS) {
      for (let v = min; v <= max; v += step * Math.ceil((max - min) / step / 500)) {
        const there = nudgeLogValue(v, min, max, step, 1);
        if (there === max) continue; // pushed against the stop, which does not move
        expect(nudgeLogValue(there, min, max, step, -1)).toBe(v);
      }
    }
  });

  it('holds still at the ends', () => {
    for (const [, min, max, step] of LOG_SPECS) {
      expect(nudgeLogValue(max, min, max, step, 1)).toBe(max);
      expect(nudgeLogValue(min, min, max, step, -1)).toBe(min);
    }
  });

  it('pages by a tenth of the travel without ever standing still', () => {
    // Page keys are handled here too: the browser's own big step is a fraction
    // of the position range, and the position range is now far finer than the
    // value range, so at the bottom of a fader it would move nothing.
    for (const [, min, max, step] of LOG_SPECS) {
      let value = min;
      let presses = 0;
      while (value < max) {
        const next = nudgeLogValue(value, min, max, step, 100);
        expect(next).toBeGreaterThan(value);
        value = next;
        presses += 1;
        expect(presses).toBeLessThanOrEqual(15);
      }
      expect(presses).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('snapToStep', () => {
  it('clamps to the ends and lands on the step', () => {
    expect(snapToStep(1234.7, 1, 20_000, 1)).toBe(1235);
    expect(snapToStep(-5, 1, 20_000, 1)).toBe(1);
    expect(snapToStep(1e9, 1, 20_000, 1)).toBe(20_000);
    expect(snapToStep(20_050, 100, 200_000, 100)).toBe(20_100);
  });

  it('rounds the binary noise back out of a fractional step', () => {
    expect(snapToStep(0.1 + 0.2, 0, 1, 0.01)).toBe(0.3);
    expect(snapToStep(0.3333, 0, 1, 0.01)).toBe(0.33);
  });

  it('passes a non-finite reading through as the minimum', () => {
    expect(snapToStep(Number.NaN, 3, 20, 1)).toBe(3);
  });
});

/**
 * The int row's entry rules. Both of these cost the reader a finished run: the
 * stepper keys stay enabled at the ends by design, and a cleared field is the
 * middle of select-all-then-retype, not a request for the minimum.
 */
describe('intEntry', () => {
  it('reports nothing when a key at its own limit changes nothing', () => {
    expect(intEntry(21, 20, 3, 20)).toBeNull();
    expect(intEntry(2, 3, 3, 20)).toBeNull();
    expect(intEntry(161, 160, 24, 160)).toBeNull();
    expect(intEntry(23, 24, 24, 160)).toBeNull();
  });

  it('reports nothing for a number typed past the end it is already at', () => {
    expect(intEntry('999', 20, 3, 20)).toBeNull();
    expect(intEntry('-4', 3, 3, 20)).toBeNull();
  });

  it('restores rather than collapsing when the field is cleared', () => {
    expect(intEntry('', 12, 3, 20)).toBeNull();
    expect(intEntry('   ', 12, 3, 20)).toBeNull();
    expect(intEntry('twelve', 12, 3, 20)).toBeNull();
  });

  it('clamps a reachable entry and reports it', () => {
    expect(intEntry('999', 12, 3, 20)).toBe(20);
    expect(intEntry(-4, 12, 3, 20)).toBe(3);
    expect(intEntry('15', 12, 3, 20)).toBe(15);
    expect(intEntry(13, 12, 3, 20)).toBe(13);
  });

  it('rounds a fractional entry to the lattice', () => {
    expect(intEntry('7.6', 12, 3, 20)).toBe(8);
    expect(intEntry('12.4', 12, 3, 20)).toBeNull();
  });
});

/**
 * The rail renders every kind of `ParamSpec` but one. A seed is not a knob a
 * reader turns — it is the transport's Shuffle key — and a help sentence under
 * every row was most of the text on the page.
 */
describe('the rail', () => {
  let dom: Harness | null = null;

  afterEach(() => {
    dom?.teardown();
    dom = null;
  });

  it('renders no seed row and no help text', () => {
    dom = installDom();
    const host = dom.document.createElement('form');
    dom.app.appendChild(host);
    const specs: readonly ParamSpec[] = [
      { kind: 'int', key: 'rows', label: 'Rows', min: 3, max: 20, default: 12, help: 'Peg rows.' },
      { kind: 'range', key: 'p', label: 'Bias', min: 0, max: 1, step: 0.01, default: 0.5, help: 'A coin.' },
      { kind: 'toggle', key: 'trails', label: 'Trails', default: true, help: 'Fading traces.' },
      { kind: 'choice', key: 'lattice', label: 'Lattice', options: [{ value: 'off', label: 'Off' }], default: 'off' },
      { kind: 'seed', key: 'seed', label: 'Seed', default: 42, help: 'Same seed, same pile.' },
    ];
    const handle = createControls(host as unknown as HTMLElement, specs, { seed: 7 }, () => undefined);

    // Declared order, seed dropped.
    const rows = byClass(dom, 'control');
    expect(rows.map((row) => row.className)).toEqual([
      'control control--int',
      'control control--range',
      'control control--toggle',
      'control control--choice',
    ]);
    expect(rows.some((row) => row.textContent.includes('Seed'))).toBe(false);
    expect(byClass(dom, 'control__help')).toEqual([]);
    expect(host.textContent).not.toContain('Peg rows.');

    // Setting the seed is not an error either; there is simply nothing to show.
    expect(() => handle.setValue('seed', 9)).not.toThrow();
    handle.destroy();
  });
});
