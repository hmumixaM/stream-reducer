import { useState } from "react";

/** A small source preview beside the heading; the reading stays in focus. */
export function SourceCover({
  src,
  title,
  author,
  href,
}: {
  src?: string | null;
  title: string;
  author?: string | null;
  href: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return null;
  return (
    <a
      className="source-cover"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
    >
      <img
        src={src}
        onError={() => setFailedSrc(src)}
        alt={`${title}${author ? ` — ${author}` : ""}`}
        width={160}
        height={90}
        loading="eager"
        decoding="async"
      />
    </a>
  );
}
