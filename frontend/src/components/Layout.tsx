import { useState, useEffect, Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutGrid,
  Search as SearchIcon,
  Network,
  Highlighter,
  ListChecks,
  Rss,
  BarChart3,
  Settings as SettingsIcon,
  Plus,
  Moon,
  Sun,
  Menu,
} from "lucide-react";
import { api } from "@/lib/api";
import { MIRROR } from "@/lib/mirror";
import { Button, Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Library", icon: LayoutGrid, end: true },
  { to: "/search", label: "Search", icon: SearchIcon },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/annotations", label: "Highlights", icon: Highlighter },
  { to: "/queue", label: "Queue", icon: ListChecks },
  { to: "/subscriptions", label: "Subscriptions", icon: Rss },
  { to: "/stats", label: "Stats", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

// The public mirror is read-only: browsing, search, and the unified graph are
// reachable.
const MIRROR_NAV = new Set(["/", "/search", "/graph"]);
const NAV_ITEMS = MIRROR ? NAV.filter((item) => MIRROR_NAV.has(item.to)) : NAV;

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const qc = useQueryClient();
  const urls = text.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  const mutation = useMutation({
    mutationFn: (list: string[]) => api.addItems(list),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      setText("");
      onClose();
    },
  });
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in"
      onClick={onClose}
    >
      <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">Add content</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Paste one or more YouTube, Bilibili, Apple Podcast, 小宇宙, or direct
          media URLs — one per line. A playlist or whole podcast show expands
          into a folder of episodes. Tracking params are stripped automatically.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (urls.length) mutation.mutate(urls);
          }}
          className="space-y-3"
        >
          <textarea
            autoFocus
            rows={5}
            placeholder={"https://www.youtube.com/watch?v=...\nhttps://www.bilibili.com/video/BV..."}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {urls.length} URL{urls.length === 1 ? "" : "s"}
            </span>
            <Button type="submit" disabled={mutation.isPending || urls.length === 0}>
              {mutation.isPending ? <Spinner /> : `Add ${urls.length || ""}`.trim()}
            </Button>
          </div>
        </form>
        {mutation.isError && (
          <p className="mt-2 text-sm text-red-400">{String(mutation.error)}</p>
        )}
      </Card>
    </div>
  );
}

export function Layout() {
  const [addOpen, setAddOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  
  const [dark, setDark] = useState(
    () => document.documentElement.classList.contains("dark"),
  );
  
  const queue = useQuery({
    queryKey: ["queue"],
    queryFn: api.listQueue,
    refetchInterval: 4000,
    enabled: !MIRROR,
  });
  const active = (queue.data ?? []).filter((i) => i.status !== "error").length;

  const toggleTheme = () => {
    document.documentElement.classList.toggle("dark");
    setDark(document.documentElement.classList.contains("dark"));
  };

  // Close sidebar on route change on mobile
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const SidebarContent = () => (
    <>
      <div className="mb-6 flex items-center gap-2 px-2">
        <img src="/logo.png" alt="" className="h-8 w-8 rounded-md" />
        <span className="text-lg font-semibold tracking-tight">stream-reduce</span>
      </div>
      {!MIRROR && (
        <Button className="mb-4 w-full" onClick={() => { setAddOpen(true); setSidebarOpen(false); }}>
          <Plus className="h-4 w-4" /> Add content
        </Button>
      )}
      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
            {item.to === "/queue" && active > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                {active}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <Button variant="ghost" size="sm" className="justify-start mt-auto" onClick={toggleTheme}>
        {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        {dark ? "Dark" : "Light"} mode
      </Button>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Mobile Top Bar */}
      <header className="flex h-14 items-center justify-between border-b border-border bg-card/40 px-4 md:hidden">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" />
          <span className="font-semibold tracking-tight">stream-reduce</span>
        </div>
        <button
          onClick={() => setSidebarOpen(true)}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {/* Mobile Sidebar Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 animate-fade-in md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar (Mobile Drawer & Desktop Static) */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-card p-4 transition-transform duration-300 ease-in-out md:static md:w-60 md:translate-x-0 md:bg-card/40",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
          <Suspense
            fallback={
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </div>
      </main>
      
      {!MIRROR && <AddDialog open={addOpen} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
