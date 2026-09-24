import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  GitBranch, Search, PackageCheck, UploadCloud, GitCommitHorizontal,
  Trash2, CheckCircle2, XCircle, AlertTriangle, Loader2, Circle,
} from 'lucide-react';
import type { WorkflowStageId, WorkflowStageStatus } from '../../api/types';

export interface StageNodeData {
  label: string;
  detail?: string;
  status: WorkflowStageStatus | 'pending';
  logCount: number;
  expanded: boolean;
  onToggle: (id: string) => void;
  stageId: string;
  [key: string]: unknown;
}

// One icon per stage "family" — gives each node an immediately recognizable glyph.
const STAGE_ICON: Record<string, typeof GitBranch> = {
  'clone-theme-icons': GitBranch,
  'clone-luz-next': GitBranch,
  'clone-klara-theme': GitBranch,
  'audit-icon': Search,
  'audit-duotone': Search,
  'audit-illustration': Search,
  'export-icon': PackageCheck,
  'export-duotone': PackageCheck,
  'export-illustration': PackageCheck,
  'commit-theme-icons': UploadCloud,
  'commit-luz-next': UploadCloud,
  'commit-klara-theme': UploadCloud,
  cleanup: Trash2,
  system: GitCommitHorizontal,
};

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  start: Loader2,
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  pending: Circle,
};

function iconFor(stageId: string) {
  // export-* / audit-* ids are template-literal types like `audit-icon` —
  // exact lookup first, fall back to prefix match for forward-compat.
  return STAGE_ICON[stageId]
    ?? STAGE_ICON[Object.keys(STAGE_ICON).find(k => stageId.startsWith(k.split('-')[0])) ?? '']
    ?? GitCommitHorizontal;
}

export const StageNode = memo(function StageNode({ data }: NodeProps) {
  const d = data as unknown as StageNodeData;
  const Icon = iconFor(d.stageId);
  const StatusIcon = STATUS_ICON[d.status] ?? Circle;

  return (
    <div className={`flow-node flow-node--${d.status}`}>
      <Handle type="target" position={Position.Left} className="flow-node__handle" />
      <Handle type="source" position={Position.Right} className="flow-node__handle" />

      {/* Emissive "core" — breathes while the machine is working. */}
      <span className="flow-node__core" aria-hidden="true" />

      <button
        type="button"
        className="flow-node__body"
        onClick={() => d.onToggle(d.stageId)}
        disabled={d.logCount === 0}
      >
        <span className="flow-node__icon-wrap">
          <Icon size={16} className="flow-node__icon" />
        </span>
        <span className="flow-node__text">
          <span className="flow-node__label">{d.label}</span>
          {d.detail && <span className="flow-node__detail">{d.detail}</span>}
        </span>
        <span className={`flow-node__status flow-node__status--${d.status}`}>
          <StatusIcon size={14} className={d.status === 'start' ? 'spin' : ''} />
        </span>
      </button>

      {/* Activity bar at the bottom edge — animated while running. */}
      <span className="flow-node__activity" aria-hidden="true" />

      {d.logCount > 0 && (
        <div className="flow-node__log-badge">{d.logCount}</div>
      )}
    </div>
  );
});

export type { WorkflowStageId };
