export interface SubstackConnection {
  id: string;
  label: string;
  enabled: number;
  status: string;
  expires_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}
export interface SubstackPublication {
  access?: "free" | "paid" | "unknown";
  id: number | null;
  title: string;
  url: string;
  image_url: string | null;
  substack_publication_id: string;
  following: boolean;
}
export async function substackApi<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`/api/substack${path}`, {
    method, credentials: "same-origin", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Substack 暂时不可用，请重试");
  return data as T;
}
