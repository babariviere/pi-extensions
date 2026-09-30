/**
 * Pure planner for arranging N subagent panes into an even grid.
 *
 * Instead of stacking every pane vertically (which squashes each into a thin
 * horizontal strip), we tile them into columns and rows so each pane gets a
 * usable rectangle. Columns count is `ceil(sqrt(n))`; rows are distributed as
 * evenly as possible across columns, with any remainder going to the leftmost
 * columns. Examples: n=4 -> 2 columns of 2 (2 left, 2 right); n=6 -> 3 columns
 * of 2; n=7 -> columns of 3,2,2.
 *
 * The planner emits nothing herdr-specific; herdr-backend consumes `rowsPerCol`
 * to drive the actual `right`/`down` splits.
 */

export interface GridPlan {
	/** Number of columns (left-to-right). */
	cols: number;
	/** Row count for each column, left-to-right. Sums to the pane count. */
	rowsPerCol: number[];
}

/** Compute an even grid layout for `n` panes. `n` is clamped to at least 1. */
export function computeGrid(n: number): GridPlan {
	const count = Math.max(1, Math.floor(n));
	const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
	const base = Math.floor(count / cols);
	const remainder = count % cols;
	// Leftmost `remainder` columns get one extra row so the grid is as even as
	// possible while still totaling exactly `count`.
	const rowsPerCol = Array.from({ length: cols }, (_, c) => base + (c < remainder ? 1 : 0));
	return { cols, rowsPerCol };
}
