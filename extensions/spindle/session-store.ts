/**
 * The session-scoped scratchpad behind the guest's `τ` namespace.
 *
 * A `spindle_exec` program runs in a fresh QuickJS context, so everything it
 * does not return is lost. That is the right default (a program is a pure
 * function of its code plus the filesystem), but it forces a multi-step plan to
 * either re-derive a large intermediate or push it through the model's context
 * just to hand it to the next program. `τ` is the narrow escape hatch: an
 * explicit, JSON-only key/value store that outlives one program and dies with
 * the session.
 *
 * Three deliberate constraints:
 *
 * - **Explicit, not ambient.** `τ.get` / `τ.set` are calls, not property access
 *   on a magic object. A write can fail (a limit, a non-serializable value), and
 *   a failable operation must not look like an assignment. This is why `τ` does
 *   not mirror `π`, whose keys really are constants for the life of a program.
 * - **JSON only.** The interpreter is torn down between programs, so nothing
 *   with identity survives: no closures, no handles, no sockets. Values are
 *   stored as JSON text, which both enforces that and makes the byte accounting
 *   exact.
 * - **No eviction.** Over a limit, the write throws and names the keys already
 *   held. Silently dropping the entry a later program depends on would turn a
 *   budget into a nondeterministic bug.
 *
 * Discoverability is the other half of the contract and does not live here: the
 * model cannot see state it did not write in this turn, so `spindle_exec` echoes
 * the held keys in every result (`execution-service.ts` reads `keys()`,
 * `spindle-exec-tool.ts` renders them).
 */

/** Byte and count budgets for one session's store. */
export interface SpindleSessionStoreLimits {
	/** Maximum number of live keys. */
	maxKeys: number;
	/** Maximum serialized size of a single value. */
	maxValueBytes: number;
	/** Maximum serialized size of every value together. */
	maxTotalBytes: number;
	/** Maximum key length. */
	maxKeyChars: number;
}

export const DEFAULT_SESSION_STORE_LIMITS: SpindleSessionStoreLimits = {
	maxKeys: 64,
	maxValueBytes: 4 * 1024 * 1024,
	maxTotalBytes: 16 * 1024 * 1024,
	maxKeyChars: 64,
};

/** Keys must be safe to print in a result envelope and in an error message. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** One held key, as echoed back to the model. */
export interface SpindleSessionStoreKey {
	key: string;
	bytes: number;
	updatedAt: number;
	/**
	 * A bounded slice of the stored JSON, for the expand-to-inspect surface.
	 * Present only on `snapshot()`: `keys()` answers the guest, which can read
	 * the value itself and must not pay for a copy of it.
	 */
	preview?: string;
}

/** The outcome of a `τ.set`. */
export interface SpindleSessionStoreWrite {
	key: string;
	bytes: number;
	keys: string[];
}

/** The outcome of a `τ.get`; `found` distinguishes a stored null from a miss. */
export interface SpindleSessionStoreRead {
	key: string;
	found: boolean;
	value?: unknown;
}

