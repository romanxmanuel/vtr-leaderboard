import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

const SHEET_ID = process.env.LEADERBOARD_SHEET_ID || "YOUR_SHEET_ID_HERE";
const SALES_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=Sales%20Feed`;
const AGENTS_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=Agents`;
const TIME_ZONE = "America/New_York";
const CACHE_ID = 1;
const FRESH_FOR_MS = 20_000;

const saleSchema = z.object({
  id: z.string(),
  agent: z.string(),
  team: z.string(),
  carrier: z.string(),
  policyType: z.string(),
  photoUrl: z.string().nullable(),
  ap: z.number(),
  saleDay: z.string(),
  occurredAt: z.string(),
});

const agentSchema = z.object({
  rank: z.number().int(),
  name: z.string(),
  team: z.string(),
  policies: z.number().int(),
  ap: z.number(),
  average: z.number(),
  policyTypes: z.array(z.string()),
  photoUrl: z.string().nullable(),
});

const leaderboardResponse = z.object({
  source: z.object({
    status: z.enum(["live", "stale", "error"]),
    fetchedAt: z.string(),
    error: z.string().nullable(),
    sourceRowCount: z.number().int().nonnegative(),
    invalidRowCount: z.number().int().nonnegative(),
    timezone: z.string(),
  }),
  periods: z.object({
    todayLabel: z.string(),
    weekLabel: z.string(),
    monthLabel: z.string(),
    yearLabel: z.string(),
  }),
  today: z.object({ ap: z.number(), policies: z.number().int(), average: z.number() }),
  week: z.object({ ap: z.number(), policies: z.number().int(), average: z.number() }),
  month: z.object({ ap: z.number(), policies: z.number().int(), average: z.number() }),
  year: z.object({ ap: z.number(), policies: z.number().int(), average: z.number() }),
  agents: z.array(agentSchema),
  weekAgents: z.array(agentSchema),
  monthAgents: z.array(agentSchema),
  yearAgents: z.array(agentSchema),
  teams: z.array(z.object({
    rank: z.number().int(),
    name: z.string(),
    writers: z.number().int(),
    policies: z.number().int(),
    ap: z.number(),
  })),
  premiumPerPolicy: z.array(agentSchema),
  topProducts: z.array(z.object({
    rank: z.number().int(),
    name: z.string(),
    policies: z.number().int(),
    ap: z.number(),
  })),
  recentBigSales: z.array(saleSchema),
  recentSales: z.array(saleSchema),
});

type LeaderboardResponse = z.infer<typeof leaderboardResponse>;
type Sale = z.infer<typeof saleSchema>;
type RawCell = { v?: unknown; f?: string } | null;
type RawRow = { c?: RawCell[] };
type RawColumn = { id?: string; label?: string; type?: string };
type RawTable = { cols?: RawColumn[]; rows?: RawRow[] };
type AgentDirectoryEntry = { name: string; team: string; photoUrl: string | null };


function dayKeyFromInstant(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function mondayKey(todayKey: string, now: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" }).format(now);
  const indexes: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const distance = ((indexes[weekday] ?? 1) + 6) % 7;
  const start = new Date(`${todayKey}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - distance);
  return start.toISOString().slice(0, 10);
}

function monthStartKey(todayKey: string): string {
  return `${todayKey.slice(0, 7)}-01`;
}

function displayPeriod(dayKey: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${dayKey}T12:00:00Z`));
}

