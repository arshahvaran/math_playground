/**
 * The fact card — a data plate (DESIGN §5).
 *
 * The fact text *is* the heading: no "Did you know", no icon, no coloured
 * stripe. Every fact carries a source, and the source link is the one place in
 * the figure column allowed to open a new browser tab, because a citation that
 * replaced the running simulation would be a strange kind of citation.
 */

import type { Fact } from '../core/types';
import { clear, h, setProse } from './dom';

export interface FactsHandle {
  destroy(): void;
}

export function createFacts(host: HTMLElement, facts: readonly Fact[]): FactsHandle {
  host.classList.add('fact');
  clear(host);

  if (facts.length === 0) {
    host.hidden = true;
    return { destroy() {} };
  }
  host.hidden = false;

  let index = 0;
  const text = h('h2', { class: 'fact__text' });
  const source = h('p', { class: 'fact__source' });
  host.append(text, source);

  // One fact needs no shuffler, and a key that cannot change anything is worse
  // than no key.
  if (facts.length > 1) {
    host.append(
      h(
        'button',
        {
          class: 'key key--small fact__next',
          type: 'button',
          onclick: () => show(index + 1),
        },
        'Another fact',
      ),
    );
  }

  function show(next: number): void {
    index = ((next % facts.length) + facts.length) % facts.length;
    const fact = facts[index];
    if (!fact) return;
    // §2: the variables inside a fact are italic, so the sentence is prose, not
    // a string — `p`, `π` and `n` are set apart from the words around them.
    setProse(text, fact.text);
    clear(source);
    source.append(
      'Source: ',
      fact.source.url
        ? h('a', { href: fact.source.url, target: '_blank', rel: 'noopener noreferrer' }, fact.source.label)
        : fact.source.label,
    );
  }

  // The first fact, not a random one: a permalink should show the same card to
  // the person it was sent to.
  show(0);

  return {
    destroy() {
      clear(host);
    },
  };
}
