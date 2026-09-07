import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import {
  Welford,
  binomialPmf,
  fmt,
  histogram,
  logChoose,
  mean,
  normalCdf,
  normalPdf,
  standardError,
  stddev,
  variance,
} from '../src/core/stats';

/** Composite Simpson's rule — an independent check on the closed forms below. */
function simpson(f: (x: number) => number, a: number, b: number, steps: number): number {
  const h = (b - a) / steps;
  let s = f(a) + f(b);
  for (let i = 1; i < steps; i++) s += f(a + i * h) * (i % 2 === 1 ? 4 : 2);
  return (s * h) / 3;
}

describe('mean / variance / stddev', () => {
  it('computes textbook values on a small array', () => {
    const xs = [1, 2, 3, 4];
    expect(mean(xs)).toBe(2.5);
    expect(variance(xs)).toBe(1.25); // population: Σ(x−2.5)² / 4
    expect(stddev(xs)).toBe(Math.sqrt(1.25));
  });

  it('reads only the first n entries of a pre-allocated typed array', () => {
    const xs = new Float64Array(16);
    xs.set([1, 2, 3, 4]);
    expect(mean(xs, 4)).toBe(2.5);
    expect(variance(xs, 4)).toBe(1.25);
    // The zeros beyond n must not leak in.
    expect(mean(xs)).not.toBe(2.5);
  });

  it('clamps n to the array length rather than reading undefined', () => {
    expect(mean([1, 2, 3], 10)).toBe(2);
  });

  it('is NaN for an empty range and 0 for a constant array', () => {
    expect(mean([], 0)).toBeNaN();
    expect(variance([])).toBeNaN();
    expect(variance([7, 7, 7, 7])).toBe(0);
  });

  it('does not cancel when the mean dwarfs the spread', () => {
    // The one-pass E[x²] − E[x]² would be off by ~1e-1 here at offset 1e8;
    // two-pass rounding is bounded by the ulp of the offset (1.5e-8) times a
    // deviation under 1, so 1e-6 is a wide margin.
    const rng = createRng(3);
    const small = Array.from({ length: 5_000 }, () => rng.next());
    const shifted = small.map((v) => v + 1e8);
    expect(Math.abs(variance(shifted) - variance(small))).toBeLessThan(1e-6);
  });
});

describe('histogram', () => {
  it('conserves samples: counts plus underflow plus overflow equals n', () => {
    const rng = createRng(11);
    const n = 20_000;
    const xs = new Float64Array(n + 100); // slack beyond n, must be ignored
    for (let i = 0; i < n; i++) xs[i] = rng.range(-0.5, 1.5);
    const h = histogram(xs, { bins: 8, min: 0, max: 1, n });
    let inRange = 0;
    for (const c of h.counts) inRange += c;
    expect(inRange + h.underflow + h.overflow).toBe(n);
    // A quarter of the range lies on each side.
    // SE of a count with p = 0.25 at n = 20,000 is √(n·p·(1−p)) ≈ 61; 5σ ≈ 306.
    expect(Math.abs(h.underflow - n / 4)).toBeLessThan(306);
    expect(Math.abs(h.overflow - n / 4)).toBeLessThan(306);
  });

  it('fills bins uniformly for uniform input', () => {
    const rng = createRng(1);
    const n = 10_000;
    const xs = Array.from({ length: n }, () => rng.next());
    const h = histogram(xs, { bins: 10, min: 0, max: 1 });
    expect(h.underflow).toBe(0);
    expect(h.overflow).toBe(0);
    // Each bin is Binomial(10,000, 0.1): SE = √(10,000·0.1·0.9) = 30; 5σ = 150.
    for (const c of h.counts) expect(Math.abs(c - 1000)).toBeLessThan(150);
  });

  it('places edges exactly on min and max, with clean interior values', () => {
    const h = histogram([], { bins: 10, min: 0, max: 1 });
    expect(h.edges.length).toBe(11);
    expect(h.edges[0]).toBe(0);
    expect(h.edges[10]).toBe(1);
    expect(h.edges[3]).toBe(0.3);
  });

  it('keeps a sample on max in the last bin and one on min in the first', () => {
    const h = histogram([0, 1, 0.5, 1 - 1e-16], { bins: 4, min: 0, max: 1 });
    expect(Array.from(h.counts)).toEqual([1, 0, 1, 2]);
    expect(h.underflow + h.overflow).toBe(0);
  });

  it('bins integer data exactly with half-integer bounds', () => {
    const rows = 5;
    const landing = [0, 1, 1, 2, 2, 2, 3, 3, 4, 5];
    const h = histogram(landing, { bins: rows + 1, min: -0.5, max: rows + 0.5 });
    expect(Array.from(h.counts)).toEqual([1, 2, 3, 2, 1, 1]);
  });

  it('skips NaN and routes ±Infinity to the tails', () => {
    const h = histogram([NaN, Infinity, -Infinity, 0.5], { bins: 2, min: 0, max: 1 });
    expect(Array.from(h.counts)).toEqual([0, 1]);
    expect(h.underflow).toBe(1);
    expect(h.overflow).toBe(1);
  });

  it('rejects a degenerate range or bin count', () => {
    expect(() => histogram([], { bins: 0, min: 0, max: 1 })).toThrow(RangeError);
    expect(() => histogram([], { bins: 2.5, min: 0, max: 1 })).toThrow(RangeError);
    expect(() => histogram([], { bins: 4, min: 1, max: 1 })).toThrow(RangeError);
  });
});