function cellText(cell: RawCell): string {
  if (!cell) return "";
  if (typeof cell.v === "string" && /^Date\(/.test(cell.v.trim())) return cell.v.trim();
  if (typeof cell.f === "string" && cell.f.trim()) return cell.f.trim();
  if (cell.v === null || cell.v === undefined) return "";
  return String(cell.v).trim();
}

function normalizedColumnLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizedAgentName(value: string): string {
  const parts = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  return parts.length > 1 ? `${first} ${last.slice(0, 1)}` : first;
}

function currencyValue(value: string): number | null {
  if (!value.trim()) return null;
  const negative = /^\(.*\)$/.test(value.trim());
  const cleaned = value.replace(/[$,()\s]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function corePolicyType(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  const validTypes: Record<string, string> = {
    "whole life": "Whole Life",
    term: "Term",
    iul: "IUL",
    "final expense": "Final Expense",
  };
  return validTypes[normalized] ?? "";
}

function dateParts(value: string): { dayKey: string; instant: Date | null } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const gviz = trimmed.match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})(?:,\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}))?\)$/);
  if (gviz) {
    const year = Number(gviz[1]);
    const monthIndex = Number(gviz[2]);
    const day = Number(gviz[3]);
    if (Number.isFinite(year) && Number.isFinite(monthIndex) && Number.isFinite(day)) {
      const key = `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const hour = Number(gviz[4] ?? 12);
      const minute = Number(gviz[5] ?? 0);
      const second = Number(gviz[6] ?? 0);
      return { dayKey: key, instant: new Date(Date.UTC(year, monthIndex, day, hour, minute, second)) };
    }
  }

  const isoDay = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|T)/);
  if (isoDay) {
    const key = `${isoDay[1] ?? "0000"}-${isoDay[2] ?? "00"}-${isoDay[3] ?? "00"}`;
    const parsed = new Date(trimmed);
    return { dayKey: key, instant: Number.isNaN(parsed.getTime()) ? null : parsed };
  }

  const usDay = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usDay) {
    const month = Number(usDay[1]);
    const day = Number(usDay[2]);
    const year = Number(usDay[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const parsed = new Date(trimmed);
      return { dayKey: key, instant: Number.isNaN(parsed.getTime()) ? null : parsed };
    }
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return { dayKey: dayKeyFromInstant(parsed), instant: parsed };
}

function parseGviz(text: string): { sales: Sale[]; sourceRowCount: number; invalidRowCount: number } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The sheet returned an unreadable response.");
  const decoded = JSON.parse(text.slice(start, end + 1)) as { status?: string; table?: RawTable };
  if (decoded.status !== "ok") throw new Error("The sheet did not return a successful response.");

  const table = decoded.table;
  const rows = table?.rows ?? [];
  const expected = ["Timestamp", "Agent Name", "Team", "Carrier", "Premium (AP)", "Sale Date", "Policy Type"];
  const required = expected;

  const columnIndexes = new Map<string, number>();
  for (const [index, column] of (table?.cols ?? []).entries()) {
    const label = normalizedColumnLabel(column.label ?? "");
    if (label && !columnIndexes.has(label)) columnIndexes.set(label, index);
  }

  // Older GViz responses can expose blank column labels and return the sheet's
  // header as the first row. Keep that shape as a fallback, but prefer the
  // labels in table.cols so actual sales are never mistaken for headers.
  let dataRows = rows;
  if (required.some((name) => !columnIndexes.has(normalizedColumnLabel(name)))) {
    const firstRowLabels = (rows[0]?.c ?? []).map((cell) => normalizedColumnLabel(cellText(cell)));
    const fallbackIndexes = new Map<string, number>();
    for (const [index, label] of firstRowLabels.entries()) {
      if (label && !fallbackIndexes.has(label)) fallbackIndexes.set(label, index);
    }
    if (required.every((name) => fallbackIndexes.has(normalizedColumnLabel(name)))) {
      columnIndexes.clear();
      for (const [label, index] of fallbackIndexes) columnIndexes.set(label, index);
      dataRows = rows.slice(1);
    }
  }

  const indexFor = (name: string): number => columnIndexes.get(normalizedColumnLabel(name)) ?? -1;
  if (required.some((name) => indexFor(name) < 0)) {
    const found = expected.filter((name) => indexFor(name) >= 0).length;
    throw new Error(`The Sales Feed is missing required column labels (${found} of ${expected.length} found).`);
  }

  let invalidRowCount = 0;
  const sales: Sale[] = [];

  for (const [rowIndex, row] of dataRows.entries()) {
    const cells = row.c ?? [];
    const value = (name: string): string => cellText(cells[indexFor(name)] ?? null);
    const agent = value("Agent Name");
    const ap = currencyValue(value("Premium (AP)"));
    const saleDate = dateParts(value("Sale Date"));
    const timestamp = dateParts(value("Timestamp"));
    const policyType = corePolicyType(value("Policy Type"));

    if (!agent || ap === null || ap < 0 || !saleDate) {
      invalidRowCount += 1;
      continue;
    }

    const occurred = timestamp?.instant ?? saleDate.instant ?? new Date(`${saleDate.dayKey}T12:00:00Z`);
    sales.push({
      id: `sale-${saleDate.dayKey}-${rowIndex}`,
      agent,
      team: value("Team") || "Unassigned",
      carrier: value("Carrier") || "Carrier not listed",
      policyType,
      photoUrl: null,
      ap,
      saleDay: saleDate.dayKey,
      occurredAt: occurred.toISOString(),
    });
  }

  // Sale day, not batch-import time, defines recency. Imported rows often share
  // an agent-specific timestamp, which previously grouped the ticker by agent.
  sales.sort((a, b) => b.saleDay.localeCompare(a.saleDay) || b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  return { sales, sourceRowCount: dataRows.length, invalidRowCount };
}

function parseAgentDirectory(text: string): AgentDirectoryEntry[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The Agents tab returned an unreadable response.");
  const decoded = JSON.parse(text.slice(start, end + 1)) as { status?: string; table?: RawTable };
  if (decoded.status !== "ok") throw new Error("The Agents tab did not return a successful response.");

  const table = decoded.table;
  const rows = table?.rows ?? [];
  const required = ["Agent Name", "Team", "Photo URL"];
  const columnIndexes = new Map<string, number>();
  for (const [index, column] of (table?.cols ?? []).entries()) {
    const label = normalizedColumnLabel(column.label ?? "");
    if (label && !columnIndexes.has(label)) columnIndexes.set(label, index);
  }

  let dataRows = rows;
  if (required.some((name) => !columnIndexes.has(normalizedColumnLabel(name)))) {
    const firstRowLabels = (rows[0]?.c ?? []).map((cell) => normalizedColumnLabel(cellText(cell)));
    const fallbackIndexes = new Map<string, number>();
    for (const [index, label] of firstRowLabels.entries()) {
      if (label && !fallbackIndexes.has(label)) fallbackIndexes.set(label, index);
    }
    if (required.every((name) => fallbackIndexes.has(normalizedColumnLabel(name)))) {
      columnIndexes.clear();
      for (const [label, index] of fallbackIndexes) columnIndexes.set(label, index);
      dataRows = rows.slice(1);
    }
  }

  const indexFor = (name: string): number => columnIndexes.get(normalizedColumnLabel(name)) ?? -1;
  if (required.some((name) => indexFor(name) < 0)) {
    throw new Error("The Agents tab must contain Agent Name, Team, and Photo URL columns.");
  }

  const entries = new Map<string, AgentDirectoryEntry>();
  for (const row of dataRows) {
    const cells = row.c ?? [];
    const value = (name: string): string => cellText(cells[indexFor(name)] ?? null);
    const name = value("Agent Name");
    const key = normalizedAgentName(name);
    if (!key || entries.has(key)) continue;
    entries.set(key, {
      name,
      team: value("Team"),
      photoUrl: value("Photo URL") || null,
    });
  }
  return [...entries.values()];
}

async function ownAgentPhotos(ctx: Ctx, sales: Sale[], directory: AgentDirectoryEntry[]): Promise<{ sales: Sale[]; photoByAgent: Map<string, string> }> {
  const db = ctx.db<typeof schema>();
  const cachedRows = await db.select().from(schema.agentPhotos);
  const cachedByAgent = new Map(cachedRows.map((row) => [row.agentKey, row]));
  const sourceByAgent = new Map<string, string>();

  for (const agent of directory) {
    const sourceUrl = agent.photoUrl?.trim();
    if (sourceUrl) sourceByAgent.set(normalizedAgentName(agent.name), sourceUrl);
  }

  const ownedByAgent = new Map<string, string>();
  for (const [agentKey, sourceUrl] of sourceByAgent) {
    const cached = cachedByAgent.get(agentKey);
    if (cached?.sourceUrl === sourceUrl) {
      try {
        ownedByAgent.set(agentKey, await ctx.blobs.getUrl(cached.blobKey, { public: true }));
        continue;
      } catch {
        // Re-fetch below when the cached blob is no longer available.
      }
    }

    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "https:") continue;
      const response = await fetch(parsed.toString(), { headers: { accept: "image/jpeg,image/png,image/webp,image/gif" } });
      if (!response.ok) continue;
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
      if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(contentType)) continue;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000) continue;
      const safeAgent = agentKey.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
      const blobKey = `agent-photos/${safeAgent}-${Date.now()}`;
      await ctx.blobs.put(blobKey, bytes, { contentType, public: true });
      await db.insert(schema.agentPhotos).values({
        agentKey,
        sourceUrl,
        blobKey,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: schema.agentPhotos.agentKey,
        set: { sourceUrl, blobKey, updatedAt: new Date() },
      });
      ownedByAgent.set(agentKey, await ctx.blobs.getUrl(blobKey, { public: true }));
      if (cached && cached.blobKey !== blobKey) {
        try { await ctx.blobs.delete(cached.blobKey); } catch { /* Old photo cleanup is best effort. */ }
      }
    } catch {
      // A bad photo must never stop production totals from refreshing.
    }
  }

  return {
    sales: sales.map((sale) => ({
      ...sale,
      photoUrl: ownedByAgent.get(normalizedAgentName(sale.agent)) ?? null,
    })),
    photoByAgent: ownedByAgent,
  };
}

function aggregate(
  sales: Sale[],
  fetchedAt: Date,
  status: "live" | "stale" | "error",
  error: string | null,
  sourceRowCount: number,
  invalidRowCount: number,
  directory: AgentDirectoryEntry[] = [],
  photoByAgent: Map<string, string> = new Map(),
): LeaderboardResponse {
  const todayKey = dayKeyFromInstant(fetchedAt);
  const weekKey = mondayKey(todayKey, fetchedAt);
  const monthKey = monthStartKey(todayKey);
  const yearKey = `${todayKey.slice(0, 4)}-01-01`;
  const todaySales = sales.filter((sale) => sale.saleDay === todayKey);
  const weekSales = sales.filter((sale) => sale.saleDay >= weekKey && sale.saleDay <= todayKey);
  const monthSales = sales.filter((sale) => sale.saleDay >= monthKey && sale.saleDay <= todayKey);
  const yearSales = sales.filter((sale) => sale.saleDay >= yearKey && sale.saleDay <= todayKey);
  const sum = (rows: Sale[]): number => rows.reduce((total, sale) => total + sale.ap, 0);

  const directoryByAgent = new Map(directory.map((agent) => [normalizedAgentName(agent.name), agent]));
  const rankAgents = (rows: Sale[]) => {
    const agentMap = new Map<string, {
      name: string;
      team: string;
      policies: number;
      ap: number;
      policyTypes: Set<string>;
      photoUrl: string | null;
    }>();
    for (const sale of rows) {
      const key = normalizedAgentName(sale.agent);
      const profile = directoryByAgent.get(key);
      const current = agentMap.get(key) ?? {
        name: profile?.name ?? sale.agent,
        team: sale.team || profile?.team || "Unassigned",
        policies: 0,
        ap: 0,
        policyTypes: new Set<string>(),
        photoUrl: photoByAgent.get(key) ?? sale.photoUrl,
      };
      current.policies += 1;
      current.ap += sale.ap;
      if (sale.policyType) current.policyTypes.add(sale.policyType);
      if (!current.photoUrl && sale.photoUrl) current.photoUrl = sale.photoUrl;
      agentMap.set(key, current);
    }
    return [...agentMap.values()]
      .sort((a, b) => b.ap - a.ap || b.policies - a.policies || a.name.localeCompare(b.name))
      .map((agent, index) => ({
        name: agent.name,
        team: agent.team,
        policies: agent.policies,
        ap: agent.ap,
        policyTypes: [...agent.policyTypes].sort(),
        photoUrl: agent.photoUrl,
        rank: index + 1,
        average: agent.policies ? agent.ap / agent.policies : 0,
      })).slice(0, 10);
  };
  const agents = rankAgents(todaySales);
  const weekAgents = rankAgents(weekSales);
  const monthAgents = rankAgents(monthSales);
  const yearAgents = rankAgents(yearSales);

  const teamMap = new Map<string, { name: string; writers: Set<string>; policies: number; ap: number }>();
  for (const sale of yearSales) {
    const current = teamMap.get(sale.team) ?? { name: sale.team, writers: new Set<string>(), policies: 0, ap: 0 };
    current.writers.add(sale.agent);
    current.policies += 1;
    current.ap += sale.ap;
    teamMap.set(sale.team, current);
  }
  const teamsBase = [...teamMap.values()].sort((a, b) => b.ap - a.ap || b.policies - a.policies || a.name.localeCompare(b.name));
  const teams = teamsBase.map((team, index) => ({ rank: index + 1, name: team.name, writers: team.writers.size, policies: team.policies, ap: team.ap }));

  const premiumPerPolicy = yearAgents
    .filter((agent) => agent.policies > 0)
    .sort((a, b) => b.average - a.average || b.ap - a.ap || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((agent, index) => ({ ...agent, rank: index + 1 }));

  const productMap = new Map<string, { name: string; policies: number; ap: number }>();
  for (const sale of yearSales) {
    if (!sale.policyType) continue;
    const name = sale.policyType;
    const current = productMap.get(name) ?? { name, policies: 0, ap: 0 };
    current.policies += 1;
    current.ap += sale.ap;
    productMap.set(name, current);
  }
  const topProducts = [...productMap.values()]
    .sort((a, b) => b.ap - a.ap || b.policies - a.policies || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((product, index) => ({ ...product, rank: index + 1 }));
  const recentBigSales = [...yearSales]
    .sort((a, b) => b.ap - a.ap || b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 8);

  const todayAp = sum(todaySales);
  return {
    source: {
      status,
      fetchedAt: fetchedAt.toISOString(),
      error,
      sourceRowCount,
      invalidRowCount,
      timezone: TIME_ZONE,
    },
    periods: {
      todayLabel: displayPeriod(todayKey, { month: "short", day: "numeric" }),
      weekLabel: `Since ${displayPeriod(weekKey, { month: "short", day: "numeric" })}`,
      monthLabel: displayPeriod(monthKey, { month: "long", year: "numeric" }),
      yearLabel: displayPeriod(yearKey, { year: "numeric" }),
    },
    today: { ap: todayAp, policies: todaySales.length, average: todaySales.length ? todayAp / todaySales.length : 0 },
    week: { ap: sum(weekSales), policies: weekSales.length, average: weekSales.length ? sum(weekSales) / weekSales.length : 0 },
    month: { ap: sum(monthSales), policies: monthSales.length, average: monthSales.length ? sum(monthSales) / monthSales.length : 0 },
    year: { ap: sum(yearSales), policies: yearSales.length, average: yearSales.length ? sum(yearSales) / yearSales.length : 0 },
    agents,
    weekAgents,
    monthAgents,
    yearAgents,
    teams,
    premiumPerPolicy,
    topProducts,
    recentBigSales,
    recentSales: sales.slice(0, 10),
  };
}

async function readCached(ctx: Ctx): Promise<{ data: LeaderboardResponse; ageMs: number } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.leaderboardCache).limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    const data = leaderboardResponse.parse(JSON.parse(row.payload));
    return { data, ageMs: Math.max(0, Date.now() - row.fetchedAt.getTime()) };
  } catch {
    return null;
  }
}

async function refresh(ctx: Ctx): Promise<LeaderboardResponse> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  try {
    const [salesResponse, agentDirectory] = await Promise.all([
      fetch(SALES_SHEET_URL, { headers: { accept: "application/javascript,text/plain;q=0.9" } }),
      fetch(AGENTS_SHEET_URL, { headers: { accept: "application/javascript,text/plain;q=0.9" } })
        .then(async (response) => response.ok ? parseAgentDirectory(await response.text()) : [])
        .catch(() => [] as AgentDirectoryEntry[]),
    ]);
    if (!salesResponse.ok) throw new Error(`The Sales Feed returned HTTP ${salesResponse.status}.`);
    const parsed = parseGviz(await salesResponse.text());
    const owned = await ownAgentPhotos(ctx, parsed.sales, agentDirectory);
    const data = aggregate(owned.sales, now, "live", null, parsed.sourceRowCount, parsed.invalidRowCount, agentDirectory, owned.photoByAgent);
    await db.insert(schema.leaderboardCache).values({
      id: CACHE_ID,
      payload: JSON.stringify(data),
      fetchedAt: now,
      sourceRowCount: parsed.sourceRowCount,
      invalidRowCount: parsed.invalidRowCount,
      lastError: null,
    }).onConflictDoUpdate({
      target: schema.leaderboardCache.id,
      set: {
        payload: JSON.stringify(data),
        fetchedAt: now,
        sourceRowCount: parsed.sourceRowCount,
        invalidRowCount: parsed.invalidRowCount,
        lastError: null,
      },
    });
    ctx.invalidateQueries();
    return data;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "The sales feed could not be refreshed.";
    const cached = await readCached(ctx);
    if (cached) {
      const stale = { ...cached.data, source: { ...cached.data.source, status: "stale" as const, error: message } };
      await db.update(schema.leaderboardCache).set({ payload: JSON.stringify(stale), lastError: message }).where(eq(schema.leaderboardCache.id, CACHE_ID));
      return stale;
    }
    return aggregate([], now, "error", message, 0, 0);
  }
}

export const Actions = {
  getLeaderboard: defineAction({
    request: z.object({}),
    response: leaderboardResponse,
    async handler(ctx): Promise<LeaderboardResponse> {
      const cached = await readCached(ctx);
      if (cached && cached.ageMs < FRESH_FOR_MS) return cached.data;
      return refresh(ctx);
    },
  }),

  refreshLeaderboard: defineAction({
    request: z.object({}),
    response: leaderboardResponse,
    async handler(ctx): Promise<LeaderboardResponse> {
      return refresh(ctx);
    },
  }),
} satisfies ActionsModule;
