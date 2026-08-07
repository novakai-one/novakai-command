// The real PTY, through the same contract the fake one uses.
//
// If this passes, "a real terminal you can type into that no window can kill"
// is a fact about a real process, not about a test double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { b3ok, mintRuntimeEpochId } from '@novakai/foundation/contract';
import { composeTerminal, type RuntimeEpochFence } from '../../contract/index.js';
import { createNodePtyHost } from '../../adapters/pty-host/node-pty.js';
import { humanContext, humanPrincipal, unwrap } from '../harness.js';

async function waitFor(
  predicate: () => boolean, whatFor: string, timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${whatFor}`);
}

test('a real shell echoes what the lease holder types, and outlives its controller', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-real-pty-'));
  const epochId = mintRuntimeEpochId();
  const epochFence: RuntimeEpochFence = {
    activeEpochId: () => epochId,
    assertActive: () => b3ok(epochId),
  };
  const terminal = composeTerminal({ root, ptyHost: await createNodePtyHost(), epochFence });
  try {
    const session = unwrap(await terminal.openManagedTerminal(humanContext(), {
      owner: { kind: 'plain-shell', shellInstanceId: 'shell_real' },
      launchAuthorityRef: 'plain-shell',
      launchFingerprint: 'plain-shell:real',
      workingDirectory: root,
      columns: 80, rows: 24,
    }), 'open real shell');

    const seen: string[] = [];
    const reading = (async () => {
      for await (const item of terminal.readTerminalStream(humanPrincipal(), {
        terminalSessionId: session.id, afterOutputSequence: 0,
      })) {
        if (item.ok && item.value.kind === 'bytes') {
          seen.push(Buffer.from(item.value.base64, 'base64').toString('utf8'));
        }
        if (item.ok && item.value.kind === 'exit') return;
      }
    })();

    const controller = unwrap(await terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 80, rows: 24,
    }), 'attach');
    const lease = unwrap(await terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
      mode: 'acquire-if-free', ttlMs: 60_000,
    }), 'acquire');

    unwrap(await terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text',
      utf8Text: 'echo novakai-lives\r',
    }), 'write');

    await waitFor(() => seen.join('').includes('novakai-lives'), 'the shell to echo');

    // Close the window. The process must still be there afterwards.
    unwrap(await terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
    }), 'detach');
    const view = unwrap(await terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.session.status, 'live');

    const pid = Number.parseInt(view.session.privateProcessRef.replace('pid:', ''), 10);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the real shell died when its window closed');

    // Tidy up through the ONE authorised path.
    const runtimeSelf = {
      principal: { id: 'sys_agent_runtime' as const, kind: 'system' as const, verifiedScopes: [] },
      clientOpId: humanContext().clientOpId,
      traceId: humanContext().traceId,
      contractVersion: 1 as const,
    };
    unwrap(await terminal.terminateTerminal(runtimeSelf, {
      terminalSessionId: session.id, expectedRuntimeEpochId: epochId, reason: 'plain-shell-close',
    }), 'terminate');
    await reading;
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 'the shell to exit after an authorised stop');
  } finally {
    await terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mock managed session runs a real process and answers on the same contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-real-mock-'));
  const epochId = mintRuntimeEpochId();
  const terminal = composeTerminal({
    root,
    ptyHost: await createNodePtyHost(),
    epochFence: { activeEpochId: () => epochId, assertActive: () => b3ok(epochId) },
  });
  try {
    const session = unwrap(await terminal.openManagedTerminal(humanContext(), {
      owner: {
        kind: 'agent-run',
        agentRunId: 'agentRun_00000000-0000-7000-8000-000000000002' as never,
      },
      launchAuthorityRef: 'mock-managed',
      launchFingerprint: 'mock:provider',
      workingDirectory: root,
      columns: 100, rows: 30,
    }), 'open mock managed');

    const seen: string[] = [];
    void (async () => {
      for await (const item of terminal.readTerminalStream(humanPrincipal(), {
        terminalSessionId: session.id, afterOutputSequence: 0,
      })) {
        if (item.ok && item.value.kind === 'bytes') {
          seen.push(Buffer.from(item.value.base64, 'base64').toString('utf8'));
        }
        if (item.ok && item.value.kind === 'exit') return;
      }
    })();

    await waitFor(() => seen.join('').includes('mock managed session ready'), 'the mock to boot');

    const controller = unwrap(await terminal.attachController(humanContext(), {
      terminalSessionId: session.id, controllerKind: 'external-terminal', columns: 100, rows: 30,
    }), 'attach');
    const lease = unwrap(await terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
      mode: 'acquire-if-free', ttlMs: 60_000,
    }), 'acquire');
    unwrap(await terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'hello\r',
    }), 'write');

    await waitFor(() => seen.join('').includes('mock> hello'), 'the mock to answer');

    unwrap(await terminal.detachController(humanContext(), {
      terminalSessionId: session.id, attachmentId: controller.id,
    }), 'detach');
    const view = unwrap(await terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.session.status, 'live', 'the managed session died with its controller');

    unwrap(await terminal.terminateTerminal({
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: humanContext().clientOpId,
      traceId: humanContext().traceId,
      contractVersion: 1,
    }, {
      terminalSessionId: session.id, expectedRuntimeEpochId: epochId, reason: 'stop-one',
    }), 'terminate');
  } finally {
    await terminal.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
