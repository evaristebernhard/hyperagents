-- Indexed English words and overlapping CJK bigrams; no external embedding service.
CREATE FUNCTION knowledge_terms(input text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT COALESCE(array_agg(DISTINCT term),ARRAY[]::text[]) FROM (
 SELECT m[1] term FROM regexp_matches(lower(input), '[a-z0-9_]{2,}', 'g') m
 UNION ALL
 SELECT substring(input FROM n FOR 2) FROM generate_series(1,length(input)-1) n
 WHERE substring(input FROM n FOR 2) ~ '^[一-鿿㐀-䶿]{2}$'
 ) terms
$$;
ALTER TABLE resources ADD COLUMN search_terms text[] GENERATED ALWAYS AS
 (knowledge_terms(coalesce(value->>'content','') || ' ' || coalesce(value->>'name','') || ' ' || coalesce(value->>'description','') || ' ' || coalesce(value->>'documentation','') || ' ' || coalesce(value->>'whenToUse','') || ' ' || coalesce((value->'tags')::text,''))) STORED;
CREATE INDEX resources_knowledge_terms ON resources USING gin(search_terms);
ALTER TABLE learning_suggestions ADD COLUMN target_id text;
ALTER TABLE learning_suggestions ADD COLUMN target_revision integer;
ALTER TABLE learning_suggestions ADD COLUMN before_value jsonb;
