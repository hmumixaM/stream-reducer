import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Save, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card, Select, Spinner } from "@/components/ui";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  TextColumn,
} from "@/components/shell";

export function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });

  const [llmModel, setLlmModel] = useState("");
  const [mapModel, setMapModel] = useState("");
  const [sttModel, setSttModel] = useState("");

  useEffect(() => {
    if (settings.data) {
      setLlmModel(settings.data.llm_model);
      setMapModel(settings.data.summary_map_model);
      setSttModel(settings.data.stt_model);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        llm_model: llmModel.trim(),
        summary_map_model: mapModel.trim(),
        stt_model: sttModel.trim(),
      }),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });

  if (settings.isError) {
    return (
      <ErrorState message={settings.error.message} onRetry={() => settings.refetch()} />
    );
  }
  if (!settings.data) return <LoadingState />;
  const s = settings.data;

  const dirty =
    llmModel !== s.llm_model ||
    mapModel !== s.summary_map_model ||
    sttModel !== s.stt_model;

  return (
    <TextColumn>
      <PageHeader
        title="Settings"
        subtitle={
          <>
            Pick the transcription and summary models below; changes apply to the next
            job (no restart needed). Everything else comes from{" "}
            <span className="font-mono">.env</span>.
          </>
        }
      />

      <div className="space-y-6">
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Summarization (LLM via LiteLLM)</h2>
          <Row label="Endpoint" value={s.llm_base_url} />
          <ModelField
            label="Summary model"
            value={llmModel}
            onChange={setLlmModel}
            options={s.llm_model_options}
            def={s.llm_model_default}
          />
          <ModelField
            label="Map model (per-chunk pass)"
            value={mapModel}
            onChange={setMapModel}
            options={s.llm_model_options}
            def={s.summary_map_model_default}
          />
          <Row label="API key" value={<KeyState ok={s.has_llm_key} />} />
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Transcription (OpenRouter)</h2>
          <ModelField
            label="STT model"
            value={sttModel}
            onChange={setSttModel}
            options={s.stt_model_options}
            def={s.stt_model_default}
          />
          <Row label="Chunk size" value={`${s.transcribe_chunk_seconds}s`} />
          <Row label="Rate limit" value={`${s.transcribe_rate_limit} req/min`} />
          <Row label="Default language" value={s.default_language || "auto-detect"} />
          <Row label="API key" value={<KeyState ok={s.has_openrouter_key} />} />
        </Card>

        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? <Spinner /> : <Save className="h-4 w-4" />} Save changes
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setLlmModel(s.llm_model);
              setMapModel(s.summary_map_model);
              setSttModel(s.stt_model);
            }}
          >
            <RotateCcw className="h-4 w-4" /> Reset
          </Button>
          {save.isSuccess && !dirty && <span className="text-sm text-success">Saved</span>}
          {save.isError && <span className="text-sm text-danger">Save failed</span>}
        </div>
      </div>
    </TextColumn>
  );
}

function ModelField({
  label,
  value,
  onChange,
  options,
  def,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  def: string;
}) {
  const overridden = value !== def;
  // Ensure the current value and the env default are always selectable, even
  // if they aren't in the curated option list.
  const choices = Array.from(new Set([...options, def, value])).filter(Boolean);
  return (
    <div className="border-b border-border py-2 last:border-0">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        {overridden && (
          <span className="text-xs text-warning">override (default: {def})</span>
        )}
      </div>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      >
        {choices.map((m) => (
          <option key={m} value={m}>
            {m}
            {m === def ? "  (default)" : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function KeyState({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CheckCircle2 className="h-4 w-4" /> set
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-danger">
      <XCircle className="h-4 w-4" /> missing
    </span>
  );
}
