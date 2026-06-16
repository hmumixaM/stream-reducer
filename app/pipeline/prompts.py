"""Prompt templates for the lossless, source-traceable summarizer.

Strategy: the MAP step turns each transcript chunk into a *rich, detailed
chronological walkthrough* that preserves concrete details, anecdotes, numbers,
names and the section's mood. The REDUCE step does NOT compress that detail away;
instead it writes a high-level wrapper on top: background, TL;DR, the overall
atmosphere/vibe, the most important cross-cutting takeaways, top quotes, and
mentioned entities.
"""

from __future__ import annotations

MAP_SYSTEM = (
    "You are an expert writer and note-taker. You turn a portion of a transcript "
    "into a vivid, faithful, and DETAILED walkthrough that loses nothing important. "
    "Preserve every concrete detail: facts, arguments, examples, numbers, dates, "
    "names, causes and consequences. Crucially, also preserve the TEXTURE: the "
    "anecdotes and stories, the humor and banter, the tension and emotion, the "
    "asides and tangents, and how the speakers actually discuss things. Do NOT "
    "flatten the content into dry one-line bullets and do NOT editorialize or add "
    "facts that are not present. Keep [HH:MM:SS] timestamps so any claim can be "
    "traced to the source. Write in the SAME language as the transcript."
)

MAP_TEMPLATE = """Below is part {index} of {total} of a transcript. Each line is
prefixed with its [HH:MM:SS] timestamp.

Write a detailed, faithful walkthrough of THIS part as Markdown:
- Break it into one or more subsections, each starting with a heading of the form
  `### [HH:MM:SS] <short descriptive heading>` using the timestamp where that topic begins.
- Under each heading, write 1-3 paragraphs of flowing prose that capture what is
  said in depth: the specific details, numbers, names, and examples, AND the mood
  and the way it is discussed (stories, jokes, debates, emotional beats).
- After the prose, optionally add `- ` bullets for extra concrete data points,
  lists, or facts that deserve to stand alone.
- Weave in memorable verbatim quotes inline using "quotation marks".
- IMPORTANT: Put a [HH:MM:SS] timestamp ONLY on the section headings. Do NOT add
  timestamps inside the prose sentences or bullets — the prose must read cleanly
  with no inline timestamps. Start a new `###` subsection when a clearly distinct
  new topic begins (roughly every 1-3 minutes), rather than timestamping sentences.
- Be thorough. Do not skip substantive content. Do NOT write an overall title or
  any preamble/conclusion about the whole video — only cover this part.
- LANGUAGE: {language_instruction}

TRANSCRIPT PART:
{chunk}
"""

REDUCE_SYSTEM = (
    "You are an expert editor. You are given page metadata and an already-written, "
    "detailed chronological walkthrough of a piece of media. Write the high-level "
    "framing that sits on top of it. Never invent content; every claim must be "
    "supported by the walkthrough. Capture the overall ATMOSPHERE and feel, not just "
    "facts. Preserve timestamps so readers can jump to the source. Respond with "
    "STRICT JSON only, no markdown fences. Write all text fields in the SAME language "
    "as the walkthrough (JSON keys stay in English)."
)

REDUCE_TEMPLATE = """## Page background (metadata about where this came from)
{context}

## Detailed walkthrough (already written from the full transcript)
{notes}

---
Using the walkthrough above, write the high-level framing. The walkthrough already
holds the fine detail, so here you summarize and characterize the whole piece.

Return STRICT JSON with this exact shape:
{{
  "background": "1-3 sentences: who published/submitted it (uploader/author/channel), the platform, when, and what the page description says it is about. Use the page background above.",
  "tldr": "3-5 sentence high-level overview of the content itself.",
  "atmosphere": "2-4 sentences describing the overall tone, mood, narrative style, the speaker/host dynamics, the emotional arc, and what it actually FEELS like to watch or listen. Be specific and evocative but strictly faithful.",
  "key_points": [{{"text": "...", "timestamp": <seconds as number or null>}}],
  "quotes": [{{"text": "notable verbatim quote", "timestamp": <seconds or null>, "speaker": "name or null"}}],
  "entities": ["people, products, companies, works mentioned"]
}}

Rules:
- `background` MUST state who submitted/published the content and summarize the page description.
- `atmosphere` must describe the FEEL and vibe, not just restate facts.
- `key_points`: 8-20 of the most important cross-cutting takeaways (the big ideas
  and conclusions), NOT a full replay of every detail.
- `quotes`: include the most striking 8-15 verbatim quotes from the walkthrough.
- timestamps are numbers of seconds (e.g. 95 for 00:01:35), parsed from [HH:MM:SS] markers.
- LANGUAGE: {language_instruction}
"""

