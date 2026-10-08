import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiResponse } from "./api";
import vtrShield from "./assets/vtr-shield-transparent.png";

type Leaderboard = ApiResponse<typeof api, "getLeaderboard">;
type Agent = Leaderboard["agents"][number];
type Team = Leaderboard["teams"][number];
type Sale = Leaderboard["recentSales"][number];
type Product = Leaderboard["topProducts"][number];
type PeriodKey = "today" | "week" | "month" | "year";

const SCREEN_COUNT = 3;
const ROTATION_MS = 15_000;
const IDLE_RESUME_MS = 30_000;
const SEEN_SALES_KEY = "vtr-leaderboard-seen-sales-v2";
const LEGACY_SEEN_POLICIES_KEY = "vtr-leaderboard-seen-policies-v1";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function displayCarrier(name: string): string {
  return name.replace(/\bFidelity Life\b|\bFidelity\b/gi, "InstaBrain");
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

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Update time unavailable";
  return `Updated ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)}`;
}

function saleDetail(sale: Sale): string {
  const policyType = corePolicyType(sale.policyType);
  return policyType ? `${policyType} - ${displayCarrier(sale.carrier)}` : displayCarrier(sale.carrier);
}

function saleLine(sale: Sale): string {
  return `${sale.agent} - ${money.format(sale.ap)} - ${saleDetail(sale)}`;
}

function displayPolicyTypes(values: string[]): string {
  return [...new Set(values.map(corePolicyType).filter(Boolean))].slice(0, 2).join(" / ");
}

function AgentAvatar({ name, photoUrl, className = "avatar" }: { name: string; photoUrl: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoUrl]);
  if (photoUrl && !failed) return <img className={`${className} agent-photo`} src={photoUrl} alt={`${name} profile`} onError={() => setFailed(true)} />;
  return <span className={className} aria-hidden="true">{initials(name)}</span>;
}

function PeriodTabs({ active, onChange }: { active: PeriodKey; onChange: (period: PeriodKey) => void }) {
  const tabs: Array<{ key: PeriodKey; label: string }> = [
    { key: "today", label: "Today" },
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
    { key: "year", label: "YTD" },
  ];
  return (
    <div className="period-tabs" role="tablist" aria-label="Leaderboard period">
      {tabs.map((tab) => (
        <button key={tab.key} type="button" role="tab" aria-selected={active === tab.key} className={active === tab.key ? "is-active" : ""} onClick={() => onChange(tab.key)}>{tab.label}</button>
      ))}
    </div>
  );
}

function BroadcastHeader({ data, period, onPeriodChange, refreshing, onRefresh }: {
  data?: Leaderboard;
  period: PeriodKey;
  onPeriodChange: (period: PeriodKey) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="broadcast-header">
      <div className="brand-mark"><img src={vtrShield} alt="VTR Financial Group shield" /></div>
      <div className="broadcast-header__message">
        <span>SALES ARE LIVE</span>
        <strong>Disposition. Get ranked.</strong>
      </div>
      <PeriodTabs active={period} onChange={onPeriodChange} />
      <button className="sync-button" type="button" onClick={onRefresh} disabled={refreshing}>
        <span className={`status-dot status-dot--${data?.source.status ?? "loading"}`} aria-hidden="true" />
        <span>{refreshing ? "Refreshing" : data ? formatUpdated(data.source.fetchedAt) : "Connecting"}</span>
      </button>
    </header>
  );
}

