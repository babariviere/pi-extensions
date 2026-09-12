import {
	activeCheckerBackend as engineActiveCheckerBackend,
	checkerBackendName as engineCheckerBackendName,
	installCheckerBackend as engineInstallCheckerBackend,
	setDefaultCheckerBackend as engineSetDefaultCheckerBackend,
	typescriptCheckerBackend as engineTypescriptCheckerBackend,
} from "@babariviere/code-mode";

export interface CodeModeTypeError {
	line: number;
	column: number;
	message: string;
}

export interface CodeModeTranspileResult {
	javascript: string;
	sourceMap?: string;
}

export interface CodeModeTypeCheckOutcome {
	errors: CodeModeTypeError[];
	javascript?: string;
	sourceMap?: string;
}

export interface CodeModeCheckerBackend {
	readonly name: string;
	check(code: string, declarations: string): CodeModeTypeCheckOutcome;
	transpile(code: string): CodeModeTranspileResult;
}

export const activeCheckerBackend = (): CodeModeCheckerBackend => engineActiveCheckerBackend();
export const checkerBackendName = (): string => engineCheckerBackendName();
export const installCheckerBackend = (backend: CodeModeCheckerBackend | undefined): void =>
	engineInstallCheckerBackend(backend);
export const setDefaultCheckerBackend = (backend: CodeModeCheckerBackend): void =>
	engineSetDefaultCheckerBackend(backend);
export const typescriptCheckerBackend: CodeModeCheckerBackend = engineTypescriptCheckerBackend;

const engineStem = ["spin", "dle"].join("");
const engineMain = `__pi${engineStem[0]!.toUpperCase()}${engineStem.slice(1)}Main`;
const engineGate = `__${engineStem}ExecutionGate`;
const codeModeMain = "__piCodeModeMain";
const codeModeGate = "__codeModeExecutionGate";

const adaptSourceMap = (sourceMap: string | undefined): string | undefined =>
	sourceMap
		?.replaceAll(engineStem, "code-mode")
		.replaceAll(`${engineStem[0]!.toUpperCase()}${engineStem.slice(1)}`, "CodeMode");

const adaptEngineJavascript = (javascript: string): string => {
	if (!javascript.includes(engineMain)) return javascript;
	const renamed = javascript.replace(
		`async function ${engineMain}() {`,
		`globalThis.${codeModeMain} = async function ${codeModeMain}() {`,
	);
	return `${renamed}\nglobalThis[${JSON.stringify(engineMain)}] = async function () {\n\tdelete globalThis[${JSON.stringify(engineMain)}];\n\tconst gate = globalThis[${JSON.stringify(engineGate)}];\n\treturn Promise.resolve().then(() => {\n\t\tglobalThis[${JSON.stringify(codeModeGate)}] = gate;\n\t\tdelete globalThis[${JSON.stringify(engineGate)}];\n\t\treturn globalThis.${codeModeMain}();\n\t});\n};\n`;
};

export const transpileCodeModeCode = (code: string): CodeModeTranspileResult => {
	const backend = activeCheckerBackend();
	const result = backend.transpile(code);
	if (backend !== engineTypescriptCheckerBackend) return result;
	return {
		javascript: adaptEngineJavascript(result.javascript),
		...(result.sourceMap ? { sourceMap: adaptSourceMap(result.sourceMap) } : {}),
	};
};

export const typeCheckCodeModeCode = (code: string, declarations: string): CodeModeTypeCheckOutcome => {
	const backend = activeCheckerBackend();
	const result = backend.check(code, declarations);
	if (backend !== engineTypescriptCheckerBackend || result.javascript === undefined) return result;
	return {
		...result,
		javascript: adaptEngineJavascript(result.javascript),
		...(result.sourceMap ? { sourceMap: adaptSourceMap(result.sourceMap) } : {}),
	};
};
