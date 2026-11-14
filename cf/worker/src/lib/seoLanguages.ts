import { isPredominantlyChinese } from "./chinese";
// Public language URLs are based only on stored content, never on browser locale.
export type PublicLanguage =
  | "en"
  | "zh"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "ru";
export type SourceLanguage = PublicLanguage | "und";
export function publicLanguage(
  value: string | null | undefined,
): PublicLanguage | undefined {
  if (/^(en(?:[-_].+)?|english)$/i.test(value || "")) return "en";
  const base = (value || "").toLowerCase().split(/[-_]/)[0];
  if (["zh", "ja", "ko", "es", "fr", "de", "ru"].includes(base))
    return base as PublicLanguage;
  return undefined;
}
export function sourceLanguage(
  text: string,
  hint?: string | null,
  available: string[] = [],
): SourceLanguage {
  const stored = publicLanguage(hint);
  if (stored) return stored;
  text = text.slice(0, 3000);
  if (/[\u3040-\u30ff]/.test(text.slice(0, 3000))) return "ja";
  if (/[\uac00-\ud7af]/.test(text.slice(0, 3000))) return "ko";
  if ((text.slice(0, 3000).match(/[\u0400-\u04ff]/g)?.length || 0) > 100)
    return "ru";
  if (isPredominantlyChinese(text)) return "zh";
  // Legacy Latin-script originals have no language tag. A separately stored
  // English edition is evidence that assuming English would hide real content.
  return available.some((lang) => publicLanguage(lang) === "en") ? "und" : "en";
}
export function languagePlan(
  base: string,
  source: SourceLanguage,
  available: string[],
  requested: string | null,
) {
  const targets = [
    ...new Set(
      available
        .map(publicLanguage)
        .filter((v): v is PublicLanguage => !!v && v !== source),
    ),
  ];
  const wanted = publicLanguage(requested);
  const missing =
    !!requested &&
    !["original", "auto"].includes(requested) &&
    (!wanted || (wanted !== source && !targets.includes(wanted)));
  const selected = wanted && !missing ? wanted : source;
  const variants = [
    ...(source === "und"
      ? []
      : [{ lang: source === "zh" ? "zh-Hans" : source, url: base }]),
    ...targets.map((lang) => ({
      lang: lang === "zh" ? "zh-Hans" : lang,
      url: `${base}?lang=${lang}`,
    })),
  ];
  return {
    selected,
    missing,
    language: selected === "zh" ? "zh-CN" : selected,
    canonical: selected === source ? base : `${base}?lang=${selected}`,
    alternates: [...variants, { lang: "x-default", url: base }],
  };
}

export const languageNames: Record<string, string> = {
  en: "English",
  "zh-Hans": "中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ru: "Русский",
};
