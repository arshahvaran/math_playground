import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Prose, Readout, VizContext } from '../src/core/types';
import {
  axisRange,
  layoutPlot,
  niceCeil,
  parrondo,
  plotX,
  plotY,
  vertexStride,
  type Rect,
} from '../src/viz/parrondo/index';
import {
  A_ONLY,
  B_ONLY,
  MODULUS,
  RULES,
  RULE_A,
  RULE_B,
  RULE_TURNS,
  TAKING_TURNS,
  Table,
  expectedMoney,
  remainder,
  solveRule,
  solveShares,
  transitionMatrix,
  winProbability,
  type Rule,
} from '../src/viz/parrondo/games';

/** The tilt the tab opens on, as the chain sees it. */
const EPS = 0.005;

/** The fixed run: `MAX_ROUNDS` in the module. */
const ROUNDS = 3_000;
/** The player ceiling the purses are allocated at: `MAX_PLAYERS` in the module. */
const MAX_PLAYERS = 2_000;
const PLAYERS = 400;
const SEED = 42;

/** The engine's tick: 120 Hz. At the fixed 250 rounds/s that is 25 rounds per twelve ticks. */
const TICK = 1000 / 120;
/** `ROUND_RATE` in the module. */
const ROUND_RATE = 250;

/** The strict alternation, which is *not* the rule the tab plays. */
const RULE_ABAB: Rule = ['A', 'B'];

function runTable(seed: number, players: number, eps: number, rounds = ROUNDS): Table {
  const rng = createRng(seed);
  const table = new Table(MAX_PLAYERS, rounds);
  table.configure(players, eps);
  for (let i = 0; i < rounds; i++) table.playRound(rng);
  return table;
}

/**
 * Four standard errors on the average purse after `rounds` rounds at `players`
 * players, in coins.
 *
 * Each round moves a purse by exactly ±1, so one round's spread is one coin,
 * and the mod-3 rule makes consecutive rounds *negatively* correlated — so one
 * coin per round is an upper bound on the long-run spread, not an estimate of
 * it. (Measured over five seeds at 3,000 rounds: 1.00 coins for game A, which
 * is the independent case, 0.74 for game B and 0.93 for taking turns.) The
 * average of `players` independent purses therefore sits within √(rounds /
 * players) of its prediction, and four of those is 10.95 coins at the run this
 * suite drives. Nothing here was widened to make a number pass.
 */
function purseTolerance(rounds: number, players: number): number {
  return 4 * Math.sqrt(rounds / players);
}

/**
 * The same bound expressed as coins per hundred rounds, with the start-up
 * offset added.
 *
 * `solveRule` returns the settled drift, which a finite run does not quite
 * reach: everybody starts on nothing, and nothing is a multiple of three, so
 * game B's first rounds are played on its bad coin. The whole of that effect is
 * a constant — the difference between the exact expected money and `drift ·
 * rounds` — and it is worth 0.017 coins per hundred rounds at 3,000 rounds
 * against a standard error of 0.091.
 */
function gainTolerance(rule: Rule, eps: number, rounds: number, players: number): number {
  const startUp = Math.abs(expectedMoney(rule, eps, rounds) - rounds * solveRule(rule, eps).drift);
  return (100 * (purseTolerance(rounds, players) + startUp)) / rounds;
}

// ---------------------------------------------------------------------------
// The chain, solved rather than pasted
// ---------------------------------------------------------------------------

