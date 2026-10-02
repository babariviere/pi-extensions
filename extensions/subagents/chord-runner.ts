/** Stable Chord service handle for the reloadable batch runner. */

import { createFacetHost, defineFacet, defineService } from "@earendil-works/chord";
import type { FacetHost } from "@earendil-works/chord";
import type { RunBackend } from "./run.ts";

interface RunnerService {
	run: RunBackend;
}

const RUNNER_SERVICE = defineService<RunnerService>("pi.subagents.run-backend.v1", { local: true });
const PROVIDER_FACET_ID = "pi.subagents.chord-runner.provider";
const CONSUMER_FACET_ID = "pi.subagents.chord-runner.consumer";

function validateBackend(backend: RunBackend): void {
	if (typeof backend !== "function") throw new TypeError("ChordRunner backend must be a function");
}

function providerFacet(backend: RunBackend) {
	const generation: { backend: RunBackend | undefined } = { backend };
	return defineFacet({
		id: PROVIDER_FACET_ID,
		setup(env) {
			env.provide(RUNNER_SERVICE, {
				run: (requests, context) => {
					const current = generation.backend;
					if (current === undefined) throw new Error("ChordRunner provider is inactive");
					return current(requests, context);
				},
			});
			env.onDeactivate(() => {
				generation.backend = undefined;
			});
		},
	});
}

/** A reloadable backend whose captured `run` handle stays live across cutovers. */
export class ChordRunner {
	readonly run: RunBackend = async (requests, context) => {
		if (this.#closing || this.#serviceRun === undefined) throw new Error("ChordRunner is disposed");
		return this.#serviceRun(requests, context);
	};

	readonly #host: FacetHost;
	#serviceRun: RunBackend | undefined;
	#closing = false;
	#operations: Promise<void> = Promise.resolve();
	#disposePromise: Promise<void> | undefined;

	private constructor(host: FacetHost, serviceRun: RunBackend) {
		this.#host = host;
		this.#serviceRun = serviceRun;
	}

	static async open(backend: RunBackend): Promise<ChordRunner> {
		validateBackend(backend);

		let serviceRun: RunBackend | undefined;
		let consumerHandle: RunnerService | undefined;
		const consumer = defineFacet({
			id: CONSUMER_FACET_ID,
			setup(env) {
				consumerHandle = env.use(RUNNER_SERVICE);
				env.onActivate(() => {
					const handle = consumerHandle;
					if (handle === undefined) throw new Error("ChordRunner consumer handle is unavailable");
					serviceRun = handle.run;
					consumerHandle = undefined;
				});
			},
		});
		const host = await createFacetHost({ facets: [providerFacet(backend), consumer] });
		if (serviceRun === undefined) {
			await host.dispose();
			throw new Error("ChordRunner consumer did not acquire its service");
		}
		const capturedRun = serviceRun;
		serviceRun = undefined;
		return new ChordRunner(host, capturedRun);
	}

	async reload(backend: RunBackend): Promise<void> {
		validateBackend(backend);
		if (this.#closing) throw new Error("ChordRunner is disposed");
		await this.#serialize(() => this.#host.reload([providerFacet(backend)]));
	}

	dispose(): Promise<void> {
		if (this.#disposePromise !== undefined) return this.#disposePromise;
		this.#closing = true;
		this.#disposePromise = this.#serialize(async () => {
			try {
				await this.#host.dispose();
			} finally {
				this.#serviceRun = undefined;
			}
		});
		return this.#disposePromise;
	}

	#serialize(operation: () => Promise<void>): Promise<void> {
		const result = this.#operations.then(operation, operation);
		this.#operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
