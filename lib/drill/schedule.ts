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
 * Grading is Anki's four-grade scheme with one hard floor: a WRONG pick is
 * always Again — no self-rating can override an objective miss. A correct
 * pick earns the Again/Hard/Good/Easy choice (Again stays available for the
 * lucky guess the learner wants to disown).
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

/** Anki's grade scale: 1 Again · 2 Hard · 3 Good · 4 Easy. */
export type DrillRating = 1 | 2 | 3 | 4;

/** One review at an explicit grade. Returns the next card state and the
 *  numeric rating for the review log. */
export function gradeCard(
  card: Card,
  rating: DrillRating,
  now: Date,
): { card: Card; rating: number } {
  const { card: next } = engine.next(card, now, rating as Grade);
  return { card: next, rating };
}

/** Back-compat binary review: right pick → Good, wrong pick → Again. */
export function reviewCard(
  card: Card,
  correct: boolean,
  now: Date,
): { card: Card; rating: number } {
  return gradeCard(card, correct ? (Rating.Good as DrillRating) : (Rating.Again as DrillRating), now);
}

/** The projected time-until-next-review for EVERY grade — what the rating
 *  buttons print (Anki's affordance: the choice shows its consequence). */
export function previewIntervals(card: Card, now: Date): Record<DrillRating, number> {
  const out = {} as Record<DrillRating, number>;
  for (const r of [1, 2, 3, 4] as const) {
    const { card: next } = engine.next(card, now, r as Grade);
    out[r] = Math.max(0, next.due.getTime() - now.getTime());
  }
  return out;
}

export function isDue(card: Card, now: Date): boolean {
  return card.due.getTime() <= now.getTime();
}

/** True once a card has left the (re)learning steps — FSRS's Review state. */
export function isLearned(card: Card): boolean {
  return card.state === State.Review;
}
