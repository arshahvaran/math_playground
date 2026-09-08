/**
 * Story mode — the program tape (DESIGN §5).
 *
 * A numbered stepper over the visualization's presets. Presets are ordered
 * pedagogically, so the tape is a path through the idea rather than a menu:
 * step 1 is one ball, step 3 is ten thousand, and the caption says what changed.
 *
 * The component never applies a preset to the simulation itself. It calls
 * `onApply` and waits to be told what is current through `setActive`, because
 * the route is the single source of truth for which preset is showing — a
 * permalink can land on one that was never clicked.
 */

import type { Preset } from '../core/types';
import { clear, h, setProse } from './dom';

export interface StoryHandle {
  setActive(id: string | null): void;
  destroy(): void;
}

export function createStory(
  host: HTMLElement,
  presets: readonly Preset[],
  onApply: (preset: Preset) => void,
): StoryHandle {
  host.classList.add('story');
  clear(host);

  if (presets.length === 0) {
    // A tape with no steps is 40 px of padding promising something. Hide it.
    host.hidden = true;
    return { setActive() {}, destroy() {} };
  }
  host.hidden = false;

  let active = -1;

  const steps = presets.map((preset, index) =>
    h(
      'button',
      {
        class: 'story__step',
        type: 'button',
        'aria-label': `Step ${index + 1}: ${preset.label}`,
        onclick: () => select(index, true),
      },
      String(index + 1),
    ),
  );

  const list = h('ol', { class: 'story__steps' }, ...steps.map((step) => h('li', null, step)));
  const prev = h('button', { class: 'key key--small', type: 'button', onclick: () => move(-1) }, 'Prev');
  const next = h('button', { class: 'key key--small', type: 'button', onclick: () => move(1) }, 'Next');
  const tape = h('div', { class: 'story__tape' }, prev, list, next);
  const label = h('h3', { class: 'story__label' });
  const caption = h('p', { class: 'story__caption' });

  tape.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    move(event.key === 'ArrowLeft' ? -1 : 1);
    steps[active]?.focus();
  });

  host.append(h('h2', { class: 'visually-hidden' }, 'Story mode'), tape, label, caption);

  function move(delta: number): void {
    // With nothing active, either arrow lands on step 1 — the tape is a path and
    // its start is the only sensible entry point.
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active;
    const target = Math.min(presets.length - 1, Math.max(0, from + delta));
    if (target !== active) select(target, true);
  }

  function select(index: number, apply: boolean): void {
    const preset = presets[index];
    if (!preset) return;
    active = index;
    render();
    if (apply) onApply(preset);
  }

  function render(): void {
    steps.forEach((step, index) => {
      const current = index === active;
      // `aria-current="step"` is the only marker of the current step; the CSS
      // reads it directly and there is no `.story__step--current` to write.
      if (current) {
        step.setAttribute('aria-current', 'step');
        step.classList.add('story__step--visited');
      } else {
        step.removeAttribute('aria-current');
      }
    });
    const preset = active < 0 ? undefined : presets[active];
    label.textContent = preset ? preset.label : '';
    setProse(caption, preset ? preset.caption : '');
    label.hidden = !preset;
    caption.hidden = !preset;
    // The ends are inoperable, not removed from the tab order. `disabled` on the
    // key that just fired the move takes it out of focus under the user's own
    // keypress, `document.activeElement` falls back to <body>, and the next Tab
    // restarts from the top of the document — halfway up the page from the tape.
    // `.key[aria-disabled="true"]` carries the same look as `:disabled`, and
    // `move()` already clamps, so an activation at either end is a no-op.
    prev.setAttribute('aria-disabled', String(active === 0));
    next.setAttribute('aria-disabled', String(active === presets.length - 1));
  }

  render();

  return {
    setActive(id) {
      const index = id === null ? -1 : presets.findIndex((preset) => preset.id === id);
      active = index;
      render();
    },
    destroy() {
      clear(host);
    },
  };
}
