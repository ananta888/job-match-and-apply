import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessSupervisor } from './process-supervisor.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'supervisor-')); roots.push(value); return value; }

describe('ProcessSupervisor', () => {
  it('spawns without a shell and preserves arguments literally', async () => {
    const cwd = await root();
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.start({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', '$(not-a-command); & literal'],
      cwd
    }).completion;
    expect(result.termination).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBe('$(not-a-command); & literal');
  });

  it('streams output and closes stdin safely', async () => {
    const cwd = await root();
    const stdout = vi.fn();
    const processHandle = new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d));'], cwd,
      limits: { idleTimeMs: 5_000 }
    }, { onStdout: stdout });
    await processHandle.writeInput('hello', true);
    const result = await processHandle.completion;
    expect(result.stdout).toBe('hello');
    expect(stdout).toHaveBeenCalled();
  });

  it('terminates on walltime and output limits', async () => {
    const cwd = await root();
    const timed = await new ProcessSupervisor().start({
      executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd,
      limits: { wallTimeMs: 100, idleTimeMs: 5_000, cancelGraceMs: 50 }
    }).completion;
    expect(timed.termination).toBe('timeout');

    const noisy = await new ProcessSupervisor().start({
      executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000))'], cwd,
      limits: { stdoutBytes: 32, totalOutputBytes: 64, cancelGraceMs: 50 }
    }).completion;
    expect(noisy.termination).toBe('output_limit');
    expect(Buffer.byteLength(noisy.stdout)).toBeLessThanOrEqual(32);
    expect(noisy.stdoutTruncated).toBe(true);
  });

  it('supports explicit cancellation and rejects unsafe Windows wrappers', async () => {
    const cwd = await root();
    const handle = new ProcessSupervisor().start({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd });
    await handle.cancel('test cancel');
    expect((await handle.completion).termination).toBe('cancelled');
    if (process.platform === 'win32') {
      expect(() => new ProcessSupervisor().start({ executable: 'unsafe.cmd', args: [], cwd })).toThrow('CMD-/BAT');
    }
  });

  it.skipIf(process.platform === 'win32')('kills a stubborn descendant process when the direct child exits on cancellation', async () => {
    const cwd = await root();
    let pidText = '';
    const handle = new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', [
        'const {spawn}=require("node:child_process");',
        'const child=spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});',
        'process.stdout.write(String(child.pid));',
        'process.on("SIGTERM",()=>process.exit(0));',
        'setInterval(()=>{},1000);'
      ].join('')],
      cwd,
      limits: { wallTimeMs: 5_000, idleTimeMs: 5_000, cancelGraceMs: 75 }
    }, { onStdout: (chunk) => { pidText += chunk; } });
    const until = Date.now() + 2_000;
    while (!/^\d+$/.test(pidText) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const descendantPid = Number(pidText);
    expect(descendantPid).toBeGreaterThan(0);
    await handle.cancel('descendant cleanup test');
    expect((await handle.completion).termination).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });
});