# Appended to the reduce system prompt on a retry when the first attempt didn't
# return parseable JSON (the model wrapped it in prose or a fence).
STRICT_JSON_SUFFIX = (
    " CRITICAL: Output ONLY the raw JSON object — start your response with '{' and "
    "end it with '}'. No prose, no explanation, no markdown code fences."
)

# Default directive: keep the model in the source language. Replaced with a
# stronger Simplified-Chinese mandate when the transcript is Chinese-dominant.
LANGUAGE_SAME_AS_SOURCE = (
    "Write all text fields in the SAME language as the transcript/source."
)
LANGUAGE_SIMPLIFIED_CHINESE = (
    "原文为简体中文，因此所有正文必须用【简体中文】撰写，绝对不要翻译成英文或其他语言。"
    "遇到英文专有名词、产品名、公司名或技术术语（如 AI、RAG、PMF、A/B test 等）时可保留英文原文，"
    "但叙述、解释与总结一律使用简体中文。"
)


def language_directive(text: str) -> str:
    """Pick the output-language instruction based on the source text.

    Forces Simplified Chinese when the sample is predominantly CJK so the
    summarizer stops drifting into English on Chinese (often tech-heavy) sources.
    """
    sample = (text or "")[:8000]
    cjk = sum(1 for ch in sample if "\u4e00" <= ch <= "\u9fff")
    latin = sum(1 for ch in sample if ch.isascii() and ch.isalpha())
    if cjk >= 20 and cjk >= latin:
        return LANGUAGE_SIMPLIFIED_CHINESE
    return LANGUAGE_SAME_AS_SOURCE

DIRECT_AUDIO_SYSTEM = (
    "You are an expert media analyst. Listen to the audio and produce a faithful, "
    "lossless structured summary. Respond with STRICT JSON only."
)

DANMAKU_SYSTEM = (
    "You analyze 弹幕 (timeline bullet-comments) that viewers posted while watching "
    "a video. Summarize the OVERALL emotional atmosphere of the audience and what "
    "they reacted to, joked about, or argued over. Be faithful to the comments and "
    "never invent. Respond with STRICT JSON only. Write all text in the SAME language "
    "as the comments (usually Chinese); JSON keys stay in English."
)

DANMAKU_TEMPLATE = """以下是观众在视频时间轴上发布的弹幕列表（每行格式：[时间] 内容），共 {count} 条。
请整体概括这些弹幕反映出的【观众情绪与氛围】，以及大家主要在讨论、吐槽、调侃或共鸣什么。

弹幕列表：
{danmaku}

返回严格 JSON（不要使用 markdown 代码块）：
{{
  "overall_mood": "用 2-4 句话总结弹幕整体的情绪基调、氛围，以及观众的主要反应",
  "sentiment": {{"positive": <0-100 整数>, "neutral": <0-100 整数>, "negative": <0-100 整数>}},
  "themes": [{{"topic": "观众集中关注/吐槽/玩梗的点", "example": "一条有代表性的弹幕原文"}}],
  "highlights": ["最有代表性、最高频或最有趣的弹幕原文"]
}}

规则：
- sentiment 三个数值之和约等于 100，体现正面/中性/负面情绪的大致占比。
- themes 给出 3-8 个。
- highlights 给出 5-12 条弹幕原文。
- 用与弹幕相同的语言书写所有文本字段。
"""
