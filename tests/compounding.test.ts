import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import { verdictOf } from '../src/ui/readouts';
import {
  compounding,
  layoutPlot,
  multipleLabel,
  plotX,
  plotY,
  roundRateFor,
  roundTickStep,
} from '../src/viz/compounding/index';
import {
  BREAK_EVEN_HEADS,
  Crowd,
  DOWN,
  MEAN_FACTOR,
  MEDIAN_FACTOR,
  STEP_DECADES,
  UP,
  decades,
  meanFactorTolerance,
  medianFactorTolerance,
  shareBelowStake,
  shareTolerance,
  spreadDecades,
  wealth,
  wealthWindow,
} from '../src/viz/compounding/growth';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/** The shipped ceilings, mirrored here so a change to either is a failing test. */
const MAX_PLAYERS = 20_000;
const MAX_ROUNDS = 100;
const MAX_PAINTED = 48;

/** The default run: 4,000 players over 40 rounds. */
const DEFAULT_PLAYERS = 4_000;
const DEFAULT_ROUNDS = 40;

/** Run a crowd to the end of its rounds, off any canvas. */
function run(seed: number, players: number, rounds: number): Crowd {
  const rng = createRng(seed);
  const crowd = new Crowd(MAX_PLAYERS, MAX_ROUNDS, MAX_PAINTED);
  crowd.setParams(players, rounds);
  crowd.reset();
  while (!crowd.finished) crowd.play(rng);
  return crowd;
}

// ---------------------------------------------------------------------------
// The closed forms
// ---------------------------------------------------------------------------

describe('the two per-round factors', () => {
  it('are ½(u + d) for the average and √(u·d) for the middle', () => {
    expect(MEAN_FACTOR).toBeCloseTo(1.05, 15);
    expect(MEDIAN_FACTOR).toBeCloseTo(0.9486832980505138, 15);
    // The average grows 5% a round and the middle loses 5.13% a round, forever.
    expect(MEAN_FACTOR - 1).toBeCloseTo(0.05, 12);
    expect(1 - MEDIAN_FACTOR).toBeCloseTo(0.0513167, 7);
  });

  it('put break-even at 55.749% heads, of a fair coin', () => {
    expect(BREAK_EVEN_HEADS).toBeCloseTo(0.5574929506502401, 15);
    // A pile is exactly the stake when that share of flips came up heads.
    expect(wealth(BREAK_EVEN_HEADS * 100, 100)).toBeCloseTo(1, 12);
  });

  it('compound to the numbers the catalogue quotes at a hundred rounds', () => {
    expect(MEAN_FACTOR ** 100).toBeCloseTo(131.50125784630401, 6);
    expect(MEDIAN_FACTOR ** 100).toBeCloseTo(0.005153775207320096, 12);
    expect(1 - shareBelowStake(100)).toBeCloseTo(0.135627, 6);
  });
});

describe('wealth and decades', () => {
  it('is u^k · d^(r−k), and one round of nothing is the stake', () => {
    expect(wealth(0, 0)).toBe(1);
    for (const [k, r] of [[0, 10], [3, 10], [10, 10], [55, 100]] as const) {
      expect(wealth(k, r)).toBeCloseTo(UP ** k * DOWN ** (r - k), 10);
    }
  });

  it('reads the same pile in decades', () => {
    for (const [k, r] of [[0, 10], [7, 20], [55, 100]] as const) {
      expect(decades(k, r)).toBeCloseTo(Math.log10(wealth(k, r)), 10);
    }
  });

  it('fans out as √r, one step at a time', () => {
    expect(STEP_DECADES).toBeCloseTo((Math.log10(UP) - Math.log10(DOWN)) / 2, 15);
    expect(spreadDecades(1)).toBeCloseTo(STEP_DECADES, 15);
    expect(spreadDecades(100) / spreadDecades(25)).toBeCloseTo(2, 12);
  });
});

