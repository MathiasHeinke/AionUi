/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the media-lane intent gate, pinned against the Founder/CoS
 * contract: intent activates controls, never content. The visible artifact
 * only disambiguates a genuine mutation intent.
 */

import { describe, expect, it } from 'vitest';

import {
  isArtifactMutationIntent,
  isImageLaneRequest,
  resolveMediaLaneIntent,
} from '@/common/config/mediaLaneIntentCore';

describe('isImageLaneRequest', () => {
  it('matches image creation phrasing in EN and DE', () => {
    expect(isImageLaneRequest('Erstelle ein Bild: eine lila Aubergine als Icon.')).toBe(true);
    expect(isImageLaneRequest('generate an image of an eggplant icon')).toBe(true);
    expect(isImageLaneRequest('Mach mir ein Logo für die Firma')).toBe(true);
    expect(isImageLaneRequest('create a poster for the launch')).toBe(true);
    expect(isImageLaneRequest('text-to-image with a neon eggplant')).toBe(true);
  });

  it('never matches plain chat, non-creation media mentions, or video intent', () => {
    expect(isImageLaneRequest('Schick mir das Foto von gestern.')).toBe(false);
    expect(isImageLaneRequest('Was siehst du auf dem Bild?')).toBe(false);
    expect(isImageLaneRequest('hello, how are you?')).toBe(false);
    expect(isImageLaneRequest('')).toBe(false);
    expect(isImageLaneRequest(undefined)).toBe(false);
    expect(isImageLaneRequest('Erstelle ein kurzes Video von einer Aubergine.')).toBe(false);
    expect(isImageLaneRequest('generate a video clip for the product')).toBe(false);
  });
});

describe('isArtifactMutationIntent', () => {
  it('covers the generic mutation families (EN + DE), not one pinned sentence', () => {
    expect(isArtifactMutationIntent('Gib der Aubergine ein Gesicht.')).toBe(true);
    expect(isArtifactMutationIntent('Füge links ein Logo hinzu.')).toBe(true);
    expect(isArtifactMutationIntent('add a second character')).toBe(true);
    expect(isArtifactMutationIntent('change the background to black')).toBe(true);
    expect(isArtifactMutationIntent('Entferne den Schatten.')).toBe(true);
    expect(isArtifactMutationIntent('Ersetze den Himmel durch Nacht.')).toBe(true);
    expect(isArtifactMutationIntent('crop it to 1:1')).toBe(true);
    expect(isArtifactMutationIntent('Schneide den Anfang weg.')).toBe(true);
    expect(isArtifactMutationIntent('animate the eggplant slowly')).toBe(true);
    expect(isArtifactMutationIntent('Färbe den Hintergrund um.')).toBe(true);
  });

  it('excludes greetings, thanks, questions, analysis, continuation and meta imperatives', () => {
    expect(isArtifactMutationIntent('Hallo.')).toBe(false);
    expect(isArtifactMutationIntent('Danke.')).toBe(false);
    expect(isArtifactMutationIntent('Was hältst du davon?')).toBe(false);
    expect(isArtifactMutationIntent('Was kannst du eigentlich alles?')).toBe(false);
    expect(isArtifactMutationIntent('Analysiere das Bild.')).toBe(false);
    expect(isArtifactMutationIntent('Mach weiter.')).toBe(false);
    expect(isArtifactMutationIntent('Lösch den Chat.')).toBe(false);
    expect(isArtifactMutationIntent('Ändere die App-Einstellungen.')).toBe(false);
    expect(isArtifactMutationIntent('')).toBe(false);
    expect(isArtifactMutationIntent(undefined)).toBe(false);
  });

  it('excludes time/scheduling/document objects even with mutation verbs (Grok MAJOR 2+3)', () => {
    expect(isArtifactMutationIntent('give me five minutes')).toBe(false);
    expect(isArtifactMutationIntent('add that to the email')).toBe(false);
    expect(isArtifactMutationIntent('change the meeting time')).toBe(false);
    expect(isArtifactMutationIntent('remove the second paragraph')).toBe(false);
    expect(isArtifactMutationIntent('Ändere den Betreff.')).toBe(false);
    expect(isArtifactMutationIntent('Lösch den zweiten Absatz.')).toBe(false);
  });

  it('keeps polite question-FORM requests (Grok MAJOR 1: no blanket `?` ban)', () => {
    expect(isArtifactMutationIntent('Kannst du der Aubergine ein Gesicht geben?')).toBe(true);
    expect(isArtifactMutationIntent('Can you give the eggplant a face?')).toBe(true);
  });
});