function Ticker({ sales, highlightedId }: { sales: Sale[]; highlightedId: string | null }) {
  const items = sales.slice(0, 8);
  if (items.length === 0) return <div className="ticker__empty">Waiting for the first submitted sale.</div>;
  return (
    <div className="ticker__viewport" aria-label="Recent live sales">
      <div className="ticker__track">
        {[...items, ...items].map((sale, index) => (
          <span className={`ticker__item ${sale.id === highlightedId ? "ticker__item--new" : ""}`} key={`${sale.id}-${index}`} aria-hidden={index >= items.length}>
            <AgentAvatar name={sale.agent} photoUrl={sale.photoUrl} className="ticker-avatar" />
            <strong>{saleLine(sale)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function LiveTicker({ sales, highlightedId }: { sales: Sale[]; highlightedId: string | null }) {
  return (
    <section className="ticker" aria-label="Live sales ticker">
      <div className="live-badge"><span aria-hidden="true" /> LIVE SALES</div>
      <Ticker sales={sales} highlightedId={highlightedId} />
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="empty-state"><span aria-hidden="true" />{children}</div>;
}

function LeaderboardRows({ agents, featured = false }: { agents: Agent[]; featured?: boolean }) {
  if (!agents.length) return <EmptyState>No submitted sales in this period yet.</EmptyState>;
  return (
    <ol className={featured ? "leaderboard-list leaderboard-list--featured" : "leaderboard-list"}>
      {agents.slice(0, 10).map((agent, index) => (
        <li key={`${agent.name}-${agent.team}`} className={index < 3 ? `top-rank top-rank--${index + 1}` : ""}>
          <span className="rank-number">{index + 1}</span>
          <AgentAvatar name={agent.name} photoUrl={agent.photoUrl} />
          <span className="agent-identity"><strong>{agent.name}</strong><small>{agent.team}{displayPolicyTypes(agent.policyTypes) ? ` · ${displayPolicyTypes(agent.policyTypes)}` : ""}</small></span>
          <span className="policy-count"><strong>{agent.policies}</strong><small>{agent.policies === 1 ? "sale" : "sales"}</small></span>
          <strong className="ap-number">{money.format(agent.ap)}</strong>
        </li>
      ))}
    </ol>
  );
}

function RecentSales({ sales, limit = 7, onReplay }: { sales: Sale[]; limit?: number; onReplay: (sale: Sale) => void }) {
  if (!sales.length) return <EmptyState>New sales appear here the moment they hit the feed.</EmptyState>;
  return (
    <ol className="recent-list">
      {sales.slice(0, limit).map((sale) => (
        <li key={sale.id}>
          <button type="button" onClick={() => onReplay(sale)} aria-label={`Replay celebration: ${saleLine(sale)}`}>
            <AgentAvatar name={sale.agent} photoUrl={sale.photoUrl} className="mini-avatar" />
            <strong>{saleLine(sale)}</strong>
            <span className="replay-mark" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ol>
  );
}

function BoardHeader({ kicker, title, tag }: { kicker: string; title: string; tag?: string }) {
  return <header className="board-header"><span><small>{kicker}</small><strong>{title}</strong></span>{tag ? <b>{tag}</b> : null}</header>;
}

function DashboardScreen({ agents, stats, label, sales, onReplay }: { agents: Agent[]; stats: { ap: number; policies: number; average: number }; label: string; sales: Sale[]; onReplay: (sale: Sale) => void }) {
  return (
    <section className="screen screen--dashboard" aria-label="Sales leaderboard dashboard">
      <div className="leaderboard-panel panel">
        <BoardHeader kicker={`${label} · Ranked by annual premium`} title="TOP 10 AGENTS" tag="AP" />
        <LeaderboardRows agents={agents} />
      </div>
      <aside className="dashboard-side">
        <section className="score-hero panel">
          <span>{label} PRODUCTION</span>
          <strong>{money.format(stats.ap)}</strong>
          <div><b>{stats.policies}</b><small>submitted sales</small><b>{money.format(stats.average)}</b><small>average AP</small></div>
        </section>
        <section className="panel recent-panel">
          <BoardHeader kicker="Most recent dispositions" title="RECENT SALES" />
          <RecentSales sales={sales} limit={6} onReplay={onReplay} />
        </section>
        <div className="disposition-callout"><strong>CLOSE IT. DISPO IT.</strong></div>
      </aside>
    </section>
  );
}

function PodiumScreen({ agents, label }: { agents: Agent[]; label: string }) {
  const topThree = agents.slice(0, 3);
  return (
    <section className="screen screen--champions" aria-label="Top agents">
      <div className="champions-title"><span>{label}</span><strong>THE LEADERS</strong></div>
      {topThree.length ? (
        <div className="podium">
          {[1, 0, 2].map((sourceIndex, displayIndex) => {
            const agent = topThree[sourceIndex];
            if (!agent) return <div key={sourceIndex} className="podium-card podium-card--empty" />;
            const rank = sourceIndex + 1;
            return (
              <article key={agent.name} className={`podium-card podium-card--${rank}`}>
                <span className="podium-card__rank">#{rank}</span>
                <AgentAvatar name={agent.name} photoUrl={agent.photoUrl} className="podium-avatar" />
                <h2>{agent.name}</h2><p>{agent.team}</p><strong>{money.format(agent.ap)}</strong><small>{agent.policies} {agent.policies === 1 ? "sale" : "sales"}</small>
                {displayIndex === 1 ? <i>LEADING THE BOARD</i> : null}
              </article>
            );
          })}
        </div>
      ) : <EmptyState>No submitted sales in this period yet.</EmptyState>}
      <section className="chase-panel panel"><BoardHeader kicker="Ranks 4–10" title="THE CHASE" /><LeaderboardRows agents={agents.slice(3)} featured /></section>
    </section>
  );
}

function TeamRows({ teams }: { teams: Team[] }) {
  if (!teams.length) return <EmptyState>Team standings will appear with submitted sales.</EmptyState>;
  return <ol className="stat-list">{teams.slice(0, 6).map((team) => <li key={team.name}><span className="stat-rank">{team.rank}</span><span><strong>{team.name}</strong><small>{team.writers} writers · {team.policies} sales</small></span><b>{money.format(team.ap)}</b></li>)}</ol>;
}

function ProductRows({ products }: { products: Product[] }) {
  const validProducts = products
    .map((product) => ({ ...product, name: corePolicyType(product.name) }))
    .filter((product) => Boolean(product.name));
  if (!validProducts.length) return <EmptyState>Product mix appears when a valid product type is recorded.</EmptyState>;
  return <ol className="stat-list">{validProducts.slice(0, 6).map((product) => <li key={product.name}><span className="stat-rank">{product.rank}</span><span><strong>{product.name}</strong><small>{product.policies} {product.policies === 1 ? "sale" : "sales"}</small></span><b>{money.format(product.ap)}</b></li>)}</ol>;
}

function StatsScreen({ teams, products, sales, onReplay }: { teams: Team[]; products: Product[]; sales: Sale[]; onReplay: (sale: Sale) => void }) {
  return (
    <section className="screen screen--stats" aria-label="Sales statistics">
      <section className="panel"><BoardHeader kicker="Year to date · ranked by AP" title="TEAM STANDINGS" /><TeamRows teams={teams} /></section>
      <section className="panel"><BoardHeader kicker="Year to date · recorded types" title="TOP PRODUCTS" /><ProductRows products={products} /></section>
      <section className="panel"><BoardHeader kicker="Largest annual premium" title="BIG SALES" /><RecentSales sales={sales} limit={6} onReplay={onReplay} /></section>
    </section>
  );
}

function Celebration({ sale, onDismiss }: { sale: Sale; onDismiss: () => void }) {
  const confetti = useMemo(() => Array.from({ length: 42 }, (_, index) => ({ id: index, left: (index * 37) % 100, delay: (index % 9) * 0.08, duration: 2.7 + (index % 6) * 0.18, color: ["#60a5fa", "#fbbf24", "#ffffff", "#2563eb"][index % 4] ?? "#60a5fa" })), []);
  return (
    <button type="button" className="celebration" onClick={onDismiss} aria-label={`Dismiss new sale celebration for ${sale.agent}`}>
      <span className="celebration__flash" aria-hidden="true" />
      <svg className="celebration__lightning" viewBox="0 0 1200 700" aria-hidden="true"><path d="M120 20 360 250 258 278 470 650" /><path d="M1080 30 830 245 945 282 735 660" /><path d="M610 0 545 175 635 165 575 345" /></svg>
      <span className="confetti" aria-hidden="true">{confetti.map((piece) => <i key={piece.id} style={{ left: `${piece.left}%`, animationDelay: `${piece.delay}s`, animationDuration: `${piece.duration}s`, background: piece.color }} />)}</span>
      <span className="celebration__content"><AgentAvatar name={sale.agent} photoUrl={sale.photoUrl} className="celebration__avatar" /><span className="celebration__agent">{sale.agent}</span><span className="celebration__label">NEW SALE</span><strong>{money.format(sale.ap)}</strong><span className="celebration__detail">{saleDetail(sale)}</span><small>Click anywhere to dismiss</small></span>
    </button>
  );
}

function ScreenControls({ active, paused, onPrevious, onNext, onSelect }: { active: number; paused: boolean; onPrevious: () => void; onNext: () => void; onSelect: (index: number) => void }) {
  const labels = ["Leaderboard", "Champions", "Stats"];
  return (
    <nav className="screen-controls" aria-label="TV screens">
      <button type="button" onClick={onPrevious} aria-label="Previous screen">‹</button>
      <div>{labels.map((label, index) => <button type="button" key={label} className={active === index ? "is-active" : ""} onClick={() => onSelect(index)} aria-label={`Show ${label} screen`} aria-current={active === index ? "page" : undefined} />)}</div>
      <span>{labels[active] ?? "Leaderboard"} · {paused ? "Paused" : "15 sec"}</span>
      <i className={paused ? "rotation-progress is-paused" : "rotation-progress"} key={`${active}-${paused}`} />
      <button type="button" onClick={onNext} aria-label="Next screen">›</button>
    </nav>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [activeScreen, setActiveScreen] = useState(0);
  const [period, setPeriod] = useState<PeriodKey>("year");
  const [rotationPaused, setRotationPaused] = useState(false);
  const [celebration, setCelebration] = useState<Sale | null>(null);
  const [celebrationQueue, setCelebrationQueue] = useState<Sale[]>([]);
  const [newSaleId, setNewSaleId] = useState<string | null>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedSales = useRef(false);

  const leaderboard = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.getLeaderboard({}), refetchInterval: 30_000, refetchIntervalInBackground: true });
  const refresh = useMutation({ mutationFn: () => api.refreshLeaderboard({}), onSuccess: (result) => queryClient.setQueryData(["leaderboard"], result) });
  const data = leaderboard.data;
  const agents = period === "today" ? data?.agents ?? [] : period === "week" ? data?.weekAgents ?? [] : period === "month" ? data?.monthAgents ?? [] : data?.yearAgents ?? [];
  const stats = period === "today" ? data?.today : period === "week" ? data?.week : period === "month" ? data?.month : data?.year;
  const periodLabel = period === "today" ? data?.periods.todayLabel ?? "Today" : period === "week" ? data?.periods.weekLabel ?? "This week" : period === "month" ? data?.periods.monthLabel ?? "This month" : data?.periods.yearLabel ?? "Year to date";
  const safeStats = stats ?? { ap: 0, policies: 0, average: 0 };

  const pauseRotation = useCallback(() => { setRotationPaused(true); if (resumeTimer.current) clearTimeout(resumeTimer.current); resumeTimer.current = setTimeout(() => setRotationPaused(false), IDLE_RESUME_MS); }, []);
  const replaySale = useCallback((sale: Sale) => { setCelebration(sale); setNewSaleId(sale.id); pauseRotation(); }, [pauseRotation]);
  const goToScreen = useCallback((index: number) => { setActiveScreen((index + SCREEN_COUNT) % SCREEN_COUNT); pauseRotation(); }, [pauseRotation]);
  const changePeriod = useCallback((next: PeriodKey) => { setPeriod(next); pauseRotation(); }, [pauseRotation]);

  useEffect(() => { if (rotationPaused) return; const timer = setInterval(() => setActiveScreen((screen) => (screen + 1) % SCREEN_COUNT), ROTATION_MS); return () => clearInterval(timer); }, [rotationPaused]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "ArrowRight") goToScreen(activeScreen + 1); if (event.key === "ArrowLeft") goToScreen(activeScreen - 1); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [activeScreen, goToScreen]);
  useEffect(() => () => { if (resumeTimer.current) clearTimeout(resumeTimer.current); }, []);

  useEffect(() => {
    if (!data) return;
    const saleIds = data.recentSales.map((sale) => sale.id).filter(Boolean);
    let seen = new Set<string>();
    try {
      localStorage.removeItem(LEGACY_SEEN_POLICIES_KEY);
      const saved = localStorage.getItem(SEEN_SALES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as unknown;
        if (Array.isArray(parsed)) seen = new Set(parsed.filter((item): item is string => typeof item === "string"));
      }
    } catch { seen = new Set<string>(); }
    if (initializedSales.current || seen.size > 0) {
      const fresh = data.recentSales.filter((sale) => !seen.has(sale.id)).reverse();
      if (fresh.length) {
        setCelebrationQueue((queued) => {
          const queuedIds = new Set(queued.map((sale) => sale.id));
          return [...queued, ...fresh.filter((sale) => !queuedIds.has(sale.id))];
        });
      }
    }
    initializedSales.current = true;
    try { localStorage.setItem(SEEN_SALES_KEY, JSON.stringify([...new Set([...saleIds, ...seen])].slice(0, 5000))); } catch { /* best effort */ }
  }, [data]);

  useEffect(() => {
    if (celebration || celebrationQueue.length === 0) return;
    const [next, ...remaining] = celebrationQueue;
    if (!next) return;
    setCelebrationQueue(remaining);
    setCelebration(next);
    setNewSaleId(next.id);
  }, [celebration, celebrationQueue]);

  useEffect(() => { if (!celebration) return; const dismiss = setTimeout(() => setCelebration(null), 8_000); const unhighlight = setTimeout(() => setNewSaleId(null), 9_000); return () => { clearTimeout(dismiss); clearTimeout(unhighlight); }; }, [celebration]);

  return (
    <div className="app-shell" onPointerDown={pauseRotation}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main>
        <BroadcastHeader data={data} period={period} onPeriodChange={changePeriod} refreshing={leaderboard.isFetching || refresh.isPending} onRefresh={() => refresh.mutate()} />
        <LiveTicker sales={data?.recentSales ?? []} highlightedId={newSaleId} />
        {data?.source.error ? <div className="source-alert" role="status">Feed is delayed. Showing the latest available totals.</div> : null}
        <div className="screen-stage">
          {activeScreen === 0 ? <DashboardScreen agents={agents} stats={safeStats} label={periodLabel} sales={data?.recentSales ?? []} onReplay={replaySale} /> : null}
          {activeScreen === 1 ? <PodiumScreen agents={agents} label={periodLabel} /> : null}
          {activeScreen === 2 ? <StatsScreen teams={data?.teams ?? []} products={data?.topProducts ?? []} sales={data?.recentBigSales ?? []} onReplay={replaySale} /> : null}
        </div>
        <ScreenControls active={activeScreen} paused={rotationPaused} onPrevious={() => goToScreen(activeScreen - 1)} onNext={() => goToScreen(activeScreen + 1)} onSelect={goToScreen} />
        <footer><span>Sales Feed · Auto-refresh 30 sec</span>{data && data.source.invalidRowCount > 0 ? <span>{data.source.invalidRowCount} incomplete {data.source.invalidRowCount === 1 ? "row" : "rows"} skipped</span> : null}</footer>
      </main>
      {celebration ? <Celebration sale={celebration} onDismiss={() => setCelebration(null)} /> : null}
    </div>
  );
}
