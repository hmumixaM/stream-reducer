import type { Env } from "../env";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

// bge-m3 caps each request at 60k tokens across the whole batch. CJK text
// tokenizes to >1 token/char, so batch by a conservative character budget
// (with a count cap) rather than a fixed count.
const CHAR_BUDGET = 16000;
const MAX_PER_CALL = 50;

function isContextLimit(e: unknown): boolean {
  return /max context|3030/i.test(String((e as { message?: string })?.message ?? e));
}

async function runEmbed(env: Env, batch: string[]): Promise<number[][]> {
  try {
    const res = (await (env.AI as { run: (m: string, i: unknown) => Promise<unknown> }).run(
      EMBEDDING_MODEL,
      { text: batch },
    )) as { data: number[][] };
    return res.data.map(normalize);
  } catch (e) {
    if (isContextLimit(e) && batch.length > 1) {
      const mid = Math.floor(batch.length / 2);
      return [...(await runEmbed(env, batch.slice(0, mid))), ...(await runEmbed(env, batch.slice(mid)))];
    }
    if (isContextLimit(e)) {
      // A single chunk over budget: truncate to a safe length and retry.
      return runEmbed(env, [batch[0].slice(0, 2000)]);
    }
    throw e;
  }
}

// Embed texts with Workers AI (bge-m3, 1024-dim). Vectors are unit-normalized
// so a dot-product / cosine index ranks correctly.
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const t of texts) {
    const n = Math.max(1, t.length);
    if (cur.length && (size + n > CHAR_BUDGET || cur.length >= MAX_PER_CALL)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += n;
  }
  if (cur.length) batches.push(cur);

  const out: number[][] = [];
  for (const batch of batches) out.push(...(await runEmbed(env, batch)));
  return out;
}

export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vec.map((x) => x / norm);
}
