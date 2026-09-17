import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { testable, verdictOf } from '../src/ui/readouts';
import type { ParamValue, Readout, VizContext } from '../src/core/types';
import {
  BINS,
  CDF_EXCESS,
  DOMINANT_EXCESS,
  FAIR_EXCESS,
  FLIP_STEP,
  KS_CRITICAL,
  MAX_FLIPS,
  MAX_GAMES,
  MIN_FLIPS,
  MIN_GAMES,
  RUN_SECONDS,
  TRACES,
  VARIANCE_EXCESS,
  arcsine,
  flipsFor,
  gameRateFor,
  gamesFor,
  layoutPlate,
} from '../src/viz/arcsine/index';
import {
  DOMINANT_P,
  FAIR_HI,
  FAIR_LO,
  FAIR_P,
  LEAD_HIGH,
  LEAD_LOW,
  LEAD_MEAN,
  LEAD_VARIANCE,
  LeadTally,
  TRACE_SAMPLES,
  analyticBarHeight,
  analyticBinProbability,
  arcsineCdf,
  exactLeadPmf,
  leadBin,
  playGame,
} from '../src/viz/arcsine/walk';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** The default run: the parameters the tab opens on. */
const FLIPS = 2_000;
const GAMES = 2_000;

/**
 * Where every tolerance in this file comes from.
 *
 * Two terms, and neither is fitted. The first is the sampling band: a
 * proportion measured over `games` independent games has standard error
 * √(p(1−p)/games), a mean has √(Var/games), and a variance has
 * √((μ₄ − σ⁴)/games) — which for the arcsine law, whose kurtosis is 3/2, is
 * √((3/128 − 1/64)/games) = 0.0884/√games. Three of those is the band a
 * finished run sits inside about 997 times in 1,000, and it is the same three
 * the readouts publish as their own tolerance.
 *
 * The second is the finite-game term. These runs are being compared against the
 * *limit* law, and a game of n flips does not obey the limit exactly: the exact
 * law of Feller III.4 sits above it by 2.97/n in the dominated tails and
 * 1.22/n in the fair-looking band, its variance is (n+2)/(8n) rather than ⅛,
 * and its distribution function is up to 0.0036 away from F at the bars' edges.
 * `exactLeadPmf` is what those four numbers are measured from, and the first
 * describe block below pins each of them against it over the whole range of
 * game lengths the fader offers — so they are properties of the mathematics,
 * checked here, rather than constants chosen to make a run pass.
 *
 * Nothing in this file is flaky: every run is a pure function of its seed, so
 * an assertion that passes once passes forever.
 */
const SIGMAS = 3;

function proportionBand(p: number, games: number, excess: number, flips: number): number {
  return SIGMAS * Math.sqrt((p * (1 - p)) / games) + excess / flips;
}

/** Play `games` games of `flips` flips from `seed` and return the tally. */
function runGames(seed: number, flips: number, games: number): LeadTally {
  const rng = createRng(seed);
  const tally = new LeadTally(BINS);
  for (let g = 0; g < games; g++) tally.push(playGame(rng, flips));
  return tally;
}

/** Σ P(T = 2k/flips) over the atoms of the exact law inside `[lo, hi]`. */
function exactBand(flips: number, lo: number, hi: number): number {
  const m = flips / 2;
  let sum = 0;
  for (let k = 0; k <= m; k++) {
    const t = k / m;
    if (t >= lo && t <= hi) sum += exactLeadPmf(flips, k);
  }
  return sum;
}

/** The exact law's largest distance from F, taken at the bars' interior edges. */
function exactCdfGap(flips: number): number {
  const m = flips / 2;
  let cumulative = 0;
  let worst = 0;
  let edge = 1;
  for (let k = 0; k <= m; k++) {
    while (edge < BINS && k / m >= edge / BINS) {
      worst = Math.max(worst, Math.abs(cumulative - arcsineCdf(edge / BINS)));
      edge++;
    }
    cumulative += exactLeadPmf(flips, k);
  }
  while (edge < BINS) {
    worst = Math.max(worst, Math.abs(cumulative - arcsineCdf(edge / BINS)));
    edge++;
  }
  return worst;
}

/** Game lengths spanning the fader, both ends and a step off each. */
const LENGTHS = [MIN_FLIPS, MIN_FLIPS + FLIP_STEP, 1_000, 2_000, 3_000, 5_000, 7_000, MAX_FLIPS];

// ---------------------------------------------------------------------------
// The law, and the finite-game corrections every tolerance below is built from
// ---------------------------------------------------------------------------

