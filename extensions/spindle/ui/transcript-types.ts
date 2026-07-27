/**
 * `SpindleLogLine`, copied verbatim from upstream `src/agents/types.ts` so the
 * vendored transcript parser/reader do not import a dropped subsystem.
 */
export interface SpindleLogLine {
  /** Legacy absolute line index; newer paged readers expose byte offset instead. */
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}
