import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyProcessResourceUsage,
  HostProcessTreeResourceProbe,
  ProcessSupervisor,
  summarizeProcessTree,
  type ProcessTableCommandExecutor,
  type ResourceProbe,
} from './process-supervisor.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('ProcessSupervisor optional raw-log rotation', () => {
  it('keeps raw logging disabled by default', async () => {
    const cwd = await temporaryRoot('supervisor-raw-off-');
    const result = await new ProcessSupervisor().start({
      executable: process.execPath, args: ['-e', 'process.stdout.write("not-persisted")'], cwd,
    }).completion;

    expect(result.termination).toBe('exit');
    expect(await readdir(cwd)).toEqual([]);
  });

  it('rotates both streams within exact file-count and byte limits', async () => {
    const cwd = await temporaryRoot('supervisor-raw-cwd-');
    const logRoot = await temporaryRoot('supervisor-raw-root-');
    const result = await new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("0123456789".repeat(4)); process.stderr.write("abcdefghij".repeat(2) + "xyz")'],
      cwd,
      rawLog: { rootDirectory: logRoot, runId: 'rotation-run', maxBytesPerFile: 10, maxFiles: 3 },
    }).completion;

    expect(result.termination).toBe('exit');
    const directory = join(logRoot, 'rotation-run');
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(['stderr.1.log', 'stderr.2.log', 'stderr.log', 'stdout.1.log', 'stdout.2.log', 'stdout.log']);
    for (const file of files) expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(10);
    const ordered = async (stream: 'stdout' | 'stderr'): Promise<string> => [2, 1, 0]
      .map((index) => join(directory, index === 0 ? `${stream}.log` : `${stream}.${index}.log`))
      .reduce(async (content, path) => `${await content}${await readFile(path, 'utf8')}`, Promise.resolve(''));
    expect(await ordered('stdout')).toBe('0123456789'.repeat(3));
    expect(await ordered('stderr')).toBe('abcdefghij'.repeat(2) + 'xyz');
  });

  it('rejects a run-directory symlink without writing outside the validated root', async () => {
    const cwd = await temporaryRoot('supervisor-raw-link-cwd-');
    const logRoot = await temporaryRoot('supervisor-raw-link-root-');
    const outside = await temporaryRoot('supervisor-raw-outside-');
    try { await symlink(outside, join(logRoot, 'linked-run'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    expect(() => new ProcessSupervisor().start({
      executable: process.execPath, args: ['-e', 'process.stdout.write("blocked")'], cwd,
      rawLog: { rootDirectory: logRoot, runId: 'linked-run', maxBytesPerFile: 64, maxFiles: 2 },
    })).toThrow('Symlink');
    expect(await readdir(outside)).toEqual([]);
  });

  it('classifies a post-validation unsafe file replacement as raw_log_error', async () => {
    const cwd = await temporaryRoot('supervisor-raw-race-cwd-');
    const logRoot = await temporaryRoot('supervisor-raw-race-root-');
    const handle = new ProcessSupervisor().start({
      executable: process.execPath, args: ['-e', 'process.stdout.write("blocked"); setInterval(() => {}, 1000)'], cwd,
      limits: { wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 50 },
      rawLog: { rootDirectory: logRoot, runId: 'unsafe-replacement', maxBytesPerFile: 64, maxFiles: 2 },
    }, {
      onStart: () => mkdirSync(join(logRoot, 'unsafe-replacement', 'stdout.log')),
    });

    const result = await handle.completion;
    expect(result.termination).toBe('raw_log_error');
    expect(result.error).toContain('Rohlog-Schreiben fehlgeschlagen');
    expect(result.stdout).toBe('');
  });
});

describe('ProcessSupervisor injected resource boundaries', () => {
  it('aggregates only the supervised process tree from a process-table snapshot', () => {
    expect(summarizeProcessTree(10, [
      { pid: 1, parentPid: 0, residentMemoryBytes: 1_000 },
      { pid: 10, parentPid: 1, residentMemoryBytes: 200 },
      { pid: 11, parentPid: 10, residentMemoryBytes: 300 },
      { pid: 12, parentPid: 11, residentMemoryBytes: 400 },
      { pid: 99, parentPid: 1, residentMemoryBytes: 99_000 },
    ])).toEqual({ residentMemoryBytes: 900, childProcessCount: 2 });
  });

  it('uses fixed platform commands and normalizes Windows and POSIX RSS units', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const windowsExecutor: ProcessTableCommandExecutor = { async run(executable, args) {
      calls.push({ executable, args });
      return { exitCode: 0, stdout: JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: '200' },
        { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: 300 },
      ]), stderr: '' };
    } };
    await expect(new HostProcessTreeResourceProbe('win32', windowsExecutor).sample(10))
      .resolves.toEqual({ residentMemoryBytes: 500, childProcessCount: 1 });
    expect(calls[0]?.executable).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/i);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']));
    expect(calls[0]?.args.at(-1)).toContain('SELECT ProcessId,ParentProcessId,WorkingSetSize FROM Win32_Process');

    const posixExecutor: ProcessTableCommandExecutor = { async run(executable, args) {
      calls.push({ executable, args });
      return { exitCode: 0, stdout: '10 1 2\n11 10 3\n', stderr: '' };
    } };
    await expect(new HostProcessTreeResourceProbe('linux', posixExecutor).sample(10))
      .resolves.toEqual({ residentMemoryBytes: 5 * 1024, childProcessCount: 1 });
    expect(calls[1]).toEqual({ executable: '/usr/bin/ps', args: ['-axo', 'pid=,ppid=,rss='] });
  });

  it('fails closed for malformed tables, unsupported hosts, and a missing root process', async () => {
    const malformed: ProcessTableCommandExecutor = { async run() { return { exitCode: 0, stdout: 'not-json', stderr: '' }; } };
    await expect(new HostProcessTreeResourceProbe('win32', malformed).sample(10)).rejects.toThrow();
    const missing: ProcessTableCommandExecutor = { async run() { return { exitCode: 0, stdout: '11 1 3\n', stderr: '' }; } };
    await expect(new HostProcessTreeResourceProbe('linux', missing).sample(10)).rejects.toThrow('Root-Prozess fehlt');
    await expect(new HostProcessTreeResourceProbe('aix', missing).sample(10)).rejects.toThrow('nicht unterstuetzt');
  });

  it('classifies exact and exceeded memory/child boundaries deterministically', () => {
    expect(classifyProcessResourceUsage(
      { residentMemoryBytes: 100, childProcessCount: 1 },
      { maxResidentMemoryBytes: 100, maxChildProcesses: 1 },
    )).toBeUndefined();
    expect(classifyProcessResourceUsage(
      { residentMemoryBytes: 101, childProcessCount: 1 },
      { maxResidentMemoryBytes: 100, maxChildProcesses: 1 },
    )).toBe('memory_limit');
    expect(classifyProcessResourceUsage(
      { residentMemoryBytes: 100, childProcessCount: 2 },
      { maxResidentMemoryBytes: 100, maxChildProcesses: 1 },
    )).toBe('child_process_limit');
  });

  it('terminates on an over-limit sample from the injected probe', async () => {
    const probe: ResourceProbe = {
      async sample() {
        return { residentMemoryBytes: 101, childProcessCount: 0 };
      },
    };
    const cwd = await temporaryRoot('supervisor-memory-');
    const result = await new ProcessSupervisor(probe).start({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
      limits: {
        maxResidentMemoryBytes: 100, resourceProbeIntervalMs: 10,
        wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 50,
      },
    }).completion;

    expect(result.termination).toBe('memory_limit');
    expect(result.lastResourceUsage).toEqual({ residentMemoryBytes: 101, childProcessCount: 0 });
  });

  it('retries one Windows root-visibility lag and then enforces the measured limit', async () => {
    let rootPid = 0;
    let samples = 0;
    const resourceExecutor: ProcessTableCommandExecutor = { async run() {
      samples += 1;
      return { exitCode: 0, stdout: JSON.stringify(samples === 1
        ? [{ ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 1 }]
        : [{ ProcessId: rootPid, ParentProcessId: 1, WorkingSetSize: 101 }]), stderr: '' };
    } };
    const cleanupExecutor: ProcessTableCommandExecutor = { async run(_executable, _args, timeoutMs) {
      expect(timeoutMs).toBe(2_000);
      return { exitCode: 0, stdout: JSON.stringify([
        { ProcessId: rootPid, ParentProcessId: 1, WorkingSetSize: 101 },
      ]), stderr: '' };
    } };
    const cwd = await temporaryRoot('supervisor-visibility-lag-');
    const result = await new ProcessSupervisor(
      new HostProcessTreeResourceProbe('win32', resourceExecutor),
      cleanupExecutor,
    ).start({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
      limits: {
        maxResidentMemoryBytes: 100, resourceProbeIntervalMs: 10,
        wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 50,
      },
    }, { onStart: (pid) => { rootPid = pid; } }).completion;

    expect(samples).toBe(2);
    expect(result.termination).toBe('memory_limit');
    expect(result.lastResourceUsage).toEqual({ residentMemoryBytes: 101, childProcessCount: 0 });
  });

  it('fails closed when the supervised root is still absent on the retry', async () => {
    let rootPid = 0;
    let samples = 0;
    const missingRootExecutor: ProcessTableCommandExecutor = { async run() {
      samples += 1;
      return { exitCode: 0, stdout: JSON.stringify([
        { ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 1 },
      ]), stderr: '' };
    } };
    const cleanupExecutor: ProcessTableCommandExecutor = { async run() {
      return { exitCode: 0, stdout: JSON.stringify([
        { ProcessId: rootPid, ParentProcessId: 1, WorkingSetSize: 1 },
      ]), stderr: '' };
    } };
    const cwd = await temporaryRoot('supervisor-visibility-closed-');
    const result = await new ProcessSupervisor(
      new HostProcessTreeResourceProbe('win32', missingRootExecutor),
      cleanupExecutor,
    ).start({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
      limits: {
        maxResidentMemoryBytes: 100, resourceProbeIntervalMs: 10,
        wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 50,
      },
    }, { onStart: (pid) => { rootPid = pid; } }).completion;

    expect(samples).toBe(2);
    expect(result.termination).toBe('resource_probe_error');
    expect(result.error).toContain('Root-Prozess fehlt');
  });

  it.runIf(['win32', 'linux', 'darwin'].includes(process.platform))('enforces a real host process-table sample', async () => {
    const cwd = await temporaryRoot('supervisor-host-probe-');
    const result = await new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd,
      limits: {
        maxResidentMemoryBytes: 1,
        maxChildProcesses: 16,
        resourceProbeIntervalMs: 100,
        wallTimeMs: 15_000,
        idleTimeMs: 15_000,
        cancelGraceMs: 100,
      },
    }).completion;

    expect(result.termination).toBe('memory_limit');
    expect(result.lastResourceUsage?.residentMemoryBytes).toBeGreaterThan(1);
  }, 20_000);

  it.runIf(['win32', 'linux', 'darwin'].includes(process.platform))('detects and cleans up a real descendant over the child-process ceiling', async () => {
    const cwd = await temporaryRoot('supervisor-host-child-probe-');
    let descendantPidText = '';
    const result = await new ProcessSupervisor().start({
      executable: process.execPath,
      args: ['-e', [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'process.stdout.write(String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('')],
      cwd,
      limits: {
        maxResidentMemoryBytes: 1024 * 1024 * 1024,
        maxChildProcesses: 0,
        resourceProbeIntervalMs: 100,
        wallTimeMs: 15_000,
        idleTimeMs: 15_000,
        cancelGraceMs: 100,
      },
    }, { onStdout: (chunk) => { descendantPidText += chunk; } }).completion;

    expect(result.termination).toBe('child_process_limit');
    expect(result.lastResourceUsage?.childProcessCount).toBeGreaterThan(0);
    const descendantPid = Number(descendantPidText);
    expect(descendantPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  }, 20_000);

  it('fails closed for a missing, throwing, or invalid resource probe', async () => {
    const cwd = await temporaryRoot('supervisor-probe-failure-');
    expect(() => new ProcessSupervisor(null).start({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
      limits: { maxResidentMemoryBytes: 100 },
    })).toThrow('ResourceProbe');

    const probe: ResourceProbe = { async sample(): Promise<never> { throw new Error('synthetic probe failure'); } };
    const result = await new ProcessSupervisor(probe).start({
      executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd,
      limits: {
        maxResidentMemoryBytes: 100, resourceProbeIntervalMs: 10,
        wallTimeMs: 2_000, idleTimeMs: 2_000, cancelGraceMs: 50,
      },
    }).completion;
    expect(result.termination).toBe('resource_probe_error');
  });
});
