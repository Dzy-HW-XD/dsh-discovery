/**
 * Narrow SQLite result rows at the persistence boundary. SQLite returns only
 * scalar JSON-safe values; repositories validate the few fields they rely on
 * instead of casting an entire row.
 * @module @deepseek-ai/dsh-research-core/rows
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ResearchError } from './errors.ts'

/** One row as returned by `node:sqlite`. */
export type SqlRow = Record<string, unknown>

/**
 * Read a required string column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the string value.
 * @throws ResearchError when the stored value is not a string.
 */
export function text(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not text`, { column })
  }
  return value
}

/**
 * Read a required integer column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the numeric value.
 * @throws ResearchError when the stored value is not a number.
 */
export function integer(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not an integer`, { column })
  }
  return value
}

/**
 * Read an optional string column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the string, or undefined for SQL NULL.
 */
export function optionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not text`, { column })
  }
  return value
}

/**
 * Read an optional integer column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the number, or undefined for SQL NULL.
 */
export function optionalInteger(row: SqlRow, column: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not an integer`, { column })
  }
  return value
}

/**
 * Parse one required JSON text column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the parsed value.
 */
export function json(row: SqlRow, column: string): JsonValue {
  try {
    return JSON.parse(text(row, column)) as JsonValue
  } catch (error) {
    if (error instanceof ResearchError) throw error
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not valid JSON`, { column })
  }
}

/**
 * Read a finite numeric column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the numeric value.
 */
export function real(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not a number`, { column })
  }
  return value
}

/**
 * Read an optional finite numeric column.
 * @param row - one SQLite row.
 * @param column - column name.
 * @returns the number, or undefined for SQL NULL.
 */
export function optionalReal(row: SqlRow, column: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ResearchError('research/database-unavailable', `research column "${column}" is not a number`, { column })
  }
  return value
}
