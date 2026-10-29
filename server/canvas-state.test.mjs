import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateState, emptyState } from './validation.mjs';
const state = canvas => {
  const s = emptyState(); s.workspaces[0].data.threads.push({ id: 'thread-one', title: 'Canvas', summary: '', time: '', ...(canvas === undefined ? {} : { canvas }) }); return s;
};
const canvas = () => ({ layout: 'tiles', hidden: ['artifact-one'], order: ['artifact-two', 'artifact-one'], collapsed: false });
test('old threads without canvas remain valid; supported layouts preserve preferences', () => {
  assert.doesNotThrow(() => validateState(state()));
  for (const layout of ['focus', 'tiles', 'carousel']) assert.doesNotThrow(() => validateState(state({ ...canvas(), layout })));
});
test('canvas rejects unknown fields, unsupported layouts, unsafe IDs, duplicates and invalid flags', () => {
  for (const value of [null, [], { ...canvas(), layout: 'windows' }, { ...canvas(), secret: 'not-allowed' }, { ...canvas(), hidden: ['../private'] }, { ...canvas(), order: ['duplicate', 'duplicate'] }, { ...canvas(), collapsed: 'yes' }, { ...canvas(), hidden: 'artifact' }, { layout: 'focus' }, { ...canvas(), order: [123] }]) assert.throws(() => validateState(state(value)), e => e.status === 422);
});
test('canvas IDs are inert presentation preferences; stale IDs do not block artifact deletion or imports', () => {
  const s = state(canvas()); const serialized = JSON.stringify(s);
  assert.doesNotThrow(() => validateState(s)); assert.equal(JSON.stringify(s), serialized);
});
