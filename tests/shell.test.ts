import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byClass, fire, installDom, type Harness, type MElement } from './dom-harness';
import { createShell, type ShellHandle } from '../src/ui/shell';
import { SHORTCUTS_EVENT, shortcutsEnabled } from '../src/ui/transport';
import { registry } from '../src/viz/registry';

/**
 * The bench itself: the parts of the shell that outlive every route and are
 * therefore the parts that can go on asserting something that stopped being
 * true — the tab order against the layout, a confirmation timer against the
 * link under it, a switch against the state it controls.
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
      'caption',
      'readouts',
      'story',
      'fact',
      'transport',
      'controls',
    ]);
  });

  it('follows the single stack below it', () => {
    // CSS `order` moves the paint and not the tab sequence: with the rail last
    // in the DOM, Tab off "Copy permalink" skipped the transport and every
    // control, landed on the story tape, and came back up to Play nine stops
    // later — WCAG 2.4.3 at every width below 1024 px.
    dom.setMedia(STACKED, true);
    mount();
    expect(benchOrder()).toEqual([
      'figure__head',
      'plate',
      'caption',
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

describe('the copy confirmation', () => {
  it('does not survive the route it was given for', () => {
    const handle = mount();
    handle.setPermalink('#/galton?seed=99');
    const copy = byClass(dom, 'caption__copy')[0];
    expect(copy).toBeDefined();

    // No clipboard in this document, so the key reports that instead — the
    // timer and the transient label are the same either way.
    fire(copy as MElement, 'click');
    expect(copy?.textContent).not.toBe('Copy permalink');

    const other = registry[1];
    if (other) handle.setActiveTab(other.id);

    // The key must not still be vouching for the previous route's link.
    expect(copy?.textContent).toBe('Copy permalink');
    expect(copy?.dataset['state']).toBeUndefined();
  });
});

describe('the keyboard-shortcuts switch', () => {
  it('reports the live state when the preference cannot be stored', () => {
    // Private browsing, blocked site data: the write throws, the shortcuts are
    // still turned off, and re-reading the store would answer "on" — a switch
    // showing the opposite of the state it controls, and no way back, on the
    // one control that exists to satisfy SC 2.1.4.
    mount();
    const switchEl = byClass(dom, 'switch')[0];
    expect(switchEl?.checked).toBe(true);
    dom.breakStorage();

    if (switchEl) switchEl.checked = false;
    fire(switchEl as MElement, 'change');

    expect(shortcutsEnabled()).toBe(true); // nothing was persisted
    expect(switchEl?.checked).toBe(false); // but the switch tells the truth
  });

  it('follows an event from another mounted transport', () => {
    mount();
    const switchEl = byClass(dom, 'switch')[0];

    dom.window.dispatchEvent({
      type: SHORTCUTS_EVENT,
      detail: { enabled: false },
      target: null,
      currentTarget: null,
      bubbles: false,
      defaultPrevented: false,
      preventDefault() {},
      stopPropagation() {},
    });

    expect(switchEl?.checked).toBe(false);
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
