import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

/**
 * Holographic edge. Idle = dim line. When `active` (upstream done, downstream in
 * progress or further along), a bright gradient stroke flows AND luminous
 * "packets" ride the path via SVG <animateMotion> — the signature effect,
 * pushed toward "Mission Control": data visibly travels the machine.
 */
export const FlowEdge = memo(function FlowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const state = (data as { state?: 'idle' | 'active' | 'done' } | undefined)?.state ?? 'idle';

  return (
    <>
      <BaseEdge id={id} path={edgePath} className={`flow-edge flow-edge--${state}`} />
      {state === 'active' && (
        <>
          <path d={edgePath} className="flow-edge__flow" fill="none" />
          <circle r="4" className="flow-edge__packet">
            <animateMotion dur="1.1s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r="2.5" className="flow-edge__packet flow-edge__packet--trail">
            <animateMotion dur="1.1s" begin="0.37s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r="2" className="flow-edge__packet flow-edge__packet--trail">
            <animateMotion dur="1.1s" begin="0.74s" repeatCount="indefinite" path={edgePath} />
          </circle>
        </>
      )}
    </>
  );
});
