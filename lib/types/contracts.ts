import { z } from 'zod';

export const EpisodeRef = z.object({
  module_id: z.string(),
  scenario_idx: z.number().int(),
  phase: z.enum(['initial', 'read', 'ponder', 'revise', 'retro', 'final']),
  span: z.tuple([z.number(), z.number()]).optional(),
});

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
