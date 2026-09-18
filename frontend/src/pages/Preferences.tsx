import { useEffect, useState } from "react";
import { Check, Languages, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, Card, Select, Spinner } from "@/components/ui";
import { ErrorState, LoadingState, PageHeader, TextColumn } from "@/components/shell";

export function Preferences() {
  const qc = useQueryClient();
  const preference = useQuery({ queryKey: ["bulletin-preference"], queryFn: api.getBulletinPreference });
  const [language, setLanguage] = useState<"auto" | "zh">("auto");
  useEffect(() => {
    if (preference.data) setLanguage(preference.data.preferred_language);
  }, [preference.data]);

  const save = useMutation({
    mutationFn: () => api.updateBulletinPreference(language),
    onSuccess: (data) => {
      qc.setQueryData(["bulletin-preference"], data);
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["research"] });
      qc.invalidateQueries({ queryKey: ["bulletin"] });
      qc.invalidateQueries({ queryKey: ["item"] });
    },
  });
  const backfill = useMutation({
    mutationFn: api.backfillBulletins,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bulletin"] });
      qc.invalidateQueries({ queryKey: ["research"] });
      qc.invalidateQueries({ queryKey: ["item"] });
    },
  });

  if (preference.isLoading) return <LoadingState label="Loading preferences…" />;
  if (preference.isError || !preference.data) return <ErrorState message="Preferences could not be loaded." onRetry={() => preference.refetch()} />;
  const dirty = language !== preference.data.preferred_language;

  return (
    <TextColumn>
      <PageHeader title="Preferences" subtitle="Tune the language of your feed-ready bulletin without changing the detailed summary." />
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-accent p-2 text-primary"><Languages className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-xl font-semibold tracking-tight">Preferred bulletin language</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">中文偏好会覆盖 Bulletin 的标题、副标题、概览段落和要点；详细内容保留原文语言。 Chinese applies to the complete bulletin, including its headline and overview.</p>
            <Select value={language} onChange={(event) => setLanguage(event.target.value as "auto" | "zh")} className="mt-4 max-w-sm">
              <option value="auto">Auto · keep the source language</option>
              <option value="zh">简体中文 · Chinese bulletin</option>
            </Select>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                {save.isPending ? <Spinner /> : <Check className="h-4 w-4" />} Save preference
              </Button>
              <Button variant="outline" onClick={() => backfill.mutate()} disabled={backfill.isPending}>
                {backfill.isPending ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Backfill existing bulletins
              </Button>
              {save.data?.enqueued !== undefined && <span className="text-sm text-success">Queued {save.data.enqueued} bulletin{save.data.enqueued === 1 ? "" : "s"}.</span>}
              {backfill.data?.enqueued !== undefined && <span className="text-sm text-success">Queued {backfill.data.enqueued} bulletin{backfill.data.enqueued === 1 ? "" : "s"}.</span>}
              {(save.isError || backfill.isError) && <span className="text-sm text-danger">Could not queue the bulletin backfill.</span>}
            </div>
          </div>
        </div>
      </Card>
    </TextColumn>
  );
}
