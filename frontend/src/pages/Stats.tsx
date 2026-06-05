import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Clock,
  Coins,
  DollarSign,
  FileText,
  LayoutGrid,
  Mic,
  Sparkles,
  Type,
} from "lucide-react";
import { api, type Platform } from "@/lib/api";
import { Card } from "@/components/ui";
import { PlatformBadge } from "@/components/badges";
import { formatCost, formatCount, formatLength, formatMs } from "@/lib/utils";

const COLORS = ["#818cf8", "#f87171", "#34d399", "#fbbf24", "#f472b6", "#60a5fa"];

export function Stats() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.getStats, refetchInterval: 10000 });
  if (!stats.data) return <p className="text-muted-foreground">Loading...</p>;
  const s = stats.data;

  const stageData = Object.entries(s.avg_stage_ms).map(([stage, ms]) => ({
    stage,
    avg: Math.round(ms / 1000),
  }));
  const platformData = s.by_platform.map((p) => ({ name: p.platform, value: p.items }));
  const done = s.items_by_status["done"] ?? 0;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Stats</h1>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat icon={LayoutGrid} label="Items" value={formatCount(s.total_items)} sub={`${done} done`} />
        <Stat icon={Clock} label="Total length" value={formatLength(s.total_duration_s)} sub="source media" />
        <Stat icon={Type} label="Words" value={formatCount(s.transcript_words)} sub="transcribed" />
        <Stat
          icon={Coins}
          label="Tokens"
          value={formatCount(s.total_tokens)}
          sub={`${formatCount(s.prompt_tokens)} in · ${formatCount(s.completion_tokens)} out`}
        />
        <Stat icon={DollarSign} label="Total cost" value={formatCost(s.total_cost_usd)} sub="all stages" />
        <Stat
          icon={Mic}
          label="STT requests"
          value={formatCount(s.openrouter_requests)}
          sub={s.http_429_total > 0 ? `${s.http_429_total}× 429` : "no 429s"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Avg time per stage (s)</h2>
          {stageData.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stageData}>
                <XAxis dataKey="stage" stroke="#94a3b8" fontSize={12} />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }}
                />
                <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                  {stageData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Items by platform</h2>
          {platformData.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={platformData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {platformData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden p-0">
        <h2 className="border-b border-border px-5 py-4 text-sm font-semibold">By platform</h2>
        {s.by_platform.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Platform</th>
                  <th className="px-5 py-2 text-right font-medium">Items</th>
                  <th className="px-5 py-2 text-right font-medium">Done</th>
                  <th className="px-5 py-2 text-right font-medium">Length</th>
                  <th className="px-5 py-2 text-right font-medium">Tokens</th>
                  <th className="px-5 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {s.by_platform.map((p) => (
                  <tr key={p.platform} className="border-b border-border/50 last:border-0">
                    <td className="px-5 py-2.5">
                      <PlatformBadge platform={p.platform as Platform} />
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{p.items}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">
                      {p.done}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{formatLength(p.duration_s)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{formatCount(p.tokens)}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{formatCost(p.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5">
            <Empty />
          </div>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-muted-foreground" /> Cost by stage
          </h2>
          <div className="space-y-2">
            {Object.entries(s.cost_by_stage)
              .filter(([, c]) => c > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([stage, cost]) => {
                const pct = s.total_cost_usd ? (cost / s.total_cost_usd) * 100 : 0;
                return (
                  <div key={stage}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="capitalize text-muted-foreground">{stage}</span>
                      <span className="tabular-nums">{formatCost(cost)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-emerald-400"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            {Object.values(s.cost_by_stage).every((c) => !c) && <Empty />}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-muted-foreground" /> Total time per stage
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(s.total_stage_ms).map(([stage, ms]) => (
              <div key={stage} className="rounded-md bg-muted/50 p-3">
                <div className="text-lg font-semibold">{formatMs(ms)}</div>
                <div className="text-xs capitalize text-muted-foreground">{stage}</div>
              </div>
            ))}
            {Object.keys(s.total_stage_ms).length === 0 && <Empty />}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">No data yet.</p>;
}
