import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byClass, byLabel, fire, installDom, type Harness, type MElement } from './dom-harness';
import { createFacts, firstSentence } from '../src/ui/facts';
import { createShell, type ShellHandle } from '../src/ui/shell';
import { createStory } from '../src/ui/story';
import { registry } from '../src/viz/registry';

/**
 * The bench itself: the parts of the shell that outlive every route and are
 * therefore the parts that can go on asserting something that stopped being
 * true — the tab order against the layout, a confirmation timer against the
 * link under it — and the two small components in the figure column that
 * decide how much of a visualization's prose a visitor is shown.
 */

const STACKED = '(max-width: 63.9375rem)';

let dom: Harness;
let shell: ShellHandle | null = null;
let selected: string[] = [];

function mount(): ShellHandle {
  selected = [];
  shell = createShell(dom.app as unknown as HTMLElement, registry, (id) => selected.push(id));
  const first = registry[0];
  if (first) shell.setActiveTab(first.id);
  return shell;
}

beforeEach(() => {
  vi.useFakeTimers();
  dom = installDom();
});

afterEach(() => {
  shell?.destroy();
  shell = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  dom.teardown();
});

/** The bench's children in document order, by class — the tab order, in short. */
function benchOrder(): string[] {
  const bench = byClass(dom, 'bench')[0];
  if (!bench) throw new Error('no bench');
  const names: string[] = [];
  const walk = (el: MElement): void => {
    for (const child of el.children) {
      const cls = child.className.split(/\s+/)[0] ?? '';
      // `display: contents` wrappers contribute their children, not themselves.
      if (cls === 'figure' || cls === 'rail' || cls === 'rail__panel') walk(child);
      else names.push(cls);
    }
  };
  walk(bench);
  return names;
}

describe('bench order', () => {
  it('follows the two-column layout above the breakpoint', () => {
    mount();
    // The figure column, then the rail: the paint order at this width.
    expect(benchOrder()).toEqual([
      'figure__head',
      'plate',
      'share',
      'readouts',
      'story',
      'fact',
      'transport',
      'controls',
    ]);
  });

  it('follows the single stack below it', () => {
    // CSS `order` moves the paint and not the tab sequence: with the rail last
    // in the DOM, Tab off Share skipped the transport and every control, landed
    // on the chips, and came back up to Play stops later — WCAG 2.4.3 at every
    // width below 1024 px.
    dom.setMedia(STACKED, true);
    mount();
    expect(benchOrder()).toEqual([
      'figure__head',
      'plate',
      'share',
      'transport',
      'readouts',
      'controls',
      'story',
      'fact',
    ]);
  });

  it('restacks when the layout changes, keeping the focus', () => {
    mount();
    const play = byClass(dom, 'transport')[0];
    expect(play).toBeDefined();
    play?.focus();

    dom.setMedia(STACKED, true);

    expect(benchOrder()[3]).toBe('transport');
    // Re-parenting an element blurs it; the focus has to be carried across.
    expect(dom.document.activeElement).toBe(play);

    dom.setMedia(STACKED, false);
    expect(benchOrder()[6]).toBe('transport');
    expect(dom.document.activeElement).toBe(play);
  });
});

describe('the chrome', () => {
  it('is the wordmark and the scheme toggle, and nothing else in the masthead', () => {
    mount();
    const masthead = byClass(dom, 'masthead')[0];
    expect(masthead?.textContent).toBe('Math Playground');
    expect(masthead?.children.map((el) => el.className.split(/\s+/)[0])).toEqual([
      'masthead__wordmark',
      'key',
    ]);
  });

  it('navigates by the tab strip alone', () => {
    mount();
    expect(byLabel(dom, 'Previous visualization')).toBeUndefined();
    expect(byLabel(dom, 'Next visualization')).toBeUndefined();
    expect(byClass(dom, 'tabs__select')).toEqual([]);
    expect(dom.findAll((el) => el.getAttribute('role') === 'tab')).toHaveLength(registry.length);
  });

  it('puts the source, the licence and the author on one footer line', () => {
    mount();
    const footer = byClass(dom, 'footer')[0];
    expect(footer?.children.map((el) => el.textContent)).toEqual([
      'Source',
      'CC BY-NC 4.0',
      'Ali Reza Shahvaran',
    ]);
    expect(byClass(dom, 'footer__source')[0]?.getAttribute('href')).toMatch(/github\.com/);
  });

  it('carries no parameter caption and no figure number under the plate', () => {
    const handle = mount();
    handle.setPermalink('#/galton?rows=20&seed=7');
    expect(byClass(dom, 'caption')).toEqual([]);
    const share = byClass(dom, 'share')[0];
    expect(share?.textContent).toBe('Share');
    expect(share?.getAttribute('data-permalink')).toContain('#/galton?rows=20&seed=7');
  });
});

