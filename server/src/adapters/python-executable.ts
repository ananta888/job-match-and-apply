/**
 * Python-Interpreter für die lokalen Skill-Skripte.
 * macOS und viele Linux-Systeme kennen nur `python3`; Windows installiert `python`.
 * `PYTHON_EXECUTABLE` hat immer Vorrang.
 */
export function pythonExecutable(environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return environment.PYTHON_EXECUTABLE || (platform === 'win32' ? 'python' : 'python3');
}
