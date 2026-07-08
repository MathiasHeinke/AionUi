/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildSkillCandidateCards,
  decideSkillLoopTransition,
  scanSkillCandidateGuard,
  type EveSkillLibraryCandidate,
} from '@/process/commandEve/skillScoutLoopCore';

const LOCAL_BROWSER_SKILL: EveSkillLibraryCandidate = {
  id: 'browser-research',
  name: 'Browser Research',
  description: 'Researches public pages with receipts.',
  source: 'local-skill-library',
  sourceTrust: 'trusted_local',
  capabilities: ['browser_research', 'web_summary'],
  requiredToolsets: ['browser'],
  risk: 'high',
  markdown: '# Browser Research\nUse browser receipts.',
};

describe('Command EVE skill scout loop core', () => {
  it('builds candidate cards for a missing capability without making them active', () => {
    const cards = buildSkillCandidateCards({
      missingCapability: 'browser_research',
      library: [LOCAL_BROWSER_SKILL],
    });

    expect(cards).toEqual([
      expect.objectContaining({
        id: 'browser-research',
        state: 'candidate',
        missingCapability: 'browser_research',
        requiredToolsets: ['browser'],
        risk: 'high',
        canStage: true,
        reasonCode: 'skill.candidate.review-required',
        humanGate: 'HG-2.5',
      }),
    ]);
  });

  it('does not allow untrusted remote candidates to be staged automatically', () => {
    const cards = buildSkillCandidateCards({
      missingCapability: 'lead_capture',
      library: [
        {
          id: 'lead-capture',
          name: 'Lead Capture',
          source: 'https://example.test/skills',
          sourceTrust: 'untrusted_remote',
          capabilities: ['lead_capture'],
          requiredToolsets: ['browser'],
          risk: 'medium',
        },
      ],
    });

    expect(cards[0]).toMatchObject({
      canStage: false,
      reasonCode: 'skill.candidate.untrusted-source',
      guard: { status: 'review', reasonCode: 'skill.guard.high-risk-toolset' },
    });
  });

  it('fails the guard when candidate markdown contains secret-like content', () => {
    expect(
      scanSkillCandidateGuard({
        id: 'bad',
        name: 'Bad',
        source: 'model-output',
        sourceTrust: 'model_generated',
        capabilities: ['vision'],
        requiredToolsets: ['vision'],
        markdown: 'api_key = sk-proj-secretsecretsecret',
      })
    ).toEqual({
      status: 'fail',
      reasonCode: 'skill.guard.secret-like-content',
      humanGate: 'HG-3',
      findings: ['secret-like-content'],
    });
  });

  it('requires human or CAO approval before staging and approving a skill', () => {
    expect(
      decideSkillLoopTransition({
        currentState: 'candidate',
        action: 'stage',
        guardStatus: 'review',
        sourceTrust: 'trusted_local',
        requestedBy: 'model',
        profileScope: 'current_profile',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'skill.transition.human-required',
      humanGate: 'HG-2',
    });

    expect(
      decideSkillLoopTransition({
        currentState: 'candidate',
        action: 'stage',
        guardStatus: 'review',
        sourceTrust: 'trusted_local',
        requestedBy: 'human',
        profileScope: 'current_profile',
      })
    ).toMatchObject({
      ok: true,
      to: 'staged',
    });

    expect(
      decideSkillLoopTransition({
        currentState: 'staged',
        action: 'approve',
        guardStatus: 'review',
        sourceTrust: 'trusted_local',
        requestedBy: 'cao',
        profileScope: 'current_profile',
        caoApproved: true,
      })
    ).toMatchObject({
      ok: true,
      to: 'approved',
    });
  });

  it('blocks model-direct activation and cross-profile persistence', () => {
    expect(
      decideSkillLoopTransition({
        currentState: 'approved',
        action: 'activate',
        guardStatus: 'pass',
        sourceTrust: 'trusted_local',
        requestedBy: 'model',
        profileScope: 'current_profile',
        humanApproved: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'skill.transition.model-active-write-blocked',
      humanGate: 'HG-2',
    });

    expect(
      decideSkillLoopTransition({
        currentState: 'approved',
        action: 'activate',
        guardStatus: 'pass',
        sourceTrust: 'trusted_local',
        requestedBy: 'human',
        profileScope: 'cross_profile',
        humanApproved: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'skill.transition.cross-profile-blocked',
      humanGate: 'HG-3',
    });
  });

  it('activates only approved current-profile skills with explicit approval', () => {
    expect(
      decideSkillLoopTransition({
        currentState: 'approved',
        action: 'activate',
        guardStatus: 'pass',
        sourceTrust: 'trusted_local',
        requestedBy: 'human',
        profileScope: 'current_profile',
        humanApproved: true,
      })
    ).toEqual({
      ok: true,
      from: 'approved',
      to: 'active',
      reasonCode: 'skill.transition.pass',
      humanGate: 'HG-0',
    });
  });
});
