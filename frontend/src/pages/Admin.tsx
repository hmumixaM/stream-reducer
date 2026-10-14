import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Shield, ShieldOff, Trash2, ArrowUp, ArrowDown, ArrowUpDown, RefreshCw, Users, ListChecks } from "lucide-react";
import { api, type AdminUser, type AdminQueueItem, type FeedbackReport } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Button, Card, Spinner } from "@/components/ui";
import { EmptyState, PageHeader, SectionHeader } from "@/components/shell";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import { timeAgo } from "@/lib/utils";

export function Admin() {
  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" /> Admin
          </span>
        }
        subtitle="Manage users and the global processing queue."
      />
      <FeedbackPanel />
      <QueuePanel />
      <UsersPanel />
    </div>
  );
}

function FeedbackPanel() {
  const reports = useQuery({ queryKey: ["admin", "feedback"], queryFn: api.adminListFeedback });
  const rows = reports.data ?? [];
  return (
    <section>
      <SectionHeader title={`Feedback (${rows.length})`} />
      <Card className="divide-y divide-border">
        {reports.isLoading && <p className="px-4 py-6 text-sm text-muted-foreground"><Spinner /> Loading…</p>}
        {!reports.isLoading && rows.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No reports yet.</p>}
        {rows.map((report: FeedbackReport) => (
          <article key={report.id} className="space-y-2 px-4 py-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{report.email}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{report.kind}</span>
              <span className="text-xs text-muted-foreground">{timeAgo(report.created_at)}</span>
            </p>
            <p className="whitespace-pre-wrap">{report.body}</p>
            {report.page_url && <a className="block truncate text-xs text-primary" href={report.page_url}>{report.page_url}</a>}
            {report.image_ids.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {report.image_ids.map((imageId) => (
                  <a key={imageId} href={`/api/admin/feedback/${report.id}/images/${imageId}`} target="_blank" rel="noreferrer">
                    <img src={`/api/admin/feedback/${report.id}/images/${imageId}`} alt="" className="h-20 w-20 rounded-md border border-border object-cover" />
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </Card>
    </section>
  );
}

type SortDir = "asc" | "desc";
type UserSortKey = "email" | "last_online_at" | "library_count" | "queued_count" | "subscription_count" | "created_at";

const dateValue = (value: string | null) => (value ? Date.parse(value) : null);

const USER_COLUMNS: { key: UserSortKey; label: string; firstDir: SortDir; value: (u: AdminUser) => number | string | null }[] = [
  { key: "email", label: "Email", firstDir: "asc", value: (u) => u.email.toLowerCase() },
  { key: "last_online_at", label: "Last online", firstDir: "desc", value: (u) => dateValue(u.last_online_at) },
  { key: "library_count", label: "Library", firstDir: "desc", value: (u) => u.library_count },
  { key: "queued_count", label: "In queue", firstDir: "desc", value: (u) => u.queued_count },
  { key: "subscription_count", label: "Subs", firstDir: "desc", value: (u) => u.subscription_count },
  { key: "created_at", label: "Joined", firstDir: "desc", value: (u) => dateValue(u.created_at) },
];

function sortUsers(rows: AdminUser[], key: UserSortKey, dir: SortDir): AdminUser[] {
  const value = USER_COLUMNS.find((column) => column.key === key)!.value;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // Missing values (e.g. never online) stay last in either direction.
    if (x === null || y === null) return x === y ? a.id - b.id : x === null ? 1 : -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return (dir === "asc" ? order : -order) || a.id - b.id;
  });
}

function UsersPanel() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: api.adminListUsers, refetchInterval: 60_000 });
  const [sort, setSort] = useState<{ key: UserSortKey; dir: SortDir }>({ key: "last_online_at", dir: "desc" });
  const toggleSort = (key: UserSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: USER_COLUMNS.find((column) => column.key === key)!.firstDir },
    );
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });

  const setAdmin = useMutation({
    mutationFn: ({ id, is_admin }: { id: number; is_admin: boolean }) =>
      api.adminSetUserAdmin(id, is_admin),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.adminDeleteUser(id),
    onSuccess: invalidate,
  });

  const rows = sortUsers(users.data ?? [], sort.key, sort.dir);

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Users
            <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
          </span>
        }
      />
      <p className="mb-3 text-xs text-muted-foreground">Last online records authenticated activity, updated at most once a minute. Times use your local timezone.</p>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <tr>
                {USER_COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={column.key}
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      className="whitespace-nowrap px-3 py-2 font-medium"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={`inline-flex items-center gap-1 uppercase hover:text-foreground ${active ? "text-foreground" : ""}`}
                      >
                        {column.label}
                        <Icon className={`h-3.5 w-3.5 ${active ? "" : "opacity-40"}`} />
                      </button>
                    </th>
                  );
                })}
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.isLoading && (
                <tr><td colSpan={7} className="px-4 py-6 text-muted-foreground"><Spinner /> Loading…</td></tr>
              )}
              {rows.map((u: AdminUser) => {
                const self = u.id === me.data?.user?.id;
                return (
                  <tr key={u.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{u.email}</span>
                      {u.is_admin && (
                        <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">admin</span>
                      )}
                      {self && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {u.last_online_at ? <>
                        <time dateTime={u.last_online_at} title={new Date(u.last_online_at).toLocaleString()}>
                          {new Date(u.last_online_at).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}
                        </time>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{timeAgo(u.last_online_at)}</span>
                      </> : <span className="text-muted-foreground" title="No recorded activity is available for this account.">Not recorded</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{u.library_count}</td>
                    <td className="px-3 py-2 tabular-nums">{u.queued_count}</td>
                    <td className="px-3 py-2 tabular-nums">{u.subscription_count}</td>
                    <td className="px-3 py-2 text-muted-foreground">{timeAgo(u.created_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={setAdmin.isPending}
                          onClick={() => setAdmin.mutate({ id: u.id, is_admin: !u.is_admin })}
                        >
                          {u.is_admin ? <ShieldOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
                          {u.is_admin ? "Revoke" : "Make admin"}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={self || remove.isPending}
                          onClick={() => {
                            if (confirm(`Delete ${u.email}? Their library, notes, and subscriptions are removed.`))
                              remove.mutate(u.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!users.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-muted-foreground">No users.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}

function QueuePanel() {
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ["admin", "queue"], queryFn: api.adminQueue, refetchInterval: 4000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "queue"] });

  const bump = useMutation({ mutationFn: (id: number) => api.adminBumpQueue(id), onSuccess: invalidate });
  const retry = useMutation({ mutationFn: (id: number) => api.adminRetryQueue(id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: number) => api.adminDeleteQueue(id), onSuccess: invalidate });

  const rows = queue.data ?? [];

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <ListChecks className="h-5 w-5" /> Global queue
            <span className="text-sm font-normal text-muted-foreground">
              ({rows.length} pending)
            </span>
          </span>
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="h-5 w-5" />}
          title="Nothing pending"
          description="The global queue is clear."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((item: AdminQueueItem) => (
            <Card key={item.id} className="flex items-center gap-4 p-3">
              <div className="w-8 shrink-0 text-center text-lg font-semibold tabular-nums text-muted-foreground">
                {item.queue_position}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <PlatformBadge platform={item.platform} />
                  <StatusBadge status={item.status} />
                </div>
                <Link to={`/items/${item.id}`} className="block truncate font-medium hover:underline">
                  {item.title || item.source_url}
                </Link>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{item.owner_count} owner{item.owner_count === 1 ? "" : "s"}</span>
                  {item.owners.length > 0 && <span className="truncate">{item.owners.join(", ")}</span>}
                  {item.error && <span className="text-danger">{item.error.slice(0, 80)}</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" title="Process next" disabled={bump.isPending} onClick={() => bump.mutate(item.id)}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" title="Retry" disabled={retry.isPending} onClick={() => retry.mutate(item.id)}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button variant="danger" size="sm" title="Remove from catalog" disabled={remove.isPending}
                  onClick={() => { if (confirm("Remove this item from the global catalog for everyone?")) remove.mutate(item.id); }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
