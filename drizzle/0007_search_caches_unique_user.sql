-- search_caches 每用户至多一行：此前靠 saveRecentResults 的 delete+insert 约定维持，
-- 并发窗口下会出现「删了还没插上」的另一用户读到空缓存。加数据库唯一约束后，
-- 写入改为原子 upsert（ON CONFLICT DO UPDATE），中间态由数据库消除。
--> statement-breakpoint
DELETE FROM "search_caches" WHERE "id" NOT IN (
  SELECT MIN("id") FROM "search_caches" GROUP BY "wecom_userid"
);--> statement-breakpoint
ALTER TABLE "search_caches" ADD CONSTRAINT "search_caches_wecom_userid_unique" UNIQUE("wecom_userid");--> statement-breakpoint
CREATE INDEX "search_caches_userid_idx" ON "search_caches" USING btree ("wecom_userid");
