import type { Rng } from '../../core/types';

/**
 * Buffon's needle: the mathematics, with no canvas in sight.
 *
 * The plane is ruled by horizontal lines at y = k·d. A needle of length L ≤ d
 * lands with its centre uniform over the field and its angle θ uniform in
 * [0, π). Write y₀ for the distance from the centre down to the line above it.
 * The needle reaches (L/2)·|sin θ| above and below its centre, so it crosses
 * the line above when y₀ ≤ (L/2)·|sin θ| and the line below when
 * d − y₀ ≤ (L/2)·|sin θ|. Averaging over y₀ ~ U[0, d) and θ ~ U[0, π):
 *
 *   P(cross) = (1/π) ∫₀^π (L·|sin θ| / d) dθ = 2L / (π·d)
 *
 * so π ≈ 2·L·N / (d·C) after C crossings in N drops. Everything the tab shows
 * is a function of those two counters.
 */

export interface Needle {
  x: number;
  y: number;
  /** Radians from the horizontal, in [0, π). */
  angle: number;
  crosses: boolean;
}

/**
 * Whether a needle centred at height `y` with angle `angle` meets a ruled line.
 *
 * Only the projection onto the axis perpendicular to the lines matters: a
 * horizontal needle reaches 0 px and can cross only if its centre sits exactly
 * on a line. The modulus is written with `floor` rather than `%` so a negative
 * `y` still lands in [0, spacing).
 */
export function needleCrosses(y: number, angle: number, length: number, spacing: number): boolean {
  const reach = 0.5 * length * Math.abs(Math.sin(angle));
  const y0 = y - Math.floor(y / spacing) * spacing;
  return y0 <= reach || spacing - y0 <= reach;
}

/**
 * One drop. Four draws from `rng`, always in the same order, so a seed
 * reproduces the needle sequence exactly:
 *
 *   1. y₀, the centre's height above the line below it, uniform in [0, spacing)
 *   2. θ, uniform in [0, π)
 *   3. x, uniform across `width`
 *   4. the strip the needle is painted in, uniform over the whole strips in `height`
 *
 * Crossing is decided by y₀ and θ alone, before the layout is consulted, so
 * the crossing sequence for a seed — and every readout with it — is the same
 * at any canvas size, which is what lets a permalink reproduce a run on
 * someone else's window. The field only decides where the needle is painted.
 * Sampling y over the whole field height and reducing mod d would give the
 * same distribution but tie each outcome to how many strips fit the screen:
 * frac(u · rows) flips with rows, and a resize mid-run would fork the run.
 *
 * Centres land only in whole strips, so every painted needle lies between two
 * ruled lines; a `height` under one strip still gets one.
 */
export function dropNeedle(
  rng: Rng,
  width: number,
  height: number,
  length: number,
  spacing: number,
): Needle {
  const y0 = rng.range(0, spacing);
  const angle = rng.range(0, Math.PI);
  const x = rng.range(0, width);
  const strips = Math.max(1, Math.floor(height / spacing));
  const strip = rng.int(0, strips - 1);
  return { x, y: strip * spacing + y0, angle, crosses: needleCrosses(y0, angle, length, spacing) };
}

/**
 * P(cross) = 2L/(πd), the short-needle case L ≤ d.
 *
 * For L > d a needle can cross two lines and the probability becomes
 * (2/π)·(L/d − √((L/d)² − 1) + arcsec(L/d)). The tab caps L/d at 1, so that
 * case is out of scope here and `length` is clamped to [0, spacing] instead.
 */
export function crossingProbability(length: number, spacing: number): number {
  const l = Math.min(Math.max(length, 0), spacing);
  return (2 * l) / (Math.PI * spacing);
}

/**
 * Invert P = 2L/(πd) with the observed fraction C/N in place of P.
 * Undefined before the first crossing, hence NaN rather than Infinity.
 */
export function estimatePi(drops: number, crossings: number, length: number, spacing: number): number {
  if (crossings === 0) return NaN;
  return (2 * length * drops) / (spacing * crossings);
}

