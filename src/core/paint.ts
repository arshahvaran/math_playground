/**
 * Painting rules that belong to the design system rather than to any one
 * visualization — docs/DESIGN.md §7. The shell needs them (it paints the first
 * frame of every tab and owns font loading) and so does every visualization, so
 * they live in core/ rather than in whichever directory needed them first.
 *
 * Nothing here reads a colour: every colour arrives as an argument, from
 * `VizContext.theme`.
 */

/** Extra width for the halo under a curve. §7: `+ 4` for curves, `+ 2` for marks. */
const CURVE_HALO = 4;

/**
 * Stroke `path` twice: once in the plate colour at `lineWidth + haloWidth`, then
 * in `pen` at `lineWidth`.
 *
 * The halo is what makes the pens safe to overlay. `--data-1` against `--data-2`
 * is 1.96:1, and a `--data-2` curve crossing its own histogram lands on a wash
 * it only clears at 6.41:1 in the best case — so the plate colour is laid down
 * between them and the two pens never actually touch. §7 makes this a shared
 * helper on purpose: it was "recommended" per visualization once, and nothing
 * ever drew it.
 *
 * `path` may be omitted, in which case the context's current path is stroked —
 * the shape a visualization already has after batching hundreds of segments
 * through `beginPath()` / `lineTo()`, with no `Path2D` to allocate per frame.
 * Both strokes use the same path, so the halo can never be a pixel out of
 * register with the mark it sits under.
 */
export function strokeWithHalo(
  ctx: CanvasRenderingContext2D,
  path: Path2D | undefined,
  pen: string,
  haloColor: string,
  lineWidth: number,
  haloWidth: number = CURVE_HALO,
): void {
  ctx.save();
  ctx.lineWidth = lineWidth + haloWidth;
  ctx.strokeStyle = haloColor;
  if (path) ctx.stroke(path);
  else ctx.stroke();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = pen;
  if (path) ctx.stroke(path);
  else ctx.stroke();
  ctx.restore();
}

/**
 * Ask for the in-canvas label font, and say when it has arrived.
 *
 * `ctx.font` fails silently, and canvas text never triggers a load: with
 * `display=swap` a cold load draws every axis numeral in the fallback
 * (Consolas) and, because a background layer is repainted only on init, resize
 * and parameter change, they stay that way for the life of the tab. §7
 * therefore requires *requesting* the face alongside the first
 * `drawBackground()` and repainting when it lands — which is the caller's job,
 * since only the caller knows what to repaint. Never awaited before that first
 * paint: a blackholed request is a promise that never settles, and painting
 * behind one leaves the plate blank and the ledger empty for the life of the
 * tab. Whatever face is available is legible; the network does not gate a paint.
 *
 * Resolves immediately, and never rejects, where the API is missing (a
 * non-browser host, an old engine) or where the shorthand is one the font
 * parser refuses: an unloaded face degrades to the next family in the stack,
 * which is legible, so this is never worth failing a render over.
 */
export async function ensureCanvasFont(labelFont: string): Promise<void> {
  const fonts: FontFaceSet | undefined =
    typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts || typeof fonts.load !== 'function') return;
  try {
    await fonts.load(labelFont);
  } catch {
    // A shorthand the parser rejects, or a face that never arrives.
  }
}
