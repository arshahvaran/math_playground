import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import {
  NeedleField,
  crossingProbability,
  dropNeedle,
  estimatePi,
  needleCrosses,
  piStandardError,
  type Needle,
} from '../src/viz/buffon/geometry';

const SEED = 42;
const LENGTH = 0.8;
const SPACING = 1;
const DROPS = 100_000;
/** Analytic crossing probability at L/d = 0.8: 2·0.8/π = 0.50930. */
const P = (2 * LENGTH) / (Math.PI * SPACING);

/**
 * 100,000 drops on a 10 × 10 field — ten whole strips, so y mod d is exactly
 * uniform. The buffer is deliberately far smaller than the drop count: the
 * statistics must keep counting after the ring wraps.
 */
function run(seed: number, budget = 1_000): NeedleField {
  const rng = createRng(seed);
  const field = new NeedleField(budget);
  for (let i = 0; i < DROPS; i++) field.push(dropNeedle(rng, 10, 10, LENGTH, SPACING));
  return field;
}

/**
 * `NeedleField` stores each needle's direction as (cos θ, sin θ) so the painter
 * never recomputes 20,000 sin/cos per frame, so the angle has to be recovered
 * here — and through Float32 storage it comes back a few ulps off. Hence
 * `expectNeedles` rather than a bare `toEqual`.
 */
function collect(field: NeedleField): Needle[] {
  const out: Needle[] = [];
  field.forEach((x, y, cos, sin, crosses) => out.push({ x, y, angle: Math.atan2(sin, cos), crosses }));
  return out;
}

function expectNeedles(actual: Needle[], expected: Needle[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((want, i) => {
    const got = actual[i];
    expect(got).toBeDefined();
    expect(got?.x).toBe(want.x);
    expect(got?.y).toBe(want.y);
    expect(got?.crosses).toBe(want.crosses);
    // Float32 round-trip through (cos, sin) holds to ~7 significant digits.
    expect(got?.angle).toBeCloseTo(want.angle, 5);
  });
}

describe('buffon convergence', () => {
  it('crossing fraction reaches 2L/(πd) within 4σ at 100,000 drops', () => {
    const field = run(SEED);
    expect(field.drops).toBe(DROPS);
    expect(field.count).toBe(1_000);
    // A proportion at N = 1e5 has SE = sqrt(P(1−P)/N) = 0.00158; 0.006 is ≈ 3.8σ.
    expect(Math.abs(field.crossings / field.drops - P)).toBeLessThan(0.006);
  });

  it('π estimate reaches Math.PI within 4σ at 100,000 drops', () => {
    const field = run(SEED);
    const pi = estimatePi(field.drops, field.crossings, LENGTH, SPACING);
    // Delta-method SE of π̂ is π·sqrt((1−P)/(P·N)) = 0.00975 here, so 0.04 is ≈ 4.1σ.
    expect(piStandardError(DROPS, LENGTH, SPACING)).toBeCloseTo(0.00975, 4);
    expect(Math.abs(pi - Math.PI)).toBeLessThan(0.04);
  });

  it('reproduces the same needles and counts from the same seed', () => {
    const a = run(SEED);
    const b = run(SEED);
    expect(a.drops).toBe(b.drops);
    expect(a.crossings).toBe(b.crossings);
    expect(collect(a)).toEqual(collect(b));
  });

  it('differs between seeds', () => {
    expect(run(1).crossings).not.toBe(run(2).crossings);
  });

  it('gives the same crossings at any field height, so a permalink survives the recipient’s window', () => {
    // Crossing is decided by y₀ and θ, drawn before the layout is consulted;
    // the field height only picks the strip the needle is painted in, and it
    // costs the same one draw whatever the height. Heights here span 3, 10 and
    // 37 whole strips plus a partial one, and one shorter than a single strip.
    const counts = [0.4, 3, 10, 37.5].map((height) => {
      const rng = createRng(SEED);
      const field = new NeedleField(100);
      for (let i = 0; i < 20_000; i++) field.push(dropNeedle(rng, 10, height, LENGTH, SPACING));
      return field.crossings;
    });
    expect(new Set(counts).size, `crossings varied with field height: ${counts.join(', ')}`).toBe(1);
    // A live check that the count is the real one, not zero on every height.
    expect(counts[0]).toBeGreaterThan(9_000);
  });
});

describe('dropNeedle', () => {
  it('keeps centres inside the field and angles in [0, π)', () => {
    const rng = createRng(7);
    // Counted rather than asserted per needle: 70,000 expect() calls cost a
    // second, one comparison of a counter costs nothing.
    let outside = 0;
    let inconsistent = 0;
    let maxAngle = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const n = dropNeedle(rng, 10, 10, LENGTH, SPACING);
      if (n.x < 0 || n.x >= 10 || n.y < 0 || n.y >= 10 || n.angle < 0 || n.angle >= Math.PI) outside++;
      if (n.crosses !== needleCrosses(n.y, n.angle, LENGTH, SPACING)) inconsistent++;
      maxAngle = Math.max(maxAngle, n.angle);
    }
    expect(outside).toBe(0);
    expect(inconsistent).toBe(0);
    // Angles do reach the top of the range: the largest of 10,000 uniform draws
    // on [0, π) falls short of π by about π/10,000 on average.
    expect(maxAngle).toBeGreaterThan(Math.PI - 0.01);
  });
});

