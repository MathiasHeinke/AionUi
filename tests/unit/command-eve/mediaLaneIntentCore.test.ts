/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the media-lane intent gate, pinned against the FINAL
 * Founder/CoS contract: precision over recall, explicit medium noun plus
 * edit semantics required, edit veto before creation, per-medium source
 * binding, umlaut-safe German.
 */

import { describe, expect, it } from 'vitest';

import {
  isExplicitVideoEditRequest,
  isImageEditRequest,
  isImageLaneRequest,
  resolveMediaLaneIntent,
} from '@/common/config/mediaLaneIntentCore';

const NONE = { operation: 'none' } as const;

describe('plain chat / greetings / questions: NEVER any control', () => {
  it.each([
    'Hallo.',
    'Danke.',
    'Was hältst du davon?',
    'Was kannst du eigentlich alles?',
    'Analysiere das Bild.',
    'Mach weiter.',
    'Schreib mir eine E-Mail an den Kunden.',
    'Schau dir das im Video an.',
    'Was passiert im Video?',
    'hello, how are you?',
    '',
  ])('%s => none', (message) => {
    expect(resolveMediaLaneIntent({ message, sources: { image: true, video: true } })).toEqual(NONE);
  });
});

describe('GENERIC MUTATION OVERFIRE: every reproduced false positive is quiet', () => {
  it.each([
    'Füge eine Aufgabe hinzu.',
    'Add a todo item.',
    'Lösche die Datei.',
    'Remove this task.',
    'Change the project title.',
    'Setze den Status auf erledigt.',
    'Add a note for tomorrow.',
    'Bearbeite den Vertrag.',
    'give me five minutes',
    'add that to the email',
    'change the meeting time',
    'remove the second paragraph',
    'Ändere den Betreff.',
    'Lösch den zweiten Absatz.',
    'Gib der Aubergine ein Gesicht.', // NO medium noun: ambiguous by design
  ])('%s => none even with sources visible', (message) => {
    expect(resolveMediaLaneIntent({ message, sources: { image: true, video: true } })).toEqual(NONE);
  });
});

describe('explicit EDIT intent binds to the MATCHING medium only', () => {
  it('Bearbeite das Bild + newest artifact is VIDEO (image source exists) => edit-hint/image', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Bearbeite das Bild und gib der Aubergine ein Gesicht.',
        sources: { image: true, video: true },
      })
    ).toEqual({ operation: 'edit-hint', medium: 'image' });
  });

  it('Bearbeite das Bild + only VIDEO source => none (no matching source, no wrong affordance)', () => {
    expect(resolveMediaLaneIntent({ message: 'Bearbeite das Bild.', sources: { image: false, video: true } })).toEqual(
      NONE
    );
  });

  it('Bearbeite das Video + newest artifact is IMAGE (video source exists) => edit-hint/video', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Bearbeite das Video und mach es kürzer.',
        sources: { image: true, video: true },
      })
    ).toEqual({ operation: 'edit-hint', medium: 'video' });
  });

  it('Bearbeite das Video + only IMAGE source => none', () => {
    expect(resolveMediaLaneIntent({ message: 'Bearbeite das Video.', sources: { image: true, video: false } })).toEqual(
      NONE
    );
  });

  it('the canonical explicit frame: Gib der Aubergine im Video ein Gesicht => edit-hint/video', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Gib der Aubergine im Video ein Gesicht.',
        sources: { image: false, video: true },
      })
    ).toEqual({ operation: 'edit-hint', medium: 'video' });
  });

  it('the canonical frame without a video source => none (Hermes explains the missing target)', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Gib der Aubergine im Video ein Gesicht.',
        sources: { image: true, video: false },
      })
    ).toEqual(NONE);
  });

  it('Füge links ein Logo im Bild hinzu => edit-hint/image with image source', () => {
    expect(
      resolveMediaLaneIntent({
        message: 'Füge links ein Logo im Bild hinzu.',
        sources: { image: true, video: false },
      })
    ).toEqual({ operation: 'edit-hint', medium: 'image' });
  });
});

describe('EDIT VETO beats the creation regex (the three direct-generation regressions)', () => {
  it.each(['Schneide das Video.', 'Mach das Video heller.', 'Animate this video.'])(
    '%s => edit-hint/video with source, never create',
    (message) => {
      expect(resolveMediaLaneIntent({ message, sources: { image: false, video: true } })).toEqual({
        operation: 'edit-hint',
        medium: 'video',
      });
      // …and the shared veto predicate matches the same texts.
      expect(isExplicitVideoEditRequest(message)).toBe(true);
    }
  );

  it('the veto holds without a source (none, but still vetoed — never direct generation)', () => {
    for (const message of ['Schneide das Video.', 'Mach das Video heller.', 'Animate this video.']) {
      expect(isExplicitVideoEditRequest(message)).toBe(true);
      expect(resolveMediaLaneIntent({ message, sources: { image: false, video: false } })).toEqual(NONE);
    }
  });
});

