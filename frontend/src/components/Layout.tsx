import { useState, useEffect, Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutGrid,
  Bookmark,
  Clock,
  Compass,
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
  LogOut,
  Shield,
} from "lucide-react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { MIRROR } from "@/lib/mirror";
import { Button, Card, Select, Spinner } from "@/components/ui";
import { SkeletonGrid } from "@/components/shell";
import { cn } from "@/lib/utils";
import { LogIn } from "lucide-react";

const SECTIONS = ["main", "discover", "system"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABELS: Record<Section, string> = {
  main: "Content",
  discover: "Discover",
  system: "System",
};

const NAV: {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  section: Section;
  end?: boolean;
  admin?: boolean;
}[] = [
  { to: "/", label: "Timeline", icon: Clock, section: "main", end: true },
  { to: "/subscriptions", label: "Channels", icon: Rss, section: "main" },
  { to: "/library", label: "Saved", icon: Bookmark, section: "main" },
  { to: "/browse", label: "Browse", icon: Compass, section: "discover" },
  { to: "/search", label: "Search", icon: SearchIcon, section: "discover" },
  { to: "/graph", label: "Graph", icon: Network, section: "discover" },
  { to: "/annotations", label: "Highlights", icon: Highlighter, section: "discover" },
  { to: "/queue", label: "Queue", icon: ListChecks, section: "system" },
  { to: "/stats", label: "Stats", icon: BarChart3, section: "system" },
  // Admin-only entries (settings exposes provider endpoint/keys).
  { to: "/admin", label: "Admin", icon: Shield, section: "system", admin: true },
  { to: "/settings", label: "Settings", icon: SettingsIcon, section: "system", admin: true },
];

// The public mirror is read-only and has no follows, so `/` stays the mirrored
// library rather than a timeline; browsing, search, and the graph are reachable.
const MIRROR_NAV = new Set(["/", "/search", "/graph"]);
// Anonymous (no session) visitors can only browse the global catalog.
const PUBLIC_NAV = new Set(["/browse"]);
const MIRROR_LABELS: Record<string, string> = { "/": "Library" };

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [folderId, setFolderId] = useState<string>("");
  const qc = useQueryClient();
  const urls = text.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.listGroups(),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: (list: string[]) =>
      api.addItems(list, folderId ? Number(folderId) : null),
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
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              Add to folder
            </span>
            <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">No folder (Unfiled)</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title || "Folder"}
                </option>
              ))}
            </Select>
          </label>
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
          <p className="mt-2 text-sm text-danger">{String(mutation.error)}</p>
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
  
  const me = useMe();
  const authed = !!me.data?.user;
  const isAdmin = !!me.data?.user?.is_admin;

  const queue = useQuery({
    queryKey: ["queue"],
    queryFn: api.listQueue,
    refetchInterval: 4000,
    enabled: !MIRROR && authed,
  });
  const active = (queue.data ?? []).filter((i) => i.status !== "error").length;

  const navItems = MIRROR
    ? NAV.filter((item) => MIRROR_NAV.has(item.to))
    : authed
      ? NAV.filter((item) => !item.admin || isAdmin)
      : NAV.filter((item) => PUBLIC_NAV.has(item.to));

  const logout = async () => {
    await api.logout();
    window.location.href = "/login";
  };

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
      {!MIRROR && authed && (
        <Button className="mb-4 w-full" onClick={() => { setAddOpen(true); setSidebarOpen(false); }}>
          <Plus className="h-4 w-4" /> Add content
        </Button>
      )}
      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {SECTIONS.map((section) => {
          const entries = navItems.filter((item) => item.section === section);
          if (entries.length === 0) return null;
          return (
            <div key={section} className="flex flex-col gap-1">
              {/* Group labels only earn their space once a group has siblings. */}
              {navItems.length > 3 && (
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {SECTION_LABELS[section]}
                </p>
              )}
              {entries.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      "before:absolute before:left-0 before:top-1/2 before:h-5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground before:bg-primary"
                        : "text-muted-foreground before:bg-transparent hover:bg-accent/60 hover:text-foreground",
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {(MIRROR && MIRROR_LABELS[item.to]) || item.label}
                  {item.to === "/queue" && active > 0 && (
                    <span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                      {active}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="mt-auto space-y-1 border-t border-border pt-2">
        {authed && (
          <p className="truncate px-3 pt-1 text-xs text-muted-foreground" title={me.data!.user!.email}>
            {me.data!.user!.email}
          </p>
        )}
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={toggleTheme}>
          {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          {dark ? "Dark" : "Light"} mode
        </Button>
        {authed ? (
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        ) : (
          <NavLink to="/login" className="block">
            <Button variant="ghost" size="sm" className="w-full justify-start">
              <LogIn className="h-4 w-4" /> Sign in
            </Button>
          </NavLink>
        )}
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Mobile Top Bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur md:hidden">
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
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-card p-4 transition-transform duration-300 ease-in-out md:sticky md:top-0 md:h-screen md:self-start md:w-60 md:translate-x-0 md:bg-card/40",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
          <Suspense fallback={<SkeletonGrid count={6} />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      
      {!MIRROR && <AddDialog open={addOpen} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