describe('needleCrosses', () => {
  it('always crosses when centred exactly on a line, at any angle', () => {
    for (let k = 0; k < 6; k++) {
      for (const angle of [0, 0.3, Math.PI / 2, 2.5, Math.PI - 1e-9]) {
        expect(needleCrosses(k * SPACING, angle, LENGTH, SPACING)).toBe(true);
      }
    }
  });

  it('never crosses when horizontal and off a line', () => {
    for (const y of [0.05, 0.3, 0.5, 0.7, 0.999, 3.5, 7.25]) {
      expect(needleCrosses(y, 0, LENGTH, SPACING)).toBe(false);
    }
  });

  it('always crosses when vertical at full length', () => {
    // Reach is d/2, so one of y₀ ≤ d/2 or d − y₀ ≤ d/2 holds for every y₀.
    for (let i = 0; i <= 100; i++) {
      expect(needleCrosses(i / 100 + 2, Math.PI / 2, SPACING, SPACING)).toBe(true);
    }
  });

  it('depends on y only through the distance to the nearest line', () => {
    const rng = createRng(3);
    for (let i = 0; i < 2_000; i++) {
      const y0 = rng.range(0, SPACING);
      const angle = rng.range(0, Math.PI);
      const base = needleCrosses(y0, angle, LENGTH, SPACING);
      expect(needleCrosses(SPACING - y0, angle, LENGTH, SPACING)).toBe(base);
      expect(needleCrosses(y0 + 7 * SPACING, angle, LENGTH, SPACING)).toBe(base);
      expect(needleCrosses(y0 - 3 * SPACING, angle, LENGTH, SPACING)).toBe(base);
    }
  });
});

describe('crossingProbability', () => {
  it('is 2L/(πd) for L ≤ d', () => {
    expect(crossingProbability(0.8, 1)).toBeCloseTo(P, 12);
    expect(crossingProbability(51.2, 64)).toBeCloseTo(P, 12);
    expect(crossingProbability(1, 1)).toBeCloseTo(2 / Math.PI, 12);
    expect(crossingProbability(0, 1)).toBe(0);
  });

  it('clamps the out-of-scope long-needle case to the L = d value', () => {
    expect(crossingProbability(1.5, 1)).toBeCloseTo(2 / Math.PI, 12);
  });
});

describe('estimatePi', () => {
  it('is NaN before the first crossing', () => {
    expect(estimatePi(0, 0, LENGTH, SPACING)).toBeNaN();
    expect(estimatePi(50, 0, LENGTH, SPACING)).toBeNaN();
  });

  it('recovers π exactly from the expected crossing count', () => {
    expect(estimatePi(1_000, 1_000 * P, LENGTH, SPACING)).toBeCloseTo(Math.PI, 10);
    expect(estimatePi(3_408, 1_808, 5 / 6, 1)).toBeCloseTo(355 / 113, 12);
  });
});

describe('piStandardError', () => {
  it('follows the delta method and shrinks as 1/√N', () => {
    const se = piStandardError(DROPS, LENGTH, SPACING);
    expect(se).toBeCloseTo(Math.PI * Math.sqrt((1 - P) / (P * DROPS)), 12);
    expect(se / piStandardError(4 * DROPS, LENGTH, SPACING)).toBeCloseTo(2, 12);
  });

  it('is infinite with no drops or a zero-length needle', () => {
    expect(piStandardError(0, LENGTH, SPACING)).toBe(Infinity);
    expect(piStandardError(1_000, 0, SPACING)).toBe(Infinity);
  });
});

describe('NeedleField', () => {
  // Coordinates are multiples of 1/4 so they survive the Float32 round trip exactly.
  const needle = (i: number, crosses: boolean): Needle => ({ x: i + 0.25, y: 2 * i + 0.5, angle: 0.5, crosses });

  it('keeps only the newest `budget` needles but counts every drop', () => {
    const field = new NeedleField(5);
    for (let i = 0; i < 8; i++) field.push(needle(i, i % 2 === 0));
    expect(field.capacity).toBe(5);
    expect(field.count).toBe(5);
    expect(field.drops).toBe(8);
    expect(field.crossings).toBe(4);
    expectNeedles(collect(field), [3, 4, 5, 6, 7].map((i) => needle(i, i % 2 === 0)));
  });

  it('visits oldest first with a chronological index', () => {
    const field = new NeedleField(3);
    for (let i = 0; i < 3; i++) field.push(needle(i, false));
    const seen: number[] = [];
    field.forEach((x, _y, _cos, _sin, _crosses, index) => {
      seen.push(index);
      expect(x).toBe(index + 0.25);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('reset clears the needles and the counters', () => {
    const field = new NeedleField(4);
    for (let i = 0; i < 10; i++) field.push(needle(i, true));
    field.reset();
    expect(field.count).toBe(0);
    expect(field.drops).toBe(0);
    expect(field.crossings).toBe(0);
    expectNeedles(collect(field), []);
    field.push(needle(0, true));
    expectNeedles(collect(field), [needle(0, true)]);
  });

  it('never allocates below one slot', () => {
    const field = new NeedleField(0);
    field.push(needle(1, false));
    field.push(needle(2, true));
    expect(field.count).toBe(1);
    expect(field.drops).toBe(2);
    expectNeedles(collect(field), [needle(2, true)]);
  });
});
