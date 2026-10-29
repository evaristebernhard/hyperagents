import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWebFetch} from './moli-tools.mjs';
import {createMoliSemanticTools,validateSemanticUrl} from './moli-semantic-tools.mjs';
test('semantic tree validates public HTTPS URLs',()=>{assert.equal(validateSemanticUrl('https://example.com/a'),'https://example.com/a');assert.throws(()=>validateSemanticUrl('http://example.com'),/HTTPS/);assert.throws(()=>validateSemanticUrl('https://127.0.0.1'),/Private/);});
test('semantic tree binds only when explicitly enabled',()=>{assert.equal(createMoliSemanticTools({enabled:[]}).definitions.length,0);assert.equal(createMoliSemanticTools({enabled:['Web Semantic Tree']}).definitions[0].function.name,'web_semantic_tree');});
