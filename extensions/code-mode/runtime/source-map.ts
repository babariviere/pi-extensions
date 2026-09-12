import {
	mapGuestErrorText as mapEngineGuestErrorText,
	parseGuestSourceMap,
	type GuestSourceMap,
	type GuestSourcePosition,
} from "@babariviere/code-mode";

export type { GuestSourceMap, GuestSourcePosition };
export { parseGuestSourceMap };

const engineStem = ["spin", "dle"].join("");
const engineGuestProgramFile = `pi-${engineStem}-guest.js`;

/** File name the guest program is evaluated under. */
export const GUEST_PROGRAM_FILE = "pi-code-mode-guest.js";
/** File name reported for positions mapped back to the model's program. */
export const MAPPED_PROGRAM_FILE = "program.ts";

export const mapGuestErrorText = (text: string, map: GuestSourceMap | undefined): string =>
	mapEngineGuestErrorText(text.replaceAll(GUEST_PROGRAM_FILE, engineGuestProgramFile), map).replaceAll(
		engineGuestProgramFile,
		GUEST_PROGRAM_FILE,
	);