describe('normalPdf', () => {
  it('peaks at 1/√(2π) for the standard normal', () => {
    expect(Math.abs(normalPdf(0, 0, 1) - 0.3989422804014327)).toBeLessThan(1e-16);
    expect(Math.abs(normalPdf(1, 0, 1) - 0.24197072451914337)).toBeLessThan(1e-16);
  });

  it('scales by 1/σ under a change of location and scale', () => {
    expect(normalPdf(3, 1, 2)).toBe(normalPdf(1, 0, 1) / 2);
  });

  it('integrates to 1', () => {
    // Simpson at h = 0.01 on [−10, 10] has error ~ (b−a)/180 · h⁴ · max|f⁗| ≈ 3e-9;
    // the mass beyond ±10 is 1.5e-23.
    const area = simpson((x) => normalPdf(x, 2, 0.7), -10 * 0.7 + 2, 10 * 0.7 + 2, 2000);
    expect(Math.abs(area - 1)).toBeLessThan(1e-8);
  });
});

describe('normalCdf', () => {
  it('gives the 97.5th percentile at z = 1.96', () => {
    expect(Math.abs(normalCdf(1.96, 0, 1) - 0.975)).toBeLessThan(1e-4);
  });

  it('matches erfc-derived references to double precision', () => {
    // References from Python's math.erfc. Hart's approximation measured at
    // ≤ 2.2e-16 absolute against them; 1e-14 leaves room for platform exp().
    const cases: ReadonlyArray<[number, number]> = [
      [0, 0.5],
      [0.5, 0.691462461274013],
      [1, 0.8413447460685428],
      [1.96, 0.9750021048517796],
      [2, 0.9772498680518209],
      [3, 0.9986501019683699],
      [5, 0.9999997133484282],
      [7.5, 0.999999999999968],
      [-1, 0.15865525393145707],
      [-1.96, 0.024997895148220435],
      [-3, 0.0013498980316300959],
    ];
    for (const [z, phi] of cases) {
      expect(Math.abs(normalCdf(z, 0, 1) - phi)).toBeLessThan(1e-14);
    }
  });

  it('keeps relative precision deep in the lower tail', () => {
    // Measured relative error against erfc is ≤ 9e-9 across the tail (worst
    // just past the 7.07 switch-over); 1e-7 is a 10× margin on values shown
    // to four digits.
    const cases: ReadonlyArray<[number, number]> = [
      [-5, 2.8665157187919455e-7],
      [-7.5, 3.19089167291092e-14],
      [-10, 7.619853024160595e-24],
      [-37, 5.7255712225251394e-300],
    ];
    for (const [z, phi] of cases) {
      expect(Math.abs(normalCdf(z, 0, 1) / phi - 1)).toBeLessThan(1e-7);
    }
    expect(normalCdf(-40, 0, 1)).toBe(0);
    expect(normalCdf(40, 0, 1)).toBe(1);
  });

  it('is symmetric to one rounding: Φ(−z) = 1 − Φ(z)', () => {
    // Both signs share one tail evaluation; the only difference is the
    // double rounding in 1 − (1 − tail), at most an ulp of 1 (1.1e-16) plus
    // half an ulp of the tail itself.
    for (const z of [0.1, 0.7, 1.3, 2.2, 3.9]) {
      expect(Math.abs(normalCdf(-z, 0, 1) - (1 - normalCdf(z, 0, 1)))).toBeLessThan(3e-16);
    }
  });

  it('agrees with numerical integration of the density', () => {
    // Independent of the erfc references: Simpson on [−9, x] at h = 0.001 has
    // error ~ 18/180 · 1e-12 · 3 ≈ 3e-13, and Φ(−9) = 1.1e-19 is dropped.
    for (const x of [-3, -1, -0.5, 0, 0.5, 1, 1.96, 3]) {
      const steps = Math.round((x + 9) / 0.001);
      const area = simpson((t) => normalPdf(t, 0, 1), -9, x, steps);
      expect(Math.abs(normalCdf(x, 0, 1) - area)).toBeLessThan(1e-11);
    }
  });

  it('standardizes by mu and sigma', () => {
    expect(normalCdf(5, 3, 2)).toBe(normalCdf(1, 0, 1));
  });
});

