-- Browser profiles are metadata only. The private service volume holds credentials.
ALTER TABLE tasks DROP CONSTRAINT tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check CHECK(state IN ('queued','running','waiting_children','waiting_user','waiting_approval','waiting_tool','waiting_browser','uncertain','succeeded','failed','cancelled'));
ALTER TABLE tasks ADD COLUMN active_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN active_since timestamptz;
ALTER TABLE tasks ADD COLUMN wait_reason text;
ALTER TABLE tasks ADD COLUMN requested_by uuid REFERENCES users(id);
CREATE TABLE browser_profiles (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), owner_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,workspace_id)
);
CREATE TABLE browser_grants (profile_id uuid REFERENCES browser_profiles(id), user_id uuid REFERENCES users(id), PRIMARY KEY(profile_id,user_id));
ALTER TABLE tasks ADD COLUMN browser_profile_id uuid REFERENCES browser_profiles(id);
CREATE TABLE browser_sessions (
 id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES browser_profiles(id), task_id uuid REFERENCES tasks(id),
 state text NOT NULL DEFAULT 'starting' CHECK(state IN ('starting','open','closed','error')),
 control text NOT NULL DEFAULT 'agent' CHECK(control IN ('agent','transferring','human','paused')),
 control_epoch integer NOT NULL DEFAULT 0, controller_id uuid REFERENCES users(id),
 tabs jsonb NOT NULL DEFAULT '[]', last_active_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX browser_one_session ON browser_sessions(profile_id) WHERE state IN ('starting','open');
CREATE UNIQUE INDEX browser_one_task ON browser_sessions(task_id) WHERE task_id IS NOT NULL AND state IN ('starting','open');
ALTER TABLE operations DROP CONSTRAINT operations_status_check;
ALTER TABLE operations ADD CONSTRAINT operations_status_check CHECK(status IN ('prepared','running','dispatched','completed','failed','obsolete'));
CREATE TABLE browser_outbox (
 operation_id uuid PRIMARY KEY REFERENCES operations(id), task_id uuid NOT NULL REFERENCES tasks(id),
 session_id uuid NOT NULL REFERENCES browser_sessions(id), profile_id uuid NOT NULL REFERENCES browser_profiles(id), control_epoch integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','uncertain','obsolete')),
 service_instance uuid, result jsonb, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz
);
CREATE TABLE task_inputs (
 id text PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), kind text NOT NULL,
 payload jsonb NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_inputs_pending ON task_inputs(task_id,created_at) WHERE consumed_at IS NULL;
CREATE TABLE browser_transitions (
 session_id uuid NOT NULL REFERENCES browser_sessions(id), key text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 action text NOT NULL, expected_epoch integer NOT NULL, note text NOT NULL DEFAULT '', result jsonb,
 PRIMARY KEY(session_id,key)
);
CREATE TABLE browser_tickets (
 token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES browser_sessions(id), user_id uuid NOT NULL REFERENCES users(id),
 app_session_hash text NOT NULL, workspace_id uuid NOT NULL REFERENCES workspaces(id), permission text NOT NULL CHECK(permission IN ('observe','write')),
 control_epoch integer NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz
);
-- Preserve the old root wall-clock allowance conservatively during migration.
UPDATE tasks SET active_ms=LEAST(1200000,GREATEST(0,extract(epoch FROM (LEAST(now(),COALESCE(updated_at,now()))-(deadline-interval '20 minutes')))*1000)::bigint),
 active_since=CASE WHEN state='running' THEN now() ELSE NULL END
 WHERE id=root_id AND deadline IS NOT NULL;
-- Charge only leased execution fragments, including fragments interrupted by a crash.
-- A state/lease transition settles time atomically, so waiting never consumes budget.
CREATE FUNCTION account_active_fragment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='running' AND OLD.active_since IS NOT NULL THEN
  NEW.active_ms := OLD.active_ms + GREATEST(0, EXTRACT(EPOCH FROM (LEAST(clock_timestamp(),COALESCE(OLD.lease_until,clock_timestamp()))-OLD.active_since))*1000)::bigint;
 END IF;
 IF NEW.state='running' THEN NEW.active_since := clock_timestamp(); ELSE NEW.active_since := NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_active_fragment BEFORE UPDATE OF state,lease_until ON tasks FOR EACH ROW EXECUTE FUNCTION account_active_fragment();
