import type { User } from "@/lib/api";

export type Session = { user: User | null };

// The whole shell waits on the session query, so a cold load used to sit on a
// full-screen spinner for one network round trip before anything could paint.
// Remembering the last answer lets a returning visitor render the real UI
// immediately while the refetch confirms (or corrects) it. It is only a hint:
// nothing here is trusted for authorization, which stays server-side.
const SNAPSHOT_KEY = "sr.session";

export function sessionSnapshot(): Session | undefined {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

export function rememberSession(session: Session): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(session));
  } catch {
    // storage is a nicety, never a requirement
  }
}

export function forgetSession(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // see above
  }
}
