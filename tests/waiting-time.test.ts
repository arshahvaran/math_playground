import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import {
  arrivalRateFor,
  caughtGapStandardError,
  chartScale,
  chartX,
  chartY,
  layoutPlate,
  waitingTime,
} from '../src/viz/waiting-time/index';
import { agrees, testable, verdictOf } from '../src/ui/readouts';
import {
  Crowd,
  MEAN_GAP,
  NAIVE_WAIT,
  Timetable,
  WaitHistory,
  dropPassenger,
  expectedWait,
  experiencedGap,
  gapShape,
  gapStddev,
  sampleGap,
  waitStandardError,
} from '../src/viz/waiting-time/buses';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** The module's own constants, restated so a change to either shows up here. */
const MAX_PASSENGERS = 50_000;
const DEFAULT_PASSENGERS = 20_000;
const PASSENGERS_PER_GAP = 2;
const WINDOW_MINUTES = 900;
const ROWS = 6;
const MINUTES_PER_ROW = 150;

/** Gaps the tab draws for a run of `passengers`, mirroring `gapsFor`. */
function gapsFor(passengers: number): number {
  return Math.ceil(passengers / PASSENGERS_PER_GAP);
}

// ---------------------------------------------------------------------------
// The gap law
// ---------------------------------------------------------------------------