describe('remainder and the two games', () => {
  it('reads money below zero as a remainder in 0..2', () => {
    expect([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3].map(remainder)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
  });

  it('gives game A one coin and game B two, both tipped by the tilt', () => {
    for (const money of [-4, -1, 0, 1, 5, 9]) {
      expect(winProbability('A', money, EPS)).toBeCloseTo(0.495, 12);
      expect(winProbability('B', money, EPS)).toBeCloseTo(remainder(money) === 0 ? 0.095 : 0.745, 12);
    }
  });

  it('is exactly fair at zero tilt — both games, by construction', () => {
    // Game A is obvious. Game B is fair when the odds around the cycle balance:
    // (1−p₀)(1−p₁)(1−p₂) = p₀p₁p₂, which is 0.9 · 0.25 · 0.25 = 0.1 · 0.75 · 0.75.
    expect(0.9 * 0.25 * 0.25).toBeCloseTo(0.1 * 0.75 * 0.75, 15);
    expect(solveRule(RULE_A, 0).drift).toBe(0);
    expect(Math.abs(solveRule(RULE_B, 0).drift)).toBeLessThan(1e-12);
  });
});

describe('transitionMatrix', () => {
  it('moves the remainder by exactly one step, and its rows are probabilities', () => {
    for (const game of ['A', 'B'] as const) {
      const P = transitionMatrix(game, EPS);
      for (let i = 0; i < MODULUS; i++) {
        const row = P[i]!;
        expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        expect(row[(i + 1) % MODULUS]).toBeCloseTo(winProbability(game, i, EPS), 12);
        expect(row[(i + MODULUS - 1) % MODULUS]).toBeCloseTo(1 - winProbability(game, i, EPS), 12);
      }
    }
  });
});

describe('solveShares', () => {
  it('leaves game A on an even spread and game B piled on the multiples of three', () => {
    expect(solveShares(transitionMatrix('A', EPS))).toEqual([1 / 3, 1 / 3, 1 / 3].map((x) => expect.closeTo(x, 12)));
    const b = solveShares(transitionMatrix('B', EPS));
    expect(b[0]).toBeCloseTo(0.3836, 4);
    expect(b[1]).toBeCloseTo(0.1543, 4);
    expect(b[2]).toBeCloseTo(0.4621, 4);
    expect(b.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
  });

  it('is a fixed point of the chain it came from', () => {
    const P = transitionMatrix('B', EPS);
    const x = solveShares(P);
    for (let j = 0; j < MODULUS; j++) {
      let sum = 0;
      for (let i = 0; i < MODULUS; i++) sum += x[i]! * P[i]![j]!;
      expect(sum).toBeCloseTo(x[j]!, 12);
    }
  });
});

describe('solveRule', () => {
  it('reproduces the catalogue: both games lose, two of each in a row wins', () => {
    expect(solveRule(RULE_A, EPS).drift).toBeCloseTo(-0.01, 12);
    expect(solveRule(RULE_B, EPS).drift).toBeCloseTo(-0.008695, 6);
    expect(solveRule(RULE_TURNS, EPS).drift).toBeCloseTo(0.014651, 6);
  });

  it('loses under strict alternation, which is why the tab does not play it', () => {
    // The fact card's claim, checked. A, B, A, B is the trap in this problem:
    // it mixes the two games and still drifts down.
    expect(solveRule(RULE_ABAB, EPS).drift).toBeCloseTo(-0.006738, 6);
    expect(solveRule(RULE_TURNS, EPS).drift).toBeGreaterThan(0);
  });

  it('still wins on two exactly fair games', () => {
    expect(solveRule(RULE_TURNS, 0).drift).toBeCloseTo(0.02454, 5);
  });

  it('has a tipping point: past about 1.24 % tilt even taking turns loses', () => {
    expect(solveRule(RULE_TURNS, 0.012).drift).toBeGreaterThan(0);
    expect(solveRule(RULE_TURNS, 0.0125).drift).toBeLessThan(0);
    // The slider's top, which the third preset sits on.
    expect(solveRule(RULE_TURNS, 0.02).drift).toBeCloseTo(-0.0150159, 6);
  });

  it('knocks game B off the multiples of three, which is the whole mechanism', () => {
    const alone = solveRule(RULE_B, EPS).shares[0]!;
    const turns = solveRule(RULE_TURNS, EPS).shares[0]!;
    expect(alone).toBeCloseTo(0.3836, 4);
    expect(turns).toBeCloseTo(0.3527, 4);
    // Game B alone sits on its bad coin more often than an even third of the
    // time; two rounds of A pull it back towards a third and that is the win.
    expect(alone).toBeGreaterThan(1 / MODULUS);
    expect(turns).toBeLessThan(alone);
    for (const rule of RULES) {
      expect(solveRule(rule, EPS).shares.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
    }
  });
});

describe('expectedMoney', () => {
  it('starts at nothing and follows the drift line, offset by the start on a multiple of three', () => {
    for (const rule of RULES) expect(expectedMoney(rule, EPS, 0)).toBe(0);
    for (const rule of RULES) {
      const drift = solveRule(rule, EPS).drift;
      const offset = expectedMoney(rule, EPS, 3_000) - 3_000 * drift;
      // The offset is a constant reached in a few rounds, not a growing term.
      expect(expectedMoney(rule, EPS, 6_000) - 6_000 * drift).toBeCloseTo(offset, 9);
    }
    // Game A never looks at the money, so it has no start-up at all.
    expect(expectedMoney(RULE_A, EPS, 500)).toBeCloseTo(-5, 12);
    // Game B's first round is certain to be on the bad coin.
    expect(expectedMoney(RULE_B, EPS, 1)).toBeCloseTo(2 * 0.095 - 1, 12);
  });
});

// ---------------------------------------------------------------------------
// Convergence: measured against the chain
// ---------------------------------------------------------------------------

describe('parrondo convergence', () => {
  it('lands every rule’s average purse on the chain’s exact prediction', () => {
    const table = runTable(SEED, PLAYERS, EPS);
    expect(table.round).toBe(ROUNDS);
    const bar = purseTolerance(ROUNDS, PLAYERS);
    expect(bar).toBeCloseTo(10.954, 3);
    for (let r = 0; r < RULES.length; r++) {
      const predicted = expectedMoney(RULES[r]!, EPS, ROUNDS);
      expect(Math.abs(table.averageMoney(r) - predicted), `rule ${r}`).toBeLessThan(bar);
    }
  });

  it('measures each rule’s gain per hundred rounds against its solved drift', () => {
    const table = runTable(SEED, PLAYERS, EPS);
    for (let r = 0; r < RULES.length; r++) {
      const rule = RULES[r]!;
      const drift = 100 * solveRule(rule, EPS).drift;
      const measured = 100 * table.averagePerRound(r);
      expect(Math.abs(measured - drift), `rule ${r}`).toBeLessThan(gainTolerance(rule, EPS, ROUNDS, PLAYERS));
    }
  });

  it('shows the moment: both games down, taking turns up, on the same run', () => {
    const table = runTable(SEED, PLAYERS, EPS);
    expect(table.averagePerRound(A_ONLY)).toBeLessThan(0);
    expect(table.averagePerRound(B_ONLY)).toBeLessThan(0);
    expect(table.averagePerRound(TAKING_TURNS)).toBeGreaterThan(0);
    // Not a near miss in either direction: the separation is many standard
    // errors wide, which is what makes it a picture rather than a coincidence.
    const bar = purseTolerance(ROUNDS, PLAYERS);
    expect(table.averageMoney(TAKING_TURNS) - table.averageMoney(A_ONLY)).toBeGreaterThan(4 * bar);
  });

  it('holds the moment on fair coins and loses it past the tipping point', () => {
    const fair = runTable(SEED, PLAYERS, 0);
    expect(Math.abs(fair.averageMoney(A_ONLY))).toBeLessThan(purseTolerance(ROUNDS, PLAYERS));
    expect(Math.abs(fair.averageMoney(B_ONLY))).toBeLessThan(purseTolerance(ROUNDS, PLAYERS));
    expect(fair.averageMoney(TAKING_TURNS)).toBeGreaterThan(purseTolerance(ROUNDS, PLAYERS));

    const tipped = runTable(SEED, PLAYERS, 0.02);
    for (let r = 0; r < RULES.length; r++) expect(tipped.averagePerRound(r), `rule ${r}`).toBeLessThan(0);
  });

  it('measures the share of rounds spent on a multiple of three', () => {
    const table = runTable(SEED, PLAYERS, EPS);
    // A share over `rounds · players` observations has a standard error of at
    // most ½/√(rounds · players) = 0.00046, so 0.005 is more than ten of them.
    for (let r = 0; r < RULES.length; r++) {
      expect(Math.abs(table.shareOnBad(r) - solveRule(RULES[r]!, EPS).shares[0]!), `rule ${r}`).toBeLessThan(0.005);
    }
    expect(table.shareOnBad(B_ONLY)).toBeGreaterThan(table.shareOnBad(TAKING_TURNS));
  });

  it('reproduces a run from its seed and differs between seeds', () => {
    const a = runTable(SEED, PLAYERS, EPS, 400);
    const b = runTable(SEED, PLAYERS, EPS, 400);
    for (let r = 0; r < RULES.length; r++) {
      expect(a.averageMoney(r)).toBe(b.averageMoney(r));
      expect(a.shareOnBad(r)).toBe(b.shareOnBad(r));
    }
    expect(runTable(1, PLAYERS, EPS, 400).averageMoney(TAKING_TURNS)).not.toBe(
      runTable(2, PLAYERS, EPS, 400).averageMoney(TAKING_TURNS),
    );
  });
});

describe('Table', () => {
  it('starts everybody on nothing and stops at its round ceiling', () => {
    const rng = createRng(SEED);
    const table = new Table(MAX_PLAYERS, 10);
    table.configure(50, EPS);
    expect(table.round).toBe(0);
    expect(table.averageMoney(A_ONLY)).toBe(0);
    expect(table.averagePerRound(A_ONLY)).toBeNaN();
    expect(table.shareOnBad(A_ONLY)).toBeNaN();
    for (let i = 0; i < 40; i++) table.playRound(rng);
    expect(table.round).toBe(10);
    expect(table.finished).toBe(true);
    const settled = RULES.map((_, r) => table.averageMoney(r));
    table.playRound(rng);
    expect(RULES.map((_, r) => table.averageMoney(r))).toEqual(settled);
  });

  it('clamps the table to its budget and reseats everyone on a new size', () => {
    const table = new Table(16, 20);
    table.configure(9_999, EPS);
    expect(table.players).toBe(16);
    const rng = createRng(SEED);
    for (let i = 0; i < 20; i++) table.playRound(rng);
    expect(table.round).toBe(20);
    table.configure(4, EPS);
    expect(table.players).toBe(4);
    expect(table.round).toBe(0);
    expect(table.averageMoney(TAKING_TURNS)).toBe(0);
    expect(table.historyAt(TAKING_TURNS, 12)).toBe(0);
  });

  it('records the average after every round, and every purse moves by one a round', () => {
    const rng = createRng(SEED);
    const table = new Table(MAX_PLAYERS, 30);
    table.configure(200, EPS);
    let previous = 0;
    for (let n = 1; n <= 30; n++) {
      table.playRound(rng);
      const now = table.averageMoney(TAKING_TURNS);
      expect(table.historyAt(TAKING_TURNS, n)).toBeCloseTo(now, 4);
      // 200 purses each moving ±1 can shift the average by at most one coin.
      expect(Math.abs(now - previous)).toBeLessThanOrEqual(1 + 1e-9);
      previous = now;
    }
  });
});

// ---------------------------------------------------------------------------
// Plate geometry — pure, so a test can reach it
// ---------------------------------------------------------------------------

describe('niceCeil', () => {
  it('rounds up to a number worth printing on an axis', () => {
    expect(niceCeil(56.5)).toBe(60);
    expect(niceCeil(89.1)).toBe(100);
    expect(niceCeil(140.2)).toBe(150);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(10)).toBe(10);
    // 60/10 comes back as 6.000000000000001 from the decade division.
    expect(niceCeil(60)).toBe(60);
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-3)).toBe(0);
  });

  it('never rounds down', () => {
    for (let x = 0.01; x < 1_000; x *= 1.037) expect(niceCeil(x)).toBeGreaterThanOrEqual(x);
  });
});

