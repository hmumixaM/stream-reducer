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
        primaryColor: "#f5f3ff",
        primaryTextColor: "#312e81",
        primaryBorderColor: "#8b5cf6",
        lineColor: "#7c3aed",
        secondaryColor: "#ecfeff",
        tertiaryColor: "#f0fdf4",
        clusterBkg: "#ffffff",
        clusterBorder: "#c4b5fd",
        edgeLabelBackground: "#fafafa",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon, .node path {
          filter: drop-shadow(0 4px 7px rgb(76 29 149 / 0.14));
          stroke-width: 1.5px;
        }
        .node rect {
          rx: 10px;
          ry: 10px;
        }
        .nodeLabel, .edgeLabel {
          font-weight: 600;
        }
        .edgePath .path {
          stroke-width: 2px;
        }
        .cluster rect {
          rx: 14px;
          ry: 14px;
          filter: drop-shadow(0 6px 12px rgb(15 23 42 / 0.08));
        }
      `,
      flowchart: {
        curve: "basis",
        htmlLabels: false,
        nodeSpacing: 42,
        rankSpacing: 52,
        padding: 14,
        useMaxWidth: true,
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
