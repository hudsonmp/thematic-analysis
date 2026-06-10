import 'server-only';
import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';

export type ResearcherSession = {
  ok?: boolean;
  at?: number;
};

export const RESEARCHER_COOKIE = 'specstudy_researcher';

export const researcherSessionOptions: SessionOptions = {
  cookieName: RESEARCHER_COOKIE,
  password: process.env.COOKIE_SECRET!,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
};

export async function getResearcherSession() {
  const cookieStore = await cookies();
  return getIronSession<ResearcherSession>(
    cookieStore,
    researcherSessionOptions,
  );
}

export function verifyResearcherPassword(submitted: string): boolean {
  const expected = process.env.RESEARCHER_PASSWORD ?? '';
  if (!expected || !submitted) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
