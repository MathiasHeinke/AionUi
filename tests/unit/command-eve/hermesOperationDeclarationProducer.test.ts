/**
 * MAT-1749 — the PRODUCER side of the paid-seam allowlist.
 *
 * The shim now refuses any request that does not declare a registered operation.
 * That is only safe because the user's own chat turn DOES declare one. If the
 * declaration below is ever dropped, the shim stops being a money guard and starts
 * being an outage: every Standard/MAX turn would 403. So the producer is pinned
 * here, next to the consumer it must agree with.
 *
 * WHAT KIND OF EVIDENCE THIS IS — say it plainly. These are STRUCTURAL pins on
 * rendered Python. `runtimeBootstrapCore` emits a `sitecustomize`-style provider
 * override that runs inside the bundled Hermes interpreter, which vitest cannot
 * execute. So this asserts the emitted TEXT, not its runtime behaviour. It cannot
 * prove the patch works against a live Hermes; it can only prove the declaration
 * was not deleted or renamed out from under the registry. The repo already uses
 * this technique for the permission-authority patch, for the same reason.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { commandEveRegisteredOperations } from '@/process/commandEve/paidOperationRegistryCore';

const bootstrapSource = fs.readFileSync(
  fileURLToPath(new URL('../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts', import.meta.url)),
  'utf8'
);

describe('MAT-1749 producer — the user own chat turn declares itself', () => {
  it('stamps user_chat_turn on the MAIN agent client, gated on the loopback shim', () => {
    // build_api_kwargs_extras is reached only from ChatCompletionsTransport, i.e.
    // the main agent client. Hermes auxiliaries never pass through it — which is
    // exactly why the declaration lives here and not in a shared header.
    expect(bootstrapSource).toContain('extra_body["eve_operation"] = "user_chat_turn"');
    // It must stay behind the loopback host gate: the declaration is meaningful
    // only for our own shim and must never be stamped onto a foreign endpoint.
    const declarationIndex = bootstrapSource.indexOf('extra_body["eve_operation"] = "user_chat_turn"');
    const gateIndex = bootstrapSource.lastIndexOf(
      'if request_host in {"127.0.0.1", "localhost", "::1"}:',
      declarationIndex
    );
    expect(gateIndex, 'the user_chat_turn declaration escaped its loopback gate').toBeGreaterThan(-1);
  });

  it('keeps the existing session_id behaviour intact beside the new declaration', () => {
    expect(bootstrapSource).toContain('extra_body["session_id"] = session_id[:256]');
  });
});

describe('MAT-1749 producer — every auxiliary declares what it is calling for', () => {
  it('installs the declaration patch on the auxiliary chokepoint', () => {
    expect(bootstrapSource).toContain('def _install_command_eve_operation_declaration_patch() -> None:');
    expect(bootstrapSource).toContain('merged["eve_operation"] = operation');
    // Both the sync and async auxiliary entry points.
    expect(bootstrapSource).toContain('(auxiliary_client, "call_llm"), (auxiliary_client, "async_call_llm")');
  });

  it('patches title_generator OWN module-level binding — the double-debit call site', () => {
    // title_generator does `from agent.auxiliary_client import call_llm` at module
    // level, so it holds its own reference and would never see a patch applied to
    // the auxiliary_client module attribute. Missing this line is the whole bug.
    expect(bootstrapSource).toContain('title_generator.call_llm = _command_eve_declare(_original_title)');
  });

  it('runs the installer both at import time and on every model call', () => {
    // Module level, so a context that never builds a model call is still patched.
    expect(bootstrapSource).toContain("'_install_command_eve_operation_declaration_patch()',");
    // And inside build_api_kwargs_extras, so a late import cannot slip past it.
    expect(bootstrapSource).toContain("'        _install_command_eve_operation_declaration_patch()',");
  });

  it('declares the bounded compaction call, which posts to the shim directly', () => {
    expect(bootstrapSource).toContain('"eve_operation": "context_compression",');
  });

  it('gives a task-LESS auxiliary a generic name instead of letting it arrive absent', () => {
    // FACT(whl agent/plugin_llm.py:949-950) passes task=None and FACT(whl
    // trajectory_compressor.py:649-655) omits it entirely. Absent is REFUSED, so
    // without this fallback those two real paths would break — and "absent" would
    // stop meaning the only thing it should mean: the user's own turn lost its
    // producer.
    expect(bootstrapSource).toContain('str(task or "").strip().lower() or "eve_auxiliary"');
    expect(
      commandEveRegisteredOperations(),
      'the producer emits eve_auxiliary but the registry does not know it'
    ).toContain('eve_auxiliary');
  });
});

describe('MAT-1749 — producer and registry may not drift apart', () => {
  it('every operation the producer hard-codes is one the registry knows', () => {
    // The two sides are edited in different files by different people. A name that
    // exists on one side only is silently either an outage (a turn that cannot
    // declare) or a leak (a declaration nobody registered).
    const producerDeclared = [...bootstrapSource.matchAll(/"eve_operation":\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const assignmentDeclared = [...bootstrapSource.matchAll(/extra_body\["eve_operation"\]\s*=\s*"([a-z_]+)"/g)].map(
      (m) => m[1]
    );

    const declared = [...new Set([...producerDeclared, ...assignmentDeclared])].toSorted();
    expect(declared, 'the producer stopped declaring the operations this fix depends on').toEqual([
      'context_compression',
      'user_chat_turn',
    ]);

    const registered = commandEveRegisteredOperations();
    for (const operation of declared) {
      expect(registered, `producer declares "${operation}" but the registry does not list it`).toContain(operation);
    }
  });
});
