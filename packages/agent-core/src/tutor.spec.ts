import { describe, expect, it } from 'vitest';
import {
  TUTOR_LIMITS,
  TUTOR_MODES,
  TUTOR_MODE_PARTS,
  type AgentContext,
  type MaterialExcerpt,
  type TutorTurn,
} from '@focusloop/shared-types';
import { buildTutorPrompt, normaliseForComparison, readTutorReply } from './tutor';

const EXCERPT: MaterialExcerpt = {
  materialId: 'm1',
  title: 'Rotations',
  heading: 'Left rotation',
  text: 'A left rotation moves the pivot down and to the right.',
  truncated: false,
};

function contextWith(patch: Partial<AgentContext> = {}): AgentContext {
  return {
    session: {
      sessionId: 's1',
      startedAt: '2026-01-01T00:00:00.000Z',
      elapsedMs: 1000,
      completedTasks: 1,
      totalTasks: 5,
    },
    concept: { conceptId: 'c1', title: 'Rotations', summary: null, keyPoints: [] },
    task: {
      taskId: 't1',
      title: 'Read section 3',
      instructions: 'Read it and note the invariant',
      kind: 'read',
      estimatedMinutes: 5,
      step: 2,
      totalSteps: 5,
    },
    material: EXCERPT,
    learningState: 'FOCUSED',
    recentEvents: [],
    checkpoint: null,
    ...patch,
  };
}

describe('buildTutorPrompt', () => {
  it('sends the excerpt AG1 chose, and nothing else from the material', () => {
    const { prompt } = buildTutorPrompt({
      mode: 'EXPLAIN',
      context: contextWith(),
      question: 'why?',
      turns: [],
    });

    expect(prompt).toContain('A left rotation moves the pivot down');
    expect(prompt).toContain('Left rotation');
    // The bound is AG1's, and this asserts it is inherited rather than re-decided.
    expect(EXCERPT.text.length).toBeLessThanOrEqual(1200);
  });

  it('says so when there is no section to ground an answer in', () => {
    const noMaterial = contextWith({
      material: { materialId: null, title: null, heading: null, text: '', truncated: false },
    });
    const { prompt } = buildTutorPrompt({
      mode: 'HINT',
      context: noMaterial,
      question: 'q',
      turns: [],
    });

    expect(prompt).toContain('no material is attached to this course');
    expect(prompt).toContain('do not cite a section');
  });

  it('names which of the two reasons there is no section', () => {
    // AG1 distinguishes "no material" from "no section matches this concept", and the tutor reuses
    // AG1's wording rather than inventing a second account of the same situation.
    const attached = contextWith({
      material: { materialId: 'm1', title: 'Rotations', heading: null, text: '', truncated: false },
    });
    const { prompt } = buildTutorPrompt({
      mode: 'HINT',
      context: attached,
      question: 'q',
      turns: [],
    });

    expect(prompt).toContain('no section of the material matches this concept');
  });

  it('clips a question that is longer than it reads, and says that it did', () => {
    const { prompt, report } = buildTutorPrompt({
      mode: 'EXPLAIN',
      context: contextWith(),
      question: 'x'.repeat(TUTOR_LIMITS.questionCharacters + 500),
      turns: [],
    });

    expect(prompt).not.toContain('x'.repeat(TUTOR_LIMITS.questionCharacters + 1));
    expect(report.omitted.some((entry) => entry.field === 'conversation')).toBe(true);
  });

  it('holds the aggregate input budget, not just each part of it', () => {
    /*
     * The bound the first design draft did not have. Eight turns of a 2000-character question and a
     * 600-character answer is 20,800 characters against a 1200-character excerpt, and every one of
     * those per-item numbers is individually reasonable. What matters is the sum, because the sum is
     * what the model is actually sent.
     */
    const turns: TutorTurn[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'learner' : 'tutor',
      text: 'y'.repeat(TUTOR_LIMITS.answerCharacters),
    }));

    const { report } = buildTutorPrompt({
      mode: 'EXPLAIN',
      context: contextWith(),
      question: 'z'.repeat(500),
      turns,
    });

    expect(report.sent.inputCharacters).toBeLessThanOrEqual(TUTOR_LIMITS.inputCharacters);
    expect(report.sent.turns).toBeLessThanOrEqual(TUTOR_LIMITS.turns);
  });

  it('drops the oldest turns first and reports how many', () => {
    const turns: TutorTurn[] = Array.from({ length: 12 }, (_, index) => ({
      role: 'learner',
      text: `turn-${index}-${'y'.repeat(400)}`,
    }));

    const { prompt, report } = buildTutorPrompt({
      mode: 'EXPLAIN',
      context: contextWith(),
      question: 'q',
      turns,
    });

    // The newest are the ones kept: they are nearest to what is being asked about.
    expect(prompt).toContain('turn-11-');
    expect(prompt).not.toContain('turn-0-');
    expect(report.omitted.some((entry) => entry.detail.includes('earlier turn'))).toBe(true);
  });

  it('tells each mode what it is for, and what shape the answer has', () => {
    for (const mode of TUTOR_MODES) {
      const { system } = buildTutorPrompt({
        mode,
        context: contextWith(),
        question: 'q',
        turns: [],
      });
      const { required } = TUTOR_MODE_PARTS[mode];

      for (const kind of required) expect(system).toContain(`[${kind}]`);
      expect(system).toContain('labelled sections');
    }
  });

  it('tells the model not to answer from general knowledge', () => {
    // The material is the ground. A tutor that answers from the model's training instead is the
    // failure the whole grounding section exists for.
    const { system } = buildTutorPrompt({
      mode: 'EXPLAIN',
      context: contextWith(),
      question: 'q',
      turns: [],
    });
    expect(system).toContain('rather than answering from general knowledge');
  });
});