describe('the gap law', () => {
  it('keeps the average gap at ten minutes at every setting of the dial', () => {
    // The tab's one promise: the dial moves the spread and nothing else. A
    // sample mean of G gaps has SE = μ·cv/√G, so at G = 40,000 and the worst
    // cv = 1 that is 0.05 minutes; 0.25 is five of them.
    for (const cv of [0, 0.25, 0.5, 0.75, 1]) {
      const rng = createRng(11);
      const table = new Timetable(40_000);
      table.generate(rng, cv, 40_000);
      expect(Math.abs(table.gapMean - MEAN_GAP), `cv=${cv}`).toBeLessThan(0.25);
      // …and does move the spread, by exactly μ·cv. A sample standard
      // deviation's relative SE is √((κ−1)/4G) with κ = 3 + 6cv², so 0.019 at
      // cv = 1 and G = 40,000; 5% is well over five of those.
      expect(Math.abs(table.gapStddev - gapStddev(cv)), `cv=${cv}`).toBeLessThan(0.05 * MEAN_GAP + 1e-12);
    }
  });

  it('is exactly the mean at cv = 0, and takes no draw to say so', () => {
    const rng = createRng(3);
    const before = rng.next();
    for (let i = 0; i < 100; i++) expect(sampleGap(rng, 0)).toBe(MEAN_GAP);
    // A degenerate timetable consumes nothing, so the stream is where it was.
    const after = createRng(3);
    after.next();
    expect(rng.next()).toBe(after.next());
    expect(before).not.toBe(after.next());
  });

  it('is exponential at cv = 1 — shape one, and the memoryless tail to prove it', () => {
    expect(gapShape(1)).toBe(1);
    expect(gapShape(0.5)).toBe(4);
    expect(gapShape(0)).toBe(Infinity);
    const rng = createRng(5);
    const n = 40_000;
    let over = 0;
    let overTwice = 0;
    for (let i = 0; i < n; i++) {
      const g = sampleGap(rng, 1);
      if (g > MEAN_GAP) over++;
      if (g > 2 * MEAN_GAP) overTwice++;
    }
    // P(X > μ) = e⁻¹ = 0.36788 and P(X > 2μ) = e⁻² = 0.13534 for an
    // exponential. A proportion at n = 40,000 has SE ≤ 0.0025, so 0.01 is 4σ.
    expect(Math.abs(over / n - Math.exp(-1))).toBeLessThan(0.01);
    expect(Math.abs(overTwice / n - Math.exp(-2))).toBeLessThan(0.01);
  });

  it('never returns a negative or zero-length gap', () => {
    const rng = createRng(7);
    let bad = 0;
    for (const cv of [0.05, 0.3, 0.7, 1]) {
      for (let i = 0; i < 20_000; i++) if (!(sampleGap(rng, cv) > 0)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('clamps a dial outside its range instead of producing nonsense', () => {
    const rng = createRng(9);
    expect(sampleGap(rng, -1)).toBe(MEAN_GAP);
    expect(sampleGap(rng, Number.NaN)).toBe(MEAN_GAP);
    // Above the dial's ceiling the sampler is pinned to the exponential.
    expect(gapShape(5)).toBe(1);
    expect(experiencedGap(5)).toBe(2 * MEAN_GAP);
  });
});

describe('the closed forms', () => {
  it('is μ + σ²/μ for the gap and half of it for the wait', () => {
    for (const cv of [0, 0.2, 0.5, 0.9, 1]) {
      const sigma = gapStddev(cv);
      expect(experiencedGap(cv)).toBeCloseTo(MEAN_GAP + (sigma * sigma) / MEAN_GAP, 12);
      expect(expectedWait(cv)).toBeCloseTo(NAIVE_WAIT + (sigma * sigma) / (2 * MEAN_GAP), 12);
    }
  });

  it('collapses onto the naive answer exactly when the timetable is perfect', () => {
    expect(expectedWait(0)).toBe(NAIVE_WAIT);
    expect(experiencedGap(0)).toBe(MEAN_GAP);
    // …and doubles it at the other end, which is the headline of the tab.
    expect(expectedWait(1)).toBe(MEAN_GAP);
    expect(experiencedGap(1)).toBe(2 * MEAN_GAP);
  });

  it('matches the figures researched for docs/VISUALIZATIONS.md entry 17', () => {
    // gamma shape 4 is cv = ½: 10 · (1 + ¼) = 12.5 against the 12.528 measured
    // there from a sample's own moments.
    expect(experiencedGap(0.5)).toBeCloseTo(12.5, 12);
    expect(experiencedGap(1)).toBeCloseTo(19.957, 1);
  });
});

describe('waitStandardError', () => {
  it('is the uniform-within-a-fixed-gap error when the timetable is perfect', () => {
    // Every gap is μ, so the wait is uniform on [0, μ): Var = μ²/12, and the
    // timetable contributes nothing because every timetable is the same one.
    const se = waitStandardError(0, 10_000, 5_000);
    expect(se).toBeCloseTo(Math.sqrt((MEAN_GAP * MEAN_GAP) / 12 / 10_000), 12);
  });

  it('is √(μ²/n + 2μ²/G) at cv = 1, where the wait is itself exponential', () => {
    const mu2 = MEAN_GAP * MEAN_GAP;
    expect(waitStandardError(1, 20_000, 10_000)).toBeCloseTo(Math.sqrt(mu2 / 20_000 + (2 * mu2) / 10_000), 12);
    // The run the tab actually ships: 20,000 passengers over 10,000 gaps.
    expect(waitStandardError(1, DEFAULT_PASSENGERS, gapsFor(DEFAULT_PASSENGERS))).toBeCloseTo(0.1581, 4);
  });

  it('keeps the timetable term when the passengers run to infinity', () => {
    // The measurement converges on this timetable's own answer, not on the
    // law's, and that floor is what the `predicted` readout exists to show.
    const floor = waitStandardError(1, Infinity, 10_000);
    expect(floor).toBeCloseTo(Math.sqrt((2 * MEAN_GAP * MEAN_GAP) / 10_000), 12);
    expect(waitStandardError(1, 10 ** 9, 10_000)).toBeGreaterThan(floor);
  });

  it('is infinite with no passengers or no timetable', () => {
    expect(waitStandardError(1, 0, 1_000)).toBe(Infinity);
    expect(waitStandardError(1, 1_000, 0)).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// The timetable
// ---------------------------------------------------------------------------

describe('Timetable', () => {
  it('lays the buses end to end, first at zero', () => {
    const table = new Timetable(50);
    table.generate(createRng(1), 1, 50);
    expect(table.gaps).toBe(50);
    expect(table.busTime(0)).toBe(0);
    let sum = 0;
    for (let i = 0; i < 50; i++) {
      expect(table.gapLength(i)).toBeGreaterThan(0);
      sum += table.gapLength(i);
      expect(table.busTime(i + 1)).toBeCloseTo(sum, 9);
    }
    expect(table.totalMinutes).toBeCloseTo(sum, 9);
  });

  it('finds the gap a moment falls in, at both edges of every gap', () => {
    const table = new Timetable(200);
    table.generate(createRng(2), 1, 200);
    for (let i = 0; i < 200; i++) {
      const from = table.busTime(i);
      const to = table.busTime(i + 1);
      expect(table.gapAt(from), `start of ${i}`).toBe(i);
      expect(table.gapAt((from + to) / 2), `middle of ${i}`).toBe(i);
      expect(table.gapAt(to - (to - from) * 1e-9), `end of ${i}`).toBe(i);
    }
    // Off both ends: a moment before the first bus or after the last belongs to
    // the first and last gap respectively, never to a slot that does not exist.
    expect(table.gapAt(-5)).toBe(0);
    expect(table.gapAt(table.totalMinutes)).toBe(199);
    expect(table.gapAt(table.totalMinutes * 10)).toBe(199);
  });

  it('reports what its own gaps predict, which is what a measurement converges on', () => {
    const table = new Timetable(20_000);
    table.generate(createRng(4), 1, 20_000);
    // M₂/(2M₁) from the Welford accumulator, against the same thing computed
    // the naive way from the gap lengths the table hands back.
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < 20_000; i++) {
      const g = table.gapLength(i);
      s1 += g;
      s2 += g * g;
    }
    expect(table.predictedWait).toBeCloseTo(s2 / (2 * s1), 6);
    // …and it sits near the law's answer, within the timetable's own error:
    // √(2μ²/G) = 0.1 minutes here, so 0.5 is five of them.
    expect(Math.abs(table.predictedWait - expectedWait(1))).toBeLessThan(0.5);
  });

  it('is exact when every gap is the same', () => {
    const table = new Timetable(100);
    table.generate(createRng(6), 0, 100);
    expect(table.gapMean).toBe(MEAN_GAP);
    expect(table.gapStddev).toBe(0);
    expect(table.predictedWait).toBe(NAIVE_WAIT);
    expect(table.totalMinutes).toBeCloseTo(1_000, 9);
  });

  it('never grows past the array it allocated', () => {
    const table = new Timetable(8);
    table.generate(createRng(8), 1, 10_000);
    expect(table.gaps).toBe(8);
    table.generate(createRng(8), 1, 0);
    expect(table.gaps).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Convergence: the whole point of the tab
// ---------------------------------------------------------------------------

/** One full run of the mathematics, with no canvas anywhere. */
function run(seed: number, cv: number, passengers: number): Crowd {
  const rng = createRng(seed);
  const table = new Timetable(MAX_PASSENGERS / PASSENGERS_PER_GAP);
  table.generate(rng, cv, gapsFor(passengers));
  const crowd = new Crowd(600);
  for (let i = 0; i < passengers; i++) {
    const a = dropPassenger(rng, table);
    crowd.push(a, table.gapLength(a.gap), a.time < WINDOW_MINUTES);
  }
  return crowd;
}

describe('waiting-time convergence', () => {
  it('reaches μ/2 + σ²/(2μ) within 3σ at every setting of the dial', () => {
    // The tolerance is three standard errors from waitStandardError, which is
    // the theory, not a number tuned until green: √(Var(wait)/n + Var(table)/G)
    // with n = 20,000 passengers over G = 10,000 gaps.
    for (const cv of [0, 0.25, 0.5, 0.75, 1]) {
      const crowd = run(SEED, cv, DEFAULT_PASSENGERS);
      const target = expectedWait(cv);
      const bar = 3 * waitStandardError(cv, DEFAULT_PASSENGERS, gapsFor(DEFAULT_PASSENGERS));
      expect(crowd.passengers, `cv=${cv}`).toBe(DEFAULT_PASSENGERS);
      expect(Math.abs(crowd.meanWait - target), `cv=${cv} wait=${crowd.meanWait}`).toBeLessThan(bar);
      // The gap landed in is the same statement doubled, and its own standard
      // error is never worse than twice the wait's.
      expect(Math.abs(crowd.meanGap - experiencedGap(cv)), `cv=${cv}`).toBeLessThan(2 * bar);
    }
  });

  it('is not the naive answer, and the distance is the σ²/(2μ) of the formula', () => {
    const crowd = run(SEED, 1, DEFAULT_PASSENGERS);
    const excess = crowd.meanWait - NAIVE_WAIT;
    const bar = 3 * waitStandardError(1, DEFAULT_PASSENGERS, gapsFor(DEFAULT_PASSENGERS));
    // σ²/(2μ) = μ/2 = 5 minutes at cv = 1: the wait doubles.
    expect(Math.abs(excess - MEAN_GAP / 2)).toBeLessThan(bar);
    // …and the naive answer is more than thirty standard errors away, so this
    // is not a claim the noise could have manufactured.
    expect(Math.abs(crowd.meanWait - NAIVE_WAIT) / bar).toBeGreaterThan(10);
  });

  it('collapses onto the naive answer exactly when the dial reaches zero', () => {
    const crowd = run(SEED, 0, DEFAULT_PASSENGERS);
    // Every gap is exactly ten minutes and the arrival is uniform inside it, so
    // the only error left is μ/√(12n) = 0.0204 minutes; 3σ is 0.061.
    expect(Math.abs(crowd.meanWait - NAIVE_WAIT)).toBeLessThan(
      3 * waitStandardError(0, DEFAULT_PASSENGERS, gapsFor(DEFAULT_PASSENGERS)),
    );
    expect(Math.abs(crowd.meanGap - MEAN_GAP)).toBeLessThan(1e-9);
  });

  it('climbs monotonically with the dial, which is the moment the tab is for', () => {
    const waits = [0, 0.25, 0.5, 0.75, 1].map((cv) => run(SEED, cv, DEFAULT_PASSENGERS).meanWait);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i] ?? 0, `step ${i}`).toBeGreaterThan(waits[i - 1] ?? 0);
    }
    expect(waits[0]).toBeCloseTo(NAIVE_WAIT, 1);
    expect(waits[waits.length - 1]).toBeCloseTo(MEAN_GAP, 0);
  });

  it('sharpens as the passenger count rises, at the rate the theory says', () => {
    const errors = [1_000, 10_000, 50_000].map((n) => ({
      n,
      error: Math.abs(run(SEED, 1, n).meanWait - expectedWait(1)),
      bar: 3 * waitStandardError(1, n, gapsFor(n)),
    }));
    for (const { n, error, bar } of errors) expect(error, `n=${n}`).toBeLessThan(bar);
  });

  it('reproduces the same run from the same seed and differs between seeds', () => {
    const a = run(SEED, 1, 5_000);
    const b = run(SEED, 1, 5_000);
    expect(a.meanWait).toBe(b.meanWait);
    expect(a.meanGap).toBe(b.meanGap);
    expect(a.count).toBe(b.count);
    expect(run(1, 1, 5_000).meanWait).not.toBe(run(2, 1, 5_000).meanWait);
  });

  it('paints about two dots a gap whatever the passenger count', () => {
    // The painted window is a fixed 900 minutes and the timetable holds one gap
    // per two passengers, so the dots that land on screen number
    // 2 · 900 / 10 = 180 at every setting of the fader. The count is binomial
    // with SE ≈ 13, so 60 either side is over four of them.
    for (const n of [1_000, 5_000, 20_000, 50_000]) {
      const painted = run(SEED, 1, n).count;
      expect(painted, `n=${n}`).toBeGreaterThan(120);
      expect(painted, `n=${n}`).toBeLessThan(240);
    }
  });
});

describe('dropPassenger', () => {
  it('takes two draws in a fixed order and lands inside the gap it names', () => {
    const rng = createRng(13);
    const table = new Timetable(500);
    table.generate(createRng(13), 1, 500);
    let outside = 0;
    for (let i = 0; i < 5_000; i++) {
      const a = dropPassenger(rng, table);
      if (a.time < 0 || a.time >= table.totalMinutes) outside++;
      if (a.lane < 0 || a.lane >= 1) outside++;
      if (a.time < table.busTime(a.gap) || a.time >= table.busTime(a.gap + 1)) outside++;
      if (Math.abs(a.wait - (table.busTime(a.gap + 1) - a.time)) > 1e-9) outside++;
      if (a.wait < 0 || a.wait > table.gapLength(a.gap)) outside++;
    }
    expect(outside).toBe(0);
  });

  it('lands in a gap in proportion to that gap’s length, which is the whole paradox', () => {
    const table = new Timetable(10_000);
    table.generate(createRng(21), 1, 10_000);

    // Gaps longer than three times the average: a twentieth of the buses —
    // e⁻³ = 4.98% of an exponential timetable — but a fifth of its minutes.
    const long = 3 * MEAN_GAP;
    let longGaps = 0;
    let longMinutes = 0;
    for (let k = 0; k < table.gaps; k++) {
      const g = table.gapLength(k);
      if (g > long) {
        longGaps++;
        longMinutes += g;
      }
    }
    const busShare = longGaps / table.gaps;
    const minuteShare = longMinutes / table.totalMinutes;
    // A proportion at G = 10,000 has SE ≤ 0.0022, so 0.01 is over 4σ.
    expect(Math.abs(busShare - Math.exp(-3))).toBeLessThan(0.01);
    // ∫₃^∞ x·e⁻ˣ dx = 4e⁻³ = 0.19915: four times the share of the buses. The
    // share of minutes is a much noisier reading than the share of buses,
    // because x·1{x>3μ} has variance 0.806μ² against the indicator's 0.047:
    // SE = √(0.806/10,000) = 0.009, so 0.03 is over 3σ.
    expect(Math.abs(minuteShare - 4 * Math.exp(-3))).toBeLessThan(0.03);

    const draws = createRng(22);
    const trials = 40_000;
    let inLong = 0;
    for (let k = 0; k < trials; k++) {
      const a = dropPassenger(draws, table);
      if (table.gapLength(a.gap) > long) inLong++;
    }
    // The arrivals follow the minutes, not the buses: a proportion at 40,000
    // has SE ≤ 0.0025, so 0.01 is 4σ from `minuteShare` — and four times as
    // far from `busShare`, which is the answer anybody would have guessed.
    expect(Math.abs(inLong / trials - minuteShare)).toBeLessThan(0.01);
    expect(Math.abs(inLong / trials - busShare)).toBeGreaterThan(0.1);
  });
});

describe('Crowd', () => {
  const arrival = (time: number, wait: number) => ({ time, gap: 0, wait, lane: 0.5 });

  it('counts everybody and paints only who it was told to', () => {
    const crowd = new Crowd(4);
    for (let i = 0; i < 10; i++) crowd.push(arrival(i, i), 2 * i, i < 3);
    expect(crowd.passengers).toBe(10);
    expect(crowd.count).toBe(3);
    expect(crowd.meanWait).toBeCloseTo(4.5, 12);
    expect(crowd.meanGap).toBeCloseTo(9, 12);
  });

  it('drops the earliest painted arrivals rather than growing past its budget', () => {
    const crowd = new Crowd(3);
    for (let i = 0; i < 7; i++) crowd.push(arrival(i, 1), 1, true);
    expect(crowd.count).toBe(3);
    const seen: number[] = [];
    crowd.forEach((t) => seen.push(t));
    expect(seen).toEqual([4, 5, 6]);
    expect(crowd.passengers).toBe(7);
  });

  it('reset clears the crowd and the statistics, and keeps the arrays', () => {
    const crowd = new Crowd(4);
    for (let i = 0; i < 9; i++) crowd.push(arrival(i, i), i, true);
    crowd.reset();
    expect(crowd.count).toBe(0);
    expect(crowd.passengers).toBe(0);
    expect(crowd.meanWait).toBeNaN();
    crowd.push(arrival(1, 2), 3, true);
    expect(crowd.count).toBe(1);
    expect(crowd.meanWait).toBe(2);
  });
});

describe('WaitHistory', () => {
  it('records every one of the first twenty arrivals and then thins out', () => {
    const history = new WaitHistory();
    for (let n = 1; n <= 20; n++) history.sample(n, n);
    expect(history.count).toBe(20);
    for (let n = 21; n <= MAX_PASSENGERS; n++) history.sample(n, 10);
    // The twenty at the head, then log₁₀(50,000/21) = 3.38 decades at 48
    // samples each: 182 by the arithmetic and 174 measured, the difference
    // being the gate rounding up. The longest run the fader allows therefore
    // never wraps the ring, which is the guarantee the capacity is for.
    expect(history.capacity).toBe(288);
    expect(history.count).toBeGreaterThan(150);
    expect(history.count).toBeLessThan(history.capacity);
    const ns: number[] = [];
    history.forEach((n) => ns.push(n));
    for (let i = 1; i < ns.length; i++) expect(ns[i] ?? 0).toBeGreaterThan(ns[i - 1] ?? 0);
  });

  it('reset empties it and restarts the gate', () => {
    const history = new WaitHistory(8);
    for (let n = 1; n <= 100; n++) history.sample(n, 5);
    history.reset();
    expect(history.count).toBe(0);
    history.sample(1, 7);
    expect(history.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layout — pure, and the part of the painter a test can reach
// ---------------------------------------------------------------------------

describe('layoutPlate', () => {
  it('always gives six rows, because the window is six rows of timetable', () => {
    for (const [w, h] of [[705, 440], [1_280, 800], [343, 381], [320, 200]] as const) {
      const { rows, chart } = layoutPlate(w, h);
      expect(rows, `${w}×${h}`).toHaveLength(ROWS);
      for (const row of rows) {
        expect(row.height, `${w}×${h}`).toBeGreaterThan(0);
        expect(row.x, `${w}×${h}`).toBeGreaterThanOrEqual(0);
        expect(row.x + row.width, `${w}×${h}`).toBeLessThanOrEqual(w);
      }
      expect(chart.height, `${w}×${h}`).toBeGreaterThan(0);
      expect(chart.y + chart.height, `${w}×${h}`).toBeLessThanOrEqual(h + 1e-9);
    }
  });

  it('never overlaps a band with the next one, or the last band with the chart', () => {
    for (let h = 200; h <= 900; h += 7) {
      const { rows, chart } = layoutPlate(700, h);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const row = rows[i];
        expect((prev?.y ?? 0) + (prev?.height ?? 0), `h=${h} row ${i}`).toBeLessThanOrEqual(row?.y ?? 0);
      }
      const last = rows[rows.length - 1];
      expect((last?.y ?? 0) + (last?.height ?? 0), `h=${h}`).toBeLessThanOrEqual(chart.y);
    }
  });
});

describe('chart scales', () => {
  const area = { x: 8, y: 300, width: 690, height: 180 };

  it('puts one passenger at the left edge and the target at the right', () => {
    const s = chartScale(area, DEFAULT_PASSENGERS);
    expect(chartX(s, 1)).toBeCloseTo(s.box.x, 9);
    expect(chartX(s, DEFAULT_PASSENGERS)).toBeCloseTo(s.box.x + s.box.width, 9);
    // Decades are equally spaced, which is what makes the settling readable.
    const d1 = chartX(s, 100) - chartX(s, 10);
    const d2 = chartX(s, 1_000) - chartX(s, 100);
    expect(d2).toBeCloseTo(d1, 9);
  });

  it('puts zero minutes on the floor and twenty on the ceiling, and clamps outside', () => {
    const s = chartScale(area, DEFAULT_PASSENGERS);
    expect(chartY(s, 0)).toBeCloseTo(s.box.y + s.box.height, 9);
    expect(chartY(s, 20)).toBeCloseTo(s.box.y, 9);
    expect(chartY(s, 10)).toBeCloseTo(s.box.y + s.box.height / 2, 9);
    // A first passenger who waited an hour, and a reading that does not exist
    // yet, both land on the frame rather than off the plate.
    expect(chartY(s, 60)).toBe(s.box.y);
    expect(chartY(s, Number.NaN)).toBe(s.box.y + s.box.height);
    // The halo pad holds a curve inside its own frame.
    expect(chartY(s, 0, 3)).toBeCloseTo(s.box.y + s.box.height - 3, 9);
  });

  it('never returns a box outside the area it was given', () => {
    for (const w of [80, 200, 690]) {
      for (const h of [40, 120, 300]) {
        const s = chartScale({ x: 8, y: 300, width: w, height: h }, 1_000);
        expect(s.box.width).toBeGreaterThan(0);
        expect(s.box.height).toBeGreaterThan(0);
      }
    }
  });
});

describe('arrivalRateFor', () => {
  it('finishes any run in about twenty seconds, inside the clamps', () => {
    expect(arrivalRateFor(20_000)).toBe(1_000);
    expect(arrivalRateFor(50_000)).toBe(2_500);
    expect(arrivalRateFor(500)).toBe(25);
    // A permalink can carry a count under the fader's floor; the rate does not
    // go with it, or a one-passenger run would never start.
    expect(arrivalRateFor(1)).toBe(25);
    expect(arrivalRateFor(10 ** 9)).toBe(2_500);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];

/** A Path2D that keeps its segments; vitest runs in node, which has none. */
class RecordingPath {
  readonly segments: Seg[] = [];
  private x = 0;
  private y = 0;
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
  lineTo(x: number, y: number): void {
    this.segments.push([this.x, this.y, x, y]);
    this.x = x;
    this.y = y;
  }
}

(globalThis as { Path2D?: unknown }).Path2D ??= RecordingPath;

interface Stroke {
  pen: string;
  width: number;
  alpha: number;
  segments: readonly Seg[];
}

interface Arc {
  x: number;
  y: number;
  r: number;
  fill: string;
}

interface Box {
  kind: 'fill' | 'stroke';
  x: number;
  y: number;
  width: number;
  height: number;
  style: string;
}

/** A canvas context that records the marks it is asked for and accepts the rest. */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: Stroke[];
  arcs: Arc[];
  boxes: Box[];
  texts: string[];
} {
  const strokes: Stroke[] = [];
  const arcs: Arc[] = [];
  const boxes: Box[] = [];
  const texts: string[] = [];
  let path = new RecordingPath();
  let pending: Arc[] = [];
  const api = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (t: string) => ({ width: 6.6 * t.length }),
    fillText(t: string): void {
      texts.push(t);
    },
    fillRect(x: number, y: number, width: number, height: number): void {
      boxes.push({ kind: 'fill', x, y, width, height, style: String(api.fillStyle) });
    },
    strokeRect(x: number, y: number, width: number, height: number): void {
      boxes.push({ kind: 'stroke', x, y, width, height, style: String(api.strokeStyle) });
    },
    beginPath(): void {
      path = new RecordingPath();
      pending = [];
    },
    moveTo(x: number, y: number): void {
      path.moveTo(x, y);
    },
    lineTo(x: number, y: number): void {
      path.lineTo(x, y);
    },
    arc(x: number, y: number, r: number): void {
      pending.push({ x, y, r, fill: '' });
    },
    fill(): void {
      for (const a of pending) arcs.push({ ...a, fill: String(api.fillStyle) });
      pending = [];
    },
    stroke(p?: RecordingPath): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        segments: [...(p ?? path).segments],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, arcs, boxes, texts };
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
  spread: 100,
  passengers: DEFAULT_PASSENGERS,
  seed: SEED,
};

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
  const instance = waitingTime.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with the mark log cleared first so it holds exactly that frame. */
function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.fg.arcs.length = 0;
  v.fg.boxes.length = 0;
  v.fg.texts.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.strokes.length = 0;
    v.bg.boxes.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

/** Exactly what src/main.ts does on a resize. */
function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.bg.boxes.length = 0;
  v.bg.texts.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

describe('waiting-time instance: readouts', () => {
  it('publishes every number it draws, with the closed forms, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 600);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual([
      'passengers',
      'wait',
      'naive',
      'experienced',
      'gapAverage',
      'gapSpread',
      'predicted',
      'busiest',
    ]);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    // 1,000 passengers a second against the 120 Hz tick: 600 ticks is five
    // seconds of run, so 5,000 of the twenty thousand.
    expect(by['passengers']?.value).toBe(5_000);
    expect(by['wait']?.target).toBe(MEAN_GAP);
    expect(by['experienced']?.target).toBe(2 * MEAN_GAP);
    expect(by['gapAverage']?.target).toBe(MEAN_GAP);
    expect(by['gapSpread']?.target).toBe(MEAN_GAP);
    expect(by['naive']?.value).toBe(NAIVE_WAIT);
    // 5,000 passengers over 10,000 gaps: SE = 0.1732, so 4σ is 0.70.
    expect(Math.abs((by['wait']?.value ?? 0) - MEAN_GAP)).toBeLessThan(0.7);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('marks the wait as the one headline and keeps the plain sentence to three numbers', () => {
    const v = stubViz();
    tick(v, 120);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const headline = last.filter((r) => r.headline === true);
    expect(headline.map((r) => r.key)).toEqual(['wait']);
    expect(headline[0]?.plain).toBe('average wait');
    const shown = last.filter((r) => r.expertOnly !== true).map((r) => r.key);
    expect(shown).toEqual(['passengers', 'wait', 'naive']);
    for (const r of last) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('says nothing a sixteen-year-old has to look up', () => {
    // The vocabulary bar for this group, enforced rather than reviewed: the
    // plain view and its hints are the only text a newcomer reads, and every
    // one of these words sends them somewhere else.
    const banned = [
      'mean',
      'variance',
      'analytic',
      'converged',
      'estimator',
      'standard error',
      'residual',
      'tolerance',
      'asymptotic',
      'stationary',
      'ergodic',
      'order parameter',
      'critical exponent',
      'markov',
    ];
    const v = stubViz();
    tick(v, 120);
    paint(v);
    const strings = [
      ...(v.emitted.at(-1) ?? []).flatMap((r) => [r.plain ?? '', r.hint ?? '']),
      text(waitingTime.blurb),
      ...(waitingTime.presets ?? []).map((p) => text(p.caption)),
    ];
    for (const s of strings) {
      for (const word of banned) {
        expect(s.toLowerCase().includes(word), `"${word}" in "${s}"`).toBe(false);
      }
    }
  });

  it('draws without mutating the simulation, and resets to an empty stop', () => {
    const v = stubViz();
    tick(v, 240);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['passengers']).toBe(0);
    expect(ledger(v)['wait']).toBeNaN();
    v.instance.destroy();
  });

  /** The half-width a row declares, by the arithmetic the ledger does. */
  function halfOf(row: Readout | undefined): number {
    const band = row?.band;
    if (band === undefined) return NaN;
    if (band.kind === 'absolute') return band.half;
    if (band.kind === 'sampled') return (3 * band.sigma) / Math.sqrt(band.samples);
    return NaN;
  }

  it('derives every band from the theory at the counts in hand, not from the reading', () => {
    const v = stubViz();
    tick(v, 120);
    paint(v);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    const gaps = gapsFor(DEFAULT_PASSENGERS);
    const passengers = by['passengers']?.value ?? 0;
    // Part way through the run: the passengers are still arriving, and the
    // whole defect was a band that had already been given credit for all of
    // them.
    expect(passengers).toBeGreaterThan(0);
    expect(passengers).toBeLessThan(DEFAULT_PASSENGERS);
    expect(by['wait']?.band).toEqual({
      kind: 'absolute',
      half: 3 * waitStandardError(1, passengers, gaps),
    });
    // The timetable is drawn in one pass at reset, so its three rows have every
    // gap they will ever have on the first frame - a measurement that was
    // finished before the clock started, not a band that failed to shrink.
    expect(halfOf(by['predicted'])).toBeCloseTo(3 * waitStandardError(1, Infinity, gaps), 12);
    expect(by['gapAverage']?.band).toEqual({ kind: 'sampled', sigma: gapStddev(1), samples: gaps });
    expect(halfOf(by['gapSpread'])).toBeCloseTo(3 * gapStddev(1) * Math.sqrt(8 / (4 * gaps)), 12);
    // The gap a passenger lands in is not the wait doubled as far as noise
    // goes: a wait is a uniform point inside the gap it caught, so the two
    // differ in the passenger term. Borrowing the wait's relative band
    // overstated this one by SQRT(2) on that term - the direction that buys
    // verdicts nobody measured.
    expect(halfOf(by['experienced'])).toBeCloseTo(
      3 * caughtGapStandardError(1, passengers, gaps),
      12,
    );
    expect(halfOf(by['experienced'])).toBeLessThan(2 * halfOf(by['wait']));
    for (const r of v.emitted.at(-1) ?? []) expect(r.tolerance, r.key).toBeUndefined();
  });

  it('refuses the headline at the fewest passengers the fader offers, and gives it at the most', () => {
    // The finding: at the left stop the band was three standard errors at the
    // count the run would *finish* on, 30% of a ten-minute wait, and the hero
    // printed "11.76 min matches the prediction of 10 min". At cv = 1 a run
    // needs about 18,000 passengers before three standard errors are a
    // twentieth of that wait.
    const few = stubViz({ passengers: 500 });
    tick(few, 2_400);
    paint(few);
    const short = few.emitted.at(-1)?.find((r) => r.key === 'wait');
    expect(ledger(few)['passengers']).toBe(500);
    expect(testable(short!)).toBe(false);
    // Not a claim about this seed: no reading at all can be certified through a
    // band that wide, including one that is exactly right.
    expect(agrees({ ...short!, value: expectedWait(1) })).toBe(false);

    const many = stubViz({ passengers: DEFAULT_PASSENGERS });
    tick(many, Math.ceil((DEFAULT_PASSENGERS / arrivalRateFor(DEFAULT_PASSENGERS)) * 120) + 4);
    paint(many);
    const long = many.emitted.at(-1)?.find((r) => r.key === 'wait');
    expect(ledger(many)['passengers']).toBe(DEFAULT_PASSENGERS);
    expect(testable(long!)).toBe(true);
    expect(verdictOf(long!).state).toBe('agree');
  });

  it('calls a perfect timetable exact rather than settling', () => {
    // At cv = 0 every gap is exactly ten minutes, so the spread really is zero,
    // the average gap really is ten and what the timetable predicts really is
    // five. A relative band on a target of zero says nothing at all, and a bare
    // tolerance of zero could not be told from no tolerance at all - which is
    // how this row came to be judged against a 1% bar it never asked for.
    const v = stubViz({ spread: 0 });
    tick(v, 240);
    paint(v);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    for (const key of ['gapAverage', 'gapSpread', 'predicted']) {
      expect(halfOf(by[key]), key).toBe(0);
      expect(by[key]?.value, key).toBe(by[key]?.target);
      expect(verdictOf(by[key]!).state, key).toBe('agree');
    }
  });
});

describe('waiting-time instance: the run', () => {
  it('stops at exactly the count the fader asked for and stays there', () => {
    const v = stubViz({ passengers: 500 });
    // 500 passengers run at the 25/s floor: 20 seconds, 2,400 ticks.
    tick(v, 2_399);
    paint(v);
    expect(ledger(v)['passengers']).toBe(499);
    tick(v, 1);
    paint(v);
    expect(ledger(v)['passengers']).toBe(500);
    const done = ledger(v);
    tick(v, 2_000);
    paint(v);
    expect(ledger(v)).toEqual(done);
  });

  it('resets on every knob it has, so a change is a fresh experiment', () => {
    const changes: ReadonlyArray<readonly [string, ParamValue]> = [
      ['spread', 0],
      ['passengers', 5_000],
      ['seed', 7],
    ];
    for (const [key, value] of changes) {
      const v = stubViz();
      tick(v, 240);
      paint(v);
      expect(setParam(v, key, value), key).toBe(false);
      expect(ledger(v)['passengers'], key).toBe(0);
      tick(v, 240);
      paint(v);

      const fresh = stubViz({ [key]: value });
      tick(fresh, 240);
      paint(fresh);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('shows the excess vanish when the dial reaches zero, on the plate and in the ledger', () => {
    const regular = stubViz({ spread: 0 });
    tick(regular, 2_400);
    paint(regular);
    const l = ledger(regular);
    expect(l['gapSpread']).toBe(0);
    expect(l['predicted']).toBe(NAIVE_WAIT);
    expect(Math.abs((l['wait'] ?? 0) - NAIVE_WAIT)).toBeLessThan(0.1);
    // …and the two reference lines land on the same pixel row, which is how the
    // plate says it: the prediction and the on-time guess are one line.
    const lines = regular.fg.strokes.filter((s) => s.pen === THEME.data2 && s.segments.length === 1);
    const ys = new Set(lines.map((s) => Math.round((s.segments[0] ?? [0, 0, 0, 0])[1])));
    expect(ys.size).toBe(1);
  });

  it('separates the two lines by exactly the excess at the top of the dial', () => {
    const v = stubViz();
    tick(v, 120);
    paint(v);
    const scale = chartScale(layoutPlate(705, 440).chart, DEFAULT_PASSENGERS);
    const ys = v.fg.strokes
      .filter((s) => s.pen === THEME.data2 && s.segments.length === 1)
      .map((s) => (s.segments[0] ?? [0, 0, 0, 0])[1]);
    expect(new Set(ys).size).toBe(2);
    expect(Math.min(...ys)).toBeCloseTo(chartY(scale, MEAN_GAP, 3), 6);
    expect(Math.max(...ys)).toBeCloseTo(chartY(scale, NAIVE_WAIT, 3), 6);
  });
});

describe('waiting-time instance: the plate', () => {
  it('paints the timetable once, on the background, and rains passengers on the foreground', () => {
    const v = stubViz();
    const busTicks = v.bg.strokes.filter((s) => s.pen === THEME.grid).flatMap((s) => s.segments);
    // Fifteen hours of buses at a ten-minute average gap.
    expect(busTicks.length).toBeGreaterThan(50);
    expect(busTicks.length).toBeLessThan(200);
    for (const [x0, y0, x1, y1] of busTicks) {
      expect(x0).toBe(x1);
      expect(y1).toBeGreaterThan(y0);
    }
    // Six washes, one per row, in the graphite fill and never through alpha.
    const washes = v.bg.boxes.filter((b) => b.kind === 'fill' && b.style === THEME.data3Fill);
    expect(washes).toHaveLength(ROWS);

    tick(v, 600);
    paint(v);
    const dots = v.fg.arcs;
    expect(dots.length).toBeGreaterThan(20);
    for (const d of dots) {
      expect(d.fill).toBe(THEME.data1);
      expect(d.r).toBe(THEME.particleRadius);
    }
    // Nothing structural is repainted per frame: no wash, no bus tick.
    expect(v.fg.strokes.some((s) => s.pen === THEME.grid)).toBe(false);
    expect(v.fg.boxes.some((b) => b.style === THEME.data3Fill)).toBe(false);
  });

  it('keeps every painted dot inside a band and inside the plate', () => {
    for (const [w, h] of [[705, 440], [343, 381], [1_280, 800]] as const) {
      const v = stubViz({}, w, h);
      tick(v, 2_400);
      paint(v);
      const { rows } = layoutPlate(w, h);
      for (const d of v.fg.arcs) {
        expect(d.x, `${w}×${h}`).toBeGreaterThanOrEqual(0);
        expect(d.x, `${w}×${h}`).toBeLessThanOrEqual(w);
        const row = rows.find((r) => d.y >= r.y - 1e-6 && d.y <= r.y + r.height + 1e-6);
        expect(row, `${w}×${h} dot at ${d.y}`).toBeDefined();
      }
    }
  });

  it('bounds what it paints independently of what it counts', () => {
    const v = stubViz({ passengers: MAX_PASSENGERS });
    tick(v, 2_400);
    paint(v);
    expect(ledger(v)['passengers']).toBe(MAX_PASSENGERS);
    // Fifty thousand counted, about a hundred and eighty painted: the window is
    // 900 minutes of a 250,000-minute timetable.
    expect(v.fg.arcs.length).toBeLessThan(400);
    expect(v.fg.arcs.length).toBeGreaterThan(80);
    expect(v.fg.arcs.length).toBeLessThanOrEqual(waitingTime.budget?.maxEntities ?? 0);
  });

  it('paints the same picture weight at 500 passengers and at 50,000', () => {
    const few = stubViz({ passengers: 500 });
    const many = stubViz({ passengers: MAX_PASSENGERS });
    for (const v of [few, many]) {
      tick(v, 2_400);
      paint(v);
    }
    const ratio = few.fg.arcs.length / Math.max(1, many.fg.arcs.length);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('highlights one gap, with its length written beside it and published', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    const silhouettes = v.fg.boxes.filter((b) => b.kind === 'stroke' && b.style === THEME.data3);
    expect(silhouettes).toHaveLength(1);
    const busiest = ledger(v)['busiest'] ?? 0;
    expect(busiest).toBeGreaterThan(0);
    expect(v.fg.texts).toContain(`${busiest.toFixed(0)} min`);
    // The highlight holds still: a search would tie-break differently every
    // frame while the counts are small.
    const first = silhouettes[0];
    paint(v);
    expect(v.fg.boxes.filter((b) => b.kind === 'stroke' && b.style === THEME.data3)[0]).toEqual(first);
  });

  it('uses no colour outside the theme, and no alpha under a data mark', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    const pens = new Set([...v.fg.strokes.map((s) => s.pen), ...v.bg.strokes.map((s) => s.pen)]);
    const fills = new Set([...v.fg.arcs.map((a) => a.fill), ...v.fg.boxes.map((b) => b.style), ...v.bg.boxes.map((b) => b.style)]);
    const allowed = new Set(Object.values(THEME).map(String));
    for (const c of [...pens, ...fills]) expect(allowed.has(c), c).toBe(true);
    for (const s of v.fg.strokes) expect(s.alpha).toBe(1);
  });
});

describe('waiting-time instance: resize', () => {
  it('leaves the counters and the measurement untouched', () => {
    const v = stubViz({}, 705, 440);
    tick(v, 600);
    paint(v);
    const before = ledger(v);
    resize(v, 343, 381);
    expect(ledger(v)).toEqual(before);
    resize(v, 1_280, 800);
    expect(ledger(v)).toEqual(before);
  });

  it('gives the same ledger on any plate, so a permalink survives the window', () => {
    const wide = stubViz({}, 1_280, 800);
    const narrow = stubViz({}, 320, 356);
    for (const v of [wide, narrow]) {
      tick(v, 600);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
  });

  it('re-places the passengers already at the stop rather than stranding them', () => {
    const v = stubViz({}, 400, 300);
    tick(v, 600);
    paint(v);
    const before = v.fg.arcs.length;
    resize(v, 1_280, 800);
    expect(v.fg.arcs.length).toBe(before);
    const xs = v.fg.arcs.map((a) => a.x);
    // The whole width is used: the window is six rows of timetable and the
    // arrivals are uniform over it.
    expect(Math.max(...xs)).toBeGreaterThan(0.9 * 1_280);
    expect(Math.min(...xs)).toBeLessThan(0.15 * 1_280);
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

describe('waiting-time metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(waitingTime.params.map((p) => p.key)).toEqual(['spread', 'passengers', 'seed']);
    expect(waitingTime.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(waitingTime.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
  });

  it('gives both faders one sentence of help and neither one a hidden unit', () => {
    for (const spec of waitingTime.params) {
      if (spec.kind === 'seed') continue;
      expect(spec.help, spec.key).toBeDefined();
      // ParamSpec.help is one sentence, and the rail has room for one.
      expect(text(spec.help ?? ''), spec.key).not.toMatch(SECOND_SENTENCE);
      expect(spec.label, spec.key).toBe(spec.label.trim());
    }
    // Ten minutes is a constant, not a knob: the whole argument is that the
    // wait climbs while the average gap stands still.
    expect(waitingTime.params.some((p) => p.key === 'meanGap')).toBe(false);
  });

  it('offers three presets, each one plain sentence, each from a declared parameter', () => {
    const presets = waitingTime.presets ?? [];
    expect(presets.length).toBeGreaterThan(1);
    expect(presets.length).toBeLessThanOrEqual(3);
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const key of Object.keys(preset.values)) {
        expect(waitingTime.params.some((p) => p.key === key), `preset ${preset.id} sets ${key}`).toBe(true);
      }
    }
    // Ordered to walk to the insight: a perfect timetable, a ragged one, then
    // buses at random — the average gap never moving.
    expect(presets.map((p) => p.id)).toEqual(['clockwork', 'a-bit-ragged', 'at-random']);
    expect(presets.map((p) => p.values['spread'])).toEqual([0, 50, 100]);
  });

  it('states at most two facts, one sentence each, and sources both', () => {
    expect(waitingTime.facts.length).toBeGreaterThan(0);
    expect(waitingTime.facts.length).toBeLessThanOrEqual(2);
    for (const fact of waitingTime.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(waitingTime.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).toMatch(/^Drops /);
  });

  it('keeps its permanent id and a plate shape for both widths', () => {
    expect(waitingTime.id).toBe('waiting-time');
    expect(waitingTime.group).toBe('randomness');
    expect(waitingTime.aspect).toBeGreaterThan(1);
    expect(waitingTime.aspectNarrow).toBeLessThan(1);
    expect(waitingTime.budget?.maxEntities).toBe(MAX_PASSENGERS);
    // The window is what the row count and the row length say it is.
    expect(ROWS * MINUTES_PER_ROW).toBe(WINDOW_MINUTES);
  });
});
