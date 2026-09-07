import { describe, expect, it } from 'vitest';
import type { CanvasTheme } from '../src/core/types';
import {
  CANVAS_THEME_VARS,
  DEFAULT_CANVAS_THEME,
  computeBackingSize,
} from '../src/core/canvas';

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
  'data1',
  'data2',
  'data3',
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
    for (const c of data) expect([t.canvas, t.ink, t.inkMuted, t.grid]).not.toContain(c);
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
      data1: '--data-1',
      data2: '--data-2',
      data3: '--data-3',
      accent: '--accent',
      labelFont: '--canvas-label-font',
      lineWidth: '--canvas-line-width',
      particleRadius: '--canvas-particle-radius',
    });
  });
});
