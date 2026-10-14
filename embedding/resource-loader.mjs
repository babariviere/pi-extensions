import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
	createEventBus,
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Identify known package entries without importing or executing their factories. */
export function ownedExtension(path, ownedPackages, manifests = new Map()) {
	if (path.startsWith("builtin:")) return false;
	let canonical;
	try {
		canonical = realpathSync(path);
	} catch {
		return false;
	}
	let directory = dirname(canonical);
	for (;;) {
		let name = manifests.get(directory);
		if (name === undefined) {
			try {
				name = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")).name ?? null;
			} catch {
				name = null;
			}
			manifests.set(directory, name);
		}
		const entries = typeof name === "string" && Object.hasOwn(ownedPackages, name) ? ownedPackages[name] : undefined;
		if (entries) {
			if (entries.includes("*")) return true;
			const entry = relative(directory, canonical).split(sep).join("/");
			return entries.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`));
		}
		// The nearest package defines identity; do not infer identity from directory names.
		if (name) return false;
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

/**
 * Keep native discovery/trust/resource handling, but select extension paths before any factory runs.
 * DefaultResourceLoader's extensionsOverride runs too late for provider and event-bus side effects.
 */
export class EmbeddedResourceLoader {
	constructor(options, { requiredPaths, ownedPackages, projectTrusted = false }) {
		this.options = {
			...options,
			settingsManager: options.settingsManager ?? SettingsManager.create(options.cwd, options.agentDir),
			eventBus: options.eventBus ?? createEventBus(),
		};
		this.requiredPaths = requiredPaths;
		this.ownedPackages = ownedPackages;
		this.projectTrusted = projectTrusted;
		this.delegate = new DefaultResourceLoader(this.options);
		// A reusable empty native loader supplies the SDK's public reload/cache-invalidation lifecycle.
		this.cacheReset = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}

	async reload() {
		const { settingsManager, cwd, agentDir } = this.options;
		settingsManager.setProjectTrusted(this.projectTrusted);
		await settingsManager.reload();
		const manager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			builtinExtensions: (this.options.extensionFactories ?? [])
				.filter((factory) => typeof factory !== "function" && factory.builtin)
				.map((factory) => factory.name),
		});
		const [discovered, explicit] = await Promise.all([
			manager.resolve(),
			manager.resolveExtensionSources(this.options.additionalExtensionPaths ?? [], { temporary: true }),
		]);
		const manifests = new Map();
		const resources = [...explicit.extensions, ...(this.options.noExtensions ? [] : discovered.extensions)].filter(
			(entry) => entry.enabled && !ownedExtension(entry.path, this.ownedPackages, manifests),
		);
		const disabledBuiltins = new Set(this.options.disabledBuiltinExtensions ?? []);
		const paths = [
			...new Set([
				...resources
					.map((entry) => entry.path)
					.filter((path) => !path.startsWith("builtin:") || !disabledBuiltins.has(path.slice(8))),
				...this.requiredPaths,
			]),
		];
		await this.cacheReset.reload();
		this.delegate = new DefaultResourceLoader({
			...this.options,
			noExtensions: true,
			additionalExtensionPaths: paths,
		});
		// Trust is already decided by the host. No preliminary pass may execute a second factory set.
		await this.delegate.reload();
		const metadata = new Map(resources.map((entry) => [resolve(entry.path), entry.metadata]));
		for (const extension of this.delegate.getExtensions().extensions) {
			const source = metadata.get(resolve(extension.path));
			if (!source) continue;
			extension.sourceInfo = { path: extension.path, ...source };
			for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo;
			for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
		}
	}

	getExtensions() {
		return this.delegate.getExtensions();
	}
	getSkills() {
		return this.delegate.getSkills();
	}
	getPrompts() {
		return this.delegate.getPrompts();
	}
	getThemes() {
		return this.delegate.getThemes();
	}
	getAgentsFiles() {
		return this.delegate.getAgentsFiles();
	}
	getSystemPrompt() {
		return this.delegate.getSystemPrompt();
	}
	getSystemPromptSource() {
		return this.delegate.getSystemPromptSource();
	}
	getAppendSystemPrompt() {
		return this.delegate.getAppendSystemPrompt();
	}
	getAppendSystemPromptSources() {
		return this.delegate.getAppendSystemPromptSources();
	}
	extendResources(paths) {
		this.delegate.extendResources(paths);
	}
}
