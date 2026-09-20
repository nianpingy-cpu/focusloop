import type { AgentContextOmission, MaterialExcerpt } from './agent-context';
import type { ProviderFailure } from './provider';

/**
 * The contextual tutor's contract (AG3).
 *
 * "Ask about this step", not "ask me anything": the modes are the six things a learner needs while
 * working on the task in front of them, and the context is the one AG1 already bounded. There is no
 * free-form question box, and there is no mode that answers something other than the step.
 *
 * The reason this file is a contract rather than a prompt is the epic's central claim: an answer to a
 * learner's own understanding is *not* yes or no — it confirms what is right, supplies what is
 * missing, and asks something that moves them forward. A system prompt that asks for that is a hope,
 * so the shape of the answer is a type, and `TutorOutcome` is what the tutor does when the shape it
 * asks for is not the shape it got.
 */

export const TUTOR_MODES = [
  'EXPLAIN',
  'HINT',
  'EXAMPLE',
  'SOCRATIC',
  'CHECK_MY_ANSWER',
  'SUMMARIZE',
] as const;

export type TutorMode = (typeof TUTOR_MODES)[number];

export const TUTOR_PART_KINDS = [
  'explanation',
  'hint',
  'example',
  'question',
  'summary',
  /** What the learner got right. Carries a quotation of their own words — see `TUTOR_QUOTE_MARKS`. */
  'confirmed',
  /** The condition the learner left out, when there is one. */
  'missing',
] as const;

export type TutorPartKind = (typeof TUTOR_PART_KINDS)[number];

export interface TutorPart {
  readonly kind: TutorPartKind;
  /** Model prose. Content the learner reads, in the same category as `MaterialExcerpt.text`. */
  readonly text: string;
}

/**
 * What each mode is defined by, and the only parts it may return.
 *
 * Required *and* allowed, both. Requiring a part is what makes "not yes or no" structural; allowing
 * no others is what stops a learner who asked for a nudge being handed a lecture. The second half was
 * missing from the first draft of the design, where a `HINT` could legally carry an explanation and a
 * question as well, which made "a hint can only be a hint" unenforceable in the one place it is worth
 * enforcing.
 *
 * `missing` is required by nothing. Requiring it would mean a learner whose understanding is complete
 * still gets a gap invented for them, or filler in its place.
 */
export const TUTOR_MODE_PARTS: Record<
  TutorMode,
  { readonly required: readonly TutorPartKind[]; readonly allowed: readonly TutorPartKind[] }
> = {
  EXPLAIN: { required: ['explanation'], allowed: ['explanation'] },
  HINT: { required: ['hint'], allowed: ['hint'] },
  EXAMPLE: { required: ['example'], allowed: ['example'] },
  SOCRATIC: { required: ['question'], allowed: ['question'] },
  CHECK_MY_ANSWER: {
    required: ['confirmed', 'question'],
    allowed: ['confirmed', 'missing', 'question'],
  },
  SUMMARIZE: { required: ['summary'], allowed: ['summary'] },
};

/**
 * The characters the model is asked to wrap the learner's own words in.
 *
 * The confirmation has to name what it is confirming, so that a learner can see exactly which of
 * their words was endorsed and a confirmation with no referent cannot be produced. Straight quotes
 * are what the format asks for; the CJK and typographic forms are accepted because a model writing
 * Chinese, or writing carefully, will reach for them.
 */
export const TUTOR_QUOTE_MARKS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
];

/**
 * One turn of the conversation, as the tutor keeps it.
 *
 * The transcript lives in the main process, not in the renderer. It becomes text the model reads as
 * its own prior output, so it is the largest untrusted string in the feature, and every argument that
 * arrives over IPC is validated in the main process for exactly that reason.
 */
export interface TutorTurn {
  readonly role: 'learner' | 'tutor';
  readonly text: string;
}

/**
 * The bounds, in one place, as numbers with reasons.
 *
 * The aggregate is the one that matters and the one the first draft did not have. Per-item caps that
 * are each individually reasonable — 8 turns, 2000 characters a question, 600 an answer — sum to
 * 20,800 characters against a 1200-character material excerpt, which is a boundary that moved by more
 * than an order of magnitude while nobody was looking at the sum. `AgentContext` guarantees its
 * boundaries, not its fields, and a conversation is an input it does not know about.
 *
 * `inputCharacters` bounds **everything that leaves the process, system prompt included**, and the
 * first version of this comment said "everything" while the counter counted only the excerpt, the
 * transcript and the question — leaving the system prompt, the context block and the per-turn
 * prefixes outside it, so a prompt could send ~5,400 characters against a documented 4,000. The
 * inspector would have shown 3,800. Counting the whole thing is the only version that means anything.
 */
