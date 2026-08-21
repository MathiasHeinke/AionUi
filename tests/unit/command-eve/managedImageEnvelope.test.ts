import { describe, expect, it } from 'vitest';

import { handleCommandEveArtifactContextEnvelope } from '@/process/bridge/commandEveVideoBridge';
import { buildEveArtifactContextEnvelope } from '@/common/config/eveArtifactContextEnvelopeCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';

const IMAGE_SHA = 'b'.repeat(64);
const HANDLE = `evecap_${'e'.repeat(64)}`;
const SEAT_ID = 'seat-a';
function managedImageRecord(
  overrides: { id?: string; sha256?: string; createdAt?: number } = {}
): CommandEveActiveImageArtifact {
  const id = overrides.id ?? 'img_generated1';
  const sha256 = overrides.sha256 ?? IMAGE_SHA;
  const createdAt = overrides.createdAt ?? 1_754_000_000_000;
  return {
    id,
    seat_id: SEAT_ID,
    conversation_id: 'conv-1',
    kind: 'image',
    status: 'active',
    payload: {
      artifact_type: 'image',
      title: 'Bild 1K',
      description: '1K · 16:9 · gemini',
      managed_image: true,
      mime_type: 'image/png',
      sha256,
      size: 1234,
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspect_ratio: '16:9',
      prompt_sha256: 'c'.repeat(64),
      parent_artifact_id: 'img_parent1',
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getDataPath: () => '/tmp/unused',
    getActiveSeatId: () => SEAT_ID,
    buildEntries: () => [],
    recordActiveTurn: () => true,
    isVideoEditEnabled: () => false,
    isImageEditEnabled: () => true,
    listManagedImageRecords: () => [managedImageRecord()],
    ensureImageEditHandle: () => HANDLE,
    ...overrides,
  };
}

describe('managed image envelope entries', () => {
  it('an ACTIVE image rides with metadata + edit handle + parentage — and NO path anywhere', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild' },
      deps()
    );
    expect(envelope).toContain('artifact_id=img_generated1');
    expect(envelope).toContain('kind=image');
    expect(envelope).toContain('mime=image/png');
    expect(envelope).toContain('editable=true');
    expect(envelope).toContain(`edit_handle=${HANDLE}`);
    expect(envelope).toContain('edited_from=img_parent1');
    expect(envelope).toContain('Managed MCP artifact capabilities advertised to tools: eve_image_edit.');
    expect(envelope).toContain(
      'This capability list governs only managed MCP artifact operations; it is not the selected work-product surface.'
    );
    for (const token of ['/Users/', 'file:', 'MEDIA:', 'data:image', 'blobs']) {
      expect(envelope).not.toContain(token);
    }
  });

  it('forwards persisted image, video and Office cleanup notes through the same Hermes context', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'weiter' },
      deps({
        buildEntries: () => [
          {
            artifactId: 'video-1',
            kind: 'video',
            mimeType: 'video/mp4',
            durationSeconds: 5,
            editable: false,
            cleanupNotice: 'Hinweis: Im Ordner „videos“ wurden mindestens 100 Artefakte angelegt.',
          },
        ],
        listManagedImageRecords: () => [
          {
            ...managedImageRecord(),
            payload: {
              ...managedImageRecord().payload,
              cleanup_notice: 'Hinweis: Im Ordner „bilder“ wurden mindestens 100 Artefakte angelegt.',
            },
          },
        ],
        listOfficeArtifactRecords: async () =>
          [
            {
              payload: {
                cleanup_notice: 'Hinweis: Im Ordner „dokumente“ wurden mindestens 100 Artefakte angelegt.',
              },
            },
          ] as never,
      })
    );

    expect(envelope).toContain('Im Ordner „bilder“');
    expect(envelope).toContain('Im Ordner „videos“');
    expect(envelope).toContain('Im Ordner „dokumente“');
  });

  it('a record whose handle cannot be minted rides with editable=false and NO handle', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild' },
      deps({ ensureImageEditHandle: () => undefined })
    );
    expect(envelope).toContain('artifact_id=img_generated1');
    expect(envelope).toContain('editable=false');
    expect(envelope).not.toContain('edit_handle=');
    // …and a closed image seat advertises no capability.
    expect(envelope).not.toContain('eve_image_edit');
  });

  it('a closed image seat lists the image read-only', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild' },
      deps({ isImageEditEnabled: () => false })
    );
    expect(envelope).not.toContain('eve_image_edit');
  });

  it('marks the exact managed image selected for the native Hermes edit tool', async () => {
    const selectedSha = 'd'.repeat(64);
    const records = [
      managedImageRecord({ id: 'img_newer', sha256: IMAGE_SHA, createdAt: 1_754_000_010_000 }),
      managedImageRecord({ id: 'img_selected', sha256: selectedSha }),
    ];

    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        userTurnText: 'make the selected image brighter',
        selectedArtifactIds: ['img_selected'],
      },
      deps({ listManagedImageRecords: () => records })
    );

    expect(envelope).toContain('artifact_id=img_selected kind=image');
    expect(envelope).toContain('selected=true');
    expect(envelope).toContain('eve_image_edit');
  });

  it('the pure builder renders image entries alongside the advertised native tool', () => {
    const rendered = buildEveArtifactContextEnvelope({
      entries: [
        {
          artifactId: 'img_generated1',
          kind: 'image',
          mimeType: 'image/png',
          durationSeconds: 0,
          editable: true,
          editHandle: HANDLE,
          artifactSha256: IMAGE_SHA,
        },
      ],
      allowedCapabilities: ['eve_image_edit'],
    });
    expect(rendered).toContain('kind=image');
    expect(rendered).toContain(`edit_handle=${HANDLE}`);
    expect(rendered).toContain('eve_image_edit');
    // The content hash travels ONLY in the non-rendered field.
    expect(rendered).not.toContain(IMAGE_SHA);
  });
});
