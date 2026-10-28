CREATE TABLE "tracked_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"wecom_userid" text NOT NULL,
	"source" text DEFAULT 'github' NOT NULL,
	"kind" text DEFAULT 'repo' NOT NULL,
	"identifier" text NOT NULL,
	"display_name" text NOT NULL,
	"cursor" jsonb DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_change_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_items_user_source_kind_identifier_unique" UNIQUE("wecom_userid","source","kind","identifier")
);
--> statement-breakpoint
CREATE INDEX "tracked_items_active_checked_idx" ON "tracked_items" USING btree ("active","last_checked_at");