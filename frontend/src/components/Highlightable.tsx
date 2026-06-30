import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Highlighter, Trash2, Check } from "lucide-react";
import type { Highlight, HighlightSource, NewHighlight } from "@/lib/api";
import { cn } from "@/lib/utils";

// Tailwind needs the class strings to appear literally so they survive the JIT
// scan; keep the full classes (not interpolated) in this map.
const HL_COLORS: Record<string, string> = {
  yellow: "bg-yellow-300/50 dark:bg-yellow-400/25",
  green: "bg-emerald-300/50 dark:bg-emerald-400/25",
  blue: "bg-sky-300/50 dark:bg-sky-400/25",
  pink: "bg-pink-300/50 dark:bg-pink-400/25",
  orange: "bg-orange-300/50 dark:bg-orange-400/25",
};

const COLOR_DOTS: Record<string, string> = {
  yellow: "bg-yellow-400",
  green: "bg-emerald-400",
  blue: "bg-sky-400",
  pink: "bg-pink-400",
  orange: "bg-orange-400",
};

export function hlClass(color: string | null | undefined): string {
  return HL_COLORS[color || "yellow"] ?? HL_COLORS.yellow;
}

function unwrapMarks(root: HTMLElement) {
  root.querySelectorAll("mark[data-hl]").forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

// Text nodes under `root`, skipping any already inside a highlight mark so
// overlapping highlights don't nest.
function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (!node.parentElement?.closest("mark[data-hl]")) nodes.push(node);
    node = walker.nextNode() as Text | null;
  }
  return nodes;
}

function markFor(hl: Highlight, onClick: (id: number, el: HTMLElement) => void): HTMLElement {
  const mark = document.createElement("mark");
  mark.setAttribute("data-hl", String(hl.id));
  mark.className = cn(
    "rounded-[2px] px-0.5 text-inherit cursor-pointer transition-colors",
    hlClass(hl.color),
    hl.note ? "underline decoration-dotted underline-offset-2" : "",
  );
  mark.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(hl.id, mark);
  });
  return mark;
}

function wrapQuote(
  root: HTMLElement,
  hl: Highlight,
  onClick: (id: number, el: HTMLElement) => void,
) {
  const quote = hl.quote;
  if (!quote) return;

  // A highlight can span multiple paragraphs, i.e. several text nodes across
  // block elements, and the stored quote carries the selection's newlines that
  // the rendered DOM doesn't. So match on a whitespace-stripped index of all
  // text (CJK has no spaces; English spaces are dropped on both sides), map the
  // hit back to (node, offset) positions, and wrap each spanned text node's
  // segment in its own <mark> — surroundContents can't cross block boundaries.
  const nodes = collectTextNodes(root);
  let norm = "";
  const map: { node: Text; offset: number }[] = [];
  for (const node of nodes) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      if (!/\s/.test(text[i])) {
        norm += text[i];
        map.push({ node, offset: i });
      }
    }
  }

  const target = quote.replace(/\s+/g, "");
  if (!target) return;
  const start = norm.indexOf(target);
  if (start === -1) return;
  const end = start + target.length - 1;

  // The covered [min, max] character offset within each spanned text node.
  const ranges = new Map<Text, { min: number; max: number }>();
  for (let i = start; i <= end; i++) {
    const { node, offset } = map[i];
    const existing = ranges.get(node);
    if (!existing) ranges.set(node, { min: offset, max: offset });
    else existing.max = offset; // offsets are monotonic per node
  }

  for (const [node, { min, max }] of ranges) {
    const range = document.createRange();
    range.setStart(node, min);
    range.setEnd(node, max + 1);
    try {
      range.surroundContents(markFor(hl, onClick));
    } catch {
      // Range crossed an inline element boundary inside the node (rare); skip
      // this segment — the highlight still shows in the annotations feed.
    }
  }
}

interface ToolbarState {
  x: number;
  y: number;
  quote: string;
  prefix: string;
  suffix: string;
}

interface PopoverState {
  id: number;
  x: number;
  y: number;
}

/** Renders ``markdown`` and layers text-anchored highlights on top of it. */
export function HighlightableMarkdown({
  markdown,
  ...rest
}: {
  markdown: string;
  highlights: Highlight[];
  source: HighlightSource;
  readOnly?: boolean;
  onCreate: (h: NewHighlight) => void;
  onUpdateNote: (id: number, note: string) => void;
  onDelete: (id: number) => void;
  className?: string;
}) {
  // Memoize so parent re-renders (after a highlight mutation) reuse the same
  // element and React leaves the DOM — and our marks — intact.
  // remark-gfm: GFM tables, task lists, strikethrough, autolinks.
  // remark-math + rehype-katex: $inline$ / $$block$$ LaTeX (KaTeX CSS in main.tsx).
  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {markdown}
      </ReactMarkdown>
    ),
    [markdown],
  );
  return <HighlightLayer {...rest}>{rendered}</HighlightLayer>;
}

