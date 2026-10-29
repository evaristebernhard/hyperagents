import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveVisibleArtifact } from '../src/canvas-order.ts';

test('first reorder follows display sort, not insertion order', () => {
  // Insertion A,B,C is deliberately different from the current display C,B,A.
  assert.deepEqual(moveVisibleArtifact(['C','B','A'], ['C','B','A'], 'C', 'B'), ['B','C','A']);
  assert.deepEqual(moveVisibleArtifact(['A','C','B'], ['A','C','B'], 'A', 'C'), ['C','A','B']);
});
test('reordering visible artifacts preserves filtered and docked slots', () => {
  const all=['hidden-one','C','filtered','B','A','hidden-two'];
  const visible=['C','B','A'];
  assert.deepEqual(moveVisibleArtifact(all,visible,'C','A'), ['hidden-one','B','filtered','A','C','hidden-two']);
  assert.deepEqual(all,['hidden-one','C','filtered','B','A','hidden-two']);
  assert.deepEqual(visible,['C','B','A']);
});
test('reverse moves, no-ops and foreign drag IDs cannot corrupt order', () => {
  assert.deepEqual(moveVisibleArtifact(['C','B','A'],['C','B','A'],'A','C'),['A','C','B']);
  for(const [all,visible,from,to] of [[['A','B'],['A','B'],'foreign','B'],[['A','B'],['A','B'],'A','A'],[['A'],['foreign'],'foreign','A'],[['A','A'],['A'],'A','B'],[['A','B'],['A','A'],'A','B']]) assert.equal(moveVisibleArtifact(all,visible,from,to),null);
});
