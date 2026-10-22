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
  nativeEnglish = false,
  allowMoreLanguages = true,
  onSelect,
  onRequest,
}: {
  active: string | null;
  translations: { lang: string; status: string }[];
  authed: boolean;
  busy: boolean;
  zhUi: boolean;
  nativeChinese?: boolean;
  nativeEnglish?: boolean;
  allowMoreLanguages?: boolean;
  onSelect: (lang: string | null) => void;
  onRequest: (lang: string) => void;
}) {
  const [pick, setPick] = useState("");
  const status = new Map(translations.map((row) => [row.lang, row.status]));
  const extras = translations.filter((row) => !PRIMARY.includes(row.lang));
  const remaining = TRANSLATE_LANGS.filter((lang) => !PRIMARY.includes(lang.code) && !status.has(lang.code));

  const isOriginalLanguage = (code: string | null) => (code === "zh" && nativeChinese) || (code === "en" && nativeEnglish);
  const choose = (code: string | null) => {
    if (isOriginalLanguage(code)) {
      onSelect(null);
      return;
    }
    if (code != null && !status.has(code)) onRequest(code);
    else onSelect(code);
  };

  const chip = (code: string | null, label: string) => {
    const pending = code != null && !isOriginalLanguage(code) && status.has(code) && !["done", "error"].includes(status.get(code) || "");
    return (
      <button
        key={label}
        type="button"
        aria-pressed={active === code}
        disabled={busy || (!authed && code != null && !isOriginalLanguage(code) && !status.has(code))}
        title={!authed && code != null && !status.has(code) && !isOriginalLanguage(code) ? (zhUi ? "登录后生成此语言版本" : "Sign in to prepare this language") : undefined}
        onClick={() => choose(code)}
        className={cn(
          "min-h-11 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
          active === code
            ? "border-primary bg-primary text-primary-foreground dark:text-background"
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
      {authed && allowMoreLanguages && remaining.length > 0 && (
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
