const LOCAL_CHILD_ENVIRONMENT_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'LANG', 'LC_ALL', 'PYTHONUTF8', 'PYTHONIOENCODING'
] as const;

/**
 * Local deterministic helpers receive only operating-system basics. Secrets,
 * portal credentials and unrelated server configuration never cross this
 * process boundary implicitly.
 */
export function buildMinimalLocalChildEnvironment(host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_CHILD_ENVIRONMENT_KEYS) {
    const value = host[key];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) environment[key] = value;
  }
  return environment;
}
