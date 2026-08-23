CREATE TABLE "nexus_im_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"avatar" text,
	"display_name" text,
	"external_id" text NOT NULL,
	"group_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" text DEFAULT 'qq' NOT NULL,
	"user_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nexus_im_login_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"group_id" text,
	"identity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" text DEFAULT 'qq' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nexus_im_identities" ADD CONSTRAINT "nexus_im_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexus_im_login_codes" ADD CONSTRAINT "nexus_im_login_codes_identity_id_nexus_im_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."nexus_im_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nexus_im_login_codes" ADD CONSTRAINT "nexus_im_login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nexus_im_identities_provider_external_id_idx" ON "nexus_im_identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "nexus_im_identities_user_id_idx" ON "nexus_im_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "nexus_im_identities_provider_group_id_idx" ON "nexus_im_identities" USING btree ("provider","group_id");--> statement-breakpoint
CREATE INDEX "nexus_im_login_codes_code_hash_idx" ON "nexus_im_login_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "nexus_im_login_codes_status_expires_at_idx" ON "nexus_im_login_codes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "nexus_im_login_codes_user_id_idx" ON "nexus_im_login_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "nexus_im_login_codes_identity_id_idx" ON "nexus_im_login_codes" USING btree ("identity_id");