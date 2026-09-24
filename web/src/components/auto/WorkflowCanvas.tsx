import { useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls,
  useReactFlow, BackgroundVariant, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AnimatePresence, motion } from 'framer-motion';
import type { WorkflowStageEvent } from '../../api/types';
import { StageNode, type StageNodeData } from './StageNode';
import { FlowEdge } from './FlowEdge';

export interface StageState {
  event: WorkflowStageEvent;
  logs: string[];
}

interface Props {
  stages: StageState[];
  expandedStage: string | null;
  onToggleExpand: (id: string) => void;
}

const nodeTypes = { stage: StageNode };
const edgeTypes = { flow: FlowEdge };

// Column bucket per stage family — purely visual grouping, mirrors the real
// pipeline shape (clone -> audit -> export -> commit -> cleanup) without
// requiring the caller to pass full topology info.
function columnFor(stageId: string): number {
  if (stageId.startsWith('clone-')) return 0;
  if (stageId.startsWith('audit-')) return 1;
  if (stageId.startsWith('export-')) return 2;
  if (stageId.startsWith('commit-')) return 3;
  if (stageId === 'cleanup') return 4;
  return 4; // 'system' and anything unrecognized lands in the last column
}

const COL_WIDTH = 260;
const ROW_HEIGHT = 92;

function buildGraph(
  stages: StageState[],
  expandedStage: string | null,
  onToggleExpand: (id: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const colCounts: Record<number, number> = {};
  const nodes: Node[] = stages.map(s => {
    const col = columnFor(s.event.id);
    const row = colCounts[col] ?? 0;
    colCounts[col] = row + 1;
    const data: StageNodeData = {
      label: s.event.label,
      detail: s.event.detail,
      status: s.event.status,
      logCount: s.logs.length,
      expanded: expandedStage === s.event.id,
      onToggle: onToggleExpand,
      stageId: s.event.id,
    };
    return {
      id: s.event.id,
      type: 'stage',
      position: { x: col * COL_WIDTH, y: row * ROW_HEIGHT },
      data: data as unknown as Record<string, unknown>,
      draggable: false,
      selectable: false,
    };
  });

  // Connect nodes in arrival order — this already reflects real dependency
  // order (audit before export, export before commit, etc.) since the
  // server emits stage events in that sequence.
  const edges: Edge[] = [];
  for (let i = 0; i < stages.length - 1; i++) {
    const source = stages[i];
    const target = stages[i + 1];
    const state = source.event.status === 'ok'
      ? (target.event.status === 'start' ? 'active' : 'done')
      : 'idle';
    edges.push({
      id: `${source.event.id}->${target.event.id}`,
      source: source.event.id,
      target: target.event.id,
      type: 'flow',
      data: { state },
    });
  }

  return { nodes, edges };
}

function CanvasInner({ stages, expandedStage, onToggleExpand }: Props) {
  const { nodes, edges } = useMemo(
    () => buildGraph(stages, expandedStage, onToggleExpand),
    [stages, expandedStage, onToggleExpand],
  );
  const { fitView } = useReactFlow();
  const prevCount = useRef(0);

  // Keep the active/newest node in view as the graph grows, without fighting
  // the user if they've manually panned/zoomed mid-run.
  useEffect(() => {
    if (nodes.length !== prevCount.current) {
      prevCount.current = nodes.length;
      const id = requestAnimationFrame(() => {
        fitView({ padding: 0.3, duration: 400, maxZoom: 1.1 });
      });
      return () => cancelAnimationFrame(id);
    }
  }, [nodes.length, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      zoomOnScroll={false}
      minZoom={0.3}
      maxZoom={1.5}
      style={{ background: 'transparent' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="flow-canvas__bg" />
      <Controls showInteractive={false} className="flow-canvas__controls" />
    </ReactFlow>
  );
}

/**
 * Live workflow graph — the "n8n-style" hero. Renders each streamed stage as
 * a node (appearing progressively as events arrive) with animated edges that
 * "flow" while the downstream stage is active. Drop-in replacement for
 * PipelineTimeline: same stages/expandedStage/onToggleExpand contract.
 */
export function WorkflowCanvas(props: Props) {
  const { stages, expandedStage, onToggleExpand } = props;
  const expandedEntry = stages.find(s => s.event.id === expandedStage);

  return (
    <div className="flow-canvas">
      <AnimatePresence>
        {stages.length === 0 && (
          <motion.div
            className="flow-canvas__empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            Waiting for the first stage to start…
          </motion.div>
        )}
      </AnimatePresence>
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>

      {/* Side drawer: logs for whichever node the user clicked. */}
      <AnimatePresence>
        {expandedEntry && (
          <motion.div
            className="flow-canvas__drawer"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          >
            <div className="flow-canvas__drawer-header">
              <span className="flow-canvas__drawer-title">{expandedEntry.event.label}</span>
              <button
                className="flow-canvas__drawer-close"
                onClick={() => onToggleExpand(expandedEntry.event.id)}
                aria-label="Close log panel"
              >
                ×
              </button>
            </div>
            <pre className="flow-canvas__drawer-body">
              {expandedEntry.logs.length > 0 ? expandedEntry.logs.join('\n') : '(no log output for this stage)'}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
