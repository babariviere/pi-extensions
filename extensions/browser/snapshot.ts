/** Page snapshot: capped visible text plus numbered interactive elements. */

export interface SnapshotElement {
	ref: number;
	role: string;
	name: string;
	href?: string;
	value?: string;
	checked?: boolean;
	disabled?: boolean;
	/** Outside the current viewport; click and type scroll it into view first. */
	offscreen?: boolean;
}

export interface Snapshot {
	url: string;
	title: string;
	text: string;
	textTruncated: boolean;
	totalTextChars: number;
	elements: SnapshotElement[];
	totalElements: number;
}

/** Attribute that tags snapshot elements so actions can find them by ref. */
export const REF_ATTRIBUTE = "data-pi-ref";

/**
 * In-page script that tags interactive elements with sequential refs and
 * returns a Snapshot. Refs are reassigned on every snapshot, so actions must
 * use refs from the latest one. Kept as plain JavaScript source (not a
 * serialized function) so loader-injected helpers can never leak into it.
 */
const SNAPSHOT_SOURCE = String.raw`(maxChars, maxElements, refAttribute) => {
	const roles = ["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "textbox", "searchbox"];
	const selector = [
		"a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
		"[contenteditable='']", "[contenteditable='true']", "[onclick]",
		...roles.map((role) => "[role=" + role + "]"),
	].join(",");
	for (const el of document.querySelectorAll("[" + refAttribute + "]")) el.removeAttribute(refAttribute);

	const clean = (s, max = 100) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "select") return "select";
		if (tag === "textarea") return "textbox";
		if (tag === "input") {
			const type = el.type;
			if (type === "checkbox" || type === "radio") return type;
			if (["submit", "reset", "button", "image"].includes(type)) return "button";
			return type === "search" ? "searchbox" : "textbox";
		}
		if (el.isContentEditable) return "textbox";
		return "clickable";
	};

	const elements = [];
	let total = 0;
	for (const el of document.querySelectorAll(selector)) {
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) continue;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none") continue;
		total++;
		if (elements.length >= maxElements) continue;

		const ref = elements.length + 1;
		el.setAttribute(refAttribute, String(ref));
		const role = roleOf(el);
		const name = clean(
			el.getAttribute("aria-label") ||
				(el.labels && el.labels[0] && el.labels[0].innerText) ||
				el.placeholder ||
				el.innerText ||
				(role === "button" ? el.value : "") ||
				el.title ||
				el.getAttribute("alt") ||
				(el.querySelector("img[alt]") && el.querySelector("img[alt]").getAttribute("alt")),
		);
		const item = { ref, role, name };
		if (el instanceof HTMLAnchorElement && el.href) item.href = el.href.slice(0, 300);
		if (["textbox", "searchbox", "select", "combobox"].includes(role) && "value" in el) {
			item.value = el.type === "password" ? (el.value ? "••••" : "") : clean(el.value);
		}
		if (role === "checkbox" || role === "radio" || role === "switch") {
			item.checked = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
		}
		if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
		if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) item.offscreen = true;
		elements.push(item);
	}

	const text = (document.body && document.body.innerText) || "";
	return {
		url: location.href,
		title: document.title,
		text: text.slice(0, maxChars),
		textTruncated: text.length > maxChars,
		totalTextChars: text.length,
		elements,
		totalElements: total,
	};
}`;

/** Expression that takes a snapshot in the page. */
export function snapshotExpression(maxChars: number, maxElements: number): string {
	return `(${SNAPSHOT_SOURCE})(${maxChars}, ${maxElements}, ${JSON.stringify(REF_ATTRIBUTE)})`;
}

/** Model-facing rendering of a snapshot. */
export function formatSnapshot(snapshot: Snapshot): string {
	const lines = [`Title: ${snapshot.title || "(none)"}`, `URL: ${snapshot.url}`, ""];
	const textNote = snapshot.textTruncated
		? ` (first ${snapshot.text.length} of ${snapshot.totalTextChars} chars)`
		: "";
	lines.push(`Text${textNote}:`, snapshot.text.trim() || "(empty)", "");
	const countNote =
		snapshot.totalElements > snapshot.elements.length
			? ` (${snapshot.elements.length} of ${snapshot.totalElements})`
			: "";
	lines.push(`Elements${countNote}:`);
	if (!snapshot.elements.length) lines.push("(none)");
	for (const el of snapshot.elements) lines.push(formatElement(el));
	return lines.join("\n");
}

export function formatElement(el: SnapshotElement): string {
	let line = `[${el.ref}] ${el.role} ${JSON.stringify(el.name)}`;
	if (el.value !== undefined) line += ` value=${JSON.stringify(el.value)}`;
	if (el.checked !== undefined) line += el.checked ? " checked" : " unchecked";
	if (el.disabled) line += " disabled";
	if (el.offscreen) line += " offscreen";
	if (el.href) line += ` -> ${el.href}`;
	return line;
}
