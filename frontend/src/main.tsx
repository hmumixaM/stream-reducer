import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";
import "./index.css";

// Every page is code-split so the initial load only ships the shell + the
// route you actually open.
const named = <T extends string>(
  loader: () => Promise<Record<T, React.ComponentType>>,
  name: T,
) => lazy(() => loader().then((m) => ({ default: m[name] })));

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

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

// Gate the whole app on an authenticated session.
function AuthGuard() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.getMe });
  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (!me.data?.user) return <Navigate to="/login" replace />;
  return <Layout />;
}

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    path: "/",
    element: <AuthGuard />,
    children: [
      { index: true, element: <Library /> },
      { path: "browse", element: <Browse /> },
      { path: "search", element: <Search /> },
      { path: "graph", element: <Graph /> },
      { path: "folders/:id", element: <FolderView /> },
      { path: "items/:id", element: <ItemDetail /> },
      { path: "annotations", element: <Annotations /> },
      { path: "queue", element: <Queue /> },
      { path: "subscriptions", element: <Subscriptions /> },
      { path: "stats", element: <Stats /> },
      { path: "settings", element: <Settings /> },
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
