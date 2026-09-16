/**
 * "Try:" — one row of preset chips.
 *
 * Presets are ordered pedagogically, so the first few are the ones that walk a
 * newcomer to the idea; the row shows at most three of them, and the caption
 * under the row says what the active one reveals. A tape of numbered steps with
 * Prev and Next keys was more machine than a reader needs for three buttons.
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

/** Chips shown per tab. Three is a choice; five is a menu. */
export const MAX_CHIPS = 3;

export function createStory(
  host: HTMLElement,
  presets: readonly Preset[],
  onApply: (preset: Preset) => void,
): StoryHandle {
  host.classList.add('story');
  clear(host);

  const shown = presets.slice(0, MAX_CHIPS);
  if (shown.length === 0) {
    // A row with no chips is 40 px of padding promising something. Hide it.
    host.hidden = true;
    return { setActive() {}, destroy() {} };
  }
  host.hidden = false;

  let active = -1;

  const chips = shown.map((preset, index) =>
    h(
      'button',
      {
        class: 'key key--small story__chip',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => select(index),
      },
      preset.label,
    ),
  );

  const row = h(
    'div',
    { class: 'story__row', role: 'group', 'aria-label': 'Try' },
    h('span', { class: 'story__lead', 'aria-hidden': 'true' }, 'Try:'),
    ...chips,
  );
  // Always in flow, at a reserved height: showing and hiding a caption would
  // move the fact card under it every time a chip is pressed.
  const caption = h('p', { class: 'story__caption' });
  host.append(row, caption);

  function select(index: number): void {
    const preset = shown[index];
    if (!preset) return;
    active = index;
    render();
    onApply(preset);
  }

  function render(): void {
    // `aria-pressed` is the only marker of the active chip; the CSS reads it
    // directly and there is no `.story__chip--active` to desynchronise.
    chips.forEach((chip, index) => chip.setAttribute('aria-pressed', String(index === active)));
    const preset = active < 0 ? undefined : shown[active];
    setProse(caption, preset ? preset.caption : '');
  }

  render();

  return {
    setActive(id) {
      active = id === null ? -1 : shown.findIndex((preset) => preset.id === id);
      render();
    },
    destroy() {
      clear(host);
    },
  };
}