describe('the arcsine law', () => {
  it('pins the four values the catalogue quotes', () => {
    // One side leads at least 90% of the game: 2·F(0.1) = (4/π)·arcsin(√0.1).
    expect(DOMINANT_P).toBeCloseTo(0.409666, 6);
    // The lead comes out between 45% and 55%: F(0.55) − F(0.45).
    expect(arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO)).toBeCloseTo(0.063769, 6);
    expect(LEAD_MEAN).toBe(0.5);
    expect(LEAD_VARIANCE).toBe(0.125);
    // Two literals, not one and its complement: 1 − 0.9 is 0.09999999999999998,
    // and a game that led exactly 40 of 400 flips lands on the double 0.1.
    expect(LEAD_LOW).toBe(0.1);
    expect(LEAD_HIGH).toBe(0.9);
    expect(arcsineCdf(LEAD_LOW)).toBeCloseTo(1 - arcsineCdf(LEAD_HIGH), 15);
  });

  it('has its lowest density at one half, where it equals 2/π', () => {
    // f(½) as the limit of F over a shrinking window, so the density is read
    // off the same function every comparison in the tab is made against.
    const h = 1e-6;
    expect((arcsineCdf(0.5 + h) - arcsineCdf(0.5 - h)) / (2 * h)).toBeCloseTo(2 / Math.PI, 8);
    expect(2 / Math.PI).toBeCloseTo(0.636620, 6);

    // And the minimum really is in the middle: the shortest bar the law
    // predicts is the middle one, and the tallest are the two ends.
    const bars = Array.from({ length: BINS }, (_, j) => analyticBinProbability(j, BINS));
    const middle = bars[(BINS - 1) / 2] ?? NaN;
    expect(Math.min(...bars)).toBe(middle);
    expect(bars[0]).toBe(Math.max(...bars));
    expect(bars[0]).toBeCloseTo(0.140049, 6);
    expect(middle).toBeCloseTo(0.030327, 6);
    // The valley is deep, not a dip: the end bars are over four times it.
    expect((bars[0] ?? 0) / middle).toBeGreaterThan(4);
  });

  it('is a distribution: the exact law sums to one and is symmetric', () => {
    for (const flips of [20, 400, 2_000]) {
      const m = flips / 2;
      let sum = 0;
      for (let k = 0; k <= m; k++) sum += exactLeadPmf(flips, k);
      expect(sum, `flips=${flips}`).toBeCloseTo(1, 9);
      for (let k = 0; k <= m; k++) {
        expect(exactLeadPmf(flips, k)).toBeCloseTo(exactLeadPmf(flips, m - k), 12);
      }
    }
    expect(exactLeadPmf(20, -1)).toBe(0);
    expect(exactLeadPmf(20, 11)).toBe(0);
    expect(exactLeadPmf(20, 1.5)).toBe(0);
  });

  it('reproduces the two exact twenty-flip numbers the catalogue quotes', () => {
    // One side ahead at every moment of the game, either side: 2·P(T = 0).
    expect(2 * exactLeadPmf(20, 0)).toBeCloseTo(0.352394, 6);
    // The two sides splitting the time exactly evenly.
    expect(exactLeadPmf(20, 5)).toBeCloseTo(0.060562, 6);
    // The extremes beat the fair-looking middle by nearly six to one — the
    // claim the fact card makes.
    expect((2 * exactLeadPmf(20, 0)) / exactLeadPmf(20, 5)).toBeGreaterThan(5.8);
  });

  it('never sits further above the limit than the tolerances allow for', () => {
    for (const flips of LENGTHS) {
      const dominant = exactBand(flips, LEAD_HIGH, 1) + exactBand(flips, 0, LEAD_LOW);
      const fair = exactBand(flips, FAIR_LO, FAIR_HI);
      const gap = exactCdfGap(flips);
      // Above the limit, and by less than the term the readouts allow.
      expect(dominant, `dominant at ${flips}`).toBeGreaterThan(DOMINANT_P);
      expect((dominant - DOMINANT_P) * flips, `dominant at ${flips}`).toBeLessThan(DOMINANT_EXCESS);
      expect(fair, `fair at ${flips}`).toBeGreaterThan(arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO));
      expect((fair - (arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO))) * flips, `fair at ${flips}`).toBeLessThan(
        FAIR_EXCESS,
      );
      expect(gap, `cdf gap at ${flips}`).toBeLessThan(CDF_EXCESS);
    }
  });

  it('has mean exactly one half and variance exactly (n+2)/(8n) at every game length', () => {
    for (const flips of [400, 2_000, 10_000]) {
      const m = flips / 2;
      let mean = 0;
      let variance = 0;
      for (let k = 0; k <= m; k++) mean += (k / m) * exactLeadPmf(flips, k);
      for (let k = 0; k <= m; k++) variance += (k / m - 0.5) ** 2 * exactLeadPmf(flips, k);
      expect(mean, `mean at ${flips}`).toBeCloseTo(0.5, 9);
      expect(variance, `variance at ${flips}`).toBeCloseTo((flips + 2) / (8 * flips), 9);
      // Which is ⅛ over by 2/n — the term the variance row allows for.
      expect((variance / LEAD_VARIANCE - 1) * flips).toBeCloseTo(VARIANCE_EXCESS, 6);
    }
  });

  it('never fills in, however long the game gets', () => {
    // The teaching moment as a number, on the exact law rather than on a run.
    // The share of games that come out looking even *falls* as the game
    // lengthens — more flips do not pile the histogram into the middle, they
    // empty it — and it falls onto the limit from above rather than crossing it.
    const fair = [400, 1_000, 4_000, 10_000].map((flips) => exactBand(flips, FAIR_LO, FAIR_HI));
    for (let i = 1; i < fair.length; i++) {
      expect(fair[i] ?? 1, `${i}`).toBeLessThan(fair[i - 1] ?? 0);
    }
    expect(fair[fair.length - 1] ?? 0).toBeGreaterThan(arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO));

    // And at every length the two end bars together are an order of magnitude
    // taller than the middle one. The shape is the same at 400 flips and at
    // 10,000: it never becomes a bell.
    for (const flips of [400, 10_000]) {
      const middleLo = (BINS - 1) / 2 / BINS;
      const middle = exactBand(flips, middleLo, middleLo + 1 / BINS);
      const ends = exactBand(flips, 0, 1 / BINS) + exactBand(flips, 1 - 1 / BINS, 1);
      expect(ends / middle, `flips=${flips}`).toBeGreaterThan(8);
    }
  });

  it('pins the claim the first preset makes', () => {
    // "One side is ahead the whole way in about one game in twelve" — at the
    // 400 flips that chip sets, 2·P(T = 0) is 0.0797, or one in 12.5.
    expect(2 * exactLeadPmf(400, 0)).toBeCloseTo(0.0797, 4);
  });
});

// ---------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------

