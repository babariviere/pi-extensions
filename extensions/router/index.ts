/** Opt-in, deterministic routing. Selecting router/auto is the only way to enable it. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { readExtensionConfig } from "../shared/config.ts";

export interface RouterConfig {
	cheapModel?: string;
	strongModel?: string;
	directModel?: string;
}

export function normalizeRouterConfig(value: Record<string, unknown>): RouterConfig {
	const config: RouterConfig = {};
	for (const key of ["cheapModel", "strongModel", "directModel"] as const) {
		const name = value[key];
		if (name === undefined) continue;
		if (typeof name !== "string" || !/^[^/\s]+\/\S+$/.test(name) || /[*?]/.test(name))
			throw new Error(`router.json: ${key} must be an exact provider/model ID`);
		config[key] = name;
	}
	return config;
}

const modelKey = (model: Pick<Model<Api>, "provider" | "id">): string => `${model.provider}/${model.id}`;

/** Intersect the session allowlist with authenticated physical models, never expand it. */
export function routingCandidates(
	available: readonly Model<Api>[],
	scoped: readonly { model: Model<Api> }[],
): Model<Api>[] {
	const allowed = scoped.length ? new Set(scoped.map(({ model }) => modelKey(model))) : undefined;
	return available.filter((model) => model.api !== "pi-virtual" && (!allowed || allowed.has(modelKey(model))));
}

function price(model: Model<Api>): number | undefined {
	const input = model.cost?.input;
	const output = model.cost?.output;
	const total = input + output;
	if (
		!Number.isFinite(input) ||
		!Number.isFinite(output) ||
		input < 0 ||
		output < 0 ||
		!Number.isFinite(total) ||
		total <= 0
	)
		return undefined;
	return total;
}

function hasImages(request: ModelRouteRequest): boolean {
	return request.messages.some(
		(message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
	);
}

/** Pure route selection, exported for tests. Prices do not stand in for model quality. */
export function chooseRoute(
	request: ModelRouteRequest,
	candidates: readonly Model<Api>[],
	config: RouterConfig,
): ModelRoute {
	if (request.signal?.aborted) throw request.signal.reason ?? new Error("Routing aborted");
	const sticky = request.reason === "retry" ? (request.failed ?? request.previous) : request.previous;
	if ((request.reason === "continuation" || request.reason === "retry") && sticky) {
		const model = candidates.find((candidate) => modelKey(candidate) === modelKey(sticky.model));
		if (!model)
			throw new Error(`router/auto: previous model ${modelKey(sticky.model)} is no longer available in scope`);
		return { model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
	}

	const strong = ["high", "xhigh", "max"].includes(request.thinkingLevel);
	const configured =
		request.reason === "direct"
			? (config.directModel ?? config.cheapModel)
			: strong
				? config.strongModel
				: config.cheapModel;
	if (strong && request.reason !== "direct" && !configured)
		throw new Error("router/auto: configure strongModel in router.json for high, xhigh, or max thinking");

	const compatible = hasImages(request) ? candidates.filter((model) => model.input.includes("image")) : candidates;
	let model: Model<Api> | undefined;
	if (configured) {
		model = compatible.find((candidate) => modelKey(candidate) === configured);
		if (!model)
			throw new Error(`router/auto: ${configured} is not authenticated, in scope, or compatible with image input`);
	} else {
		const priced = compatible.filter((candidate) => price(candidate) !== undefined);
		model = priced.sort((a, b) => price(a)! - price(b)! || modelKey(a).localeCompare(modelKey(b)))[0];
		if (!model)
			throw new Error(
				"router/auto: no priced physical model in scope; configure cheapModel or add authenticated physical models to enabledModels",
			);
	}
	return { model, thinkingLevel: request.reason === "direct" ? "off" : request.thinkingLevel };
}

export async function routeRequest(request: ModelRouteRequest, ctx: ExtensionContext): Promise<ModelRoute> {
	const config = normalizeRouterConfig(readExtensionConfig("router.json", ctx));
	const candidates = routingCandidates(await ctx.modelRegistry.getAvailable(), ctx.scopedModels);
	return chooseRoute(request, candidates, config);
}

export default function router(pi: ExtensionAPI): void {
	pi.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto (scoped, cost-aware)",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		route: routeRequest,
	});
}
