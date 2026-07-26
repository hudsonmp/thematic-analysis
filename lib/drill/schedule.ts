import {
  fsrs,
  createEmptyCard,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs';

/**
 * schedule — the FSRS wrapper for code drill.
 *
 * FSRS (Free Spaced Repetition Scheduler) is the memory model Anki ships as of
 * 23.10: a three-component DSR model (Difficulty, Stability, Retrievability)
 * whose ~20 default weights were fit on hundreds of millions of real Anki
 * reviews — that pretrained parameter vector IS the "model", and it ships
 * inside ts-fsrs, so scheduling is a pure local computation.
 *
 * Fuzz is disabled: interval jitter exists to de-synchronize big Anki decks,
 * which a ~40-code deck doesn't need, and determinism keeps this testable.
 *
 * Grading is BINARY on purpose. The drill auto-grades from the learner's pick
 * (right code → Good, wrong code → Again); asking a novice to self-rate
 * Hard/Good/Easy adds a judgment-of-learning task, and novice JOLs are poorly
 * calibrated — the pick itself is the honest signal.
 */

const engine = fsrs(generatorParameters({ enable_fuzz: false }));

/** The serialized Card as it lives in cb_drill_states.fsrs (dates as ISO). */
export type FsrsCardJson = Omit<Card, 'due' | 'last_review'> & {
  due: string;
  last_review?: string;
};

export function serializeCard(card: Card): FsrsCardJson {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review ? card.last_review.toISOString() : undefined,
  };
}

export function parseCard(json: FsrsCardJson): Card {
  return {
    ...json,
    due: new Date(json.due),
    last_review: json.last_review ? new Date(json.last_review) : undefined,
  };
}

/** A brand-new card, due immediately. */
export function newCard(now: Date): Card {
  return createEmptyCard(now);
}

/** One review: right pick → Good, wrong pick → Again. Returns the next card
 *  state and the numeric rating for the review log. */
export function reviewCard(
  card: Card,
  correct: boolean,
  now: Date,
): { card: Card; rating: number } {
  const rating: Grade = correct ? Rating.Good : Rating.Again;
  const { card: next } = engine.next(card, now, rating);
  return { card: next, rating };
}

export function isDue(card: Card, now: Date): boolean {
  return card.due.getTime() <= now.getTime();
}

/** True once a card has left the (re)learning steps — FSRS's Review state. */
export function isLearned(card: Card): boolean {
  return card.state === State.Review;
}
