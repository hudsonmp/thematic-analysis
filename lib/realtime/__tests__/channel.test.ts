import { describe, expect, it } from 'vitest';
import { annotationChannelName } from '../channel';

/**
 * The codebook layer (/sessions/[id]) and the action layer
 * (/coding/action/[id]) are separate coding surfaces over the SAME session. A
 * coder may have both open. Two subscribes on one topic name in one browser
 * client is a collision, so the topic has to name the layer as well as the
 * session.
 */
describe('annotationChannelName', () => {
  it('gives the two layers different topics for the same session', () => {
    const codebook = annotationChannelName('sess-1', 'cb_annotations');
    const action = annotationChannelName('sess-1', 'cb_action_annotations');

    expect(codebook).not.toBe(action);
  });

  it('gives the same layer the same topic for the same session', () => {
    expect(annotationChannelName('sess-1', 'cb_annotations')).toBe(
      annotationChannelName('sess-1', 'cb_annotations'),
    );
  });

  it('gives different sessions different topics on the same layer', () => {
    expect(annotationChannelName('sess-1', 'cb_annotations')).not.toBe(
      annotationChannelName('sess-2', 'cb_annotations'),
    );
  });
});
