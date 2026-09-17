import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasTheme } from '../src/core/types';
import {
  CANVAS_THEME_VARS,
  DEFAULT_CANVAS_THEME,
  computeBackingSize,
  createStage,
} from '../src/core/canvas';
import { ensureCanvasFont, strokeWithHalo } from '../src/core/paint';
import { installDom, type Harness, type MElement } from './dom-harness';

/** WCAG 2.x relative luminance of a `#rrggbb` colour, in [0, 1]. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio, in [1, 21]. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('computeBackingSize', () => {
  it('scales the CSS box by the device-pixel ratio', () => {
    expect(computeBackingSize(300, 150, 2, 2)).toEqual({ w: 600, h: 300, dpr: 2 });
  });

  it('passes a ratio inside the cap through unchanged', () => {
    expect(computeBackingSize(100, 100, 1.5, 2).dpr).toBe(1.5);
  });

  it('caps the ratio at maxDpr', () => {
    expect(computeBackingSize(100, 100, 3, 2)).toEqual({ w: 200, h: 200, dpr: 2 });
    expect(computeBackingSize(100, 100, 1.5, 1)).toEqual({ w: 100, h: 100, dpr: 1 });
  });

  it('never renders below 1x', () => {
    expect(computeBackingSize(100, 100, 0.5, 2)).toEqual({ w: 100, h: 100, dpr: 1 });
    expect(computeBackingSize(100, 100, 0, 2).dpr).toBe(1);
    expect(computeBackingSize(100, 100, -2, 2).dpr).toBe(1);
  });

  it('treats a non-finite ratio as 1x', () => {
    expect(computeBackingSize(100, 100, Number.NaN, 2).dpr).toBe(1);
    expect(computeBackingSize(100, 100, Number.POSITIVE_INFINITY, 2).dpr).toBe(1);
  });

  it('lets the 1x floor win over a maxDpr below 1 or non-finite', () => {
    expect(computeBackingSize(100, 100, 0.5, 0.5).dpr).toBe(1);
    expect(computeBackingSize(100, 100, 2, 0).dpr).toBe(1);
    expect(computeBackingSize(100, 100, 2, Number.NaN).dpr).toBe(1);
  });

  it('rounds fractional stores to whole device pixels, within half a pixel of exact', () => {
    // 333 × 1.5 = 499.5 and 111 × 1.5 = 166.5: both land exactly on a rounding boundary.
    const { w, h } = computeBackingSize(333, 111, 1.5, 2);
    expect(Number.isInteger(w)).toBe(true);
    expect(Number.isInteger(h)).toBe(true);
    expect(Math.abs(w - 333 * 1.5)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(h - 111 * 1.5)).toBeLessThanOrEqual(0.5);
  });

  it('never returns a zero-sized store', () => {
    // 0.2 × 2 rounds to 0, which exercises the floor after rounding, not just before.
    const boxes = [
      [0, 0],
      [-5, 10],
      [Number.NaN, 20],
      [0.2, 0.2],
    ] as const;
    for (const [cssW, cssH] of boxes) {
      const { w, h } = computeBackingSize(cssW, cssH, 2, 2);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(w)).toBe(true);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

const COLOR_FIELDS = [
  'canvas',
  'ink',
  'inkMuted',
  'grid',
  'gridSoft',
  'data1',
  'data2',
  'data3',
  'data3Fill',
  'accent',
] as const satisfies readonly (keyof CanvasTheme)[];

describe('DEFAULT_CANVAS_THEME', () => {
  const t = DEFAULT_CANVAS_THEME;

  it('fills every field with a usable value', () => {
    // The type annotation already forces every CanvasTheme field to exist; this
    // checks the values are the kind the canvas API will accept.
    for (const key of COLOR_FIELDS) expect(t[key]).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.labelFont).toMatch(/^\d+px /);
    expect(t.lineWidth).toBeGreaterThan(0);
    expect(t.particleRadius).toBeGreaterThan(0);
  });

  it('is frozen, since every themeless host shares the one object', () => {
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('keeps ink at WCAG AAA (7:1) and muted ink at AA (4.5:1) against the ground', () => {
    expect(contrast(t.ink, t.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(t.inkMuted, t.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every data mark and the accent at the 3:1 non-text minimum against the ground', () => {
    for (const key of ['data1', 'data2', 'data3', 'accent'] as const) {
      expect(contrast(t[key], t.canvas)).toBeGreaterThanOrEqual(3);
    }
  });

  it('orders the neutrals so structure recedes: ground > grid > muted ink > ink', () => {
    expect(luminance(t.canvas)).toBeGreaterThan(luminance(t.grid));
    expect(luminance(t.grid)).toBeGreaterThan(luminance(t.inkMuted));
    expect(luminance(t.inkMuted)).toBeGreaterThan(luminance(t.ink));
  });

  it('uses three distinct data colours, none of them a neutral', () => {
    const data = [t.data1, t.data2, t.data3];
    expect(new Set(data).size).toBe(3);
    const neutrals = [t.canvas, t.ink, t.inkMuted, t.grid, t.gridSoft];
    for (const c of data) expect(neutrals).not.toContain(c);
  });

  it('keeps container structure at the 3:1 non-text minimum, and distinct from the experiment’s own', () => {
    // Bin dividers, axes, floors and frames are recessive but still graphical
    // objects: a reader has to be able to see where the bins are.
    expect(contrast(t.gridSoft, t.canvas)).toBeGreaterThanOrEqual(3);
    expect(t.gridSoft).not.toBe(t.grid);
  });

  it('makes the area a wash a particle can sit on plus a silhouette that carries the shape', () => {
    // The two-mark rule. No single colour is both 3:1 on the plate and 3:1
    // under the particles, so `data3Fill` is deliberately exempt from the 3:1
    // loop above — it is never the sole encoding — while the dots that land on
    // it and the silhouette that outlines it both have to clear the bar.
    expect(contrast(t.data1, t.data3Fill)).toBeGreaterThanOrEqual(3);
    expect(contrast(t.data3, t.canvas)).toBeGreaterThanOrEqual(3);
    // A wash sits between the plate and its own pen: lighter than the
    // silhouette, darker than the ground it is painted on.
    expect(luminance(t.canvas)).toBeGreaterThan(luminance(t.data3Fill));
    expect(luminance(t.data3Fill)).toBeGreaterThan(luminance(t.data3));
  });
});

describe('CANVAS_THEME_VARS', () => {
  it('names exactly one custom property per theme field', () => {
    expect(Object.keys(CANVAS_THEME_VARS).sort()).toEqual(Object.keys(DEFAULT_CANVAS_THEME).sort());
  });

  it('uses well-formed, distinct custom-property names', () => {
    const names = Object.values(CANVAS_THEME_VARS);
    for (const name of names) expect(name).toMatch(/^--[a-z][a-z0-9-]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('pins the names the theme stylesheet must define', () => {
    // The shell's theme.css is written against these strings. Renaming one here
    // is a contract change, not a refactor.
    expect(CANVAS_THEME_VARS).toEqual({
      canvas: '--canvas',
      ink: '--ink',
      inkMuted: '--ink-muted',
      grid: '--grid',
      gridSoft: '--grid-soft',
      data1: '--data-1',
      data2: '--data-2',
      data3: '--data-3',
      data3Fill: '--data-3-fill',
      accent: '--accent',
      labelFont: '--canvas-label-font',
      lineWidth: '--canvas-line-width',
      particleRadius: '--canvas-particle-radius',
    });
  });
});

/**
 * A context that records what each `stroke()` saw. `strokeWithHalo` is one of
 * the few pieces of canvas code that is worth a unit test: it is not "draw the
 * thing twice", it is "draw the thing twice *in this order, at these widths*",
 * and getting the order backwards paints the mark and then buries it.
 */