describe('resolveMediaLaneIntent — the Founder/CoS contract', () => {
  it('explicit image create/edit intent => image controls (no artifact needed)', () => {
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein Bild: eine lila Aubergine als Icon.' })).toEqual({
      operation: 'create',
      medium: 'image',
    });
  });

  it('explicit video create/edit intent => video controls (no artifact needed)', () => {
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein kurzes Video (480p): eine Aubergine dreht sich.' })).toEqual(
      { operation: 'create', medium: 'video' }
    );
  });

  it('latest video + "Hallo" => null (artifact is context, never intent)', () => {
    expect(resolveMediaLaneIntent({ message: 'Hallo.', latestVisibleArtifactType: 'video' })).toEqual({
      operation: 'none',
    });
  });

  it('latest video + "Danke" => null', () => {
    expect(resolveMediaLaneIntent({ message: 'Danke.', latestVisibleArtifactType: 'video' })).toEqual({
      operation: 'none',
    });
  });

  it('latest video + "Was hältst du davon?" => null', () => {
    expect(resolveMediaLaneIntent({ message: 'Was hältst du davon?', latestVisibleArtifactType: 'video' })).toEqual({
      operation: 'none',
    });
  });

  it('latest video + topic change => null', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Schreib mir eine E-Mail an den Kunden.',
        latestVisibleArtifactType: 'video',
      })
    ).toEqual({ operation: 'none' });
  });

  it('latest video + "Gib der Aubergine ein Gesicht" => video (kind disambiguates mutation)', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Gib der Aubergine ein Gesicht.',
        latestVisibleArtifactType: 'video',
      })
    ).toEqual({ operation: 'edit-hint', medium: 'video' });
  });

  it('latest image + "Füge links ein Logo hinzu" => image', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Füge links ein Logo hinzu.',
        latestVisibleArtifactType: 'image',
      })
    ).toEqual({ operation: 'edit-hint', medium: 'image' });
  });

  it('mutation intent WITHOUT a visible artifact => null', () => {
    expect(resolveMediaLaneIntent({ message: 'Gib der Aubergine ein Gesicht.' })).toEqual({ operation: 'none' });
    expect(resolveMediaLaneIntent({ message: 'add a second character' })).toEqual({ operation: 'none' });
  });

  it('explicit current-draft intent overrides artifact context', () => {
    // Fresh explicit image request over a visible video: image wins the slot.
    expect(
      resolveMediaLaneIntent({
        message: 'Erstelle ein Bild im gleichen Stil.',
        latestVisibleArtifactType: 'video',
      })
    ).toEqual({ operation: 'create', medium: 'image' });
    // Explicit video beats explicit image when a draft carries both.
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein Bild und ein Video davon.' })).toEqual({
      operation: 'create',
      medium: 'video',
    });
  });

  it('image and video are structurally mutually exclusive (one return value)', () => {
    const lanes = [
      resolveMediaLaneIntent({ message: 'Erstelle ein Bild.' }),
      resolveMediaLaneIntent({ message: 'Erstelle ein Video.' }),
      resolveMediaLaneIntent({ message: 'Gib der Aubergine ein Gesicht.', latestVisibleArtifactType: 'video' }),
    ];
    expect(lanes).toEqual([
      { operation: 'create', medium: 'image' },
      { operation: 'create', medium: 'video' },
      { operation: 'edit-hint', medium: 'video' },
    ]);
    for (const lane of lanes)
      expect(lane.operation === 'none' || lane.operation === 'create' || lane.operation === 'edit-hint').toBe(true);
  });

  it('keeps the video gate’s existing signals (addressed videomarketer still wins)', () => {
    expect(resolveMediaLaneIntent({ message: 'Hallo.', resolvedAgentId: 'video-marketer' })).toEqual({
      operation: 'create',
      medium: 'video',
    });
  });
});
