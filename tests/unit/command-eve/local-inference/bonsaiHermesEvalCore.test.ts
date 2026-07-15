import { describe, expect, it } from 'vitest';

import {
  scoreHermesWorkflow,
  type HermesWorkflowEvidence,
} from '../../../../scripts/command-eve-bonsai-hermes-eval-core';

function evidence(overrides: Partial<HermesWorkflowEvidence> = {}): HermesWorkflowEvidence {
  return {
    processExitCode: 0,
    timedOut: false,
    mcpCallCount: 1,
    mcpCaseId: 'EVE-1234',
    expectedCaseId: 'EVE-1234',
    terminalProof: 'terminal-nonce',
    expectedTerminalProof: 'terminal-nonce',
    digest: 'digest',
    expectedDigest: 'digest',
    artifact: {
      case_id: 'EVE-1234',
      mcp_token: 'mcp-token',
      sha256: 'digest',
      terminal_nonce: 'terminal-nonce',
      priority: 'hoch',
      amount_eur: 1250,
      recommended_action: 'Angebot pruefen und bis 16 Uhr antworten.',
    },
    finalResponse:
      'EVE_HERMES_OK\nFall: EVE-1234\nPrioritaet: hoch\nBetrag: 1250 EUR\nEmpfehlung: Angebot pruefen und bis 16 Uhr antworten.',
    expected: {
      mcpToken: 'mcp-token',
      priority: 'hoch',
      amountEur: 1250,
      recommendedAction: 'Angebot pruefen und bis 16 Uhr antworten.',
    },
    ...overrides,
  };
}

describe('Bonsai Hermes eval core', () => {
  it('requires successful MCP, terminal, artifact, output, and process gates', () => {
    expect(scoreHermesWorkflow(evidence())).toMatchObject({ score: 10, hardPass: true, reasons: [] });
  });

  it('fails when the model answers without calling the MCP server', () => {
    const score = scoreHermesWorkflow(evidence({ mcpCallCount: 0, mcpCaseId: undefined }));
    expect(score.hardPass).toBe(false);
    expect(score.reasons).toContain('mcp_gate_failed');
  });

  it('fails when a plausible artifact does not contain the hidden terminal proof', () => {
    const score = scoreHermesWorkflow(
      evidence({
        artifact: {
          ...evidence().artifact,
          terminal_nonce: 'guessed',
        },
      })
    );
    expect(score.hardPass).toBe(false);
    expect(score.reasons).toContain('artifact_gate_failed');
  });

  it('fails output that is factually correct but violates the exact five-line contract', () => {
    const score = scoreHermesWorkflow(evidence({ finalResponse: `${evidence().finalResponse}\nErledigt.` }));
    expect(score.hardPass).toBe(false);
    expect(score.reasons).toContain('output_gate_failed');
  });
});
