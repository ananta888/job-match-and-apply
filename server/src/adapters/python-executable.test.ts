import { describe, expect, it } from 'vitest';
import { pythonExecutable } from './python-executable.js';

describe('pythonExecutable', () => {
  it('prefers PYTHON_EXECUTABLE', () => {
    expect(pythonExecutable({ PYTHON_EXECUTABLE: '/opt/py/bin/python3.12' }, 'darwin')).toBe('/opt/py/bin/python3.12');
  });
  it('uses python3 on macOS and Linux, python on Windows', () => {
    expect(pythonExecutable({}, 'darwin')).toBe('python3');
    expect(pythonExecutable({}, 'linux')).toBe('python3');
    expect(pythonExecutable({}, 'win32')).toBe('python');
  });
});
