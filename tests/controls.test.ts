import { describe, expect, it } from 'vitest';
import { mapLogPosition, unmapLogPosition } from '../src/ui/controls';

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
