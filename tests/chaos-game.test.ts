import { describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import type { ParamValue, Readout, VizContext } from '../src/core/types';
import { SHAPES, chaosGame, layoutView, resolveSystem } from '../src/viz/chaos-game/index';
import {
  BOX_MAX_LEVEL,
  BOX_MIN_LEVEL,
  BURN_IN,
  NAMED_SYSTEMS,
  Occupancy,
  PENTAGON_RATIO,
  attractorBounds,
  boxCountingDimension,
  branching,
  createChaosGame,
  findSystem,
  fixedPoint,
  gridSquare,
  polygonOpenSetRatio,
  polygonSystem,
  polygonVertex,
  restrictedDimension,
  similarityDimension,
  type AffineMap,
  type Restriction,
} from '../src/viz/chaos-game/ifs';

const SEED = 42;

/** The engine's tick: 120 Hz. */
const TICK = 1000 / 120;

/**
 * The tolerance every convergence assertion here uses, and where it comes from.
 *
 * A box count is not a Monte Carlo mean and has no 1/√N standard error to
 * quote: `boxCountingDimension` regresses five deterministic counters, and at
 * the point counts used below the sampling error in those counters is nil. For
 * the Sierpiński triangle at 10⁶ points the finest level regressed over (1/256)
 * holds 3⁸ = 6,561 occupied boxes and therefore about 150 points each, so the
 * chance that any box the attractor touches went unvisited is e⁻¹⁵⁰.
 *
 * What is left is discretisation. N(ε) = C·ε^−D holds only up to a bounded
 * oscillation, because the grid is not aligned with the attractor's own
 * subdivision, and a perturbation δ in log N at the top level moves the
 * five-point least-squares slope by δ/(5·ln 2) = 0.29·δ. An oscillation of a
 * tenth of a nat therefore buys three hundredths of dimension, which is the
 * order of what is measured: +0.012 (triangle), −0.008 (pentagon), −0.014
 * (square), +0.005 (restricted square). 0.05 is roughly four times the worst
 * of those, and it is the same number the readout publishes as its tolerance.
 */
const DIM_TOLERANCE = 0.05;

/** Run a system to `points` from a fixed seed and measure its box dimension. */
function measure(
  maps: readonly AffineMap[],
  points: number,
  opts: { seed?: number; restriction?: Restriction; start?: { x: number; y: number } } = {},
): { dimension: number; plotted: number; cells: number } {
  const rng = createRng(opts.seed ?? SEED);
  const game = createChaosGame(rng, maps, {
    ...(opts.restriction ? { restriction: opts.restriction } : {}),
    ...(opts.start ? { start: opts.start } : {}),
  });
  game.step(points);
  return {
    dimension: boxCountingDimension(game.grid),
    plotted: game.plotted,
    cells: game.grid.count(BOX_MAX_LEVEL),
  };
}

// ---------------------------------------------------------------------------
// Convergence — the box count against the closed form
// ---------------------------------------------------------------------------

describe('chaos-game convergence', () => {
  it('reaches log n / log(1/r) for the polygon systems at 10⁶ points', () => {
    const cases: ReadonlyArray<[string, number, number]> = [
      ['Sierpiński triangle', 3, 0.5],
      ['Sierpiński pentagon', 5, PENTAGON_RATIO],
      ['square', 4, 0.5],
    ];
    for (const [name, n, r] of cases) {
      const analytic = similarityDimension(n, r);
      const { dimension } = measure(polygonSystem(n, r), 1_000_000);
      expect(Math.abs(dimension - analytic), `${name}: ${dimension} vs ${analytic}`).toBeLessThan(
        DIM_TOLERANCE,
      );
    }
  });

  it('pins the three analytic values the catalogue quotes', () => {
    expect(similarityDimension(3, 0.5)).toBeCloseTo(1.5849625, 7);
    expect(similarityDimension(5, PENTAGON_RATIO)).toBeCloseTo(1.6723, 4);
    expect(similarityDimension(4, 0.5)).toBe(2);
    expect(PENTAGON_RATIO).toBeCloseTo(0.3819660, 7);
  });

  it('measures the restriction, not just the randomness: the square’s two dimensions', () => {
    // The teaching moment, as a number. Unrestricted, four half-squares tile the
    // square and it fills: dimension 2. Forbid an immediate repeat and the
    // branching drops to three, which is the Sierpiński triangle's dimension out
    // of a rule rather than out of a shape.
    const free = measure(polygonSystem(4, 0.5), 1_000_000);
    const bound = measure(polygonSystem(4, 0.5), 1_000_000, { restriction: 'no-repeat' });
    expect(Math.abs(free.dimension - 2)).toBeLessThan(DIM_TOLERANCE);
    expect(Math.abs(bound.dimension - Math.log2(3))).toBeLessThan(DIM_TOLERANCE);
    // Not a subtle difference: the restricted run inks a fifth of the boxes.
    expect(free.dimension - bound.dimension).toBeGreaterThan(0.3);
    expect(bound.cells / free.cells).toBeLessThan(0.35);
  });

  it('reaches log m / log(1/r) for every restriction on the square', () => {
    for (const restriction of ['none', 'no-repeat', 'not-neighbour', 'not-opposite'] as const) {
      const analytic = restrictedDimension(4, 0.5, restriction);
      const { dimension } = measure(polygonSystem(4, 0.5), 1_000_000, { restriction });
      expect(
        Math.abs(dimension - analytic),
        `${restriction}: ${dimension} vs ${analytic}`,
      ).toBeLessThan(DIM_TOLERANCE);
    }
  });

  it('is under-resolved rather than wrong at a thousand points', () => {
    // A thousand points cannot reach nine thousand boxes, so the finest counts
    // are short and the slope comes out at 0.786 rather than 1.585. The first
    // preset says exactly this: every point is already on the attractor, and it
    // is the estimate that is not there yet.
    const { dimension, cells } = measure(polygonSystem(3, 0.5), 1_000);
    expect(cells).toBeLessThan(1_000);
    expect(dimension).toBeGreaterThan(0.5);
    expect(dimension).toBeLessThan(similarityDimension(3, 0.5) - 0.5);
  });

  it('has stopped depending on the run length by a million points', () => {
    const at1e6 = measure(polygonSystem(3, 0.5), 1_000_000);
    const at2e6 = measure(polygonSystem(3, 0.5), 2_000_000);
    // Doubling the points finds 0.5% more boxes at 1/256 and moves the slope by
    // three thousandths, which is what makes the reading a property of the
    // attractor rather than of how long the run was left going.
    expect(at2e6.cells / at1e6.cells).toBeLessThan(1.01);
    expect(at1e6.cells).toBeGreaterThan(9_000);
    expect(Math.abs(at1e6.dimension - at2e6.dimension)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// The attractor does not depend on the seed or the start
// ---------------------------------------------------------------------------

describe('chaos-game determinism', () => {
  it('reproduces the same points and counts from the same seed', () => {
    const a = createChaosGame(createRng(SEED), polygonSystem(3, 0.5));
    const b = createChaosGame(createRng(SEED), polygonSystem(3, 0.5));
    a.step(50_000);
    b.step(50_000);
    const pointsOf = (g: typeof a): number[] => {
      const out: number[] = [];
      g.forEachRecent(g.plotted - 100, (x, y) => out.push(x, y));
      return out;
    };
    expect(pointsOf(a)).toEqual(pointsOf(b));
    expect(a.grid.count(BOX_MAX_LEVEL)).toBe(b.grid.count(BOX_MAX_LEVEL));
    expect(boxCountingDimension(a.grid)).toBe(boxCountingDimension(b.grid));
  });

  it('draws a different walk but the same figure from a different seed', () => {
    const one = measure(polygonSystem(3, 0.5), 500_000, { seed: 1 });
    const two = measure(polygonSystem(3, 0.5), 500_000, { seed: 2 });
    // Different runs...
    const a = createChaosGame(createRng(1), polygonSystem(3, 0.5));
    const b = createChaosGame(createRng(2), polygonSystem(3, 0.5));
    a.step(1_000);
    b.step(1_000);
    expect(a.x).not.toBe(b.x);
    // ...and the same attractor, to within the estimator's own resolution.
    expect(Math.abs(one.dimension - two.dimension)).toBeLessThan(0.01);
    expect(one.cells / two.cells).toBeGreaterThan(0.99);
    expect(one.cells / two.cells).toBeLessThan(1.01);
  });

  it('is independent of the starting point, which is why the burn-in is safe', () => {
    // Hutchinson: the attractor is the unique invariant set and any start
    // converges to it. Started at the origin, at a far corner and on a vertex,
    // the same seed inks the same boxes to within the ones the burn-in eats.
    const origin = measure(polygonSystem(3, 0.5), 400_000);
    const far = measure(polygonSystem(3, 0.5), 400_000, { start: { x: 40, y: -25 } });
    const vertex = measure(polygonSystem(3, 0.5), 400_000, { start: polygonVertex(3, 1) });
    expect(Math.abs(origin.dimension - far.dimension)).toBeLessThan(0.001);
    expect(Math.abs(origin.dimension - vertex.dimension)).toBeLessThan(0.001);
    expect(origin.cells).toBe(far.cells);
    expect(origin.cells).toBe(vertex.cells);
    // The distance to the attractor falls by r per step, so twenty steps from a
    // point 50 units out land within 50·2⁻²⁰ — under a ten-thousandth of a pixel.
    expect(50 * 0.5 ** BURN_IN).toBeLessThan(1e-4);
  });

  it('spends exactly one draw per point, so the rate cannot change the figure', () => {
    const slow = createChaosGame(createRng(SEED), polygonSystem(5, PENTAGON_RATIO));
    const fast = createChaosGame(createRng(SEED), polygonSystem(5, PENTAGON_RATIO));
    for (let i = 0; i < 100; i++) slow.step(137);
    fast.step(13_700);
    expect(slow.plotted).toBe(fast.plotted);
    expect(slow.x).toBe(fast.x);
    expect(slow.y).toBe(fast.y);
    expect(slow.grid.count(BOX_MAX_LEVEL)).toBe(fast.grid.count(BOX_MAX_LEVEL));
  });
});

// ---------------------------------------------------------------------------
// The pure pieces
// ---------------------------------------------------------------------------

describe('polygonSystem', () => {
  it('places n equally weighted similarities of ratio r on the unit circle', () => {
    for (const n of [3, 4, 5, 8]) {
      const maps = polygonSystem(n, 0.4);
      expect(maps).toHaveLength(n);
      let total = 0;
      maps.forEach((m, k) => {
        total += m.weight;
        expect(m.weight).toBeCloseTo(1 / n, 12);
        // A similarity of ratio r with no rotation and no reflection.
        expect(m.a).toBe(0.4);
        expect(m.d).toBe(0.4);
        expect(m.b).toBe(0);
        expect(m.c).toBe(0);
        // …whose fixed point is the vertex it aims at.
        const v = polygonVertex(n, k);
        const p = fixedPoint(m);
        expect(p.x).toBeCloseTo(v.x, 12);
        expect(p.y).toBeCloseTo(v.y, 12);
        expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 12);
      });
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('multiplies the distance to the chosen vertex by exactly r', () => {
    const maps = polygonSystem(3, 0.5);
    const m = maps[0];
    expect(m).toBeDefined();
    if (!m) return;
    const v = polygonVertex(3, 0);
    for (const p of [{ x: 0, y: 0 }, { x: 0.3, y: -0.2 }, { x: -0.7, y: 0.4 }]) {
      const q = { x: m.a * p.x + m.b * p.y + m.e, y: m.c * p.x + m.d * p.y + m.f };
      expect(Math.hypot(q.x - v.x, q.y - v.y)).toBeCloseTo(0.5 * Math.hypot(p.x - v.x, p.y - v.y), 12);
    }
  });

  it('stands odd polygons on a vertex and even ones on an edge', () => {
    // The square has to read as a square when it fills, not as a diamond.
    const square = [0, 1, 2, 3].map((k) => polygonVertex(4, k));
    for (const v of square) {
      expect(Math.abs(v.x)).toBeCloseTo(Math.SQRT1_2, 12);
      expect(Math.abs(v.y)).toBeCloseTo(Math.SQRT1_2, 12);
    }
    // The triangle keeps its apex up.
    expect(polygonVertex(3, 0).x).toBeCloseTo(0, 12);
    expect(polygonVertex(3, 0).y).toBeCloseTo(1, 12);
    expect(polygonVertex(5, 0).y).toBeCloseTo(1, 12);
  });
});

describe('polygonOpenSetRatio', () => {
  it('reproduces the published flake ratios', () => {
    expect(polygonOpenSetRatio(3)).toBeCloseTo(0.5, 12);
    expect(polygonOpenSetRatio(4)).toBeCloseTo(0.5, 12);
    expect(polygonOpenSetRatio(5)).toBeCloseTo(PENTAGON_RATIO, 12);
    expect(polygonOpenSetRatio(5)).toBeCloseTo(1 / (1 + (1 + Math.sqrt(5)) / 2), 12);
    expect(polygonOpenSetRatio(6)).toBeCloseTo(1 / 3, 12);
    expect(polygonOpenSetRatio(8)).toBeCloseTo(1 / (2 + Math.SQRT2), 12);
  });

  it('falls as the polygon gains vertices', () => {
    for (let n = 4; n <= 8; n++) {
      expect(polygonOpenSetRatio(n)).toBeLessThanOrEqual(polygonOpenSetRatio(n - 1) + 1e-12);
    }
  });

  it('is the ratio at which two adjacent pieces exactly touch', () => {
    // The pentagon's binding pair is an adjacent one. Projected on the line
    // through the two vertices, the pieces are (1−r)(vᵢ·u) ± r·h; at r = r_c the
    // gap between their centres is exactly the two half-widths, so they meet at
    // a point and their interiors are disjoint.
    const n = 5;
    const r = polygonOpenSetRatio(n);
    const v0 = polygonVertex(n, 0);
    const v1 = polygonVertex(n, 1);
    const s = Math.hypot(v1.x - v0.x, v1.y - v0.y);
    const ux = (v1.x - v0.x) / s;
    const uy = (v1.y - v0.y) / s;
    let h = -Infinity;
    for (let k = 0; k < n; k++) {
      const v = polygonVertex(n, k);
      h = Math.max(h, v.x * ux + v.y * uy);
    }
    expect((1 - r) * s).toBeCloseTo(2 * r * h, 12);
  });

  it('is where the dimension formula stops being true', () => {
    // At the open-set ratio the pentagon's box count still matches log 5 / log(1/r).
    const critical = polygonOpenSetRatio(5);
    const atRc = measure(polygonSystem(5, critical), 1_000_000);
    expect(Math.abs(atRc.dimension - similarityDimension(5, critical))).toBeLessThan(
      DIM_TOLERANCE,
    );
    // Above it the copies overlap and the formula returns more than 2, which no
    // set in the plane can be. The grid measures 1.876 — a set with interior,
    // nowhere near the 2.016 the formula asks for, and further off than the
    // estimator's own resolution. This is the case the tab refuses to put a
    // target on.
    const over = 0.45;
    expect(over).toBeGreaterThan(critical);
    expect(similarityDimension(5, over)).toBeGreaterThan(2);
    const above = measure(polygonSystem(5, over), 1_000_000);
    expect(above.dimension).toBeGreaterThan(1.8);
    expect(above.dimension).toBeLessThan(2.05);
    expect(similarityDimension(5, over) - above.dimension).toBeGreaterThan(DIM_TOLERANCE);
  });
});

describe('branching and restrictedDimension', () => {
  it('counts the vertices each rule leaves', () => {
    expect(branching(4, 'none')).toBe(4);
    expect(branching(4, 'no-repeat')).toBe(3);
    expect(branching(4, 'not-neighbour')).toBe(2);
    expect(branching(4, 'not-opposite')).toBe(3);
    expect(branching(3, 'no-repeat')).toBe(2);
    expect(branching(3, 'not-neighbour')).toBe(1);
    expect(branching(8, 'no-repeat')).toBe(7);
    expect(branching(8, 'not-neighbour')).toBe(6);
    expect(branching(8, 'not-opposite')).toBe(7);
    // Odd polygons have no single opposite vertex; the two furthest go instead.
    expect(branching(5, 'not-opposite')).toBe(3);
  });

  it('turns the square into a Sierpiński triangle by forbidding a repeat', () => {
    expect(restrictedDimension(4, 0.5, 'none')).toBe(2);
    expect(restrictedDimension(4, 0.5, 'no-repeat')).toBeCloseTo(Math.log2(3), 12);
    expect(restrictedDimension(4, 0.5, 'no-repeat')).toBeCloseTo(similarityDimension(3, 0.5), 12);
    expect(restrictedDimension(4, 0.5, 'not-neighbour')).toBeCloseTo(1, 12);
    // A rule that leaves one vertex leaves one point, and a point has dimension 0.
    expect(restrictedDimension(3, 0.5, 'not-neighbour')).toBe(0);
  });
});

describe('similarityDimension', () => {
  it('is undefined outside the contracting range', () => {
    expect(similarityDimension(3, 1)).toBeNaN();
    expect(similarityDimension(3, 0)).toBeNaN();
    expect(similarityDimension(3, 1.2)).toBeNaN();
  });

  it('exceeds 2 once the copies must overlap, which is the formula failing loudly', () => {
    expect(similarityDimension(3, 0.6)).toBeGreaterThan(2);
    expect(similarityDimension(3, 0.6)).toBeCloseTo(2.1507, 4);
    expect(0.6).toBeGreaterThan(polygonOpenSetRatio(3));
  });
});

describe('attractorBounds', () => {
  it('is exact for a polygon system: the polygon’s own box', () => {
    for (const n of [3, 4, 5, 7]) {
      const b = attractorBounds(polygonSystem(n, 0.5));
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < n; k++) {
        const v = polygonVertex(n, k);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
      expect(b.minX).toBeCloseTo(minX, 9);
      expect(b.maxX).toBeCloseTo(maxX, 9);
      expect(b.minY).toBeCloseTo(minY, 9);
      expect(b.maxY).toBeCloseTo(maxY, 9);
    }
  });

  it('holds every point of every named system’s attractor', () => {
    for (const system of NAMED_SYSTEMS) {
      const b = system.bounds ?? attractorBounds(system.maps);
      const game = createChaosGame(createRng(7), system.maps, {
        ...(system.bounds ? { bounds: system.bounds } : {}),
      });
      game.step(200_000);
      let outside = 0;
      let spanX = 0;
      let spanY = 0;
      game.forEachRecent(0, (x, y) => {
        if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) outside++;
        spanX = Math.max(spanX, (x - b.minX) / (b.maxX - b.minX));
        spanY = Math.max(spanY, (y - b.minY) / (b.maxY - b.minY));
      });
      expect(outside, system.id).toBe(0);
      // …and is not loose: the sample reaches the far edge in both directions,
      // so the figure is not drawn small inside an oversized frame.
      expect(spanX, system.id).toBeGreaterThan(0.99);
      expect(spanY, system.id).toBeGreaterThan(0.99);
    }
  });
});

describe('Occupancy', () => {
  it('counts a cell once, at every level above it', () => {
    const grid = new Occupancy(4);
    expect(grid.size).toBe(16);
    grid.mark(0, 0);
    grid.mark(0, 0);
    grid.mark(1, 1);
    expect(grid.count(4)).toBe(2);
    // Both cells share the level-3 cell (0,0) and everything above it.
    expect(grid.count(3)).toBe(1);
    expect(grid.count(0)).toBe(1);
    grid.mark(15, 15);
    expect(grid.count(4)).toBe(3);
    expect(grid.count(3)).toBe(2);
    expect(grid.count(1)).toBe(2);
  });

  it('ignores points outside the grid rather than piling them on the edge', () => {
    const grid = new Occupancy(4);
    grid.mark(-1, 0);
    grid.mark(0, 16);
    grid.mark(16, 16);
    expect(grid.count(4)).toBe(0);
    expect(grid.has(-1, 0)).toBe(false);
  });

  it('visits exactly the cells it was given, and clears', () => {
    const grid = new Occupancy(5);
    const marked: Array<[number, number]> = [
      [0, 0],
      [31, 0],
      [7, 19],
      [31, 31],
    ];
    for (const [cx, cy] of marked) grid.mark(cx, cy);
    const seen: Array<[number, number]> = [];
    grid.forEachCell((cx, cy, index) => {
      seen.push([cx, cy]);
      expect(index).toBe((cy << 5) + cx);
      expect(grid.has(cx, cy)).toBe(true);
    });
    expect(seen.sort()).toEqual([...marked].sort());
    grid.clear();
    expect(grid.count(5)).toBe(0);
    let after = 0;
    grid.forEachCell(() => after++);
    expect(after).toBe(0);
  });
});

describe('boxCountingDimension', () => {
  it('reads 2 off a solidly filled grid and 1 off a diagonal', () => {
    const filled = new Occupancy(BOX_MAX_LEVEL);
    for (let cy = 0; cy < filled.size; cy++) {
      for (let cx = 0; cx < filled.size; cx++) filled.mark(cx, cy);
    }
    expect(boxCountingDimension(filled)).toBeCloseTo(2, 9);

    const diagonal = new Occupancy(BOX_MAX_LEVEL);
    for (let c = 0; c < diagonal.size; c++) diagonal.mark(c, c);
    expect(boxCountingDimension(diagonal)).toBeCloseTo(1, 9);
  });

  it('reads log 3 / log 2 off an exactly constructed Sierpiński carpet of triangles', () => {
    // The Sierpiński gasket on its own dyadic grid: cell (cx, cy) is in the set
    // when cx & cy === 0, which is Kummer's theorem for odd binomial
    // coefficients — Pascal's triangle mod 2. It has exactly 3ʲ cells at level j,
    // so the regression must return the slope with nothing left over.
    const grid = new Occupancy(BOX_MAX_LEVEL);
    for (let cy = 0; cy < grid.size; cy++) {
      for (let cx = 0; cx + cy < grid.size; cx++) {
        if ((cx & cy) === 0) grid.mark(cx, cy);
      }
    }
    for (let j = BOX_MIN_LEVEL; j <= BOX_MAX_LEVEL; j++) expect(grid.count(j)).toBe(3 ** j);
    expect(boxCountingDimension(grid)).toBeCloseTo(Math.log2(3), 12);
  });

  it('is NaN until two levels have anything in them', () => {
    const empty = new Occupancy(BOX_MAX_LEVEL);
    expect(boxCountingDimension(empty)).toBeNaN();
    empty.mark(0, 0);
    // One cell at every level is one point on the line, not two.
    expect(boxCountingDimension(empty)).toBeCloseTo(0, 12);
  });
});

describe('gridSquare', () => {
  it('squares and pads the bounds so an extreme point still indexes a cell', () => {
    const square = gridSquare({ minX: -2, minY: 0, maxX: 2, maxY: 10 });
    expect(square.span).toBeCloseTo(10.2, 12);
    expect(square.y0).toBeCloseTo(5 - 5.1, 12);
    expect(square.x0).toBeCloseTo(-5.1, 12);
    // The top of the range lands inside the last cell rather than one past it.
    const size = 1024;
    expect((((10 - square.y0) * size) / square.span) | 0).toBeLessThan(size);
  });
});

// ---------------------------------------------------------------------------
// The instance: what the shell actually drives
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
  strokes: Array<{ pen: string; width: number; alpha: number }>;
  texts: Array<{ text: string; style: string }>;
  /** Every assignment to fillStyle, in order — the batching budget. */
  styleWrites: string[];
}

function recordingContext(): Recorder {
  const fills: Fill[] = [];
  const strokes: Array<{ pen: string; width: number; alpha: number }> = [];
  const texts: Array<{ text: string; style: string }> = [];
  const styleWrites: string[] = [];
  let fillStyle = '';
  const api = {
    lineWidth: 1,
    lineJoin: 'miter',
    strokeStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
      styleWrites.push(value);
    },
    clearRect: () => undefined,
    fillRect(x: number, y: number, w: number, h: number): void {
      fills.push({ style: fillStyle, x, y, w, h, alpha: api.globalAlpha });
    },
    strokeRect: () => undefined,
    fillText(text: string): void {
      texts.push({ text, style: fillStyle });
    },
    measureText: () => ({ width: 48 }),
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
    stroke(): void {
      strokes.push({ pen: String(api.strokeStyle), width: api.lineWidth, alpha: api.globalAlpha });
    },
  };
  return { ctx: api as unknown as CanvasRenderingContext2D, fills, strokes, texts, styleWrites };
}

function clearLog(r: Recorder): void {
  r.fills.length = 0;
  r.strokes.length = 0;
  r.texts.length = 0;
  r.styleWrites.length = 0;
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

/** Everything the URL can carry: the shape, the dot count, and the seed the rail never shows. */
const DEFAULTS: Record<string, ParamValue> = {
  system: 'sierpinski',
  points: 200_000,
  seed: SEED,
};

function stubViz(overrides: Record<string, ParamValue> = {}, width = 560, height = 560) {
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
  const instance = chaosGame.create(ctx);
  instance.drawBackground?.();
  return { ctx, bg, fg, emitted, instance };
}

type Viz = ReturnType<typeof stubViz>;

/** The fixed 2,000 points per frame at the 120 Hz tick is exactly 1,000 points per step. */
function tick(v: Viz, steps: number): void {
  for (let i = 0; i < steps; i++) v.instance.step(TICK);
}

/** One frame, with both logs cleared first so they hold exactly that frame. */
function paint(v: Viz): void {
  clearLog(v.bg);
  clearLog(v.fg);
  v.instance.draw();
}

/**
 * Exactly what src/main.ts does with a control change. The logs are cleared
 * before the repaint rather than after, because a full background repaint
 * happens inside `drawBackground()` on a reset and inside `draw()` on an
 * absorbed colour change — and both are what these tests are looking at.
 */
function setParam(v: Viz, key: string, value: ParamValue): boolean {
  v.ctx.params = { ...v.ctx.params, [key]: value };
  const absorbed = v.instance.onParamChange?.(key, value) === true;
  clearLog(v.bg);
  clearLog(v.fg);
  if (!absorbed) {
    v.instance.reset();
    v.instance.drawBackground?.();
  }
  v.instance.draw();
  return absorbed;
}

/** Exactly what src/main.ts does on a resize. */
function resize(v: Viz, width: number, height: number): void {
  v.ctx.width = width;
  v.ctx.height = height;
  clearLog(v.bg);
  clearLog(v.fg);
  v.instance.drawBackground?.();
  v.instance.draw();
}

function ledger(v: Viz): Record<string, number> {
  const last = v.emitted.at(-1);
  expect(last).toBeDefined();
  return Object.fromEntries((last ?? []).map((r) => [r.key, r.value]));
}

describe('chaos-game instance: readouts', () => {
  it('publishes every number it draws, with the analytic target, identically for a seed', () => {
    const a = stubViz();
    const b = stubViz();
    for (const v of [a, b]) {
      tick(v, 200);
      paint(v);
    }
    const last = a.emitted.at(-1);
    expect(last?.map((r) => r.key)).toEqual(['points', 'dimension', 'analytic', 'cells']);
    const by = Object.fromEntries((last ?? []).map((r) => [r.key, r]));
    expect(by['points']?.value).toBe(200_000);
    expect(by['dimension']?.target).toBeCloseTo(similarityDimension(3, 0.5), 12);
    expect(by['analytic']?.value).toBeCloseTo(similarityDimension(3, 0.5), 12);
    expect(Math.abs((by['dimension']?.value ?? 0) - similarityDimension(3, 0.5))).toBeLessThan(
      DIM_TOLERANCE,
    );
    // The ledger's 1% default would call a perfectly good box count unconverged.
    expect(by['dimension']?.tolerance).toBeCloseTo(DIM_TOLERANCE / similarityDimension(3, 0.5), 12);
    expect(b.emitted.at(-1)).toEqual(last);
  });

  it('marks one headline in plain words and demotes the internals to the exact table', () => {
    const v = stubViz();
    tick(v, 20);
    paint(v);
    const rows = v.emitted.at(-1) ?? [];
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    // Exactly one headline, and it is the dimension.
    expect(rows.filter((r) => r.headline === true).map((r) => r.key)).toEqual(['dimension']);
    expect(by['dimension']?.plain).toBe('how crinkly the shape is');
    expect(by['dimension']?.hint).toBe('a filled square scores 2, a line 1');
    expect(by['points']?.plain).toBe('dots placed');
    // What a newcomer sees carries a plain label; what only the table shows need not.
    for (const r of rows) {
      if (r.expertOnly === true) continue;
      expect(r.plain, r.key).toMatch(/^[a-z]/);
    }
    expect(by['analytic']?.expertOnly).toBe(true);
    expect(by['cells']?.expertOnly).toBe(true);
    // The exact table's names, targets and digits are the contract the rest of
    // this file reads, and the plain fields sit beside them rather than
    // replacing them.
    expect(by['dimension']?.label).toBe('Box dimension');
    expect(by['dimension']?.digits).toBe(4);
    expect(by['points']?.label).toBe('Points plotted');
    expect(by['analytic']?.label).toBe('Analytic dimension');
    expect(by['cells']?.label).toBe('Boxes at 1/256');
  });

  it('draws without mutating the simulation, and resets to an empty picture', () => {
    const v = stubViz();
    tick(v, 50);
    paint(v);
    const first = ledger(v);
    paint(v);
    expect(ledger(v)).toEqual(first);
    // A second paint of the same state adds no points to the plate.
    expect(v.bg.fills).toHaveLength(0);
    v.instance.reset();
    v.instance.drawBackground?.();
    paint(v);
    expect(ledger(v)['points']).toBe(0);
    expect(ledger(v)['cells']).toBe(0);
    v.instance.destroy();
  });

  it('publishes the restricted square against log 3 / log 2, the rule’s own closed form', () => {
    // The teaching moment as the ledger sees it: the same four corners, and
    // the target moves from 2 to the Sierpiński triangle's dimension because
    // the shape carries the rule.
    const free = stubViz({ system: 'square', points: 1_000_000 });
    const bound = stubViz({ system: 'square-no-repeat', points: 1_000_000 });
    for (const v of [free, bound]) {
      tick(v, 1_000);
      paint(v);
    }
    const freeRows = Object.fromEntries((free.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    const boundRows = Object.fromEntries((bound.emitted.at(-1) ?? []).map((r) => [r.key, r]));
    expect(freeRows['dimension']?.target).toBe(2);
    expect(boundRows['dimension']?.target).toBeCloseTo(Math.log2(3), 12);
    expect(Math.abs((freeRows['dimension']?.value ?? 0) - 2)).toBeLessThan(DIM_TOLERANCE);
    expect(Math.abs((boundRows['dimension']?.value ?? 0) - Math.log2(3))).toBeLessThan(DIM_TOLERANCE);
  });

  it('reports the fern without a target and the dragon without a claim', () => {
    const fern = stubViz({ system: 'fern', points: 200_000 });
    tick(fern, 200);
    paint(fern);
    expect((fern.emitted.at(-1) ?? []).map((r) => r.key)).toEqual(['points', 'dimension', 'cells']);

    const dragon = stubViz({ system: 'dragon', points: 200_000 });
    tick(dragon, 200);
    paint(dragon);
    const rows = dragon.emitted.at(-1) ?? [];
    expect(rows.map((r) => r.key)).toEqual(['points', 'dimension', 'analytic', 'cells']);
    // log 2 / log √2 = 2 exactly, and the box count over five octaves does not
    // get there, because the dragon's fractal part is its boundary.
    expect(rows.find((r) => r.key === 'analytic')?.value).toBeCloseTo(2, 12);
    expect(rows.find((r) => r.key === 'dimension')?.target).toBeUndefined();
    expect(ledger(dragon)['dimension']).toBeGreaterThan(1.6);
    expect(ledger(dragon)['dimension']).toBeLessThan(1.9);
  });
});

describe('chaos-game instance: parameters', () => {
  function fresh(points: number, steps: number): Record<string, number> {
    const v = stubViz({ points });
    tick(v, steps);
    paint(v);
    return ledger(v);
  }

  it('absorbs a raised ceiling as a prefix continuation, identical to a fresh run', () => {
    const v = stubViz({ points: 20_000 });
    tick(v, 40);
    paint(v);
    expect(ledger(v)['points']).toBe(20_000);

    expect(setParam(v, 'points', 100_000)).toBe(true);
    tick(v, 100);
    paint(v);
    expect(ledger(v)).toEqual(fresh(100_000, 140));
  });

  it('resets on a ceiling below the points already plotted, so the permalink stays honest', () => {
    const v = stubViz({ points: 200_000 });
    tick(v, 200);
    paint(v);
    expect(setParam(v, 'points', 20_000)).toBe(false);
    expect(ledger(v)['points']).toBe(0);
    tick(v, 40);
    paint(v);
    expect(ledger(v)).toEqual(fresh(20_000, 40));
  });

  it('absorbs only a raised ceiling, and defers the shape and the seed to the shell', () => {
    const v = stubViz();
    tick(v, 10);
    expect(v.instance.onParamChange?.('points', 400_000)).toBe(true);
    expect(v.instance.onParamChange?.('system', 'fern')).toBe(false);
    expect(v.instance.onParamChange?.('system', 'square-no-repeat')).toBe(false);
    expect(v.instance.onParamChange?.('seed', 7)).toBe(false);
  });

  it('carries the vertices, the ratio and the rule on the shape', () => {
    // The sliders are gone, so a stray n or r in the URL cannot reach the
    // system: the pentagon is its own (5, 1/(1 + φ)) whatever else is passed.
    const pentagon = resolveSystem({ ...DEFAULTS, system: 'pentagon', n: 8, r: 0.9 });
    expect(pentagon.n).toBe(5);
    expect(pentagon.r).toBeCloseTo(PENTAGON_RATIO, 12);
    expect(pentagon.restriction).toBe('none');
    expect(pentagon.targeted).toBe(true);
    // The one rule on the menu rides on its shape.
    const bound = resolveSystem({ ...DEFAULTS, system: 'square-no-repeat' });
    expect(bound.n).toBe(4);
    expect(bound.r).toBe(0.5);
    expect(bound.restriction).toBe('no-repeat');
    expect(bound.branching).toBe(3);
    expect(bound.dimension).toBeCloseTo(Math.log2(3), 12);
    expect(bound.targeted).toBe(true);
    // An id the menu does not have is the default triangle, not a crash.
    const stray = resolveSystem({ ...DEFAULTS, system: 'polygon' });
    expect(stray.n).toBe(3);
    expect(stray.r).toBe(0.5);
  });

  it('resolves the fern with no corners and no rule', () => {
    const fern = resolveSystem({ ...DEFAULTS, system: 'fern' });
    expect(fern.restriction).toBe('none');
    expect(fern.n).toBe(0);
    expect(fern.targeted).toBe(false);
    // The fern's probabilities are the whole design of the fern; a rule that
    // discarded them would delete the stem.
    expect(findSystem('fern')?.maps.map((m) => m.weight)).toEqual([0.01, 0.85, 0.07, 0.07]);
  });
});

describe('chaos-game instance: painting', () => {
  /**
   * Marks that are not snapped, opaque, one CSS pixel and in an allowed pen.
   * Counted rather than asserted one by one: twenty thousand points is a
   * hundred thousand expect() calls, and one comparison of a counter is free.
   */
  function offSpec(v: Viz, pens: readonly string[]): number {
    let bad = 0;
    for (const f of v.bg.fills) {
      if (
        f.alpha !== 1 ||
        f.w !== 1 ||
        f.h !== 1 ||
        !Number.isInteger(f.x) ||
        !Number.isInteger(f.y) ||
        !pens.includes(f.style)
      ) {
        bad++;
      }
    }
    return bad;
  }

  it('paints snapped, full-strength marks in two pens, one pass each', () => {
    const v = stubViz();
    tick(v, 20);
    paint(v);
    expect(v.bg.fills.length).toBe(20_000);
    // §7: a mark under 3 CSS px is legal snapped and at full coverage — the
    // drafting pen is 9.41:1 solid and 2.56:1 smeared across a hairline.
    expect(offSpec(v, [THEME.data2, THEME.data1])).toBe(0);
    // Colour by vertex is always on: two fill styles for twenty thousand
    // points, not one per point, and both pens actually land on the plate.
    expect(v.bg.styleWrites).toEqual([THEME.data2, THEME.data1]);
    expect(new Set(v.bg.fills.map((f) => f.style))).toEqual(new Set([THEME.data2, THEME.data1]));
  });

  it('repaints the picture in the pens it was plotted in, from the grid rather than the points', () => {
    const v = stubViz();
    tick(v, 200);
    paint(v);
    const points = ledger(v)['points'];
    resize(v, 560, 560);
    expect(ledger(v)['points']).toBe(points);
    // The repaint comes off the occupancy grid, so it inks cells, not points.
    const cells = v.bg.fills.length;
    expect(cells).toBeGreaterThan(1_000);
    expect(cells).toBeLessThan(points ?? 0);
    expect(new Set(v.bg.fills.map((f) => f.style))).toEqual(new Set([THEME.data2, THEME.data1]));
  });

  it('keeps the run and the picture across a resize', () => {
    /** Marks painted outside the plate, counted rather than asserted per mark. */
    const escaped = (v: Viz, w: number, h: number): number =>
      v.bg.fills.filter((f) => f.x < 0 || f.y < 0 || f.x + f.w > w || f.y + f.h > h).length;

    const v = stubViz({}, 400, 400);
    tick(v, 200);
    paint(v);
    const before = ledger(v);

    resize(v, 900, 900);
    // Everything ever plotted comes back, recovered from the grid rather than
    // from two hundred thousand stored coordinates — and the counters do not
    // notice that it happened.
    expect(ledger(v)).toEqual(before);
    expect(v.bg.fills.length).toBeGreaterThan(10_000);
    expect(escaped(v, 900, 900)).toBe(0);

    resize(v, 320, 320);
    expect(ledger(v)).toEqual(before);
    expect(v.bg.fills.length).toBeGreaterThan(10_000);
    expect(escaped(v, 320, 320)).toBe(0);
  });

  it('recovers the picture after a fast-forward longer than the cursor ring', () => {
    // What src/main.ts does for a reduced-motion cold start: thousands of ticks
    // with one paint at the end. More points are plotted than the ring holds, so
    // the background comes back off the grid instead of off the ring.
    const v = stubViz({ points: 1_000_000 });
    tick(v, 1_000);
    paint(v);
    expect(ledger(v)['points']).toBe(1_000_000);
    expect(v.bg.fills.length).toBeGreaterThan(10_000);
    expect(Math.abs((ledger(v)['dimension'] ?? 0) - similarityDimension(3, 0.5))).toBeLessThan(
      DIM_TOLERANCE,
    );
  });

  it('draws the apparatus once, on the background, and writes no text on the plate', () => {
    const v = stubViz({ system: 'square' });
    // The polygon outline is the frame; the vertices are the experiment.
    expect(v.bg.strokes.some((s) => s.pen === THEME.gridSoft)).toBe(true);
    expect(v.bg.styleWrites).toContain(THEME.grid);
    // No numerals at the corners and no reading in the corner of the plate:
    // every number this tab shows is in the readouts, in words.
    expect(v.bg.texts).toEqual([]);
    tick(v, 10);
    paint(v);
    expect(v.fg.texts).toEqual([]);
    // …and the apparatus is not repainted per frame.
    expect(v.bg.strokes).toEqual([]);
  });

  it('keeps the live cursor in the signal pen, never as a hairline', () => {
    const v = stubViz();
    tick(v, 5);
    paint(v);
    const trail = v.fg.strokes.filter((s) => s.pen === THEME.data1);
    expect(trail.length).toBeGreaterThan(0);
    for (const s of trail) {
      expect(s.width).toBeGreaterThanOrEqual(2 * THEME.lineWidth);
      expect(s.alpha).toBe(1);
    }
  });
});

describe('layoutView', () => {
  it('uses one scale for both axes and centres the figure', () => {
    const bounds = { minX: -1, minY: -0.5, maxX: 1, maxY: 1 };
    const view = layoutView(600, 400, bounds, 10);
    // The height binds: 1.5 units into 380 px is tighter than 2 into 580.
    expect(view.scale).toBeCloseTo(380 / 1.5, 9);
    // The figure's centre lands on the plate's centre, y flipped.
    expect(view.originX + view.scale * 0).toBeCloseTo(300, 9);
    expect(view.originY - view.scale * 0.25).toBeCloseTo(200, 9);
  });

  it('keeps the whole attractor inside the margin at every plate shape', () => {
    const bounds = { minX: -0.866, minY: -0.5, maxX: 0.866, maxY: 1 };
    for (const [w, h] of [[320, 320], [900, 500], [500, 900], [1_280, 720]] as const) {
      const view = layoutView(w, h, bounds, 8);
      for (const x of [bounds.minX, bounds.maxX]) {
        const px = view.originX + view.scale * x;
        expect(px, `${w}×${h}`).toBeGreaterThanOrEqual(8 - 1e-9);
        expect(px, `${w}×${h}`).toBeLessThanOrEqual(w - 8 + 1e-9);
      }
      for (const y of [bounds.minY, bounds.maxY]) {
        const py = view.originY - view.scale * y;
        expect(py, `${w}×${h}`).toBeGreaterThanOrEqual(8 - 1e-9);
        expect(py, `${w}×${h}`).toBeLessThanOrEqual(h - 8 + 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** One sentence: a single terminal mark, at the end. */
function oneSentence(text: unknown): boolean {
  return typeof text === 'string' && /^[^.!?]+[.!?]$/.test(text.trim());
}

describe('chaos-game metadata', () => {
  it('declares two controls and a seed the rail never shows', () => {
    expect(chaosGame.id).toBe('chaos-game');
    expect(chaosGame.group).toBe('chaos');
    expect(chaosGame.params.map((p) => p.key)).toEqual(['system', 'points', 'seed']);
    // The seed stays a spec so the URL keeps carrying it and Shuffle has
    // something to redraw; the rail skips the kind, so it is not a control.
    expect(chaosGame.params.find((p) => p.key === 'seed')?.kind).toBe('seed');
    expect(chaosGame.params.filter((p) => p.kind !== 'seed')).toHaveLength(2);
    expect(chaosGame.params.map((p) => p.label)).toEqual(['Shape', 'Dots', 'Seed']);
    expect(chaosGame.budget?.maxEntities).toBe(2_000_000);
    expect(chaosGame.aspect).toBe(1);
    expect(chaosGame.aspectNarrow).toBe(1);
  });

  it('offers every named system as a shape, the restricted square, and nothing else', () => {
    const system = chaosGame.params.find((p) => p.key === 'system');
    expect(system?.kind).toBe('choice');
    const values = system?.kind === 'choice' ? system.options.map((o) => o.value) : [];
    expect(values).toEqual(SHAPES.map((s) => s.id));
    // Every system in the catalogue is reachable from the menu…
    for (const named of NAMED_SYSTEMS) {
      expect(SHAPES.some((s) => s.system.id === named.id), named.id).toBe(true);
    }
    // …and exactly one entry carries a rule: the square that never repeats a corner.
    const ruled = SHAPES.filter((s) => s.restriction !== 'none');
    expect(ruled.map((s) => [s.id, s.system.id, s.restriction])).toEqual([
      ['square-no-repeat', 'square', 'no-repeat'],
    ]);
    // Shape names a reader can use without looking anything up.
    const labels = system?.kind === 'choice' ? system.options.map((o) => o.label) : [];
    expect(labels).toEqual([
      'Triangle',
      'Pentagon',
      'Square',
      'Square, never the same corner twice',
      'Fern',
      'Dragon curve',
    ]);
  });

  it('walks to the insight in three presets, the last two one control apart', () => {
    const presets = chaosGame.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['triangle', 'square-fills', 'add-a-rule']);
    for (const preset of presets) {
      expect(oneSentence(preset.caption), `preset ${preset.id} caption`).toBe(true);
      for (const key of Object.keys(preset.values)) {
        expect(
          chaosGame.params.some((p) => p.key === key),
          `preset ${preset.id} sets unknown param ${key}`,
        ).toBe(true);
      }
    }
    // The moment is one control apart: the two square presets differ only in
    // the shape, and the shape is what carries the rule.
    const fills = presets.find((p) => p.id === 'square-fills');
    const ruled = presets.find((p) => p.id === 'add-a-rule');
    const differing = Object.keys(ruled?.values ?? {}).filter(
      (k) => ruled?.values[k] !== fills?.values[k],
    );
    expect(differing).toEqual(['system']);
    expect(fills?.values['system']).toBe('square');
    expect(ruled?.values['system']).toBe('square-no-repeat');
    // The first chip is the default configuration, so it reads as pressed on arrival.
    const first = presets[0];
    for (const spec of chaosGame.params) {
      if (spec.kind === 'seed') continue;
      expect(first?.values[spec.key], spec.key).toBe(spec.default);
    }
  });

  it('keeps to two facts, one sentence each, both sourced', () => {
    expect(chaosGame.facts.length).toBeGreaterThanOrEqual(1);
    expect(chaosGame.facts.length).toBeLessThanOrEqual(2);
    for (const fact of chaosGame.facts) {
      expect(oneSentence(fact.text)).toBe(true);
      expect(fact.source.label.length).toBeGreaterThan(0);
      expect(fact.source.url).toMatch(/^https:\/\//);
    }
    expect(oneSentence(chaosGame.blurb)).toBe(true);
  });
});