interface Recorder {
  strokeStyle: string;
  lineWidth: number;
  /** Positive while inside a save()/restore() pair; must end at zero. */
  depth: number;
  strokes: { path: Path2D | undefined; pen: string; width: number }[];
  save(): void;
  restore(): void;
  stroke(path?: Path2D): void;
}

function recorder(): Recorder {
  const r: Recorder = {
    strokeStyle: '',
    lineWidth: 0,
    depth: 0,
    strokes: [],
    save() {
      r.depth++;
    },
    restore() {
      r.depth--;
    },
    stroke(path?: Path2D) {
      r.strokes.push({ path, pen: r.strokeStyle, width: r.lineWidth });
    },
  };
  return r;
}

function asContext(r: Recorder): CanvasRenderingContext2D {
  return r as unknown as CanvasRenderingContext2D;
}

describe('strokeWithHalo', () => {
  const PLATE = '#ffffff';
  const PEN = '#24467a';

  it('lays the plate colour down first, wider, then the pen on top', () => {
    const r = recorder();
    strokeWithHalo(asContext(r), undefined, PEN, PLATE, 2);
    expect(r.strokes).toEqual([
      { path: undefined, pen: PLATE, width: 6 },
      { path: undefined, pen: PEN, width: 2 },
    ]);
  });

  it('takes the narrower halo a thin mark asks for', () => {
    const r = recorder();
    strokeWithHalo(asContext(r), undefined, PEN, PLATE, 2, 2);
    expect(r.strokes.map((s) => s.width)).toEqual([4, 2]);
  });

  it('strokes one and the same path twice, so the halo cannot drift off register', () => {
    const r = recorder();
    // Path2D is a DOM class and does not exist here; identity is what matters.
    const path = { id: 'curve' } as unknown as Path2D;
    strokeWithHalo(asContext(r), path, PEN, PLATE, 2);
    expect(r.strokes).toHaveLength(2);
    expect(r.strokes[0]?.path).toBe(path);
    expect(r.strokes[1]?.path).toBe(path);
  });

  it('leaves the context state as it found it', () => {
    const r = recorder();
    r.strokeStyle = '#d53619';
    r.lineWidth = 1;
    strokeWithHalo(asContext(r), undefined, PEN, PLATE, 2);
    // save()/restore() balance is what puts the caller's pen back; a leaked
    // strokeStyle would silently repaint whatever the caller drew next.
    expect(r.depth).toBe(0);
  });
});

