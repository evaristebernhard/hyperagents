import { spawn } from 'node:child_process';
import net from 'node:net';

/**
 * Standalone, read-only Moli visual adapter. This file intentionally does not
 * register itself with the app. The host integration should add `definitions`
 * and route calls to `execute`; if persistence is available, pass `persist` to
 * createMoliVisualTools. `persist({bytes,mimeType,filename,kind,url})` may return
 * a host artifact reference; no local path is ever returned by this adapter.
 */
const MAX_URL = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 45_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOOLS = {
  screenshot: { mimeType: 'image/png', extension: 'png', dump: 'screenshot' },
  screenshot_full: { mimeType: 'image/png', extension: 'png', dump: 'screenshot_full' },
  pdf: { mimeType: 'application/pdf', extension: 'pdf', dump: 'pdf' },
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error(message); };

function isPrivateHost(host) {
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') return true;
  if (!net.isIP(host)) return false;
  if (net.isIPv4(host)) {
    const p = host.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
  }
  const normalized = host.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized === '::';
}

export function normalizeMoliVisualArgs(args) {
  if (!plain(args) || typeof args.url !== 'string' || args.url.length < 1 || args.url.length > MAX_URL || /[\u0000-\u001f\u007f-\u009f]/.test(args.url)) fail('Invalid visual URL.');
  const url = (() => { try { return new URL(args.url); } catch { fail('Invalid visual URL.'); } })();
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || isPrivateHost(hostname)) fail('Visual tools require a public HTTPS URL without credentials or fragments.');
  const kind = args.kind ?? 'screenshot';
  if (!Object.hasOwn(TOOLS, kind)) fail('Unsupported visual output kind.');
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail('Invalid visual timeout.');
  const unexpected = Object.keys(args).filter(key => !['url', 'kind', 'timeoutMs'].includes(key));
  if (unexpected.length) fail('Unknown visual arguments.');
  return { url: url.href, kind, timeoutMs };
}

export const moliVisualDefinitions = Object.entries(TOOLS).map(([kind, spec]) => ({
  type: 'function', function: {
    name: `moli_${kind}`,
    description: `Read-only ${kind === 'pdf' ? 'PDF' : 'PNG'} rendering of a public HTTPS URL using Moli. No cookies, form actions, scripts from the caller, or writes.`,
    parameters: { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: MAX_URL }, timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS } }, required: ['url'], additionalProperties: false },
  },
}));

export function createMoliVisualTools({ enabled = [], moliPath = process.env.MOLI_PATH || '/home/ubuntu/.local/bin/moli', persist } = {}) {
  const active = Array.isArray(enabled) && (enabled.includes('Visual Output') || enabled.includes('Screenshots') || enabled.includes('PDF'));
  return {
    definitions: active ? structuredClone(moliVisualDefinitions) : [],
    capabilities: [{ name: 'Visual Output', available: active, reason: active ? 'Moli screenshot/PDF output is enabled.' : 'Enable Visual Output in the thread tools.' }],
    async execute(name, args, signal) {
      if (!active || !name.startsWith('moli_')) fail('Moli visual output is unavailable or disabled.');
      const kind = name.slice(5);
      if (!Object.hasOwn(TOOLS, kind)) fail('Unknown Moli visual tool.');
      const normalized = normalizeMoliVisualArgs({ ...args, kind });
      if (signal?.aborted) fail('Moli visual output cancelled.');
      const bytes = await runMoli(moliPath, normalized, signal);
      const spec = TOOLS[kind];
      const artifact = { kind, mimeType: spec.mimeType, filename: `moli-${kind}.${spec.extension}`, byteLength: bytes.length, bytesBase64: bytes.toString('base64'), url: normalized.url, engine: 'moli' };
      if (typeof persist === 'function') { artifact.ref = await persist({ ...artifact, bytes }); delete artifact.bytesBase64; artifact.persisted = true; }
      return { status: 'ok', artifact };
    },
  };
}

function runMoli(binary, { url, kind, timeoutMs }, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['fetch', '--dump', TOOLS[kind].dump, '--layout', '--wait', 'done', '--timeout', String(timeoutMs), '--block-private-networks', '--fail', url], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.local/bin', HOME: process.env.HOME || '/home/ubuntu', LANG: 'C.UTF-8' } });
    let chunks = [], total = 0, settled = false, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill('SIGKILL'); finish(new Error('Moli visual output cancelled.')); };
    child.stdout.on('data', chunk => { if (settled) return; total += chunk.length; if (total > MAX_BYTES) { child.kill('SIGKILL'); finish(new Error('Moli visual output exceeded 8 MiB.')); } else chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Moli visual output failed.')));
    child.on('close', code => { if (settled) return; if (code !== 0) finish(new Error('Moli visual output failed.')); else finish(null, Buffer.concat(chunks)); });
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Moli visual output timed out.')); }, timeoutMs + 1000);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export const MOLI_VISUAL_LIMITS = Object.freeze({ maxUrlLength: MAX_URL, maxBytes: MAX_BYTES, maxTimeoutMs: MAX_TIMEOUT_MS });
