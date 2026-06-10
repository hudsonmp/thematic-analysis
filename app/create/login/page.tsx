import ResearcherLoginForm from './ResearcherLoginForm';

// Validate the post-login destination to internal, app-relative paths only.
// The whole app is researcher-gated, so any internal route is a valid target;
// default to the home route.
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//') && raw !== '/create/login') {
    return raw;
  }
  return '/';
}

export default async function ResearcherLoginPage(props: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await props.searchParams;
  return <ResearcherLoginForm next={safeNext(next)} />;
}
