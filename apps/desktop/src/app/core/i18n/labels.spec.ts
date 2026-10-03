import { describe, expect, it } from 'vitest';
import {
  LEARNING_EVENT_TYPES,
  type LearningEventSource,
  type LearningEventType,
} from '@focusloop/shared-types';
import en from './messages.en';
import { zh } from './messages.zh';
import { EVENT_SOURCE_KEYS, EVENT_TYPE_KEYS } from './labels';

/**
 * Every place an event can come from.
 *
 * Written out rather than derived: the maps are `Record<LearningEventSource, MessageKey>`, so a source
 * added to the union is a type error here - but a source removed from the union while this list still
 * names it is only caught by the assertions below, which is the point.
 */
const SOURCES: readonly LearningEventSource[] = [
  'user',
  'extension',
  'simulator',
  'system',
  'agent',
];

function wordingIn(dictionary: Record<string, string>, key: string): string {
  return dictionary[key] ?? '';
}

describe('the event history vocabulary', () => {
  /*
   * The RED the issue asks for, and the one that matters: `EVENT_TYPE_KEYS` is a
   * `Record<LearningEventType, MessageKey>`, so a new event type cannot be added without a map entry -
   * but nothing in the type system says the entry points at a key that exists, or at wording that is
   * not blank. These run over the closed vocabulary itself rather than over the map, so a missing entry
   * is a failure here instead of a `HELP_REQUESTED` on a Chinese screen.
   */
  it.each(LEARNING_EVENT_TYPES)('gives %s wording in both languages', (type: LearningEventType) => {
    const key = EVENT_TYPE_KEYS[type];
    expect(key, `${type} has no key`).toBeDefined();
    expect(en).toHaveProperty(key);
    expect(zh).toHaveProperty(key);
    expect(wordingIn(en, key).trim()).not.toBe('');
    expect(wordingIn(zh, key).trim()).not.toBe('');
  });

  it.each(SOURCES)('gives the %s source wording in both languages', (source) => {
    const key = EVENT_SOURCE_KEYS[source];
    expect(key, `${source} has no key`).toBeDefined();
    expect(en).toHaveProperty(key);
    expect(zh).toHaveProperty(key);
    expect(wordingIn(en, key).trim()).not.toBe('');
    expect(wordingIn(zh, key).trim()).not.toBe('');
  });

  it('gives every event type and source wording of its own', () => {
    // Two vocabulary members sharing a key would make the history ambiguous - and it is a mistake the
    // type checker cannot see, because both keys are valid `MessageKey`s.
    const typeKeys = LEARNING_EVENT_TYPES.map((type) => EVENT_TYPE_KEYS[type]);
    expect(new Set(typeKeys).size).toBe(typeKeys.length);

    const sourceKeys = SOURCES.map((source) => EVENT_SOURCE_KEYS[source]);
    expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
  });

  it('reads as history rather than as the log', () => {
    /*
     * The wording is for the learner, so no entry is the enum member, an ALL_CAPS token, or another
     * member's name - which is what stops the map being "fixed" by pointing a key at its own name or at a
     * neighbour's. The last check is the one the sources need: they are lower-case words, so neither the
     * ALL_CAPS test nor the inequality reaches them, and `'event.source.user': 'agent'` would otherwise
     * pass while putting the wrong provenance on every row.
     *
     * The component's *fallback* is deliberately not covered here: `eventTypeLabel` returns the raw value
     * for a record naming something this build does not know, and that path lives in `DashboardPage`, which
     * has no component spec. An earlier version of this file "tested" it by building the expected string
     * itself, which could not fail; a tautology is worse than an acknowledged gap.
     */
    const memberNames: readonly string[] = [...LEARNING_EVENT_TYPES, ...SOURCES];
    for (const entry of [
      ...LEARNING_EVENT_TYPES.map((type) => [type, EVENT_TYPE_KEYS[type]] as const),
      ...SOURCES.map((source) => [source, EVENT_SOURCE_KEYS[source]] as const),
    ]) {
      const [member, key] = entry;
      for (const wording of [en[key], zh[key]]) {
        expect(wording, `${member} reads as ${JSON.stringify(wording)}`).not.toBe(member);
        expect(wording, `${member} reads as another member's name`).not.toMatch(/^[A-Z][A-Z_]*$/);
        expect(memberNames, `${member} reads as another member's name`).not.toContain(wording);
        expect(wording, `${member} has surrounding whitespace`).toBe(wording.trim());
      }
    }
  });
});
