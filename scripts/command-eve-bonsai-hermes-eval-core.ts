export type HermesWorkflowEvidence = Readonly<{
  processExitCode: number | null;
  timedOut: boolean;
  mcpCallCount: number;
  mcpCaseId?: string;
  expectedCaseId: string;
  terminalProof?: string;
  expectedTerminalProof: string;
  digest?: string;
  expectedDigest: string;
  artifact?: Record<string, unknown>;
  finalResponse: string;
  expected: {
    mcpToken: string;
    priority: string;
    amountEur: number;
    recommendedAction: string;
  };
}>;

export type HermesWorkflowScore = Readonly<{
  score: number;
  maxScore: number;
  scoreRatio: number;
  hardPass: boolean;
  gates: {
    process: boolean;
    mcp: boolean;
    terminal: boolean;
    artifact: boolean;
    output: boolean;
  };
  reasons: string[];
}>;

function normalizedLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function artifactMatches(evidence: HermesWorkflowEvidence): boolean {
  const artifact = evidence.artifact;
  return Boolean(
    artifact &&
    artifact.case_id === evidence.expectedCaseId &&
    artifact.mcp_token === evidence.expected.mcpToken &&
    artifact.sha256 === evidence.expectedDigest &&
    artifact.terminal_nonce === evidence.expectedTerminalProof &&
    artifact.priority === evidence.expected.priority &&
    artifact.amount_eur === evidence.expected.amountEur &&
    artifact.recommended_action === evidence.expected.recommendedAction
  );
}

function outputMatches(evidence: HermesWorkflowEvidence): boolean {
  const lines = normalizedLines(evidence.finalResponse);
  if (lines.length !== 5 || lines[0] !== 'EVE_HERMES_OK') return false;
  if (lines[1] !== `Fall: ${evidence.expectedCaseId}`) return false;
  if (lines[2] !== `Prioritaet: ${evidence.expected.priority}`) return false;
  if (lines[3] !== `Betrag: ${evidence.expected.amountEur} EUR`) return false;
  return lines[4] === `Empfehlung: ${evidence.expected.recommendedAction}`;
}

export function scoreHermesWorkflow(evidence: HermesWorkflowEvidence): HermesWorkflowScore {
  const process = evidence.processExitCode === 0 && !evidence.timedOut;
  const mcp = evidence.mcpCallCount === 1 && evidence.mcpCaseId === evidence.expectedCaseId;
  const terminal =
    evidence.terminalProof === evidence.expectedTerminalProof && evidence.digest === evidence.expectedDigest;
  const artifact = artifactMatches(evidence);
  const output = outputMatches(evidence);
  const gates = { process, mcp, terminal, artifact, output };
  const reasons = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => `${gate}_gate_failed`);
  const score = Object.values(gates).filter(Boolean).length * 2;
  return {
    score,
    maxScore: 10,
    scoreRatio: score / 10,
    hardPass: reasons.length === 0,
    gates,
    reasons,
  };
}
