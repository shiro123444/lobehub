CREATE TABLE IF NOT EXISTS "nexus_registry_items" (
	"id" text PRIMARY KEY NOT NULL,
	"author_avatar_url" text,
	"author_name" text,
	"author_url" text,
	"category" text,
	"description" text,
	"download_url" text,
	"homepage_url" text,
	"identifier" text NOT NULL,
	"kind" text NOT NULL,
	"locale" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"name" text NOT NULL,
	"published_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repository_url" text,
	"source" text DEFAULT 'official' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"submitted_by" text,
	"sync_run_id" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"upstream_identifier" text,
	"upstream_source" text,
	"version" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexus_registry_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'lobehub' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexus_registry_items" DROP CONSTRAINT IF EXISTS "nexus_registry_items_submitted_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "nexus_registry_items" ADD CONSTRAINT "nexus_registry_items_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nexus_registry_items_kind_source_identifier_idx" ON "nexus_registry_items" USING btree ("kind","source","identifier");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nexus_registry_items_upstream_idx" ON "nexus_registry_items" USING btree ("kind","upstream_source","upstream_identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_items_kind_status_idx" ON "nexus_registry_items" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_items_source_idx" ON "nexus_registry_items" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_items_category_idx" ON "nexus_registry_items" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_items_submitted_by_idx" ON "nexus_registry_items" USING btree ("submitted_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_items_sync_run_id_idx" ON "nexus_registry_items" USING btree ("sync_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_sync_runs_kind_started_at_idx" ON "nexus_registry_sync_runs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_sync_runs_source_status_idx" ON "nexus_registry_sync_runs" USING btree ("source","status");
