-- Production pre-deploy step (outside the migration transaction):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_memories_contexts_user_memory_ids_gin_idx"
-- ON "user_memories_contexts" USING gin ("user_memory_ids");
SET lock_timeout = '3s';--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."search_sync_revision_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_sync_outbox" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dead_at" timestamp with time zone,
	"document_id" text NOT NULL,
	"entity" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"priority" smallint DEFAULT 10 NOT NULL,
	"revision" bigint DEFAULT nextval('search_sync_revision_seq') NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_sync_settings" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text DEFAULT 'default' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_sync_outbox_entity_document_id_unique" ON "search_sync_outbox" USING btree ("entity","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sync_outbox_claim_idx" ON "search_sync_outbox" USING btree ("priority","available_at","revision") WHERE "search_sync_outbox"."dead_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sync_outbox_lease_idx" ON "search_sync_outbox" USING btree ("locked_until") WHERE "search_sync_outbox"."dead_at" IS NULL AND "search_sync_outbox"."locked_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_sync_settings_key_unique" ON "search_sync_settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_contexts_user_memory_ids_gin_idx" ON "user_memories_contexts" USING gin ("user_memory_ids");--> statement-breakpoint
INSERT INTO "search_sync_settings" ("key", "enabled")
VALUES ('default', false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_search_sync_outbox(
	p_entity text,
	p_document_ids text[],
	p_priority smallint DEFAULT 10
) RETURNS void AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM search_sync_settings WHERE key = 'default' AND enabled
	) THEN
		RETURN;
	END IF;

	INSERT INTO search_sync_outbox (entity, document_id, priority)
	SELECT DISTINCT p_entity, document_id, p_priority
	FROM unnest(p_document_ids) AS document_id
	WHERE document_id IS NOT NULL AND document_id <> ''
	ORDER BY document_id
	ON CONFLICT (entity, document_id) DO UPDATE SET
		attempts = 0,
		available_at = now(),
		dead_at = NULL,
		last_error = NULL,
		locked_until = NULL,
		priority = LEAST(search_sync_outbox.priority, EXCLUDED.priority),
		-- Allocate after locking the conflicting row so concurrent upserts preserve commit order.
		revision = nextval('search_sync_revision_seq'),
		updated_at = now();
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_search_sync_change() RETURNS trigger AS $$
DECLARE
	field_name text;
	old_row jsonb;
	new_row jsonb;
	priority smallint := CASE WHEN TG_OP = 'DELETE' THEN 0 ELSE 10 END;
	row_id text;
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM search_sync_settings WHERE key = 'default' AND enabled
	) THEN
		RETURN COALESCE(NEW, OLD);
	END IF;

	IF TG_OP = 'UPDATE' AND TG_NARGS > 1 THEN
		old_row := to_jsonb(OLD);
		new_row := to_jsonb(NEW);
		FOREACH field_name IN ARRAY TG_ARGV[1:TG_NARGS - 1] LOOP
			IF old_row->field_name IS DISTINCT FROM new_row->field_name THEN
				priority := 0;
			END IF;
		END LOOP;
	END IF;

	IF TG_OP = 'DELETE' THEN
		row_id := OLD.id::text;
	ELSE
		row_id := NEW.id::text;
	END IF;

	PERFORM enqueue_search_sync_outbox(TG_ARGV[0], ARRAY[row_id], priority);
	RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_search_sync_memory_fanout() RETURNS trigger AS $$
-- Keep this fanout aligned with SearchDocumentBuilder.resolveAffectedKeys.
DECLARE
	memory_id text := COALESCE(NEW.id, OLD.id)::text;
	priority smallint := CASE WHEN TG_OP = 'DELETE' THEN 0 ELSE 10 END;
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM search_sync_settings WHERE key = 'default' AND enabled
	) THEN
		RETURN COALESCE(NEW, OLD);
	END IF;

	PERFORM enqueue_search_sync_outbox(
		'memoryContexts',
		ARRAY(SELECT id::text FROM user_memories_contexts WHERE user_memory_ids @> to_jsonb(ARRAY[memory_id]) ORDER BY id),
		priority
	);
	PERFORM enqueue_search_sync_outbox(
		'memoryPreferences',
		ARRAY(SELECT id::text FROM user_memories_preferences WHERE user_memory_id = memory_id ORDER BY id),
		priority
	);
	PERFORM enqueue_search_sync_outbox(
		'memoryActivities',
		ARRAY(SELECT id::text FROM user_memories_activities WHERE user_memory_id = memory_id ORDER BY id),
		priority
	);
	PERFORM enqueue_search_sync_outbox(
		'memoryIdentities',
		ARRAY(SELECT id::text FROM user_memories_identities WHERE user_memory_id = memory_id ORDER BY id),
		priority
	);
	PERFORM enqueue_search_sync_outbox(
		'memoryExperiences',
		ARRAY(SELECT id::text FROM user_memories_experiences WHERE user_memory_id = memory_id ORDER BY id),
		priority
	);

	RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_search_sync_knowledge_base_files() RETURNS trigger AS $$
