import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMe } from "@/lib/auth";
import { MIRROR } from "@/lib/mirror";
import { Button } from "@/components/ui";

const DISMISSED_KEY = "sr.guest-login-guide.dismissed";

export function GuestLoginGuide() {
  const me = useMe();
  const location = useLocation();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  // The home page already introduces sign-in. Wait for a confirmed session so
  // a stale anonymous snapshot never prompts a returning signed-in reader.
  if (MIRROR || dismissed || location.pathname === "/" || !me.isSuccess ||
      me.dataUpdatedAt === 0 || me.data?.user !== null) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Dismissal still works for this mounted shell when storage is blocked.
    }
  };

  return (
    <section
      aria-labelledby="guest-login-heading"
      className="screen-only mb-6 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6"
    >
      <div className="min-w-0">
        <h2 id="guest-login-heading" className="text-base font-semibold">
          Keep what you discover
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Sign in to save summaries, follow sources, and keep highlights.
          {" "}You can keep reading without an account.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link
          to="/login"
          state={{ returnTo: location.pathname + location.search + location.hash }}
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground dark:text-background hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Sign in
        </Link>
        <Button type="button" variant="ghost" className="min-h-11" onClick={dismiss}>
          Keep browsing
        </Button>
      </div>
    </section>
  );
}
