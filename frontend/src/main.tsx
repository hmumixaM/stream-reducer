import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { MIRROR } from "@/lib/mirror";
import "./index.css";

// Every page is code-split so the initial load only ships the shell + the
// route you actually open. This keeps heavy, page-local deps out of the entry
// bundle: recharts (Stats), react-markdown (ItemDetail), and the force-graph/d3
// stack (Graph) each land in their own lazily-fetched chunk.
const named = <T extends string>(
  loader: () => Promise<Record<T, React.ComponentType>>,
  name: T,
) => lazy(() => loader().then((m) => ({ default: m[name] })));

const Library = named(() => import("@/pages/Library"), "Library");
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
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// The public mirror only exposes read-only browsing + search; the live app
// additionally exposes the queue, subscriptions, stats, and settings.
const children = [
  { index: true, element: <Library /> },
  { path: "search", element: <Search /> },
  { path: "graph", element: <Graph /> },
  { path: "folders/:id", element: <FolderView /> },
  { path: "items/:id", element: <ItemDetail /> },
  ...(MIRROR
    ? []
    : [
        { path: "annotations", element: <Annotations /> },
        { path: "queue", element: <Queue /> },
        { path: "subscriptions", element: <Subscriptions /> },
        { path: "stats", element: <Stats /> },
        { path: "settings", element: <Settings /> },
      ]),
];

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children,
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
