import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, VizContext } from '../src/core/types';
import { arrivalBand, dla, frameCount, viewReach, walkSpeedFor } from '../src/viz/dla/index';
import {
  CONTACT,
  createCluster,
  fractalDimension,
  radiusOfGyration,
  type Cluster,
  type Lattice,
} from '../src/viz/dla/cluster';

const SEED = 42;

/** The analytic target: Witten and Sander's dimension in two dimensions. */
const ANALYTIC_D = 1.71;

/**
 * Uncertainty on D from one finite cluster.
 *
 * Measured, not guessed: the fit over the growth history at 20,000 particles
 * gives 1.6982, 1.7074, 1.7166, 1.7469, 1.7535, 1.7581 and 1.7662 for seeds
 * 2024, 99, 1234, 42, 7, 3 and 1 — mean 1.735, sample sd 0.027. The fit's own
 * least-squares standard error is ~0.006, but the checkpoints along one growth
 * history are strongly correlated (consecutive ones share 92% of their
 * particles, at eight checkpoints per octave), and inflating it by the √8 that
 * correlation costs gives ~0.017 — the same order, a factor under two apart.
 * The larger of the two is the honest one.
 */
const D_SIGMA = 0.03;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

function grow(seed: number, particles: number, opts: Partial<{ stickiness: number; lattice: Lattice }> = {}): Cluster {
  const c = createCluster(createRng(seed), {
    particles,
    stickiness: opts.stickiness ?? 1,
    lattice: opts.lattice ?? 'off',
  });
  c.grow();
  return c;
}

/** The scale reference: a finished cluster measures R_g ≈ N^(1/1.71) particle radii. */
function scaleReference(n: number): number {
  return n ** (1 / ANALYTIC_D);
}

/**
 * The headless model the tab is driving: the same seed, and the same step
 * budget spent the same way.
 *
 * The rate is a fraction of a step per tick, so the model has to carry the same
 * accumulator — 361.11 steps a tick at the default target drifts by a hundred
 * steps over a thousand ticks if the fraction is dropped.
 */
function twin(ticks: number, particles: number, stickiness = 1): Cluster {
  const c = createCluster(createRng(SEED), {
    particles,
    capacity: 50_000,
    stickiness,
    lattice: 'off',
  });
  let pending = 0;
  for (let i = 0; i < ticks; i++) {
    pending += walkSpeedFor(particles);
    const steps = Math.floor(pending);
    pending -= steps;
    c.advance(steps);
  }
  return c;
}

/**
 * The convergence cluster, grown once and read by three tests. Twenty thousand
 * particles is twenty-four million walk steps and about four seconds; growing
 * it per test would be most of this file's runtime. Nothing here mutates it.
 */
let big: Cluster | null = null;
function bigCluster(): Cluster {
  return (big ??= grow(SEED, 20_000));
}

