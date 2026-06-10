import { z } from 'zod';

export const EpisodeRef = z.object({
  module_id: z.string(),
  scenario_idx: z.number().int(),
  phase: z.enum(['initial', 'read', 'ponder', 'revise', 'retro', 'final']),
  span: z.tuple([z.number(), z.number()]).optional(),
});

/**
 * A coding reference anchored to a session RECORDING's clock — distinct from
 * `EpisodeRef` (which keys into authored study episodes by module/scenario/phase).
 * A `cb_codings.episode_ref` written from the session player carries this shape:
 * `span` is `[startMs, endMs]` on the recording clock, and `segment_idxs` records
 * which transcript segments the researcher brushed (so the highlight is
 * reconstructible even if the SRT is re-parsed). `user_id`/`study_id` may be null
 * (a recording can exist before its participant is resolved in `users`).
 */
export const RecordingRef = z.object({
  kind: z.literal('recording'),
  user_id: z.string().nullable(),
  study_id: z.string().nullable(),
  pid: z.string(),
  span: z.tuple([z.number(), z.number()]),     // [startMs, endMs] on the recording clock
  segment_idxs: z.array(z.number().int()).optional(),
});
export type RecordingRefT = z.infer<typeof RecordingRef>;

export const Exemplar = z.object({
  text: z.string().min(1),
  source_pid: z.string().optional(),
  episode_ref: EpisodeRef.optional(),
});

export const BulletList = z.array(z.string());

export const CodeVersionInput = z.object({
  definition: z.string().min(1),
  include_if: BulletList,
  exclude_if: BulletList,
  exemplars: z.array(Exemplar),
  disconfirming_pattern: z.string().optional(),
  prediction: z.string().optional(),
  prediction_falsifier: z.string().optional(),
  change_note: z.string().optional(),
});

export type EpisodeRefT = z.infer<typeof EpisodeRef>;
export type ExemplarT = z.infer<typeof Exemplar>;
export type CodeVersionInputT = z.infer<typeof CodeVersionInput>;
