import { useEffect } from "react";
export const siteTitle = "Stream Reducer — Video & Podcast Summaries";
export const siteDescription =
  "Read clear summaries of YouTube videos, Bilibili videos and podcasts. Explore key ideas, detailed notes and timestamped sources in English and Chinese.";
export function updateMetadata(
  title: string,
  description: string,
  canonical: string,
  index = false,
) {
  document.title = title;
  document.documentElement.lang =
    ((title + description).match(/[\u3400-\u9fff]/g)?.length || 0) > 20
      ? "zh-CN"
      : "en";
  for (const [attribute, name, content] of [
    ["name", "description", description],
    [
      "name",
      "robots",
      index
        ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
        : "noindex, follow",
    ],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", canonical],
  ]) {
    let tag = document.head.querySelector<HTMLMetaElement>(
      `meta[${attribute}="${name}"]`,
    );
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute(attribute, name);
      document.head.appendChild(tag);
    }
    tag.content = content;
  }
  let link = document.head.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  if (link.href !== canonical) {
    document.getElementById("seo-schema")?.remove();
    document.head.querySelector('meta[property="og:image"]')?.remove();
  }
  link.href = canonical;
}
export function useArticleMetadata(
  id: number,
  title?: string | null,
  description?: string | null,
  index = true,
) {
  useEffect(() => {
    if (!title) return;
    updateMetadata(
      `${title} | Stream Reducer`,
      (description || siteDescription).replace(/[#*`_]/g, "").slice(0, 180),
      `https://reducer.xgoose.org/items/${id}`,
      index,
    );
  }, [id, title, description, index]);
}
