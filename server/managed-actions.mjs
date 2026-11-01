import path from 'node:path';

// Host-authored approval descriptors only. The model cannot call this API or
// supply replacement execution callbacks through the HTTP approval endpoint.
export function normalizeManagedAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).some(k => !['kind', 'command', 'cwd', 'timeoutSeconds'].includes(k))) throw Error('Invalid managed action.');
  if (!['file', 'skill'].includes(action.kind)) throw Error('Unsupported managed action kind.');
  if (typeof action.command !== 'string' || !action.command.trim() || action.command.length > 40000 || action.command.includes('\0')) throw Error('Invalid managed action display.');
  if (typeof action.cwd !== 'string' || !path.isAbsolute(action.cwd) || action.cwd.length > 4096 || /[\0\r\n]/.test(action.cwd)) throw Error('Invalid managed action directory.');
  const timeoutSeconds = action.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw Error('Invalid managed action timeout.');
  return { kind: action.kind, command: action.command, cwd: action.cwd, timeoutSeconds };
}

export function managedActionSucceeded(result) {
  if (!result || result.error || result.cancelled || result.timedOut || ['denied', 'failed', 'cancelled', 'timed_out', 'error'].includes(result.status)) return false;
  if (typeof result.exitCode === 'number') return result.exitCode === 0;
  if (typeof result.path === 'string' && /^[a-f0-9]{64}$/.test(result.sha256 || '') && Number.isInteger(result.bytes)) return true;
  return ['ok', 'succeeded', 'completed', 'written', 'edited', 'saved'].includes(result.status);
}
