CREATE TABLE skill_packages (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id text NOT NULL,
 name text NOT NULL, description text NOT NULL, source jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE skill_versions (
 workspace_id uuid NOT NULL, package_id text NOT NULL, digest text NOT NULL,
 files jsonb NOT NULL, source jsonb NOT NULL DEFAULT '{}', requirements jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,package_id,digest),
 FOREIGN KEY(workspace_id,package_id) REFERENCES skill_packages(workspace_id,id)
);
CREATE TABLE skill_installations (
 workspace_id uuid NOT NULL, package_id text NOT NULL, digest text NOT NULL,
 revision integer NOT NULL DEFAULT 1, local boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,package_id),
 FOREIGN KEY(workspace_id,package_id,digest) REFERENCES skill_versions(workspace_id,package_id,digest)
);
CREATE FUNCTION immutable_skill_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Skill versions are immutable'; END $$;
CREATE TRIGGER immutable_skill_version BEFORE UPDATE OR DELETE ON skill_versions FOR EACH ROW EXECUTE FUNCTION immutable_skill_version();
-- Preserve IDs and Agent links for document-only legacy resources.
INSERT INTO skill_packages(workspace_id,id,name,description,source)
 SELECT workspace_id,id,value->>'name',coalesce(value->>'description',''),'{"kind":"legacy"}' FROM resources WHERE kind='skills';
INSERT INTO skill_versions(workspace_id,package_id,digest,files)
 SELECT workspace_id,id,encode(sha256(convert_to(value->>'documentation','UTF8')),'hex'),jsonb_build_object('SKILL.md',value->>'documentation') FROM resources WHERE kind='skills';
INSERT INTO skill_installations(workspace_id,package_id,digest)
 SELECT workspace_id,package_id,digest FROM skill_versions;
