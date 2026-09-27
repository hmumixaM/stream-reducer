import { useState } from "react";
import { Languages } from "lucide-react";
import { TRANSLATE_LANGS } from "@/lib/api";
import { Button, Select, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

const PRIMARY = ["zh", "en"];

export function languageLabel(code: string): string {
  return TRANSLATE_LANGS.find((lang) => lang.code === code)?.label ?? code;
}

// One language control for the full reading edition. 原文, 简体中文, and English
// stay in that order on every reading surface so a Chinese preference can still
// open the English edition of the same summary.
export function ContentLanguageBar({
  active,
  translations,
  authed,
  busy,
  zhUi,
  nativeChinese = false,
  onSelect,
  onRequest,
}: {
  active: string | null;
  translations: { lang: string; status: string }[];
  authed: boolean;
  busy: boolean;
  zhUi: boolean;
  nativeChinese?: boolean;
  onSelect: (lang: string | null) => void;
  onRequest: (lang: string) => void;
}) {
  const [pick, setPick] = useState("");
  const status = new Map(translations.map((row) => [row.lang, row.status]));
  const extras = translations.filter((row) => !PRIMARY.includes(row.lang));
  const remaining = TRANSLATE_LANGS.filter((lang) => !PRIMARY.includes(lang.code) && !status.has(lang.code));

  const choose = (code: string | null) => {
    if (code === "zh" && nativeChinese) {
      onSelect(null);
      return;
    }
    if (code != null && !status.has(code)) onRequest(code);
    else onSelect(code);
  };

  const chip = (code: string | null, label: string) => {
    const pending = code != null && !(code === "zh" && nativeChinese) && status.has(code) && !["done", "error"].includes(status.get(code) || "");
    return (
      <button
        key={label}
        type="button"
        onClick={() => choose(code)}
        className={cn(
          "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
          active === code
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-muted-foreground hover:bg-accent",
        )}
      >
        {label}{pending ? " …" : ""}
      </button>
    );
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <Languages className="mr-1 h-4 w-4 text-muted-foreground" aria-hidden />
      {chip(null, zhUi ? "原文" : "Original")}
      {chip("zh", "简体中文")}
      {chip("en", "English")}
      {extras.map((row) => chip(row.lang, languageLabel(row.lang)))}
      {authed && remaining.length > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <Select value={pick} onChange={(event) => setPick(event.target.value)} className="h-8 w-auto py-0 text-xs" aria-label={zhUi ? "翻译成其他语言" : "Translate to another language"}>
            <option value="">{zhUi ? "其他语言…" : "More languages…"}</option>
            {remaining.map((lang) => <option key={lang.code} value={lang.code}>{lang.label}</option>)}
          </Select>
          <Button size="sm" variant="outline" disabled={!pick || busy} onClick={() => { if (pick) onRequest(pick); }}>
            {busy ? <Spinner /> : <Languages className="h-4 w-4" />} {zhUi ? "翻译" : "Translate"}
          </Button>
        </span>
      )}
    </div>
  );
}
