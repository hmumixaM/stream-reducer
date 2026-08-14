import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { rememberSession, sessionSnapshot } from "@/lib/session";

// Shared session query. Cached under ["me"] so every consumer (Layout, route
// guards, item detail) reads the same result without refetching.
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const session = await api.getMe();
      rememberSession(session);
      return session;
    },
    // Paint from the last known session, then revalidate: `initialDataUpdatedAt: 0`
    // marks the snapshot stale on arrival so every mount still asks the server.
    initialData: sessionSnapshot,
    initialDataUpdatedAt: 0,
  });
}