describe('UMLAUT-SAFE German boundaries', () => {
  it.each([
    'Ändere das Video.',
    'Ändere das Bild.',
    'Verändere das Video bitte.',
    'Öffne das Bild nicht, aber bearbeite das Bild.',
  ])('%s matches the edit predicate for its medium', (message) => {
    const isVideo = /video/i.test(message);
    if (isVideo) {
      expect(isExplicitVideoEditRequest(message)).toBe(true);
      expect(resolveMediaLaneIntent({ message, sources: { image: true, video: true } })).toEqual({
        operation: 'edit-hint',
        medium: 'video',
      });
    } else {
      expect(isImageEditRequest(message)).toBe(true);
      expect(resolveMediaLaneIntent({ message, sources: { image: true, video: true } })).toEqual({
        operation: 'edit-hint',
        medium: 'image',
      });
    }
  });

  it('umlaut stems do not overfire on non-media nouns', () => {
    expect(isExplicitVideoEditRequest('Ändere den Termin.')).toBe(false);
    expect(isImageEditRequest('Ändere den Vertrag.')).toBe(false);
  });
});

describe('explicit CREATE intent (unchanged semantics)', () => {
  it('explicit image create => create/image (full selector, no source needed)', () => {
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein Bild: eine lila Aubergine als Icon.' })).toEqual({
      operation: 'create',
      medium: 'image',
    });
  });

  it('explicit video create => create/video (full creation settings, no source needed)', () => {
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein kurzes Video (480p): eine Aubergine dreht sich.' })).toEqual(
      { operation: 'create', medium: 'video' }
    );
  });

  it('a mixed draft still resolves to the expensive lane (video before image)', () => {
    expect(resolveMediaLaneIntent({ message: 'Erstelle ein Bild und ein Video davon.' })).toEqual({
      operation: 'create',
      medium: 'video',
    });
  });

  it('image creation phrasing EN + DE, and never video creation as image', () => {
    expect(isImageLaneRequest('generate an image of an eggplant icon')).toBe(true);
    expect(isImageLaneRequest('Mach mir ein Logo für die Firma')).toBe(true);
    expect(isImageLaneRequest('Erstelle ein kurzes Video von einer Aubergine.')).toBe(false);
    expect(isImageLaneRequest('Schick mir das Foto von gestern.')).toBe(false);
  });

  it('keeps the shipped video-gate signals (addressed videomarketer still wins)', () => {
    expect(resolveMediaLaneIntent({ message: 'Hallo.', resolvedAgentId: 'video-marketer' })).toEqual({
      operation: 'create',
      medium: 'video',
    });
  });
});

describe('CREATION-VS-EDIT PRECEDENCE (CoS): strong creation wins over edit-like words', () => {
  it.each([
    ['Erstelle ein animiertes Video von einer Aubergine.', 'video'],
    ['Create an animated video.', 'video'],
    ['Gib mir ein Video von einer Aubergine.', 'video'],
    ['Give me a video of an eggplant.', 'video'],
    ['Erstelle ein Bild und füge darauf ein Logo hinzu.', 'image'],
    ['Create an image and add a logo.', 'image'],
    ['generate images of eggplants for the campaign', 'image'],
  ])('%s => create/%s (NEVER edit, even with a source visible)', (message, medium) => {
    expect(resolveMediaLaneIntent({ message, sources: { image: true, video: true } })).toEqual({
      operation: 'create',
      medium,
    });
    // The shared veto predicate agrees: these are NOT edits.
    if (medium === 'video') expect(isExplicitVideoEditRequest(message)).toBe(false);
    else expect(isImageEditRequest(message)).toBe(false);
  });

  it('edit semantics still hold when no strong creation is named', () => {
    for (const message of ['Mach das Video heller.', 'Schneide das Video.', 'Animate this video.']) {
      expect(isExplicitVideoEditRequest(message)).toBe(true);
      expect(resolveMediaLaneIntent({ message, sources: { image: false, video: true } })).toEqual({
        operation: 'edit-hint',
        medium: 'video',
      });
    }
  });

  it('weak/ambiguous forms stay quiet rather than misroute', () => {
    // 'add' without a strong creation verb and without edit semantics: not
    // an edit, not our lane at all.
    expect(resolveMediaLaneIntent({ message: 'Add a video of the product to the page.' })).toEqual(NONE);
    // "Give me five minutes" is neither (no medium noun).
    expect(resolveMediaLaneIntent({ message: 'Give me five minutes.' })).toEqual(NONE);
    // "Gib mir ein Gesicht" — request idiom without a medium noun: quiet.
    expect(resolveMediaLaneIntent({ message: 'Gib mir ein Gesicht.' })).toEqual(NONE);
    // Ordinary workplace verbs are not edits even with a matching source
    // visible (Grok final MAJOR): insert/attach/append do not fire.
    expect(
      resolveMediaLaneIntent({
        message: 'Insert the new table into the image doc.',
        sources: { image: true, video: false },
      })
    ).toEqual(NONE);
    expect(
      resolveMediaLaneIntent({ message: 'Attach the contract to the ticket.', sources: { image: true, video: true } })
    ).toEqual(NONE);
    expect(
      resolveMediaLaneIntent({ message: 'Append the signature to the report.', sources: { image: true, video: false } })
    ).toEqual(NONE);
  });
});

describe('structural exclusivity', () => {
  it('every answer is exactly one of none/create/edit-hint', () => {
    const lanes = [
      resolveMediaLaneIntent({ message: 'Erstelle ein Bild.' }),
      resolveMediaLaneIntent({ message: 'Erstelle ein Video.' }),
      resolveMediaLaneIntent({
        message: 'Gib der Aubergine im Video ein Gesicht.',
        sources: { image: false, video: true },
      }),
      resolveMediaLaneIntent({ message: 'Hallo.' }),
    ];
    expect(lanes).toEqual([
      { operation: 'create', medium: 'image' },
      { operation: 'create', medium: 'video' },
      { operation: 'edit-hint', medium: 'video' },
      NONE,
    ]);
  });
});
