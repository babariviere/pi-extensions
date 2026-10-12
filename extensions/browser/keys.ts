/** Translate key specs like "Enter" or "Control+Shift+a" into CDP key events. */

export interface KeySpec {
	key: string;
	code: string;
	keyCode: number;
	/** Text the key inserts, when it is printable and no command modifier is held. */
	text?: string;
	/** CDP modifier bitmask: Alt 1, Control 2, Meta 4, Shift 8. */
	modifiers: number;
}

const NAMED: Record<string, { code: string; keyCode: number; text?: string; key?: string }> = {
	Enter: { code: "Enter", keyCode: 13, text: "\r" },
	Tab: { code: "Tab", keyCode: 9 },
	Escape: { code: "Escape", keyCode: 27 },
	Backspace: { code: "Backspace", keyCode: 8 },
	Delete: { code: "Delete", keyCode: 46 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { code: "ArrowRight", keyCode: 39 },
	Home: { code: "Home", keyCode: 36 },
	End: { code: "End", keyCode: 35 },
	PageUp: { code: "PageUp", keyCode: 33 },
	PageDown: { code: "PageDown", keyCode: 34 },
	Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};

const ALIASES: Record<string, string> = {
	return: "Enter",
	esc: "Escape",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	del: "Delete",
	" ": "Space",
};

const MODIFIERS: Record<string, number> = {
	alt: 1,
	option: 1,
	control: 2,
	ctrl: 2,
	meta: 4,
	cmd: 4,
	command: 4,
	shift: 8,
};

export function parseKey(spec: string): KeySpec {
	const match = /^((?:[A-Za-z]+\+)*)(.+)$/.exec(spec);
	if (!match) throw new Error(`Invalid key: "${spec}"`);
	let modifiers = 0;
	for (const name of match[1]!.split("+").filter(Boolean)) {
		const bit = MODIFIERS[name.toLowerCase()];
		if (bit === undefined) throw new Error(`Unknown modifier "${name}" in key "${spec}"`);
		modifiers |= bit;
	}
	const raw = match[2]!;
	const commandHeld = (modifiers & 7) !== 0;

	if (raw.length === 1) {
		const shifted = (modifiers & 8) !== 0 && /[a-z]/.test(raw);
		const key = shifted ? raw.toUpperCase() : raw;
		const upper = raw.toUpperCase();
		const code = /[a-z]/i.test(raw) ? `Key${upper}` : /[0-9]/.test(raw) ? `Digit${raw}` : raw === " " ? "Space" : "";
		const keyCode = /[a-z0-9 ]/i.test(raw) ? upper.charCodeAt(0) : 0;
		return { key, code, keyCode, modifiers, ...(commandHeld ? {} : { text: key }) };
	}

	const name = NAMED[raw]
		? raw
		: (ALIASES[raw.toLowerCase()] ?? Object.keys(NAMED).find((n) => n.toLowerCase() === raw.toLowerCase()));
	const named = name ? NAMED[name] : undefined;
	if (!name || !named)
		throw new Error(`Unknown key "${raw}". Use a single character or one of: ${Object.keys(NAMED).join(", ")}`);
	return {
		key: named.key ?? name,
		code: named.code,
		keyCode: named.keyCode,
		modifiers,
		...(named.text && !commandHeld ? { text: named.text } : {}),
	};
}
