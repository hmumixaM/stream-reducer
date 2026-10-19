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
  if (!src) return null;
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
        alt={`${title}${author ? ` — ${author}` : ""}`}
        width={160}
        height={90}
        loading="eager"
        decoding="async"
      />
    </a>
  );
}
