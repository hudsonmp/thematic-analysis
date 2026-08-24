/**
 * channel — the realtime topic name for an annotation subscription.
 *
 * The codebook layer (/sessions/[id], cb_annotations) and the action layer
 * (/coding/action/[id], cb_action_annotations) are separate coding surfaces
 * over the SAME session, and a coder may have both open. Supabase topics are
 * per-client, so a session-only name means the second subscribe collides with
 * the first and one surface silently stops refreshing. The anchor table names
 * the layer, so it belongs in the topic.
 */
export function annotationChannelName(sessionId: string, annotationsTable: string): string {
  return `realtime:${annotationsTable}:${sessionId}`;
}
