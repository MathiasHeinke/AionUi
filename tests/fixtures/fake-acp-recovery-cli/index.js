#!/usr/bin/env node
/**
 * Stateful ACP fixture for accepted-turn recovery E2E coverage.
 *
 * Custom-agent registration probes initialize + session/new only. Real prompt
 * attempts increment a spec-owned counter so the first logical turn can fail
 * across AionCore process eviction/replay and a later manual turn can recover.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const JSONRPC_VERSION = '2.0';
const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_SENTINEL';
const SUCCESS_RESPONSE = 'Synthetic recovery reply after manual retry.';
const stateFile = process.env.E2E_ACP_STATE_FILE;

if (!stateFile || !path.isAbsolute(stateFile)) {
  process.stderr.write('E2E_ACP_STATE_FILE must be an absolute path.\n');
  process.exit(2);
}

let sessionCounter = 0;

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })}\n`);
}

function sendError(id) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: { details: PRIVATE_SENTINEL },
      },
    })}\n`
  );
}

function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`);
}

function readPromptCount() {
  try {
    const value = Number.parseInt(fs.readFileSync(stateFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function incrementPromptCount() {
  const next = readPromptCount() + 1;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${next}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, stateFile);
  return next;
}

function handleRequest(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: 1,
        serverCapabilities: {
          streaming: true,
          sessionManagement: true,
        },
        serverInfo: {
          name: 'fake-acp-recovery-cli',
          version: '1.0.0',
        },
      });
      break;

    case 'session/new':
      sessionCounter += 1;
      sendResponse(id, {
        sessionId: `fake-recovery-session-${sessionCounter}`,
        modes: [],
        configOptions: [],
        models: {
          currentModelId: 'fake-recovery-model',
          availableModels: [{ id: 'fake-recovery-model', name: 'Fake Recovery Model' }],
        },
      });
      break;

    case 'session/prompt': {
      const promptCount = incrementPromptCount();
      if (promptCount <= 2) {
        sendError(id);
        break;
      }

      const sessionId = params?.sessionId || 'unknown';
      const chunks = [SUCCESS_RESPONSE.slice(0, 18), SUCCESS_RESPONSE.slice(18)];
      for (const chunk of chunks) {
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: chunk },
          },
        });
      }
      sendResponse(id, {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 3,
          outputTokens: 8,
          totalTokens: 11,
        },
      });
      break;
    }

    case 'session/cancel':
      break;

    case 'session/set_mode':
    case 'session/set_model':
    case 'session/set_config_option':
      sendResponse(id, {});
      break;

    default:
      if (id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: JSONRPC_VERSION,
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          })}\n`
        );
      }
  }
}

const stdin = readline.createInterface({ input: process.stdin, terminal: false });
stdin.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    handleRequest(JSON.parse(trimmed));
  } catch (error) {
    process.stderr.write(`Fixture request failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});

process.stdin.resume();
