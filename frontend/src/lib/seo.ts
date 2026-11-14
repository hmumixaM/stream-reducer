import { useEffect, useLayoutEffect, useRef } from "react";
export const siteTitle = "Stream Reducer — Video & Podcast Summaries";
export const siteDescription =
  "Read clear summaries of YouTube videos, Bilibili videos and podcasts. Explore key ideas, detailed notes and timestamped sources in English and Chinese.";
let publicMetadataOwner = false;
export const isPublicSeoPath = (path: string) => path === "/" || path === "/browse" || path === "/articles" || /^\/(?:items|bulletin|rss\/articles)\/\d+$/.test(path) || /^\/collections(?:\/[^/]+)?\/?$/.test(path);

export function updateMetadata(
  title: string,
  description: string,
  canonical: string,
  index = false,
  authoritative = false,
) {
  // The Worker owns public canonical, language, and eligibility decisions.
  // Legacy reader effects must not overwrite those after hydration.
  if (!authoritative && publicMetadataOwner && isPublicSeoPath(window.location.pathname)) return;
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

const publicHead = 'title,meta[name="description"],meta[name="robots"],meta[name="stream-reducer-seo"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],link[rel="alternate"][hreflang],script#seo-schema';

/** Keep the rendered document consistent with the same public Worker HTML.
 * GET only: it does not request generation or use private API metadata.
 */
export function usePublicMetadata(pathname: string, search: string, enabled = true) {
  const first = useRef(true);
  useLayoutEffect(() => {
    publicMetadataOwner = enabled;
    if (!enabled) return;
    const initial = first.current;
    first.current = false;
    if (isPublicSeoPath(pathname) && initial && document.head.querySelector('meta[name="stream-reducer-seo"]')) return;
    document.head.querySelectorAll('link[rel="alternate"][hreflang],meta[name="stream-reducer-seo"],script#seo-schema').forEach(e => e.remove());
    const target = new URL(pathname + search, window.location.origin);
    updateMetadata(siteTitle, siteDescription, "https://reducer.xgoose.org" + pathname + search, false, true);
    if (!isPublicSeoPath(pathname)) return;
    const controller = new AbortController();
    void fetch(target.href, { headers: { Accept: "text/html" }, signal: controller.signal })
      .then(async response => {
        if (!response.ok && response.status !== 404) throw new Error("Public metadata unavailable");
        const html = new DOMParser().parseFromString(await response.text(), "text/html");
        if (controller.signal.aborted || window.location.pathname + window.location.search !== pathname + search) return;
        if (!html.head.querySelector('meta[name="stream-reducer-seo"]')) return;
        document.head.querySelectorAll(publicHead).forEach(e => e.remove());
        html.head.querySelectorAll(publicHead).forEach(e => document.head.appendChild(document.importNode(e, true)));
        document.documentElement.lang = html.documentElement.lang || "en";
      }).catch(() => { /* A failed read keeps this navigation safely noindex. */ });
    return () => controller.abort();
  }, [pathname, search, enabled]);
}