describe('shareBelowStake', () => {
  it('is the exact binomial tail below the break-even heads count', () => {
    expect(shareBelowStake(0)).toBe(0);
    expect(shareBelowStake(10)).toBeCloseTo(0.623047, 6);
    expect(shareBelowStake(20)).toBeCloseTo(0.748278, 6);
    expect(shareBelowStake(40)).toBeCloseTo(0.785205, 6);
    expect(shareBelowStake(100)).toBeCloseTo(0.864373, 6);
  });

  it('is not monotonic in the round count, because the boundary is a lattice', () => {
    // 0.5574930·r sweeps past whole heads at its own pace: 11.15 heads at twenty
    // rounds, 16.72 at thirty. Worth pinning, because it looks like a bug.
    expect(shareBelowStake(30)).toBeLessThan(shareBelowStake(20));
    expect(shareBelowStake(80)).toBeLessThan(shareBelowStake(70));
  });

  it('is a probability at every round count the fader offers', () => {
    for (let r = 10; r <= MAX_ROUNDS; r += 10) {
      const p = shareBelowStake(r);
      expect(p, `${r} rounds`).toBeGreaterThan(0.5);
      expect(p, `${r} rounds`).toBeLessThan(1);
    }
  });
});

describe('wealthWindow', () => {
  it('holds both curves and most of the fan, at every round count the fader offers', () => {
    for (let r = 10; r <= MAX_ROUNDS; r += 10) {
      const win = wealthWindow(r);
      const average = r * Math.log10(MEAN_FACTOR);
      const middle = r * Math.log10(MEDIAN_FACTOR);
      expect(win.top, `${r} rounds`).toBeGreaterThanOrEqual(average);
      expect(win.bottom, `${r} rounds`).toBeLessThanOrEqual(middle);
      // 2.2 standard deviations of the fan below the middle, which leaves 1.4%
      // of players off the bottom of the plate.
      expect(win.bottom, `${r} rounds`).toBeLessThanOrEqual(middle - 2.2 * spreadDecades(r));
      // The stake is never on an edge.
      expect(win.top, `${r} rounds`).toBeGreaterThanOrEqual(1);
      expect(win.bottom, `${r} rounds`).toBeLessThanOrEqual(-1);
      expect(Number.isInteger(win.top) && Number.isInteger(win.bottom)).toBe(true);
    }
  });

  it('depends on the round count alone, so the axis cannot move under a run', () => {
    expect(wealthWindow(40)).toEqual(wealthWindow(40));
    expect(wealthWindow(100).bottom).toBeLessThan(wealthWindow(10).bottom);
  });
});

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

describe('compounding convergence', () => {
  it('lands all three readings inside their derived allowances on the default run', () => {
    const crowd = run(SEED, DEFAULT_PLAYERS, DEFAULT_ROUNDS);
    const s = crowd.read();
    expect(s.round).toBe(DEFAULT_ROUNDS);

    // Measured at seed 42, 4,000 players, 40 rounds. Pinned so a change to the
    // draw order or the summaries shows up as a failure rather than as drift.
    expect(s.meanFactor).toBeCloseTo(1.041997, 6);
    expect(s.medianFactor).toBeCloseTo(0.9486832980505138, 12);
    expect(s.shareBelow).toBeCloseTo(0.79325, 5);

    const meanOff = Math.abs(s.meanFactor - MEAN_FACTOR) / MEAN_FACTOR;
    const medianOff = Math.abs(s.medianFactor - MEDIAN_FACTOR) / MEDIAN_FACTOR;
    const target = shareBelowStake(DEFAULT_ROUNDS);
    const shareOff = Math.abs(s.shareBelow - target) / target;

    // 0.76% against an allowance of 3.29%, exactly 0% against 0.87%, and 1.02%
    // against 2.48%.
    expect(meanOff).toBeLessThan(meanFactorTolerance(DEFAULT_PLAYERS, DEFAULT_ROUNDS));
    expect(medianOff).toBeLessThan(medianFactorTolerance(DEFAULT_PLAYERS, DEFAULT_ROUNDS));
    expect(shareOff).toBeLessThan(shareTolerance(DEFAULT_PLAYERS, DEFAULT_ROUNDS));
  });

  it('stays inside them across the corners of the slider grid', () => {
    const grid: ReadonlyArray<readonly [number, number]> = [
      [500, 10],
      [500, 100],
      [4_000, 40],
      [20_000, 10],
      [20_000, 100],
    ];
    for (const [players, rounds] of grid) {
      const target = shareBelowStake(rounds);
      for (let seed = 1; seed <= 5; seed++) {
        const s = run(seed, players, rounds).read();
        const label = `${players}/${rounds}/seed ${seed}`;
        expect(Math.abs(s.meanFactor - MEAN_FACTOR) / MEAN_FACTOR, label).toBeLessThan(
          meanFactorTolerance(players, rounds),
        );
        expect(Math.abs(s.medianFactor - MEDIAN_FACTOR) / MEDIAN_FACTOR, label).toBeLessThan(
          medianFactorTolerance(players, rounds),
        );
        expect(Math.abs(s.shareBelow - target) / target, label).toBeLessThan(shareTolerance(players, rounds));
      }
    }
  });

  it('puts the middle exactly on √(u·d) per round at an even round count', () => {
    // Not approximately: the median of Binomial(r, ½) is exactly r/2 for even r,
    // and a crowd this size finds it every time.
    for (const rounds of [10, 40, 100]) {
      const s = run(7, 20_000, rounds).read();
      expect(s.medianFactor, `${rounds} rounds`).toBeCloseTo(MEDIAN_FACTOR, 12);
      expect(s.medianWealth, `${rounds} rounds`).toBeCloseTo(MEDIAN_FACTOR ** rounds, 12);
    }
  });

  it('sends the average up and the middle down at the same time, from the same run', () => {
    const s = run(SEED, DEFAULT_PLAYERS, 100).read();
    // This is the whole tab in two assertions.
    expect(s.meanWealth).toBeGreaterThan(20);
    expect(s.medianWealth).toBeLessThan(0.01);
    expect(s.shareBelow).toBeGreaterThan(0.8);
    // …and the gap is carried by a handful of players: forty of the four
    // thousand hold 86% of the money between them.
    expect(s.topShare).toBeGreaterThan(0.8);
    expect(s.richest).toBeGreaterThan(1_000);
  });

  it('reproduces a run from its seed and differs between seeds', () => {
    expect(run(SEED, 2_000, 30).read()).toEqual(run(SEED, 2_000, 30).read());
    expect(run(1, 2_000, 30).read().shareBelow).not.toBe(run(2, 2_000, 30).read().shareBelow);
  });
});

