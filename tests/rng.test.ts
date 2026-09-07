import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';

describe('createRng', () => {
  it('reproduces an identical stream from the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const streamA = Array.from({ length: 500 }, () => a.next());
    const streamB = Array.from({ length: 500 }, () => b.next());
    expect(streamA).toEqual(streamB);
  });

  it('produces different streams from different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toEqual(b.next());
  });

  it('reseeds back to the start of the stream', () => {
    const rng = createRng(7);
    const first = [rng.next(), rng.next(), rng.next()];
    rng.reseed(7);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(first);
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is uniform enough that no decile deviates more than 5% from expectation', () => {
    const rng = createRng(12345);
    const n = 100_000;
    const bins = new Array(10).fill(0);
    for (let i = 0; i < n; i++) bins[Math.floor(rng.next() * 10)]++;
    for (const count of bins) {
      expect(Math.abs(count - n / 10) / (n / 10)).toBeLessThan(0.05);
    }
  });

  it('generates standard normals with the right first two moments', () => {
    const rng = createRng(2024);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const z = rng.normal();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    // Standard error of the mean is 1/sqrt(n) ≈ 0.0022; 0.02 is a ~9-sigma envelope.
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(variance - 1)).toBeLessThan(0.02);
  });

  it('respects the probability given to bool()', () => {
    const rng = createRng(555);
    const n = 100_000;
    let heads = 0;
    for (let i = 0; i < n; i++) if (rng.bool(0.3)) heads++;
    expect(Math.abs(heads / n - 0.3)).toBeLessThan(0.01);
  });

  it('keeps int() inclusive of both endpoints', () => {
    const rng = createRng(8);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) seen.add(rng.int(1, 6));
    expect([...seen].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
