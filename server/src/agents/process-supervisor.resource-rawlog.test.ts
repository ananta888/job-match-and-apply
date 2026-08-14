import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyProcessResourceUsage, ProcessSupervisor, type ResourceProbe } from './process-supervisor.js';

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

  it('fails closed for a missing, throwing, or invalid resource probe', async () => {
    const cwd = await temporaryRoot('supervisor-probe-failure-');
    expect(() => new ProcessSupervisor().start({
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
