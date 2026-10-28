import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { testable, verdictOf } from '../src/ui/readouts';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import {
  BEADS_STEP,
  MAX_BEADS,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  RUN_SECONDS,
  TEMPERATURE_STEP,
  analyticBarShare,
  beadsFor,
  launchRateFor,
  maxwellBoltzmann,
  pileMetrics,
  scaleFor,
  temperatureFor,
} from '../src/viz/maxwell-boltzmann/index';
import {
  GASES,
  MEAN_FACTOR,
  MODE_FACTOR,
  RMS_FACTOR,
  RMS_SD_FACTOR,
  SPEED_SD_FACTOR,
  SpeedTally,
  bandShare,
  fasterThanSound,
  gasById,
  sampleSpeed,
  speedCdf,
  speedPdf,
  speedTail,
  thermalScale,
} from '../src/viz/maxwell-boltzmann/gas';
import {
  COUNT_MS,
  FLIGHT,
  FLIGHT_S,
  GRAVITY,
  LIFT,
  REST,
  SLOTS,
  SLOT_SPEED,
  TOP_SPEED,
  createMachine,
  hopperGrid,
  layoutPlate,
  restSlot,
  slotOf,
  slotShare,
  type MachineGeometry,
  type PlateLayout,
} from '../src/viz/maxwell-boltzmann/sim';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/**
 * Where every tolerance in this file comes from.
 *
 * Nothing is fitted. A mean of n speeds has standard error √(3 − 8/π)·a/√n, a
 * root-mean-square √(1/2)·a/√n to first order, and a proportion √(p(1−p)/n);
 * three of those is the band a run sits inside about 997 times in 1,000, and
 * it is the same three the readouts publish. A whole distribution is held to
 * Kolmogorov's 99th percentile, 1.628/√n. Every run is a pure function of its
 * seed, so an assertion that passes once passes forever.
 */
const SIGMAS = 3;
const KS_CRITICAL = 1.628;

/** Nitrogen at room temperature, the tab's default gas. */
const N2 = gasById('nitrogen');
const A300 = thermalScale(300, N2.mass);

/** Simpson's rule on [lo, hi] with `n` (even) panels. */
function integrate(f: (x: number) => number, lo: number, hi: number, n = 4000): number {
  const h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += (i % 2 === 1 ? 4 : 2) * f(lo + i * h);
  return (s * h) / 3;
}

/** The largest gap between the empirical distribution of `xs` and the law's. */
function ksGap(xs: number[], a: number): number {
  const sorted = [...xs].sort((p, q) => p - q);
  const n = sorted.length;
  let worst = 0;
  sorted.forEach((x, i) => {
    const F = speedCdf(x, a);
    worst = Math.max(worst, Math.abs((i + 1) / n - F), Math.abs(i / n - F));
  });
  return worst;
}

// ---------------------------------------------------------------------------
// The law
// ---------------------------------------------------------------------------

