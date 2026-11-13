/**
 * Stable Phase 1 domain failures. The Host Remote adapter maps these codes to
 * the wire vocabulary; callers inside the Host can branch on the code without
 * parsing messages.
 * @module @deepseek-ai/dsh-research-core/errors
 */

/** Closed Phase 1 failure vocabulary. */
export type ResearchErrorCode =
  | 'research/idea-not-found'
  | 'research/relation-not-found'
  | 'research/version-conflict'
  | 'research/invalid-transition'
  | 'research/invalid-input'
  | 'research/parent-cycle'
  | 'research/relation-invalid'
  | 'research/database-unavailable'

/** One structured research-domain failure. */
export class ResearchError extends Error {
  /**
   * @param code - stable machine-routable failure code.
   * @param message - actionable human-readable message.
   * @param details - lossless-JSON context for the caller.
   */
  constructor(
    readonly code: ResearchErrorCode,
    message: string,
    readonly details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message)
    this.name = 'ResearchError'
  }
}

/**
 * Whether a value is one structured research failure.
 * @param value - candidate error.
 * @returns true for the exact class (including subclasses).
 */
export function isResearchError(value: unknown): value is ResearchError {
  return value instanceof ResearchError
}
