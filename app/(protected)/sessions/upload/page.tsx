import UploadSession from '@/components/sessions/UploadSession';

/**
 * The upload page. A thin Server Component shell inside the (protected) group —
 * the route-group layout has already gated the session (`requireAuthUser`), so
 * the only job here is to mount the client `UploadSession`, which drives the
 * folder picker, the per-file resumable uploads (bound to the researcher's
 * browser session), and the `createSessionFromUpload` ingest call.
 */
export default function UploadPage() {
  return <UploadSession />;
}
