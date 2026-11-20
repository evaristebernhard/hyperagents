-- Allocation is immutable: existing tasks always remain TypeScript tasks.
ALTER TABLE tasks ADD COLUMN runtime_kind text NOT NULL DEFAULT 'typescript' CHECK(runtime_kind IN ('typescript','rust'));
ALTER TABLE tasks ADD COLUMN runtime_version text NOT NULL DEFAULT 'ts-1.5.0';
ALTER TABLE tasks ADD COLUMN runtime_phase text NOT NULL DEFAULT 'model' CHECK(runtime_phase IN ('model','tools'));
ALTER TABLE tasks ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN kernel_internal boolean NOT NULL DEFAULT false;
CREATE TABLE kernel_threads (
 task_id uuid PRIMARY KEY REFERENCES tasks(id), snapshot jsonb NOT NULL DEFAULT '{}',
 revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kernel_inputs (
 id text PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), payload jsonb NOT NULL,
 available_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz, deferred boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kernel_inputs_ready ON kernel_inputs(task_id,available_at,created_at,id) WHERE consumed_at IS NULL AND NOT deferred;
CREATE INDEX kernel_ready ON tasks(updated_at,id) WHERE runtime_kind='rust' AND state='queued' AND runtime_phase='model';
CREATE TABLE kernel_metrics (name text PRIMARY KEY, value bigint NOT NULL DEFAULT 0);
CREATE FUNCTION kernel_input(input_id text, task uuid, body jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO kernel_inputs(id,task_id,payload) VALUES(input_id,task,body) ON CONFLICT DO NOTHING;
 PERFORM pg_notify('hyper_kernel', task::text);
END $$;
CREATE FUNCTION kernel_task_hooks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.runtime_kind<>OLD.runtime_kind OR NEW.runtime_version<>OLD.runtime_version) THEN
  RAISE EXCEPTION 'Task runtime allocation is immutable';
 END IF;
 IF TG_OP='INSERT' AND NEW.parent_id IS NOT NULL THEN
  SELECT runtime_kind,runtime_version INTO NEW.runtime_kind,NEW.runtime_version FROM tasks WHERE id=NEW.parent_id;
 END IF;
 IF NEW.runtime_kind='rust' THEN
  IF TG_OP='INSERT' THEN
   PERFORM kernel_input('start:'||NEW.id,NEW.id,jsonb_build_object('kind','start'));
  ELSIF NEW.state='queued' AND OLD.state='waiting_children' THEN
   PERFORM kernel_input('children:'||NEW.id||':'||NEW.step,NEW.id,jsonb_build_object('kind','user','text','CHILD_RESULTS: '||COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'state',state,'result',result))::text FROM tasks WHERE parent_id=NEW.id),'[]')));
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Allocation must happen before INSERT; input FK needs the task row, so split the hooks.
CREATE FUNCTION kernel_inherit_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_id IS NOT NULL THEN SELECT runtime_kind,runtime_version INTO NEW.runtime_kind,NEW.runtime_version FROM tasks WHERE id=NEW.parent_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kernel_inherit BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION kernel_inherit_runtime();
CREATE TRIGGER kernel_task AFTER INSERT OR UPDATE OF runtime_kind,runtime_version,state ON tasks FOR EACH ROW EXECUTE FUNCTION kernel_task_hooks();
CREATE FUNCTION kernel_instruction_hook() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND runtime_kind='rust') THEN
  PERFORM kernel_input('instruction:'||NEW.id,NEW.task_id,jsonb_build_object('kind','user','text',NEW.message));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kernel_instruction AFTER INSERT ON instructions FOR EACH ROW EXECUTE FUNCTION kernel_instruction_hook();
CREATE FUNCTION kernel_operation_hook() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('completed','failed','obsolete') AND OLD.status NOT IN ('completed','failed','obsolete') AND EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND runtime_kind='rust') THEN
  PERFORM kernel_input('tool:'||NEW.id,NEW.task_id,jsonb_build_object('kind','tool','callId',NEW.call_id,'result',COALESCE(NEW.result,'{}')));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER kernel_operation AFTER UPDATE OF status ON operations FOR EACH ROW EXECUTE FUNCTION kernel_operation_hook();
ALTER TABLE model_attempts ADD COLUMN bridge_started_at timestamptz;
ALTER TABLE model_attempts ADD COLUMN lease_epoch bigint NOT NULL DEFAULT 0;
CREATE INDEX kernel_workspace_fairness ON tasks(workspace_id,updated_at DESC) WHERE runtime_kind='rust' AND lease_epoch>0;
CREATE INDEX kernel_leases ON tasks(runtime_phase,state,lease_until,workspace_id) WHERE runtime_kind='rust';
