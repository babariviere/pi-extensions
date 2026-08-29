/**
 * Seam for the type-checking backend.
 *
 * The default backend is the stock `typescript` compiler, which is correct but
 * heavy: a full createProgram per cold check. Alternative implementations
 * (a native-compiler process, a language-server session, a cached project) can
 * be installed at runtime without touching the checker core or the execution
 * service, which resolves the backend at call time.
 *
 * A backend must be self-sufficient: `check` both reports errors and emits the
 * JavaScript (plus its source map, see runtime/source-map.ts) the sandbox will
 * run, so a swapped backend controls exactly what executes.
 */

export interface SpindleTypeError {
	line: number;
	column: number;
	message: string;
}

export interface SpindleTranspileResult {
	javascript: string;
	/** JSON text of the emitted source map, when the backend produced one. */
	sourceMap?: string;
}

export interface SpindleTypeCheckOutcome {
	errors: SpindleTypeError[];
	javascript?: string;
	sourceMap?: string;
}

export interface SpindleCheckerBackend {
	readonly name: string;
	check(code: string, declarations: string): SpindleTypeCheckOutcome;
	transpile(code: string): SpindleTranspileResult;
}

let installedBackend: SpindleCheckerBackend | undefined;
let defaultBackend: SpindleCheckerBackend | undefined;

/** Install a backend for the rest of the process; undefined restores the default. */
export const installCheckerBackend = (backend: SpindleCheckerBackend | undefined): void => {
	installedBackend = backend;
};

/** Registered by a backend module as the process-wide fallback (idempotent). */
export const setDefaultCheckerBackend = (backend: SpindleCheckerBackend): void => {
	defaultBackend = backend;
};

export const checkerBackendName = (): string => activeCheckerBackend().name;

export const activeCheckerBackend = (): SpindleCheckerBackend => {
	const backend = installedBackend ?? defaultBackend;
	if (backend === undefined) {
		throw new Error("No Spindle checker backend registered; import runtime/type-checker.ts first");
	}
	return backend;
};
