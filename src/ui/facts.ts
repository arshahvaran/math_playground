/**
 * The fact card: at most two facts, one sentence each, each with its source.
 *
 * The fact text is the content — no "Did you know", no icon, no coloured
 * stripe. A visualization may declare more facts and longer ones; the card
 * shows the first two and the first sentence of each, because two sentences a
 * reader will actually read beat six they scroll past. The source link is the
 * one place in the figure column allowed to open a new browser tab, because a
 * citation that replaced the running simulation would be a strange kind of
 * citation.
 */

import type { Fact, Prose, ProseSegment } from '../core/types';
import { clear, h, prose, proseText } from './dom';

export interface FactsHandle {
  destroy(): void;
}

/** Facts shown per tab. */
export const MAX_FACTS = 2;

/**
 * The first sentence of a fact, markup preserved.
 *
 * A sentence ends at the first `.`, `!` or `?` that is followed by whitespace.
 * That test is what keeps "3.1415929" and "0.07 and 0.07." from cutting the
 * sentence in the middle of a number: a decimal point is followed by a digit,
 * and a full stop by a space.
 */
export function firstSentence(text: Prose): Prose {
  const segments: readonly ProseSegment[] = typeof text === 'string' ? [text] : text;
  const out: ProseSegment[] = [];
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      out.push(segment);
      continue;
    }
    const end = /[.!?](?=\s)/.exec(segment);
    if (end) {
      out.push(segment.slice(0, end.index + 1));
      return out;
    }
    out.push(segment);
  }
  return out;
}

export function createFacts(host: HTMLElement, facts: readonly Fact[]): FactsHandle {
  host.classList.add('fact');
  clear(host);

  const shown = facts.slice(0, MAX_FACTS);
  if (shown.length === 0) {
    host.hidden = true;
    return { destroy() {} };
  }
  host.hidden = false;

  const list = h('ul', { class: 'fact__list' });
  for (const fact of shown) {
    const sentence = firstSentence(fact.text);
    // The link reads "Source" on the page and names the work to a screen
    // reader listing links, where two bare "Source"s would be indistinguishable.
    const label = `Source: ${fact.source.label}`;
    const source = fact.source.url
      ? h(
          'a',
          {
            href: fact.source.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            'aria-label': label,
            title: fact.source.label,
          },
          'Source',
        )
      : h('span', { title: fact.source.label }, 'Source');
    list.append(
      h(
        'li',
        { class: 'fact__item' },
        // The variables inside a fact are italic, so the sentence is prose, not
        // a string — `p`, `π` and `n` are set apart from the words around them.
        h('p', { class: 'fact__text', 'aria-label': proseText(sentence) }, ...prose(sentence)),
        h('p', { class: 'fact__source' }, source),
      ),
    );
  }
  host.append(list);

  return {
    destroy() {
      clear(host);
    },
  };
}
