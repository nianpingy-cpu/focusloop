import {
  TUTOR_LIMITS,
  TUTOR_MODE_PARTS,
  TUTOR_PART_KINDS,
  TUTOR_QUOTE_MARKS,
  type AgentContext,
  type AgentContextOmission,
  type MaterialExcerpt,
  type TutorContextReport,
  type TutorMode,
  type TutorPart,
  type TutorPartKind,
  type TutorRejection,
  type TutorReply,
  type TutorTurn,
} from '@focusloop/shared-types';

/**
 * The contextual tutor's rules (AG3): what it sends, and what it will accept back.
 *
 * Pure, and therefore testable without a session, a database, a provider or Electron — the same shape
 * as `agent-context.ts`, `dashboard.ts` and `insights.ts`. The one thing it deliberately cannot do is
 * decide whether an answer is *true*; it decides whether the answer is the shape the mode promises,
 * and it refuses the ones that are not rather than passing them off as help.
 */

/**
 * Normalises text for the two comparisons that have to be forgiving.
 *
 * Used for the quotation check and for resolving a named section. Deliberately aggressive, because
 * the two errors are not symmetric: a normalisation that is too lenient lets a fabricated quote
 * through only if it happens to be a substring of something the learner really wrote, while one that
 * is too strict rejects an honest learner silently — they cannot even see what went wrong.
 *
 * NFKC folds full-width to half-width, which matters because this is a bilingual product: a Chinese
 * learner's words can differ from the model's copy by `，` versus `,` alone. Case, whitespace,
 * punctuation and symbols then go, so quoted words survive being re-punctuated by the model.
 */
