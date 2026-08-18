import { describe, expect, it } from 'vitest';

import {
  parseComposerArtifactFollowupTarget,
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
  it('exposes exact pathless candidates and the native clarify handoff contract', () => {
    const context = renderComposerArtifactFollowupRoutingContext([
      resolveComposerArtifactReference(artifact({ payload: { path: '/private/report.docx', title: 'Secret title' } })),
      resolveComposerArtifactReference(
        artifact({ id: 'artifact-2', kind: 'image', payload: { artifact_type: 'image', title: 'Motiv' } })
      ),
      resolveComposerArtifactReference(artifact({ id: 'artifact-3', payload: { path: '/private/model.xlsx' } })),
    ]);

    expect(context).toContain('candidate=artifact_id:artifact-1;mode:word;latest_for_mode:true');
    expect(context).toContain('candidate=artifact_id:artifact-2;mode:image;latest_for_mode:true');
    expect(context).toContain('candidate=artifact_id:artifact-3;mode:excel;latest_for_mode:true');
    expect(context).toContain('[command_eve:artifact_followup:<mode>][command_eve:artifact_target:<artifact_id>]');
    expect(context).toContain('call clarify once');
    expect(context).toContain('exactly one action choice');
    expect(context).toContain('Never infer a target from keywords');
    expect(context).toContain('use the candidate marked latest_for_mode:true');
    expect(context).toContain('grants no permit or spend authority');
    expect(context).not.toContain('/private/');
    expect(context).not.toContain('Secret title');
  });

  it('keeps chronological order and bounds the set to the newest artifacts', () => {
    const values = Array.from({ length: 20 }, (_, index) => ({
      artifactId: `artifact-${index}`,
      mode: ['excel', 'pdf', 'image', 'presentation', 'word', 'video'][index % 6],
    }));
    const context = renderComposerArtifactFollowupRoutingContext(values);
    const candidates = context.match(/^candidate=\S+$/gm) ?? [];

    expect(candidates).toHaveLength(12);
    // Thirteen of the twenty carry a follow-up mode; the oldest one falls out.
    expect(candidates.at(0)).toBe('candidate=artifact_id:artifact-2;mode:image;latest_for_mode:false');
    expect(candidates.at(-1)).toBe('candidate=artifact_id:artifact-18;mode:excel;latest_for_mode:true');
    expect(context).not.toContain('candidate=artifact_id:artifact-0;');
    expect(context.length).toBeLessThan(5000);
  });

  it('offers a re-emitted artifact once, at its newest position', () => {
    const context = renderComposerArtifactFollowupRoutingContext([
      { artifactId: 'artifact-1', mode: 'image' },
      { artifactId: 'artifact-2', mode: 'video' },
      { artifactId: 'artifact-1', mode: 'word' },
    ]);

    expect(context.match(/^candidate=\S+$/gm)).toEqual([
      'candidate=artifact_id:artifact-2;mode:video;latest_for_mode:true',
      'candidate=artifact_id:artifact-1;mode:word;latest_for_mode:true',
    ]);
  });

  /**
   * A follow-up addresses what was just produced. Filling the bound from the
   * oldest end dropped exactly that artifact once a conversation outgrew the
   * bound, so "make it shorter" on a freshly paid video either failed closed or
   * had only stale clips to bind to.
   */
  it('offers the newest artifact once a conversation exceeds the candidate bound', () => {
    const values = Array.from({ length: 13 }, (_, index) => ({
      artifactId: `artifact-${index}`,
      mode: 'video',
    }));

    const context = renderComposerArtifactFollowupRoutingContext(values);

    expect(context).toContain('candidate=artifact_id:artifact-12;mode:video;latest_for_mode:true');
    expect(context).not.toContain('candidate=artifact_id:artifact-0;');
    expect(context.match(/^candidate=\S+$/gm)).toHaveLength(12);
  });

  it('is absent for empty, malformed and unsupported candidates', () => {
    expect(renderComposerArtifactFollowupRoutingContext([])).toBe('');
    expect(
      renderComposerArtifactFollowupRoutingContext([
        null,
        { artifactId: 'artifact-1', mode: 'audio' },
        { artifactId: '../escape', mode: 'image' },
        { mode: 'video' },
      ])
    ).toBe('');
  });
});

describe('parseComposerArtifactFollowupTarget', () => {
  it('returns the exact opaque target and strips only its internal marker', () => {
    expect(
      parseComposerArtifactFollowupTarget(
        '[command_eve:artifact_target:video-child_1] Soll ich die Aubergine lächeln lassen?'
      )
    ).toEqual({ artifactId: 'video-child_1', question: 'Soll ich die Aubergine lächeln lassen?' });
  });

  it.each([
    'Soll ich es ändern?',
    '[command_eve:artifact_target:../escape] Soll ich es ändern?',
    '[command_eve:artifact_target:artifact-1]',
    `[command_eve:artifact_target:${'a'.repeat(257)}] Frage?`,
  ])('refuses a missing, unsafe, empty or unbounded target marker', (value) => {
    expect(parseComposerArtifactFollowupTarget(value)).toBeNull();
  });
});
