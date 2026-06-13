import type { Env } from "../env";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

// Embed texts with Workers AI (bge-m3, 1024-dim). Vectors are unit-normalized
// so a dot-product / cosine index ranks correctly.
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  // bge-m3 accepts batches; keep them modest to stay within request limits.
  const BATCH = 50;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = (await (env.AI as { run: (m: string, i: unknown) => Promise<unknown> }).run(
      EMBEDDING_MODEL,
      { text: batch },
    )) as { data: number[][] };
    for (const v of res.data) out.push(normalize(v));
  }
  return out;
}

export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vec.map((x) => x / norm);
}
