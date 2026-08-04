import { describe, expect, it } from 'vitest';

import { resolveEditAuthorization } from '@/common/config/editAuthorizationCore';
import { resolveMediaLaneIntent } from '@/common/config/mediaLaneIntentCore';

const BOTH = { image: true, video: true };
const VIDEO_ONLY = { image: false, video: true };
const IMAGE_ONLY = { image: true, video: false };
const NEITHER = { image: false, video: false };

describe('resolveEditAuthorization — the fail-closed spend gate', () => {
  it('PFLICHT-PASS: "Gib der Aubergine ein Gesicht." over the ONE editable video resolves video_edit — while the UI stays silent', () => {
    // The mutation carries no medium noun: the visibility gate shows NOTHING
    // (precision-first, unchanged), and the authorization resolver still binds
    // the turn to the single canonical source's operation.
    const message = 'Gib der Aubergine ein Gesicht.';
    expect(resolveMediaLaneIntent({ message, sources: VIDEO_ONLY })).toEqual({ operation: 'none' });
    expect(resolveEditAuthorization({ message, sources: VIDEO_ONLY })).toBe('video_edit');
  });

  it('the image analogue: a contextual mutation over the ONE editable image resolves image_edit', () => {
    const message = 'Gib der Aubergine ein Gesicht.';
    expect(resolveMediaLaneIntent({ message, sources: IMAGE_ONLY })).toEqual({ operation: 'none' });
    expect(resolveEditAuthorization({ message, sources: IMAGE_ONLY })).toBe('image_edit');
  });

  it('repairs a natural missing-logo follow-up without opening media controls', () => {
    const german = 'Ja, und wo ist mein Logo?';
    const english = 'Where is my logo?';

    expect(resolveMediaLaneIntent({ message: german, sources: IMAGE_ONLY })).toEqual({ operation: 'none' });
    expect(resolveEditAuthorization({ message: german, sources: IMAGE_ONLY })).toBe('image_edit');
    expect(resolveMediaLaneIntent({ message: english, sources: VIDEO_ONLY })).toEqual({ operation: 'none' });
    expect(resolveEditAuthorization({ message: english, sources: VIDEO_ONLY })).toBe('video_edit');
  });

  it('keeps missing-element follow-ups fail-closed when the target is absent or ambiguous', () => {
    expect(resolveEditAuthorization({ message: 'Wo ist mein Logo?', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Mein Logo fehlt.', sources: NEITHER })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Where is my logo?', sources: BOTH })).toBeNull();
  });

  it('an explicit medium in the draft beats a deviating context', () => {
    // The newest canonical source is the image, but the user SAID video.
    expect(resolveEditAuthorization({ message: 'Bearbeite das Video', sources: BOTH })).toBe('video_edit');
    expect(resolveEditAuthorization({ message: 'Bearbeite das Bild', sources: BOTH })).toBe('image_edit');
    expect(resolveEditAuthorization({ message: 'Edit this clip', sources: BOTH })).toBe('video_edit');
  });

  it('both media plausible without uniqueness resolves NONE — no coin flip, no permit', () => {
    expect(resolveEditAuthorization({ message: 'Gib der Aubergine ein Gesicht.', sources: BOTH })).toBeNull();
  });

  it('a replied/selected context target breaks the tie', () => {
    expect(
      resolveEditAuthorization({ message: 'Gib der Aubergine ein Gesicht.', contextMedium: 'video', sources: BOTH })
    ).toBe('video_edit');
    expect(
      resolveEditAuthorization({ message: 'Gib der Aubergine ein Gesicht.', contextMedium: 'image', sources: BOTH })
    ).toBe('image_edit');
  });

  it('creation intent resolves NONE — a creation turn carries no edit permit', () => {
    expect(resolveEditAuthorization({ message: 'Erstelle ein Video von einer Aubergine', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Create an image of an aubergine', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Generiere ein Bild', sources: IMAGE_ONLY })).toBeNull();
    // Edit-like WORDS inside a strong creation do not turn it into an edit.
    expect(resolveEditAuthorization({ message: 'Erstelle ein animiertes Video', sources: VIDEO_ONLY })).toBeNull();
  });

  it('a non-mutation turn (Hallo/Danke/opinion) resolves NONE', () => {
    expect(resolveEditAuthorization({ message: 'Hallo', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Danke!', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Was hältst du davon?', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: '', sources: BOTH })).toBeNull();
    expect(resolveEditAuthorization({ message: undefined, sources: BOTH })).toBeNull();
  });

  it('an explicit medium WITHOUT a canonically editable source resolves NONE', () => {
    // Hermes explains the missing target honestly; the app pre-arms no spend.
    expect(resolveEditAuthorization({ message: 'Bearbeite das Video', sources: NEITHER })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Bearbeite das Video', sources: IMAGE_ONLY })).toBeNull();
    expect(resolveEditAuthorization({ message: 'Bearbeite das Bild', sources: VIDEO_ONLY })).toBeNull();
  });

  it('a contextual mutation with NO editable source at all resolves NONE', () => {
    expect(resolveEditAuthorization({ message: 'Gib der Aubergine ein Gesicht.', sources: NEITHER })).toBeNull();
  });
});
