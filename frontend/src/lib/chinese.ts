// Keep in sync with cf/worker/src/lib/chinese.ts. A source that is already
// predominantly Chinese is shown as-is instead of being regenerated.
export function isPredominantlyChinese(text: string): boolean {
  const sample = (text || "").slice(0, 8000);
  let cjk = 0;
  let latin = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) latin += 1;
  }
  return cjk >= 20 && cjk >= latin;
}