describe('ensureCanvasFont', () => {
  const g = globalThis as unknown as { document?: unknown };

  it('resolves where the font API is absent, rather than blocking the first paint', async () => {
    await expect(ensureCanvasFont('500 11px "Martian Mono"')).resolves.toBeUndefined();
  });

  it('asks for exactly the shorthand the canvas will use', async () => {
    const asked: string[] = [];
    g.document = {
      fonts: {
        load(font: string) {
          asked.push(font);
          return Promise.resolve([]);
        },
      },
    };
    try {
      await ensureCanvasFont('500 11px "Martian Mono", monospace');
    } finally {
      delete g.document;
    }
    // Verbatim: `ctx.font` and `fonts.load()` parse the same shorthand, and a
    // face requested at the wrong weight is a face that never arrives.
    expect(asked).toEqual(['500 11px "Martian Mono", monospace']);
  });

  it('resolves when the face never loads: a fallback family is still legible', async () => {
    g.document = {
      fonts: {
        load: () => Promise.reject(new SyntaxError('unparseable font shorthand')),
      },
    };
    try {
      await expect(ensureCanvasFont('nonsense')).resolves.toBeUndefined();
    } finally {
      delete g.document;
    }
  });
});

/**
 * A browser that will not give out a 2D context.
 *
 * Not hypothetical: a canvas-blocking privacy extension, iOS Safari past its
 * total-canvas-memory ceiling, and a crashed GPU process all answer
 * `getContext('2d')` with null. It used to throw from here, out through
 * `activate()` and past a `teardown()` that had already emptied the bench, and
 * the reader was left with a blank white plate and no message — on this tab and
 * on every tab they clicked afterwards, for the life of the page.
 *
 * So the refusal is in the return type. `Stage | null` is a value the compiler
 * makes the caller handle, where a throw was something it could not see.
 */
describe('createStage', () => {
  let dom: Harness | null = null;
  let restoreCreateElement: (() => void) | null = null;

  afterEach(() => {
    restoreCreateElement?.();
    restoreCreateElement = null;
    dom?.teardown();
    dom = null;
  });

  /** Let `allowed` canvases have a context; every one after that answers null. */
  function denyContextAfter(harness: Harness, allowed: number): void {
    const document = harness.document;
    const real = document.createElement.bind(document);
    let made = 0;
    restoreCreateElement = () => {
      document.createElement = real;
    };
    document.createElement = (tag: string): MElement => {
      const el = real(tag);
      if (tag === 'canvas' && ++made > allowed) el.getContext = () => null;
      return el;
    };
  }

  function host(harness: Harness): HTMLElement {
    return harness.app as unknown as HTMLElement;
  }

  it('stacks two layers on the host and sizes them to it', () => {
    dom = installDom();
    const stage = createStage(host(dom));

    expect(stage).not.toBeNull();
    expect(dom.app.children).toHaveLength(2);
    expect(stage?.width).toBe(900);
    expect(stage?.height).toBe(600);

    stage?.destroy();
    expect(dom.app.children).toHaveLength(0);
    expect(dom.app.classList.contains('stage')).toBe(false);
  });

  it('answers null instead of throwing when no context is given out', () => {
    dom = installDom();
    denyContextAfter(dom, 0);

    expect(createStage(host(dom))).toBeNull();
  });

  it('leaves the host exactly as it found it, so the caller can say so in it', () => {
    dom = installDom();
    const before = dom.app.className;
    denyContextAfter(dom, 0);

    createStage(host(dom));

    // A half-built stage is worse than none: the canvases would cover whatever
    // message the caller puts here, and the `position: relative` would outlive
    // the refusal.
    expect(dom.app.children).toHaveLength(0);
    expect(dom.app.className).toBe(before);
    expect(dom.app.style['position']).toBeUndefined();
  });

  it('refuses whole when only the second layer is refused', () => {
    dom = installDom();
    denyContextAfter(dom, 1);

    // Both layers are built before the host is touched, so the second refusal
    // is not a case that has to be unwound — there is nothing to unwind.
    expect(createStage(host(dom))).toBeNull();
    expect(dom.app.children).toHaveLength(0);
  });
});