describe('axisRange', () => {
  it('keeps every prediction and its wander inside the axis, at every table size', () => {
    for (const eps of [0, EPS, 0.0125, 0.02]) {
      for (const players of [20, 400, 2_000]) {
        const ends = RULES.map((rule) => expectedMoney(rule, eps, ROUNDS));
        const range = axisRange(ends, players, ROUNDS);
        const wander = 3 * Math.sqrt(ROUNDS / players);
        for (const end of ends) {
          expect(range.max, `${eps}/${players}`).toBeGreaterThanOrEqual(end + wander);
          expect(range.min, `${eps}/${players}`).toBeLessThanOrEqual(end - wander);
        }
        // Breaking even is always on the plate, whichever way the rules go.
        expect(range.min).toBeLessThan(0);
        expect(range.max).toBeGreaterThan(0);
      }
    }
  });

  it('is decided by the predictions and the table, never by a measurement', () => {
    const ends = RULES.map((rule) => expectedMoney(rule, EPS, ROUNDS));
    expect(axisRange(ends, PLAYERS, ROUNDS)).toEqual(axisRange(ends, PLAYERS, ROUNDS));
    // A bigger table wanders less, so the axis closes in rather than opening up.
    expect(axisRange(ends, 2_000, ROUNDS).max).toBeLessThanOrEqual(axisRange(ends, 20, ROUNDS).max);
  });
});

