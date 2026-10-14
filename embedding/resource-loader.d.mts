import type { DefaultResourceLoader, ResourceLoader } from "@earendil-works/pi-coding-agent";
type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
export function ownedExtension(
	path: string,
	ownedPackages: Record<string, readonly string[]>,
	manifests?: Map<string, string | null>,
): boolean;
export class EmbeddedResourceLoader implements ResourceLoader {
	constructor(
		options: LoaderOptions,
		embedding: {
			requiredPaths: string[];
			ownedPackages: Record<string, readonly string[]>;
			projectTrusted?: boolean;
		},
	);
	reload(): Promise<void>;
	getExtensions: ResourceLoader["getExtensions"];
	getSkills: ResourceLoader["getSkills"];
	getPrompts: ResourceLoader["getPrompts"];
	getThemes: ResourceLoader["getThemes"];
	getAgentsFiles: ResourceLoader["getAgentsFiles"];
	getSystemPrompt: ResourceLoader["getSystemPrompt"];
	getSystemPromptSource: ResourceLoader["getSystemPromptSource"];
	getAppendSystemPrompt: ResourceLoader["getAppendSystemPrompt"];
	getAppendSystemPromptSources: ResourceLoader["getAppendSystemPromptSources"];
	extendResources: ResourceLoader["extendResources"];
}
