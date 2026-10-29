import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMoliVisualTools, normalizeMoliVisualArgs, moliVisualDefinitions } from './moli-visual-tools.mjs';

test('visual args require public HTTPS and reject private/unknown inputs', () => {
  assert.equal(normalizeMoliVisualArgs({ url: 'https://example.com', kind: 'pdf' }).kind, 'pdf');
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://localhost', 'https://[::1]']) assert.throws(() => normalizeMoliVisualArgs({ url }), /public HTTPS|Invalid/);
  assert.throws(() => normalizeMoliVisualArgs({ url: 'https://example.com', cookie: 'x' }), /Unknown/);
  assert.equal(moliVisualDefinitions.length, 3);
});

test('visual adapter uses layout, blocks private networks, and returns bounded bytes without a path', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'moli-visual-'));
  const script = path.join(dir, 'moli-fake.sh');
  await writeFile(script, '#!/bin/sh\nprintf \'PNG-OR-PDF-BYTES\'\nprintf \' %s\' "$*"\n', { mode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const tool = createMoliVisualTools({ enabled: ['Visual Output'], moliPath: script, persist: async input => { seen.push(input); return 'temporary-artifact-1'; } });
  const result = await tool.execute('moli_screenshot', { url: 'https://example.com' });
  assert.equal(result.status, 'ok');
  assert.equal(result.artifact.mimeType, 'image/png');
  assert.equal(result.artifact.ref, 'temporary-artifact-1');
  assert.equal(result.artifact.persisted, true);
  assert.equal('bytesBase64' in result.artifact, false);
  assert.equal('path' in result.artifact, false);
  assert.equal(seen[0].bytes.toString().startsWith('PNG-OR-PDF-BYTES'), true);
  assert.equal(seen[0].bytes.toString().includes('--layout'), true);
  assert.equal(seen[0].bytes.toString().includes('--block-private-networks'), true);
});

test('visual adapter is opt-in', async () => {
  const tool = createMoliVisualTools();
  assert.deepEqual(tool.definitions, []);
  await assert.rejects(() => tool.execute('moli_pdf', { url: 'https://example.com' }), /disabled/);
});
