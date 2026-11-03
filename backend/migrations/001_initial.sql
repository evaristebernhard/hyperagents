CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL, admin boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE workspaces (id uuid PRIMARY KEY, user_id uuid UNIQUE NOT NULL REFERENCES users(id));
CREATE TABLE invites (id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf_hash text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE conversations (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,workspace_id));
CREATE TABLE messages (id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tasks (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), conversation_id uuid NOT NULL,
 parent_id uuid REFERENCES tasks(id), root_id uuid NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
 prompt text NOT NULL, acceptance jsonb NOT NULL, input_file_ids jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL CHECK(state IN ('queued','running','waiting_children','waiting_user','waiting_approval','uncertain','succeeded','failed','cancelled')),
 idempotency_key text, request_hash text, checkpoint jsonb NOT NULL DEFAULT '{}', result jsonb, error_code text,
 step integer NOT NULL DEFAULT 0, repair_count integer NOT NULL DEFAULT 0, instruction_cursor bigint NOT NULL DEFAULT 0,
 model_calls integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0, tokens bigint NOT NULL DEFAULT 0, transfer_bytes bigint NOT NULL DEFAULT 0, artifact_bytes bigint NOT NULL DEFAULT 0,
 lease_owner uuid, lease_until timestamptz, deadline timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,idempotency_key), UNIQUE(id,workspace_id), FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id)
);
CREATE INDEX tasks_schedule ON tasks(state,lease_until);
CREATE TABLE instructions (id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), message text NOT NULL);
CREATE TABLE events (id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX events_task_cursor ON events(task_id,id);
CREATE TABLE operations (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), step integer NOT NULL, call_id text NOT NULL, name text NOT NULL, args jsonb NOT NULL, status text NOT NULL CHECK(status IN ('prepared','running','completed','failed','obsolete')), replay text NOT NULL CHECK(replay IN ('safe','uncertain')), result jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,step,call_id));
CREATE TABLE files (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), task_id uuid, name text NOT NULL, format text NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, sha256 text NOT NULL, storage_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,workspace_id), FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id));
CREATE TABLE artifacts (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), conversation_id uuid NOT NULL, name text NOT NULL, UNIQUE(id,workspace_id), FOREIGN KEY(conversation_id,workspace_id) REFERENCES conversations(id,workspace_id));
CREATE TABLE artifact_versions (id uuid PRIMARY KEY, artifact_id uuid NOT NULL, workspace_id uuid NOT NULL, task_id uuid NOT NULL, file_id uuid NOT NULL, version integer NOT NULL, operation_key text NOT NULL UNIQUE, validation jsonb NOT NULL, source_ids jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(artifact_id,version), FOREIGN KEY(artifact_id,workspace_id) REFERENCES artifacts(id,workspace_id), FOREIGN KEY(file_id,workspace_id) REFERENCES files(id,workspace_id), FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id));
CREATE TABLE sources (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, task_id uuid NOT NULL, url text NOT NULL, title text NOT NULL, excerpt text NOT NULL, read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,url), FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id));
CREATE TABLE approvals (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), operation_id uuid NOT NULL UNIQUE REFERENCES operations(id), action text NOT NULL, payload jsonb NOT NULL, digest text NOT NULL, decision text CHECK(decision IN ('approved','denied')), created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tasks ADD COLUMN reserved_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN ordinal integer NOT NULL DEFAULT 0;
CREATE TABLE model_attempts(id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id),root_id uuid NOT NULL REFERENCES tasks(id),reserved bigint NOT NULL,usage jsonb,status text NOT NULL CHECK(status IN ('running','completed','failed')),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE model_attempts ADD COLUMN model text;
ALTER TABLE model_attempts ADD COLUMN finished_at timestamptz;
ALTER TABLE model_attempts ADD COLUMN error_code text;
