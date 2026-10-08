import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const leaderboardCache = sqliteTable("leaderboard_cache", {
  id: integer("id").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  sourceRowCount: integer("source_row_count").notNull().default(0),
  invalidRowCount: integer("invalid_row_count").notNull().default(0),
  lastError: text("last_error"),
});

export const agentPhotos = sqliteTable("agent_photos", {
  agentKey: text("agent_key").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  blobKey: text("blob_key").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
