import { listFamiliarization } from '@/app/actions/admin';
import GuideTour from './GuideTour';

/**
 * /guide — the onboarding walkthrough for new coders: each coding feature as a
 * card, in the order a coder meets them, ending with the admin-curated
 * DATA-FAMILIARIZATION list (the sessions to watch before coding anything).
 *
 * A page of cards rather than DOM-anchored tooltips on purpose: spotlight tours
 * break the moment the UI they point at shifts, and this UI is under active
 * development — a guide that lies is worse than none. Each card links to the real
 * surface instead.
 */
export default async function GuidePage() {
  const familiarization = await listFamiliarization();
  return <GuideTour familiarization={familiarization} />;
}
