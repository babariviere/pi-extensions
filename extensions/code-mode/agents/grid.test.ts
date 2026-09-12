import assert from "node:assert/strict";
import { test } from "node:test";
import { computeGrid } from "./grid.ts";

test("computeGrid tiles panes into even columns with remainder on the left", () => {
	const cases: Array<[number, number, number[]]> = [
		[1, 1, [1]],
		[2, 2, [1, 1]],
		[3, 2, [2, 1]],
		[4, 2, [2, 2]],
		[5, 3, [2, 2, 1]],
		[6, 3, [2, 2, 2]],
		[7, 3, [3, 2, 2]],
		[8, 3, [3, 3, 2]],
		[9, 3, [3, 3, 3]],
	];
	for (const [n, cols, rowsPerCol] of cases) {
		const plan = computeGrid(n);
		assert.equal(plan.cols, cols, `cols for n=${n}`);
		assert.deepEqual(plan.rowsPerCol, rowsPerCol, `rowsPerCol for n=${n}`);
	}
});

test("computeGrid row counts always sum to the pane count", () => {
	for (let n = 1; n <= 32; n++) {
		const plan = computeGrid(n);
		const total = plan.rowsPerCol.reduce((a, b) => a + b, 0);
		assert.equal(total, n, `sum for n=${n}`);
		assert.equal(plan.rowsPerCol.length, plan.cols, `column count for n=${n}`);
	}
});

test("computeGrid clamps non-positive input to a single pane", () => {
	assert.deepEqual(computeGrid(0), { cols: 1, rowsPerCol: [1] });
	assert.deepEqual(computeGrid(-3), { cols: 1, rowsPerCol: [1] });
});