describe('logChoose', () => {
  it('reproduces ln C(1000, 500) = 689.467…', () => {
    // Reference is ln of the exact integer from Python's math.comb.
    // ln Γ(1001) ≈ 5912 carries an ulp of 9e-13; three such terms and Lanczos's
    // own 1e-15 relative error keep the sum within 1e-11. 1e-9 is a 100× margin.
    expect(Math.abs(logChoose(1000, 500) - 689.4672615678512)).toBeLessThan(1e-9);
  });

  it('is exact to rounding for small arguments', () => {
    // Each ln Γ term is ~1e2 with ulp 1.4e-14; 1e-11 covers three of them
    // plus the 1e-15 Lanczos error.
    expect(Math.abs(logChoose(5, 2) - Math.log(10))).toBeLessThan(1e-11);
    expect(Math.abs(logChoose(52, 5) - 14.77062192297037)).toBeLessThan(1e-11);
    expect(Math.abs(logChoose(30, 15) - 18.85969358114838)).toBeLessThan(1e-11);
    expect(logChoose(10, 0)).toBe(0);
    expect(logChoose(10, 10)).toBe(0);
  });

  it('does not overflow at n = 10⁶', () => {
    // References are ln of the exact integers from Python's math.comb.
    // ln Γ(10⁶ + 1) ≈ 1.3e7 has an ulp of 1.9e-9; a handful of such roundings
    // in each of the three terms bounds the error near 1e-8. 1e-7 is a 10×
    // margin on that and 1.4e-13 relative on the first value.
    const big = logChoose(1_000_000, 500_000);
    expect(Number.isFinite(big)).toBe(true);
    expect(Math.abs(big - 693140.0470130637)).toBeLessThan(1e-7);
    expect(Math.abs(logChoose(1_000_000, 3) - 39.654769204662266)).toBeLessThan(1e-7);
  });

  it('is symmetric in k ↔ n − k and −∞ outside 0..n', () => {
    expect(logChoose(40, 7)).toBe(logChoose(40, 33));
    expect(logChoose(5, -1)).toBe(-Infinity);
    expect(logChoose(5, 6)).toBe(-Infinity);
  });
});

describe('binomialPmf', () => {
  it('gives 252/1024 for ten fair flips landing five heads', () => {
    // exp() of a log-sum with ~1e-14 absolute error: relative 1e-14 on 0.246.
    expect(Math.abs(binomialPmf(10, 5, 0.5) - 252 / 1024)).toBeLessThan(1e-14);
    expect(Math.abs(binomialPmf(30, 7, 0.3) - 0.12185372599100643)).toBeLessThan(1e-14);
  });

  it('sums to 1 over k and has mean n·p', () => {
    const n = 30;
    const p = 0.3;
    let total = 0;
    let first = 0;
    for (let k = 0; k <= n; k++) {
      const q = binomialPmf(n, k, p);
      total += q;
      first += k * q;
    }
    expect(Math.abs(total - 1)).toBeLessThan(1e-12);
    expect(Math.abs(first - n * p)).toBeLessThan(1e-11);
  });

  it('handles the degenerate probabilities and out-of-range k', () => {
    expect(binomialPmf(10, 0, 0)).toBe(1);
    expect(binomialPmf(10, 3, 0)).toBe(0);
    expect(binomialPmf(10, 10, 1)).toBe(1);
    expect(binomialPmf(10, 9, 1)).toBe(0);
    expect(binomialPmf(10, -1, 0.5)).toBe(0);
    expect(binomialPmf(10, 11, 0.5)).toBe(0);
    expect(binomialPmf(10, 2.5, 0.5)).toBe(0);
    expect(binomialPmf(0, 0, 0.4)).toBe(1);
  });

  it('stays finite for a 20-row Galton board at every k and for large n', () => {
    for (let k = 0; k <= 20; k++) expect(Number.isFinite(binomialPmf(20, k, 0.7))).toBe(true);
    // Exact C(10⁶, 5·10⁵) / 2^10⁶ from Python's big integers. Not the normal
    // approximation 1/√(2π·250,000): the local-limit correction (1 − 1/(8m))
    // is 2.5e-7 relative here, which is 2e-10 absolute, well above the
    // rounding. logChoose is good to ~1e-9 absolute at n = 10⁶, so the pmf is
    // good to ~1e-9 relative, ~1e-12 absolute; 1e-10 is a wide margin.
    expect(Math.abs(binomialPmf(1_000_000, 500_000, 0.5) - 7.978843613317501e-4)).toBeLessThan(
      1e-10,
    );
  });
});

