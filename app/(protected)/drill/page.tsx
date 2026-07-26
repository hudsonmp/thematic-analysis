import { getDrillDeck } from '@/app/actions/drill';
import DrillHome from '@/components/drill/DrillSession';

/**
 * Drill — FSRS-scheduled retrieval practice on the a priori codes. Server
 * Component: loads the derived deck (codes + this user's scheduling states)
 * and hands it to the client session. Reviews are submitted from event
 * handlers in the client; a fresh visit re-resolves the queue.
 */
export default async function DrillPage() {
  const deck = await getDrillDeck();
  return <DrillHome codes={deck.codes} states={deck.states} />;
}