/**
 * Standard error of the π estimate after `drops` needles, by the delta method.
 *
 * The observed fraction p̂ = C/N is binomial with Var(p̂) = P(1−P)/N. The
 * estimator is g(p̂) = 2L/(d·p̂), with g'(P) = −2L/(d·P²) = −π/P. So
 *
 *   Var(π̂) ≈ g'(P)²·Var(p̂) = (π/P)²·P(1−P)/N = π²(1−P)/(P·N)
 *   SE(π̂) ≈ π·√((1−P)/(P·N))
 *
 * At N = 10⁵ and L/d = 0.8 this is 0.0098 — two correct digits, not five, which
 * is the honest speed of the method. Infinity for N = 0 or L = 0: no crossings
 * possible, no information about π.
 */
export function piStandardError(drops: number, length: number, spacing: number): number {
  const p = crossingProbability(length, spacing);
  return Math.PI * Math.sqrt((1 - p) / (p * drops));
}

/**
 * The needles on screen, plus the statistics of every needle ever dropped.
 *
 * A ring buffer over typed arrays allocated once at the budget: after
 * `capacity` drops the oldest needle is overwritten, so the visible field never
 * grows past the budget however long the tab runs. `drops` and `crossings` are
 * counters, not the buffer length — they keep going after the buffer wraps,
 * because the estimate must use every drop, not just the ones still drawn.
 */
export class NeedleField {
  readonly capacity: number;

  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  /**
   * Direction as (cos θ, sin θ), taken once at push. A needle never moves, so
   * the painter wants its half-vector, not its angle — and 20,000 sin/cos
   * pairs per frame were a measurable slice of the budget at full capacity.
   */
  private readonly cosines: Float32Array;
  private readonly sines: Float32Array;
  private readonly crossFlags: Uint8Array;

  /** Slot the next push writes to. */
  private head = 0;
  /** Live entries, ≤ capacity. */
  private stored = 0;
  private total = 0;
  private crossed = 0;

  constructor(budget: number) {
    this.capacity = Math.max(1, Math.floor(budget));
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);
    this.cosines = new Float32Array(this.capacity);
    this.sines = new Float32Array(this.capacity);
    this.crossFlags = new Uint8Array(this.capacity);
  }

  /** Needles currently held, at most `capacity`. */
  get count(): number {
    return this.stored;
  }

  /** Every needle ever pushed since the last reset, including overwritten ones. */
  get drops(): number {
    return this.total;
  }

  /** Every crossing ever pushed since the last reset. */
  get crossings(): number {
    return this.crossed;
  }

  push(n: Needle): void {
    const i = this.head;
    this.xs[i] = n.x;
    this.ys[i] = n.y;
    this.cosines[i] = Math.cos(n.angle);
    this.sines[i] = Math.sin(n.angle);
    this.crossFlags[i] = n.crosses ? 1 : 0;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.stored < this.capacity) this.stored++;
    this.total++;
    if (n.crosses) this.crossed++;
  }

  /**
   * Visit the held needles oldest first, so a painter that follows this order
   * lands the newest needle on top. `index` is the chronological position among
   * the held needles, 0 for the oldest; `from` skips the first `from` of them,
   * so a painter that already has them on screen can pick up where it left off.
   */
  forEach(
    cb: (x: number, y: number, cos: number, sin: number, crosses: boolean, index: number) => void,
    from = 0,
  ): void {
    // Until the buffer wraps the oldest entry is slot 0; afterwards it is the
    // slot `head` is about to overwrite.
    const start = this.stored < this.capacity ? 0 : this.head;
    for (let i = Math.max(0, from); i < this.stored; i++) {
      let slot = start + i;
      if (slot >= this.capacity) slot -= this.capacity;
      cb(
        this.xs[slot] ?? 0,
        this.ys[slot] ?? 0,
        this.cosines[slot] ?? 1,
        this.sines[slot] ?? 0,
        this.crossFlags[slot] === 1,
        i,
      );
    }
  }

  /** Forget every needle and zero the counters. The arrays are kept; nothing reallocates. */
  reset(): void {
    this.head = 0;
    this.stored = 0;
    this.total = 0;
    this.crossed = 0;
  }
}