/**
 * Wraps arbitrary rendered ``children`` (markdown, transcript paragraphs, …)
 * with text-selection → highlight + per-mark note popover behaviour. Pass a
 * memoized ``children`` element so re-renders don't wipe the layered marks.
 */
export function HighlightLayer({
  children,
  highlights,
  source,
  readOnly = false,
  onCreate,
  onUpdateNote,
  onDelete,
  className,
}: {
  children: ReactNode;
  highlights: Highlight[];
  source: HighlightSource;
  readOnly?: boolean;
  onCreate: (h: NewHighlight) => void;
  onUpdateNote: (id: number, note: string) => void;
  onDelete: (id: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);

  const openPopover = useCallback((id: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setToolbar(null);
    setPopover({ id, x: rect.left, y: rect.bottom + window.scrollY + 6 });
  }, []);

  // (Re)apply the highlight marks whenever the text or the highlight set changes.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    unwrapMarks(root);
    for (const hl of highlights) wrapQuote(root, hl, openPopover);
    return () => {
      if (root) unwrapMarks(root);
    };
  }, [children, highlights, openPopover]);

  const handleMouseUp = useCallback(() => {
    if (readOnly) return;
    const sel = window.getSelection();
    const root = ref.current;
    if (!sel || sel.isCollapsed || !root) {
      setToolbar(null);
      return;
    }
    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    if (!text || !root.contains(range.commonAncestorContainer)) {
      setToolbar(null);
      return;
    }
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    const prefix = (startNode.textContent ?? "").slice(
      Math.max(0, range.startOffset - 40),
      range.startOffset,
    );
    const suffix = (endNode.textContent ?? "").slice(
      range.endOffset,
      range.endOffset + 40,
    );
    const rect = range.getBoundingClientRect();
    setToolbar({
      x: rect.left + rect.width / 2,
      y: rect.top + window.scrollY - 8,
      quote: text,
      prefix,
      suffix,
    });
  }, [readOnly]);

  // Dismiss the popover when clicking elsewhere.
  useEffect(() => {
    if (!popover) return;
    const onDoc = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-hl-popover]") || el.closest("mark[data-hl]")) return;
      setPopover(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [popover]);

  const create = (color: string) => {
    if (!toolbar) return;
    onCreate({
      quote: toolbar.quote,
      source,
      color,
      prefix: toolbar.prefix,
      suffix: toolbar.suffix,
    });
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  };

  const active = highlights.find((h) => h.id === popover?.id) ?? null;

  return (
    <>
      <div ref={ref} onMouseUp={handleMouseUp} className={className}>
        {children}
      </div>

      {toolbar && (
        <div
          className="fixed z-50 -translate-x-1/2 -translate-y-full"
          style={{ left: toolbar.x, top: toolbar.y - window.scrollY }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-lg">
            <span className="px-1 text-muted-foreground">
              <Highlighter className="h-4 w-4" />
            </span>
            {Object.keys(HL_COLORS).map((c) => (
              <button
                key={c}
                title={`Highlight (${c})`}
                onClick={() => create(c)}
                className={cn(
                  "h-5 w-5 rounded-full border border-black/10 transition-transform hover:scale-110",
                  COLOR_DOTS[c],
                )}
              />
            ))}
          </div>
        </div>
      )}

      {active && popover && (
        <HighlightPopover
          key={active.id}
          highlight={active}
          x={popover.x}
          y={popover.y}
          readOnly={readOnly}
          onSave={(note) => {
            onUpdateNote(active.id, note);
            setPopover(null);
          }}
          onDelete={() => {
            onDelete(active.id);
            setPopover(null);
          }}
          onClose={() => setPopover(null)}
        />
      )}
    </>
  );
}

function HighlightPopover({
  highlight,
  x,
  y,
  readOnly,
  onSave,
  onDelete,
  onClose,
}: {
  highlight: Highlight;
  x: number;
  y: number;
  readOnly: boolean;
  onSave: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(highlight.note);
  return (
    <div
      data-hl-popover
      className="absolute z-50 w-72 rounded-lg border border-border bg-card p-3 shadow-xl"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - 300)), top: y }}
    >
      <blockquote
        className={cn(
          "mb-2 max-h-24 overflow-auto rounded border-l-2 border-border px-2 py-1 text-xs italic text-muted-foreground",
        )}
      >
        “{highlight.quote}”
      </blockquote>
      {readOnly ? (
        highlight.note ? (
          <p className="whitespace-pre-wrap text-sm">{highlight.note}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No note.</p>
        )
      ) : (
        <textarea
          autoFocus
          rows={3}
          placeholder="Add a note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      {!readOnly && (
        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={onDelete}
            title="Delete highlight"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(note)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Check className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