describe('the allowances themselves', () => {
  it('tighten as the crowd grows and widen as the rounds pile up', () => {
    expect(meanFactorTolerance(20_000, 40)).toBeLessThan(meanFactorTolerance(500, 40));
    expect(meanFactorTolerance(4_000, 100)).toBeGreaterThan(meanFactorTolerance(4_000, 40));
    expect(shareTolerance(20_000, 40)).toBeLessThan(shareTolerance(500, 40));
    expect(medianFactorTolerance(20_000, 40)).toBeLessThan(medianFactorTolerance(500, 40));
  });

  it('admit how loosely the middle is even defined at an odd round count', () => {
    // The middle is an interval there, and its ends are ±ln(u/d)/(2r) away from
    // the geometric midpoint the target quotes: 4.25% at eleven rounds. A run
    // lands on one end or the other, so it needs the wider allowance and would
    // miss the one an even count gets.
    const odd = medianFactorTolerance(4_000, 11);
    expect(odd).toBeGreaterThan(Math.expm1(Math.log(UP / DOWN) / 22));
    const off = Math.abs(run(1, 4_000, 11).read().medianFactor - MEDIAN_FACTOR) / MEDIAN_FACTOR;
    expect(off).toBeGreaterThan(medianFactorTolerance(4_000, 10));
    expect(off).toBeLessThan(odd);
    // The fader offers only even counts, where the term is gone entirely and
    // all that is left is 0.87% of sampling noise.
    expect(medianFactorTolerance(4_000, 40)).toBeCloseTo(0.008667, 6);
  });

  it('degrade to something finite before the first round', () => {
    for (const t of [meanFactorTolerance(4_000, 0), medianFactorTolerance(4_000, 0), shareTolerance(4_000, 0)]) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
    }
  });
});

