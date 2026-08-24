import RegisterForm from './RegisterForm';

/**
 * Registration is INVITE-ONLY: the single-use token arrives as ?invite=<uuid> in the
 * link the admin minted at /?admin. Next 16: searchParams is a Promise.
 */
export default async function ResearcherRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const raw = (await searchParams).invite;
  const invite = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  return <RegisterForm invite={invite} />;
}
