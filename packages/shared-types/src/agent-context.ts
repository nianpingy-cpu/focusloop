import type { LearningCheckpoint } from './checkpoint';
import type { MicroTaskKind } from './course';
import type { LearningEvent } from './events';
import type { LearningState } from './state';

/**
 * What the agent is allowed to know about the current moment.
 *
 * The point of this type is its **boundaries**, not its fields. Handing a model the course list, the
 * session log and the database is easy to write and impossible to keep honest: the prompt grows with
 * the learner's history, the cost stops being predictable, and there is no longer any one place that
 * says what the model may see. This file is that place.
 *
 * A note on naming: the design notes call the checkpoint a `CognitiveCheckpoint`. The continuity
 * package already stores exactly that object as `LearningCheckpoint`, so this reuses it. Two names
 * for one thing is how a domain drifts.
 */

/** A bounded piece of the imported material — never the document. */
export interface MaterialExcerpt {
  readonly materialId: string | null;
  readonly title: string | null;
  readonly heading: string | null;
  readonly text: string;
  /** True when the section was longer than the excerpt, so `text` is its beginning. */
  readonly truncated: boolean;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly completedTasks: number;
  readonly totalTasks: number;
}

export interface ConceptContext {
  readonly conceptId: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly keyPoints: readonly string[];
}

export interface TaskContext {
  readonly taskId: string | null;
  readonly title: string | null;
  readonly instructions: string | null;
  readonly kind: MicroTaskKind | null;
  readonly estimatedMinutes: number | null;
  /** One-based position inside the course, which is what "step 3 of 7" counts. */
  readonly step: number;
  readonly totalSteps: number;
}

export interface AgentContext {
  readonly session: SessionContext;
  readonly concept: ConceptContext;
  readonly task: TaskContext;
  readonly material: MaterialExcerpt;
  readonly learningState: LearningState;
  /** The most recent events, oldest first. A window, never the whole log. */
  readonly recentEvents: readonly LearningEvent[];
  readonly checkpoint: LearningCheckpoint | null;
}

/**
 * Something the context deliberately does not carry.
 *
 * Recorded rather than dropped, because "the model was not shown the rest of the material" is a
 * claim worth being able to check. A context that silently excludes things is indistinguishable
 * from one that forgot them, and the difference matters the first time an answer is wrong.
 */
export interface AgentContextOmission {
  readonly field: 'events' | 'material' | 'courses' | 'session';
  readonly detail: string;
}

/** The context, and the account of how it was arrived at. */
export interface AgentContextReport {
  readonly context: AgentContext | null;
  readonly omissions: readonly AgentContextOmission[];
}

/**
 * The bounds, in one place, as numbers with reasons.
 *
 * Material is bounded by characters because the failure it prevents is a prompt that grows with the
 * length of whatever the learner happened to import. Events are bounded by count because the failure
 * it prevents is a prompt that grows with how long the session has been running. Both are small
 * enough to be worth reading in full, which is the actual requirement — an agent that needs more
 * than this to decide whether to help is an agent that has stopped being about the current moment.
 */
export const AGENT_CONTEXT_LIMITS = {
  materialCharacters: 1200,
  events: 12,
} as const;
