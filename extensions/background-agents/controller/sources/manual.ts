import { randomUUID } from "node:crypto";
import type { SourceEventResult } from "../database.ts";
import type { InputKind } from "../../types.ts";
import { type SourceAdapter, type SourceAdapterOptions, fingerprint, persistSourceEvent } from "./source.ts";

export interface ManualSubmission {
	title: string;
	body: string;
	kind?: Extract<InputKind, "bug-report" | "feature" | "question" | "maintenance" | "other">;
	sourceKey?: string;
	repository?: string;
	service?: string;
	priority?: number;
	metadata?: Record<string, unknown>;
}

export class ManualSourceAdapter implements SourceAdapter {
	readonly source = "manual" as const;

	constructor(private readonly options: SourceAdapterOptions) {}

	submit(input: ManualSubmission): SourceEventResult {
		const id = input.sourceKey?.trim() || randomUUID();
		const kind = input.kind ?? "other";
		return persistSourceEvent(
			{ ...this.options, priority: input.priority ?? this.options.priority },
			{
				source: "manual",
				sourceKey: id.startsWith("manual:") ? id : `manual:${id}`,
				title: input.title,
				body: input.body,
				repository: input.repository,
				service: input.service,
				fingerprint: fingerprint({ kind, title: input.title, body: input.body, repository: input.repository }),
				metadata: { ...input.metadata, kind, intake: "manual" },
			},
			undefined,
		);
	}
}

export function submitManual(options: SourceAdapterOptions, input: ManualSubmission): SourceEventResult {
	return new ManualSourceAdapter(options).submit(input);
}
