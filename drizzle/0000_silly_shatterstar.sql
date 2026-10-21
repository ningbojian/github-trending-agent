CREATE TABLE "favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"wecom_userid" text NOT NULL,
	"full_name" text NOT NULL,
	"starred_on_github" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_wecom_userid_full_name_unique" UNIQUE("wecom_userid","full_name")
);
--> statement-breakpoint
CREATE TABLE "kv_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"full_name" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"description" text,
	"language" text,
	"topics" jsonb NOT NULL,
	"stars" integer NOT NULL,
	"html_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_caches" (
	"id" serial PRIMARY KEY NOT NULL,
	"wecom_userid" text NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" serial PRIMARY KEY NOT NULL,
	"wecom_userid" text NOT NULL,
	"display_name" text NOT NULL,
	"preferences" jsonb DEFAULT '{"languages":[],"keywords":[]}' NOT NULL,
	"github_login" text,
	"github_token_enc" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_wecom_userid_unique" UNIQUE("wecom_userid")
);
--> statement-breakpoint
CREATE TABLE "trending_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"date" date NOT NULL,
	"period" text NOT NULL,
	"language" text NOT NULL,
	"rank" integer NOT NULL,
	"stars_at_capture" integer NOT NULL,
	"stars_delta" integer NOT NULL,
	"is_new" boolean NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "trending_entries_date_period_language_full_name_unique" UNIQUE("date","period","language","full_name")
);
--> statement-breakpoint
ALTER TABLE "trending_entries" ADD CONSTRAINT "trending_entries_full_name_repos_full_name_fk" FOREIGN KEY ("full_name") REFERENCES "public"."repos"("full_name") ON DELETE cascade ON UPDATE no action;