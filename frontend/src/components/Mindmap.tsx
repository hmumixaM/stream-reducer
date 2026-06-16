import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { AlertCircle } from "lucide-react";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    darkMode: true,
    fontFamily: "inherit",
    // Base colors
    primaryColor: "#0f172a",      // slate-900 (node background)
    primaryTextColor: "#f8fafc",  // slate-50 (node text)
    primaryBorderColor: "#3b82f6",// blue-500 (node border)
    lineColor: "#475569",         // slate-600 (edges)
    secondaryColor: "#1e293b",    // slate-800
    tertiaryColor: "#020617",     // slate-950 (root node)
    
    // Explicit cluster/background colors if flowchart uses subgraphs
    clusterBkg: "#0f172a",
    clusterBorder: "#334155",
  },
  mindmap: {
    padding: 16,
    maxNodeWidth: 250,
  },
  flowchart: {
    curve: "step",          // Angular, rectilinear lines ("step" or "linear") looks more like a structured map
    padding: 20,
    nodeSpacing: 40,
    rankSpacing: 40,
  },
});

interface MindmapProps {
  chart: string;
}

// LLMs frequently emit small Mermaid syntax mistakes. Repair the most common
// ones client-side so a single bad token doesn't blank the whole diagram.
function sanitizeChart(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences if any slipped through.
  text = text.replace(/^```(?:mermaid)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // Drop conversational preamble before the diagram keyword.
  const startMatch = text.match(/\b(mindmap|timeline|flowchart|graph)\b/i);
  if (startMatch && startMatch.index! > 0) {
    text = text.slice(startMatch.index!);
  }

  // Cut any trailing prose the model appended after the diagram (e.g.
  // "By the way, ..." postscripts that Gemini sometimes adds).
  text = text.replace(/\n\s*By the way[\s\S]*$/i, "").trim();

  // `</subgraph>` / `</subgraph` is invalid — Mermaid closes blocks with `end`.
  text = text.replace(/<\/subgraph>?/gi, "end");

  return text.trim();
}

export function Mindmap({ chart }: MindmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chart || !containerRef.current) return;

    let isMounted = true;
    setError(null);

    const renderChart = async () => {
      try {
        // Clear previous content
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }
        
        // Generate a unique ID for this render to avoid conflicts
        const id = `mindmap-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, sanitizeChart(chart));
        
        if (isMounted && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (isMounted) {
          console.error("Mermaid rendering error:", err);
          setError(err instanceof Error ? err.message : "Failed to render mindmap");
        }
      }
    };

    renderChart();

    return () => {
      isMounted = false;
    };
  }, [chart]);

  if (!chart) {
    return null;
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-400 p-4 border border-red-500/20 bg-red-500/10 rounded-md">
        <AlertCircle className="h-4 w-4" />
        <p>Failed to render mindmap. It may contain invalid syntax.</p>
      </div>
    );
  }

  return (
    <div 
      className="w-full flex justify-center [&>svg]:max-w-full [&>svg]:h-auto drop-shadow-md transition-transform duration-500 hover:scale-[1.02]"
      ref={containerRef}
    />
  );
}