describe('playGame', () => {
  it('returns an even count of led intervals over the game length', () => {
    const rng = createRng(SEED);
    for (let g = 0; g < 200; g++) {
      const flips = 400;
      const fraction = playGame(rng, flips);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
      // Feller's count is even for an even game, which is what the exact law
      // is stated in and what `leadBin`'s fold assumes.
      const led = Math.round(fraction * flips);
      expect(Math.abs(fraction * flips - led)).toBeLessThan(1e-9);
      expect(led % 2).toBe(0);
    }
  });

  it('is a pure function of the seed, traced or not', () => {
    const a = createRng(SEED);
    const b = createRng(SEED);
    const trace = new Float32Array(TRACE_SAMPLES);
    for (let g = 0; g < 20; g++) {
      // Sampling the running score draws nothing, so a traced game and an
      // untraced one leave the stream in the same place.
      expect(playGame(a, 600)).toBe(playGame(b, 600, trace));
    }
    expect(playGame(createRng(1), 600)).not.toBe(playGame(createRng(2), 600));
  });

  it('samples the running score from zero, in units of the square root of the game', () => {
    const trace = new Float32Array(TRACE_SAMPLES);
    for (const flips of [400, 10_000]) {
      trace.fill(NaN);
      playGame(createRng(SEED), flips, trace);
      expect(trace[0]).toBe(0);
      for (let j = 0; j < TRACE_SAMPLES; j++) {
        expect(Number.isFinite(trace[j] ?? NaN), `sample ${j} of ${flips}`).toBe(true);
        // A fair walk of n steps stays inside 5√n with overwhelming probability,
        // and the fan is drawn on a ±3 frame.
        expect(Math.abs(trace[j] ?? 0)).toBeLessThan(5);
      }
      // Neighbouring samples are n/127 steps apart, so they cannot differ by
      // more than that in score — the trace is a path, not a scatter.
      const reach = (flips / (TRACE_SAMPLES - 1) + 1) / Math.sqrt(flips);
      for (let j = 1; j < TRACE_SAMPLES; j++) {
        expect(Math.abs((trace[j] ?? 0) - (trace[j - 1] ?? 0))).toBeLessThanOrEqual(reach);
      }
    }
  });

  it('writes a whole trace even when the game is shorter than the fan', () => {
    // Not reachable from the fader, which stops at 400, but a permalink is not
    // the fader and a stale sample would draw a game that never happened.
    const trace = new Float32Array(TRACE_SAMPLES).fill(NaN);
    playGame(createRng(SEED), 20, trace);
    expect(Array.from(trace).every(Number.isFinite)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Binning
// ---------------------------------------------------------------------------

describe('leadBin', () => {
  it('is symmetric about one half, so a symmetric law paints a symmetric histogram', () => {
    for (let i = 0; i <= 1_000; i++) {
      const x = i / 1_000;
      expect(leadBin(x, BINS) + leadBin(1 - x, BINS), `x=${x}`).toBe(BINS - 1);
    }
  });

  it('puts the ends in the end bars and a level game in the middle one', () => {
    expect(leadBin(0, BINS)).toBe(0);
    expect(leadBin(1, BINS)).toBe(BINS - 1);
    expect(leadBin(0.5, BINS)).toBe((BINS - 1) / 2);
    // The middle bar straddles ½ rather than starting at it.
    expect(leadBin(0.5 - 1e-9, BINS)).toBe((BINS - 1) / 2);
    expect(leadBin(0.5 + 1e-9, BINS)).toBe((BINS - 1) / 2);
    // Out of range cannot escape the array.
    expect(leadBin(-1, BINS)).toBe(0);
    expect(leadBin(2, BINS)).toBe(BINS - 1);
  });

  it('gives every bar the games inside its own edges', () => {
    for (let j = 0; j < BINS; j++) {
      const lo = j / BINS;
      const hi = (j + 1) / BINS;
      expect(leadBin((lo + hi) / 2, BINS)).toBe(j);
    }
  });
});

describe('the analytic overlay', () => {
  it('passes through the top of every bar the law predicts', () => {
    // The curve is a window average, not the density: at a bar's centre it is
    // that bar's probability exactly, which is what makes it comparable to the
    // measurement drawn under it.
    for (let j = 0; j < BINS; j++) {
      const centre = (j + 0.5) / BINS;
      expect(analyticBarHeight(centre, 1 / BINS)).toBeCloseTo(analyticBinProbability(j, BINS), 12);
    }
  });

  it('stays finite where the density does not', () => {
    // f diverges at both ends; a window of positive width never can.
    expect(analyticBarHeight(0, 1 / BINS)).toBeLessThan(0.2);
    expect(analyticBarHeight(1, 1 / BINS)).toBeLessThan(0.2);
    expect(analyticBarHeight(0, 1 / BINS)).toBeCloseTo(analyticBarHeight(1, 1 / BINS), 12);
  });
});

// ---------------------------------------------------------------------------
// Convergence — measured runs against the closed forms
// ---------------------------------------------------------------------------

describe('arcsine convergence', () => {
  it('reaches all four analytic values at the default run, from three seeds', () => {
    for (const seed of [SEED, 7, 2_024]) {
      const tally = runGames(seed, FLIPS, GAMES);
      const games = tally.games;
      expect(games).toBe(GAMES);

      const dominant = tally.dominant / games;
      const fair = tally.fair / games;
      const gap = tally.cdfGap();
      const where = `seed ${seed}: dominant ${dominant.toFixed(4)}, fair ${fair.toFixed(4)}, mean ${tally.mean.toFixed(
        4,
      )}, variance ${tally.variance.toFixed(5)}, gap ${gap.toFixed(4)}`;

      expect(Math.abs(dominant - DOMINANT_P), where).toBeLessThan(
        proportionBand(DOMINANT_P, games, DOMINANT_EXCESS, FLIPS),
      );
      const fairP = arcsineCdf(FAIR_HI) - arcsineCdf(FAIR_LO);
      expect(Math.abs(fair - fairP), where).toBeLessThan(proportionBand(fairP, games, FAIR_EXCESS, FLIPS));
      expect(Math.abs(tally.mean - LEAD_MEAN), where).toBeLessThan(
        SIGMAS * Math.sqrt(LEAD_VARIANCE / games),
      );
      // A variance over M games has SE √((μ₄ − σ⁴)/M) = 0.0884/√M for a law of
      // kurtosis 3/2, and the exact variance is ⅛ over by 2/n.
      expect(Math.abs(tally.variance - LEAD_VARIANCE), where).toBeLessThan(
        SIGMAS * 0.088388 * Math.sqrt(1 / games) + (LEAD_VARIANCE * VARIANCE_EXCESS) / FLIPS,
      );
      // Kolmogorov's 99th percentile, plus the exact law's own distance from F.
      expect(gap, where).toBeLessThan(1.628 / Math.sqrt(games) + CDF_EXCESS);
    }
  });

  it('is nowhere near a bell at either end of the fader', () => {
    for (const flips of [MIN_FLIPS, MAX_FLIPS]) {
      const tally = runGames(SEED, flips, 2_000);
      const counts = Array.from(tally.counts);
      const middle = counts[(BINS - 1) / 2] ?? 0;
      const ends = (counts[0] ?? 0) + (counts[BINS - 1] ?? 0);
      const lowest = Math.min(...counts);
      const shape = `flips=${flips}: ends ${counts[0]}/${counts[BINS - 1]}, middle ${middle}, lowest ${lowest}`;
      // The two end bars beat every other bar, and the middle bar is the
      // shortest to within the noise a bar of that height carries: a count of c
      // fluctuates by √c, so three of those is the band the middle bar sits in
      // above whichever of its neighbours came out shortest this run.
      for (let j = 1; j < BINS - 1; j++) {
        expect(counts[0] ?? 0, shape).toBeGreaterThan(counts[j] ?? 0);
        expect(counts[BINS - 1] ?? 0, shape).toBeGreaterThan(counts[j] ?? 0);
      }
      expect(middle, shape).toBeLessThanOrEqual(lowest + 3 * Math.sqrt(lowest));
      expect(ends / middle, shape).toBeGreaterThan(4);
    }
  });

  it('gets no closer to the middle as the game lengthens', () => {
    // A hundred times the flips, the same number of games, and the share of
    // games that come out looking even does not rise.
    const short = runGames(SEED, 400, 4_000);
    const long = runGames(SEED, 10_000, 4_000);
    const measured = `short ${short.fair}/4000, long ${long.fair}/4000`;
    expect(long.fair, measured).toBeLessThanOrEqual(short.fair);
    // Both sit on the limit, and the limit is a sixteenth.
    for (const tally of [short, long]) {
      expect(tally.fair / 4_000).toBeGreaterThan(0.03);
      expect(tally.fair / 4_000).toBeLessThan(0.1);
    }
  });

  it('reproduces a run from its seed and separates two seeds', () => {
    const a = runGames(SEED, 600, 400);
    const b = runGames(SEED, 600, 400);
    expect(Array.from(a.counts)).toEqual(Array.from(b.counts));
    expect(a.mean).toBe(b.mean);
    expect(a.dominant).toBe(b.dominant);
    expect(runGames(1, 600, 400).dominant).not.toBe(runGames(2, 600, 400).dominant);
  });
});

describe('LeadTally', () => {
  it('counts the two bands on their stated edges', () => {
    const tally = new LeadTally(BINS);
    for (const fraction of [0, 0.1, 0.9, 1, 0.45, 0.5, 0.55, 0.2, 0.44, 0.56]) tally.push(fraction);
    expect(tally.games).toBe(10);
    // 0, 0.1, 0.9 and 1 are dominated; the band is closed on both edges.
    expect(tally.dominant).toBe(4);
    // 0.45, 0.5 and 0.55 look fair; 0.44 and 0.56 do not.
    expect(tally.fair).toBe(3);
    expect(tally.counts.reduce((sum, c) => sum + c, 0)).toBe(10);
  });

  it('reports nothing before the first game and forgets everything on reset', () => {
    const tally = new LeadTally(BINS);
    expect(tally.games).toBe(0);
    expect(Number.isNaN(tally.mean)).toBe(true);
    expect(Number.isNaN(tally.cdfGap())).toBe(true);

    tally.push(0.5);
    expect(tally.games).toBe(1);
    const counts = tally.counts;
    tally.reset();
    expect(tally.games).toBe(0);
    expect(tally.dominant).toBe(0);
    expect(tally.fair).toBe(0);
    // The same array, zeroed — nothing is reallocated on a reset.
    expect(tally.counts).toBe(counts);
    expect(Array.from(tally.counts).every((c) => c === 0)).toBe(true);
  });

  it('measures the gap against F, not against a bar count', () => {
    // A tally laid out exactly on the law reads a gap of zero at every edge,
    // whatever the bar heights are.
    const tally = new LeadTally(BINS);
    const games = 100_000;
    for (let j = 0; j < BINS; j++) {
      const want = Math.round(analyticBinProbability(j, BINS) * games);
      for (let i = 0; i < want; i++) tally.push((j + 0.5) / BINS);
    }
    expect(tally.cdfGap()).toBeLessThan(1e-4);
  });
});

// ---------------------------------------------------------------------------
// Parameters and layout
// ---------------------------------------------------------------------------

describe('the faders', () => {
  it('snaps a permalink onto the grid the simulation needs', () => {
    // Even, always: Feller's count is even only for an even game.
    expect(flipsFor({ flips: 777 }) % 2).toBe(0);
    expect(flipsFor({ flips: 777 }) % FLIP_STEP).toBe(0);
    expect(flipsFor({ flips: 1e9 })).toBe(MAX_FLIPS);
    expect(flipsFor({ flips: -5 })).toBe(MIN_FLIPS);
    expect(flipsFor({ flips: 'nonsense' as unknown as ParamValue })).toBe(2_000);
    expect(flipsFor({})).toBe(2_000);

    expect(gamesFor({ games: 1e9 })).toBe(MAX_GAMES);
    expect(gamesFor({ games: 0 })).toBe(MIN_GAMES);
    expect(gamesFor({ games: 2_449 })).toBe(2_400);
    expect(gamesFor({})).toBe(2_000);
  });

  it('paces any run to about the same length, inside the frame budget', () => {
    expect(gameRateFor(MAX_GAMES) * RUN_SECONDS).toBe(MAX_GAMES);
    // The peak rate the two faders can ask for, in flips a second. At roughly
    // 50 M flips a second this is 1.4 ms of a 16 ms frame.
    expect((gameRateFor(MAX_GAMES) * MAX_FLIPS) / 60).toBeLessThan(100_000);
  });
});

describe('layoutPlate', () => {
  it('splits the plate into a fan and a histogram that do not overlap', () => {
    for (const [w, h] of [
      [705, 440],
      [343, 343],
      [1_200, 750],
    ] as const) {
      const L = layoutPlate(w, h);
      expect(L.left).toBeLessThan(L.right);
      expect(L.fanTop).toBeLessThan(L.fanBottom);
      expect(L.fanZero).toBeCloseTo((L.fanTop + L.fanBottom) / 2, 9);
      expect(L.fanHalf).toBeCloseTo((L.fanBottom - L.fanTop) / 2, 9);
      expect(L.fanBottom).toBeLessThan(L.histTop);
      expect(L.histTop).toBeLessThan(L.histBase);
      // The axis row is reserved whether or not a numeral has been painted.
      expect(L.histBase).toBeLessThan(h);
      expect(L.binW * BINS).toBeCloseTo(L.right - L.left, 9);
    }
  });

  it('keeps both halves drawable on a plate too short for either', () => {
    const L = layoutPlate(320, 120);
    expect(L.fanBottom - L.fanTop).toBeGreaterThanOrEqual(40);
    expect(L.histBase - L.histTop).toBeGreaterThanOrEqual(60);
    expect(L.fanBottom).toBeLessThan(L.histTop);
  });
});

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

interface Fill {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
}

interface Recorder {
  ctx: CanvasRenderingContext2D;
  fills: Fill[];
  strokes: Array<{ pen: string; width: number; alpha: number; points: number }>;
  texts: Array<{ text: string; style: string }>;
  /** Calls to anything at all, so a test can assert that a phase painted nothing. */
  calls: number;
  /** Calls to measureText: the layout may never be derived from a number's text. */
  measured: number;
}

function recordingContext(): Recorder {
  const fills: Fill[] = [];
  const strokes: Array<{ pen: string; width: number; alpha: number; points: number }> = [];
  const texts: Array<{ text: string; style: string }> = [];
  let points = 0;
  const log = { calls: 0, measured: 0 };
  const api = {
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect(): void {
      log.calls++;
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      log.calls++;
      fills.push({ style: String(api.fillStyle), x, y, w, h, alpha: api.globalAlpha });
    },
    strokeRect(): void {
      log.calls++;
    },
    fillText(text: string): void {
      log.calls++;
      texts.push({ text, style: String(api.fillStyle) });
    },
    measureText(): { width: number } {
      log.calls++;
      log.measured++;
      return { width: 48 };
    },
    save(): void {
      log.calls++;
    },
    restore(): void {
      log.calls++;
    },
    beginPath(): void {
      log.calls++;
      points = 0;
    },
    moveTo(): void {
      log.calls++;
      points++;
    },
    lineTo(): void {
      log.calls++;
      points++;
    },
    arc(): void {
      log.calls++;
      points++;
    },
    fill(): void {
      log.calls++;
    },
    stroke(): void {
      log.calls++;
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        points,
      });
    },
  };
  return {
    ctx: api as unknown as CanvasRenderingContext2D,
    fills,
    strokes,
    texts,
    get calls(): number {
      return log.calls;
    },
    get measured(): number {
      return log.measured;
    },
  } as Recorder;
}

function clearLog(r: Recorder): void {
  r.fills.length = 0;
  r.strokes.length = 0;
  r.texts.length = 0;
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

const DEFAULTS: Record<string, ParamValue> = { flips: FLIPS, games: GAMES, seed: SEED };

function stubViz(overrides: Record<string, ParamValue> = {}, width = 705, height = 440) {
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
  const instance = arcsine.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

function paint(v: Viz): void {
  clearLog(v.bg);
  clearLog(v.fg);
  v.instance.draw();
}

function ledger(v: Viz): Map<string, Readout> {
  const last = v.emitted[v.emitted.length - 1] ?? [];
  return new Map(last.map((r) => [r.key, r]));
}

/** Ticks that finish a run of `games` at the tab's own pace. */
function ticksFor(games: number): number {
  return Math.ceil((games / gameRateFor(games)) * 120) + 2;
}

describe('arcsine instance: the run', () => {
  it('stops at exactly the game count and then does nothing', () => {
    const v = stubViz({ flips: 400, games: 200 });
    tick(v, ticksFor(200));
    paint(v);
    expect(ledger(v).get('games')?.value).toBe(200);

    tick(v, 600);
    paint(v);
    expect(ledger(v).get('games')?.value).toBe(200);
  });

  it('paints nothing while it steps', () => {
    const v = stubViz({ flips: 400, games: 400 });
    const before = v.bg.calls + v.fg.calls;
    tick(v, 120);
    expect(v.bg.calls + v.fg.calls).toBe(before);
  });

  it('changes no reading when it draws', () => {
    const v = stubViz({ flips: 400, games: 400 });
    tick(v, 120);
    paint(v);
    const first = ledger(v);
    paint(v);
    paint(v);
    const third = ledger(v);
    for (const [key, readout] of first) {
      expect(third.get(key)?.value, key).toBe(readout.value);
    }
  });

  it('replays the same run from the same seed and a different one from another', () => {
    const one = stubViz({ flips: 400, games: 400, seed: 3 });
    const two = stubViz({ flips: 400, games: 400, seed: 3 });
    const other = stubViz({ flips: 400, games: 400, seed: 4 });
    for (const v of [one, two, other]) {
      tick(v, ticksFor(400));
      paint(v);
    }
    expect(ledger(one).get('dominated')?.value).toBe(ledger(two).get('dominated')?.value);
    expect(ledger(one).get('gap')?.value).toBe(ledger(two).get('gap')?.value);
    expect(ledger(one).get('dominated')?.value).not.toBe(ledger(other).get('dominated')?.value);
  });

  it('starts over on reset', () => {
    const v = stubViz({ flips: 400, games: 400 });
    tick(v, ticksFor(400));
    paint(v);
    const finished = ledger(v).get('dominated')?.value ?? NaN;
    expect(Number.isFinite(finished)).toBe(true);

    v.instance.reset();
    paint(v);
    expect(ledger(v).get('games')?.value).toBe(0);
    expect(Number.isFinite(ledger(v).get('dominated')?.value ?? NaN)).toBe(false);

    tick(v, ticksFor(400));
    paint(v);
    expect(ledger(v).get('dominated')?.value).toBe(finished);
  });
});

describe('arcsine instance: readouts', () => {
  it('publishes every number on the plate, with its prediction', () => {
    const v = stubViz();
    tick(v, ticksFor(GAMES));
    paint(v);
    const rows = ledger(v);
    expect([...rows.keys()]).toEqual(['games', 'dominated', 'fair', 'average', 'spread', 'gap']);
    expect(rows.get('dominated')?.target).toBeCloseTo(0.409666, 6);
    expect(rows.get('fair')?.target).toBeCloseTo(0.063769, 6);
    expect(rows.get('average')?.target).toBe(0.5);
    expect(rows.get('spread')?.target).toBe(0.125);
    expect(rows.get('gap')?.target).toBe(0);
    expect(rows.get('games')?.value).toBe(GAMES);
  });

  /**
   * The half-width each row declares, from the theory at the top of this file
   * and the games in hand — never from the count the run will finish on.
   *
   * A band read at the final count is a constant for the whole run: the
   * headline's was 8.4 % of its own prediction at the defaults and 26 % near
   * the bottom of the fader, and 26 % of 0.4097 certified a reading of 0.5150.
   * A band a reading cannot fall outside is not a test of it.
   */
  function theoreticalBands(games: number, flips: number): Map<string, number> {
    return new Map([
      ['dominated', proportionBand(DOMINANT_P, games, DOMINANT_EXCESS, flips)],
      ['fair', proportionBand(FAIR_P, games, FAIR_EXCESS, flips)],
      ['average', SIGMAS * Math.sqrt(LEAD_VARIANCE / games)],
      // √(μ₄ − σ⁴) written out rather than as the 0.088388 the convergence
      // block rounds it to: this row asserts the declaration itself, to the
      // last bit, and a rounded literal would be asserting the rounding.
      [
        'spread',
        (SIGMAS * Math.sqrt(3 / 128 - 1 / 64)) / Math.sqrt(games) + (LEAD_VARIANCE * VARIANCE_EXCESS) / flips,
      ],
      ['gap', KS_CRITICAL / Math.sqrt(games) + CDF_EXCESS],
    ]);
  }

  it('declares the band the theory gives, in the reading’s own units', () => {
    const v = stubViz();
    tick(v, ticksFor(GAMES));
    paint(v);
    const rows = ledger(v);
    const expected = theoreticalBands(GAMES, FLIPS);
    // The mean is the one row with no finite-game bias to carry — the exact law
    // has mean exactly ½ at every game length — so it is the one that can state
    // a σ and let the ledger divide. The other three carry a bias, which is not
    // noise and does not fall as 1/√M, so they state a half-width outright.
    expect(rows.get('average')?.band).toEqual({
      kind: 'sampled',
      sigma: Math.sqrt(LEAD_VARIANCE),
      samples: GAMES,
    });
    for (const key of ['dominated', 'fair', 'spread', 'gap']) {
      const band = rows.get(key)?.band;
      expect(band?.kind, key).toBe('absolute');
      expect(band?.kind === 'absolute' ? band.half : NaN, key).toBeCloseTo(expected.get(key) ?? NaN, 12);
    }
    // And no row declares the legacy relative form as well: two bands are a
    // contradiction, and the ledger refuses both rather than picking one.
    for (const row of v.emitted[v.emitted.length - 1] ?? []) {
      expect(row.tolerance, row.key).toBeUndefined();
    }
  });

  it('sits inside all five of those bands at the default run', () => {
    const v = stubViz();
    tick(v, ticksFor(GAMES));
    paint(v);
    const expected = theoreticalBands(GAMES, FLIPS);
    const measured: string[] = [];
    for (const row of v.emitted[v.emitted.length - 1] ?? []) {
      const target = row.target;
      if (target === undefined) continue;
      const half = expected.get(row.key) ?? NaN;
      measured.push(`${row.key} ${row.value.toFixed(5)} vs ${target.toFixed(5)}`);
      expect(Math.abs(row.value - target), `${row.key}: ${row.value} vs ${target}, band ±${half}`).toBeLessThanOrEqual(
        half,
      );
    }
    expect(measured).toHaveLength(5);
  });

  it('declares the range each share is confined to, so no band can be most of it', () => {
    const v = stubViz();
    tick(v, ticksFor(GAMES));
    paint(v);
    const rows = ledger(v);
    // Four shares and a distance between two distribution functions: every one
    // of them lives in [0, 1], and the gap's prediction is exactly zero — no
    // scale of its own at all, so without the range there is nothing for its
    // band to be judged against and the row gets no verdict for ever.
    for (const key of ['dominated', 'fair', 'average', 'gap']) {
      expect(rows.get(key)?.range, key).toEqual([0, 1]);
    }
  });

  it('marks exactly one headline and gives every plain reading plain words', () => {
    const v = stubViz();
    tick(v, 240);
    paint(v);
    const rows = v.emitted[v.emitted.length - 1] ?? [];
    expect(rows.filter((r) => r.headline === true)).toHaveLength(1);
    expect(rows.find((r) => r.headline === true)?.key).toBe('dominated');

    // The words a sixteen-year-old has no use for, banned from everything the
    // simple view can print.
    const banned =
      /\b(mean|variance|analytic|converged|estimator|standard error|bin|residual|tolerance|asymptotic|stationary|ergodic|Markov)\b/i;
    for (const row of rows) {
      if (row.expertOnly === true) continue;
      expect(row.plain, row.key).toBeDefined();
      const plain = row.plain ?? '';
      expect(plain, row.key).toBe(plain.toLowerCase());
      expect(plain, row.key).not.toMatch(banned);
      expect(row.hint ?? '', row.key).not.toMatch(banned);
    }
    // And the internals stay internal.
    expect(rows.filter((r) => r.expertOnly === true).map((r) => r.key)).toEqual(['spread', 'gap']);
  });

  it('reads as nothing measured before the first game', () => {
    const v = stubViz();
    paint(v);
    const rows = ledger(v);
    expect(rows.get('games')?.value).toBe(0);
    for (const key of ['dominated', 'fair', 'average', 'spread', 'gap']) {
      expect(Number.isFinite(rows.get(key)?.value ?? NaN), key).toBe(false);
    }
  });

  it('sharpens every band as the games come in, rather than fixing it at the run’s end', () => {
    // The replaced declaration took its standard errors at the game count the
    // run was going to reach, which is a constant for the whole run: the row
    // opened with the band it would have earned by the end and certified
    // anything that happened to be near the target on the way. Every band here
    // is 1/√M of the games actually tallied, so it can only narrow.
    const v = stubViz({ flips: MAX_FLIPS, games: MAX_GAMES });
    const halfOf = (key: string): number => {
      const band = ledger(v).get(key)?.band;
      if (band === undefined) return NaN;
      if (band.kind === 'absolute') return band.half;
      if (band.kind === 'sampled') return (3 * band.sigma) / Math.sqrt(band.samples);
      return NaN;
    };
    const keys = ['dominated', 'fair', 'average', 'spread', 'gap'];
    tick(v, 600);
    paint(v);
    const early = ledger(v).get('games')?.value ?? 0;
    const first = keys.map(halfOf);
    tick(v, 600);
    paint(v);
    expect(ledger(v).get('games')?.value ?? 0).toBeGreaterThan(early);
    keys.forEach((key, i) => {
      expect(halfOf(key), key).toBeLessThan(first[i] ?? 0);
    });
  });

  it('withholds the headline’s verdict until the run can test it', () => {
    // The defect this replaced, in one line: 26 % of 0.4097 is a band no
    // reading the experiment could produce would fall outside, and the ledger
    // printed "matches" through it. A proportion near 0.41 is settled to a
    // twentieth of itself only from about 5,200 games, so the default run
    // cannot certify the headline and the top of the fader can.
    const defaults = stubViz();
    tick(defaults, ticksFor(GAMES));
    paint(defaults);
    const headline = ledger(defaults).get('dominated');
    expect(headline?.headline).toBe(true);
    expect(testable(headline!)).toBe(false);
    expect(verdictOf(headline!).state).not.toBe('agree');

    const most = stubViz({ flips: MAX_FLIPS, games: MAX_GAMES });
    tick(most, ticksFor(MAX_GAMES));
    paint(most);
    const best = ledger(most).get('dominated');
    expect(ledger(most).get('games')?.value).toBe(MAX_GAMES);
    expect(testable(best!)).toBe(true);
  });

  it('carries the last preset to a game count that can test the headline', () => {
    // The preset list is the guided tour, and its last stop is the one place a
    // reader meets the tab's own claim being checked. A ceiling under the count
    // that claim needs would have left the headline reading "still settling"
    // at every setting there is — as unhelpful as the check mark it replaced.
    const last = (arcsine.presets ?? []).at(-1);
    expect(last?.id).toBe('many-games');
    expect(last?.values['games']).toBe(MAX_GAMES);
    // 3·√(p(1−p)/M) ≤ a twentieth of p needs M ≥ 9(1−p)/(p·0.05²) = 5,184.
    expect(MAX_GAMES).toBeGreaterThan((9 * (1 - DOMINANT_P)) / (DOMINANT_P * 0.05 ** 2));
  });
});

describe('arcsine instance: the plate', () => {
  it('draws the level line in the apparatus pen and the axis in the container pen', () => {
    const v = stubViz();
    const pens = v.bg.strokes.map((s) => s.pen);
    expect(pens).toContain(THEME.grid);
    expect(pens).toContain(THEME.gridSoft);
    // One near-black line only: the level line. Everything else contains the
    // experiment rather than being part of it.
    expect(pens.filter((p) => p === THEME.grid)).toHaveLength(1);
    expect(v.bg.texts.map((t) => t.text)).toEqual([
      '0%',
      '50%',
      '100%',
      'ahead',
      'behind',
      'share of the game one side was ahead',
    ]);
    expect(v.bg.texts.every((t) => t.style === THEME.inkMuted)).toBe(true);
  });

  it('paints the histogram as an opaque wash under a full-opacity silhouette', () => {
    const v = stubViz({ flips: 400, games: 400 });
    tick(v, ticksFor(400));
    paint(v);
    const bars = v.fg.fills.filter((f) => f.style === THEME.data3Fill);
    expect(bars.length).toBeGreaterThan(BINS / 2);
    // Never through globalAlpha: a translucent wash composites to a ghost.
    expect(bars.every((f) => f.alpha === 1)).toBe(true);
    const silhouette = v.fg.strokes.find((s) => s.pen === THEME.data3);
    expect(silhouette?.width).toBe(2 * THEME.lineWidth);
    expect(silhouette?.alpha).toBe(1);
  });

  it('haloes the analytic curve and the traces so no two pens touch', () => {
    const v = stubViz({ flips: 400, games: 400 });
    tick(v, ticksFor(400));
    paint(v);
    const order = v.fg.strokes.map((s) => s.pen);
    // Every data-2 and data-1 stroke is preceded by one in the plate colour on
    // the same path — that is what `strokeWithHalo` lays down.
    for (const pen of [THEME.data2, THEME.data1]) {
      const at = order.indexOf(pen);
      expect(at, pen).toBeGreaterThan(0);
      expect(order[at - 1], pen).toBe(THEME.canvas);
      expect(v.fg.strokes[at]?.points).toBe(v.fg.strokes[at - 1]?.points);
      expect(v.fg.strokes[at]?.alpha).toBe(1);
      expect(v.fg.strokes[at]?.width).toBe(2 * THEME.lineWidth);
    }
  });

  it('paints five traces however many games it counts', () => {
    const v = stubViz({ flips: 400, games: 2_000 });
    tick(v, ticksFor(2_000));
    paint(v);
    expect(ledger(v).get('games')?.value).toBe(2_000);
    const fan = v.fg.strokes.find((s) => s.pen === THEME.data1);
    // One path, one stroke, five traces of TRACE_SAMPLES points.
    expect(fan?.points).toBe(TRACES * TRACE_SAMPLES);
    expect(v.fg.strokes.filter((s) => s.pen === THEME.data1)).toHaveLength(1);
  });

  it('never measures a number to lay anything out', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    expect(v.bg.measured).toBe(0);
    expect(v.fg.measured).toBe(0);
  });

  it('re-lays-out on resize without touching the run', () => {
    const v = stubViz({ flips: 400, games: 2_000 });
    tick(v, 600);
    paint(v);
    const before = ledger(v).get('dominated')?.value ?? NaN;
    const barsBefore = v.fg.fills.filter((f) => f.style === THEME.data3Fill).length;

    v.ctx.width = 343;
    v.ctx.height = 343;
    clearLog(v.bg);
    v.instance.drawBackground?.();
    paint(v);
    expect(ledger(v).get('dominated')?.value).toBe(before);
    expect(v.fg.fills.filter((f) => f.style === THEME.data3Fill)).toHaveLength(barsBefore);
    const widths = v.fg.fills.filter((f) => f.style === THEME.data3Fill).map((f) => f.w);
    expect(Math.max(...widths)).toBeLessThan(343 / BINS + 1);
  });

  it('keeps every bar inside the histogram, whatever the counts do', () => {
    const v = stubViz({ flips: 400, games: 200 });
    tick(v, ticksFor(200));
    paint(v);
    const L = layoutPlate(705, 440);
    for (const bar of v.fg.fills.filter((f) => f.style === THEME.data3Fill)) {
      expect(bar.y).toBeGreaterThanOrEqual(L.histTop - 1e-9);
      expect(bar.y + bar.h).toBeCloseTo(L.histBase, 9);
    }
  });
});

describe('arcsine metadata', () => {
  it('is registered under a permanent id, in the randomness run', () => {
    expect(arcsine.id).toBe('arcsine');
    expect(arcsine.group).toBe('randomness');
    expect(arcsine.title).toBe('The Long Lead');
    expect(arcsine.budget?.maxEntities).toBe(MAX_GAMES);
    expect(arcsine.aspect).toBe(1.6);
    expect(arcsine.aspectNarrow).toBe(1);
  });

  it('offers two faders and a seed, and nothing else', () => {
    const keys = arcsine.params.map((p) => p.key);
    expect(keys).toEqual(['flips', 'games', 'seed']);
    const rendered = arcsine.params.filter((p) => p.kind !== 'seed');
    expect(rendered).toHaveLength(2);
    expect(rendered.every((p) => p.kind === 'range')).toBe(true);
    // The seed is declared so a permalink carries it, not so the rail draws it.
    expect(arcsine.params.filter((p) => p.kind === 'seed')).toHaveLength(1);
  });

  it('walks a newcomer through three presets, in order', () => {
    const presets = arcsine.presets ?? [];
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.id)).toEqual(['short-game', 'long-game', 'many-games']);
    const keys = new Set(arcsine.params.map((p) => p.key));
    for (const preset of presets) {
      expect(Object.keys(preset.values).every((k) => keys.has(k)), preset.id).toBe(true);
      expect(typeof preset.caption === 'string' ? preset.caption : '', preset.id).not.toBe('');
      // Every preset value survives the snap, so a chip lands on itself.
      const values = preset.values;
      expect(flipsFor(values), preset.id).toBe(values['flips']);
      expect(gamesFor(values), preset.id).toBe(values['games']);
    }
    // The flips fader travels far enough between the first two to be the point.
    expect(Number(presets[1]?.values['flips'] ?? 0) / Number(presets[0]?.values['flips'] ?? 1)).toBe(25);
  });

  it('sources every fact', () => {
    expect(arcsine.facts.length).toBeGreaterThanOrEqual(2);
    for (const fact of arcsine.facts) {
      expect(fact.source.label.length).toBeGreaterThan(10);
      expect(typeof fact.text === 'string' ? fact.text : '').not.toBe('');
    }
  });

  it('says what it does in one plain sentence', () => {
    const blurb = typeof arcsine.blurb === 'string' ? arcsine.blurb : '';
    expect(blurb).not.toBe('');
    expect(blurb.split('.').filter((s) => s.trim() !== '')).toHaveLength(1);
    expect(blurb).not.toMatch(/arcsine|distribution|variance|asymptotic/i);
  });
});

