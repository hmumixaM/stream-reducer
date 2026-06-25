import type { Context } from "hono";
import type { AppContext } from "../auth";

export async function readJson<T extends object>(c: Context<AppContext>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function readForm(c: Context<AppContext>): Promise<Record<string, string | File>> {
  try {
    return (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    return {};
  }
}
