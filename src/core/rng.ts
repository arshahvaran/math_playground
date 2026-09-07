import type { Rng } from './types';

/**
 * Seeded pseudo-random number generation.
 *
 * Determinism is load-bearing here, not a nicety: a permalink is only meaningful
 * if `?seed=42` reproduces the exact run someone else saw, and the convergence
 * tests in tests/ assert on fixed-seed output. No visualization may call
 * `Math.random()` — see tests/determinism.test.ts, which fails the build if one does.
 */

/**
 * mulberry32. 32-bit state, period 2^32, passes gjrand's smallcrush.
 * Chosen over xoshiro128** for being a third of the code at equivalent quality
 * for this use: we are scattering pixels, not generating keys.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number): Rng {
  let next = mulberry32(seed);

  // Box–Muller produces two normals per pair of uniforms; cache the spare.
  let spare: number | null = null;

  return {
    next: () => next(),

    range: (lo, hi) => lo + next() * (hi - lo),

    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),

    bool: (p = 0.5) => next() < p,

    normal(): number {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      // Rejection-free polar form: avoids log(0) without a retry loop.
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const mul = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * mul;
      return u * mul;
    },

    reseed(newSeed: number) {
      next = mulberry32(newSeed);
      spare = null;
    },
  };
}

/** A fresh seed for the "randomize" button. Kept in 32-bit range so it round-trips through the URL. */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
