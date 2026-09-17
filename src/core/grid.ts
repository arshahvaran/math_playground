/**
 * The one value grid a `range` parameter lives on.
 *
 * A range spec declares `min`, `max` and `step`, and that triple defines a set
 * of reachable values — `min + k·step`, clamped to the ends. Two layers have to
 * agree about it: the rail, which draws a thumb on it, and the router, which
 * reads a number out of a fragment a human typed. When they disagree the page
 * runs one experiment and displays another — the address bar said `temp=2.27`,
 * the fader said 2.25, and the physics followed the URL.
 *
 * It disagreed because there were two quantisers. The rail snapped to the
 * *grid*; the router rounded to the step's *decimal places*, which for any step
 * that is not a power of ten (5, 40, 0.05, 1000) is not a snap at all. This
 * module is the grid, and both layers call it, so there is no second definition
 * to drift from. It is arithmetic, not DOM, which is why it lives in core.
 */

/**
 * Decimals a value on this step grid needs to print without rounding away.
 * Capped at twelve, which is what the finest step in the registry — the
 * Lorenz twins' 10⁻¹² starting gap — needs to survive `toFixed()`: at ten,
 * that gap quantised to exactly 0.
 */
const MAX_DECIMALS = 12;

export function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0;
  const text = String(step);
  const e = text.indexOf('e');
  if (e < 0) return Math.min(MAX_DECIMALS, (text.split('.')[1] ?? '').length);
  // 1e-7 prints in exponent form; the exponent is where the decimals went.
  const exponent = Number(text.slice(e + 1));
  const mantissa = (text.slice(0, e).split('.')[1] ?? '').length;
  return Math.min(MAX_DECIMALS, Math.max(0, mantissa - exponent));
}

/**
 * A value on the grid the parameter actually takes: on `step`, inside the ends,
 * and rounded back out of the binary noise snapping accumulates — the number is
 * about to be printed, compared against a default and put in a URL.
 *
 * Idempotent by construction: `snapToStep(snapToStep(v)) === snapToStep(v)`,
 * which is the property that makes a permalink reproduce the run it advertises.
 * A non-finite value has no nearest grid point and takes the low end.
 */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  const decimals = decimalsForStep(step);
  const clamped = value < min ? min : value > max ? max : value;
  if (!Number.isFinite(clamped)) return min;
  if (!(step > 0) || !Number.isFinite(step)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  const bounded = snapped < min ? min : snapped > max ? max : snapped;
  return decimals > 0 ? Number(bounded.toFixed(decimals)) : Math.round(bounded);
}