/** Distance from particle `i` to the nearest particle that arrived before it. */
function nearestEarlier(c: Cluster, i: number): number {
  let best = Infinity;
  for (let j = 0; j < i; j++) {
    const dx = c.xs[i]! - c.xs[j]!;
    const dy = c.ys[i]! - c.ys[j]!;
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe('dla convergence', () => {
  it('measures D within 3σ of 1.71 at twenty thousand particles', () => {
    const c = bigCluster();
    expect(c.count).toBe(20_000);
    const fit = c.dimension();
    // Measured at this seed: D = 1.7469, 1.2σ above the analytic 1.71.
    expect(Math.abs(fit.dimension - ANALYTIC_D)).toBeLessThan(3 * D_SIGMA);
    expect(fit.points).toBeGreaterThan(40);
    // The fit's own error, corrected for the correlation between checkpoints,
    // is the same order as the seed-to-seed spread the tolerance is built on.
    // If this ever fails, the two estimates of the uncertainty have diverged
    // and the tolerance above is no longer the honest one.
    expect(fit.stderr * Math.sqrt(8)).toBeLessThan(2 * D_SIGMA);
  }, 120_000);

  it('gets closer to 1.71 as the cluster grows', () => {
    const c = bigCluster();
    // The same fit, over the history truncated at a thousand particles. A
    // cluster that small is a handful of arms and reads far too compact —
    // 1.49 against 1.75 — which is the finite-size caveat on every DLA
    // dimension estimate, made visible instead of hidden.
    let early = 0;
    while (early < c.historyCount && c.historyN[early]! <= 1_000) early++;
    const small = fractalDimension(c.historyN, c.historyRg, early);
    const large = c.dimension();
    expect(small.points).toBeGreaterThan(3);
    expect(Math.abs(small.dimension - ANALYTIC_D)).toBeGreaterThan(4 * D_SIGMA);
    expect(Math.abs(large.dimension - ANALYTIC_D)).toBeLessThan(Math.abs(small.dimension - ANALYTIC_D));
  }, 120_000);

  it('grows to the verified radius-of-gyration scale, N^(1/1.71) particle radii', () => {
    // The reference the whole tab is calibrated against: 56.8 radii at N = 10³,
    // 218.4 at 10⁴, 559.7 at 5·10⁴. The prefactor is not universal — it depends
    // on the sticking rule and the step size — so this checks that *this*
    // model's prefactor is 1 to within a few per cent, over more than a decade.
    const c = bigCluster();
    for (const n of [1_000, 5_000, 10_000, 20_000]) {
      // The checkpoint nearest n; they are 9% apart, so this is within 5% of n.
      let k = 0;
      for (let i = 0; i < c.historyCount; i++) {
        if (Math.abs(c.historyN[i]! - n) < Math.abs(c.historyN[k]! - n)) k = i;
      }
      const at = c.historyN[k]!;
      const ratio = c.historyRg[k]! / scaleReference(at);
      expect(ratio, `N=${at} R_g=${c.historyRg[k]}`).toBeGreaterThan(0.9);
      expect(ratio, `N=${at} R_g=${c.historyRg[k]}`).toBeLessThan(1.12);
    }
  }, 120_000);

  it('reproduces the cluster exactly from the same seed, and differs between seeds', () => {
    const a = grow(SEED, 1_500);
    const b = grow(SEED, 1_500);
    expect([...a.xs.subarray(0, a.count)]).toEqual([...b.xs.subarray(0, b.count)]);
    expect([...a.ys.subarray(0, a.count)]).toEqual([...b.ys.subarray(0, b.count)]);
    expect(a.relaunches).toBe(b.relaunches);
    expect(a.steps).toBe(b.steps);
    expect(grow(1, 1_500).gyration).not.toBe(grow(2, 1_500).gyration);
  });

  it('publishes a radius of gyration that matches the two-pass computation', () => {
    // The instance reads `gyration` every frame, so it is kept as running
    // moments; this is the one-pass form held against the honest one.
    const c = grow(SEED, 2_000);
    expect(c.gyration).toBeCloseTo(radiusOfGyration(c.xs, c.ys, c.count), 6);
  });
});

// ---------------------------------------------------------------------------
// The moment: screening, and the stickiness slider that switches it off
// ---------------------------------------------------------------------------

describe('dla screening', () => {
  it('packs the same particles into a smaller cluster as stickiness falls', () => {
    const n = 5_000;
    const sticky = grow(SEED, n, { stickiness: 1 });
    const middling = grow(SEED, n, { stickiness: 0.25 });
    const barely = grow(SEED, n, { stickiness: 0.05 });
    // Measured: 149.6, 114.4 and 89.1 particle radii. A wanderer that bounces
    // instead of sticking gets to try again further in, so it reaches the gaps
    // the tips would otherwise have screened.
    expect(middling.gyration).toBeLessThan(0.85 * sticky.gyration);
    expect(barely.gyration).toBeLessThan(0.65 * sticky.gyration);
    // Denser is measurable as well as visible: the dimension of the object it
    // builds at this size rises toward 2, the value for something space-filling.
    expect(barely.dimension().dimension).toBeGreaterThan(sticky.dimension().dimension + 0.1);
    // Bouncing is the mechanism, so there must be a great many bounces.
    expect(barely.bounces).toBeGreaterThan(10 * n);
    expect(sticky.bounces).toBe(0);
  }, 120_000);

  it('gives up on wanderers at the kill radius and counts every one', () => {
    const c = grow(SEED, 2_000);
    // A 2D walk is recurrent, so every one of these would eventually have come
    // back; the count is the honest price of not waiting for it.
    expect(c.relaunches).toBeGreaterThan(0);
    expect(c.relaunches).toBeLessThan(c.count);
    expect(c.killRadius).toBeGreaterThan(c.launchRadius);
    expect(c.launchRadius).toBeGreaterThan(c.clusterRadius);
  });
});

// ---------------------------------------------------------------------------
// The aggregate itself
// ---------------------------------------------------------------------------

describe('dla cluster geometry', () => {
  it('freezes every particle touching the cluster and overlapping nothing', () => {
    const c = grow(SEED, 600);
    let touching = 0;
    for (let i = 1; i < c.count; i++) {
      const d = nearestEarlier(c, i);
      // Off the lattice a particle is placed at exact tangency with whatever it
      // hit, so its nearest neighbour is at the contact distance — never
      // inside it, which a step that simply ended where it ended would allow.
      expect(d, `particle ${i} at ${d}`).toBeGreaterThan(CONTACT - 1e-3);
      if (d < CONTACT + 1e-3) touching++;
    }
    expect(touching).toBe(c.count - 1);
  });

  it('keeps lattice modes on their lattice, and off-lattice off it', () => {
    const square = grow(SEED, 400, { lattice: 'square' });
    for (let i = 0; i < square.count; i++) {
      // Math.abs, because a negative coordinate leaves −0 behind and vitest
      // reads that as different from 0.
      expect(Math.abs(square.xs[i]! % CONTACT)).toBe(0);
      expect(Math.abs(square.ys[i]! % CONTACT)).toBe(0);
    }
    const hex = grow(SEED, 400, { lattice: 'hex' });
    const row = Math.sqrt(3) * (CONTACT / 2);
    for (let i = 0; i < hex.count; i++) {
      const j = hex.ys[i]! / row;
      expect(Math.abs(j - Math.round(j))).toBeLessThan(1e-4);
      // x = 2i + j in units of the lattice constant's half: the rows interleave.
      const k = (hex.xs[i]! - Math.round(j) * (CONTACT / 2)) / CONTACT;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-4);
    }
    // Every lattice neighbour is exactly the lattice constant away, so nothing
    // is missed by the Float32 round trip that the √3 rows go through.
    for (let i = 1; i < hex.count; i++) {
      expect(nearestEarlier(hex, i)).toBeCloseTo(CONTACT, 3);
    }
    const off = grow(SEED, 400);
    const onSquare = [...off.xs.subarray(0, off.count)].filter((x) => x % CONTACT === 0).length;
    expect(onSquare).toBeLessThan(off.count / 10);
  });

  it('stops at the target and never writes past the capacity', () => {
    const c = createCluster(createRng(SEED), { particles: 50, capacity: 200, stickiness: 1, lattice: 'off' });
    c.grow();
    expect(c.count).toBe(50);
    expect(c.done).toBe(true);
    expect(c.advance(10_000)).toBe(0);
    expect(c.capacity).toBe(200);
    // Raising the target continues the same walk rather than restarting it.
    expect(c.retarget(120)).toBe(true);
    c.grow();
    expect(c.count).toBe(120);
    const fresh = createCluster(createRng(SEED), { particles: 120, capacity: 200, stickiness: 1, lattice: 'off' });
    fresh.grow();
    expect([...c.xs.subarray(0, 120)]).toEqual([...fresh.xs.subarray(0, 120)]);
    // …and lowering it below what is already frozen is refused, because there
    // is no honest ledger for it.
    expect(c.retarget(10)).toBe(false);
    expect(c.count).toBe(120);
  });

  it('starts from one seed particle at the origin and records its growth', () => {
    const c = createCluster(createRng(SEED), { particles: 900, stickiness: 1, lattice: 'off' });
    expect(c.count).toBe(1);
    expect(c.xs[0]).toBe(0);
    expect(c.ys[0]).toBe(0);
    expect(c.clusterRadius).toBe(0);
    c.grow();
    // Checkpoints are geometrically spaced from 16, so the fit weights every
    // octave of growth equally rather than the last one.
    expect(c.historyCount).toBeGreaterThan(20);
    for (let i = 1; i < c.historyCount; i++) {
      expect(c.historyN[i]!).toBeGreaterThan(c.historyN[i - 1]!);
      expect(c.historyRg[i]!).toBeGreaterThan(0);
    }
    c.reset();
    expect(c.count).toBe(1);
    expect(c.historyCount).toBe(0);
    expect(c.relaunches).toBe(0);
    expect(c.gyration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

describe('fractalDimension', () => {
  it('recovers the exponent of an exact power law', () => {
    const ns: number[] = [];
    const rgs: number[] = [];
    for (let k = 0; k < 40; k++) {
      const n = 100 * 1.2 ** k;
      ns.push(n);
      rgs.push(n ** (1 / 1.71));
    }
    const fit = fractalDimension(ns, rgs, ns.length, 0);
    expect(fit.dimension).toBeCloseTo(1.71, 10);
    expect(fit.residual).toBeLessThan(1e-12);
    expect(fit.stderr).toBeLessThan(1e-12);
    expect(fit.points).toBe(40);
    // The default cut discards the checkpoints below 300 particles.
    expect(fractalDimension(ns, rgs, ns.length).points).toBe(33);
  });

  it('reports the scatter it is fitting through', () => {
    // A power law with a 1% wobble on R_g: the slope survives, and the error
    // bar the tolerance is built from grows with the noise instead of pretending.
    const ns: number[] = [];
    const clean: number[] = [];
    const noisy: number[] = [];
    for (let k = 0; k < 40; k++) {
      const n = 100 * 1.2 ** k;
      ns.push(n);
      clean.push(n ** (1 / 1.71));
      noisy.push(n ** (1 / 1.71) * (1 + 0.01 * Math.sin(k)));
    }
    const fit = fractalDimension(ns, noisy, ns.length, 0);
    expect(fit.dimension).toBeCloseTo(1.71, 2);
    expect(fit.stderr).toBeGreaterThan(fractalDimension(ns, clean, ns.length, 0).stderr);
    expect(fit.stderr).toBeLessThan(0.01);
  });

  it('discards the small-N transient and refuses to fit too few points', () => {
    const ns = [10, 20, 50, 400, 800, 1_600, 3_200];
    const rgs = ns.map((n) => (n < 300 ? 5 * n ** (1 / 1.2) : n ** (1 / 1.71)));
    // With the transient in, the slope is dragged well off; with it out, exact.
    expect(fractalDimension(ns, rgs, ns.length, 0).dimension).not.toBeCloseTo(1.71, 2);
    expect(fractalDimension(ns, rgs, ns.length, 300).dimension).toBeCloseTo(1.71, 10);
    expect(fractalDimension(ns, rgs, 2).dimension).toBeNaN();
    expect(fractalDimension(ns, rgs, 2).stderr).toBe(Infinity);
    // A history with no spread in R_g has no slope to fit.
    expect(fractalDimension([1_000, 2_000, 4_000], [50, 50, 50], 3).dimension).toBeNaN();
  });
});

describe('radiusOfGyration', () => {
  it('is the RMS distance from the centre of mass, not from the origin', () => {
    // Four points on a circle of radius 5 about (100, 0).
    const xs = [105, 100, 95, 100];
    const ys = [0, 5, 0, -5];
    expect(radiusOfGyration(xs, ys, 4)).toBeCloseTo(5, 12);
    // One point has no spread; none has no answer.
    expect(radiusOfGyration(xs, ys, 1)).toBe(0);
    expect(radiusOfGyration(xs, ys, 0)).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

interface Shape {
  kind: 'arc' | 'rect';
  x: number;
  y: number;
  size: number;
}

interface Paint {
  pen: string;
  alpha: number;
  shapes: readonly Shape[];
}

/**
 * A canvas context that records the fills and strokes it is asked for and
 * accepts everything else. Every grain, the launch circle and the display
 * window all arrive through this, so a test can check what was painted, in
 * which pen, and at what alpha.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  fills: Paint[];
  strokes: Paint[];
  clears: number;
} {
  const fills: Paint[] = [];
  const strokes: Paint[] = [];
  let shapes: Shape[] = [];
  const state = { clears: 0 };
  const api = {
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    clearRect: (): void => {
      state.clears++;
    },
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillText: () => undefined,
    setLineDash: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: () => ({ width: 48 }),
    beginPath(): void {
      shapes = [];
    },
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc(x: number, y: number, r: number): void {
      shapes.push({ kind: 'arc', x, y, size: r });
    },
    rect(x: number, y: number, w: number): void {
      shapes.push({ kind: 'rect', x, y, size: w });
    },
    fill(): void {
      fills.push({ pen: String(api.fillStyle), alpha: api.globalAlpha, shapes: [...shapes] });
    },
    stroke(): void {
      strokes.push({ pen: String(api.strokeStyle), alpha: api.globalAlpha, shapes: [...shapes] });
    },
  };
  return {
    ctx: api as unknown as CanvasRenderingContext2D,
    fills,
    strokes,
    get clears() {
      return state.clears;
    },
  };
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

/** What coerceParams() hands the tab: its two controls and the permalink's seed. */
const DEFAULTS: Record<string, ParamValue> = {
  particles: 2_000,
  stickiness: 1,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 440, height = 440) {
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
  const instance = dla.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Stub = ReturnType<typeof stubViz>;

function tick(v: Stub, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

function paint(v: Stub): void {
  v.bg.fills.length = 0;
  v.fg.fills.length = 0;
  v.fg.strokes.length = 0;
  v.instance.draw();
}

/** Exactly what src/main.ts does with a control change. */
function setParam(v: Stub, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

function ledger(v: Stub): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

function grains(paints: readonly Paint[]): Shape[] {
  return paints.flatMap((p) => [...p.shapes]);
}

/**
 * Particles painted, not marks painted: with arrival colouring on, a grain is
 * an opaque graphite mark plus the signal pen over it, so the graphite pass is
 * the one that counts them.
 */
function grainCount(paints: readonly Paint[]): number {
  const base = paints.filter((p) => p.pen === THEME.data3);
  return base.length > 0 ? grains(base).length : grains(paints).length;
}

describe('dla instance: readouts', () => {
  it('publishes every number it draws, with the analytic target, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 3_000);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['particles', 'gyration', 'dimension', 'relaunched']);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    // The dimension is the only row with a target, so it is the hero: 1.71 has
    // no closed form to print beside it, which is why it carries no formula.
    expect(by['dimension']?.target).toBe(ANALYTIC_D);
    expect(by['dimension']?.formula).toBeUndefined();
    // The band is three standard errors of *this* fit, taken from the fit and
    // nowhere else. The old `Math.max(0.05, …)` was a floor, so a fit spanning a
    // third of an octave was judged by the precision of one spanning seven.
    const fit = twin(3_000, 2_000).dimension();
    expect(by['dimension']?.value).toBe(fit.dimension);
    expect(by['dimension']?.band).toEqual({ kind: 'absolute', half: 3 * fit.stderr });
    expect(by['dimension']?.tolerance).toBeUndefined();
    expect(3 * fit.stderr).toBeGreaterThan(0);
    expect(by['gyration']?.target).toBeUndefined();
    expect(by['particles']?.value).toBeGreaterThan(0);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('publishes no band at all while the fit has no octave to work with', () => {
    // Four checkpoints spanning N = 305 to 400 is 0.27 of a natural log unit,
    // and a slope through them is noise. The fit refuses, the reading does not
    // exist, and the ledger prints an em dash rather than 1.747 under a check
    // mark that says 1.710.
    const v = stubViz();
    tick(v, 400);
    paint(v);
    const row = (v.emitted.at(-1) ?? []).find((r) => r.key === 'dimension');
    expect(row?.value).toBeNaN();
    expect(row?.band).toBeUndefined();
    expect(row?.tolerance).toBeUndefined();
  });

  it('marks one plain-language headline and demotes the bookkeeping to the exact table', () => {
    const v = stubViz();
    tick(v, 400);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const by = Object.fromEntries(last.map((r) => [r.key, r]));
    // The dimension is the one number a newcomer reads, in words that need no
    // statistics; the hint says what the scale means.
    expect(last.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['dimension']);
    expect(by['dimension']?.plain).toBe('how feathery the cluster is');
    expect(by['dimension']?.hint).toBe('a solid blob would score 2, a line 1');
    expect(by['dimension']?.expertOnly).toBeUndefined();
    expect(by['particles']?.plain).toBe('particles stuck');
    expect(by['particles']?.expertOnly).toBeUndefined();
    // The radius of gyration and the relaunch count are the model's own
    // bookkeeping: still published, still tested, never in the simple view.
    expect(by['gyration']?.expertOnly).toBe(true);
    expect(by['relaunched']?.expertOnly).toBe(true);
  });

  it('draws without mutating the simulation, and resets to a single seed particle', () => {
    const v = stubViz();
    tick(v, 300);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['particles']).toBe(1);
    expect(ledger(v)['relaunched']).toBe(0);
    v.instance.destroy();
  });

  it('grows the headless model’s cluster step for step — the clock is fixed and is not the physics', () => {
    // The tab's step rate is derived from the particle target so that a run of
    // any length takes about the same clock, and a thousand ticks is exactly
    // that many steps in the model: the same particles in the same places,
    // because the RNG is consulted only inside the walk. That is what lets the
    // transport own the speed without a slider on the tab.
    const v = stubViz();
    tick(v, 1_000);
    paint(v);
    const model = twin(1_000, 2_000);
    expect(model.count).toBeGreaterThan(20);
    expect(ledger(v)['particles']).toBe(model.count);
    expect(ledger(v)['gyration']).toBe(model.gyration);
    expect(ledger(v)['relaunched']).toBe(model.relaunches);
  });

  it('grows the same cluster on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({}, 1_280, 720);
    const phone = stubViz({}, 343, 343);
    for (const v of [wide, phone]) {
      tick(v, 400);
      paint(v);
    }
    expect(ledger(phone)).toEqual(ledger(wide));
    expect(ledger(wide)['particles']).toBeGreaterThan(20);
  });
});

describe('dla instance: painting', () => {
  it('paints the cluster once onto the background and only adds to it between rescales', () => {
    // The seed went down in the first drawBackground(), framed for itself. The
    // cluster has since outgrown that frame, so this frame is a rescale and
    // repaints every grain at the new scale — which is the whole of what a
    // rescale costs, and there are ten of them in a fifty-thousand run.
    const v = stubViz();
    tick(v, 400);
    paint(v);
    const first = ledger(v)['particles'] ?? 0;
    expect(first).toBeGreaterThan(frameCount(1));
    expect(grainCount(v.bg.fills)).toBe(first);

    // A frame with no arrivals repaints nothing at all: a frozen particle never
    // moves, so fifty thousand of them are painted once and then left alone.
    paint(v);
    expect(grains(v.bg.fills)).toHaveLength(0);

    tick(v, 200);
    paint(v);
    const after = ledger(v)['particles'] ?? 0;
    const added = grainCount(v.bg.fills);
    expect(added).toBeGreaterThan(0);
    // Inside one octave only the arrivals are painted; across one, every grain
    // is, and nothing else ever repaints the layer.
    expect(added).toBe(frameCount(first) === frameCount(after) ? after - first : after);
    // The foreground carries the live wanderer and the launch circle only.
    expect(v.fg.clears).toBeGreaterThan(0);
    expect(grains(v.fg.fills).length).toBeLessThanOrEqual(1);
    expect(v.fg.strokes).toHaveLength(1);
    expect(v.fg.strokes[0]?.pen).toBe(THEME.gridSoft);
    expect(v.fg.strokes[0]?.alpha).toBe(1);
  });

  it('frames the cluster it has, so the top of the fader does not open on one lit pixel', () => {
    // The frame used to be pre-scaled to the *finished* cluster: fifty thousand
    // particles frame a world 1,355 particle radii across, so on a 440 px plate
    // the whole of a young cluster was ten pixels wide and the plate read as
    // blank for the first several minutes of the run.
    const v = stubViz({ particles: 50_000 });
    tick(v, 20);
    paint(v);
    const n = ledger(v)['particles'] ?? 0;
    expect(n).toBeGreaterThan(100);
    const marks = grains(v.bg.fills.filter((p) => p.pen === THEME.data3));
    expect(marks).toHaveLength(n);
    // Every grain is at least a whole CSS pixel…
    for (const m of marks) expect(m.size).toBeGreaterThanOrEqual(1);
    // …and the cluster occupies a useful part of the plate rather than a speck
    // at the middle of it. Framed for the target this extent was 10 px.
    const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
    const extent = Math.max(spread(marks.map((m) => m.x)), spread(marks.map((m) => m.y)));
    expect(extent).toBeGreaterThan(440 / 5);
  });

  it('repaints every grain on a resize, at the new scale', () => {
    const v = stubViz({}, 440, 440);
    tick(v, 400);
    paint(v);
    const n = ledger(v)['particles'] ?? 0;
    expect(n).toBeGreaterThan(10);

    v.ctx.width = 880;
    v.ctx.height = 880;
    v.bg.fills.length = 0;
    v.instance.drawBackground?.();
    expect(grainCount(v.bg.fills)).toBe(n);
    // Twice the plate is twice the scale: the cluster is drawn about the new
    // centre, and the counters do not notice.
    paint(v);
    expect(ledger(v)['particles']).toBe(n);
  });

  it('colours by arrival with theme tokens only, and never alpha over the bare plate', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    const pens = new Set(v.bg.fills.map((p) => p.pen));
    // Two pens, both from the theme. The ramp is the signal pen composited over
    // an opaque graphite grain — the worst contrast on it is graphite's own
    // 3.61:1 on the white plate, the best vermilion's 4.80:1.
    expect([...pens].sort()).toEqual([THEME.data3, THEME.data1].sort());
    for (const p of v.bg.fills) {
      if (p.alpha < 1) expect(p.pen).toBe(THEME.data1);
      expect(p.alpha).toBeGreaterThan(0);
    }
    const graphite = v.bg.fills.filter((p) => p.pen === THEME.data3);
    for (const p of graphite) expect(p.alpha).toBe(1);
    // Every grain gets the opaque base: as many graphite marks as vermilion.
    expect(grains(graphite)).toHaveLength(grains(v.bg.fills.filter((p) => p.pen === THEME.data1)).length);
  });

  it('draws discs where there is room for one and pixel-snapped squares where there is not', () => {
    // A hundred particles on a 440 px plate: the view is 47 radii across, so a
    // grain is 4.6 px and §7's arc with r ≥ 1.5 fits.
    const few = stubViz({ particles: 100 });
    tick(few, 400);
    paint(few);
    const discs = grains(few.bg.fills);
    expect(discs.length).toBeGreaterThan(0);
    for (const s of discs) {
      expect(s.kind).toBe('arc');
      expect(s.size).toBeGreaterThanOrEqual(1.5);
    }

    // Fifty thousand: the same plate holds 2,800 radii, so a grain is a third
    // of a pixel. It is drawn as a whole-pixel square at full coverage instead,
    // because an anti-aliased arc in the signal pen measures 2.20:1.
    const many = stubViz({ particles: 50_000 });
    tick(many, 400);
    paint(many);
    const squares = grains(many.bg.fills);
    expect(squares.length).toBeGreaterThan(0);
    for (const s of squares) {
      expect(s.kind).toBe('rect');
      expect(s.size).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(s.x)).toBe(true);
      expect(Number.isInteger(s.y)).toBe(true);
    }
  });
});

describe('dla instance: parameters', () => {
  it('defers a change of experiment to the shell', () => {
    const v = stubViz();
    tick(v, 200);
    // The particles already frozen belong to the old stickiness or the old
    // seed, so there is no live absorption: the shell resets.
    expect(v.instance.onParamChange?.('stickiness', 0.05)).toBe(false);
    expect(v.instance.onParamChange?.('seed', 7)).toBe(false);
  });

  it('honours the permalink’s seed with no control for it', () => {
    // The seed is declared so coerceParams() keeps it, and the rail skips it.
    // Two runs from one seed are one cluster; a different seed is a different one.
    const a = stubViz({ seed: 7 });
    const b = stubViz({ seed: 7 });
    const c = stubViz({ seed: 8 });
    for (const v of [a, b, c]) {
      tick(v, 400);
      paint(v);
    }
    expect(ledger(a)).toEqual(ledger(b));
    expect(ledger(c)['gyration']).not.toBe(ledger(a)['gyration']);
  });

  it('absorbs a raised particle target as a prefix continuation, and resets on a lowered one', () => {
    const v = stubViz({ particles: 2_000 });
    tick(v, 400);
    paint(v);
    const n = ledger(v)['particles'] ?? 0;
    expect(n).toBeGreaterThan(10);

    expect(setParam(v, 'particles', 5_000)).toBe(true);
    expect(ledger(v)['particles']).toBe(n);
    // The scale and the arrival bands both come from the target, so every grain
    // moved: the layer is repainted in full.
    expect(grainCount(v.bg.fills)).toBe(n);

    // Below what is already frozen there is no honest ledger, so the shell resets.
    tick(v, 4_000);
    paint(v);
    expect(ledger(v)['particles']).toBeGreaterThan(100);
    expect(setParam(v, 'particles', 100)).toBe(false);
    expect(ledger(v)['particles']).toBe(1);
  });

  it('stops at the target and stays there', () => {
    const v = stubViz({ particles: 100 });
    tick(v, 4_000);
    paint(v);
    expect(ledger(v)['particles']).toBe(100);
    tick(v, 1_000);
    paint(v);
    expect(ledger(v)['particles']).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Layout helpers and metadata
// ---------------------------------------------------------------------------

describe('viewReach and arrivalBand', () => {
  it('frames the finished cluster with room for the launch circle', () => {
    // The outermost particle sits at about 1.85·N^(1/1.71) and the launch
    // circle six radii beyond it; the view holds both at every count.
    for (const [n, measured] of [
      [1_000, 122],
      [5_000, 267],
      [20_000, 620],
      [50_000, 1_021],
    ] as const) {
      expect(viewReach(n)).toBeGreaterThan(measured + 6);
      expect(viewReach(n)).toBeLessThan(2 * measured);
    }
    // A one-particle cluster is not drawn at 200× zoom.
    expect(viewReach(1)).toBeGreaterThan(12);
  });

  it('assigns arrival bands monotonically and covers the whole ramp', () => {
    const target = 2_000;
    let previous = 0;
    const seen = new Set<number>();
    for (let i = 0; i < target; i++) {
      const b = arrivalBand(i, target);
      expect(b).toBeGreaterThanOrEqual(previous);
      expect(b).toBeLessThan(8);
      previous = b;
      seen.add(b);
    }
    expect(seen.size).toBe(8);
    expect(arrivalBand(0, target)).toBe(0);
    expect(arrivalBand(target - 1, target)).toBe(7);
    // Past the target — a run whose ceiling was raised mid-flight — clamps.
    expect(arrivalBand(target + 500, target)).toBe(7);
  });
});

/**
 * One sentence: ends in a full stop and has no sentence break inside it. A
 * decimal point — "1.71" — is not a break, which is why this is not indexOf.
 */
function expectOneSentence(text: string): void {
  expect(text.endsWith('.')).toBe(true);
  expect(text).not.toMatch(/[.!?]\s/);
}

describe('dla metadata', () => {
  it('declares two controls and the seed, and nothing else', () => {
    expect(dla.id).toBe('dla');
    expect(dla.group).toBe('randomness');
    // Particles and stickiness are the whole rail: the lattice, the walk speed
    // and the arrival colouring are fixed constants now. The seed is declared
    // for the permalink and is not rendered.
    expect(dla.params.map((p) => p.key)).toEqual(['particles', 'stickiness', 'seed']);
    expect(dla.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(dla.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    expect(dla.budget?.maxEntities).toBe(50_000);
  });

  it('describes itself in one plain sentence', () => {
    const blurb = typeof dla.blurb === 'string' ? dla.blurb : '';
    expect(blurb.length).toBeGreaterThan(0);
    expectOneSentence(blurb);
  });

  it('walks three presets from one particle to the stickiness moment, each with one plain caption', () => {
    const presets = dla.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.length).toBeLessThanOrEqual(3);
    // Ordered so trying them in turn reaches the insight: the mechanism one
    // particle at a time, then the sticky cluster, then the same count barely
    // sticky and visibly denser.
    expect(presets.map((p) => p.id)).toEqual(['a-hundred', 'sticky', 'barely-sticky']);
    const sticky = presets.find((p) => p.id === 'sticky');
    const barely = presets.find((p) => p.id === 'barely-sticky');
    expect(barely?.values['particles']).toBe(sticky?.values['particles']);
    expect(barely?.values['stickiness']).toBeLessThan(Number(sticky?.values['stickiness']));
    for (const preset of presets) {
      // A caption is one sentence of plain words, with no variable in it.
      expect(typeof preset.caption).toBe('string');
      expectOneSentence(String(preset.caption));
    }
  });

  it('sets every preset value from a declared parameter, and keeps them inside its range', () => {
    expect(dla.presets?.map((p) => p.id)).toContain('barely-sticky');
    for (const preset of dla.presets ?? []) {
      for (const [key, value] of Object.entries(preset.values)) {
        const spec = dla.params.find((p) => p.key === key);
        expect(spec, `preset ${preset.id} sets unknown param ${key}`).toBeDefined();
        if (spec?.kind === 'range' && typeof value === 'number') {
          expect(value, `preset ${preset.id}.${key}`).toBeGreaterThanOrEqual(spec.min);
          expect(value, `preset ${preset.id}.${key}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec?.kind === 'choice') {
          expect(spec.options.map((o) => o.value)).toContain(value);
        }
      }
    }
  });

  it('offers at most two facts, one sentence each, every one sourced', () => {
    expect(dla.facts.length).toBeGreaterThan(0);
    expect(dla.facts.length).toBeLessThanOrEqual(2);
    for (const fact of dla.facts) {
      expect(typeof fact.text).toBe('string');
      expectOneSentence(String(fact.text));
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });
});