-- Keep this fanout aligned with SearchDocumentBuilder.resolveAffectedKeys.
DECLARE
	file_ids text[] := ARRAY[
		CASE WHEN TG_OP <> 'INSERT' THEN OLD.file_id::text END,
		CASE WHEN TG_OP <> 'DELETE' THEN NEW.file_id::text END
	];
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM search_sync_settings WHERE key = 'default' AND enabled
	) THEN
		RETURN COALESCE(NEW, OLD);
	END IF;

	PERFORM enqueue_search_sync_outbox('files', file_ids, 0::smallint);
	PERFORM enqueue_search_sync_outbox(
		'documents',
		ARRAY(SELECT id::text FROM documents WHERE file_id = ANY(file_ids) ORDER BY id),
		0::smallint
	);
	RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_agents
	AFTER INSERT OR DELETE OR UPDATE OF description, slug, system_role, tags, title, user_id, virtual, visibility, workspace_id ON agents
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'agents', 'user_id', 'visibility', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_topics
	AFTER INSERT OR DELETE OR UPDATE OF agent_id, content, description, group_id, session_id, status, title, user_id, workspace_id ON topics
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'topics', 'user_id', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_files
	AFTER INSERT OR DELETE OR UPDATE OF file_type, name, size, source, user_id, visibility, workspace_id ON files
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'files', 'user_id', 'visibility', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_knowledge_bases
	AFTER INSERT OR DELETE OR UPDATE OF description, is_public, name, type, user_id, visibility, workspace_id ON knowledge_bases
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'knowledgeBases', 'is_public', 'user_id', 'visibility', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_chat_groups
	AFTER INSERT OR DELETE OR UPDATE OF content, description, group_id, title, user_id, visibility, workspace_id ON chat_groups
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'chatGroups', 'user_id', 'visibility', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_documents
	AFTER INSERT OR DELETE OR UPDATE OF content, description, file_id, file_type, knowledge_base_id, parent_id, slug, source_type, title, total_char_count, user_id, visibility, workspace_id ON documents
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'documents', 'user_id', 'visibility', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_messages
	AFTER INSERT OR DELETE OR UPDATE OF agent_id, content, group_id, role, session_id, summary, thread_id, topic_id, user_id, workspace_id ON messages
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'messages', 'user_id', 'workspace_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_user_memories
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, details, memory_category, memory_layer, status, summary, tags, title, user_id ON user_memories
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'userMemories', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_user_memories_fanout
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, details, memory_category, memory_layer, status, summary, tags, title, user_id ON user_memories
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_memory_fanout();--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_memory_contexts
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, current_status, description, tags, title, type, user_id, user_memory_ids ON user_memories_contexts
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'memoryContexts', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_memory_preferences
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, conclusion_directives, suggestions, tags, type, user_id, user_memory_id ON user_memories_preferences
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'memoryPreferences', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_memory_activities
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, ends_at, feedback, narrative, notes, starts_at, status, tags, type, user_id, user_memory_id ON user_memories_activities
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'memoryActivities', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_memory_identities
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, description, episodic_date, relationship, role, tags, type, user_id, user_memory_id ON user_memories_identities
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'memoryIdentities', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_memory_experiences
	AFTER INSERT OR DELETE OR UPDATE OF action, captured_at, key_learning, possible_outcome, reasoning, situation, tags, type, user_id, user_memory_id ON user_memories_experiences
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'memoryExperiences', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_persona_documents
	AFTER INSERT OR DELETE OR UPDATE OF captured_at, persona, profile, tagline, user_id, version ON user_memory_persona_documents
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_change(
		'personaDocuments', 'user_id'
	);--> statement-breakpoint

CREATE OR REPLACE TRIGGER search_sync_knowledge_base_files
	AFTER INSERT OR DELETE OR UPDATE OF file_id, knowledge_base_id ON knowledge_base_files
	FOR EACH ROW EXECUTE FUNCTION capture_search_sync_knowledge_base_files();--> statement-breakpoint
SET lock_timeout = DEFAULT;