describe('readTutorReply', () => {
  const read = (
    mode: Parameters<typeof readTutorReply>[0]['mode'],
    text: string,
    extra: { learnerText?: readonly string[]; excerpt?: MaterialExcerpt | null } = {},
  ) =>
    readTutorReply({
      mode,
      text,
      excerpt: extra.excerpt === undefined ? EXCERPT : extra.excerpt,
      learnerText: extra.learnerText ?? ['it reverses the order or something'],
    });

  it('reads labelled parts and ignores prose around them', () => {
    const result = read(
      'EXPLAIN',
      'Sure, here you go:\n\n[explanation]\nThe pivot moves down.\n\n[section]\nLeft rotation\n\nHope that helps!',
    );

    expect(result).toMatchObject({ status: 'answered' });
    if (result.status !== 'answered') return;
    expect(result.reply.parts).toEqual([{ kind: 'explanation', text: 'The pivot moves down.' }]);
    expect(result.reply.source?.heading).toBe('Left rotation');
  });

  it('does not let a sign-off glue onto the heading', () => {
    // The heading is one line. A model that signs off after its last block would otherwise have that
    // sentence appended to the section name, and a correctly cited answer would be refused for
    // citing a section nobody has.
    const result = read(
      'EXPLAIN',
      '[explanation]\nIt moves.\n[section]\nLeft rotation\nHope that helps!',
    );
    expect(result).toMatchObject({ status: 'answered' });
  });

  it('accepts a label sharing its line with the first line of its block', () => {
    const result = read('HINT', '[hint] Check the ordering invariant first.');
    expect(result).toMatchObject({ status: 'answered' });
    if (result.status !== 'answered') return;
    expect(result.reply.parts).toEqual([
      { kind: 'hint', text: 'Check the ordering invariant first.' },
    ]);
  });

  it('tolerates a fenced reply', () => {
    // A model wrapping structured output in a code fence has not failed the learner.
    const result = read('HINT', '```\n[hint]\nCheck the ordering invariant.\n```');
    expect(result).toMatchObject({ status: 'answered' });
  });

  it('rejects prose with no labelled parts at all', () => {
    expect(read('EXPLAIN', 'A left rotation does this and that.')).toEqual({
      status: 'rejected',
      reason: 'unparseable',
      recovered: [],
    });
  });

  it.each([
    // An allowed label, but the part this mode is defined by is absent.
    ['missing-part', 'EXPLAIN', '[section]\nLeft rotation'],
    // Labels the format does not have, and parts this mode does not allow: the failures a single
    // format retry can fix, which is why they are distinguished from the ones it cannot.
    ['unexpected-part', 'HINT', '[hint]\nA nudge.\n[explanation]\nAnd a lecture.'],
    ['unexpected-part', 'SOCRATIC', '[question]\nWhat follows?\n[hint]\nHere is the answer.'],
    ['unexpected-part', 'HINT', '[explanation]\nThe pivot moves down.'],
  ] as const)('rejects %s', (reason, mode, text) => {
    expect(read(mode, text)).toMatchObject({ status: 'rejected', reason });
  });

  it('will not let a hint carry an explanation', () => {
    /*
     * The reason allowed-parts exist at all. A learner who asked for a nudge and got the whole idea
     * explained has been given the answer to the step they were doing, which is the opposite of help.
     * A rule the parser enforces is the only version of "a hint is only a hint" that holds.
     */
    const result = read('HINT', '[hint]\nA nudge.\n[example]\nA worked example.');
    expect(result).toMatchObject({ status: 'rejected', reason: 'unexpected-part' });
  });

  it('rejects a part that is not a part at all', () => {
    expect(read('EXPLAIN', '[explanation]\nIt moves.\n[lecture]\nMore.')).toMatchObject({
      status: 'rejected',
      reason: 'unexpected-part',
    });
  });

  it('rejects a citation of a section it was not given', () => {
    const result = read('EXPLAIN', '[explanation]\nIt moves.\n[section]\nRight rotation');
    expect(result).toMatchObject({ status: 'rejected', reason: 'not-from-the-material' });
  });

  it('rejects a citation when there was no section to cite', () => {
    const empty: MaterialExcerpt = {
      materialId: null,
      title: null,
      heading: null,
      text: '',
      truncated: false,
    };
    expect(
      read('EXPLAIN', '[explanation]\nIt moves.\n[section]\nLeft rotation', { excerpt: empty }),
    ).toMatchObject({ status: 'rejected', reason: 'not-from-the-material' });
  });

  it('accepts a reply that cites nothing', () => {
    // Naming no source is allowed: there may be no material, and a mode with one allowed part has no
    // other way to answer.
    const result = read('EXPLAIN', '[explanation]\nIt moves.');
    expect(result).toMatchObject({ status: 'answered' });
    if (result.status !== 'answered') return;
    expect(result.reply.source).toBeNull();
  });

  describe('CHECK_MY_ANSWER', () => {
    const ok = (confirmed: string, learnerText: readonly string[] = []) =>
      read(
        'CHECK_MY_ANSWER',
        `[confirmed]\n${confirmed}\n[question]\nWhat happens to the in-order sequence?`,
        {
          learnerText:
            learnerText.length > 0 ? learnerText : ['it reverses the order or something'],
        },
      );

    it('accepts a confirmation that quotes the learner', () => {
      expect(ok('You said "it reverses the order" — that part is right.')).toMatchObject({
        status: 'answered',
      });
    });

    it('rejects a bare agreement', () => {
      /*
       * The failure the epic singles out. "You're right." normalises to `youareright`, which is not
       * something the learner wrote, so a confirmation with no referent cannot be produced.
       */
      expect(ok("You're right.")).toMatchObject({
        status: 'rejected',
        reason: 'unquoted-confirmation',
      });
    });

    it('rejects a quote the learner never wrote', () => {
      expect(ok('You said "the invariant is preserved" and that is right.')).toMatchObject({
        status: 'rejected',
        reason: 'unquoted-confirmation',
      });
    });

    it('accepts a quote of something the learner said in an earlier turn', () => {
      // Conversations run to several turns, and a learner writing "the bit I said before" is quoting
      // themselves. Matching only the current message would reject an honest learner silently.
      const result = read(
        'CHECK_MY_ANSWER',
        '[confirmed]\nYou said "it reverses the order" — right.\n[question]\nAnd then?',
        { learnerText: ['first I said it reverses the order', 'but I am unsure about the rest'] },
      );
      expect(result).toMatchObject({ status: 'answered' });
    });

    it('accepts a confirmation with nothing missing', () => {
      // `missing` is required by nothing. Requiring it would mean a learner whose understanding is
      // complete gets a gap invented for them, or filler in its place.
      const result = read(
        'CHECK_MY_ANSWER',
        '[confirmed]\n"it reverses the order" is right.\n[question]\nWhat about equal keys?',
        { learnerText: ['it reverses the order or something'] },
      );
      expect(result).toMatchObject({ status: 'answered' });
      if (result.status !== 'answered') return;
      expect(result.reply.parts.map((part) => part.kind)).toEqual(['confirmed', 'question']);
    });

    it('still requires the advancing question', () => {
      // Confirming without moving the learner forward is not the answer the epic describes.
      expect(
        read('CHECK_MY_ANSWER', '[confirmed]\n"it reverses the order" is right.'),
      ).toMatchObject({ status: 'rejected', reason: 'missing-part' });
    });

    it('sees through punctuation, case and full-width characters', () => {
      // A bilingual product: the model's copy of a Chinese learner's words can differ by ，versus ,
      // alone, and an exact comparison would reject a correct quote.
      const result = read(
        'CHECK_MY_ANSWER',
        '[confirmed]\n你说“左旋不会破坏顺序”，对的。\n[question]\n那右旋呢？',
        { learnerText: ['我觉得左旋不会破坏顺序'] },
      );
      expect(result).toMatchObject({ status: 'answered' });
    });

    it('rejects a quote too short to be a referent', () => {
      // A one-character quote matches almost any text, so it establishes nothing.
      expect(ok('You said "a" and that is right.')).toMatchObject({
        status: 'rejected',
        reason: 'unquoted-confirmation',
      });
    });
  });

  it('clips an over-long part rather than refusing the answer', () => {
    const result = read(
      'EXPLAIN',
      `[explanation]\n${'w'.repeat(TUTOR_LIMITS.partCharacters + 200)}`,
    );

    expect(result).toMatchObject({ status: 'answered' });
    if (result.status !== 'answered') return;
    expect(result.reply.parts[0]?.text.length).toBe(TUTOR_LIMITS.partCharacters);
  });
});

describe('normaliseForComparison', () => {
  it('removes what a model may reasonably re-punctuate', () => {
    expect(normaliseForComparison('It reverses  the ORDER!')).toBe('itreversestheorder');
  });

  it('folds full-width characters to half-width', () => {
    expect(normaliseForComparison('ＡＢ１２')).toBe('ab12');
  });
});
