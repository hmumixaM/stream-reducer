import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

// Shared session query. Cached under ["me"] so every consumer (Layout, route
// guards, item detail) reads the same result without refetching.
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.getMe });
}
