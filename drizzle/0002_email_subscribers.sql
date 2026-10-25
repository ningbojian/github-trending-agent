CREATE TABLE "email_subscribers" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"confirm_token" text,
	"unsub_token" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"preferences" jsonb DEFAULT '{"pushTime":"09:00","intervalDays":1,"digestCount":15,"languages":[],"keywords":[]}' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"confirm_sent_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "email_subscribers_email_unique" UNIQUE("email"),
	CONSTRAINT "email_subscribers_unsub_token_unique" UNIQUE("unsub_token")
);
