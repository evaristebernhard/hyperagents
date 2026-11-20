-- Additive rollout: stop old API/workers/kernel before applying and restart together.
ALTER TABLE tasks ADD COLUMN control_state text NOT NULL DEFAULT 'normal'
 CHECK (control_state IN ('normal','pause_requested','paused'));
ALTER TABLE tasks ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN control_updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE task_plans (
 task_id uuid NOT NULL REFERENCES tasks(id), version integer NOT NULL CHECK(version>0),
 operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
 reason text NOT NULL, steps jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,version)
);
CREATE TABLE delivery_checks (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
 operation_id uuid NOT NULL UNIQUE REFERENCES operations(id),
 status text NOT NULL CHECK(status IN ('passed','failed','unverified')),
 issues jsonb NOT NULL, artifacts jsonb NOT NULL, artifact_info jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Completed provider responses survive a pause between model and native tools.
CREATE TABLE kernel_model_results (
 task_id uuid NOT NULL REFERENCES tasks(id), request_hash text NOT NULL,
 chunks jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,request_hash)
);
-- All dispatch admission and control writes serialize on 730110. Result commits
-- may still proceed after pause; cancellation continues to revoke leases.
CREATE FUNCTION task_dispatch_allowed(task uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM tasks t JOIN tasks r ON r.id=t.root_id
 WHERE t.id=task AND r.control_state='normal'
 AND r.state NOT IN ('succeeded','failed','cancelled','uncertain'))
$$;
CREATE FUNCTION settle_task_pauses() RETURNS void LANGUAGE plpgsql AS $$
DECLARE root record;
BEGIN
 FOR root IN UPDATE tasks r SET control_state='paused',control_revision=control_revision+1,control_updated_at=now()
 WHERE r.parent_id IS NULL AND r.control_state='pause_requested'
 AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.root_id=r.id AND t.state='running')
 AND NOT EXISTS(SELECT 1 FROM operations o JOIN tasks t ON t.id=o.task_id
   JOIN browser_outbox b ON b.operation_id=o.id
   WHERE t.root_id=r.id AND o.status='dispatched' AND b.status IN ('running','completed','failed','uncertain'))
 RETURNING id,control_revision LOOP
  INSERT INTO events(task_id,payload) VALUES(root.id,jsonb_build_object('type','control','control','paused','revision',root.control_revision));
 END LOOP;
END $$;
