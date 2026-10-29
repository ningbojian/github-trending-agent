CREATE TABLE "source_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"item_type" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"author" text,
	"description" text,
	"topics" jsonb DEFAULT '[]' NOT NULL,
	"metrics" jsonb DEFAULT '{}' NOT NULL,
	"raw" jsonb,
	"captured_date" date NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_items_source_id_date_unique" UNIQUE("source","source_id","captured_date")
);
--> statement-breakpoint
CREATE INDEX "source_items_source_date_idx" ON "source_items" USING btree ("source","captured_date");--> statement-breakpoint
CREATE INDEX "source_items_source_item_date_idx" ON "source_items" USING btree ("source","source_id","captured_date");