describe('selecting a visualization', () => {
  it('refuses the visualization already on screen', () => {
    mount();
    const tabs = dom.findAll((el) => el.getAttribute('role') === 'tab');
    const [first, second] = tabs;
    expect(first).toBeDefined();
    expect(first?.getAttribute('aria-selected')).toBe('true');

    fire(first as MElement, 'click');
    expect(selected).toEqual([]);

    fire(second as MElement, 'click');
    expect(selected).toEqual([registry[1]?.id]);
  });
});

describe('the share confirmation', () => {
  it('does not survive the route it was given for', () => {
    const handle = mount();
    handle.setPermalink('#/galton?seed=99');
    const share = byClass(dom, 'share__key')[0];
    expect(share?.textContent).toBe('Share');

    // No clipboard in this document, so the key reports that instead — the
    // timer and the transient label are the same either way.
    fire(share as MElement, 'click');
    expect(share?.textContent).not.toBe('Share');

    const other = registry[1];
    if (other) handle.setActiveTab(other.id);

    // The key must not still be vouching for the previous route's link.
    expect(share?.textContent).toBe('Share');
    expect(share?.dataset['state']).toBeUndefined();
  });
});

describe('the plate aspect', () => {
  it('publishes both shapes the visualization declares', () => {
    const handle = mount();
    const buffon = registry.find((viz) => viz.id === 'buffon');
    if (buffon) handle.setActiveTab(buffon.id);
    const plate = byClass(dom, 'plate')[0];

    // theme.css reads the narrow one below 600 px, where a 1.6 bed is a
    // 224 px letterbox on a phone.
    expect(plate?.style.getPropertyValue('--viz-aspect')).toBe(String(buffon?.aspect));
    expect(plate?.style.getPropertyValue('--viz-aspect-narrow')).toBe(String(buffon?.aspectNarrow));
  });
});

describe('the "Try:" row', () => {
  it('shows at most three chips, and captions only the active one', () => {
    const galton = registry.find((viz) => viz.id === 'galton');
    const presets = galton?.presets ?? [];
    expect(presets.length).toBeGreaterThan(3);
    const host = dom.document.createElement('section');
    dom.app.appendChild(host);
    const applied: string[] = [];
    const story = createStory(host as unknown as HTMLElement, presets, (p) => applied.push(p.id));

    const chips = byClass(dom, 'story__chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(presets.slice(0, 3).map((p) => p.label));
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(byClass(dom, 'story__caption')[0]?.textContent).toBe('');

    fire(chips[1] as MElement, 'click');
    expect(applied).toEqual([presets[1]?.id]);
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(byClass(dom, 'story__caption')[0]?.textContent.length).toBeGreaterThan(0);

    // The route is the source of truth: a preset past the third lights nothing.
    story.setActive(presets[3]?.id ?? null);
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
    story.destroy();
  });
});

describe('the fact card', () => {
  it('shows two facts, one sentence each, each with a source link', () => {
    const buffon = registry.find((viz) => viz.id === 'buffon');
    const facts = buffon?.facts ?? [];
    expect(facts.length).toBeGreaterThanOrEqual(2);
    const host = dom.document.createElement('section');
    dom.app.appendChild(host);
    createFacts(host as unknown as HTMLElement, facts);

    const items = byClass(dom, 'fact__item');
    expect(items).toHaveLength(2);
    const texts = byClass(dom, 'fact__text').map((el) => el.textContent);
    // One sentence each, ending where the visualization's sentence ends.
    expect(texts[0]).toMatch(/floorboard joint\.$/);
    expect(texts[0]).not.toMatch(/geometric probability/);
    const links = byClass(dom, 'fact__source').map((el) => el.children[0]);
    expect(links.map((a) => a?.textContent)).toEqual(['Source', 'Source']);
    expect(links.map((a) => a?.getAttribute('href'))).toEqual(facts.slice(0, 2).map((f) => f.source.url));
  });

  it('cuts at a full stop, never at a decimal point', () => {
    expect(firstSentence('Reported 3,408 throws giving 3.1415929 — six decimals. Then more.')).toEqual([
      'Reported 3,408 throws giving 3.1415929 — six decimals.',
    ]);
    // Markup survives, and the cut can land in a later segment.
    expect(firstSentence(['Chosen 0.01, 0.85 and 0.07. The ', { v: 'x' }, ' map draws the stem.'])).toEqual([
      'Chosen 0.01, 0.85 and 0.07.',
    ]);
    expect(firstSentence(['The ratio ', { v: 'r' }, ' = ½ is the classic jump. Above it they overlap.'])).toEqual([
      'The ratio ',
      { v: 'r' },
      ' = ½ is the classic jump.',
    ]);
    expect(firstSentence('One sentence with no full stop')).toEqual(['One sentence with no full stop']);
  });
});
