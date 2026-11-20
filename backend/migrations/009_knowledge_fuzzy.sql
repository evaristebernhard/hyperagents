CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE resources ADD COLUMN search_document text GENERATED ALWAYS AS
 (lower(coalesce(value->>'content','') || ' ' || coalesce(value->>'name','') || ' ' || coalesce(value->>'description','') || ' ' || coalesce(value->>'documentation','') || ' ' || coalesce(value->>'whenToUse','') || ' ' || coalesce((value->'tags')::text,''))) STORED;
CREATE INDEX resources_knowledge_fuzzy ON resources USING gin(search_document gin_trgm_ops);
