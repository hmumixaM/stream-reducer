import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import type { GraphData, GraphNode } from "@/lib/api";
import {
  buildAdjacency,
  buildGraphCanvasData,
  highlightedNodeIds,
  type GraphCanvasLink,
  type GraphCanvasNode,
  type PinnedNodePositions,
} from "@/lib/graphModel";

export interface GraphCanvasHandle {
  focusNode: (id: number) => void;
  zoomToFit: () => void;
}

type ForceGraphApi = ForceGraphMethods<
  NodeObject<GraphCanvasNode>,
  LinkObject<GraphCanvasNode, GraphCanvasLink>
>;

// Stable, well-spread color per community (golden-angle hue).
function communityColor(community: number): string {
  const hue = (community * 137.508) % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

function nodeRadius(node: GraphNode): number {
  return 3 + Math.sqrt(node.degree + 1) * 1.3;
}

function snippet(node: GraphNode, n: number): string {
  const t = (node.text || node.title || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function linkEndpointId(endpoint: number | GraphCanvasNode): number {
  return typeof endpoint === "number" ? endpoint : endpoint.id;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, {
  data: GraphData;
  selectedId: number | null;
  onSelect: (id: number) => void;
}>(function GraphCanvas({ data, selectedId, onSelect }, ref) {
  const fgRef = useRef<ForceGraphApi>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 500 });
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [pinnedPositions, setPinnedPositions] = useState<PinnedNodePositions>({});

  const adjacency = useMemo(() => buildAdjacency(data.edges), [data.edges]);

  const graphData = useMemo(
    () => buildGraphCanvasData(data, pinnedPositions),
    [data, pinnedPositions],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const focusNode = useCallback((id: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    const node = graphData.nodes.find((n) => n.id === id);
    if (node && node.x !== undefined && node.y !== undefined) {
      fg.centerAt(node.x, node.y, 600);
      fg.zoom(3, 600);
    }
  }, [graphData]);

  useImperativeHandle(ref, () => ({
    focusNode,
    zoomToFit: () => fgRef.current?.zoomToFit(500, 60),
  }));

  useEffect(() => {
    const t = setTimeout(() => fgRef.current?.zoomToFit(500, 60), 700);
    return () => clearTimeout(t);
  }, [graphData]);

  const highlighted = useMemo(() => highlightedNodeIds(hoverNode, adjacency), [hoverNode, adjacency]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <ForceGraph2D
        ref={fgRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        nodeId="id"
        cooldownTicks={120}
        d3VelocityDecay={0.3}
        nodeLabel={(n: GraphCanvasNode) =>
          `<div style="max-width:280px"><b>${(n.title ?? "").replace(/</g, "&lt;")}</b><br/>${snippet(n, 160).replace(/</g, "&lt;")}</div>`
        }
        onNodeHover={(n: GraphCanvasNode | null) => setHoverNode(n ? n.id : null)}
        onNodeClick={(n: GraphCanvasNode) => onSelect(n.id)}
        onNodeDragEnd={(n: GraphCanvasNode) => {
          if (n.x === undefined || n.y === undefined) return;
          setPinnedPositions((current) => ({
            ...current,
            [n.id]: { fx: n.x as number, fy: n.y as number },
          }));
        }}
        linkColor={(l: GraphCanvasLink) =>
          highlighted && highlighted.has(linkEndpointId(l.source)) &&
          highlighted.has(linkEndpointId(l.target))
            ? "rgba(120,160,255,0.85)"
            : highlighted
              ? "rgba(140,140,160,0.06)"
              : "rgba(140,140,160,0.22)"
        }
        linkWidth={(l: GraphCanvasLink) => Math.max(0.4, l.weight * 2.5)}
        nodeCanvasObject={(node: GraphCanvasNode, ctx, globalScale) => {
          const r = nodeRadius(node);
          const faded = highlighted != null && !highlighted.has(node.id);
          const isSelected = node.id === selectedId;
          ctx.globalAlpha = faded ? 0.15 : 1;

          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
          ctx.fillStyle = communityColor(node.community);
          ctx.fill();
          if (isSelected) {
            ctx.lineWidth = 2 / globalScale;
            ctx.strokeStyle = "#fff";
            ctx.stroke();
          }

          const showLabel =
            globalScale > 2.2 || isSelected || (highlighted?.has(node.id) ?? false);
          if (showLabel && !faded) {
            const fontSize = Math.max(9 / globalScale, 2.5);
            ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "rgba(130,130,150,0.95)";
            ctx.fillText(snippet(node, 24), node.x!, node.y! + r + 1);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(node: GraphCanvasNode, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, nodeRadius(node) + 2, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
    </div>
  );
});
