import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { useMe } from "@/lib/auth";
import { Button, Card, Spinner } from "@/components/ui";
import "@/lib/firebase"; // initialize Firebase monitoring (Performance + Analytics)
import "./index.css";

// Every page is code-split so the initial load only ships the shell + the
// route you actually open.
const named = <T extends string>(
  loader: () => Promise<Record<T, React.ComponentType>>,
  name: T,
) =>
  lazy(async () => {
    const module = await loader();
    return { default: module[name] };
  });

const Library = named(() => import("@/pages/Library"), "Library");
const Browse = named(() => import("@/pages/Browse"), "Browse");
const Search = named(() => import("@/pages/Search"), "Search");
const Graph = named(() => import("@/pages/Graph"), "Graph");
const FolderView = named(() => import("@/pages/FolderView"), "FolderView");
const ItemDetail = named(() => import("@/pages/ItemDetail"), "ItemDetail");
const Annotations = named(() => import("@/pages/Annotations"), "Annotations");
const Queue = named(() => import("@/pages/Queue"), "Queue");
const Subscriptions = named(() => import("@/pages/Subscriptions"), "Subscriptions");
const Stats = named(() => import("@/pages/Stats"), "Stats");
const Settings = named(() => import("@/pages/Settings"), "Settings");
const Admin = named(() => import("@/pages/Admin"), "Admin");

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

const FullScreenSpinner = () => (
  <div className="flex min-h-screen items-center justify-center text-muted-foreground">
    <Spinner /> Loading…
  </div>
);

// The shell is public: anyone can reach it. Browsing the global catalog and
// reading an item needs no account; personal pages are wrapped in RequireAuth.
function RootLayout() {
  const me = useMe();
  if (me.isLoading) return <FullScreenSpinner />;
  return <Layout />;
}

// Redirect to /login for pages that need a personal session.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <FullScreenSpinner />;
  if (!me.data?.user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Admin-only pages: signed-in non-admins are bounced home.
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <FullScreenSpinner />;
  if (!me.data?.user) return <Navigate to="/login" replace />;
  if (!me.data.user.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function PublicHome() {
  return (
    <div className="mx-auto max-w-4xl py-12">
      <div className="mb-10">
        <p className="mb-3 text-sm font-medium uppercase tracking-wide text-primary">
          Public stream-reduce
        </p>
        <h1 className="mb-4 text-4xl font-semibold tracking-tight md:text-5xl">
          Browse shared episode summaries before you sign in.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Explore the public catalog, read processed summaries, and sign in with
          email when you want your own library, subscriptions, notes, highlights,
          and knowledge graph.
        </p>
      </div>

      <div className="mb-8 flex flex-wrap gap-3">
        <Link to="/browse">
          <Button>Browse public catalog</Button>
        </Link>
        <Link to="/login">
          <Button variant="outline">Sign in with email</Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Public summaries</h2>
          <p className="text-sm text-muted-foreground">
            Anyone can browse and read episodes that have already been processed.
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Personal library</h2>
          <p className="text-sm text-muted-foreground">
            Signing in lets you save episodes, subscribe to channels, and track waiting work.
          </p>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 font-semibold">Your graph and notes</h2>
          <p className="text-sm text-muted-foreground">
            Highlights, comments, and the knowledge graph stay scoped to your account.
          </p>
        </Card>
      </div>
    </div>
  );
}

// Signed-in users land on their library; anonymous visitors get a public front page.
function Home() {
  const me = useMe();
  if (me.isLoading) return <FullScreenSpinner />;
  return me.data?.user ? <Library /> : <PublicHome />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      // Public, read-only content.
      { path: "browse", element: <Browse /> },
      { path: "items/:id", element: <ItemDetail /> },
      // Personal pages require a session.
      { path: "search", element: <RequireAuth><Search /></RequireAuth> },
      { path: "graph", element: <RequireAuth><Graph /></RequireAuth> },
      { path: "folders/:id", element: <RequireAuth><FolderView /></RequireAuth> },
      { path: "annotations", element: <RequireAuth><Annotations /></RequireAuth> },
      { path: "queue", element: <RequireAuth><Queue /></RequireAuth> },
      { path: "subscriptions", element: <RequireAuth><Subscriptions /></RequireAuth> },
      { path: "stats", element: <RequireAuth><Stats /></RequireAuth> },
      // Admin-only.
      { path: "settings", element: <RequireAdmin><Settings /></RequireAdmin> },
      { path: "admin", element: <RequireAdmin><Admin /></RequireAdmin> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
