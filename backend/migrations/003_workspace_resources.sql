-- Existing accounts, files and personal workspace IDs are preserved.
ALTER TABLE workspaces DROP CONSTRAINT workspaces_user_id_key;
ALTER TABLE workspaces ADD COLUMN kind text NOT NULL DEFAULT 'personal' CHECK(kind IN ('personal','team'));
ALTER TABLE workspaces ADD COLUMN name text NOT NULL DEFAULT 'Personal';
CREATE UNIQUE INDEX personal_workspace ON workspaces(user_id) WHERE kind='personal';
ALTER TABLE sessions ADD COLUMN active_workspace_id uuid REFERENCES workspaces(id);
CREATE TABLE workspace_members(workspace_id uuid REFERENCES workspaces(id), user_id uuid REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','member','viewer')), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE team_invites(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member','viewer')), token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE resources(workspace_id uuid NOT NULL REFERENCES workspaces(id), kind text NOT NULL, id text NOT NULL, value jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,kind,id));
CREATE INDEX resource_kind ON resources(workspace_id,kind,updated_at DESC);
ALTER TABLE conversations ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
CREATE TABLE learning_suggestions(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), task_id uuid NOT NULL REFERENCES tasks(id), operation_id uuid NOT NULL UNIQUE REFERENCES operations(id), kind text NOT NULL CHECK(kind IN ('memories','skills','wiki')), name text NOT NULL, content text NOT NULL, reason text NOT NULL, decision text CHECK(decision IN ('accepted','dismissed')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE schedule_runs(workspace_id uuid NOT NULL, schedule_id text NOT NULL, occurrence timestamptz NOT NULL, task_id uuid REFERENCES tasks(id), error_code text, PRIMARY KEY(workspace_id,schedule_id,occurrence));
