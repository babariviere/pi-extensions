/**
 * Double-tap timing state.
 *
 * Kept separate from the editor so it can be unit tested without a TUI.
 */
export class TapTracker {
	private lastTapMs = 0;

	constructor(private readonly windowMs: number) {}

	/**
	 * Record a tap.
	 *
	 * Returns `"fire"` when the tap lands inside the window of the previous one
	 * (so the wrapped action should run), `"arm"` otherwise.
	 */
	tap(nowMs: number): "arm" | "fire" {
		const armed = this.lastTapMs !== 0 && nowMs - this.lastTapMs < this.windowMs;
		this.lastTapMs = armed ? 0 : nowMs;
		return armed ? "fire" : "arm";
	}

	/** Drop the armed state, e.g. when the hint expires or another key is pressed. */
	reset(): void {
		this.lastTapMs = 0;
	}

	get armed(): boolean {
		return this.lastTapMs !== 0;
	}
}
