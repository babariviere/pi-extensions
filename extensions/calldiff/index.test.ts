import assert from "node:assert/strict";
import test from "node:test";
import { type CalldiffNode, renderShaped, shapeTree } from "./index.ts";

type Status = "same" | "added" | "removed";

function call(label: string, status: Status = "same", children: CalldiffNode[] = []): CalldiffNode {
	return { key: label.replace(/\(.*/, ""), label, status, kind: "call", children };
}

function branch(label: string, status: Status = "same", children: CalldiffNode[] = []): CalldiffNode {
	return { key: `if:${label}`, label: `if (${label})`, status, kind: "branch", children };
}

function render(root: CalldiffNode, defined: string[] | null, collapse = true): string {
	return renderShaped(shapeTree(root, { defined: defined ? new Set(defined) : null, collapse }));
}

test("drops stdlib calls and branch scaffolding, keeps the changed path", () => {
	// Shape of a real `calldiff diff` payload: one call swapped inside a helper,
	// buried under method calls on locals and if/switch nodes.
	const tree = call("filterTodos(todos, query)", "same", [
		call("query.trim()"),
		branch("!trimmed"),
		call("filter()"),
		call("map()"),
		call("trimmed.split()"),
		branch("tokens.length === 0"),
		call("buildTodoSearchText(todo)", "same", [
			call("join()"),
			call("trim()"),
			call("formatTodoId(id)", "removed"),
			call("displayTodoId(id)", "added", [
				call("formatTodoId(id)", "added"),
				call("normalizeTodoId(id)", "added", [
					call("id.trim()", "added"),
					branch('trimmed.startsWith("#")', "added", [call("trimmed.slice()", "added")]),
				]),
			]),
		]),
		call("fuzzyMatch()"),
		branch("matched", "same", [call("matches.push()")]),
		call("matches.sort()"),
	]);

	const defined = [
		"filterTodos",
		"buildTodoSearchText",
		"formatTodoId",
		"displayTodoId",
		"normalizeTodoId",
		"fuzzyMatch",
	];

	assert.equal(
		render(tree, defined),
		[
			"  filterTodos(todos, query)",
			"  \u251c\u2500 buildTodoSearchText(todo)",
			"- \u2502  \u251c\u2500 formatTodoId(id)",
			"+ \u2502  \u2514\u2500 displayTodoId(id)",
			"+ \u2502     \u251c\u2500 formatTodoId(id)",
			"+ \u2502     \u2514\u2500 normalizeTodoId(id)",
			"  \u2514\u2500 fuzzyMatch()",
		].join("\n"),
	);
});

test("collapses unchanged siblings but keeps context on both sides", () => {
	const kids = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
		i === 4 ? call(`fn${i}()`, "added") : call(`fn${i}()`),
	);
	const defined = kids.map((_, i) => `fn${i}`).concat("root");

	assert.equal(
		render(call("root()", "same", kids), defined),
		[
			"  root()",
			"  \u251c\u2500 \u2026 2 unchanged",
			"  \u251c\u2500 fn2()",
			"  \u251c\u2500 fn3()",
			"+ \u251c\u2500 fn4()",
			"  \u251c\u2500 fn5()",
			"  \u251c\u2500 fn6()",
			"  \u2514\u2500 \u2026 1 unchanged",
		].join("\n"),
	);
});

test("caps newly added subtrees instead of printing the whole thing", () => {
	const tree = call("root()", "same", [
		call("a()", "added", [
			call("b()", "added", [call("c()", "added", [call("d()", "added", [call("e()", "added")])])]),
		]),
	]);
	const defined = ["root", "a", "b", "c", "d", "e"];

	assert.equal(
		render(tree, defined),
		[
			"  root()",
			"+ \u2514\u2500 a()",
			"+    \u2514\u2500 b()",
			"+       \u2514\u2500 c()",
			"+          \u2514\u2500 \u2026 +2 more",
		].join("\n"),
	);
});

test("keeps every leaf when definition verification is unavailable", () => {
	const tree = call("root()", "same", [call("fmt.Println()"), call("doWork()", "added")]);

	assert.equal(
		render(tree, null),
		["  root()", "  \u251c\u2500 fmt.Println()", "+ \u2514\u2500 doWork()"].join("\n"),
	);
});

test("mode=tree keeps the full shape, only stripping noise", () => {
	const tree = call("root()", "same", [
		call("sb.WriteString()"),
		branch("ok", "same", [call("helper()")]),
	]);

	assert.equal(
		render(tree, ["root", "helper"], false),
		["  root()", "  \u2514\u2500 helper()"].join("\n"),
	);
});
