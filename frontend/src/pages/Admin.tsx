import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Shield, ShieldOff, Trash2, ArrowUp, RefreshCw, Users, ListChecks } from "lucide-react";
import { api, type AdminUser, type AdminQueueItem } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Button, Card, Spinner } from "@/components/ui";
import { PlatformBadge, StatusBadge } from "@/components/badges";
import { timeAgo } from "@/lib/utils";

export function Admin() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Shield className="h-6 w-6 text-primary" /> Admin
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage users and the global processing queue.
        </p>
      </div>
      <UsersPanel />
      <QueuePanel />
    </div>
  );
}

function UsersPanel() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: api.adminListUsers });
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

  const rows = users.data ?? [];

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Users className="h-5 w-5" /> Users
        <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
      </h2>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Library</th>
                <th className="px-4 py-2 font-medium">In&nbsp;queue</th>
                <th className="px-4 py-2 font-medium">Subs</th>
                <th className="px-4 py-2 font-medium">Joined</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.isLoading && (
                <tr><td colSpan={6} className="px-4 py-6 text-muted-foreground"><Spinner /> Loading…</td></tr>
              )}
              {rows.map((u: AdminUser) => {
                const self = u.id === me.data?.user?.id;
                return (
                  <tr key={u.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-medium">{u.email}</span>
                      {u.is_admin && (
                        <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">admin</span>
                      )}
                      {self && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{u.library_count}</td>
                    <td className="px-4 py-2 tabular-nums">{u.queued_count}</td>
                    <td className="px-4 py-2 tabular-nums">{u.subscription_count}</td>
                    <td className="px-4 py-2 text-muted-foreground">{timeAgo(u.created_at)}</td>
                    <td className="px-4 py-2">
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
                <tr><td colSpan={6} className="px-4 py-6 text-muted-foreground">No users.</td></tr>
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
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <ListChecks className="h-5 w-5" /> Global queue
        <span className="text-sm font-normal text-muted-foreground">({rows.length} pending)</span>
      </h2>
      {rows.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">Nothing pending — the queue is clear.</Card>
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
                  {item.error && <span className="text-red-400">{item.error.slice(0, 80)}</span>}
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
