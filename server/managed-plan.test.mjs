import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateManagedPlan} from './managed-plan.mjs';

const step = (id, status = 'pending', extra = {}) => ({id, title:id, status, ...extra});
test('plans retain legacy format and allow a dependency graph joined at synthesis', () => {
  assert.deepEqual(validateManagedPlan({steps:[step('old','in_progress')]}),[step('old','in_progress')]);
  const steps = [step('stock','completed',{childRunId:'stock-run'}),step('risk','completed',{childRunId:'risk-run'}),step('report','in_progress',{dependsOn:['stock','risk']})];
  assert.deepEqual(validateManagedPlan({steps},{childRun:()=>({status:'succeeded',resultSaved:true})}),steps);
});
test('plans reject cycles, unknown/self/duplicate dependencies and premature synthesis', () => {
  for (const steps of [
    [step('a','pending',{dependsOn:['b']}),step('b','pending',{dependsOn:['a']})],
    [step('a','pending',{dependsOn:['unknown']})],
    [step('a','pending',{dependsOn:['a']})],
    [step('a'),step('b','pending',{dependsOn:['a','a']})],
    [step('a'),step('b','in_progress',{dependsOn:['a']})],
    [step('a','in_progress'),step('b','completed',{dependsOn:['a']})],
  ]) assert.throws(()=>validateManagedPlan({steps}));
});
test('a linked child must belong to this run and have a successful saved result', () => {
  const args={steps:[step('a','completed',{childRunId:'child'})]};
  assert.throws(()=>validateManagedPlan(args),/direct child/);
  for (const status of ['queued','running','failed','cancelled','interrupted'])
    assert.throws(()=>validateManagedPlan(args,{childRun:()=>({status,resultSaved:true})}),/child succeeds/);
  assert.throws(()=>validateManagedPlan(args,{childRun:()=>({status:'succeeded',resultSaved:false})}),/result is saved/);
  assert.doesNotThrow(()=>validateManagedPlan({steps:[step('a','in_progress',{childRunId:'child'})]},{childRun:()=>({status:'running',resultSaved:false})}));
});

test('later plan updates cannot erase recorded dependency or delegated evidence', () => {
  const previousSteps=[step('stock','completed',{childRunId:'stock-run'}),step('report','pending',{dependsOn:['stock']})];
  const context={previousSteps,childRun:()=>({status:'succeeded',resultSaved:true})};
  assert.doesNotThrow(()=>validateManagedPlan({steps:[previousSteps[0],{...previousSteps[1],status:'completed'}]},context));
  for (const steps of [
    [step('stock','completed'),previousSteps[1]],
    [previousSteps[0],step('report','completed')],
    [step('stock','completed',{childRunId:'different-run'}),previousSteps[1]],
    [step('new','completed')],
  ]) assert.throws(()=>validateManagedPlan({steps},context),/Keep previously recorded/);
  assert.doesNotThrow(()=>validateManagedPlan({steps:[step('new','completed')]},{previousSteps:[step('old')]}));
});
