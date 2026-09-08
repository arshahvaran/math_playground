import type { CanvasTheme, Layers } from './types';

/**
 * The canvas host.
 *
 * Two stacked canvases, one coordinate system, sized to the device. This is the
 * piece of canvas plumbing every visualization would otherwise repeat and get
 * subtly wrong: a backing store that matches the CSS size is blurry on any
 * high-density display, and one sized at the full device ratio on a 4K screen
 * at 3x is 36 megapixels of foreground to clear every frame. The `maxDpr` cap
 * settles that trade — 2x is indistinguishable from 3x at viewing distance and
 * costs a quarter of the fill.
 *
 * The shell owns the host element and the theme. Visualizations see only the
 * `Layers` and the CSS-pixel size, through `VizContext`.
 */

export interface StageOptions {
  /** Ceiling on the device-pixel ratio. Default 2. */
  maxDpr?: number;
}

export interface Stage {
  layers: Layers;
  /** CSS pixels — the units `draw()` uses. Updated in place on resize. */
  readonly width: number;
  readonly height: number;
  /** The ratio actually applied, after the `maxDpr` clamp. */
  readonly dpr: number;
  /**
   * Called after the canvases have been re-sized and re-transformed. Re-sizing
   * wipes both bitmaps, so the subscriber must repaint the background. Returns
   * an unsubscribe function.
   */
  onResize(cb: (w: number, h: number) => void): () => void;
  /** Clear both layers to transparent. */
  clearAll(): void;
  /** Stop observing, remove the canvases, and undo what `createStage` set on the host. */
  destroy(): void;
}

export interface BackingSize {
  /** Device pixels. */
  w: number;
  h: number;
  /** The ratio actually applied, after clamping. */
  dpr: number;
}

/**
 * Backing-store size for a CSS box at a device-pixel ratio.
 *
 * The ratio is clamped to [1, maxDpr]: below 1x the canvas would have fewer
 * device pixels than it occupies and blur; a non-finite ratio (a mocked window,
 * a detached document) reads as "unknown" and takes the 1x floor, as does a
 * `maxDpr` below 1, where the interval would otherwise be empty.
 */
export function computeBackingSize(
  cssW: number,
  cssH: number,
  dpr: number,
  maxDpr: number,
): BackingSize {
  const ceiling = Number.isFinite(maxDpr) ? Math.max(1, maxDpr) : 1;
  const ratio = Number.isFinite(dpr) ? Math.min(Math.max(1, dpr), ceiling) : 1;
  return { w: backingPx(cssW, ratio), h: backingPx(cssH, ratio), dpr: ratio };
}

function backingPx(css: number, ratio: number): number {
  // A 0×0 canvas throws on getImageData and drawImage, and a host hidden mid
  // tab-switch (display:none) reports 0 — so floor at one device pixel. Rounding
  // rather than flooring keeps the store within half a device pixel of the
  // transform's ideal, which is the difference between crisp and soft hairlines
  // at fractional ratios like 1.25 and 1.5.
  if (!Number.isFinite(css) || css <= 0) return 1;
  return Math.max(1, Math.round(css * ratio));
}

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function createLayer(className: string): Layer {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  // Inline, so the stage is geometrically correct without theme.css.
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  // A canvas is opaque to assistive technology; the readouts published through
  // `emit()` are the accessible representation, so the bitmap is hidden outright.
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`2D canvas context unavailable for .${className}`);
  return { canvas, ctx };
}

