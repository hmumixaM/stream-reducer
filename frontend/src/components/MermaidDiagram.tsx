import { useEffect, useState } from "react";

interface DiagramState {
  svg: string | null;
  error: string | null;
}

let initialized = false;
let nextDiagramId = 0;
let renderQueue = Promise.resolve();

async function renderDiagram(source: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        primaryColor: "#ede9fe",
        primaryTextColor: "#111827",
        primaryBorderColor: "#8b5cf6",
        lineColor: "#6b7280",
        secondaryColor: "#e0f2fe",
        tertiaryColor: "#f3f4f6",
        clusterBkg: "#f9fafb",
        clusterBorder: "#d1d5db",
        edgeLabelBackground: "#ffffff",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
      },
    });
    initialized = true;
  }

  let svg = "";
  renderQueue = renderQueue
    .catch(() => undefined)
    .then(async () => {
      const result = await mermaid.render(`mermaid-${nextDiagramId++}`, source);
      svg = result.svg;
    });
  await renderQueue;
  return svg;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [state, setState] = useState<DiagramState>({ svg: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ svg: null, error: null });

    renderDiagram(source)
      .then((svg) => {
        if (!cancelled) setState({ svg, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            svg: null,
            error: error instanceof Error ? error.message : "Unable to render diagram",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  if (state.error) {
    return (
      <pre data-diagram-error={state.error}>
        <code className="language-mermaid">{source}</code>
      </pre>
    );
  }

  return (
    <figure className="mermaid-diagram" aria-label="Flowchart">
      {state.svg ? (
        <div dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : (
        <div className="mermaid-diagram-loading" role="status">
          Rendering flowchart…
        </div>
      )}
      <figcaption className="sr-only">Flowchart generated from the summary</figcaption>
    </figure>
  );
}
