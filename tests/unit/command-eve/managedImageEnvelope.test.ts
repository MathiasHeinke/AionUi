import { describe, expect, it } from 'vitest';

import { handleCommandEveArtifactContextEnvelope } from '@/process/bridge/commandEveVideoBridge';
import { buildEveArtifactContextEnvelope } from '@/common/config/eveArtifactContextEnvelopeCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';

const IMAGE_SHA = 'b'.repeat(64);
const HANDLE = `evecap_${'e'.repeat(64)}`;

function managedImageRecord(): CommandEveActiveImageArtifact {
  return {
    id: 'img_generated1',
    conversation_id: 'conv-1',
    kind: 'image',
    status: 'active',
    payload: {
      artifact_type: 'image',
      title: 'Bild 1K',
      description: '1K · 16:9 · gemini',
      managed_image: true,
      mime_type: 'image/png',
      sha256: IMAGE_SHA,
      size: 1234,
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspect_ratio: '16:9',
      prompt_sha256: 'c'.repeat(64),
      parent_artifact_id: 'img_parent1',
    },
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_000,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getDataPath: () => '/tmp/unused',
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
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild', requestedEditOperation: 'image_edit' },
      deps()
    );
    expect(envelope).toContain('artifact_id=img_generated1');
    expect(envelope).toContain('kind=image');
    expect(envelope).toContain('mime=image/png');
    expect(envelope).toContain('editable=true');
    expect(envelope).toContain(`edit_handle=${HANDLE}`);
    expect(envelope).toContain('edited_from=img_parent1');
    expect(envelope).toContain('Allowed capabilities on this seat: eve_image_edit.');
    for (const token of ['/Users/', 'file:', 'MEDIA:', 'data:image', 'blobs']) {
      expect(envelope).not.toContain(token);
    }
  });

  it('a record whose handle cannot be minted rides with editable=false and NO handle', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild' },
      deps({ ensureImageEditHandle: () => undefined })
    );
    expect(envelope).toContain('artifact_id=img_generated1');
    expect(envelope).toContain('editable=false');
    expect(envelope).not.toContain('edit_handle=');
    // …and a closed image seat advertises no capability and mints no permit.
    expect(envelope).not.toContain('eve_image_edit');
    expect(envelope).not.toContain('evespend_');
  });

  it('a closed image seat lists the image read-only and mints no image permit', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'bearbeite das bild', requestedEditOperation: 'image_edit' },
      deps({ isImageEditEnabled: () => false })
    );
    expect(envelope).not.toContain('eve_image_edit');
    expect(envelope).not.toContain('evespend_');
  });

  it('the pure builder renders image entries and the permit only alongside an advertised capability', () => {
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
      spendPermit: `evespend_${'7'.repeat(64)}`,
    });
    expect(rendered).toContain('kind=image');
    expect(rendered).toContain(`edit_handle=${HANDLE}`);
    expect(rendered).toContain('evespend_');
    // The content hash travels ONLY in the non-rendered field.
    expect(rendered).not.toContain(IMAGE_SHA);
  });
});