export function createStage(host: HTMLElement, opts?: StageOptions): Stage {
  const maxDpr = opts?.maxDpr ?? 2;

  const addedStageClass = !host.classList.contains('stage');
  host.classList.add('stage');
  // The canvases are absolutely positioned against the host, which therefore
  // needs to be a containing block. A detached host has no computed style ('').
  const hostPosition = getComputedStyle(host).position;
  const setPosition = hostPosition === 'static' || hostPosition === '';
  if (setPosition) host.style.position = 'relative';

  const bg = createLayer('stage__bg');
  const fg = createLayer('stage__fg');
  host.append(bg.canvas, fg.canvas);

  let width = 0;
  let height = 0;
  let dpr = 1;
  const listeners = new Set<(w: number, h: number) => void>();

  /** Re-size the backing stores to the host. Returns whether anything changed. */
  function fit(force: boolean): boolean {
    const cssW = host.clientWidth;
    const cssH = host.clientHeight;
    const size = computeBackingSize(cssW, cssH, window.devicePixelRatio, maxDpr);
    // Assigning canvas.width wipes the bitmap even when the value is unchanged,
    // so a no-op resize would silently erase the background layer.
    if (!force && cssW === width && cssH === height && size.dpr === dpr) return false;

    width = cssW;
    height = cssH;
    dpr = size.dpr;
    for (const layer of [bg, fg]) {
      // Setting the size also resets every piece of context state, including
      // the transform — which is why it is applied here and not once at creation.
      layer.canvas.width = size.w;
      layer.canvas.height = size.h;
      layer.ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    }
    return true;
  }

  let raf = 0;
  function schedule(): void {
    // A ResizeObserver can fire several times in one layout pass as the host
    // and its ancestors settle; one rAF collapses them into a single re-size
    // and a single background repaint by the subscriber.
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (fit(false)) for (const cb of listeners) cb(width, height);
    });
  }

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(schedule);
    observer.observe(host);
  } else {
    window.addEventListener('resize', schedule);
  }

  // A ResizeObserver reports CSS-box changes only. Dragging the window onto a
  // monitor with a different pixel density leaves the CSS size alone and
  // changes only devicePixelRatio; this one-shot media query catches that. It
  // is re-armed after each change because the query is literal to the ratio it
  // was made at.
  let dprQuery: MediaQueryList | null = null;
  function onDprChange(): void {
    watchDpr();
    schedule();
  }
  function watchDpr(): void {
    if (typeof window.matchMedia !== 'function') return;
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  }
  watchDpr();

  fit(true);

  return {
    layers: { background: bg.ctx, foreground: fg.ctx },

    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get dpr() {
      return dpr;
    },

    onResize(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    clearAll() {
      for (const layer of [bg, fg]) {
        // Clear in device pixels under the identity transform so no rounding
        // sliver survives along the right and bottom edges at fractional ratios.
        layer.ctx.save();
        layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.restore();
      }
    },

    destroy() {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      dprQuery?.removeEventListener('change', onDprChange);
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      listeners.clear();
      bg.canvas.remove();
      fg.canvas.remove();
      if (setPosition) host.style.position = '';
      if (addedStageClass) host.classList.remove('stage');
    },
  };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The CSS custom properties a theme must define, keyed by `CanvasTheme` field.
 *
 * theme.css is the source of truth for the values; this table is the source of
 * truth for the names. `satisfies` keeps it in lock-step with the contract: a
 * field added to `CanvasTheme` without a token here is a compile error.
 */
export const CANVAS_THEME_VARS = {
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
} as const satisfies Record<keyof CanvasTheme, `--${string}`>;

/**
 * Neutral fallback: white ground, near-black ink, and a colour-blind-safe data
 * triple from the Okabe–Ito palette. Used by the tests and by any host with no
 * theme applied. This is the one place outside theme.css where a colour literal
 * may live; everything under src/viz/ reads colours from `VizContext.theme`.
 *
 * `gridSoft` and `data3Fill` are the two greys the design system fixes by role
 * rather than by palette, so they are the shipped values: a container line that
 * still clears 3:1 on white, and a wash light enough that a particle drawn on
 * top of it clears 3:1 in turn. The wash itself is deliberately *below* 3:1
 * against the plate — that is what the silhouette in `data3` is for.
 */
export const DEFAULT_CANVAS_THEME: Readonly<CanvasTheme> = Object.freeze({
  canvas: '#ffffff',
  ink: '#1a1a1a',
  inkMuted: '#6b6b6b',
  grid: '#bdbdbd',
  gridSoft: '#8a938f',
  data1: '#0072b2',
  data2: '#d55e00',
  data3: '#009e73',
  data3Fill: '#d2d6d4',
  accent: '#8e44ad',
  labelFont: '12px system-ui, sans-serif',
  lineWidth: 1,
  particleRadius: 2,
});

type StringField = {
  [K in keyof CanvasTheme]: CanvasTheme[K] extends string ? K : never;
}[keyof CanvasTheme];
type NumberField = Exclude<keyof CanvasTheme, StringField>;

/**
 * Read the active theme off an element's computed style, falling back per
 * field to `DEFAULT_CANVAS_THEME` wherever a token is missing or unparseable.
 * Colour values pass through verbatim — anything the canvas accepts as a CSS
 * colour is fine, including `oklch()` — so no parsing happens here.
 */
export function readCanvasTheme(el: Element): CanvasTheme {
  const style = getComputedStyle(el);
  // Custom-property values come back verbatim, leading whitespace included.
  const raw = (key: keyof CanvasTheme): string =>
    style.getPropertyValue(CANVAS_THEME_VARS[key]).trim();
  const text = (key: StringField): string => raw(key) || DEFAULT_CANVAS_THEME[key];
  const px = (key: NumberField): number => {
    // parseFloat reads '1.5px' as 1.5 and '' as NaN. The DPR transform scales
    // CSS px, so the unit is dropped, not converted.
    const n = parseFloat(raw(key));
    return Number.isFinite(n) ? n : DEFAULT_CANVAS_THEME[key];
  };

  return {
    canvas: text('canvas'),
    ink: text('ink'),
    inkMuted: text('inkMuted'),
    grid: text('grid'),
    gridSoft: text('gridSoft'),
    data1: text('data1'),
    data2: text('data2'),
    data3: text('data3'),
    data3Fill: text('data3Fill'),
    accent: text('accent'),
    labelFont: text('labelFont'),
    lineWidth: px('lineWidth'),
    particleRadius: px('particleRadius'),
  };
}
