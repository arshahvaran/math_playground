import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, Rng, VizContext } from '../src/core/types';
import {
  chartScale,
  chartX,
  chartY,
  dotRadius,
  layoutPlate,
  layoutRings,
  peopleCount,
  prisoners,
  ringArea,
  ringRadius,
  roundRateFor,
  roundTarget,
  type Rect,
  type RingSlots,
} from '../src/viz/prisoners/index';
import {
  RunTally,
  boxesAllowed,
  cycleLengths,
  exactSuccessProbability,
  guessingProbability,
  harmonic,
  longestCycle,
  shuffle,
  successProbability,
} from '../src/viz/prisoners/cycles';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** The module's own ceilings, restated here so a change to one fails a test. */
const MAX_PEOPLE = 200;
const MAX_ROUNDS = 2_000;
const PAINTED_SAMPLES = 360;

/** The label face the shell hands every visualization, from theme.css. */
const LABEL_FONT = '500 11px "Martian Mono", monospace';

/** n = 100, k = 50: the number the whole tab exists to reach. */
const P100 = successProbability(100, 50);

// ---------------------------------------------------------------------------
// The closed form
// ---------------------------------------------------------------------------

describe('harmonic', () => {
  it('sums the reciprocals', () => {
    expect(harmonic(0)).toBe(0);
    expect(harmonic(1)).toBe(1);
    expect(harmonic(4)).toBeCloseTo(25 / 12, 15);
  });

  it('tracks ln n + γ', () => {
    const EULER = 0.5772156649015329;
    // Euler–Maclaurin: Hₙ − ln n − γ = 1/(2n) + O(1/n²), so at n = 10⁴ the
    // remainder is 5 × 10⁻⁵ and the next term is under 10⁻⁹.
    expect(harmonic(10_000) - Math.log(10_000) - EULER).toBeCloseTo(1 / 20_000, 8);
  });
});

describe('successProbability', () => {
  it('reproduces the published values', () => {
    expect(successProbability(10, 5)).toBeCloseTo(0.3543651, 7);
    expect(successProbability(100, 50)).toBeCloseTo(0.3118278, 7);
    expect(successProbability(200, 100)).toBeCloseTo(0.3093466, 7);
    expect(successProbability(1000, 500)).toBeCloseTo(0.3073526, 7);
  });

  it('is 1 when every box may be opened, and refuses to answer below half', () => {
    expect(successProbability(100, 100)).toBeCloseTo(1, 12);
    // The derivation needs at most one long cycle, which is exactly what fails
    // under half. A wrong number here would be worse than no number.
    expect(successProbability(100, 49)).toBeNaN();
    expect(successProbability(0, 0)).toBeNaN();
  });

  it('settles on 1 − ln 2', () => {
    // H₂ₘ − Hₘ = ln 2 + 1/(4m) + O(1/m²), so the gap from the limit is about
    // 1/(2n): 5 × 10⁻⁴ at a thousand people and 5 × 10⁻⁶ at a hundred thousand.
    const limit = 1 - Math.log(2);
    expect(Math.abs(successProbability(1_000, 500) - limit)).toBeLessThan(1e-3);
    expect(Math.abs(successProbability(100_000, 50_000) - limit)).toBeLessThan(1e-5);
  });
});

describe('exactSuccessProbability', () => {
  it('agrees with the closed form everywhere the closed form is valid', () => {
    let worst = 0;
    for (let n = 1; n <= 300; n++) {
      for (let k = Math.ceil(n / 2); k <= n; k++) {
        worst = Math.max(worst, Math.abs(exactSuccessProbability(n, k) - successProbability(n, k)));
      }
    }
    // Two different summations of the same rational number in double precision.
    expect(worst).toBeLessThan(1e-12);
  });

  it('runs straight through k = n/2 with no cliff', () => {
    // docs/VISUALIZATIONS.md §16: half is where the tidy formula begins, not
    // where the problem changes.
    expect(exactSuccessProbability(100, 49)).toBeCloseTo(0.2920278, 7);
    expect(exactSuccessProbability(100, 50)).toBeCloseTo(0.3118278, 7);
    expect(exactSuccessProbability(100, 51)).toBeCloseTo(0.3314357, 7);
    for (let k = 40; k < 60; k++) {
      expect(exactSuccessProbability(100, k + 1), `k=${k}`).toBeGreaterThan(exactSuccessProbability(100, k));
    }
  });

  it('is 1/n! at k = 1 and 1 at k = n', () => {
    // Only the identity has every cycle of length one.
    expect(exactSuccessProbability(5, 1)).toBeCloseTo(1 / 120, 15);
    expect(exactSuccessProbability(7, 7)).toBeCloseTo(1, 15);
  });
});

describe('guessingProbability', () => {
  it('is (k/n)ⁿ', () => {
    expect(guessingProbability(100, 50)).toBe(0.5 ** 100);
    expect(guessingProbability(100, 50)).toBeCloseTo(7.888609e-31, 37);
    expect(guessingProbability(6, 3)).toBe(0.5 ** 6);
  });

  it('is hopeless next to the rule, by thirty orders of magnitude', () => {
    expect(P100 / guessingProbability(100, 50)).toBeGreaterThan(1e29);
  });
});

