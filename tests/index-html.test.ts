import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The page itself, as a document rather than as a build input.
 *
 * Everything else in this suite tests code that runs. These two defects are
 * about the page that has to be legible when the code does NOT run, and neither
 * of them can fail anywhere a unit test normally looks: both were silent, both
 * left an entirely empty white page, and both are properties of the markup.
 */
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

/** What the browser parses when scripting is ON — `<noscript>` is inert then. */
const SCRIPTING_ON = HTML.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

const LINKS = [...SCRIPTING_ON.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);

function attr(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
}

const STYLESHEETS = LINKS.filter((tag) =>
  (attr(tag, 'rel') ?? '').split(/\s+/).includes('stylesheet'),
);

describe('the font stylesheet', () => {
  it('blocks nothing, so a network that swallows the request cannot stop the app', () => {
    // A cross-origin stylesheet above the module script stops that script from
    // executing at all. A network that DROPs the request rather than refusing
    // it — the Great Firewall, a corporate egress filter, a captive portal that
    // swallows TLS — then leaves a page that never boots: no exception, no
    // console message, no frame ever composited, and every defence inside
    // main.ts downstream of a line that already prevented it from running.
    // Measured blackholed, the app produced 0 DOM nodes at 30 s.
    const blocking = STYLESHEETS.filter(
      (tag) => /^https?:/i.test(attr(tag, 'href') ?? '') && attr(tag, 'media') !== 'print',
    );
    expect(blocking).toEqual([]);
  });

  it('applies the face the moment it arrives', () => {
    // `media="print"` is what makes the request non-blocking; without the swap
    // it would also be what stops the face from ever being used on screen.
    for (const tag of STYLESHEETS.filter((t) => attr(t, 'media') === 'print')) {
      expect(attr(tag, 'onload') ?? '').toMatch(/this\.media\s*=\s*'all'/);
    }
  });

  it('keeps a plain copy for readers with scripting disabled, where onload never fires', () => {
    const deferred = STYLESHEETS.filter((t) => attr(t, 'media') === 'print');
    if (deferred.length === 0) return;
    const noscript = /<noscript[\s\S]*?<\/noscript>/i.exec(HTML)?.[0] ?? '';
    expect(noscript).toMatch(/rel="stylesheet"/i);
  });

  it('still asks for the width axis theme.css sets its density with', () => {
    // Archivo's wdth axis is the design system's density instrument. Narrow the
    // requested range and every label silently snaps to 100 % with no error
    // anywhere — a thing no test but this one would notice.
    for (const tag of STYLESHEETS) {
      const href = attr(tag, 'href') ?? '';
      if (!href.includes('family=Archivo')) continue;
      expect(href).toMatch(/wdth/);
      expect(href).toMatch(/87\.\.125/);
    }
  });
});

describe('the boot fallback', () => {
  const appAt = HTML.indexOf('<div id="app">');
  const scriptAt = HTML.search(/<script\b[^>]*type="module"/i);
  const fallback = /<p\b[^>]*class="boot-fallback"[\s\S]*?<\/p>/i.exec(HTML)?.[0] ?? '';

  it('lives inside #app, not in <noscript>', () => {
    // `<noscript>` renders when scripting is DISABLED, which is the one failure
    // a modern visitor is least likely to have. A blocked, 404ed or unparsable
    // bundle leaves scripting very much enabled and the message unrendered, and
    // the page was then completely empty — no text, no background colour, since
    // theme.css is imported by the module that did not load.
    expect(appAt).toBeGreaterThan(-1);
    expect(fallback).not.toBe('');
    expect(HTML.indexOf(fallback)).toBeGreaterThan(appAt);
    expect(HTML.indexOf(fallback)).toBeLessThan(scriptAt);
    expect(SCRIPTING_ON).toContain('boot-fallback');
  });

  it('says something, and says it without the stylesheet', () => {
    const text = fallback.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(text.length).toBeGreaterThan(40);
    // The stylesheet may be exactly what is missing, so the colours are inline.
    const style = attr(fallback, 'style') ?? '';
    expect(style).toMatch(/\bcolor\s*:/);
    expect(style).toMatch(/\bbackground\s*:/);
    expect(style).toMatch(/\bfont\s*:/);
  });

  it('is removed by the bundle that replaces it', () => {
    // The pair is the mechanism: the sentence is what a reader sees unless the
    // shell was actually built. One class name, named in both files.
    expect(MAIN).toContain('boot-fallback');
  });
});
