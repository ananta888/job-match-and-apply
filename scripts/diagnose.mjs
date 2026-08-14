import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseJobSearchMcpLaunch, validateJobSearchMcpRuntime } from '../server/src/services/job-search-mcp-launch.mjs';

const root = resolve(import.meta.dirname, '..');
const checks = [];
const command = (id, executable, args, options = {}, required = true) => {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
  const output = result.status === 0 ? result.stdout : result.stderr || result.stdout || result.error?.message || '';
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  const check = { id, ok: result.status === 0, required, detail: lines.join(' | ') || 'nicht gefunden' };
  checks.push(check);
  return check;
};
command('node', process.execPath, ['--version']);
const configuredPython = command('python', process.env.PYTHON_EXECUTABLE || 'python', ['--version'], {}, false);
const version = configuredPython.detail.match(/Python (\d+)\.(\d+)/);
if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 12)) {
  const native312 = command('python-3.12', 'python3.12', ['--version'], {}, false);
  if (!native312.ok && process.platform === 'win32') command('wsl2-python-3.12', 'wsl.exe', ['-d', 'Ubuntu', '--', 'python3.12', '--version']);
} else configuredPython.required = true;
command('git-submodules', 'git', ['submodule', 'status']);
for (const provider of ['codex', 'opencode', 'claude']) {
  const executable = process.platform === 'win32' && provider === 'codex' ? 'codex.exe' : provider;
  command(`agent-provider-${provider}`, executable, ['--version'], {}, false);
}
if (process.platform === 'win32') {
  for (const provider of ['codex', 'opencode', 'claude']) {
    command(`wsl-agent-provider-${provider}`, 'wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', `command -v ${provider} >/dev/null && ${provider} --version | head -n 1`], {}, false);
  }
}
for (const [id, path] of [
  ['job-search-contract', 'integrations/job-search-mcp/src/job_search_mcp/interfaces/mcp_server.py'],
  ['application-contract', 'integrations/bewerbungs-schreib-assistent/scripts/pipeline_contract.py'],
  ['candidate-profile', '.local-data/profiles/candidate-profile.yaml'],
  ['style-profile', '.local-data/profiles/style-profile.yaml']
]) checks.push({ id, ok: existsSync(resolve(root, path)), required: !id.endsWith('-profile'), detail: path });

const nativeMcpExecutable = resolve(root, 'integrations/job-search-mcp/.venv/Scripts/job-search-mcp.exe');
const nativeMcpReady = existsSync(nativeMcpExecutable);
checks.push({
  id: 'job-search-mcp-native-runtime', ok: nativeMcpReady, required: false,
  detail: nativeMcpReady ? nativeMcpExecutable : 'Keine native Python-3.12-Venv; npm run setup:integrations kann alternativ WSL2 verwenden.'
});
let wslMcpReady = false;
let wslMcpDetail = 'Nur auf Windows mit WSL2 relevant.';
if (process.platform === 'win32') {
  const distribution = process.env.JOB_MCP_WSL_DISTRIBUTION || 'Ubuntu';
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distribution)) {
    const windowsMcpRoot = resolve(root, 'integrations/job-search-mcp').replace(/\\/g, '\\\\');
    const mapped = spawnSync('wsl.exe', ['-d', distribution, '--', 'wslpath', '-a', '-u', windowsMcpRoot], { cwd: root, encoding: 'utf8', windowsHide: true });
    const wslRoot = mapped.status === 0 ? mapped.stdout.trim() : '';
    if (wslRoot.startsWith('/')) {
      const executable = `${wslRoot}/.venv-wsl/bin/job-search-mcp`;
      const probe = spawnSync('wsl.exe', ['-d', distribution, '--', 'test', '-x', executable], { cwd: root, encoding: 'utf8', windowsHide: true });
      wslMcpReady = probe.status === 0;
      wslMcpDetail = wslMcpReady ? `${distribution}:${executable}` : `${distribution}:${executable} wurde noch nicht installiert.`;
    } else wslMcpDetail = `WSL-Pfadabbildung fuer ${distribution} ist fehlgeschlagen.`;
  } else wslMcpDetail = 'JOB_MCP_WSL_DISTRIBUTION ist ungueltig.';
}
checks.push({ id: 'job-search-mcp-wsl-runtime', ok: wslMcpReady, required: false, detail: wslMcpDetail });

