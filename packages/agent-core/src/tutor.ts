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
 * Normalises text for the one comparison that has to be forgiving.
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
 * The bracketed labels the parser reads. `section` is reply-level rather than a part: every mode has
 * to be able to name where an answer came from, and a mode whose only allowed part is `hint` has no
 * other channel through which to do it.
 */
const SECTION_LABEL = 'section';
const PART_KINDS = new Set<string>(TUTOR_PART_KINDS);
/** ``` or ~~~ fences, which a model adds around structured output out of habit. */
const FENCE = /^(?:```|~~~)/;

interface ParsedLabel {
  readonly label: string;
  readonly text: string;
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

  const flush = (): void => {
    if (current !== null)
      labels.push({ label: current.label, text: current.lines.join('\n').trim() });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (FENCE.test(line)) continue;

    // A label may share its line with the first line of the block: models do that constantly, and
    // refusing it would turn a well-formed answer into no answer over a newline.
    const match = /^\[([a-z][a-z-]*)\]\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      current = {
        label: match[1],
        lines: match[2] === undefined || match[2] === '' ? [] : [match[2]],
      };
      continue;
    }

    if (current !== null) current.lines.push(rawLine);
  }

  flush();
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

/** Shortest quoted span that can count as a referent. A one-character quote matches everywhere. */
const MIN_QUOTE_CHARACTERS = 2;

export interface ReadTutorReplyInput {
  readonly mode: TutorMode;
  readonly text: string;
  /** The excerpt the model was given, or null when there was nothing to ground an answer in. */
  readonly excerpt: MaterialExcerpt | null;
  /** Every learner turn in the conversation, oldest first. See the note on the quotation check. */
  readonly learnerText: readonly string[];
}

export type TutorReading =
  | { readonly status: 'answered'; readonly reply: TutorReply }
  | {
      readonly status: 'rejected';
      readonly reason: TutorRejection;
      /** Parts that were usable, so a caller can decide whether a format retry is worth it. */
      readonly recovered: readonly TutorPart[];
    };

/**
 * Reads a reply, and decides whether it is the answer the mode promises.
 *
 * The order matters. Whether there is anything to read comes first, because prose is not a
 * near-miss — it is the wrong thing entirely. Parts this mode does not allow come next: they are the
 * failures a single retry can fix, and they have to be caught before a required part is reported
 * missing, or a model that returned two parts gets told about the wrong one.
 */
export function readTutorReply(input: ReadTutorReplyInput): TutorReading {
  const labels = readLabels(input.text);
  const parts: TutorPart[] = [];
  let sourceHeading: string | null = null;
  let unknown = false;

  for (const label of labels) {
    if (label.label === SECTION_LABEL) {
      /*
       * One line, because a heading is one line.
       *
       * A model that signs off after its last block — "Hope that helps!" — would otherwise have that
       * sentence glue onto the heading, and an answer that cited the right section would be refused
       * for citing a section nobody has.
       */
      const heading = label.text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
      sourceHeading = heading.trim();
      continue;
    }
    if (!PART_KINDS.has(label.label)) {
      unknown = true;
      continue;
    }
    parts.push({ kind: label.label as TutorPartKind, text: label.text });
  }

  const { required, allowed } = TUTOR_MODE_PARTS[input.mode];
  const allowedSet = new Set<string>(allowed);

  // Nothing labelled at all is prose, not a malformed answer — there is nothing to repair.
  if (labels.length === 0) return { status: 'rejected', reason: 'unparseable', recovered: [] };

  if (unknown || parts.some((part) => !allowedSet.has(part.kind))) {
    return { status: 'rejected', reason: 'unexpected-part', recovered: parts };
  }

  const present = new Set(parts.map((part) => part.kind));
  if (required.some((kind) => !present.has(kind))) {
    return { status: 'rejected', reason: 'missing-part', recovered: parts };
  }

  if (input.mode === 'CHECK_MY_ANSWER') {
    const confirmed = parts.find((part) => part.kind === 'confirmed');
    if (confirmed === undefined || !quotesTheLearner(confirmed.text, input.learnerText)) {
      return { status: 'rejected', reason: 'unquoted-confirmation', recovered: parts };
    }
  }

  const source = resolveSource(sourceHeading, input.excerpt);
  if (source === undefined) {
    return { status: 'rejected', reason: 'not-from-the-material', recovered: parts };
  }

  return { status: 'answered', reply: { mode: input.mode, parts: clipParts(parts), source } };
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
 *   comparison can, and this is a named limitation rather than a solved problem.
 *
 * What it buys is that the learner can see which of their own words was endorsed. A confirmation that
 * has to point at something is harder to produce by reflex than one that does not, and the learner can
 * audit it.
 *
 * The check runs against **every learner turn**, not the current message: conversations run to several
 * turns, and a learner writing "the bit I said before about the invariant" is quoting themselves. A
 * false rejection of an honest learner is worse than a missed fabrication, because the learner cannot
 * see that anything went wrong.
 */
function quotesTheLearner(confirmed: string, learnerText: readonly string[]): boolean {
  const spans = quotedSpans(confirmed)
    .map(normaliseForComparison)
    .filter((span) => span.length >= MIN_QUOTE_CHARACTERS);
  if (spans.length === 0) return false;

  const said = learnerText.map(normaliseForComparison).join('');
  return spans.every((span) => said.includes(span));
}

/**
 * Resolves the section the model named against the one it was given.
 *
 * `undefined` means "rejected", `null` means "it named none". The comparison is exact after NFKC,
 * trimming and case folding — not fuzzy, and the reason is that the fuzzy version fails in the wrong
 * direction: a model writing "from the Red-Black Trees section" against a heading of `Red-Black Trees`
 * is *grounded and confident*, and an exact-match rule would throw that answer away.
 *
 * So this catches a citation of a section that does not exist, and what actually keeps an answer
 * grounded is the excerpt being in front of it. Describing it as a hallucination check would be
 * overclaiming.
 */
function resolveSource(
  heading: string | null,
  excerpt: MaterialExcerpt | null,
): MaterialExcerpt | null | undefined {
  if (heading === null || heading.trim().length === 0) return null;
  if (excerpt === null || excerpt.heading === null) return undefined;

  const named = heading.normalize('NFKC').trim().toLowerCase();
  const given = excerpt.heading.normalize('NFKC').trim().toLowerCase();
  return named === given ? excerpt : undefined;
}

/** Clips over-long parts. Reported by the caller rather than refused: a long part is still an answer. */
function clipParts(parts: readonly TutorPart[]): readonly TutorPart[] {
  return parts.map((part) =>
    part.text.length <= TUTOR_LIMITS.partCharacters
      ? part
      : { kind: part.kind, text: part.text.slice(0, TUTOR_LIMITS.partCharacters) },
  );
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
  const partLines = allowed.map((kind) => `[${kind}]`).join(' then ');

  return [
    'Answer with labelled sections and nothing else on the label line.',
    `Use exactly these, in this order: ${partLines}.`,
    `Required: ${required.join(', ')}. Any other label is refused.`,
    `To name the section you used, add a line "[${SECTION_LABEL}]" followed by its heading, copied exactly.`,
    "Put the learner's own words that you are confirming inside double quotes.",
  ].join('\n');
}

/**
 * Builds what the model is sent, and the account of what it was not.
 *
 * Bounded at every level, including the aggregate — see `TUTOR_LIMITS`. The excerpt is exactly what
 * AG1 chose, so the material bound is AG1's and is not re-litigated here.
 */
export function buildTutorPrompt(input: BuildTutorPromptInput): TutorPrompt {
  const omissions: AgentContextOmission[] = [];
  const excerpt = input.context.material;
  const excerptCharacters = excerpt.text.length;

  const question = clip(
    input.question.trim(),
    TUTOR_LIMITS.questionCharacters,
    'your question was longer than the tutor reads, so its end was left out',
    omissions,
  );

  const included: TutorTurn[] = [];
  let used = excerptCharacters + question.length;

  // Newest first, so the turns dropped are the ones farthest from what is being asked about.
  for (let index = input.turns.length - 1; index >= 0; index -= 1) {
    const turn = input.turns[index];
    if (turn === undefined) continue;
    if (included.length >= TUTOR_LIMITS.turns) break;

    const text = clip(
      turn.text,
      TUTOR_LIMITS.answerCharacters,
      'one earlier turn was longer than is kept, so its end was left out',
      omissions,
    );
    if (used + text.length > TUTOR_LIMITS.inputCharacters) break;

    included.unshift({ role: turn.role, text });
    used += text.length;
  }

  const dropped = input.turns.length - included.length;
  if (dropped > 0) {
    omissions.push({
      field: 'conversation',
      detail: `${dropped} earlier ${dropped === 1 ? 'turn is' : 'turns are'} not included`,
    });
  }

  const system = [
    'You are a tutor inside a focus tool. The learner is looking at one step of one task.',
    MODE_INSTRUCTIONS[input.mode],
    formatSpec(input.mode),
    'Use only the material section given below. If it does not answer the question, say so in the ' +
      'same labelled form rather than answering from general knowledge.',
    'Be brief. The learner is working, not reading.',
  ].join('\n\n');

  const prompt = [describeContext(input.context), turnsBlock(included), `[question]\n${question}`]
    .filter((block) => block.length > 0)
    .join('\n\n');

  return {
    system,
    prompt,
    report: {
      sent: { turns: included.length, inputCharacters: used, excerptCharacters },
      omitted: omissions,
    },
  };
}

function clip(
  value: string,
  limit: number,
  omission: string,
  omissions: AgentContextOmission[],
): string {
  if (value.length <= limit) return value;
  if (omission.length > 0) {
    omissions.push({ field: 'conversation', detail: omission });
  }
  return value.slice(0, limit);
}

function turnsBlock(turns: readonly TutorTurn[]): string {
  if (turns.length === 0) return '';
  const lines = turns.map(
    (turn) => `${turn.role === 'learner' ? 'Learner' : 'You'} said:\n${turn.text}`,
  );
  return `Earlier in this conversation:\n\n${lines.join('\n\n')}`;
}

/**
 * The current moment, in the words the model can use.
 *
 * Deliberately flat text rather than the JSON of `AgentContext`: the fields are what the mode
 * instructions refer to ("this step", "the section provided"), and a model reading a labelled
 * paragraph uses them more reliably than one re-deriving them from a nested object.
 */
function describeContext(context: AgentContext): string {
  const lines: string[] = [];
  const { task, concept, material } = context;

  if (concept.title !== null) lines.push(`Concept: ${concept.title}`);
  if (concept.summary !== null && concept.summary.length > 0)
    lines.push(`Concept summary: ${concept.summary}`);
  if (task.title !== null) lines.push(`Step ${task.step} of ${task.totalSteps}: ${task.title}`);
  if (task.instructions !== null) lines.push(`What the step asks for: ${task.instructions}`);
  lines.push(`The learner's state: ${context.learningState}`);

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
