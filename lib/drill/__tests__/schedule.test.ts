import { describe, it, expect } from 'vitest';
import {
  newCard,
  reviewCard,
  serializeCard,
  parseCard,
  isDue,
  isLearned,
} from '../schedule';

const T0 = new Date('2026-07-26T12:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe('schedule (FSRS wrapper)', () => {
  it('a new card is due immediately', () => {
    expect(isDue(newCard(T0), T0)).toBe(true);
  });

  it('correct answers push the due date monotonically outward', () => {
    let card = newCard(T0);
    let prevGap = 0;
    for (let i = 0; i < 5; i++) {
      const at = card.due; // review exactly when due
      ({ card } = reviewCard(card, true, at));
      const gap = card.due.getTime() - at.getTime();
      expect(gap).toBeGreaterThanOrEqual(prevGap);
      prevGap = gap;
    }
    // After five straight correct reviews the card is out of learning steps
    // and its interval is days, not minutes.
    expect(isLearned(card)).toBe(true);
    expect(prevGap).toBeGreaterThan(86_400_000);
  });

  it('a wrong answer after graduation counts a lapse and shrinks the interval', () => {
    let card = newCard(T0);
    for (let i = 0; i < 4; i++) {
      ({ card } = reviewCard(card, true, card.due));
    }
    expect(isLearned(card)).toBe(true);

    const at = card.due;
    const longGap = at.getTime() - card.last_review!.getTime();
    const { card: lapsed, rating } = reviewCard(card, false, at);
    expect(rating).toBe(1); // Again
    expect(lapsed.lapses).toBe(card.lapses + 1);
    expect(lapsed.due.getTime() - at.getTime()).toBeLessThan(longGap);
  });

  it('scheduling is deterministic (fuzz disabled)', () => {
    const a = reviewCard(newCard(T0), true, days(0)).card;
    const b = reviewCard(newCard(T0), true, days(0)).card;
    expect(a.due.getTime()).toBe(b.due.getTime());
    expect(a.stability).toBe(b.stability);
  });

  it('serialize → parse round-trips through JSON losslessly', () => {
    let card = newCard(T0);
    ({ card } = reviewCard(card, true, T0));
    ({ card } = reviewCard(card, false, days(1)));

    const revived = parseCard(JSON.parse(JSON.stringify(serializeCard(card))));
    expect(revived.due.getTime()).toBe(card.due.getTime());
    expect(revived.last_review?.getTime()).toBe(card.last_review?.getTime());
    expect(revived.stability).toBe(card.stability);
    expect(revived.difficulty).toBe(card.difficulty);
    expect(revived.reps).toBe(card.reps);
    expect(revived.lapses).toBe(card.lapses);
    expect(revived.state).toBe(card.state);

    // And the revived card keeps scheduling identically to the original.
    const fromOriginal = reviewCard(card, true, days(2)).card;
    const fromRevived = reviewCard(revived, true, days(2)).card;
    expect(fromRevived.due.getTime()).toBe(fromOriginal.due.getTime());
  });
});
