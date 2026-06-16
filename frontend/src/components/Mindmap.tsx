import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { AlertCircle } from "lucide-react";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
});

interface MindmapProps {
  chart: string;
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
        const { svg } = await mermaid.render(id, chart);
        
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
      className="w-full overflow-auto flex justify-center py-4 mermaid-container"
      ref={containerRef}
    />
  );
}