describe('boxesAllowed', () => {
  it('is half, rounded up, so the closed form is valid at every slider position', () => {
    expect(boxesAllowed(100)).toBe(50);
    expect(boxesAllowed(101)).toBe(51);
    expect(boxesAllowed(6)).toBe(3);
    for (let n = 1; n <= MAX_PEOPLE; n++) {
      expect(boxesAllowed(n), `n=${n}`).toBeGreaterThanOrEqual(n / 2);
      expect(Number.isNaN(successProbability(n, boxesAllowed(n))), `n=${n}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// One shuffle
// ---------------------------------------------------------------------------

/** An `Rng` that counts the draws taken from it. */
function countingRng(seed: number): { rng: Rng; draws: () => number } {
  const inner = createRng(seed);
  let taken = 0;
  const rng: Rng = {
    next: () => {
      taken++;
      return inner.next();
    },
    range: (lo, hi) => {
      taken++;
      return inner.range(lo, hi);
    },
    int: (lo, hi) => {
      taken++;
      return inner.int(lo, hi);
    },
    normal: () => {
      taken++;
      return inner.normal();
    },
    bool: (p) => {
      taken++;
      return inner.bool(p);
    },
    reseed: (s) => inner.reseed(s),
  };
  return { rng, draws: () => taken };
}

describe('shuffle', () => {
  it('leaves a permutation of 0…n−1, whatever the slack in the array', () => {
    const rng = createRng(7);
    const perm = new Int32Array(MAX_PEOPLE);
    for (const n of [1, 2, 6, 37, 100, MAX_PEOPLE]) {
      for (let trial = 0; trial < 20; trial++) {
        shuffle(rng, perm, n);
        const seen = new Set<number>();
        for (let i = 0; i < n; i++) seen.add(perm[i]!);
        expect(seen.size, `n=${n}`).toBe(n);
        expect(Math.min(...seen), `n=${n}`).toBe(0);
        expect(Math.max(...seen), `n=${n}`).toBe(n - 1);
      }
    }
  });

  it('takes exactly n − 1 draws, so the ticks cannot change the run', () => {
    for (const n of [1, 2, 6, 100, MAX_PEOPLE]) {
      const { rng, draws } = countingRng(3);
      const perm = new Int32Array(MAX_PEOPLE);
      shuffle(rng, perm, n);
      expect(draws(), `n=${n}`).toBe(Math.max(0, n - 1));
    }
  });

  it('puts the first box in every slot equally often', () => {
    const rng = createRng(11);
    const perm = new Int32Array(4);
    const trials = 24_000;
    const slots = [0, 0, 0, 0];
    for (let t = 0; t < trials; t++) {
      shuffle(rng, perm, 4);
      for (let i = 0; i < 4; i++) if (perm[i] === 0) slots[i]!++;
    }
    // Each slot is Binomial(24000, 1/4): mean 6000, σ = √(24000·¼·¾) = 67.1.
    // Four of those is 268.
    for (const count of slots) expect(Math.abs(count - 6_000)).toBeLessThan(268);
  });

  it('reproduces itself from a seed and differs between seeds', () => {
    const take = (seed: number): number[] => {
      const rng = createRng(seed);
      const perm = new Int32Array(20);
      shuffle(rng, perm, 20);
      return [...perm];
    };
    expect(take(SEED)).toEqual(take(SEED));
    expect(take(1)).not.toEqual(take(2));
  });
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

/** A permutation from a literal, padded with slack the way the viz's arrays are. */
function perm(entries: readonly number[]): Int32Array {
  const out = new Int32Array(MAX_PEOPLE);
  entries.forEach((v, i) => {
    out[i] = v;
  });
  return out;
}

describe('longestCycle and cycleLengths', () => {
  const seen = new Uint8Array(MAX_PEOPLE);
  const out = new Int32Array(MAX_PEOPLE);

  it('reads the cycle type off a permutation written down by hand', () => {
    // Every prisoner opens his own box and finds his own number.
    expect(longestCycle(perm([0, 1, 2, 3, 4]), 5, seen)).toBe(1);
    expect(cycleLengths(perm([0, 1, 2, 3, 4]), 5, seen, out)).toBe(5);
    expect([...out.slice(0, 5)]).toEqual([1, 1, 1, 1, 1]);

    // One chain through every box: the case that loses whatever k is, short of n.
    expect(longestCycle(perm([1, 2, 3, 4, 0]), 5, seen)).toBe(5);
    expect(cycleLengths(perm([1, 2, 3, 4, 0]), 5, seen, out)).toBe(1);
    expect(out[0]).toBe(5);

    // (0 1)(2 3 4).
    expect(longestCycle(perm([1, 0, 3, 4, 2]), 5, seen)).toBe(3);
    expect(cycleLengths(perm([1, 0, 3, 4, 2]), 5, seen, out)).toBe(2);
    expect([...out.slice(0, 2)]).toEqual([3, 2]);
  });

  it('ignores the slack past n, so a smaller run is not haunted by a bigger one', () => {
    const big = perm([1, 2, 3, 4, 0]);
    // The first three entries alone are 0 → 1 → 2 → 3, which is out of range
    // for n = 3; the walk must stay inside [0, 3).
    expect(longestCycle(big, 3, seen)).toBeLessThanOrEqual(3);
    expect(cycleLengths(big, 3, seen, out)).toBeGreaterThanOrEqual(1);
  });

  it('partitions every random permutation, longest first', () => {
    const rng = createRng(5);
    const p = new Int32Array(MAX_PEOPLE);
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + (trial % MAX_PEOPLE);
      shuffle(rng, p, n);
      const count = cycleLengths(p, n, seen, out);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        sum += out[i]!;
        if (i > 0) expect(out[i - 1]!).toBeGreaterThanOrEqual(out[i]!);
      }
      expect(sum, `n=${n}`).toBe(n);
      expect(out[0]).toBe(longestCycle(p, n, seen));
    }
  });
});

// ---------------------------------------------------------------------------
// Convergence — the reason the tab exists
// ---------------------------------------------------------------------------

describe('prisoners convergence', () => {
  /** Longest loop of `rounds` shuffles of `n` boxes, counted against thresholds. */
  function play(seed: number, n: number, rounds: number): Int32Array {
    const rng = createRng(seed);
    const p = new Int32Array(n);
    const seen = new Uint8Array(n);
    const longest = new Int32Array(rounds);
    for (let r = 0; r < rounds; r++) {
      shuffle(rng, p, n);
      longest[r] = longestCycle(p, n, seen);
    }
    return longest;
  }

  const ROUNDS = 50_000;
  const longest = play(SEED, 100, ROUNDS);
  const shareAtMost = (k: number): number => {
    let wins = 0;
    for (let r = 0; r < ROUNDS; r++) if ((longest[r] ?? 0) <= k) wins++;
    return wins / ROUNDS;
  };

  it('frees the room as often as 1 − (Hₙ − H_k) says, at k = 50', () => {
    // A proportion over N = 50,000 has SE = √(p(1−p)/N) = 0.00207 at
    // p = 0.31183, so 0.0083 is 4σ.
    expect(Math.abs(shareAtMost(50) - P100)).toBeLessThan(0.0083);
  });

  it('agrees at a second threshold, so it is the cycle lengths and not one lucky k', () => {
    const p60 = successProbability(100, 60);
    // p = 0.49249 here, SE = √(p(1−p)/N) = 0.002236, so 0.009 is 4σ.
    expect(p60).toBeCloseTo(0.4924929, 7);
    expect(Math.abs(shareAtMost(60) - p60)).toBeLessThan(0.009);
  });

  it('holds at ten prisoners, where the answer is highest', () => {
    const small = play(SEED, 10, ROUNDS);
    let wins = 0;
    for (let r = 0; r < ROUNDS; r++) if ((small[r] ?? 0) <= 5) wins++;
    const p10 = successProbability(10, 5);
    // p = 0.35437, SE = 0.00214, 4σ = 0.0086.
    expect(Math.abs(wins / ROUNDS - p10)).toBeLessThan(0.0086);
  });

  it('reproduces itself from a seed and differs between seeds', () => {
    expect([...play(SEED, 40, 200)]).toEqual([...play(SEED, 40, 200)]);
    expect([...play(1, 40, 200)]).not.toEqual([...play(2, 40, 200)]);
  });
});

// ---------------------------------------------------------------------------
// The counters
// ---------------------------------------------------------------------------

describe('RunTally', () => {
  it('counts wins against the limit and publishes the two shares', () => {
    const tally = new RunTally(10);
    expect(tally.share).toBeNaN();
    tally.record(3, 5, false);
    tally.record(7, 5, false);
    tally.record(5, 5, true);
    expect(tally.rounds).toBe(3);
    expect(tally.wins).toBe(2);
    expect(tally.guessWins).toBe(1);
    expect(tally.share).toBeCloseTo(2 / 3, 12);
    expect(tally.guessShare).toBeCloseTo(1 / 3, 12);
    expect(tally.averageLongest).toBeCloseTo(5, 12);
  });

  it('keeps counting past the history it can hold', () => {
    const tally = new RunTally(4);
    for (let i = 0; i < 10; i++) tally.record(1, 5, false);
    expect(tally.rounds).toBe(10);
    expect(tally.wins).toBe(10);
    let points = 0;
    tally.forEach(100, () => {
      points++;
    });
    // The curve stops at the capacity; the counters do not.
    expect(points).toBe(4);
  });

  it('caps the painted curve while the counters climb', () => {
    const tally = new RunTally(MAX_ROUNDS);
    for (let i = 0; i < MAX_ROUNDS; i++) tally.record(i % 3 === 0 ? 9 : 2, 5, false);
    const rounds: number[] = [];
    tally.forEach(PAINTED_SAMPLES, (round) => rounds.push(round));
    expect(tally.rounds).toBe(MAX_ROUNDS);
    expect(rounds.length).toBeLessThanOrEqual(PAINTED_SAMPLES + 1);
    expect(rounds.length).toBeGreaterThan(PAINTED_SAMPLES / 2);
    // The first and last rounds are always on the curve, and it never doubles back.
    expect(rounds[0]).toBe(1);
    expect(rounds.at(-1)).toBe(MAX_ROUNDS);
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]!).toBeGreaterThan(rounds[i - 1]!);
  });

  it('draws every round when there are few enough to draw', () => {
    const tally = new RunTally(MAX_ROUNDS);
    for (let i = 0; i < 20; i++) tally.record(2, 5, false);
    const rounds: number[] = [];
    tally.forEach(PAINTED_SAMPLES, (round) => rounds.push(round));
    expect(rounds).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('reset clears the counters and the curve', () => {
    const tally = new RunTally(8);
    for (let i = 0; i < 8; i++) tally.record(2, 5, true);
    tally.reset();
    expect(tally.rounds).toBe(0);
    expect(tally.wins).toBe(0);
    expect(tally.guessWins).toBe(0);
    expect(tally.share).toBeNaN();
    let points = 0;
    tally.forEach(10, () => {
      points++;
    });
    expect(points).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layout — pure geometry
// ---------------------------------------------------------------------------

/** The plates the tab is actually rendered on, from `aspect` and `aspectNarrow`. */
const PLATES: ReadonlyArray<readonly [number, number]> = [
  [705, 486],
  [1_280, 883],
  [343, 404],
  [320, 376],
];

describe('layoutPlate', () => {
  it('stacks the loops over the tally with no overlap, on every plate', () => {
    for (let width = 260; width <= 1_400; width += 37) {
      for (let height = 200; height <= 900; height += 41) {
        const { loops, chart } = layoutPlate(width, height);
        expect(loops.y, `${width}×${height}`).toBeGreaterThanOrEqual(0);
        expect(loops.y + loops.height, `${width}×${height}`).toBeLessThanOrEqual(chart.y);
        expect(chart.y + chart.height, `${width}×${height}`).toBeLessThanOrEqual(height);
        expect(loops.x + loops.width).toBeLessThanOrEqual(width);
        expect(loops.height).toBeGreaterThan(chart.height);
      }
    }
  });
});

describe('chart scales', () => {
  const area: Rect = { x: 8, y: 300, width: 689, height: 170 };

  it('maps a share onto the box bottom-up and clamps to it', () => {
    const s = chartScale(area, 300);
    expect(chartY(s, 0)).toBeCloseTo(s.box.y + s.box.height, 12);
    expect(chartY(s, 1)).toBeCloseTo(s.box.y, 12);
    expect(chartY(s, 0.5)).toBeCloseTo(s.box.y + s.box.height / 2, 12);
    // A share is never outside [0, 1], but 0/0 before the first round is not a
    // share at all and must not put a NaN in the path.
    expect(chartY(s, Number.NaN)).toBe(chartY(s, 0));
    expect(chartY(s, 3)).toBe(chartY(s, 1));
  });

  it('holds a curve inside its own frame when asked, so the halo cannot erase the axis', () => {
    const s = chartScale(area, 300);
    expect(chartY(s, 0, 3)).toBeCloseTo(s.box.y + s.box.height - 3, 12);
    expect(chartY(s, 1, 3)).toBeCloseTo(s.box.y + 3, 12);
  });

  it('spans the whole run, so the curve never rescales under the reader', () => {
    const s = chartScale(area, 2_000);
    expect(chartX(s, 0)).toBeCloseTo(s.box.x, 12);
    expect(chartX(s, 2_000)).toBeCloseTo(s.box.x + s.box.width, 12);
    expect(chartX(s, 1_000)).toBeCloseTo(s.box.x + s.box.width / 2, 12);
    // Round 100 sits a twentieth across whether the run has reached 200 or 2,000.
    expect(chartX(chartScale(area, 2_000), 100) - s.box.x).toBeCloseTo(s.box.width / 20, 12);
  });
});

describe('ringRadius and dotRadius', () => {
  it('spaces m boxes one pitch apart around the ring', () => {
    expect(ringRadius(0, 10)).toBe(0);
    expect(ringRadius(1, 10)).toBe(0);
    // Two boxes a pitch apart: the ring is that diameter.
    expect(ringRadius(2, 10)).toBeCloseTo(5, 12);
    // From about five boxes up, the circumference argument takes over.
    expect(ringRadius(60, 10)).toBeCloseTo(600 / (2 * Math.PI), 12);
    for (let m = 3; m <= MAX_PEOPLE; m++) {
      const r = ringRadius(m, 8);
      // Chord between neighbours never crowds below the pitch by more than the
      // arc-versus-chord gap, which is worst at m = 3.
      expect(2 * r * Math.sin(Math.PI / m), `m=${m}`).toBeGreaterThan(0.86 * 8);
    }
  });

  it('never draws a box under the 1.5 px contrast floor, or over the ceiling', () => {
    for (let pitch = 1; pitch <= 40; pitch += 0.5) {
      expect(dotRadius(pitch)).toBeGreaterThanOrEqual(1.5);
      expect(dotRadius(pitch)).toBeLessThanOrEqual(4.5);
    }
  });
});

describe('layoutRings', () => {
  const slots: RingSlots = {
    x: new Float32Array(MAX_PEOPLE),
    y: new Float32Array(MAX_PEOPLE),
    r: new Float32Array(MAX_PEOPLE),
  };

  /** The cycle types the packer has to survive, at the biggest run it offers. */
  function cycleTypes(): ReadonlyArray<readonly [string, Int32Array, number]> {
    const single = new Int32Array(MAX_PEOPLE);
    single[0] = MAX_PEOPLE;

    const fixed = new Int32Array(MAX_PEOPLE).fill(1);

    const rng = createRng(SEED);
    const p = new Int32Array(MAX_PEOPLE);
    const seen = new Uint8Array(MAX_PEOPLE);
    const typical = new Int32Array(MAX_PEOPLE);
    shuffle(rng, p, MAX_PEOPLE);
    const count = cycleLengths(p, MAX_PEOPLE, seen, typical);

    return [
      ['one loop through every box', single, 1],
      ['every box its own loop', fixed, MAX_PEOPLE],
      ['a typical shuffle', typical, count],
    ];
  }

  it('keeps every box inside the loops panel, on every plate the tab is drawn on', () => {
    for (const [width, height] of PLATES) {
      // Exactly the rectangle `draw()` hands it: the panel less the window strip.
      const area = ringArea(layoutPlate(width, height).loops, LABEL_FONT);
      for (const [name, lengths, count] of cycleTypes()) {
        const pitch = layoutRings(lengths, count, area, slots);
        const dot = dotRadius(pitch);
        expect(pitch, `${name} @ ${width}×${height}`).toBeGreaterThanOrEqual(1.5);
        expect(pitch).toBeLessThanOrEqual(26);
        for (let i = 0; i < count; i++) {
          const reach = (slots.r[i] ?? 0) + dot;
          const cx = slots.x[i] ?? 0;
          const cy = slots.y[i] ?? 0;
          const where = `${name} @ ${width}×${height}, ring ${i}`;
          expect(cx - reach, where).toBeGreaterThanOrEqual(area.x - 0.5);
          expect(cx + reach, where).toBeLessThanOrEqual(area.x + area.width + 0.5);
          expect(cy - reach, where).toBeGreaterThanOrEqual(area.y - 0.5);
          expect(cy + reach, where).toBeLessThanOrEqual(area.y + area.height + 0.5);
        }
      }
    }
  });

  it('sizes the rings by their loops, longest first', () => {
    const area = layoutPlate(705, 486).loops;
    const lengths = new Int32Array(MAX_PEOPLE);
    [62, 20, 9, 5, 3, 1].forEach((m, i) => {
      lengths[i] = m;
    });
    layoutRings(lengths, 6, area, slots);
    for (let i = 1; i < 6; i++) expect(slots.r[i - 1]!).toBeGreaterThanOrEqual(slots.r[i]!);
    expect(slots.r[5]).toBe(0);
  });

  it('gives back the same layout for the same input', () => {
    const area = layoutPlate(705, 486).loops;
    const lengths = new Int32Array(MAX_PEOPLE);
    [40, 30, 20, 10].forEach((m, i) => {
      lengths[i] = m;
    });
    const once = { x: new Float32Array(4), y: new Float32Array(4), r: new Float32Array(4) };
    const twice = { x: new Float32Array(4), y: new Float32Array(4), r: new Float32Array(4) };
    expect(layoutRings(lengths, 4, area, once)).toBe(layoutRings(lengths, 4, area, twice));
    expect([...once.x]).toEqual([...twice.x]);
    expect([...once.y]).toEqual([...twice.y]);
  });

  it('stands every loop clear of the readout window, on every plate', () => {
    const lengths = new Int32Array(MAX_PEOPLE);
    // A typical hundred-box shuffle: one long loop and a handful of short ones.
    [62, 20, 9, 5, 3, 1].forEach((m, i) => {
      lengths[i] = m;
    });
    for (const [width, height] of PLATES) {
      const loops = layoutPlate(width, height).loops;
      const area = ringArea(loops, LABEL_FONT);
      // Two 11 px lines, 6 px in from the corner, 3 px of air: 45 px of strip.
      expect(area.y - loops.y).toBe(45);
      const dot = dotRadius(layoutRings(lengths, 6, area, slots));
      for (let i = 0; i < 6; i++) {
        const where = `${width}×${height}, ring ${i}`;
        expect((slots.y[i] ?? 0) - (slots.r[i] ?? 0) - dot, where).toBeGreaterThanOrEqual(area.y);
      }
    }
  });

  it('draws nothing before the first round', () => {
    const area = layoutPlate(705, 486).loops;
    expect(layoutRings(new Int32Array(MAX_PEOPLE), 0, area, slots)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  dashed: boolean;
  segments: readonly Seg[];
}

interface Fill {
  pen: string;
  alpha: number;
  arcs: number;
}

/**
 * A canvas context that records the geometry it is asked for and accepts
 * everything else. `measureText` is proportional to the string, so the display
 * windows are sized the way a real face would size them.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  fills: Fill[];
  calls: string[];
} {
  const strokes: Stroke[] = [];
  const fills: Fill[] = [];
  const calls: string[] = [];
  let segments: Seg[] = [];
  let arcs = 0;
  let x = 0;
  let y = 0;
  let started = false;
  let dash: readonly number[] = [];
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    fillText: () => calls.push('fillText'),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    setLineDash(pattern: readonly number[]): void {
      dash = pattern;
    },
    measureText: (text: string) => ({ width: text.length * 6.6 }),
    beginPath(): void {
      segments = [];
      arcs = 0;
      started = false;
    },
    moveTo(px: number, py: number): void {
      x = px;
      y = py;
      started = true;
    },
    lineTo(px: number, py: number): void {
      if (started) segments.push([x, y, px, py]);
      x = px;
      y = py;
      started = true;
    },
    closePath(): void {
      calls.push('closePath');
    },
    arc(): void {
      arcs++;
    },
    stroke(): void {
      calls.push('stroke');
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        dashed: dash.length > 0,
        segments: [...segments],
      });
    },
    fill(): void {
      calls.push('fill');
      fills.push({ pen: String(api.fillStyle), alpha: api.globalAlpha, arcs });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, fills, calls };
}

/** The pinned canvas contract from theme.css §RULE 0 — the plate is white in both schemes. */
const THEME = {
  canvas: '#ffffff',
  ink: '#171b1d',
  inkMuted: '#4e5750',
  grid: '#23292b',
  gridSoft: '#8a938f',
  data1: '#d53619',
  data2: '#24467a',
  data3: '#7f8985',
  data3Fill: '#d2d6d4',
  accent: '#d53619',
  labelFont: '500 11px "Martian Mono", monospace',
  lineWidth: 1,
  particleRadius: 2,
};

const DEFAULTS: Record<string, ParamValue> = {
  people: 100,
  rounds: 300,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 705, height = 486) {
  const bg = recordingContext();
  const fg = recordingContext();
  const emitted: Readout[][] = [];
  const ctx: VizContext = {
    layers: { background: bg.ctx, foreground: fg.ctx },
    width,
    height,
    rng: createRng(1),
    params: { ...DEFAULTS, ...overrides },
    theme: THEME,
    emit: (readouts) => {
      emitted.push([...readouts]);
    },
    reducedMotion: false,
  };
  const instance = prisoners.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with the paint log cleared first so it holds exactly that frame. */
function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.fg.fills.length = 0;
  v.fg.calls.length = 0;
  v.instance.draw();
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

/** Run until the round target is reached, or fail loudly rather than hang. */
function runOut(v: Viz, target: number): void {
  const rate = roundRateFor(target);
  const ticks = Math.ceil((target / rate) * 120) + 20;
  tick(v, ticks);
  paint(v);
  expect(ledger(v)['rounds']).toBe(target);
}

describe('prisoners instance: readouts', () => {
  it('publishes every number it draws, with the analytic target, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 600);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual([
      'rounds',
      'wins',
      'guessWins',
      'share',
      'guessShare',
      'longest',
      'limit',
      'averageLongest',
      'guessOdds',
      'target',
    ]);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['share']?.target).toBeCloseTo(P100, 12);
    expect(by['limit']?.value).toBe(50);
    expect(by['guessOdds']?.value).toBe(0.5 ** 100);
    expect(by['target']?.value).toBe(300);
    // The longest loop published is the one the plate is showing.
    expect(by['longest']?.value).toBeGreaterThan(0);
    expect(by['longest']?.value).toBeLessThanOrEqual(100);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('marks the share as the one headline and gives every visible number a plain label', () => {
    const v = stubViz();
    tick(v, 200);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const headline = last.filter((r) => r.headline === true);
    expect(headline.map((r) => r.key)).toEqual(['share']);
    expect(headline[0]?.plain).toBe('share of rounds everyone got out');

    const shown = last.filter((r) => r.expertOnly !== true).map((r) => r.key);
    // `guessShare` is on this list because the plate prints it: the key's
    // second row is the guessers' running share, and a number drawn on canvas
    // that no readout carries is invisible to everything but an eye.
    expect(shown).toEqual(['rounds', 'wins', 'guessWins', 'share', 'guessShare', 'longest']);
    for (const r of last) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('never prints a word a sixteen-year-old would have to ask about', () => {
    // The simple view's own ban, plus the words this tab could reach for.
    const BANNED =
      /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov|permutation|cycle)\b/i;
    const v = stubViz();
    tick(v, 400);
    paint(v);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(BANNED);
      expect(r.hint ?? '', r.key).not.toMatch(BANNED);
    }
    // …and the prose the shell prints around them.
    expect(text(prisoners.blurb)).not.toMatch(BANNED);
    for (const preset of prisoners.presets ?? []) expect(text(preset.caption), preset.id).not.toMatch(BANNED);
  });

  it('asks for three standard errors, not the ledger’s one percent', () => {
    const v = stubViz();
    tick(v, 10);
    paint(v);
    const share = (v.emitted.at(-1) ?? []).find((r) => r.key === 'share');
    // Relative SE of a proportion is √((1−p)/(p·R)); at p = 0.31183 over 300
    // rounds that is 0.0797, so the row asks for 0.239.
    expect(share?.tolerance).toBeCloseTo(3 * Math.sqrt((1 - P100) / (P100 * 300)), 12);
    expect(share?.tolerance).toBeGreaterThan(0.2);
  });

  it('draws without mutating the run, and resets to an empty one', () => {
    const v = stubViz();
    tick(v, 500);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['rounds']).toBe(0);
    expect(ledger(v)['wins']).toBe(0);
    expect(ledger(v)['longest']).toBe(0);
    expect(ledger(v)['share']).toBeNaN();
    v.instance.destroy();
  });
});

describe('prisoners instance: the run', () => {
  it('stops at exactly the round target and stays there', () => {
    const v = stubViz({ rounds: 200 });
    runOut(v, 200);
    const done = ledger(v);
    tick(v, 600);
    paint(v);
    expect(ledger(v)).toEqual(done);
  });

  it('lands on the prediction over a full run of two thousand rounds', () => {
    const v = stubViz({ rounds: MAX_ROUNDS });
    runOut(v, MAX_ROUNDS);
    const l = ledger(v);
    // SE of a proportion over 2,000 rounds is √(p(1−p)/2000) = 0.01036, so
    // 0.0415 is 4σ.
    expect(Math.abs(l['share']! - P100)).toBeLessThan(0.0415);
    // A hundred prisoners guessing have never once all been lucky, and will not be.
    expect(l['guessWins']).toBe(0);
  });

  it('is a different puzzle at a different size, and still the predicted one', () => {
    const v = stubViz({ people: 10, rounds: 1_000 });
    runOut(v, 1_000);
    const l = ledger(v);
    expect(l['limit']).toBe(5);
    const p10 = successProbability(10, 5);
    // SE = √(p(1−p)/1000) = 0.01513 at p = 0.35437, so 0.0606 is 4σ.
    expect(Math.abs(l['share']! - p10)).toBeLessThan(0.0606);
    // Ten prisoners guessing win one round in 1,024, so a few do get through.
    expect(l['guessWins']).toBeGreaterThanOrEqual(0);
    expect(l['guessWins']).toBeLessThan(20);
  });

  it('starts over on every knob it has, so a change is a fresh run at the new value', () => {
    const changes: ReadonlyArray<readonly [string, ParamValue]> = [
      ['people', 40],
      ['rounds', 500],
      ['seed', 7],
    ];
    for (const [key, value] of changes) {
      const v = stubViz();
      tick(v, 400);
      paint(v);
      // Exactly what src/main.ts does with a control change the viz refuses.
      v.ctx.params = { ...v.ctx.params, [key]: value };
      expect(v.instance.onParamChange?.(key, value) === true, key).toBe(false);
      v.instance.reset();
      v.instance.drawBackground?.();
      paint(v);
      expect(ledger(v)['rounds'], key).toBe(0);
      tick(v, 400);
      paint(v);

      const fresh = stubViz({ [key]: value });
      tick(fresh, 400);
      paint(fresh);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('ignores a knob it never declared, so the sketch’s extra faders change nothing', () => {
    // #/prisoners?fraction=0.8&strategy=random&speed=4 is the shape the entry
    // in docs/VISUALIZATIONS.md sketched. The router drops keys with no spec
    // before they get here; the instance must not read them either.
    const asked = stubViz({ fraction: 0.8, strategy: 'random', speed: 4 });
    const plain = stubViz();
    for (const v of [asked, plain]) {
      tick(v, 240);
      paint(v);
    }
    expect(ledger(asked)['limit']).toBe(50);
    expect(ledger(asked)).toEqual(ledger(plain));
  });
});

describe('prisoners instance: the plate', () => {
  it('gives the same run on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({}, 1_280, 883);
    const narrow = stubViz({}, 320, 376);
    for (const v of [wide, narrow]) {
      tick(v, 900);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
    expect(ledger(wide)['rounds']).toBeGreaterThan(100);
  });

  it('leaves the counters untouched across a resize', () => {
    const v = stubViz({}, 705, 486);
    tick(v, 900);
    paint(v);
    const before = ledger(v);
    for (const [width, height] of PLATES) {
      v.ctx.width = width;
      v.ctx.height = height;
      v.instance.drawBackground?.();
      paint(v);
      expect(ledger(v), `${width}×${height}`).toEqual(before);
    }
  });

  it('costs the same handful of draw calls at six prisoners and at two hundred', () => {
    const counts = new Set<string>();
    for (const people of [6, 100, MAX_PEOPLE]) {
      for (const rounds of [20, MAX_ROUNDS]) {
        const v = stubViz({ people, rounds });
        tick(v, 900);
        paint(v);
        const strokes = v.fg.calls.filter((c) => c === 'stroke').length;
        const fills = v.fg.calls.filter((c) => c === 'fill').length;
        counts.add(`${strokes}/${fills}`);
      }
    }
    // Every ring is batched into one of two paths per pen, and every curve is
    // one path however many rounds are behind it, so the frame is a fixed
    // number of calls: nothing here scales with the run.
    expect(counts.size).toBe(1);
    expect([...counts][0]).toBe('11/2');
  });

  it('paints every mark at full strength, in a pen from the theme', () => {
    const v = stubViz({ people: 100, rounds: 400 });
    tick(v, 900);
    paint(v);
    const pens = new Set([THEME.data1, THEME.data2, THEME.canvas, THEME.gridSoft]);
    for (const s of v.fg.strokes) {
      // A translucent pen composites through the 4.5:1 the foreground owes the
      // plate: the vermilion is 4.80:1 solid and 1.46:1 at α = 0.25.
      expect(s.alpha).toBe(1);
      expect(pens, s.pen).toContain(s.pen);
      // Nothing on this plate is a hairline in a data pen: §7 puts curves and
      // rings at 2 px, and the only 1 px marks are the window frames.
      if (s.pen === THEME.data1 || s.pen === THEME.data2) expect(s.width).toBe(2 * THEME.lineWidth);
    }
    for (const f of v.fg.fills) {
      expect(f.alpha).toBe(1);
      expect([THEME.data1, THEME.data2]).toContain(f.pen);
    }
  });

  it('draws one dot per box, and the loop that loses the round in the other pen', () => {
    let fatalRounds = 0;
    let cleanRounds = 0;
    // Forty-eight permutations across eight seeds. A round is lost 68.8% of the
    // time, so the chance of drawing all forty-eight the same way — and leaving
    // one of the two branches below unexercised — is under 10⁻⁷.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const v = stubViz({ people: 100, rounds: 400, seed });
      for (let frame = 0; frame < 6; frame++) {
        // Half a second a frame, against a quarter-second hold: a new
        // permutation every time.
        tick(v, 60);
        paint(v);
        const longest = ledger(v)['longest'] ?? 0;
        const where = `seed ${seed}, frame ${frame}`;
        expect(longest, where).toBeGreaterThan(0);
        // Every box is drawn exactly once, whatever the cycle type.
        expect(v.fg.fills.reduce((sum, f) => sum + f.arcs, 0), where).toBe(100);
        const fatalDots = v.fg.fills.find((f) => f.pen === THEME.data2)?.arcs ?? 0;
        if (longest > 50) {
          fatalRounds++;
          // Exactly the boxes in the loop that is too long, and no others: at
          // most one loop can exceed half, which is the theorem being drawn.
          expect(fatalDots, where).toBe(longest);
        } else {
          cleanRounds++;
          expect(fatalDots, where).toBe(0);
        }
      }
    }
    expect(fatalRounds).toBeGreaterThan(0);
    expect(cleanRounds).toBeGreaterThan(0);
    // …and they come in roughly the predicted proportion, over 48 draws.
    expect(cleanRounds / (cleanRounds + fatalRounds)).toBeGreaterThan(0.1);
  });

  it('holds one permutation on the plate while the counters race past it', () => {
    const v = stubViz({ people: 100, rounds: MAX_ROUNDS });
    const shown: number[] = [];
    // Two seconds of simulation at 133 rounds a second, one frame per tick.
    for (let i = 0; i < 240; i++) {
      v.instance.step(TICK);
      paint(v);
      shown.push(ledger(v)['longest'] ?? 0);
    }
    const distinct = new Set(shown).size;
    expect(ledger(v)['rounds']).toBeGreaterThan(250);
    // The picture changes four times a second at most, so two seconds of frames
    // show at most nine permutations — against the 260 the counters got through.
    expect(distinct).toBeLessThanOrEqual(9);
    expect(distinct).toBeGreaterThan(1);
  });

  it('spends at most one vertex every two pixels on the tally, however long the run', () => {
    const v = stubViz({ rounds: MAX_ROUNDS });
    runOut(v, MAX_ROUNDS);
    // The rings and the key's own samples are strokes in the same pen, so the
    // two curves are picked out by where they are and by how long they are:
    // nothing else on the plate is a path of fifty segments inside the tally.
    const chart = layoutPlate(705, 486).chart;
    const curves = v.fg.strokes.filter(
      (s) => s.segments.length > 50 && s.segments.every(([, y0, , y1]) => y0 >= chart.y && y1 >= chart.y),
    );
    // strokeWithHalo strokes each curve twice — the plate colour, then the pen
    // — so a curve is two records with the same path, and the dash tells the
    // two series apart.
    const guessing = curves.filter((s) => s.dashed);
    const chain = curves.filter((s) => !s.dashed);
    expect(guessing.map((s) => s.pen)).toEqual([THEME.canvas, THEME.data1]);
    expect(chain.map((s) => s.pen)).toEqual([THEME.canvas, THEME.data1]);
    for (const s of [...guessing, ...chain]) {
      expect(s.segments.length).toBeLessThanOrEqual(PAINTED_SAMPLES);
      expect(s.segments.length).toBeGreaterThan(PAINTED_SAMPLES / 2);
    }
    // The guessing line never leaves the floor of the box.
    const floor = guessing[0]?.segments[0]?.[1] ?? 0;
    for (const [, y0, , y1] of guessing[0]?.segments ?? []) {
      expect(y0).toBe(floor);
      expect(y1).toBe(floor);
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Prose as the page prints it, for counting sentences. */
function text(prose: Prose): string {
  return typeof prose === 'string' ? prose : prose.map((s) => (typeof s === 'string' ? s : s.v)).join('');
}

/** A full stop followed by a new sentence. A decimal point has no space after it. */
const SECOND_SENTENCE = /[.!?]\s+\S/;

describe('prisoners metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(prisoners.params.map((p) => p.key)).toEqual(['people', 'rounds', 'seed']);
    expect(prisoners.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(prisoners.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
  });

  it('keeps a permanent id, a group and a hard ceiling', () => {
    expect(prisoners.id).toBe('prisoners');
    expect(prisoners.group).toBe('randomness');
    expect(prisoners.budget?.maxEntities).toBe(MAX_ROUNDS);
  });

  it('clamps a permalink that asks for more than the arrays hold', () => {
    expect(peopleCount({ people: 10_000 })).toBe(MAX_PEOPLE);
    expect(peopleCount({ people: 0 })).toBe(6);
    expect(peopleCount({})).toBe(100);
    expect(roundTarget({ rounds: 1e9 })).toBe(MAX_ROUNDS);
    expect(roundTarget({ rounds: -5 })).toBe(20);
  });

  it('paces a run to about a quarter of a minute whatever its length', () => {
    expect(20 / roundRateFor(20)).toBeLessThan(15);
    expect(MAX_ROUNDS / roundRateFor(MAX_ROUNDS)).toBeLessThan(16);
    expect(roundRateFor(MAX_ROUNDS)).toBeGreaterThan(roundRateFor(20));
  });

  it('offers at most three presets, each one plain sentence, each from a declared parameter', () => {
    const presets = prisoners.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.length).toBeLessThanOrEqual(3);
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const key of Object.keys(preset.values)) {
        expect(prisoners.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
    }
    // Ordered to walk to the insight: the surprise at ten, the same surprise at
    // a hundred, then long enough for the share to settle where it was told to.
    expect(presets.map((p) => p.id)).toEqual(['ten', 'a-hundred', 'long-run']);
  });

  it('states at most two facts, one sentence each, and sources both', () => {
    expect(prisoners.facts.length).toBeGreaterThan(0);
    expect(prisoners.facts.length).toBeLessThanOrEqual(2);
    for (const fact of prisoners.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(prisoners.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).toMatch(/^Plays /);
  });
});
