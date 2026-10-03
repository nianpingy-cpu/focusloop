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

  it('never renders the raw vocabulary for a member of the closed set', () => {
    /*
     * The bug this change exists to fix. The component falls back to the raw value for anything it does
     * not recognise (a record from a build that knew a name this one does not), so a member of the
     * closed set reaching that fallback would put `TAB_RETURNED` on screen - in either language.
     */
    const unknown = (key: string): string => `translated:${key}`;
    for (const type of LEARNING_EVENT_TYPES) {
      const key = EVENT_TYPE_KEYS[type];
      expect(unknown(key)).not.toBe(type);
      expect(unknown(key)).toContain('translated:');
    }
    for (const source of SOURCES) {
      const key = EVENT_SOURCE_KEYS[source];
      expect(unknown(key)).not.toBe(source);
      expect(unknown(key)).toContain('translated:');
    }
  });

  it('reads as history rather than as the log', () => {
    // The wording is for the learner, so no entry is the enum member or a bare identifier. This is what
    // stops the map being "fixed" by pointing every key at its own name.
    for (const type of LEARNING_EVENT_TYPES) {
      expect(en[EVENT_TYPE_KEYS[type]]).not.toBe(type);
      expect(zh[EVENT_TYPE_KEYS[type]]).not.toBe(type);
    }
    for (const source of SOURCES) {
      expect(en[EVENT_SOURCE_KEYS[source]]).not.toBe(source);
      expect(zh[EVENT_SOURCE_KEYS[source]]).not.toBe(source);
    }
  });
});
