import { describe, expect, it } from 'vitest';

import {
  renderComposerArtifactFollowupRoutingContext,
  resolveComposerArtifactReference,
} from '@/common/config/composerArtifactReferenceCore';

const artifact = (overrides: Record<string, unknown> = {}) => ({
  id: 'artifact-1',
  conversation_id: 'conv-1',
  status: 'active',
  kind: 'file',
  payload: { title: 'Ergebnis', path: '/private/result.pdf', mime_type: 'application/pdf' },
  ...overrides,
});

describe('resolveComposerArtifactReference', () => {
  it.each([
    ['image', { kind: 'image', payload: { artifact_type: 'image', title: 'Motiv', managed_image: true } }],
    ['video', { kind: 'video', payload: { artifact_type: 'video', title: 'Clip' } }],
    ['presentation', { payload: { path: '/private/deck.pptx', title: 'Deck' } }],
    ['pdf', { payload: { mime_type: 'application/pdf', title: 'Report' } }],
    ['word', { payload: { path: '/private/report.docx', title: 'Report' } }],
    ['excel', { payload: { path: '/private/model.xlsx', title: 'Model' } }],
  ])('resolves a supported %s without returning a source path', (mode, overrides) => {
    const result = resolveComposerArtifactReference(artifact(overrides));
    expect(result).toMatchObject({ mode, referenceKind: mode, artifactId: 'artifact-1', conversationId: 'conv-1' });
    expect(JSON.stringify(result)).not.toContain('/private/');
  });

  it('marks only pathless managed image records for the direct image-to-video lane', () => {
    expect(
      resolveComposerArtifactReference(
        artifact({ kind: 'image', payload: { artifact_type: 'image', title: 'Motiv', managed_image: true } })
      )?.managedImage
    ).toBe(true);
    expect(
      resolveComposerArtifactReference(artifact({ kind: 'image', payload: { artifact_type: 'image', title: 'Motiv' } }))
        ?.managedImage
    ).toBe(false);
  });

  it.each([
    artifact({ status: 'dismissed' }),
    artifact({ id: '../escape' }),
    artifact({ conversation_id: '' }),
    artifact({ kind: 'audio', payload: { artifact_type: 'audio', title: 'Track' } }),
    artifact({ kind: 'html', payload: { artifact_type: 'html', title: 'Page' } }),
    artifact({ payload: { path: '/private/archive.zip', title: 'Archive' } }),
    artifact({ payload: { path: '/private/legacy.doc', title: 'Legacy Word' } }),
    artifact({ payload: { path: '/private/legacy.xls', title: 'Legacy Excel' } }),
    artifact({ payload: { path: '/private/source.odt', title: 'OpenDocument' } }),
    artifact({ payload: { path: '/private/source.csv', title: 'CSV' } }),
  ])('rejects inactive, malformed and unsupported artifacts', (value) => {
    expect(resolveComposerArtifactReference(value)).toBeNull();
  });

  it('bounds and strips control characters from the display-only title', () => {
    const result = resolveComposerArtifactReference(
      artifact({ payload: { path: '/private/report.pdf', title: `  Report\n${'x'.repeat(200)}  ` } })
    );
    expect(result?.title).not.toContain('\n');
    expect(result?.title.length).toBeLessThanOrEqual(120);
  });
});

describe('renderComposerArtifactFollowupRoutingContext', () => {
  it('exposes only fixed available modes and the native clarify handoff contract', () => {
    const context = renderComposerArtifactFollowupRoutingContext([
      resolveComposerArtifactReference(artifact({ payload: { path: '/private/report.docx', title: 'Secret title' } })),
      resolveComposerArtifactReference(
        artifact({ id: 'artifact-2', kind: 'image', payload: { artifact_type: 'image', title: 'Motiv' } })
      ),
      resolveComposerArtifactReference(artifact({ id: 'artifact-3', payload: { path: '/private/model.xlsx' } })),
    ]);

    expect(context).toContain('available_modes=image,word,excel');
    expect(context).toContain('[command_eve:artifact_followup:<mode>]');
    expect(context).toContain('call clarify once');
    expect(context).toContain('exactly one action choice');
    expect(context).toContain('grants no permit or spend authority');
    expect(context.length).toBeLessThan(600);
    expect(context).not.toContain('artifact-');
    expect(context).not.toContain('/private/');
    expect(context).not.toContain('Secret title');
  });

  it('deduplicates and orders only the four complete follow-up lanes', () => {
    const values = ['excel', 'pdf', 'image', 'presentation', 'word', 'video', 'image'].map((mode) => ({ mode }));
    expect(renderComposerArtifactFollowupRoutingContext(values)).toContain('available_modes=image,video,word,excel');
  });

  it('is absent for empty, malformed and unsupported candidates', () => {
    expect(renderComposerArtifactFollowupRoutingContext([])).toBe('');
    expect(renderComposerArtifactFollowupRoutingContext([null, { mode: 'audio' }, { mode: '../image' }])).toBe('');
  });
});