export function normaliseForComparison(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * The labels the parser reads. `section` is reply-level rather than a part: every mode has to be able
 * to name where an answer came from, and a mode whose only allowed part is `hint` has no other channel
 * through which to do it.
 */
const SECTION_LABEL = 'section';
const PART_KINDS = new Set<string>(TUTOR_PART_KINDS);
/** ``` or ~~~ fences, which a model adds around structured output out of habit. */
const FENCE = /^(?:```|~~~)/;

/**
 * A label is a line whose entire content is `[name]`.
 *
 * The whole line, not "a line that starts with a bracketed word". The parser briefly accepted a label
 * sharing its line with the first line of its block, to be tolerant of how models write; that was
 * worse than it looked, because a *body* line beginning with a bracketed word then became a phantom
 * part and refused a well-formed reply. The format is specified in the prompt and deviations are
 * repaired by the retry, which is a more honest way to be tolerant than guessing.
 */
const LABEL_LINE = /^\[([a-z][a-z-]*)\]$/;

interface ParsedLabel {
  readonly label: string;
  readonly text: string;
  /** Lines dropped from this block, so a lossy parse is visible rather than silent. */
  readonly dropped: number;
}

/**
 * Splits the model's text on lines that are a label and nothing else.
 *
 * Tolerant on purpose: prose before the first label is ignored rather than fatal, and a fence line is
 * dropped rather than becoming part of the text. This is the same reasoning as the IPC boundary
 * returning a value instead of throwing — a model that wraps its answer in a sentence has not failed
 * the learner, and a parser that throws on it would take the whole feature down.
 */
function readLabels(text: string): readonly ParsedLabel[] {
  const labels: ParsedLabel[] = [];
  let current: { label: string; lines: string[] } | null = null;

  const flush = (heading: boolean): void => {
    if (current === null) return;
    const block = current.lines.join('\n').trim();
    /*
     * A heading is one line.
     *
     * A model that signs off after its last block — "Hope that helps!" — would otherwise have that
     * sentence glue onto the heading, so a correctly cited answer would be refused for citing a
     * section nobody has. The cost is the other direction: a heading the model wrapped across two
     * lines is read as its first line. That is the better failure of the two, and what keeps it honest
     * is `dropped` — the discarded lines are counted and reported rather than thrown away silently.
     */
    const kept = heading ? (block.split('\n')[0] ?? '') : block;
    const dropped = heading ? Math.max(0, block.split('\n').length - 1) : 0;
    labels.push({ label: current.label, text: kept.trim(), dropped });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (FENCE.test(line)) continue;

    const match = LABEL_LINE.exec(line);
    if (match?.[1] !== undefined) {
      flush(current?.label === SECTION_LABEL);
      current = { label: match[1], lines: [] };
      continue;
    }

    if (current !== null) current.lines.push(rawLine);
  }

  flush(current?.label === SECTION_LABEL);
  return labels;
}

/** The quoted spans inside a part, without their quote marks. */
function quotedSpans(text: string): readonly string[] {
  const spans: string[] = [];
  for (const [open, close] of TUTOR_QUOTE_MARKS) {
    let index = 0;
    for (;;) {
      const start = text.indexOf(open, index);
      if (start === -1) break;
      const end = text.indexOf(close, start + open.length);
      if (end === -1) break;
      spans.push(text.slice(start + open.length, end));
      index = end + close.length;
    }
  }
  return spans;
}

export interface ReadTutorReplyInput {
  readonly mode: TutorMode;
  readonly text: string;
  /** The excerpt the model was given, or null when there was nothing to ground an answer in. */
  readonly excerpt: MaterialExcerpt | null;
  /** Every learner turn in the conversation, oldest first. See the note on the quotation check. */
  readonly learnerText: readonly string[];
}

export type TutorReading =
  | {
      readonly status: 'answered';
      readonly reply: TutorReply;
      /** Ways the answer is not what the model returned: a clipped part, a dropped heading line. */
      readonly omissions: readonly AgentContextOmission[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: TutorRejection;
      /** Parts that were usable, so a caller can decide whether a format retry is worth it. */
      readonly recovered: readonly TutorPart[];
      readonly omissions: readonly AgentContextOmission[];
    };

/**
 * Whether a rejection is worth asking the model again about, once.
 *
 * **Format failures are repairable; content failures are not**, and that split is the whole point.
 * Telling a model its quote was not in the learner's message invites it to produce a quote that is,
 * whether or not it belongs to the claim — retrying a grounding failure is teaching the model to
 * satisfy the checker. A model that answered well and formatted badly has no such hazard.
 *
 * `unparseable` is in the repairable set, which is wider than the design note's wording (it named
 * `missing-part` and `unexpected-part`). Prose instead of labels is a format failure and not a
 * content one, so the same argument applies — but it is worth knowing that it *does* apply, because
 * the doc comment above `readTutorReply` calls prose "not a near-miss". Both are true: prose is not a
 * near-miss of an *answer*, and it is exactly what a format retry is for.
 */
export type RetryableRejection = Exclude<
  TutorRejection,
  'unquoted-confirmation' | 'not-from-the-material'
>;

export function isRetryable(reason: TutorRejection): reason is RetryableRejection {
  return reason === 'unparseable' || reason === 'missing-part' || reason === 'unexpected-part';
}

/**
 * Reads a reply, and decides whether it is the answer the mode promises.
 *
 * The order matters. Whether there is anything to read comes first, because prose is not a near-miss —
 * it is the wrong thing entirely. Parts this mode does not allow come next: they are the failures a
 * single retry can fix, and they have to be caught before a required part is reported missing, or a
 * model that returned two parts gets told about the wrong one.
 */
export function readTutorReply(input: ReadTutorReplyInput): TutorReading {
  const labels = readLabels(input.text);
  const omissions: AgentContextOmission[] = [];
  const parts: TutorPart[] = [];
  let sourceHeading: string | null = null;
  let unknown = false;

  for (const label of labels) {
    if (label.dropped > 0) {
      omissions.push({
        field: 'material',
        detail: `${label.dropped} line(s) after the heading were left out`,
      });
    }

    if (label.label === SECTION_LABEL) {
      sourceHeading = label.text;
      continue;
    }
    if (!PART_KINDS.has(label.label)) {
      unknown = true;
      continue;
    }
    /*
     * A label with no text is not a part. Without this a reply of bare labels satisfies every
     * required-part check and the learner gets an empty box — the one outcome the design says must
     * never happen.
     */
    if (label.text.length === 0) {
      omissions.push({ field: 'conversation', detail: `the ${label.label} was empty` });
      continue;
    }
    parts.push({ kind: label.label as TutorPartKind, text: label.text });
  }

  const { required, allowed } = TUTOR_MODE_PARTS[input.mode];
  const allowedSet = new Set<string>(allowed);

  // Nothing labelled at all is prose, not a malformed answer — and prose is what the format retry is
  // for, so it is a repairable failure rather than a final one.
  if (labels.length === 0) {
    return { status: 'rejected', reason: 'unparseable', recovered: [], omissions };
  }

  if (unknown || parts.some((part) => !allowedSet.has(part.kind))) {
    return { status: 'rejected', reason: 'unexpected-part', recovered: parts, omissions };
  }

  const present = new Set(parts.map((part) => part.kind));
  if (required.some((kind) => !present.has(kind))) {
    return { status: 'rejected', reason: 'missing-part', recovered: parts, omissions };
  }

  if (input.mode === 'CHECK_MY_ANSWER') {
    const confirmed = parts.find((part) => part.kind === 'confirmed');
    if (confirmed === undefined || !quotesTheLearner(confirmed.text, input.learnerText)) {
      return { status: 'rejected', reason: 'unquoted-confirmation', recovered: parts, omissions };
    }
  }

  const source = resolveSource(sourceHeading, input.excerpt);
  if (source === undefined) {
    return { status: 'rejected', reason: 'not-from-the-material', recovered: parts, omissions };
  }

  return {
    status: 'answered',
    reply: { mode: input.mode, parts: clipParts(parts, omissions), source },
    omissions,
  };
}

/**
 * Whether the confirmation quotes words the learner actually wrote.
 *
 * This is the whole of what the schema can say about honesty, and it is worth being exact about what
 * it does and does not catch:
 *
 * - it catches a confirmation with no referent (`"You're right."` normalises to `youareright`, which
 *   is not something the learner wrote), and it catches a quote that was invented;
 * - it does **not** catch a correctly quoted sentence being called correct when it is not. No string
 *   comparison can, and this is a named limitation rather than a solved problem;
 * - it also rejects a model that **paraphrases** the learner rather than quoting them. That follows
 *   directly from requiring a literal quotation and is the predictable failure of this check rather
 *   than an edge case: a learner who wrote "I think the order doesn't change" and is told "you said
 *   the ordering is preserved" gets the fallback instead of an answer.
 *
 * What it buys is that the learner can see exactly which of their own words was endorsed, and a
 * confirmation that has to point at something is harder to produce by reflex than one that does not.
 *
 * The check runs against **every learner turn**, not the current message: conversations run to several
 * turns, and a learner writing "the bit I said before about the invariant" is quoting themselves. A
 * false rejection of an honest learner is worse than a missed fabrication, because the learner cannot
 * see that anything went wrong.
 */
function quotesTheLearner(confirmed: string, learnerText: readonly string[]): boolean {
  const said = learnerText.map(normaliseForComparison);
  // Joined with a NUL, which no normalisation removes: the point is that a quote cannot span two turns
  // and match something the learner never wrote as one unit. (An earlier comment claimed the separator
  // was removed by the normalisation — it is not, and it is not meant to be.)
  const joined = said.join('\u0000');

  const spans = quotedSpans(confirmed).map(normaliseForComparison);
  if (spans.length === 0) return false;

  return spans.every((span) => {
    if (span.length >= TUTOR_LIMITS.quoteCharacters) return joined.includes(span);
    /*
     * A quote below the floor is still a referent when it is the learner's *whole* message: somebody
     * who answered "yes" has nothing longer to quote, and rejecting them would be rejecting an honest
     * learner for being brief.
     */
    return said.some((turn) => turn.length > 0 && turn === span);
  });
}

/**
 * Resolves the section the model named against the one it was given.
 *
 * `undefined` means "rejected", `null` means "it named none". The comparison goes through the same
 * normalisation the quote check uses and is not a fuzzy match, because the fuzzy version fails in the
 * wrong direction: a model writing "from the Red-Black Trees section" against a heading of `Red-Black
 * Trees` is *grounded and confident*, and a fuzzy rule would throw that answer away.
 *
 * So this catches a citation of a section that does not exist, and what actually keeps an answer
 * grounded is the excerpt being in front of it. Describing it as a hallucination check would be
 * overclaiming.
 */
function resolveSource(
  heading: string | null,
  excerpt: MaterialExcerpt | null,
): MaterialExcerpt | null | undefined {
  if (heading === null || heading.length === 0) return null;
  if (excerpt === null || excerpt.heading === null) return undefined;

  return normaliseForComparison(heading) === normaliseForComparison(excerpt.heading)
    ? excerpt
    : undefined;
}

/**
 * Clips over-long parts. Reported rather than refused: a long part is still an answer, and a clip the
 * caller cannot see is prose that stops mid-sentence for no stated reason.
 *
 * Sliced by code point, not by UTF-16 unit, so a clip cannot end between the halves of a surrogate
 * pair and render as a replacement character.
 */
function clipParts(
  parts: readonly TutorPart[],
  omissions: AgentContextOmission[],
): readonly TutorPart[] {
  return parts.map((part) => {
    const points = [...part.text];
    if (points.length <= TUTOR_LIMITS.partCharacters) return part;
    omissions.push({
      field: 'conversation',
      detail: `the ${part.kind} was longer than is shown, so its end was left out`,
    });
    return { kind: part.kind, text: points.slice(0, TUTOR_LIMITS.partCharacters).join('') };
  });
}

// ------------------------------------------------------------------- the prompt

export interface BuildTutorPromptInput {
  readonly mode: TutorMode;
  readonly context: AgentContext;
  readonly question: string;
  readonly turns: readonly TutorTurn[];
}

export interface TutorPrompt {
  readonly system: string;
  readonly prompt: string;
  readonly report: TutorContextReport;
}

const MODE_INSTRUCTIONS: Record<TutorMode, string> = {
  EXPLAIN: 'Explain the idea this step depends on, in terms of the material section provided.',
  HINT:
    'Give one nudge that moves the learner forward without telling them the answer. A hint is not an ' +
    'explanation: do not explain the idea, do not work an example.',
  EXAMPLE: 'Work one small concrete example from the material section, all the way through.',
  SOCRATIC:
    'Ask one question that makes the learner do the next piece of thinking themselves. Do not answer ' +
    'it for them.',
  CHECK_MY_ANSWER:
    'The learner has offered their own understanding. Quote the words of theirs that are right inside ' +
    'double quotes, say what is missing if anything genuinely is, and ask one question that moves ' +
    'them forward. Never answer just "yes" or "no", and never invent a gap that is not there.',
  SUMMARIZE:
    'Summarise what this material section says, in the terms of the task the learner is doing now. ' +
    'This is not a summary of the session or of their progress.',
};

/**
 * The format the model is asked for, described in the same words the parser implements.
 *
 * Labelled parts rather than JSON. `CompletionRequest` is `{ system?, prompt }` and `CompletionResult`
 * is `{ text }` — plain text in, plain text out — and structured output is AG9's job. Depending on it
 * here would make AG3 a dependency of a later epic, and labelled parts are readable, tolerant of
 * surrounding prose, and enough for both the per-mode contract and naming the source.
 */
function formatSpec(mode: TutorMode): string {
  const { required, allowed } = TUTOR_MODE_PARTS[mode];
  const optional = allowed.filter((kind) => !required.includes(kind));

  const lines = [
    'Answer with labelled blocks. A label is a line containing only the label, in square brackets,',
    "with that block's text on the lines after it.",
    `Use only these labels: ${allowed.map((kind) => `[${kind}]`).join(', ')}. Any other label is refused.`,
    `You must include: ${required.map((kind) => `[${kind}]`).join(', ')}.`,
  ];

  /*
   * `missing` is allowed, not required, and the prompt has to say so.
   *
   * The first version printed the allowed set as "use exactly these, in this order", which for
   * CHECK_MY_ANSWER told the model to emit `[missing]` every time — reintroducing, in the
   * instructions, exactly the fabrication that requiring it in the schema was rejected for. The schema
   * permitting a part is not the same as asking for it, and the prompt is where that distinction has
   * to survive.
   */
  for (const kind of optional) {
    if (kind === 'missing') {
      lines.push(
        'Include [missing] only if the learner genuinely left something out. If their understanding ' +
          'is complete, leave it out entirely rather than inventing a gap.',
      );
    } else {
      lines.push(`Include [${kind}] only if it is useful here.`);
    }
  }

  lines.push(
    `To name the section you used, add a line "[${SECTION_LABEL}]" with its heading copied exactly.`,
    "Put the learner's own words that you are confirming inside double quotes.",
  );

  return lines.join('\n');
}

/**
 * Builds what the model is sent, and the account of what it was not.
 *
 * Bounded at every level, **including the aggregate**: `inputCharacters` is the total of the system
 * prompt, the context, the excerpt, the transcript and the question. The first version counted only
 * the last three and described itself as "everything", which is how a documented 4,000-character
 * ceiling would have sent roughly 5,400 while the inspector showed 3,800 — the exact failure AG1's
 * report exists to prevent, one layer up.
 *
 * The fixed parts are built first and charged against the budget before any turn is considered, so
 * what remains for the transcript is a remainder rather than a number chosen in isolation. The excerpt
 * is exactly what AG1 chose, so the material bound is AG1's and is not re-litigated here.
 */
export function buildTutorPrompt(input: BuildTutorPromptInput): TutorPrompt {
  const omissions: AgentContextOmission[] = [];
  const excerpt = input.context.material;
  const limit = TUTOR_LIMITS.inputCharacters;

  const system = buildSystem(input.mode);
  const question = sanitiseQuestion(
    clip(input.question.trim(), TUTOR_LIMITS.questionCharacters, omissions),
  );

  let contextBlock = describeContext(
    input.context,
    { detailLimit: TUTOR_LIMITS.contextCharacters, includeExcerpt: true },
    omissions,
  );
  let questionBlock = `[question]\n${question}`;

  /*
   * The fixed parts can exceed the whole budget on their own.
   *
   * Two context fields at their own cap, AG1's excerpt and a long question sum to about 4,800 before
   * the system prompt is counted at all — and that is every input sitting at a documented cap, with
   * nothing adversarial about it. Without this branch the loop simply breaks on its first iteration,
   * the call returns a prompt well over the ceiling it documents, and the one omission it reports
   * blames the transcript for a problem the transcript did not cause. **A ceiling with no branch for
   * "the fixed part alone is over" reports a number above itself rather than bounding anything**, which
   * is the state this change exists to end.
   *
   * The excerpt goes first because it is the largest and the most expendable: the step's own words
   * still ground the answer, and AG1 already has a "this section was clipped" concept.
   */
  if (system.length + contextBlock.length + questionBlock.length > limit) {
    contextBlock = describeContext(
      input.context,
      { detailLimit: 0, includeExcerpt: false },
      omissions,
    );
    omissions.push({
      field: 'material',
      detail: 'the material excerpt was left out to keep the message within its length limit',
    });
  }

  // Still over after that: the question itself has to give way, and it is never dropped entirely —
  // the learner asked it, and a prompt without the question is not a smaller prompt, it is a
  // different one.
  const head = '[question]\n'.length;
  const room = limit - system.length - contextBlock.length - head;
  if (
    contextBlock.length > 0 &&
    room >= 0 &&
    questionBlock.length > limit - system.length - contextBlock.length
  ) {
    questionBlock = `[question]\n${clip(question, room, omissions)}`;
  }

  /*
   * The loop tests the **assembled** prompt, not a running total of its parts.
   *
   * The first version summed the system prompt, the context, the question and each turn block and then
   * joined them with `\n\n` and a `Earlier in this conversation:` header that nothing had charged — so
   * the artefact could sit about fifty characters over the ceiling, and the loop admitted turns that a
   * check on the real thing would have refused. One string, built the way it is actually sent, is the
   * only number worth comparing to a limit on what is sent.
   */
  const included: TutorTurn[] = [];
  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turn = input.turns[index];
    if (turn === undefined) continue;
    if (included.length >= TUTOR_LIMITS.turns) break;

    // Clipped after the budget test, not before: clipping a turn and then dropping it reports a
    // truncation the learner never saw.
    const candidate = [...included, turn];
    const assembled = assemble(contextBlock, candidate, questionBlock);
    if (system.length + assembled.length > limit) break;

    included.push({
      role: turn.role,
      text: clip(turn.text, TUTOR_LIMITS.answerCharacters, omissions),
    });
  }

  const dropped = input.turns.length - included.length;
  if (dropped > 0) {
    omissions.push({
      field: 'conversation',
      detail: `${dropped} earlier ${dropped === 1 ? 'turn is' : 'turns are'} not included`,
    });
  }

  const prompt = assemble(contextBlock, included, questionBlock);

  return {
    system,
    prompt,
    report: {
      sent: {
        turns: included.length,
        // The whole thing, system prompt included.
        inputCharacters: system.length + prompt.length,
        excerptCharacters: excerpt.text.length,
      },
      omitted: omissions,
    },
  };
}

/**
 * The prompt, assembled exactly the way it is sent.
 *
 * A function rather than an inline join because the budget test and the result have to agree: the
 * earlier version computed the length one way and built the string another, and the difference was the
 * `\n\n` separators and the transcript header.
 */
function assemble(
  contextBlock: string,
  turns: readonly TutorTurn[],
  questionBlock: string,
): string {
  return [contextBlock, turnsBlock(turns), questionBlock]
    .filter((block) => block.length > 0)
    .join('\n\n');
}

function buildSystem(mode: TutorMode): string {
  return [
    'You are a tutor inside a focus tool. The learner is looking at one step of one task.',
    MODE_INSTRUCTIONS[mode],
    formatSpec(mode),
    'Use only the material section given below. If it does not answer the question, say so in the ' +
      'same labelled form rather than answering from general knowledge.',
    'Be brief. The learner is working, not reading.',
  ].join('\n\n');
}

/**
 * Removes anything from the learner's own words that would read as one of the tutor's labels.
 *
 * The question and the transcript are data being re-sent into a format that has labels, so a learner
 * who writes `[hint]` is not answering on the tutor's behalf — but the model has no way to tell.
 *
 * Narrowed to the labels the format actually has. Removing *every* bracketed word was the first
 * version, and it deleted ordinary notation: a learner asking "what does `[x]` mean here?" lost the
 * line, and a question that was only that line became empty. That is the same argument the parser
 * makes two hundred lines up, and it should not have been reversed here.
 */
function sanitiseQuestion(question: string): string {
  const labels = new Set<string>([...TUTOR_PART_KINDS, SECTION_LABEL]);
  return question
    .split(/\r?\n/)
    .filter((line) => {
      const match = LABEL_LINE.exec(line.trim());
      return match?.[1] === undefined || !labels.has(match[1]);
    })
    .join('\n')
    .trim();
}

function clip(value: string, limit: number, omissions: AgentContextOmission[]): string {
  // By code point, so a clip cannot split a surrogate pair.
  const points = [...value];
  if (points.length <= limit) return value;
  omissions.push({
    field: 'conversation',
    detail: 'something you wrote was longer than the tutor reads, so its end was left out',
  });
  return points.slice(0, limit).join('');
}

function turnBlock(role: TutorTurn['role'], text: string): string {
  return `${role === 'learner' ? 'Learner' : 'You'} said:\n${text}`;
}

function turnsBlock(turns: readonly TutorTurn[]): string {
  if (turns.length === 0) return '';
  return `Earlier in this conversation:\n\n${turns
    .map((turn) => turnBlock(turn.role, turn.text))
    .join('\n\n')}`;
}

/**
 * The current moment, in the words the model can use.
 *
 * Deliberately flat text rather than the JSON of `AgentContext`: the fields are what the mode
 * instructions refer to ("this step", "the section provided"), and a model reading a labelled
 * paragraph uses them more reliably than one re-deriving them from a nested object.
 *
 * Its own bound, because two of these fields are unbounded strings in the domain: `Concept.summary`
 * and `Task.instructions` are whatever the imported material produced. Only `material.text` arrived
 * already bounded, from AG1, and an unbounded field inside a bounded total is not bounded.
 */
function describeContext(
  context: AgentContext,
  options: { readonly detailLimit: number; readonly includeExcerpt: boolean },
  omissions: AgentContextOmission[],
): string {
  const lines: string[] = [];
  const { task, concept, material } = context;

  if (concept.title !== null) lines.push(`Concept: ${concept.title}`);
  if (concept.summary !== null && concept.summary.length > 0 && options.detailLimit > 0) {
    lines.push(`Concept summary: ${clip(concept.summary, options.detailLimit, omissions)}`);
  }
  if (task.title !== null) lines.push(`Step ${task.step} of ${task.totalSteps}: ${task.title}`);
  if (task.instructions !== null && options.detailLimit > 0) {
    lines.push(
      `What the step asks for: ${clip(task.instructions, options.detailLimit, omissions)}`,
    );
  }
  lines.push(`The learner's state: ${context.learningState}`);

  if (!options.includeExcerpt) return lines.join('\n');

  if (material.heading !== null && material.text.length > 0) {
    lines.push(
      `Material section "${material.heading}"${material.truncated ? ' (its beginning)' : ''}:\n${material.text}`,
    );
  } else {
    const reason =
      material.materialId === null
        ? 'no material is attached to this course'
        : 'no section of the material matches this concept';
    lines.push(`Material: ${reason}. Answer from the step above, and do not cite a section.`);
  }

  return lines.join('\n');
}

/**
 * What the model is told when it is asked again.
 *
 * Format failures only, so the parameter is narrowed to the retryable subset — passing
 * `unquoted-confirmation` is then a type error rather than a function that politely claims the reply
 * was missing a label.
 *
 * **This is a follow-up turn, not a fresh prompt.** It carries the problem, the format and the
 * question, and deliberately no context block or excerpt: it must be appended after the exchange it is
 * correcting, against the same system prompt, so the model can see the answer it is being asked to
 * redo. Sending it on its own would leave nothing to ground an answer in — which is a fact about how
 * step two has to call it, and is therefore written here rather than assumed there.
 */
export function buildTutorRetryPrompt(input: {
  readonly mode: TutorMode;
  readonly reason: RetryableRejection;
  readonly question: string;
}): string {
  const { required, allowed } = TUTOR_MODE_PARTS[input.mode];
  const problem =
    input.reason === 'unparseable'
      ? 'Your answer had no labelled blocks at all.'
      : input.reason === 'unexpected-part'
        ? `Your answer used a label that is not allowed here. Only ${allowed
            .map((kind) => `[${kind}]`)
            .join(', ')} may be used.`
        : `Your answer did not include the labels this mode requires: ${required
            .map((kind) => `[${kind}]`)
            .join(', ')}. Each one needs text under it — a label on its own is not an answer.`;

  return [
    problem,
    'Answer the same question again, using only the allowed labels, each on a line of its own.',
    '',
    '[question]',
    sanitiseQuestion(input.question),
  ].join('\n');
}
