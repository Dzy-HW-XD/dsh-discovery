/** Wire-safe projections of Research Session bindings. */
import type {
  ResearchSessionBinding,
  ResearchSessionCheckpoint,
  ResearchSessionIdeaLink,
} from '@deepseek-ai/dsh-research-core'
import type {
  ResearchSessionCheckpointView,
  ResearchSessionIdeaLinkView,
  ResearchSessionView,
} from './types.ts'

/**
 * Project one domain binding to the wire.
 * @param binding - domain binding.
 * @returns wire-safe binding.
 */
export function toSessionView(binding: ResearchSessionBinding): ResearchSessionView {
  return {
    sessionId: binding.sessionId,
    ...binding.ideaId === undefined ? {} : { ideaId: binding.ideaId },
    role: binding.role,
    status: binding.status,
    bindingSource: binding.bindingSource,
    ...binding.workspaceId === undefined ? {} : { workspaceId: binding.workspaceId },
    ...binding.cwd === undefined ? {} : { cwd: binding.cwd },
    ...binding.agentPreset === undefined ? {} : { agentPreset: binding.agentPreset },
    origin: binding.origin,
    createdAt: binding.createdAt,
    ...binding.boundAt === undefined ? {} : { boundAt: binding.boundAt },
    ...binding.finalizedAt === undefined ? {} : { finalizedAt: binding.finalizedAt },
    ...binding.lastError === undefined ? {} : { lastError: binding.lastError },
    version: binding.version,
  }
}

/**
 * Project one checkpoint to the wire.
 * @param checkpoint - domain checkpoint.
 * @returns wire-safe checkpoint.
 */
export function toCheckpointView(checkpoint: ResearchSessionCheckpoint): ResearchSessionCheckpointView {
  return {
    sessionId: checkpoint.sessionId,
    lastSeenSeq: checkpoint.lastSeenSeq,
    lastSuccessfullyProcessedSeq: checkpoint.lastSuccessfullyProcessedSeq,
    lastSummarizedSeq: checkpoint.lastSummarizedSeq,
    status: checkpoint.status,
    attempts: checkpoint.attempts,
    ...checkpoint.lastError === undefined ? {} : { lastError: checkpoint.lastError },
    updatedAt: checkpoint.updatedAt,
  }
}

/**
 * Project one non-primary Idea link to the wire.
 * @param link - domain link.
 * @returns wire-safe link.
 */
export function toIdeaLinkView(link: ResearchSessionIdeaLink): ResearchSessionIdeaLinkView {
  return {
    sessionId: link.sessionId,
    ideaId: link.ideaId,
    linkType: link.linkType,
    note: link.note,
    createdAt: link.createdAt,
  }
}
