CREATE TABLE IF NOT EXISTS "nexus_registry_safety_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"verdict" text NOT NULL,
	"risk_score" integer NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" text NOT NULL,
	"content_hash" text,
	"model" text,
	"provider" text,
	"duration_ms" integer,
	"error" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nexus_registry_review_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"scan_id" text,
	"risk_snapshot" jsonb,
	"ip_address" text,
	"user_agent" text,
	"item_identifier" text,
	"item_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexus_registry_safety_scans" DROP CONSTRAINT IF EXISTS "nexus_registry_safety_scans_item_id_nexus_registry_items_id_fk";--> statement-breakpoint
ALTER TABLE "nexus_registry_safety_scans" ADD CONSTRAINT "nexus_registry_safety_scans_item_id_nexus_registry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."nexus_registry_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexus_registry_review_actions" DROP CONSTRAINT IF EXISTS "nexus_registry_review_actions_item_id_nexus_registry_items_id_fk";--> statement-breakpoint
ALTER TABLE "nexus_registry_review_actions" ADD CONSTRAINT "nexus_registry_review_actions_item_id_nexus_registry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."nexus_registry_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexus_registry_review_actions" DROP CONSTRAINT IF EXISTS "nexus_registry_review_actions_scan_id_nexus_registry_safety_scans_id_fk";--> statement-breakpoint
ALTER TABLE "nexus_registry_review_actions" ADD CONSTRAINT "nexus_registry_review_actions_scan_id_nexus_registry_safety_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."nexus_registry_safety_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_safety_scans_item_id_created_at_idx" ON "nexus_registry_safety_scans" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_safety_scans_verdict_idx" ON "nexus_registry_safety_scans" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_review_actions_item_id_created_at_idx" ON "nexus_registry_review_actions" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_review_actions_reviewer_id_idx" ON "nexus_registry_review_actions" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_review_actions_action_idx" ON "nexus_registry_review_actions" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nexus_registry_review_actions_scan_id_idx" ON "nexus_registry_review_actions" USING btree ("scan_id");
