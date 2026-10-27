CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"userid" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"ok" boolean NOT NULL,
	"total_ms" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_kind_created_at_idx" ON "agent_runs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_user_created_at_idx" ON "agent_runs" USING btree ("userid","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_run_id_idx" ON "tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_calls_created_at_idx" ON "tool_calls" USING btree ("created_at");