describe('the Maxwell–Boltzmann law', () => {
  it('pins the numbers for nitrogen at 300 K', () => {
    // k = 1.380649e-23 J/K, m = 28.0134 Da: a = √(kT/m) = 298.40 m/s.
    expect(A300).toBeCloseTo(298.4, 1);
    expect(A300 * MODE_FACTOR).toBeCloseTo(422.0, 1);
    expect(A300 * MEAN_FACTOR).toBeCloseTo(476.2, 1);
    expect(A300 * RMS_FACTOR).toBeCloseTo(516.8, 1);
    expect(A300 * Math.sqrt(N2.gamma)).toBeCloseTo(353.1, 1);
  });

  it('is a distribution whose tail and density agree', () => {
    for (const a of [100, A300, 600]) {
      expect(integrate((v) => speedPdf(v, a), 0, 12 * a)).toBeCloseTo(1, 10);
      for (const v of [0.3 * a, a, 2 * a, 4 * a]) {
        expect(integrate((u) => speedPdf(u, a), v, 12 * a)).toBeCloseTo(speedTail(v, a), 10);
      }
      expect(speedTail(0, a)).toBe(1);
      expect(speedCdf(0, a)).toBe(0);
    }
    // The tail keeps its digits where one minus the distribution would not.
    expect(speedTail(10 * A300, A300)).toBeGreaterThan(0);
    expect(speedTail(10 * A300, A300)).toBeLessThan(1e-19);
  });

  it('has the moments every band in the tab is built from', () => {
    const a = A300;
    const m1 = integrate((v) => v * speedPdf(v, a), 0, 12 * a);
    const m2 = integrate((v) => v * v * speedPdf(v, a), 0, 12 * a);
    const m4 = integrate((v) => v ** 4 * speedPdf(v, a), 0, 12 * a);
    expect(m1 / a).toBeCloseTo(MEAN_FACTOR, 9);
    expect(Math.sqrt(m2) / a).toBeCloseTo(RMS_FACTOR, 9);
    expect(Math.sqrt(m2 - m1 * m1) / a).toBeCloseTo(SPEED_SD_FACTOR, 9);
    // E[v⁴] = 15a⁴, so one squared speed carries √6·a² and the root of the
    // mean square moves by √6/(2√3) = 1/√2 of a per √n.
    expect(m4 / a ** 4).toBeCloseTo(15, 7);
    expect(Math.sqrt(m4 - m2 * m2) / (2 * Math.sqrt(m2))).toBeCloseTo(RMS_SD_FACTOR * a, 6);
    // The density peaks at √2·a.
    const peak = MODE_FACTOR * a;
    expect(speedPdf(peak, a)).toBeGreaterThan(speedPdf(peak * 0.99, a));
    expect(speedPdf(peak, a)).toBeGreaterThan(speedPdf(peak * 1.01, a));
  });

  it('puts the same share of a gas above the speed of sound at every temperature', () => {
    expect(fasterThanSound(7 / 5)).toBeCloseTo(0.705535, 5);
    expect(fasterThanSound(5 / 3)).toBeCloseTo(0.64437, 5);
    for (const gas of GASES) {
      for (const T of [MIN_TEMPERATURE, 300, MAX_TEMPERATURE]) {
        const a = thermalScale(T, gas.mass);
        expect(speedTail(a * Math.sqrt(gas.gamma), a)).toBeCloseTo(fasterThanSound(gas.gamma), 12);
      }
    }
  });

  it('draws three normals per speed, so the stream is fixed by the seed alone', () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 50; i++) {
      const v = sampleSpeed(a, 1);
      const x = b.normal();
      const y = b.normal();
      const z = b.normal();
      expect(v).toBe(Math.sqrt(x * x + y * y + z * z));
    }
    expect(a.next()).toBe(b.next());
  });

  it('samples the law: mean, root-mean-square, sound share and shape, from three seeds', () => {
    const n = 20_000;
    const share = fasterThanSound(N2.gamma);
    const c = A300 * Math.sqrt(N2.gamma);
    for (const seed of [1, 42, 2026]) {
      const rng = createRng(seed);
      const tally = new SpeedTally(c);
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const v = sampleSpeed(rng, A300);
        tally.push(v);
        xs.push(v);
      }
      expect(Math.abs(tally.mean - A300 * MEAN_FACTOR)).toBeLessThan((SIGMAS * SPEED_SD_FACTOR * A300) / Math.sqrt(n));
      expect(Math.abs(tally.rms - A300 * RMS_FACTOR)).toBeLessThan((SIGMAS * RMS_SD_FACTOR * A300) / Math.sqrt(n));
      expect(Math.abs(tally.shareAbove - share)).toBeLessThan(SIGMAS * Math.sqrt((share * (1 - share)) / n));
      expect(ksGap(xs, A300)).toBeLessThan(KS_CRITICAL / Math.sqrt(n));
    }
  });
});

