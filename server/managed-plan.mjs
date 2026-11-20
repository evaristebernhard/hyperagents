// Plans describe progress. A linked delegated step additionally requires an
// actual direct-child result; model text alone cannot establish that result.
export const planDefinition = {type:'function',function:{name:'update_plan',description:'Record progress with stable step IDs. Optional dependsOn lists prerequisite step IDs; start or complete a step only after its prerequisites complete. Optional childRunId links a real direct delegated run; a linked step can complete only after that run succeeds and its result is saved. Keep existing prerequisite and child evidence links; revised work needs a new step. A plan does not execute work.',parameters:{type:'object',additionalProperties:false,required:['steps'],properties:{steps:{type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,required:['id','title','status'],properties:{id:{type:'string'},title:{type:'string'},status:{type:'string',enum:['pending','in_progress','completed']},dependsOn:{type:'array',maxItems:11,items:{type:'string'}},childRunId:{type:'string',minLength:1,maxLength:200}}}}}}}};

export function validateManagedPlan(args, { childRun = () => undefined, previousSteps = [] } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'steps') || !Array.isArray(args.steps) || !args.steps.length || args.steps.length > 12)
    throw Error('Invalid plan: use 1..12 unique short steps and at most one in-progress step.');
  const steps = args.steps;
  if (steps.some(s => !s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['id','title','status','dependsOn','childRunId'].includes(k)) || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(s.id) || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 200 || !['pending','in_progress','completed'].includes(s.status)) || new Set(steps.map(s => s.id)).size !== steps.length || steps.filter(s => s.status === 'in_progress').length > 1)
    throw Error('Invalid plan: use 1..12 unique short steps and at most one in-progress step.');
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const prior of previousSteps) {
    if (!prior.childRunId && !prior.dependsOn?.length) continue;
    const next = byId.get(prior.id);
    if (!next || (prior.childRunId && next.childRunId !== prior.childRunId) || prior.dependsOn?.some(id => !next.dependsOn?.includes(id)))
      throw Error('Keep previously recorded child evidence and prerequisite links. Use a new step for revised delegated work.');
  }
  for (const step of steps) {
    if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.length > 11 || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => typeof id !== 'string' || id === step.id || !byId.has(id))))
      throw Error('Invalid plan dependencies: use unique, existing prerequisite IDs other than the step itself.');
    if (step.childRunId !== undefined && (typeof step.childRunId !== 'string' || !step.childRunId || step.childRunId.length > 200))
      throw Error('Invalid plan child run ID.');
  }
  const visiting = new Set(), visited = new Set();
  function visit(step) {
    if (visiting.has(step.id)) throw Error('Plan dependencies must not contain a cycle.');
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const id of step.dependsOn || []) visit(byId.get(id));
    visiting.delete(step.id); visited.add(step.id);
  }
  for (const step of steps) visit(step);
  for (const step of steps) {
    if (step.status !== 'pending' && step.dependsOn?.some(id => byId.get(id).status !== 'completed'))
      throw Error('Complete prerequisite steps before starting or completing a dependent step.');
    if (step.childRunId !== undefined) {
      const child = childRun(step.childRunId);
      if (!child) throw Error('Plan evidence must reference a direct child run in this workspace.');
      if (step.status === 'completed' && (child.status !== 'succeeded' || !child.resultSaved))
        throw Error('A delegated step can complete only after the child succeeds and its result is saved.');
    }
  }
  return steps;
}