describe('plotX, plotY and vertexStride', () => {
  const box: Rect = { x: 50, y: 14, width: 660, height: 260 };
  const range = { min: -50, max: 60 };

  it('runs the rounds across the box and clamps the money into it', () => {
    expect(plotX(box, 0, ROUNDS)).toBe(50);
    expect(plotX(box, ROUNDS, ROUNDS)).toBe(710);
    expect(plotX(box, 2 * ROUNDS, ROUNDS)).toBe(710);
    expect(plotY(box, range, 60)).toBeCloseTo(14, 9);
    expect(plotY(box, range, -50)).toBeCloseTo(274, 9);
    expect(plotY(box, range, 0)).toBeCloseTo(14 + (60 / 110) * 260, 9);
    // A run that leaves the axis is held inside the frame, halo and all.
    expect(plotY(box, range, 5_000, 3)).toBe(17);
    expect(plotY(box, range, -5_000, 3)).toBe(271);
  });

  it('bounds the painted vertices by the pixel columns, not by the rounds', () => {
    expect(vertexStride(box, ROUNDS)).toBe(5);
    expect(Math.ceil(ROUNDS / vertexStride(box, ROUNDS))).toBeLessThanOrEqual(box.width);
    // A phone-sized box strides further still; a box wider than the run strides by one.
    expect(vertexStride({ ...box, width: 277 }, ROUNDS)).toBe(11);
    expect(vertexStride({ ...box, width: 4_000 }, ROUNDS)).toBe(1);
  });
});

