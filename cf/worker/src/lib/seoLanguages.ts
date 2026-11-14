// Public language URLs are based only on stored content, never on browser locale.
export type PublicLanguage =
  "en" | "zh" | "ja" | "ko" | "es" | "fr" | "de" | "ru";
export function publicLanguage(
  value: string | null | undefined,
): PublicLanguage | undefined {
  if (value === "en" || value === "en-US" || value === "en-GB") return "en";
  if (value === "zh" || value === "zh-CN" || value === "zh-Hans") return "zh";
  if (["ja", "ko", "es", "fr", "de", "ru"].includes(value || ""))
    return value as PublicLanguage;
  return undefined;
}
export function sourceLanguage(text: string): PublicLanguage {
  if (/[\u3040-\u30ff]/.test(text.slice(0, 3000))) return "ja";
  if (/[\uac00-\ud7af]/.test(text.slice(0, 3000))) return "ko";
  if ((text.slice(0, 3000).match(/[\u0400-\u04ff]/g)?.length || 0) > 100)
    return "ru";
  return (text.slice(0, 3000).match(/[\u3400-\u9fff]/g)?.length || 0) > 300
    ? "zh"
    : "en";
}
export function languagePlan(
  base: string,
  source: PublicLanguage,
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
    { lang: source === "zh" ? "zh-Hans" : source, url: base },
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