export const TUTOR_LIMITS = {
  /** Retained turns, both roles. Older turns are dropped first and the drop is reported. */
  turns: 8,
  /** The learner's own words, per question. */
  questionCharacters: 2000,
  /** What is kept of one tutor answer. */
  answerCharacters: 600,
  /**
   * One part of an answer. Longer parts are clipped, and the clip is reported.
   */
  partCharacters: 600,
  /**
   * The context block: the concept summary and the step's instructions.
   *
   * Applied **per field**, so the block can reach twice this before anything else is counted. Both are
   * unbounded strings in the domain — whatever the imported material produced — unlike
   * `material.text`, which arrived already bounded from AG1.
   */
  contextCharacters: 800,
  /**
   * Everything the model is sent: the system prompt, the context, the excerpt, the transcript and the
   * question. Enforced as a total, not per item, by comparing the assembled string to it.
   *
   * Charged in **UTF-16 units** while the clip helpers slice by code point, so a prompt made mostly of
   * astral characters is charged roughly twice what it holds. Harmless, and named because the two units
   * are easy to mistake for one: a reader comparing `partCharacters` against this limit would conclude
   * an answer fits when it does not.
   */
  inputCharacters: 4000,
  /**
   * The shortest quoted span that counts as naming what is being confirmed.
   *
   * Two characters is not a referent: after normalisation strips case and punctuation, the two- and
   * three-character n-grams of any English sentence are exactly the ones most likely to appear
   * somewhere in several turns of the learner's own text, so a fabricated confirmation would pass.
   *
   * **The cost of six is not the same in both languages the product speaks**, and saying so matters
   * more than the number: six normalised characters is a phrase in English and most of a sentence in
   * Chinese, where two characters are already a word. A Chinese learner quoted as
   * `你说"左旋"是对的` — quoting `左旋` — is being quoted correctly and is refused unless that is
   * their entire message. The English reasoning is what chose the number; the Chinese cost is what it
   * buys, and it is the first constant to revisit if this is ever tuned for Chinese learners first.
   *
   * A quote below the floor is still accepted when it is the learner's **whole** message: somebody who
   * answered "yes" has nothing longer to quote, and rejecting them would be rejecting an honest learner
   * for being brief.
   */
  quoteCharacters: 6,
} as const;

/** Why a reply was refused, when the provider was reached and answered. */
export type TutorRejection =
  /** No labelled part at all: prose, or a fence, or the wrong format entirely. */
  | 'unparseable'
  /** A part this mode does not allow. */
  | 'unexpected-part'
  /** A part this mode is defined by was absent. */
  | 'missing-part'
  /** A confirmation that does not quote words the learner actually wrote. */
  | 'unquoted-confirmation'
  /** A citation of a section that was not the one in front of it. */
  | 'not-from-the-material';

/** Why no model answered. */
export type TutorUnavailableReason =
  /** The configured provider cannot answer: it is the offline mock, or it failed and we degraded. */
  | 'no-model'
  /** The provider was reached and failed. */
  | 'provider-failed'
  /**
   * There was no question to ask.
   *
   * Reachable without anybody misbehaving: a message that is empty, whitespace, or nothing but the
   * format's own labels sanitises to nothing — and the sanitising is itself correct. What must not
   * happen is sending the `[question]` label with nothing under it, which is a paid call asking the
   * model to explain nothing.
   */
  | 'no-question'
  /**
   * The question and the context do not both fit inside `TUTOR_LIMITS.inputCharacters`.
   *
   * A prompt with the question left out is not a smaller prompt, it is a different one, so this is
   * refused rather than sent. With the bounds as they stand it is unreachable and is kept as a
   * backstop — `buildTutorPrompt` names the constants that would bring it back into reach.
   */
  | 'request-too-long';

export interface TutorProviderInfo {
  readonly id: string;
  readonly model: string;
  readonly degraded: boolean;
  readonly failure: ProviderFailure | null;
}

/**
 * What the learner is shown when there is no answer to show.
 *
 * One fallback for every rejection and every unavailability, rather than three screens. It carries
 * whatever the app already knows, and says so when that is nothing much — never an empty box and never
 * an invented passage.
 *
 * `excerpt` is the bounded excerpt itself, empty text and all, rather than a `source` that is null in
 * exactly the states the fallback exists for. The first draft of this type had it the other way round,
 * which meant the two states with no section carried no passage at all. `instructions` is here for the
 * same reason: with no material, the step the learner is on is the only ground there is.
 *
 * `reason` is an English sentence the domain writes, not a `MessageKey`. That is a deliberate
 * departure from the design note, which said `DomainMessageKey` — this codebase's convention for
 * learner-visible, domain-explained prose is a plain string (`CompletionResult.failure.reason`,
 * `LearningEvent.reason`), and the alternative would be ~20 new bilingual keys in a change with no
 * renderer in it. The *chrome* around the fallback (labels, buttons) is a message key as always.
 */
export interface TutorFallback {
  readonly reason: string;
  readonly excerpt: MaterialExcerpt;
  readonly conceptTitle: string | null;
  readonly taskTitle: string | null;
  readonly instructions: string | null;
}

export type TutorOutcome =
  | { readonly status: 'answered'; readonly reply: TutorReply }
  | {
      readonly status: 'rejected';
      readonly reason: TutorRejection;
      readonly provider: TutorProviderInfo;
      readonly fallback: TutorFallback;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: TutorUnavailableReason;
      readonly provider: TutorProviderInfo;
      readonly fallback: TutorFallback;
    };

export interface TutorReply {
  readonly mode: TutorMode;
  readonly parts: readonly TutorPart[];
  /**
   * The excerpt the answer was drawn from, or `null` when it named none.
   *
   * The `MaterialExcerpt` itself rather than a third type describing it. It is what the model was
   * given, it is what the learner is shown as the source (AG3.9), and it is what the fallback carries
   * — one object, three uses.
   */
  readonly source: MaterialExcerpt | null;
}

/**
 * What the model was sent, and what it was not.
 *
 * The same accounting `AgentContextReport` does, for the same reason: a conversation is an input the
 * context report does not know about, so without this the prompt would grow while the inspector stayed
 * silent — which is the one failure an inspector must not have.
 */
export interface TutorContextReport {
  readonly sent: {
    readonly turns: number;
    readonly inputCharacters: number;
    readonly excerptCharacters: number;
  };
  readonly omitted: readonly AgentContextOmission[];
}

export interface TutorAnswer {
  readonly outcome: TutorOutcome;
  readonly context: TutorContextReport;
}
