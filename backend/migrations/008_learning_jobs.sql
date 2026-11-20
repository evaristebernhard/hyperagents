CREATE TABLE learning_jobs (
 task_id uuid PRIMARY KEY REFERENCES tasks(id), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 started_at timestamptz, finished_at timestamptz, usage jsonb, error_code text, model text
);
CREATE FUNCTION enqueue_learning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='succeeded' AND OLD.state<>'succeeded' AND NEW.parent_id IS NULL
 AND coalesce(NEW.context->>'memoryMode','connected')<>'read-only'
 AND coalesce((NEW.context->>'learnsAutomatically')::boolean,true)
 THEN INSERT INTO learning_jobs(task_id) VALUES(NEW.id) ON CONFLICT DO NOTHING; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_learning AFTER UPDATE OF state ON tasks FOR EACH ROW EXECUTE FUNCTION enqueue_learning();
