import path from "node:path";
import ts from "typescript";
import {
	activeCheckerBackend,
	setDefaultCheckerBackend,
	type SpindleTypeCheckOutcome,
	type SpindleTypeError,
	type SpindleTranspileResult,
} from "./checker-backend.ts";

export type { SpindleTypeCheckOutcome, SpindleTypeError, SpindleTranspileResult };
export {
	activeCheckerBackend,
	checkerBackendName,
	installCheckerBackend,
} from "./checker-backend.ts";

export interface SpindleTypeCheckResult extends SpindleTypeCheckOutcome {
	errors: SpindleTypeError[];
}

const compilerOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: false,
	noImplicitAny: false,
	strictNullChecks: false,
	strictFunctionTypes: false,
	strictBindCallApply: false,
	alwaysStrict: false,
	strictPropertyInitialization: false,
	noImplicitThis: false,
	useUnknownInCatchVariables: false,
	noEmit: false,
	skipLibCheck: true,
	lib: ["lib.es2022.d.ts"],
	// The emitted map is what runtime/source-map.ts uses to translate guest
	// stack positions back to the program the model wrote.
	sourceMap: true,
};

const TYPE_CORRECTNESS_CODES = new Set<number>([
	2339, 2551, 2322, 2345, 2367, 2531, 2532, 18047, 18048, 7006, 7008, 7019, 7031, 7032, 7033, 7034,
]);

let nextCheckerId = 0;

export const normalizeTypeScriptPath = (fileName: string): string => fileName.replaceAll("\\", "/");

class SpindleTypeChecker {
	readonly #guestFile: string;
	readonly #declarationFile: string;
	readonly #baseHost = ts.createCompilerHost(compilerOptions, true);
	readonly #stableFiles = new Map<string, ts.SourceFile>();
	readonly #declarationSource: ts.SourceFile;
	readonly #host: ts.CompilerHost;
	#sourceText = "";
	#sourceFile: ts.SourceFile;
	#program: ts.Program | undefined;

	constructor(readonly declarations: string) {
		const id = ++nextCheckerId;
		this.#guestFile = normalizeTypeScriptPath(path.resolve(`/__pi_spindle_guest_${id}.ts`));
		this.#declarationFile = normalizeTypeScriptPath(path.resolve(`/__pi_spindle_globals_${id}.d.ts`));
		this.#sourceFile = ts.createSourceFile(this.#guestFile, "", ts.ScriptTarget.ES2022, true);
		this.#declarationSource = ts.createSourceFile(this.#declarationFile, declarations, ts.ScriptTarget.ES2022, true);
		const isGuestFile = (fileName: string): boolean =>
			this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
			this.#baseHost.getCanonicalFileName(this.#guestFile);
		const isDeclarationFile = (fileName: string): boolean =>
			this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
			this.#baseHost.getCanonicalFileName(this.#declarationFile);
		this.#host = {
			...this.#baseHost,
			fileExists: (fileName) =>
				isGuestFile(fileName) || isDeclarationFile(fileName) || this.#baseHost.fileExists(fileName),
			readFile: (fileName) => {
				if (isGuestFile(fileName)) return this.#sourceText;
				if (isDeclarationFile(fileName)) return this.declarations;
				return this.#baseHost.readFile(fileName);
			},
			getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
				if (isGuestFile(fileName)) return this.#sourceFile;
				if (isDeclarationFile(fileName)) return this.#declarationSource;
				const cached = this.#stableFiles.get(fileName);
				if (cached) return cached;
				const source = this.#baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
				if (source) this.#stableFiles.set(fileName, source);
				return source;
			},
		};
	}

	check(code: string): SpindleTypeCheckResult {
		this.#sourceText = `async function __piSpindleMain() {\n${code}\n}\n`;
		this.#sourceFile = ts.createSourceFile(this.#guestFile, this.#sourceText, ts.ScriptTarget.ES2022, true);
		const program = ts.createProgram({
			rootNames: [this.#declarationFile, this.#guestFile],
			options: compilerOptions,
			host: this.#host,
			...(this.#program ? { oldProgram: this.#program } : {}),
		});
		this.#program = program;
		const diagnostics = [
			...program.getSyntacticDiagnostics(this.#sourceFile),
			...program
				.getSemanticDiagnostics(this.#sourceFile)
				.filter((diagnostic) => !TYPE_CORRECTNESS_CODES.has(diagnostic.code)),
		];
		const errors = diagnostics.map((diagnostic) => {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
			if (!diagnostic.file || diagnostic.start === undefined) {
				return { line: 0, column: 0, message };
			}
			const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			return {
				line: Math.max(1, position.line),
				column: position.character + 1,
				message,
			};
		});
		if (errors.length > 0) return { errors };

		let javascript: string | undefined;
		let sourceMap: string | undefined;
		program.emit(this.#sourceFile, (fileName, content) => {
			if (fileName.endsWith(".js")) javascript = content;
			else if (fileName.endsWith(".js.map")) sourceMap = content;
		});
		return {
			errors,
			...(javascript !== undefined ? { javascript } : {}),
			...(sourceMap !== undefined ? { sourceMap } : {}),
		};
	}
}

const checkerCache = new Map<string, SpindleTypeChecker>();
const MAX_CHECKERS = 4;

const checkerFor = (declarations: string): SpindleTypeChecker => {
	const cached = checkerCache.get(declarations);
	if (cached) {
		checkerCache.delete(declarations);
		checkerCache.set(declarations, cached);
		return cached;
	}
	const checker = new SpindleTypeChecker(declarations);
	checkerCache.set(declarations, checker);
	while (checkerCache.size > MAX_CHECKERS) {
		const oldest = checkerCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		checkerCache.delete(oldest);
	}
	return checker;
};

const transpileWrapped = (code: string): SpindleTranspileResult => {
	const wrapped = `async function __piSpindleMain() {\n${code}\n}\n`;
	const output = ts.transpileModule(wrapped, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			sourceMap: true,
		},
	});
	return {
		javascript: output.outputText,
		...(output.sourceMapText !== undefined ? { sourceMap: output.sourceMapText } : {}),
	};
};

/**
 * The stock backend: the `typescript` compiler, in-process, with a small
 * per-declarations checker cache. Registered as the default at import time.
 */
export const typescriptCheckerBackend = {
	name: "typescript",
	check(code: string, declarations: string): SpindleTypeCheckOutcome {
		return checkerFor(declarations).check(code);
	},
	transpile(code: string): SpindleTranspileResult {
		return transpileWrapped(code);
	},
} as const satisfies import("./checker-backend.ts").SpindleCheckerBackend;

setDefaultCheckerBackend(typescriptCheckerBackend);

export const transpileSpindleCode = (code: string): SpindleTranspileResult => activeCheckerBackend().transpile(code);

export const typeCheckSpindleCode = (code: string, declarations: string): SpindleTypeCheckResult =>
	activeCheckerBackend().check(code, declarations);
