'use client';

import {
  addAnnotation,
  addCodeToAnnotation,
  removeCodeFromAnnotation,
  updateAnnotationAnchor,
  deleteAnnotation,
  listMyAnnotationsForVersion,
  addAnnotationComment,
  listAnnotationComments,
  editAnnotationComment,
  deleteAnnotationComment,
  type MyAnnotationView,
  type AnnotationCommentView,
} from '@/app/actions/annotations';
import {
  addActionAnnotation,
  addActionCoding,
  removeActionCoding,
  updateActionAnnotationAnchor,
  deleteActionAnnotation,
  listMyActionAnnotationsForVersion,
  addActionAnnotationComment,
  listActionAnnotationComments,
  editActionAnnotationComment,
  deleteActionAnnotationComment,
} from '@/app/actions/action-coding';
import type { ManualComposition } from '@/lib/actions/schema';

/**
 * annotationBackend — the ONE seam between the session player and the store its
 * spans live in. The player's anchor grammar (select → annotate → attach /
 * detach / re-anchor / delete / comment) is identical on the codebook layer
 * (/sessions/[id], cb_annotations + codebook codes) and the action layer
 * (/coding/action/[id], cb_action_annotations + moves × objects), so the player
 * is written once against this interface and the page picks the layer.
 *
 * "codeId" is deliberately opaque here: on the codebook layer it is a cb_codes
 * id; on the action layer it is a cb_actions id when attaching, and a
 * cb_action_codings row id when detaching (each coding is its own chip). A
 * MANUAL composition (ad hoc moves × objects, not promoted) travels in `manual`
 * with an empty codeId — the codebook layer never receives one.
 */
export type CodingLayer = 'codebook' | 'action';

export type AnchorInput = {
  segmentId: string;
  endSegmentId?: string | null;
  charStart: number;
  charEnd: number;
  quoteText?: string | null;
  prefix?: string | null;
  suffix?: string | null;
  tStartMs: number;
  tEndMs: number;
};

export type AnnotationBackend = {
  layer: CodingLayer;
  /** The tables the realtime hook watches for this layer (anchor + junction). */
  realtimeTables: { annotations: string; links: string };
  listMine(sessionId: string, versionId: string, codebookId: string): Promise<MyAnnotationView[]>;
  add(
    input: AnchorInput & {
      sessionId: string;
      versionId: string;
      codebookId: string;
      kind: 'code' | 'quote' | 'bookmark';
      codeIds: string[];
      manual?: ManualComposition | null;
    },
  ): Promise<{ id: string }>;
  addCode(
    annotationId: string,
    codeId: string,
    manual: ManualComposition | null,
    codebookId: string,
  ): Promise<'added' | 'annotation_gone'>;
  removeCode(annotationId: string, codeId: string): Promise<void>;
  updateAnchor(annotationId: string, anchor: AnchorInput): Promise<void>;
  delete(annotationId: string): Promise<void>;
  addComment(annotationId: string, body: string): Promise<unknown>;
  listComments(annotationIds: string[]): Promise<Record<string, AnnotationCommentView[]>>;
  editComment(id: string, body: string): Promise<void>;
  deleteComment(id: string): Promise<void>;
};

/** The legacy codebook layer — exactly the calls the player made before the seam. */
export const CODEBOOK_BACKEND: AnnotationBackend = {
  layer: 'codebook',
  realtimeTables: { annotations: 'cb_annotations', links: 'cb_annotation_codes' },
  listMine: (sessionId, versionId) => listMyAnnotationsForVersion(sessionId, versionId),
  add: ({ codebookId, manual, ...input }) => {
    // The codebook layer has no use for these two (it resolves codes, never
    // compositions); they exist on the interface for the action layer.
    void codebookId;
    void manual;
    return addAnnotation(input);
  },
  addCode: (annotationId, codeId) => addCodeToAnnotation(annotationId, codeId),
  removeCode: removeCodeFromAnnotation,
  updateAnchor: updateAnnotationAnchor,
  delete: deleteAnnotation,
  addComment: addAnnotationComment,
  listComments: listAnnotationComments,
  editComment: editAnnotationComment,
  deleteComment: deleteAnnotationComment,
};

/** The action layer (/coding/action): anchors in cb_action_annotations, chips = action codings. */
export const ACTION_BACKEND: AnnotationBackend = {
  layer: 'action',
  realtimeTables: { annotations: 'cb_action_annotations', links: 'cb_action_codings' },
  listMine: listMyActionAnnotationsForVersion,
  add: ({ codeIds, manual, ...input }) =>
    addActionAnnotation({
      ...input,
      coding: manual ? { manual } : codeIds[0] ? { actionId: codeIds[0] } : null,
    }),
  addCode: (annotationId, codeId, manual, codebookId) =>
    addActionCoding(annotationId, manual ? { manual } : { actionId: codeId }, codebookId),
  removeCode: removeActionCoding,
  updateAnchor: updateActionAnnotationAnchor,
  delete: deleteActionAnnotation,
  addComment: addActionAnnotationComment,
  listComments: listActionAnnotationComments,
  editComment: editActionAnnotationComment,
  deleteComment: deleteActionAnnotationComment,
};

export function backendFor(layer: CodingLayer): AnnotationBackend {
  return layer === 'action' ? ACTION_BACKEND : CODEBOOK_BACKEND;
}