describe('layoutPlot', () => {
  it('leaves the gutters the axis needs and never inverts on a tiny plate', () => {
    const wide = layoutPlot(720, 448);
    expect(wide.x).toBe(50);
    expect(wide.y).toBe(22);
    expect(wide.width).toBe(720 - 16 - 42 - 8);
    expect(wide.height).toBe(448 - 16 - 14 - 18);
    for (const [w, h] of [[40, 30], [1, 1], [343, 343]] as const) {
      const box = layoutPlot(w, h);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
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

/**
 * A canvas context that records the strokes it is asked for and accepts
 * everything else. The traces, the predictions and the frame are the only
 * things under test here; the key paints through fillRect/strokeRect/fillText,
 * which record nothing, so every entry in `strokes` is geometry.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; strokes: Stroke[] } {
  const strokes: Stroke[] = [];
  let segments: Seg[] = [];
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
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (text: string) => ({ width: 6.6 * text.length }),
    setLineDash(pattern: readonly number[]): void {
      dash = pattern;
    },
    beginPath(): void {
      segments = [];
      started = false;
    },
    moveTo(nx: number, ny: number): void {
      x = nx;
      y = ny;
      started = true;
    },
    lineTo(nx: number, ny: number): void {
      // Canvas treats a lineTo with no current point as a moveTo.
      if (started) segments.push([x, y, nx, ny]);
      x = nx;
      y = ny;
      started = true;
    },
    stroke(): void {
      strokes.push({
        pen: String(api.strokeStyle),
        width: api.lineWidth,
        alpha: api.globalAlpha,
        dashed: dash.length > 0,
        segments: [...segments],
      });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, strokes };
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
  tilt: 0.5,
  players: PLAYERS,
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
  const instance = parrondo.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

/** Ticks enough to play `rounds` rounds at the fixed rate. */
function tick(v: Viz, rounds: number): void {
  const steps = Math.ceil((rounds * 1000) / (ROUND_RATE * TICK));
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
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

/**
 * The traces: everything on the foreground drawn in a data pen with more than
 * one segment. The key's sample lines carry the same pens and are exactly one
 * segment each, which is what separates them from the curves.
 */
function traces(v: Viz): Stroke[] {
  const pens: string[] = [THEME.data3, THEME.data1];
  return v.fg.strokes.filter((s) => pens.includes(s.pen) && s.segments.length > 1);
}

describe('parrondo instance: readouts', () => {
  it('publishes the three gains with the targets the chain solved, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, ROUNDS);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual([
      'rounds',
      'gainA',
      'gainB',
      'gainTurns',
      'shareB',
      'shareTurns',
      'players',
    ]);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['rounds']?.value).toBe(ROUNDS);
    expect(by['players']?.value).toBe(PLAYERS);
    // Solved live, per hundred rounds: −1.0000, −0.8695, +1.4651.
    expect(by['gainA']?.target).toBeCloseTo(-1, 9);
    expect(by['gainB']?.target).toBeCloseTo(-0.8695, 4);
    expect(by['gainTurns']?.target).toBeCloseTo(1.4651, 4);
    expect(by['shareB']?.target).toBeCloseTo(0.3836, 4);
    expect(by['shareTurns']?.target).toBeCloseTo(0.3527, 4);
    for (const key of ['gainA', 'gainB', 'gainTurns'] as const) {
      const row = by[key];
      const rule = key === 'gainA' ? RULE_A : key === 'gainB' ? RULE_B : RULE_TURNS;
      expect(Math.abs((row?.value ?? 0) - (row?.target ?? 0)), key).toBeLessThan(
        gainTolerance(rule, EPS, ROUNDS, PLAYERS),
      );
    }
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('marks taking turns as the one headline and gives every visible number a plain label', () => {
    const v = stubViz();
    tick(v, 200);
    paint(v);
    const last = v.emitted.at(-1) ?? [];
    const headline = last.filter((r) => r.headline === true);
    expect(headline.map((r) => r.key)).toEqual(['gainTurns']);
    expect(headline[0]?.plain).toBe('coins per 100 rounds, taking turns');

    const shown = last.filter((r) => r.expertOnly !== true).map((r) => r.key);
    expect(shown).toEqual(['rounds', 'gainA', 'gainB', 'gainTurns']);
    for (const r of last) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toBeDefined();
      expect(r.plain, r.key).toBe(r.plain?.toLowerCase());
    }
  });

  it('never prints a word a sixteen-year-old has not met', () => {
    const banned =
      /\b(mean|variance|analytic|converged?|estimator|standard error|residual|tolerance|asymptotic|stationary|ergodic|markov)\b/i;
    const v = stubViz();
    tick(v, 100);
    paint(v);
    for (const r of v.emitted.at(-1) ?? []) {
      if (r.expertOnly === true) continue;
      expect(r.plain ?? '', r.key).not.toMatch(banned);
      expect(r.hint ?? '', r.key).not.toMatch(banned);
    }
    for (const preset of parrondo.presets ?? []) expect(text(preset.caption), preset.id).not.toMatch(banned);
    expect(text(parrondo.blurb)).not.toMatch(banned);
  });

  it('is unmeasured before the first round, and reads the moment after the run', () => {
    const fresh = stubViz();
    paint(fresh);
    expect(ledger(fresh)['rounds']).toBe(0);
    expect(ledger(fresh)['gainTurns']).toBeNaN();

    const v = stubViz();
    tick(v, ROUNDS);
    paint(v);
    expect(ledger(v)['gainA']).toBeLessThan(0);
    expect(ledger(v)['gainB']).toBeLessThan(0);
    expect(ledger(v)['gainTurns']).toBeGreaterThan(0);
  });

  it('draws without mutating the simulation, and resets to an empty table', () => {
    const v = stubViz();
    tick(v, 500);
    paint(v);
    paint(v);
    expect(v.emitted.at(-1)).toEqual(v.emitted.at(-2));
    v.instance.reset();
    paint(v);
    expect(ledger(v)['rounds']).toBe(0);
    expect(ledger(v)['gainTurns']).toBeNaN();
    v.instance.destroy();
  });
});

describe('parrondo instance: the run', () => {
  it('stops at exactly the fixed ceiling and stays there', () => {
    const v = stubViz();
    tick(v, ROUNDS);
    paint(v);
    expect(ledger(v)['rounds']).toBe(ROUNDS);
    const done = ledger(v);
    tick(v, 2_000);
    paint(v);
    expect(ledger(v)).toEqual(done);
  });

  it('resets on every knob it has, so a change is a fresh run at the new value', () => {
    const changes: ReadonlyArray<readonly [string, ParamValue]> = [
      ['tilt', 2],
      ['players', 120],
      ['seed', 7],
    ];
    for (const [key, value] of changes) {
      const v = stubViz();
      tick(v, 600);
      paint(v);
      expect(setParam(v, key, value), key).toBe(false);
      expect(ledger(v)['rounds'], key).toBe(0);
      tick(v, 600);
      paint(v);

      const fresh = stubViz({ [key]: value });
      tick(fresh, 600);
      paint(fresh);
      expect(ledger(v), key).toEqual(ledger(fresh));
    }
  });

  it('re-solves the targets for whatever tilt the fader is on', () => {
    const fair = stubViz({ tilt: 0 });
    tick(fair, 40);
    paint(fair);
    const byFair = Object.fromEntries((fair.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(byFair['gainA']?.target).toBe(0);
    // Two exactly fair games, and taking turns still predicts a profit.
    expect(byFair['gainB']?.target).toBe(0);
    expect(byFair['gainTurns']?.target).toBeCloseTo(2.454, 3);

    const tipped = stubViz({ tilt: 2 });
    tick(tipped, 40);
    paint(tipped);
    const byTipped = Object.fromEntries((tipped.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(byTipped['gainTurns']?.target).toBeCloseTo(-1.50159, 4);
  });

  it('ignores the knobs it never had, so a stray permalink key runs the fixed experiment', () => {
    const v = stubViz({ modulus: 4, rule: 'ABB', gamma: 0.5 });
    tick(v, 250);
    paint(v);
    expect(ledger(v)['rounds']).toBe(250);
    const by = Object.fromEntries((v.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(by['gainTurns']?.target).toBeCloseTo(1.4651, 4);
  });
});

describe('parrondo instance: the plate', () => {
  it('gives the same run on any plate, so a permalink survives the recipient’s window', () => {
    const wide = stubViz({}, 1_280, 720);
    const narrow = stubViz({}, 343, 343);
    for (const v of [wide, narrow]) {
      tick(v, 1_500);
      paint(v);
    }
    expect(ledger(narrow)).toEqual(ledger(wide));
  });

  it('leaves the numbers untouched across a resize', () => {
    const v = stubViz({}, 720, 448);
    tick(v, 1_200);
    paint(v);
    const before = ledger(v);
    resize(v, 343, 343);
    expect(ledger(v)).toEqual(before);
    resize(v, 1_280, 720);
    expect(ledger(v)).toEqual(before);
  });

  it('paints three traces in two data pens plus a dash, all at 2 px and full strength', () => {
    const v = stubViz();
    tick(v, ROUNDS);
    paint(v);
    const drawn = traces(v);
    // Two pens, not three: the two losing games are peer series and §7 forbids
    // ranking peers with a second hue, so they share the area pen and the first
    // game is dashed. The furniture pen used to draw one of them, 1.14:1 from
    // the other and identical to the box it sat in.
    expect(new Set(drawn.map((s) => s.pen))).toEqual(new Set([THEME.data3, THEME.data1]));
    expect(v.fg.strokes.some((s) => s.pen === THEME.gridSoft && s.segments.length > 1)).toBe(false);
    expect(drawn.filter((s) => s.dashed)).toHaveLength(1);
    expect(drawn.find((s) => s.dashed)?.pen).toBe(THEME.data3);
    for (const s of drawn) {
      // A translucent pen composites through the 4.5:1 the foreground owes the
      // plate, and a hairline in a data pen smears below 3:1.
      expect(s.alpha).toBe(1);
      expect(s.width).toBe(2 * THEME.lineWidth);
    }
    // Every trace is haloed in the plate colour before its own pen goes down.
    const halos = v.fg.strokes.filter((s) => s.pen === THEME.canvas && s.segments.length > 1);
    expect(halos).toHaveLength(3);
    for (const s of halos) expect(s.width).toBe(2 * THEME.lineWidth + 4);
    // The star is painted last, so nothing lands on top of it.
    const order = v.fg.strokes.filter((s) => s.segments.length > 1).map((s) => s.pen);
    expect(order.lastIndexOf(THEME.gridSoft)).toBeLessThan(order.lastIndexOf(THEME.data1));
    expect(order.lastIndexOf(THEME.data3)).toBeLessThan(order.lastIndexOf(THEME.data1));
  });

  it('bounds the painted vertices by the plate while the rounds keep counting', () => {
    for (const [w, h] of [[1_280, 720], [720, 448], [343, 343]] as const) {
      const v = stubViz({}, w, h);
      tick(v, ROUNDS);
      paint(v);
      expect(ledger(v)['rounds']).toBe(ROUNDS);
      const box = layoutPlot(w, h);
      for (const s of traces(v)) {
        // One vertex per pixel column at most, whatever the round count.
        expect(s.segments.length, `${w}×${h}`).toBeLessThanOrEqual(Math.ceil(box.width) + 1);
        expect(s.segments.length, `${w}×${h}`).toBeGreaterThan(1);
      }
    }
  });

  it('keeps every painted point inside the frame, at every tilt and table size', () => {
    // Twenty players is the worst case by a distance — the average of twenty
    // purses wanders 37 coins at 3,000 rounds against four at the default
    // table — so the sweep spends its time there rather than at the ceiling,
    // where the axis has the most room and the least to hold.
    for (const tilt of [0, 0.5, 1.3, 2]) {
      for (const players of [20, 500]) {
        const v = stubViz({ tilt, players }, 720, 448);
        tick(v, ROUNDS);
        paint(v);
        const box = layoutPlot(720, 448);
        for (const s of [...traces(v), ...v.bg.strokes.filter((b) => b.pen === THEME.data2)]) {
          for (const [x0, y0, x1, y1] of s.segments) {
            for (const [px, py] of [[x0, y0], [x1, y1]] as const) {
              expect(px, `${tilt}/${players}`).toBeGreaterThanOrEqual(box.x - 1e-6);
              expect(px, `${tilt}/${players}`).toBeLessThanOrEqual(box.x + box.width + 1e-6);
              expect(py, `${tilt}/${players}`).toBeGreaterThanOrEqual(box.y - 1e-6);
              expect(py, `${tilt}/${players}`).toBeLessThanOrEqual(box.y + box.height + 1e-6);
            }
          }
        }
      }
    }
  });

  it('puts the three predictions on the background, in the drafting pen, before a round is played', () => {
    const v = stubViz();
    const predictions = v.bg.strokes.filter((s) => s.pen === THEME.data2);
    expect(predictions).toHaveLength(3);
    for (const s of predictions) {
      expect(s.width).toBe(2 * THEME.lineWidth);
      expect(s.dashed).toBe(false);
      // Drawn the whole length of the axis from the first frame.
      expect(s.segments.length).toBeGreaterThan(100);
      expect(s.segments[0]?.[0]).toBeCloseTo(layoutPlot(720, 448).x, 9);
    }
    // …and the foreground has nothing on it until a round is played.
    paint(v);
    expect(traces(v).flatMap((s) => s.segments)).toHaveLength(0);
  });

  it('rules breaking even as a dashed hairline, never as a fourth line of data', () => {
    const v = stubViz();
    const dashed = v.bg.strokes.filter((s) => s.dashed && s.segments.length > 0);
    expect(dashed).toHaveLength(1);
    expect(dashed[0]?.pen).toBe(THEME.gridSoft);
    expect(dashed[0]?.width).toBe(THEME.lineWidth);
    const box = layoutPlot(720, 448);
    const [x0, y0, x1, y1] = dashed[0]?.segments[0] ?? [0, 0, 0, 0];
    expect(y0).toBe(y1);
    expect(x0).toBeCloseTo(Math.round(box.x) + 0.5, 9);
    expect(x1).toBeCloseTo(Math.round(box.x + box.width) + 0.5, 9);
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

describe('parrondo metadata', () => {
  it('shows two knobs and keeps the seed for the URL only', () => {
    expect(parrondo.params.map((p) => p.key)).toEqual(['tilt', 'players', 'seed']);
    expect(parrondo.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(parrondo.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    expect(parrondo.id).toBe('parrondo');
    expect(parrondo.group).toBe('randomness');
    expect(parrondo.budget?.maxEntities).toBe(RULES.length * MAX_PLAYERS);
  });

  it('offers three presets, each one plain sentence, each from a declared parameter', () => {
    const presets = parrondo.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.length).toBeLessThanOrEqual(3);
    for (const preset of presets) {
      expect(text(preset.caption), preset.id).not.toMatch(SECOND_SENTENCE);
      for (const key of Object.keys(preset.values)) {
        expect(parrondo.params.some((p) => p.key === key), `preset ${preset.id} sets unknown param ${key}`).toBe(true);
      }
    }
    // Ordered to walk to the insight: the paradox, the tilt taken away, the
    // tilt pushed past where it works.
    expect(presets.map((p) => p.id)).toEqual(['each-one-loses', 'perfectly-fair', 'tilted-too-far']);
  });

  it('states at most two facts, one sentence each, and sources both', () => {
    expect(parrondo.facts.length).toBeGreaterThan(0);
    expect(parrondo.facts.length).toBeLessThanOrEqual(2);
    for (const fact of parrondo.facts) {
      expect(text(fact.text)).not.toMatch(SECOND_SENTENCE);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
  });

  it('introduces itself in one present-tense sentence', () => {
    const blurb = text(parrondo.blurb);
    expect(blurb).not.toMatch(SECOND_SENTENCE);
    expect(blurb).toMatch(/^Plays /);
  });
});