describe('Crowd', () => {
  it('stops at exactly its round count and stays there', () => {
    const rng = createRng(SEED);
    const crowd = new Crowd(MAX_PLAYERS, MAX_ROUNDS, MAX_PAINTED);
    crowd.setParams(1_000, 20);
    crowd.reset();
    for (let i = 0; i < 50; i++) crowd.play(rng);
    expect(crowd.round).toBe(20);
    expect(crowd.finished).toBe(true);
  });

  it('starts every player on the stake and returns them there', () => {
    const crowd = run(SEED, 1_000, 20);
    crowd.reset();
    const s = crowd.read();
    expect(s.round).toBe(0);
    expect(s.meanWealth).toBe(1);
    expect(s.medianWealth).toBe(1);
    expect(s.shareBelow).toBe(0);
    // No rate has been seen yet, and the ledger prints a dash rather than a lie.
    expect(s.meanFactor).toBeNaN();
    expect(s.medianFactor).toBeNaN();
    for (let i = 0; i < crowd.paths; i++) expect(crowd.pathAt(i, 0)).toBe(0);
  });

  it('records a path for every player it paints and no more', () => {
    expect(run(SEED, 20_000, 10).paths).toBe(MAX_PAINTED);
    // A crowd smaller than the budget records all of it.
    expect(run(SEED, 20, 10).paths).toBe(20);
  });

  it('keeps each recorded path on the lattice its own player walked', () => {
    const crowd = run(SEED, 1_000, 40);
    for (let i = 0; i < crowd.paths; i++) {
      let previous = 0;
      for (let r = 1; r <= 40; r++) {
        const step = crowd.pathAt(i, r) - previous;
        // One round moves a path by exactly one of the two payoffs.
        expect(Math.min(Math.abs(step - Math.log10(UP)), Math.abs(step - Math.log10(DOWN)))).toBeLessThan(1e-9);
        previous = crowd.pathAt(i, r);
      }
    }
  });

  it('clamps a crowd and a run to the arrays it was built with', () => {
    const crowd = new Crowd(100, 10, 4);
    crowd.setParams(1e6, 1e6);
    expect(crowd.players).toBe(100);
    expect(crowd.rounds).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Layout — pure, and the part of the painter a test can reach
// ---------------------------------------------------------------------------

describe('layoutPlot', () => {
  it('leaves the plate edges and the axis gutters clear', () => {
    const box = layoutPlot(720, 448);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(720 - 8);
    expect(box.y + box.height).toBeLessThanOrEqual(448 - 8);
  });

  it('never produces a box of negative size on a plate too small for its gutters', () => {
    for (const [w, h] of [[40, 30], [1, 1], [100, 60]] as const) {
      const box = layoutPlot(w, h);
      expect(box.width, `${w}×${h}`).toBeGreaterThan(0);
      expect(box.height, `${w}×${h}`).toBeGreaterThan(0);
    }
  });
});

describe('plotX and plotY', () => {
  const box = layoutPlot(720, 448);
  const win = wealthWindow(40);

  it('runs the rounds edge to edge', () => {
    expect(plotX(box, 0, 40)).toBeCloseTo(box.x, 10);
    expect(plotX(box, 40, 40)).toBeCloseTo(box.x + box.width, 10);
    expect(plotX(box, 20, 40)).toBeCloseTo(box.x + box.width / 2, 10);
  });

  it('puts the top decade at the top and the stake where the window says', () => {
    expect(plotY(box, win, win.top)).toBeCloseTo(box.y, 10);
    expect(plotY(box, win, win.bottom)).toBeCloseTo(box.y + box.height, 10);
    expect(plotY(box, win, 0)).toBeGreaterThan(box.y);
    expect(plotY(box, win, 0)).toBeLessThan(box.y + box.height);
  });

  it('rides the floor rather than leaving the box, at any round count', () => {
    for (let r = 10; r <= MAX_ROUNDS; r += 10) {
      const w = wealthWindow(r);
      for (const decade of [-40, -9, 0, 9, 40]) {
        const y = plotY(box, w, decade, 3);
        expect(y, `${r}/${decade}`).toBeGreaterThanOrEqual(box.y + 3 - 1e-9);
        expect(y, `${r}/${decade}`).toBeLessThanOrEqual(box.y + box.height - 3 + 1e-9);
      }
    }
  });
});

describe('the axis furniture', () => {
  it('never asks for more than ten round ticks', () => {
    for (let r = 10; r <= MAX_ROUNDS; r += 10) {
      const step = roundTickStep(r);
      expect(step, `${r} rounds`).toBeGreaterThan(0);
      expect(r / step, `${r} rounds`).toBeLessThanOrEqual(10);
    }
  });

  it('labels the stake in words and the decades as multiples of it', () => {
    expect(multipleLabel(0)).toBe('start');
    expect(multipleLabel(1)).toBe('×10');
    expect(multipleLabel(2)).toBe('×100');
    expect(multipleLabel(3)).toBe('×10³');
    expect(multipleLabel(-1)).toBe('÷10');
    expect(multipleLabel(-2)).toBe('÷100');
    expect(multipleLabel(-8)).toBe('÷10⁸');
    // Nothing on this axis needs two lines or a minus sign.
    for (let d = -12; d <= 12; d++) expect(multipleLabel(d).length).toBeLessThanOrEqual(6);
  });

  it('paces a run so it takes about a quarter of a minute whatever its length', () => {
    for (let r = 10; r <= MAX_ROUNDS; r += 10) {
      const seconds = r / roundRateFor(r);
      expect(seconds, `${r} rounds`).toBeLessThanOrEqual(15);
      expect(seconds, `${r} rounds`).toBeGreaterThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
// ---------------------------------------------------------------------------

type Seg = readonly [number, number, number, number];

/**
 * A path that keeps its segments and counts its subpaths, so a test can see the
 * fan. `lineTo` on an empty path is a `moveTo`, as it is on a real canvas —
 * without that a curve drawn as a run of `lineTo` starts with a phantom segment
 * from the origin, and every "is it inside the box" assertion fails on it.
 */
class RecordingPath {
  readonly segments: Seg[] = [];
  starts = 0;
  private x = 0;
  private y = 0;
  private empty = true;
  moveTo(x: number, y: number): void {
    this.starts++;
    this.empty = false;
    this.x = x;
    this.y = y;
  }
  lineTo(x: number, y: number): void {
    if (this.empty) {
      this.moveTo(x, y);
      return;
    }
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
  starts: number;
  segments: readonly Seg[];
}

/**
 * A canvas context that records the strokes it is asked for, counts every call
 * it takes, and accepts everything else. The call counter is what proves
 * `step()` never touches a canvas.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; strokes: Stroke[]; calls: () => number } {
  const strokes: Stroke[] = [];
  let path = new RecordingPath();
  let count = 0;
  const tally = <T>(value: T): T => {
    count++;
    return value;
  };
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
    clearRect: () => tally(undefined),
    fillRect: () => tally(undefined),
    strokeRect: () => tally(undefined),
    fillText: () => tally(undefined),
    save: () => tally(undefined),
    restore: () => tally(undefined),
    measureText: (text: string) => tally({ width: 6.6 * text.length }),
    beginPath(): void {
      tally(undefined);
      path = new RecordingPath();
    },
    moveTo(x: number, y: number): void {
      tally(undefined);
      path.moveTo(x, y);
    },
    lineTo(x: number, y: number): void {
      tally(undefined);
      path.lineTo(x, y);
    },
    stroke(p?: RecordingPath): void {
      tally(undefined);
      const used = p ?? path;
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        starts: used.starts,
        segments: [...used.segments],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes, calls: () => count };
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
  players: DEFAULT_PLAYERS,
  rounds: DEFAULT_ROUNDS,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 720, height = 448) {
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
  const instance = compounding.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** Play the run out. An hour of simulated time finishes any round count the fader offers. */
function runOut(v: Viz): void {
  v.instance.step(60 * 60 * 1000);
  paint(v);
}

function paint(v: Viz): void {
  v.fg.strokes.length = 0;
  v.instance.draw();
}

function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  if (!absorbed) {
    v.instance.reset();
    v.bg.strokes.length = 0;
    v.instance.drawBackground?.();
  }
  paint(v);
  return absorbed;
}

function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  v.bg.strokes.length = 0;
  v.instance.drawBackground?.();
  paint(v);
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

/** The fan is the first thing painted, and the only graphite stroke before the key. */
function fan(v: Viz): Stroke {
  const stroke = v.fg.strokes[0];
  expect(stroke).toBeDefined();
  expect(stroke?.pen).toBe(THEME.data3);
  return stroke as Stroke;
}

/**
 * Paths painted. Counted by their first segment rather than by subpaths: every
 * painted player starts at the stake on the left edge of the box, and a thread
 * that dives off the plate and climbs back opens a second subpath.
 */
function paintedPaths(v: Viz, width: number, height: number): number {
  const box = layoutPlot(width, height);
  return fan(v).segments.filter(([x0]) => Math.abs(x0 - box.x) < 1e-6).length;
}

describe('compounding readouts', () => {
  it('publishes every reading with its prediction, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 600);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['round', 'below', 'typical', 'average', 'top', 'richest']);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['below']?.target).toBeCloseTo(100 * shareBelowStake(by['round']?.value ?? 0), 10);
    expect(by['typical']?.target).toBe(MEDIAN_FACTOR);
    expect(by['average']?.target).toBe(MEAN_FACTOR);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('makes no claim about the crowd before the first round is played', () => {
    // Nobody is under the stake before the first flip and nothing predicts that
    // they would be, so the row would be holding 0 to 0 — and a declared zero
    // means *exact*, which is a claim about a run that has not started. The
    // percentage also carries the span it is a percentage of, so the band is
    // judged against a hundred points and not against whichever scale is
    // kinder.
    const v = stubViz();
    paint(v);
    const start = v.emitted.at(-1)?.find((r) => r.key === 'below') as Readout;
    expect(ledger(v)['round']).toBe(0);
    expect(start.value).toBe(0);
    expect(start.range).toEqual([0, 100]);
    expect(start.target).toBeUndefined();
    expect(start.tolerance).toBeUndefined();
    expect(start.band).toBeUndefined();
    expect(verdictOf(start).state).toBe('none');

    // One round in it is a measurement again, against the round it has reached.
    tick(v, 120);
    paint(v);
    const playing = v.emitted.at(-1)?.find((r) => r.key === 'below') as Readout;
    const round = ledger(v)['round'] ?? 0;
    expect(round).toBeGreaterThan(0);
    expect(playing.target).toBeCloseTo(100 * shareBelowStake(round), 10);
    expect(playing.range).toEqual([0, 100]);
  });

  it('compares the share against the round it has reached, not the round it is aiming at', () => {
    const v = stubViz();
    tick(v, 300);
    paint(v);
    const mid = v.emitted.at(-1)?.find((r) => r.key === 'below');
    const round = ledger(v)['round'] ?? 0;
    expect(round).toBeGreaterThan(0);
    expect(round).toBeLessThan(DEFAULT_ROUNDS);
    expect(mid?.target).toBeCloseTo(100 * shareBelowStake(round), 10);
  });

  it('marks one headline, and gives every visible reading a lower-case plain label', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const headline = last.filter((r) => r.headline === true);
    expect(headline.map((r) => r.key)).toEqual(['below']);
    expect(headline[0]?.plain).toBe('players poorer than when they started');

    const shown = last.filter((r) => r.expertOnly !== true).map((r) => r.key);
    expect(shown).toEqual(['round', 'below', 'typical', 'average']);
    for (const r of last) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('never prints a word a sixteen-year-old would have to ask about', () => {
    // The simple view shows the plain label and the hint; neither may reach for
    // the vocabulary the exact table is allowed.
    const banned =
      /\b(mean|variance|analytic|converged|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|order parameter|critical exponent|markov|median|logarithm|quantile)\b/i;
    const v = stubViz();
    tick(v, 600);
    paint(v);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(banned);
      expect(r.hint ?? '', r.key).not.toMatch(banned);
    }
  });

  it('draws without moving the simulation, and resets to the stake', () => {
    const v = stubViz();
    tick(v, 600);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['round']).toBe(0);
    expect(ledger(v)['below']).toBe(0);
    v.instance.destroy();
  });

  it('never touches a canvas from step()', () => {
    const v = stubViz();
    const before = v.bg.calls() + v.fg.calls();
    tick(v, 900);
    expect(v.bg.calls() + v.fg.calls()).toBe(before);
  });
});

describe('the run', () => {
  it('stops at exactly the round count and stays there', () => {
    const v = stubViz();
    runOut(v);
    expect(ledger(v)['round']).toBe(DEFAULT_ROUNDS);
    const done = ledger(v);
    tick(v, 2_000);
    paint(v);
    expect(ledger(v)).toEqual(done);
  });

  it('does not care how the driver batched its ticks', () => {
    const many = stubViz();
    tick(many, 1_700);
    paint(many);
    const once = stubViz();
    once.instance.step(1_700 * TICK);
    paint(once);
    expect(ledger(once)).toEqual(ledger(many));
  });

  it('resets on both knobs, so a change is a fresh experiment at the new value', () => {
    for (const [key, value] of [['players', 1_000], ['rounds', 20], ['seed', 7]] as const) {
      const v = stubViz();
      tick(v, 600);
      paint(v);
      expect(setParam(v, key, value), key).toBe(false);
      expect(ledger(v)['round'], key).toBe(0);
      tick(v, 600);
      paint(v);

      const fresh = stubViz({ [key]: value });
      tick(fresh, 600);
      paint(fresh);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('snaps an off-grid permalink onto the even round counts the middle needs', () => {
    const v = stubViz({ rounds: 43 });
    runOut(v);
    expect(ledger(v)['round']).toBe(40);
    expect(ledger(v)['typical']).toBeCloseTo(MEDIAN_FACTOR, 12);
  });

  it('reaches the same readings on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({}, 1_280, 720);
    const narrow = stubViz({}, 320, 300);
    for (const v of [wide, narrow]) {
      tick(v, 900);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
  });
});

describe('the plate', () => {
  it('paints the stake in the apparatus pen and everything containing it in the container pen', () => {
    const v = stubViz();
    const pens = new Set(v.bg.strokes.map((s) => s.pen));
    expect(pens).toEqual(new Set([THEME.gridSoft, THEME.grid]));
    // Exactly one near-black rule: the stake. Everything else is furniture.
    const stake = v.bg.strokes.filter((s) => s.pen === THEME.grid);
    expect(stake).toHaveLength(1);
    expect(stake[0]?.segments).toHaveLength(1);
  });

  it('paints the fan, then the average, then the middle, each at full strength', () => {
    const v = stubViz();
    tick(v, 900);
    paint(v);
    const drawn = v.fg.strokes.filter((s) => s.segments.length > 0);
    expect(drawn.length).toBeGreaterThan(0);
    for (const s of drawn) {
      // A translucent pen composites through the 3:1 a graphical object owes the
      // plate: graphite is 3.61:1 solid and well under 2:1 at any alpha.
      expect(s.alpha).toBe(1);
      expect([THEME.data1, THEME.data2, THEME.data3, THEME.canvas]).toContain(s.pen);
    }
    const pens = drawn.map((s) => s.pen);
    // The halo goes down under each curve, then the pen, then the other pair.
    expect(pens.slice(0, 5)).toEqual([THEME.data3, THEME.canvas, THEME.data2, THEME.canvas, THEME.data1]);
    expect(drawn[1]?.width).toBe(2 * THEME.lineWidth + 4);
    expect(drawn[2]?.width).toBe(2 * THEME.lineWidth);
  });

  it('never draws a path thinner than the graphite pen can carry', () => {
    const v = stubViz();
    tick(v, 900);
    paint(v);
    for (const s of v.fg.strokes) {
      if (s.pen === THEME.data3) expect(s.width).toBeGreaterThanOrEqual(2 * THEME.lineWidth);
    }
  });

  it('holds the ink well under saturation on every plate', () => {
    const plates: ReadonlyArray<readonly [number, number]> = [
      [720, 448],
      [1_280, 720],
      [343, 381], // the phone plate, from `aspectNarrow`
    ];
    for (const [width, height] of plates) {
      const v = stubViz({}, width, height);
      runOut(v);
      const stroke = fan(v);
      let area = 0;
      for (const [x0, y0, x1, y1] of stroke.segments) area += Math.hypot(x1 - x0, y1 - y0) * stroke.width;
      const box = layoutPlot(width, height);
      const inked = 1 - Math.exp(-area / (box.width * box.height));
      expect(inked, `${width}×${height}`).toBeLessThan(0.3);
      expect(paintedPaths(v, width, height), `${width}×${height}`).toBeGreaterThan(8);
      expect(paintedPaths(v, width, height), `${width}×${height}`).toBeLessThanOrEqual(MAX_PAINTED);
    }
  });

  it('paints fewer paths on a smaller plate rather than a denser picture', () => {
    const small = stubViz({}, 360, 300);
    const large = stubViz({}, 1_280, 720);
    for (const v of [small, large]) {
      tick(v, 900);
      paint(v);
    }
    expect(paintedPaths(large, 1_280, 720)).toBe(MAX_PAINTED);
    expect(paintedPaths(small, 360, 300)).toBeLessThan(paintedPaths(large, 1_280, 720));
  });

  it('drops a thread that leaves the plate instead of walking it along the edge', () => {
    // A flat line on this plate reads as a player whose money stopped moving.
    const v = stubViz({ rounds: 100 }, 720, 448);
    runOut(v);
    const box = layoutPlot(720, 448);
    const floor = box.y + box.height - THEME.lineWidth;
    const ceiling = box.y + THEME.lineWidth;
    for (const [, y0, , y1] of fan(v).segments) {
      for (const edge of [floor, ceiling]) {
        expect(Math.abs(y0 - edge) < 0.5 && Math.abs(y1 - edge) < 0.5).toBe(false);
      }
    }
  });

  it('paints the whole crowd’s readings while painting a few dozen of its paths', () => {
    const v = stubViz({ players: 20_000 });
    tick(v, 900);
    paint(v);
    expect(paintedPaths(v, 720, 448)).toBeLessThanOrEqual(MAX_PAINTED);
    expect(ledger(v)['round']).toBeGreaterThan(0);
    // Every reading is over all twenty thousand: a share this smooth cannot come
    // from forty-eight players.
    const target = 100 * shareBelowStake(ledger(v)['round'] ?? 0);
    expect(Math.abs((ledger(v)['below'] ?? 0) - target)).toBeLessThan(3);
  });

  it('keeps every mark inside the box, at any plate size and any round count', () => {
    for (const [width, height] of [[720, 448], [343, 381], [1_280, 720]] as const) {
      for (const rounds of [10, 100]) {
        const v = stubViz({ rounds }, width, height);
        runOut(v);
        const box = layoutPlot(width, height);
        for (const s of v.fg.strokes) {
          for (const [x0, y0, x1, y1] of s.segments) {
            for (const [x, y] of [[x0, y0], [x1, y1]] as const) {
              expect(x, `${width}×${height}/${rounds}`).toBeGreaterThanOrEqual(box.x - 1);
              expect(x, `${width}×${height}/${rounds}`).toBeLessThanOrEqual(box.x + box.width + 1);
              expect(y, `${width}×${height}/${rounds}`).toBeGreaterThanOrEqual(box.y - 1);
              expect(y, `${width}×${height}/${rounds}`).toBeLessThanOrEqual(box.y + box.height + 1);
            }
          }
        }
      }
    }
  });

  it('re-places the paths on the new plate instead of stranding them', () => {
    const v = stubViz({}, 400, 300);
    tick(v, 900);
    paint(v);
    const before = ledger(v);

    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);
    const box = layoutPlot(1_280, 720);
    const xs = fan(v).segments.flatMap(([x0, , x1]) => [x0, x1]);
    expect(Math.min(...xs)).toBeCloseTo(box.x, 6);

    resize(v, 320, 240);
    expect(ledger(v)).toEqual(before);
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

describe('compounding metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(compounding.params.map((p) => p.key)).toEqual(['players', 'rounds', 'seed']);
    expect(compounding.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(compounding.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
  });

  it('offers only even round counts, because the middle pile depends on it', () => {
    const spec = compounding.params.find((p) => p.key === 'rounds');
    expect(spec?.kind).toBe('range');
    if (spec?.kind !== 'range') throw new Error('rounds must be a fader');
    expect(spec.min % 2).toBe(0);
    expect(spec.step % 2).toBe(0);
    for (let r = spec.min; r <= spec.max; r += spec.step) expect(r % 2, `${r} rounds`).toBe(0);
  });

  it('keeps every knob it declares inside the budget it declares', () => {
    const players = compounding.params.find((p) => p.key === 'players');
    if (players?.kind !== 'range') throw new Error('players must be a fader');
    expect(players.max).toBe(compounding.budget?.maxEntities);
  });

  it('offers at most three presets, each one plain sentence, each from a declared parameter', () => {
    const presets = compounding.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.length).toBeLessThanOrEqual(3);
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const [key, value] of Object.entries(preset.values)) {
        expect(compounding.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(
          true,
        );
        if (key === 'rounds') expect(Number(value) % 2, preset.id).toBe(0);
      }
    }
    // Ordered to walk to the insight: the lines part, the lines run away, and
    // then one player in a hundred owns the room.
    expect(presets.map((p) => p.id)).toEqual(['ten-rounds', 'a-hundred-rounds', 'a-big-crowd']);
  });

  it('states at most two facts, one sentence each, and sources both', () => {
    expect(compounding.facts.length).toBeGreaterThan(0);
    expect(compounding.facts.length).toBeLessThanOrEqual(2);
    for (const fact of compounding.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(compounding.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).toMatch(/^Flips /);
  });

  it('keeps its permanent id and a plate that does not depend on a reading', () => {
    expect(compounding.id).toBe('compounding');
    expect(compounding.group).toBe('randomness');
    expect(compounding.aspect ?? 0).toBeGreaterThan(1);
    expect(compounding.aspectNarrow ?? 0).toBeLessThan(compounding.aspect ?? 0);
  });
});
