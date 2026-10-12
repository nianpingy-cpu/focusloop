import { describe, expect, it } from 'vitest';
import {
  LEARNER_ANSWER_CHARACTERS,
  type Course,
  type MicroTask,
  type MicroTaskKind,
} from '@focusloop/shared-types';
import {
  answerTooLong,
  canCheckAnswer,
  canCheckQuiz,
  quizVerdictKey,
  stepAnswerView,
} from './step-answer';

function task(kind: MicroTaskKind, id = 't1'): MicroTask {
  return {
    id,
    courseId: 'c1',
    conceptId: 'concept-1',
    title: 'A step',
    instructions: 'Do the thing.',
    kind,
    estimatedMinutes: 3,
    order: 0,
  };
}

function course(quizzes: Course['quizzes']): Course {
  return {
    id: 'c1',
    title: 'A course',
    description: '',
    concepts: [],
    microTasks: [],
    quizzes,
  };
}

const quiz = {
  id: 'q1',
  taskId: 't1',
  conceptId: 'concept-1',
  question: 'Which one?',
  options: ['a', 'b', 'c'],
  answerIndex: 1,
  explanation: 'Because.',
};

describe('stepAnswerView', () => {
  it('offers the quiz a quiz step asks, without the answer', () => {
    const view = stepAnswerView(course([quiz]), task('quiz'));

    expect(view?.quiz).toEqual({ quizId: 'q1', question: 'Which one?', options: ['a', 'b', 'c'] });
    // The key is not in the view at all — that is the point of the projection, and this is the
    // assertion that fails if somebody hands the row over instead.
    expect(JSON.stringify(view?.quiz)).not.toContain('answerIndex');
  });

  /*
   * The demo course attaches a quiz to a practice step as well. Offering it there would ask a question
   * the step's own instructions never mention, so the kind decides and the row only supplies.
   */
  it('does not offer a quiz on a step that is not a quiz', () => {
    expect(stepAnswerView(course([quiz]), task('practice'))?.quiz).toBeNull();
    expect(stepAnswerView(course([quiz]), task('read'))?.quiz).toBeNull();
  });

  it('falls back to the box for a quiz step with no quiz row', () => {
    const view = stepAnswerView(course([]), task('quiz'));
    expect(view?.quiz).toBeNull();
    expect(view?.placeholderKey).toBe('focus.answer.placeholder.quiz');
  });

  it('has nothing to offer before a step is running', () => {
    expect(stepAnswerView(course([quiz]), null)).toBeNull();
  });

  it('asks for something different on each kind of step', () => {
    const keys = (['read', 'practice', 'quiz'] as const).map(
      (kind) => stepAnswerView(course([]), task(kind))?.placeholderKey,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('carries the record’s bound rather than one of its own', () => {
    expect(stepAnswerView(course([]), task('read'))?.maxCharacters).toBe(LEARNER_ANSWER_CHARACTERS);
  });
});

describe('canCheckAnswer', () => {
  it('needs something to check', () => {
    expect(canCheckAnswer('A BST keeps order.')).toBe(true);
    expect(canCheckAnswer('   ')).toBe(false);
    expect(canCheckAnswer('')).toBe(false);
  });
});

describe('canCheckQuiz', () => {
  it('needs a choice', () => {
    expect(canCheckQuiz(0)).toBe(true);
    expect(canCheckQuiz(3)).toBe(true);
    expect(canCheckQuiz(null)).toBe(false);
    expect(canCheckQuiz(-1)).toBe(false);
    expect(canCheckQuiz(1.5)).toBe(false);
  });
});

describe('answerTooLong', () => {
  it('is only true past the bound', () => {
    expect(answerTooLong('x'.repeat(LEARNER_ANSWER_CHARACTERS), LEARNER_ANSWER_CHARACTERS)).toBe(
      false,
    );
    expect(
      answerTooLong('x'.repeat(LEARNER_ANSWER_CHARACTERS + 1), LEARNER_ANSWER_CHARACTERS),
    ).toBe(true);
  });
});

describe('quizVerdictKey', () => {
  it('says which way it went', () => {
    expect(quizVerdictKey(true)).toBe('focus.quiz.correct');
    expect(quizVerdictKey(false)).toBe('focus.quiz.incorrect');
  });
});
