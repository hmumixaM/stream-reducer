import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { Button, Card, Input, Select, Spinner } from "@/components/ui";
import { useMe } from "@/lib/auth";
import { substackApi, type SubstackConnection, type SubstackPublication } from "@/lib/substack";
import { timeAgo } from "@/lib/utils";

export function SubstackSources() {
  const me = useMe();
  const client = useQueryClient();
  const [selected, setSelected] = useState("");
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<{ title: string; url: string }[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState("");
  const [label, setLabel] = useState("");
  const [cookie, setCookie] = useState("");
  const loggedIn = !!me.data?.user;
  const admin = !!me.data?.user?.is_admin;
  const connections = useQuery({
    queryKey: ["substack", "connections", me.data?.user?.id],
    queryFn: () => substackApi<SubstackConnection[]>("/connections"), enabled: loggedIn,
    refetchInterval: 30000,
  });
  const connection = connections.data?.find(c => c.id === selected) || connections.data?.find(c => c.enabled) || connections.data?.[0];
  const ready = !!connection?.enabled && connection.status !== "needs_auth";
  const directory = useQuery({
    queryKey: ["substack", "subscriptions", connection?.id, me.data?.user?.id],
    queryFn: () => substackApi<{ sources: SubstackPublication[]; skipped: number }>(`/connections/${connection!.id}/subscriptions`),
    enabled: loggedIn && ready, retry: false, refetchOnWindowFocus: false,
  });
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await fn();
      await Promise.all([["substack"], ["rss"], ["source-search"], ["bulletin", "feed"]].map(queryKey => client.invalidateQueries({ queryKey })));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!loggedIn) return <p className="py-10 text-center text-muted-foreground"><Link to="/login" className="text-primary underline">登录</Link>后关注 Substack 刊物。</p>;
  const rows = directory.data?.sources.filter(s => `${s.title} ${s.url}`.toLowerCase().includes(search.toLowerCase())) || [];
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-2xl space-y-2">
        <h2 className="text-lg font-semibold">Substack</h2>
        <p className="text-sm leading-7 text-muted-foreground">从已连接账号的订阅目录中关注刊物，或直接添加刊物链接。新文章和最近三个月的历史文章会进入 Bulletin；已获取的正文和概括可由所有用户复用。</p>
      </div>
      {admin && <Button variant="outline" onClick={() => { setManage(!manage); setCookie(""); }}>管理连接</Button>}
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    {connections.isLoading ? <Spinner /> : connections.error ? <p role="alert">{connections.error.message}</p> : !connections.data?.length ? <Card className="p-5 text-sm text-muted-foreground">尚未连接 Substack 账号。管理员连接后，所有用户都可以从这里关注刊物。</Card> : <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-60 space-y-1 text-sm">内容连接
          <Select aria-label="Substack 内容连接" value={connection?.id || ""} onChange={e => setSelected(e.target.value)}>
            {connections.data.map(c => <option key={c.id} value={c.id}>{c.label}{!c.enabled ? " · 已停用" : c.status === "needs_auth" ? " · 需要重新连接" : ""}</option>)}
          </Select>
        </label>
        <Button variant="outline" disabled={busy || !ready || directory.isFetching} onClick={() => void directory.refetch()}><RefreshCw size={14} />刷新目录</Button>
        <Button disabled={busy || !ready || !directory.data?.sources.length} onClick={() => void action(async () => {
          const result = await substackApi<{ imported: number }>(`/connections/${connection!.id}/import`, {});
          setNotice(`已关注 ${result.imported} 个 Substack 刊物，文章将陆续出现在 Bulletin。`);
        })}>导入全部订阅</Button>
      </div>
      {connection?.last_error && <p className="text-sm text-warning">{connection.last_error}</p>}
      {connection?.last_checked_at && <p className="text-xs text-muted-foreground">最近检查 {timeAgo(connection.last_checked_at)}{connection.expires_at ? ` · 会话预计到期 ${new Date(connection.expires_at).toLocaleDateString()}` : ""}</p>}
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={e => { e.preventDefault(); void action(async () => {
        const result = await substackApi<{ choices?: { title: string; url: string }[] }>(`/connections/${connection!.id}/follow`, { url });
        if (result.choices) { setChoices(result.choices); return; }
        setChoices([]);
        setUrl(""); setNotice("已关注 Substack 刊物，正在获取文章。可在文章 / RSS 中管理关注。");
      }); }}>
        <Input aria-label="Substack 刊物链接" placeholder="https://刊物.substack.com，或刊物的独立域名" value={url} onChange={e => setUrl(e.target.value)} required type="url" className="min-w-0 flex-1" />
        <Button type="submit" disabled={busy || !ready || !url.trim()}><Plus size={14} />关注刊物</Button>
      </form>
      {choices.length > 0 && <div className="space-y-2"><p className="text-sm">该主页有多个刊物，请选择后关注：</p><div className="flex flex-wrap gap-2">{choices.map(choice => <Button key={choice.url} variant="outline" onClick={() => { setUrl(choice.url); setChoices([]); }}>{choice.title}</Button>)}</div></div>}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">账号订阅目录{directory.data ? ` · ${directory.data.sources.length}` : ""}</h3>
          <Input aria-label="搜索 Substack 刊物" placeholder="搜索刊物" value={search} onChange={e => setSearch(e.target.value)} className="w-full sm:w-64" />
        </div>
        {directory.isFetching && !directory.data ? <Spinner /> : directory.error ? <p role="alert" className="text-sm text-danger">{directory.error.message}</p> : !ready ? <p className="text-sm text-muted-foreground">此连接暂时不可用，已保存的文章仍可阅读。</p> : !rows.length ? <p className="py-5 text-sm text-muted-foreground">{search ? "没有匹配的刊物。" : "账号暂无订阅。可以通过上方链接添加刊物。"}</p> : <ul className="divide-y rounded-lg border bg-card">
          {rows.map(s => <li key={s.substack_publication_id} className="flex flex-wrap items-center gap-3 p-4">
            {s.image_url && <img src={s.image_url} alt="" referrerPolicy="no-referrer" className="h-11 w-11 rounded-md object-contain" />}
            <div className="min-w-0 flex-1 basis-32"><p className="font-medium">{s.title}</p><a href={s.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-xs text-muted-foreground">{s.url}<ExternalLink size={12} className="shrink-0" /></a></div>
            <Button variant={s.following ? "outline" : "default"} disabled={busy || s.following} onClick={() => void action(async () => {
              await substackApi(`/connections/${connection!.id}/follow`, { publication_id: s.substack_publication_id });
              setNotice(`已关注 ${s.title}，正在获取文章。`);
            })}>{s.following ? <Check size={14} /> : <Plus size={14} />}{s.following ? "已关注" : "关注"}</Button>
          </li>)}
        </ul>}
        <Link to="/subscriptions?tab=articles" className="inline-block text-sm text-primary underline">管理已关注的文章来源</Link>
      </div>
    </>}
    {admin && manage && <Card className="space-y-4 p-4 sm:p-6">
      <h3 className="font-semibold">管理 Substack 连接</h3>
      <p className="text-sm text-muted-foreground">reducer 仅使用连接获取文章。凭据加密保存在服务端，普通用户可以选择连接和关注刊物。</p>
      {connections.data?.map(c => <div key={c.id} className="flex flex-wrap items-center gap-2 border-b pb-3 text-sm"><span className="mr-auto">{c.label} · {c.status === "needs_auth" ? "需要重新连接" : c.enabled ? "已启用" : "已停用"}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(c.id); setLabel(c.label); setCookie(""); }}>更新会话</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(async () => { await substackApi(`/connections/${c.id}`, { enabled: !c.enabled }, "PATCH"); })}>{c.enabled ? "停用" : "启用"}</Button>
      </div>)}
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); const submitted = cookie; setCookie(""); void action(async () => {
        const result = await substackApi<{ id?: string }>(editing ? `/connections/${editing}` : "/connections", { label, cookie: submitted }, editing ? "PATCH" : "POST");
        if (result.id) setSelected(result.id);
        setEditing(""); setLabel(""); setNotice("Substack 连接已验证并保存。");
      }); }}>
        <p className="text-sm font-medium">{editing ? "更新已有连接" : "添加另一个账号连接"}</p>
        <Input aria-label="Substack 连接名称" placeholder="连接名称" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} required />
        <Input aria-label="Substack session cookie" type="password" autoComplete="off" spellCheck={false} placeholder="substack.sid=… 或 connect.sid=…" value={cookie} onChange={e => setCookie(e.target.value)} required />
        <div className="flex gap-2"><Button type="submit" disabled={busy || !cookie.trim() || !label.trim()}>{busy ? "验证中…" : "验证并保存"}</Button>{editing && <Button variant="ghost" type="button" onClick={() => { setEditing(""); setLabel(""); setCookie(""); }}>取消更新</Button>}</div>
      </form>
    </Card>}
  </div>;
}
