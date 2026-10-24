/**
 * Which subscription provider a session is really using.
 *
 * The selected model is not always the model that answers: a virtual model
 * (the router) dispatches to a physical one, and a session can switch models
 * mid-run. Usage polling and the night-mode budget guard both have to follow
 * the same physical model, so the tracking lives here rather than in one
 * extension.
 *
 * Pure state, no pi imports beyond the session entry type, so it can be unit
 * tested directly.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { usageProviderForModel, type UsageProvider } from "../usage/protocol.ts";
import { latestRoutedPhysicalModel, routedPhysicalModelFromMessage, type RoutedPhysicalModel } from "./routed-model.ts";

/** A model reference as pi reports it. */
export type UsageModelRef = { provider?: string; id?: string; api?: string } | undefined;

/** Tracks the selected model separately from the last physical model on the active branch. */
export class UsageModelTracker {
	private selected: UsageModelRef = undefined;
	private physical: RoutedPhysicalModel | undefined;

	startSession(selected: UsageModelRef, branch: readonly SessionEntry[]): void {
		this.selected = selected;
		this.physical = latestRoutedPhysicalModel(branch);
	}

	selectModel(selected: UsageModelRef): void {
		this.selected = selected;
	}

	changeBranch(selected: UsageModelRef, branch: readonly SessionEntry[]): void {
		this.startSession(selected, branch);
	}

	messageEnded(message: unknown): boolean {
		const physical = routedPhysicalModelFromMessage(message);
		if (!physical) return false;
		this.physical = physical;
		return true;
	}

	get currentModel(): UsageModelRef | RoutedPhysicalModel {
		return this.selected?.api === "pi-virtual" ? (this.physical ?? this.selected) : this.selected;
	}

	/**
	 * The subscription provider backing the model in use, or undefined when the
	 * session runs on a model with no subscription windows (a local model, an
	 * API-key model, or another provider entirely).
	 */
	get usageProvider(): UsageProvider | undefined {
		return usageProviderForModel(this.currentModel);
	}
}
