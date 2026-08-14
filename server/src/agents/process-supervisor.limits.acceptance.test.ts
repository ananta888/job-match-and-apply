import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessSupervisor } from './process-supervisor.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-limit-'));
  temporaryRoots.push(root);
  return root;
}

describe('ProcessSupervisor failure-boundary acceptance', () => {
  it('bounds callback delivery by both stream and total output limits', async () => {
    const cwd = await makeWorkspace();
    const stdoutCallbacks: string[] = [];
    const stderrCallbacks: string[] = [];
    const canary = 'SECRET-PII-CANARY-AFTER-LIMIT';
    const processHandle = new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', `process.stdout.write("o".repeat(4096) + ${JSON.stringify(canary)}); process.stderr.write("e".repeat(4096) + ${JSON.stringify(canary)}); setInterval(() => {}, 1000)`],
      cwd,
      limits: {
        wallTimeMs: 2_000,
        idleTimeMs: 2_000,
        stdoutBytes: 48,
        stderrBytes: 32,
        totalOutputBytes: 64,
        cancelGraceMs: 100,
      },
    }, {
      onStdout: (chunk) => stdoutCallbacks.push(chunk),
      onStderr: (chunk) => stderrCallbacks.push(chunk),
    });

    const result = await processHandle.completion;
    const callbackStdoutBytes = Buffer.byteLength(stdoutCallbacks.join(''));
    const callbackStderrBytes = Buffer.byteLength(stderrCallbacks.join(''));
    const serializedOutput = `${result.stdout}${result.stderr}${stdoutCallbacks.join('')}${stderrCallbacks.join('')}`;

    expect(result.termination).toBe('output_limit');
    expect(callbackStdoutBytes).toBeLessThanOrEqual(48);
    expect(callbackStderrBytes).toBeLessThanOrEqual(32);
    expect(callbackStdoutBytes + callbackStderrBytes).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
    expect(result.stdout).toBe(stdoutCallbacks.join(''));
    expect(result.stderr).toBe(stderrCallbacks.join(''));
    expect(stdoutCallbacks.length + stderrCallbacks.length).toBe(1);
    expect(serializedOutput).not.toContain(canary);
  });

  it('classifies explicit cancel, wall timeout, idle timeout and output limit independently', async () => {
    const cwd = await makeWorkspace();
    const supervisor = new ProcessSupervisor();

    const cancelled = supervisor.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      limits: { wallTimeMs: 5_000, idleTimeMs: 5_000, cancelGraceMs: 100 },
    });
    await cancelled.cancel('acceptance canary');

    const wallTimed = supervisor.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => process.stdout.write("."), 20)'],
      cwd,
      limits: { wallTimeMs: 250, idleTimeMs: 2_000, cancelGraceMs: 100 },
    });
    const idleTimed = supervisor.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      limits: { wallTimeMs: 2_000, idleTimeMs: 250, cancelGraceMs: 100 },
    });
    const outputLimited = supervisor.start({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("o".repeat(32768)); process.stderr.write("e".repeat(32768)); setInterval(() => {}, 1000)'],
      cwd,
      limits: {
        wallTimeMs: 2_000,
        idleTimeMs: 2_000,
        stdoutBytes: 128,
        stderrBytes: 96,
        totalOutputBytes: 160,
        cancelGraceMs: 100,
      },
    });

    const [cancelResult, wallResult, idleResult, outputResult] = await Promise.all([
      cancelled.completion,
      wallTimed.completion,
      idleTimed.completion,
      outputLimited.completion,
    ]);

    expect(cancelResult.termination).toBe('cancelled');
    expect(cancelResult.error).toBe('acceptance canary');
    expect(wallResult.termination).toBe('timeout');
    expect(idleResult.termination).toBe('idle_timeout');
    expect(outputResult.termination).toBe('output_limit');
    expect(Buffer.byteLength(outputResult.stdout)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(outputResult.stderr)).toBeLessThanOrEqual(96);
    expect(outputResult.stdoutTruncated || outputResult.stderrTruncated).toBe(true);
  });

  it('rejects cumulative input beyond its cap without forwarding the overflow', async () => {
    const cwd = await makeWorkspace();
    const processHandle = new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', 'process.stdin.on("data", chunk => process.stdout.write(chunk)); setInterval(() => {}, 1000)'],
      cwd,
      limits: { maxInputBytes: 8, wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 100 },
    });

    await processHandle.writeInput('1234');
    await processHandle.writeInput('5678');
    await expect(processHandle.writeInput('9')).rejects.toThrow('Eingabelimit');
    await processHandle.cancel('input test complete');
    const result = await processHandle.completion;
    expect(result.termination).toBe('cancelled');
    expect(result.stdout).not.toContain('9');
  });
});