describe('SpeedTally', () => {
  it('reports nothing before the first speed and forgets everything on reset', () => {
    const t = new SpeedTally(10);
    expect(t.n).toBe(0);
    expect(t.mean).toBeNaN();
    expect(t.rms).toBeNaN();
    expect(t.shareAbove).toBeNaN();
    for (const v of [3, 4, 12]) t.push(v);
    expect(t.mean).toBeCloseTo(19 / 3, 12);
    expect(t.rms).toBeCloseTo(Math.sqrt((9 + 16 + 144) / 3), 12);
    expect(t.shareAbove).toBeCloseTo(1 / 3, 12);
    t.reset(3.5);
    expect(t.n).toBe(0);
    t.push(4);
    expect(t.shareAbove).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The slots
// ---------------------------------------------------------------------------

describe('the slots', () => {
  it('give every speed the band of a hundred metres a second it falls in', () => {
    expect(slotOf(0)).toBe(0);
    expect(slotOf(99.999)).toBe(0);
    expect(slotOf(100)).toBe(1);
    expect(slotOf(1_899.9)).toBe(18);
    expect(slotOf(1_900)).toBe(SLOTS - 1);
    expect(slotOf(TOP_SPEED)).toBe(SLOTS - 1);
    expect(slotOf(9_999)).toBe(SLOTS - 1);
  });

  it('share out the whole law, the last slot taking everything past the far wall', () => {
    for (const a of [thermalScale(MIN_TEMPERATURE, gasById('xenon').mass), A300, thermalScale(MAX_TEMPERATURE, N2.mass)]) {
      let sum = 0;
      for (let k = 0; k < SLOTS; k++) sum += slotShare(k, a);
      expect(sum).toBeCloseTo(1, 13);
      expect(slotShare(SLOTS - 1, a)).toBeCloseTo(speedTail(TOP_SPEED - SLOT_SPEED, a), 15);
    }
  });

  it('cover every gas at every temperature on the fader with almost nothing past the far wall', () => {
    // The temperature fader's ceiling is set by this: nitrogen at 700 K is the
    // fastest gas the machine is offered, and 2.4 beads in ten thousand clear
    // 2,000 m/s. Anything that offered helium, or a hotter oven, would fail.
    let worst = 0;
    for (const gas of GASES) {
      for (let T = MIN_TEMPERATURE; T <= MAX_TEMPERATURE; T += TEMPERATURE_STEP) {
        worst = Math.max(worst, speedTail(TOP_SPEED, thermalScale(T, gas.mass)));
      }
    }
    expect(worst).toBeLessThan(2.5e-4);
    expect(speedTail(TOP_SPEED, thermalScale(300, 4.0026))).toBeGreaterThan(0.05);
  });

  it('keep every gas a gas at the bottom of the fader: xenon boils at 165 K', () => {
    expect(MIN_TEMPERATURE).toBeGreaterThan(165);
  });

  it('draw the chart’s curve through the top of every bar the law predicts', () => {
    for (const a of [thermalScale(MIN_TEMPERATURE, gasById('xenon').mass), A300, thermalScale(MAX_TEMPERATURE, N2.mass)]) {
      for (let k = 0; k < SLOTS; k++) {
        expect(analyticBarShare((k + 0.5) * SLOT_SPEED, a)).toBeCloseTo(slotShare(k, a), 14);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/** The plates the machine is checked on: a desk and the narrowest phone. */
const PLATES: ReadonlyArray<[string, number, number]> = [
  ['desktop', 770, 513],
  ['phone', 327, 409],
];

function geometryFor(L: PlateLayout, beads: number, a: number): MachineGeometry {
  const pile = pileMetrics(L, a, beads, 2);
  const hopper = hopperGrid(L, beads, 2);
  return {
    slotWidth: L.slotWidth,
    drop: L.drop,
    depth: L.depth,
    beadRadius: 2,
    dotRadius: pile.radius,
    cols: pile.cols,
    hopper: { ...hopper, left: hopper.left - L.slotLeft, bottom: hopper.bottom - L.portY },
  };
}

function machine(seed: number, beads: number, a: number, L?: PlateLayout) {
  const sim = createMachine(createRng(seed), { beads, launchRate: launchRateFor(beads), scale: a }, MAX_BEADS);
  if (L) sim.setGeometry(geometryFor(L, beads, a));
  return sim;
}

/** Ticks that finish a run of `beads`, every bead at rest. */
function ticksFor(beads: number): number {
  return Math.ceil(((beads / launchRateFor(beads)) * 1000 + COUNT_MS + 2_500) / TICK);
}

describe('the machine: statistics', () => {
  it('fills the slots with the law, binned a hundred metres a second, from three seeds', () => {
    const beads = MAX_BEADS;
    for (const seed of [1, 42, 2026]) {
      const sim = machine(seed, beads, A300);
      for (let i = 0; i < ticksFor(beads); i++) sim.step(TICK);
      expect(sim.landed).toBe(beads);
      // Every slot inside three standard errors of its own binomial count, and
      // the whole row inside Kolmogorov's band on the slots' cumulative counts.
      let cumulative = 0;
      let expected = 0;
      let worst = 0;
      for (let k = 0; k < SLOTS; k++) {
        const q = slotShare(k, A300);
        const c = sim.slots[k] ?? 0;
        expect(Math.abs(c - beads * q), `slot ${k}`).toBeLessThanOrEqual(SIGMAS * Math.sqrt(beads * q * (1 - q)) + 1);
        cumulative += c;
        expected += q;
        worst = Math.max(worst, Math.abs(cumulative / beads - expected));
      }
      expect(worst).toBeLessThan(KS_CRITICAL / Math.sqrt(beads));
    }
  });

  it('puts every bead in the slot its speed names, and counts it there', () => {
    const sim = machine(SEED, 1_200, A300);
    for (let i = 0; i < ticksFor(1_200); i++) sim.step(TICK);
    const counts = new Array<number>(SLOTS).fill(0);
    for (let i = 0; i < sim.landed; i++) {
      const k = slotOf(sim.speedOf(i));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect([...sim.slots]).toEqual(counts);
    expect([...sim.settledSlots]).toEqual(counts);
  });
});

describe('the machine: determinism', () => {
  it('produces identical speeds and slots at any step size, any plate, any pace', () => {
    const beads = 600;
    const reference = machine(SEED, beads, A300);
    for (let i = 0; i < ticksFor(beads); i++) reference.step(TICK);
    const runs = [
      machine(SEED, beads, A300, layoutPlate(327, 409)),
      machine(SEED, beads, A300, layoutPlate(1_200, 800)),
    ];
    for (const sim of runs) for (let i = 0; i < ticksFor(beads) / 4; i++) sim.step(4 * TICK);
    const coarse = machine(SEED, beads, A300);
    for (let i = 0; i < 80; i++) coarse.step(250);
    const slow = createMachine(createRng(SEED), { beads, launchRate: 7, scale: A300 }, MAX_BEADS);
    for (let i = 0; i < 2_000; i++) slow.step(50);
    for (const sim of [...runs, coarse, slow]) {
      expect(sim.landed).toBe(beads);
      expect([...sim.slots]).toEqual([...reference.slots]);
      expect([...sim.settledSlots]).toEqual([...reference.slots]);
      for (let i = 0; i < beads; i++) expect(sim.speedOf(i)).toBe(reference.speedOf(i));
    }
  });

  it('counts a bead at the mouths at a fixed time after its release, whatever the step', () => {
    const fine = machine(SEED, 1_200, A300);
    const coarse = machine(SEED, 1_200, A300);
    let t = 0;
    for (let check = 1; check <= 6; check++) {
      // 1,999 ms apart, so no check lands on a tick boundary of either run.
      const until = check * 1_999 + 0.5;
      while (fine.time + TICK <= until) fine.step(TICK);
      fine.step(until - fine.time);
      while (t + 100 <= until) {
        coarse.step(100);
        t += 100;
      }
      coarse.step(until - t);
      t = until;
      expect(fine.landed).toBe(coarse.landed);
      expect(fine.launched).toBe(coarse.launched);
    }
    // The first bead leaves on the first tick and is counted LIFT + FLIGHT later.
    const one = machine(SEED, 50, A300);
    one.step(1);
    while (one.time + 1 < COUNT_MS) one.step(1);
    expect(one.landed).toBe(0);
    one.step(2);
    expect(one.landed).toBe(1);
  });

  it('differs between seeds', () => {
    const a = machine(1, 600, A300);
    const b = machine(2, 600, A300);
    for (let i = 0; i < ticksFor(600); i++) {
      a.step(TICK);
      b.step(TICK);
    }
    expect([...a.slots]).not.toEqual([...b.slots]);
  });
});

describe('the machine: motion', () => {
  for (const [name, w, h] of PLATES) {
    for (const [label, a] of [
      ['room air', A300],
      ['hot nitrogen', thermalScale(MAX_TEMPERATURE, N2.mass)],
      ['cold xenon', thermalScale(MIN_TEMPERATURE, gasById('xenon').mass)],
    ] as const) {
      it(`keeps every bead inside the machine and inside its own slot: ${label}, ${name}`, () => {
        const L = layoutPlate(w, h);
        const beads = 2_000;
        const sim = machine(SEED, beads, a, L);
        const g = geometryFor(L, beads, a);
        const floor = 1 + L.depth / L.drop;
        const leftWall = (L.columnLeft - L.slotLeft) / L.slotWidth;
        let flights = 0;
        let below = 0;
        // Plain comparisons, and one assertion at the end: an expect() per bead
        // per frame is millions of them, and ten seconds a plate.
        const faults: string[] = [];
        const fault = (what: string, b: { x: number; y: number; phase: number; slot: number }): void => {
          if (faults.length < 5) faults.push(`${what}: phase ${b.phase}, slot ${b.slot}, x ${b.x}, y ${b.y}`);
        };
        const eps = 1e-9;
        for (let i = 0; i < ticksFor(beads); i++) {
          sim.step(TICK);
          if (i % 3 !== 0) continue;
          sim.forEachActive((b) => {
            // Never through the lid or the floor, never out of the case.
            if (b.y < -eps || b.y > floor + eps) fault('outside lid-to-floor', b);
            if (b.x < leftWall - eps || b.x > SLOTS + eps) fault('outside the case', b);
            // The lift stays in the column until it reaches the port; once out
            // of the port, a bead never goes back behind the wall.
            if (b.phase === LIFT ? b.x > eps : b.x < -eps) fault('wrong side of the wall', b);
            if (b.phase === FLIGHT) {
              // A true parabola from the port: x = u·t, y = g·t²/2.
              const u = b.speed / (SLOT_SPEED * FLIGHT_S);
              if (Math.abs(b.x - u * Math.sqrt((2 * b.y) / GRAVITY)) > 1e-9) fault('off its parabola', b);
              flights++;
            }
            if (b.y >= 1 && b.phase !== LIFT) {
              // Below the mouths a bead out of the port is between its own
              // slot's walls. (The hopper is lower than the mouths, so a bead
              // still rising from it is below them too, in the column.)
              if (b.x < b.slot - eps || b.x > b.slot + 1 + eps) fault('outside its slot', b);
              below++;
            }
          });
        }
        expect(faults).toEqual([]);
        expect(flights).toBeGreaterThan(500);
        expect(below).toBeGreaterThan(500);
        expect(sim.landed).toBe(beads);
        // And every bead ends exactly where the pile is painted.
        for (let k = 0; k < SLOTS; k++) expect(sim.settledSlots[k]).toBe(sim.slots[k]);
        expect(g.cols).toBeGreaterThanOrEqual(1);
      });
    }
  }

  it('lands a bead at a distance from the wall proportional to its speed', () => {
    // FLIGHT_S after the lift every bead is at the mouths' height, at x = v/100
    // slot widths: the slots are a speedometer before any number is read.
    const sim = machine(SEED, 400, A300);
    let checked = 0;
    for (let i = 0; i < ticksFor(400) && checked < 200; i++) {
      sim.step(TICK);
      sim.forEachActive((b) => {
        if (b.phase !== FLIGHT || b.y < 0.999 || b.y > 1.001) return;
        expect(b.x).toBeCloseTo((b.speed / SLOT_SPEED) * Math.sqrt(b.y), 9);
        expect(Math.floor(b.x / Math.sqrt(b.y) + 1e-12)).toBe(Math.min(slotOf(b.speed), Math.floor(b.speed / SLOT_SPEED)));
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('rests every bead on the place the renderer paints for it', () => {
    const L = layoutPlate(770, 513);
    const beads = 1_200;
    const sim = machine(SEED, beads, A300, L);
    const g = geometryFor(L, beads, A300);
    for (let i = 0; i < ticksFor(beads) - 300; i++) sim.step(TICK);
    let resting = 0;
    sim.forEachActive((b) => {
      if (b.phase !== REST) return;
      const place = restSlot(g.cols, g.dotRadius, g.depth, b.stack);
      expect(b.x).toBeCloseTo(b.slot + 0.5 + place.dx / g.slotWidth, 12);
      expect(b.y).toBeCloseTo(1 + place.depth / g.drop, 12);
      resting++;
    });
    expect(resting).toBeGreaterThanOrEqual(0);
  });

  it('empties the hopper from the top, at the pace the run asks for', () => {
    const sim = machine(SEED, 1_200, A300);
    expect(sim.emptiedAt).toBe(Infinity);
    for (let i = 0; i < 6 * 120; i++) sim.step(TICK);
    // Six seconds at 100 a second, give or take the first tick.
    expect(Math.abs(sim.launched - 600)).toBeLessThanOrEqual(1);
    for (let i = 0; i < 7 * 120; i++) sim.step(TICK);
    expect(sim.launched).toBe(1_200);
    expect(sim.emptiedAt).toBeLessThanOrEqual(sim.time);
    expect(sim.emptiedAt).toBeGreaterThan(11_000);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('layoutPlate', () => {
  for (const [w, h] of [
    [770, 513],
    [1_200, 800],
    [327, 409],
    [240, 200],
    [60, 40],
  ] as const) {
    it(`stacks the machine over its chart without overlap at ${w}×${h}`, () => {
      const L = layoutPlate(w, h);
      expect(L.lid).toBeLessThan(L.portY);
      expect(L.portY).toBeLessThan(L.mouthY);
      expect(L.mouthY).toBeLessThan(L.floor);
      expect(L.floor).toBeLessThan(L.chartTop);
      expect(L.chartTop).toBeLessThan(L.chartBase);
      expect(L.hopperTop).toBeLessThan(L.mesh);
      expect(L.mesh).toBeLessThan(L.fanTop);
      expect(L.fanY + L.fanR).toBeLessThanOrEqual(L.floor);
      expect(L.left).toBeLessThan(L.columnLeft);
      expect(L.columnRight).toBeLessThan(L.slotLeft);
      expect(L.slotRight).toBe(L.right);
      expect(L.slotWidth * SLOTS).toBeCloseTo(L.slotRight - L.slotLeft, 9);
      expect(L.drop).toBeCloseTo(L.mouthY - L.portY, 9);
      expect(L.depth).toBeCloseTo(L.floor - L.mouthY, 9);
    });
  }

  it('fits the whole hopper in the hopper, from fifty beads to five thousand, on a phone', () => {
    const L = layoutPlate(327, 409);
    for (const beads of [BEADS_STEP, 1_200, MAX_BEADS]) {
      const g = hopperGrid(L, beads, 2);
      const rows = Math.ceil(beads / g.cols);
      expect(g.bottom - rows * g.pitch).toBeGreaterThanOrEqual(L.hopperTop - 1e-9);
      expect(g.left).toBeGreaterThanOrEqual(L.columnLeft);
      expect(g.left + g.cols * g.pitch).toBeLessThanOrEqual(L.columnRight + 1e-9);
      expect(g.radius).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

interface Recorder {
  ctx: CanvasRenderingContext2D;
  fills: Array<{ style: string; alpha: number; h: number; y: number }>;
  strokes: Array<{ pen: string; width: number; dash: number }>;
  texts: Array<{ text: string; style: string }>;
  arcs: number;
  calls: number;
}

function recordingContext(): Recorder {
  const rec: Recorder = { ctx: null as unknown as CanvasRenderingContext2D, fills: [], strokes: [], texts: [], arcs: 0, calls: 0 };
  let dash = 0;
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
    clearRect: () => void rec.calls++,
    fillRect(_x: number, y: number, _w: number, h: number): void {
      rec.calls++;
      rec.fills.push({ style: String(api.fillStyle), alpha: api.globalAlpha, h, y });
    },
    strokeRect: () => void rec.calls++,
    fillText(text: string): void {
      rec.calls++;
      rec.texts.push({ text, style: String(api.fillStyle) });
    },
    measureText: () => ({ width: 40 }),
    save: () => void rec.calls++,
    restore: () => void rec.calls++,
    beginPath: () => void rec.calls++,
    moveTo: () => void rec.calls++,
    lineTo: () => void rec.calls++,
    quadraticCurveTo: () => void rec.calls++,
    arc(): void {
      rec.calls++;
      rec.arcs++;
    },
    fill: () => void rec.calls++,
    setLineDash(d: number[]): void {
      rec.calls++;
      dash = d.length;
    },
    stroke(): void {
      rec.calls++;
      rec.strokes.push({ pen: String(api.strokeStyle), width: api.lineWidth, dash });
    },
  };
  rec.ctx = api as unknown as CanvasRenderingContext2D;
  return rec;
}

/** The pinned canvas contract from theme.css §RULE 0. */
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

const DEFAULTS: Record<string, ParamValue> = { gas: 'nitrogen', temperature: 300, beads: 1_200, seed: SEED };

function stubViz(overrides: Record<string, ParamValue> = {}, width = 770, height = 513, reducedMotion = false) {
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
    reducedMotion,
  };
  const instance = maxwellBoltzmann.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Stub = ReturnType<typeof stubViz>;

function run(v: Stub, ticks: number): void {
  for (let i = 0; i < ticks; i++) v.instance.step(TICK);
}

function ledger(v: Stub): Map<string, Readout> {
  v.instance.draw();
  const last = v.emitted[v.emitted.length - 1] ?? [];
  return new Map(last.map((r) => [r.key, r]));
}

function finish(v: Stub): void {
  run(v, ticksFor(beadsFor(v.ctx.params)));
}

describe('maxwell-boltzmann instance: the run', () => {
  it('fires exactly the bead count, lands every bead, and then does nothing', () => {
    const v = stubViz({ beads: 200 });
    finish(v);
    const before = ledger(v);
    expect(before.get('fired')?.value).toBe(200);
    expect(before.get('landed')?.value).toBe(200);
    run(v, 600);
    const after = ledger(v);
    for (const [key, r] of before) expect(after.get(key)?.value, key).toBe(r.value);
  });

  it('moves a published number in every early batch, so a reduced-motion settle cannot stop at the start', () => {
    // The shell's settle stops at the first fast-forward batch in which nothing
    // it can see has moved. Batches start at 64 ticks; nothing lands for the
    // first 1.15 s, so something else has to move inside every 64 ticks.
    const v = stubViz({ beads: BEADS_STEP });
    let last = ledger(v).get('fired')?.value ?? 0;
    for (let batch = 0; batch < 10; batch++) {
      run(v, 64);
      const now = ledger(v).get('fired')?.value ?? 0;
      expect(now, `batch ${batch}`).toBeGreaterThan(last);
      last = now;
    }
  });

  it('paints nothing while it steps', () => {
    const v = stubViz();
    const bg = v.bg.calls;
    const fg = v.fg.calls;
    run(v, 300);
    expect(v.bg.calls).toBe(bg);
    expect(v.fg.calls).toBe(fg);
  });

  it('changes no reading when it draws', () => {
    const v = stubViz();
    run(v, 900);
    const a = ledger(v);
    const b = ledger(v);
    for (const [key, r] of a) expect(b.get(key)?.value, key).toBe(r.value);
  });

  it('replays the same run from the same seed and a different one from another', () => {
    const a = stubViz({ beads: 400 });
    const b = stubViz({ beads: 400 });
    const c = stubViz({ beads: 400, seed: 7 });
    for (const v of [a, b, c]) finish(v);
    expect(ledger(a).get('mean')?.value).toBe(ledger(b).get('mean')?.value);
    expect(ledger(a).get('mean')?.value).not.toBe(ledger(c).get('mean')?.value);
  });

  it('starts over on reset', () => {
    const v = stubViz({ beads: 400 });
    finish(v);
    const first = ledger(v).get('mean')?.value;
    v.instance.reset();
    expect(ledger(v).get('landed')?.value).toBe(0);
    expect(ledger(v).get('mean')?.value).toBeNaN();
    finish(v);
    expect(ledger(v).get('mean')?.value).toBe(first);
  });

  it('re-lays-out on resize without touching the run', () => {
    const v = stubViz();
    run(v, 900);
    const before = ledger(v);
    v.ctx.width = 327;
    v.ctx.height = 409;
    v.instance.drawBackground?.();
    v.instance.drawBackground?.();
    const after = ledger(v);
    for (const [key, r] of before) expect(after.get(key)?.value, key).toBe(r.value);
    run(v, 900);
    expect(ledger(v).get('landed')?.value).toBeGreaterThan(before.get('landed')?.value ?? 0);
  });
});

describe('maxwell-boltzmann instance: readouts', () => {
  it('publishes every number on the plate, with its prediction', () => {
    const v = stubViz();
    const r = ledger(v);
    expect([...r.keys()]).toEqual(['landed', 'fired', 'mean', 'rms', 'supersonic', 'sound']);
    expect(r.get('mean')?.target).toBeCloseTo(A300 * MEAN_FACTOR, 9);
    expect(r.get('rms')?.target).toBeCloseTo(A300 * RMS_FACTOR, 9);
    expect(r.get('supersonic')?.target).toBeCloseTo(fasterThanSound(7 / 5), 12);
    // The marker the chart draws, as a number.
    expect(r.get('sound')?.value).toBeCloseTo(A300 * Math.sqrt(7 / 5), 9);
    for (const key of ['mean', 'rms', 'supersonic']) expect(r.get(key)?.formula, key).toBeDefined();
  });

  it('marks exactly one headline, gives it its hint, and gives every plain reading plain words', () => {
    const r = [...ledger(stubViz()).values()];
    expect(r.filter((x) => x.headline).map((x) => x.key)).toEqual(['mean']);
    expect(r.filter((x) => x.hint !== undefined).map((x) => x.key)).toEqual(['mean']);
    for (const x of r) if (!x.expertOnly) expect(x.plain, x.key).toBeTruthy();
  });

  it('reads as nothing measured before the first bead lands', () => {
    const r = ledger(stubViz());
    expect(r.get('mean')?.value).toBeNaN();
    expect(verdictOf(r.get('mean') as Readout).text).toBe('not measured yet');
  });

  it('sharpens the headline’s band as beads land, and only then gives a verdict', () => {
    const v = stubViz({ beads: MAX_BEADS });
    run(v, 300);
    const early = ledger(v).get('mean') as Readout;
    expect(early.band).toEqual({ kind: 'sampled', sigma: A300 * SPEED_SD_FACTOR, samples: ledger(v).get('landed')?.value });
    // A twentieth of 476 m/s is 23.8 m/s, which three standard errors reach at
    // about 640 beads: before that the ledger may not say "matches".
    expect(testable(early)).toBe(false);
    finish(v);
    const late = ledger(v).get('mean') as Readout;
    expect(testable(late)).toBe(true);
  });

  it('sits inside every band at the end of a full run, from three seeds', () => {
    for (const seed of [1, 42, 2026]) {
      const v = stubViz({ beads: MAX_BEADS, seed });
      finish(v);
      const r = ledger(v);
      for (const key of ['mean', 'rms', 'supersonic']) {
        const x = r.get(key) as Readout;
        expect(testable(x), `${key} @ ${seed}`).toBe(true);
        expect(verdictOf(x).state, `${key} @ ${seed}: ${x.value} vs ${x.target}`).toBe('agree');
      }
    }
  });

  it('follows the gas and the temperature', () => {
    const xe = ledger(stubViz({ gas: 'xenon', temperature: 700 }));
    const a = thermalScale(700, gasById('xenon').mass);
    expect(xe.get('mean')?.target).toBeCloseTo(a * MEAN_FACTOR, 9);
    expect(xe.get('supersonic')?.target).toBeCloseTo(fasterThanSound(5 / 3), 12);
    expect(xe.get('sound')?.value).toBeCloseTo(a * Math.sqrt(5 / 3), 9);
  });
});

describe('maxwell-boltzmann instance: the plate', () => {
  it('draws the furniture in the container pen and labels it in the muted ink', () => {
    const v = stubViz();
    const pens = new Set(v.bg.strokes.map((s) => s.pen));
    expect(pens).toEqual(new Set([THEME.gridSoft]));
    for (const t of v.bg.texts) expect(t.style).toBe(THEME.inkMuted);
    expect(v.bg.texts.map((t) => t.text)).toEqual(
      expect.arrayContaining(['0', '500', '1000', '1500', '2000', 'm/s', 'beads at each speed']),
    );
  });

  it('paints the piles and the bars as opaque washes under full-opacity silhouettes', () => {
    const v = stubViz();
    run(v, 1_200);
    v.instance.draw();
    const washes = v.fg.fills.filter((f) => f.style === THEME.data3Fill);
    expect(washes.length).toBeGreaterThan(5);
    for (const f of washes) expect(f.alpha).toBe(1);
    const silhouettes = v.fg.strokes.filter((s) => s.pen === THEME.data3);
    expect(silhouettes).toHaveLength(2);
    for (const s of silhouettes) expect(s.width).toBe(2);
  });

  it('haloes the curve and the sound marker so no two pens touch', () => {
    const v = stubViz();
    run(v, 600);
    v.fg.strokes.length = 0;
    v.instance.draw();
    const s = v.fg.strokes;
    // The marker: plate colour, then the drafting pen, both dashed.
    const marker = s.findIndex((x) => x.pen === THEME.data2 && x.dash > 0);
    expect(marker).toBeGreaterThan(0);
    expect(s[marker - 1]?.pen).toBe(THEME.canvas);
    // The curve: plate colour at +4, then the drafting pen at 2 px, solid.
    const curve = s.findIndex((x) => x.pen === THEME.data2 && x.dash === 0);
    expect(curve).toBeGreaterThan(0);
    expect(s[curve - 1]?.pen).toBe(THEME.canvas);
    expect(s[curve - 1]?.width).toBe(6);
    expect(s[curve]?.width).toBe(2);
  });

  it('draws every bead once: the hopper, the air and the piles', () => {
    const beads = 400;
    const v = stubViz({ beads });
    for (const ticks of [0, 300, 900, ticksFor(beads)]) {
      run(v, ticks);
      v.fg.arcs = 0;
      v.instance.draw();
      // Two arcs that are not beads: the fan's hub, and nothing else.
      expect(v.fg.arcs - 1, `after ${ticks} ticks`).toBe(beads);
    }
  });

  it('keeps every pile in its slot and every bar in the chart, whatever the counts do', () => {
    const L = layoutPlate(770, 513);
    for (const overrides of [{ beads: BEADS_STEP }, { beads: MAX_BEADS, gas: 'xenon', temperature: MIN_TEMPERATURE }]) {
      const v = stubViz(overrides);
      finish(v);
      v.fg.fills.length = 0;
      v.instance.draw();
      for (const f of v.fg.fills.filter((x) => x.style === THEME.data3Fill)) {
        const inSlots = f.y >= L.mouthY - 1e-9 && f.y + f.h <= L.floor + 1e-9;
        const inChart = f.y >= L.chartTop - 1e-9 && f.y + f.h <= L.chartBase + 1e-9;
        expect(inSlots || inChart).toBe(true);
      }
    }
  });

  it('leaves no trails when the reader has asked for less motion', () => {
    const v = stubViz({}, 770, 513, true);
    run(v, 300);
    v.fg.fills.length = 0;
    v.instance.draw();
    expect(v.fg.fills.some((f) => f.style.startsWith('rgba'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metadata, and the claims the words make
// ---------------------------------------------------------------------------

const JARGON =
  /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov|chi)\b/i;

/** Prose as the page prints it, `<var>` segments folded back into the sentence. */
function flatten(prose: Prose): string {
  return typeof prose === 'string' ? prose : prose.map((s) => (typeof s === 'string' ? s : s.v)).join('');
}

describe('maxwell-boltzmann metadata', () => {
  it('is registered under a permanent id, in the randomness run', () => {
    expect(maxwellBoltzmann.id).toBe('maxwell-boltzmann');
    expect(maxwellBoltzmann.group).toBe('randomness');
    expect(maxwellBoltzmann.title).toBe('Maxwell–Boltzmann');
    expect(maxwellBoltzmann.budget?.maxEntities).toBe(MAX_BEADS);
  });

  it('offers a gas, two faders and a seed, and nothing else', () => {
    expect(maxwellBoltzmann.params.map((p) => [p.key, p.kind])).toEqual([
      ['gas', 'choice'],
      ['temperature', 'range'],
      ['beads', 'range'],
      ['seed', 'seed'],
    ]);
    const gas = maxwellBoltzmann.params[0];
    expect(gas?.kind === 'choice' ? gas.options.map((o) => o.value) : []).toEqual(['nitrogen', 'argon', 'xenon']);
  });

  it('snaps a permalink onto the faders’ grids, and falls back to nitrogen for an unknown gas', () => {
    expect(beadsFor({ beads: 1_234 })).toBe(1_250);
    expect(beadsFor({ beads: 1 })).toBe(BEADS_STEP);
    expect(beadsFor({ beads: 1e9 })).toBe(MAX_BEADS);
    expect(temperatureFor({ temperature: 293 })).toBe(290);
    expect(temperatureFor({ temperature: 5 })).toBe(MIN_TEMPERATURE);
    expect(temperatureFor({ temperature: 5_000 })).toBe(MAX_TEMPERATURE);
    expect(scaleFor({ gas: 'helium', temperature: 300 })).toBe(A300);
  });

  it('paces any run to about the same length', () => {
    for (const beads of [BEADS_STEP, 1_200, MAX_BEADS]) {
      const seconds = beads / launchRateFor(beads);
      expect(seconds).toBeGreaterThan(RUN_SECONDS - 1);
      expect(seconds).toBeLessThan(RUN_SECONDS + 1);
    }
  });

  it('walks a newcomer through three presets, in order, each one on the grid', () => {
    const presets = maxwellBoltzmann.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['room-air', 'pizza-oven', 'xenon']);
    const keys = new Set(maxwellBoltzmann.params.map((p) => p.key));
    for (const preset of presets) {
      expect(Object.keys(preset.values).every((k) => keys.has(k)), preset.id).toBe(true);
      expect(beadsFor(preset.values), preset.id).toBe(preset.values['beads']);
      expect(temperatureFor(preset.values), preset.id).toBe(preset.values['temperature']);
      expect(flatten(preset.caption), preset.id).not.toBe('');
    }
  });

  it('says only what the law says in the captions', () => {
    // Room air: "about half … between 300 and 600 m/s, and one in a hundred tops 1,000 m/s".
    const mid = bandShare(300, 600, A300);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.6);
    expect(speedTail(1_000, A300)).toBeGreaterThan(0.009);
    expect(speedTail(1_000, A300)).toBeLessThan(0.012);
    // Pizza oven: "half again as fast".
    expect(Math.sqrt(700 / 300)).toBeGreaterThan(1.45);
    expect(Math.sqrt(700 / 300)).toBeLessThan(1.55);
    // Xenon: "almost five times as much … under half the speed … the first few slots".
    const ratio = gasById('xenon').mass / N2.mass;
    expect(ratio).toBeGreaterThan(4.5);
    expect(ratio).toBeLessThan(5);
    expect(1 / Math.sqrt(ratio)).toBeLessThan(0.5);
    expect(speedTail(500, thermalScale(300, gasById('xenon').mass))).toBeLessThan(0.01);
  });

  it('sources every fact, and the sound fact’s two shares are the law’s', () => {
    expect(maxwellBoltzmann.facts.length).toBeGreaterThanOrEqual(2);
    for (const fact of maxwellBoltzmann.facts) {
      expect(fact.source.label.length).toBeGreaterThan(10);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
    const sound = flatten(maxwellBoltzmann.facts[1]?.text ?? '');
    expect(sound).toContain(`${Math.round(100 * fasterThanSound(7 / 5))}%`);
    expect(sound).toContain(`${Math.round(100 * fasterThanSound(5 / 3))}%`);
  });

  it('says what it does in one plain sentence', () => {
    const blurb = flatten(maxwellBoltzmann.blurb);
    expect(blurb.split('.').filter((s) => s.trim() !== '')).toHaveLength(1);
    expect(blurb).toMatch(/\bfaster\b/);
    expect(blurb).toMatch(/\bfarther\b/);
    expect(blurb).not.toMatch(JARGON);
  });

  it('never prints a word a newcomer would have to ask about', () => {
    for (const preset of maxwellBoltzmann.presets ?? []) expect(flatten(preset.caption), preset.id).not.toMatch(JARGON);
    for (const fact of maxwellBoltzmann.facts) expect(flatten(fact.text)).not.toMatch(JARGON);
    for (const p of maxwellBoltzmann.params) expect(flatten(p.help ?? ''), p.key).not.toMatch(JARGON);
  });
});