interface Entry {
	json: string;
	bytes: number;
	updatedAt: number;
}

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export class SpindleSessionStore {
	readonly #entries = new Map<string, Entry>();
	readonly #limits: SpindleSessionStoreLimits;
	#bytes = 0;

	constructor(limits: Partial<SpindleSessionStoreLimits> = {}) {
		this.#limits = { ...DEFAULT_SESSION_STORE_LIMITS, ...limits };
	}

	get limits(): SpindleSessionStoreLimits {
		return this.#limits;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** Serialized bytes currently held. */
	get bytes(): number {
		return this.#bytes;
	}

	#key(value: unknown, operation: string): string {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`τ.${operation} needs a non-empty string key`);
		}
		if (value.length > this.#limits.maxKeyChars) {
			throw new Error(`τ.${operation} key is longer than ${this.#limits.maxKeyChars} characters`);
		}
		if (!KEY_PATTERN.test(value)) {
			throw new Error(
				`τ.${operation} key ${JSON.stringify(value)} is not allowed; use letters, digits, and . _ : - (starting with a letter or digit)`,
			);
		}
		return value;
	}

	/**
	 * Store `value` under `key`, replacing any previous entry.
	 *
	 * Throws rather than evicting: a program that overruns a budget must find out
	 * at the write, not discover a missing key three steps later.
	 */
	set(key: unknown, value: unknown): SpindleSessionStoreWrite {
		const name = this.#key(key, "set");
		let json: string | undefined;
		try {
			json = JSON.stringify(value);
		} catch (error) {
			throw new Error(
				`τ.set(${JSON.stringify(name)}) needs a JSON-serializable value: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (json === undefined) {
			throw new Error(
				`τ.set(${JSON.stringify(name)}) cannot store undefined or a function; store JSON data, or call τ.delete(${JSON.stringify(name)})`,
			);
		}
		const bytes = Buffer.byteLength(json, "utf8");
		if (bytes > this.#limits.maxValueBytes) {
			throw new Error(
				`τ.set(${JSON.stringify(name)}) value is ${formatBytes(bytes)}, over the ${formatBytes(this.#limits.maxValueBytes)} per-key limit; write it to a file instead`,
			);
		}
		const previous = this.#entries.get(name);
		if (!previous && this.#entries.size >= this.#limits.maxKeys) {
			throw new Error(
				`τ holds its limit of ${this.#limits.maxKeys} keys (${this.keyNames().join(", ")}); delete one before adding ${JSON.stringify(name)}`,
			);
		}
		const nextTotal = this.#bytes - (previous?.bytes ?? 0) + bytes;
		if (nextTotal > this.#limits.maxTotalBytes) {
			throw new Error(
				`τ would hold ${formatBytes(nextTotal)}, over its ${formatBytes(this.#limits.maxTotalBytes)} session limit (held: ${this.describe()}); delete a key or write to a file instead`,
			);
		}
		this.#entries.set(name, { json, bytes, updatedAt: Date.now() });
		this.#bytes = nextTotal;
		return { key: name, bytes, keys: this.keyNames() };
	}

	/**
	 * Read `key`. `found` is reported separately so a stored `null` is
	 * distinguishable from a miss across the guest bridge, where both would
	 * otherwise arrive as a nullish value.
	 */
	get(key: unknown): SpindleSessionStoreRead {
		const name = this.#key(key, "get");
		const entry = this.#entries.get(name);
		if (!entry) return { key: name, found: false };
		return { key: name, found: true, value: JSON.parse(entry.json) };
	}

	delete(key: unknown): { key: string; deleted: boolean; keys: string[] } {
		const name = this.#key(key, "delete");
		const entry = this.#entries.get(name);
		if (entry) {
			this.#entries.delete(name);
			this.#bytes -= entry.bytes;
		}
		return { key: name, deleted: Boolean(entry), keys: this.keyNames() };
	}

	clear(): { cleared: number } {
		const cleared = this.#entries.size;
		this.reset();
		return { cleared };
	}

	/** Held keys, newest write last, with their serialized sizes. */
	keys(): SpindleSessionStoreKey[] {
		return [...this.#entries.entries()].map(([key, entry]) => ({
			key,
			bytes: entry.bytes,
			updatedAt: entry.updatedAt,
		}));
	}

	/**
	 * Held keys with a bounded preview of each value, for the TUI. The preview
	 * travels in the persisted details rather than being read at render time, so
	 * an old transcript still renders what the run actually held.
	 */
	snapshot(previewChars = 200): SpindleSessionStoreKey[] {
		return [...this.#entries.entries()].map(([key, entry]) => ({
			key,
			bytes: entry.bytes,
			updatedAt: entry.updatedAt,
			preview: entry.json.length > previewChars ? `${entry.json.slice(0, previewChars - 1)}\u2026` : entry.json,
		}));
	}

	keyNames(): string[] {
		return [...this.#entries.keys()];
	}

	/** One-line summary for the result envelope and for limit errors. */
	describe(): string {
		return this.keys()
			.map((entry) => `${entry.key} (${formatBytes(entry.bytes)})`)
			.join(", ");
	}

	/** Drop everything. A new session must not inherit the previous one's state. */
	reset(): void {
		this.#entries.clear();
		this.#bytes = 0;
	}
}

export { formatBytes as formatSessionStoreBytes };