let configuredMcpMode = 'demo';
const localConfigPath = resolve(root, '.local-data/config.json');
if (existsSync(localConfigPath)) {
  try {
    const parsed = JSON.parse(readFileSync(localConfigPath, 'utf8'));
    configuredMcpMode = String(parsed?.config?.mcp?.mode ?? parsed?.mcp?.mode ?? 'demo');
  } catch { configuredMcpMode = 'invalid'; }
}
const mcpLaunchSpecPath = resolve(root, '.local-data/job-search-mcp-launch.json');
let trustedHostLaunch = false;
let trustedHostDetail = 'Noch kein privater MCP-Startvertrag; setup:integrations erzeugt ihn.';
if (existsSync(mcpLaunchSpecPath)) {
  try {
    const launch = parseJobSearchMcpLaunch(JSON.parse(readFileSync(mcpLaunchSpecPath, 'utf8')));
    const runtime = await validateJobSearchMcpRuntime(launch, { projectRoot: root });
    trustedHostLaunch = runtime.ready;
    trustedHostDetail = `Direkter ${runtime.runtimeTarget === 'wsl' ? `WSL-${runtime.distribution}-` : 'nativer '}stdio-Start als trusted-host; Realpfad liegt in der Integration-Venv, keine Agenten-Sandbox.`;
  } catch (error) {
    trustedHostDetail = `Privater MCP-Startvertrag oder Runtimepfad ist ungueltig: ${error instanceof Error ? error.message : String(error)}`;
  }
}
checks.push({
  id: 'job-search-mcp-trusted-host-boundary', ok: trustedHostLaunch,
  required: configuredMcpMode === 'stdio', detail: trustedHostDetail
});
const mcpRuntimeReady = configuredMcpMode === 'stdio' ? trustedHostLaunch : nativeMcpReady || wslMcpReady;
checks.push({
  id: 'job-search-mcp-activation', ok: mcpRuntimeReady, required: configuredMcpMode === 'stdio',
  detail: mcpRuntimeReady
    ? `${configuredMcpMode === 'stdio' ? 'Konfigurierter Startvertrag und gebundener Runtimepfad validiert' : 'Installierter MCP-Runtimepfad vorhanden'}; konfigurierter Modus: ${configuredMcpMode}.`
    : `Nur Demoquelle startbereit; fuer StepStone/stdio zuerst npm run setup:integrations ausfuehren. Konfigurierter Modus: ${configuredMcpMode}.`
});
const languageTool = process.env.LANGUAGETOOL_URL;
const hunspell = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['hunspell'], { encoding: 'utf8', windowsHide: true });
checks.push({
  id: 'local-language-backend', ok: Boolean(languageTool) || hunspell.status === 0, required: false,
  detail: languageTool ? 'LANGUAGETOOL_URL ist konfiguriert (Wert redigiert).' : hunspell.status === 0 ? 'Hunspell lokal gefunden.' : 'Optional: weder LanguageTool noch Hunspell konfiguriert.'
});
const configPath = localConfigPath;
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  checks.push({ id: 'encrypted-identities', ok: config.schemaVersion === 2 && Boolean(config.encryptedIdentities) && !config.config?.identities, required: true, detail: 'config schemaVersion 2' });
}
const failed = checks.filter((item) => !item.ok && item.required);
const warnings = checks.filter((item) => !item.ok && !item.required);
console.log(JSON.stringify({ status: failed.length ? 'failed' : warnings.length ? 'ready_with_optional_warnings' : 'ok', checks }, null, 2));
process.exitCode = failed.length ? 1 : 0;
