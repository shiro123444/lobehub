CREATE TABLE "nexus_legacy_user_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"import_batch_id" text,
	"legacy_created_at" timestamp with time zone,
	"legacy_student_id" text NOT NULL,
	"legacy_user_id" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'kiro-kroxy' NOT NULL,
	"user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexus_legacy_user_mappings" ADD CONSTRAINT "nexus_legacy_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nexus_legacy_user_mappings_source_legacy_user_id_idx" ON "nexus_legacy_user_mappings" USING btree ("source","legacy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nexus_legacy_user_mappings_source_legacy_student_id_idx" ON "nexus_legacy_user_mappings" USING btree ("source","legacy_student_id");--> statement-breakpoint
CREATE INDEX "nexus_legacy_user_mappings_user_id_idx" ON "nexus_legacy_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "nexus_legacy_user_mappings_import_batch_id_idx" ON "nexus_legacy_user_mappings" USING btree ("import_batch_id");