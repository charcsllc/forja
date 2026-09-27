ALTER TABLE "projects" ADD COLUMN "server_error" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_error" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_noop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_sha" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "rebuild_env_hash" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version_recovery" jsonb;