describe('standardError', () => {
  it('is √(p(1−p)/n)', () => {
    expect(standardError(0.5, 100)).toBe(0.05);
    expect(Math.abs(standardError(0.3, 10_000) - Math.sqrt(0.21) / 100)).toBeLessThan(1e-16);
  });

  it('is infinite with no trials', () => {
    expect(standardError(0.5, 0)).toBe(Infinity);
  });
});

describe('fmt', () => {
  it('rounds to four significant figures by default', () => {
    expect(fmt(3.14159265)).toBe('3.142');
    expect(fmt(1234.5678)).toBe('1235');
    expect(fmt(0.000123456)).toBe('0.0001235');
  });

  it('honours the digits argument', () => {
    expect(fmt(3.14159265, 2)).toBe('3.1');
    expect(fmt(3.14159265, 6)).toBe('3.14159');
    expect(fmt(0.000123456, 2)).toBe('0.00012');
  });

  it('never emits exponent notation or separators across [1e-4, 1e9]', () => {
    for (let e = -4; e <= 8; e++) {
      for (const m of [1, 1.2345, 9.9999]) {
        const x = m * 10 ** e;
        const s = fmt(x);
        expect(s).not.toMatch(/[e,]/);
        // Four significant figures: relative error under 5e-4.
        expect(Math.abs(Number(s) / x - 1)).toBeLessThan(5e-4);
      }
    }
  });

  it('keeps every digit left of the decimal point', () => {
    expect(fmt(12345.678)).toBe('12346');
    expect(fmt(1234567.89)).toBe('1234568');
  });

  it('prints integer counts as integers and keeps width on non-integers', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(100)).toBe('100');
    expect(fmt(50_000)).toBe('50000');
    expect(fmt(2.5)).toBe('2.500');
    expect(fmt(100.04)).toBe('100.0');
  });

  it('carries a rounding overflow cleanly', () => {
    expect(fmt(9.9996)).toBe('10.00');
    expect(fmt(9999.7)).toBe('10000');
    expect(fmt(0.99996)).toBe('1.000');
  });

  it('handles sign and non-finite input', () => {
    expect(fmt(-3.14159265)).toBe('-3.142');
    expect(fmt(-0.5)).toBe('-0.5000');
    expect(fmt(NaN)).toBe('NaN');
    expect(fmt(Infinity)).toBe('∞');
    expect(fmt(-Infinity)).toBe('-∞');
  });
});

describe('Welford', () => {
  it('matches the two-pass moments on a 10k uniform stream', () => {
    // Both routes round differently; the disagreement is a few ulps of values
    // near 0.5 and 1/12, far under 1e-12.
    const rng = createRng(1);
    const n = 10_000;
    const xs = new Float64Array(n);
    const w = new Welford();
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      xs[i] = v;
      w.push(v);
    }
    expect(w.n).toBe(n);
    expect(Math.abs(w.mean - mean(xs))).toBeLessThan(1e-12);
    expect(Math.abs(w.variance - variance(xs))).toBeLessThan(1e-12);
    expect(w.stddev).toBe(Math.sqrt(w.variance));
    // And the sample itself sits where Uniform(0, 1) says: mean ½ ± 1/√(12n) ≈ 0.0029.
    expect(Math.abs(w.mean - 0.5)).toBeLessThan(0.015); // 5σ
    expect(Math.abs(w.variance - 1 / 12)).toBeLessThan(0.005);
  });

  it('is stable under a large offset', () => {
    const rng = createRng(5);
    const w = new Welford();
    const small: number[] = [];
    for (let i = 0; i < 5_000; i++) {
      const v = rng.next();
      small.push(v);
      w.push(v + 1e8);
    }
    expect(Math.abs(w.variance - variance(small))).toBeLessThan(1e-6);
  });

  it('is NaN before the first sample and after reset', () => {
    const w = new Welford();
    expect(w.n).toBe(0);
    expect(w.mean).toBeNaN();
    expect(w.variance).toBeNaN();
    w.push(4);
    expect(w.mean).toBe(4);
    expect(w.variance).toBe(0);
    w.push(6);
    expect(w.mean).toBe(5);
    expect(w.variance).toBe(1);
    w.reset();
    expect(w.n).toBe(0);
    expect(w.mean).toBeNaN();
  });
});
