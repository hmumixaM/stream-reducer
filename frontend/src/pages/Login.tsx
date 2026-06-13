import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, Card, Spinner } from "@/components/ui";

export function Login() {
  const [email, setEmail] = useState("");
  const params = new URLSearchParams(location.search);
  const linkError = params.get("error");

  const mutation = useMutation({
    mutationFn: (e: string) => api.requestMagicLink(e),
  });

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-9 w-9 rounded-md" />
          <span className="text-xl font-semibold tracking-tight">stream-reduce</span>
        </div>

        {mutation.isSuccess ? (
          <div className="space-y-2">
            <h1 className="text-lg font-semibold">Check your email</h1>
            <p className="text-sm text-muted-foreground">
              We sent a sign-in link to <span className="font-medium">{email}</span>. It
              expires in 15 minutes. Open it on this device to continue.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) mutation.mutate(email.trim().toLowerCase());
            }}
            className="space-y-4"
          >
            <div>
              <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
              <p className="text-sm text-muted-foreground">
                Enter your email and we'll send you a magic sign-in link. No password
                needed.
              </p>
            </div>
            {linkError && (
              <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
                That link was invalid or expired. Request a new one below.
              </p>
            )}
            <input
              autoFocus
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button type="submit" className="w-full" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner /> : "Send magic link"}
            </Button>
            {mutation.isError && (
              <p className="text-sm text-red-400">{String(mutation.error)}</p>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
