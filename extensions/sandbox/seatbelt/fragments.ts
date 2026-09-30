/**
 * Vendored Codex Seatbelt (SBPL) policy fragments, loaded as data.
 *
 * Kept as plain `.sbpl` files (not inlined TS strings) so the vendored text
 * stays byte-identical to upstream, which is what makes re-vendoring a diff
 * instead of a merge. See ./NOTICE for provenance (upstream commit, license,
 * per-file verbatim/derived status).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => readFileSync(join(here, name), "utf8");

/** Codex's `(deny default)` base policy: sysctls, IOKit, mach services, /dev, pty. */
export const SEATBELT_BASE = load("base.sbpl");
/** System read paths, file-map-executable for frameworks/dylibs, firmlink ancestors. */
export const SEATBELT_READ_ONLY_PLATFORM_DEFAULTS = load("read-only-platform-defaults.sbpl");
/** Our derivation of Codex's inline process defaults, with write grants stripped. */
export const SEATBELT_PROCESS_PLATFORM_DEFAULTS = load("process-platform-defaults.sbpl");
/** Mach lookups for DNS config, trustd.agent, SecurityServer, ocspd. */
export const SEATBELT_NETWORK = load("network.sbpl");
/** cfprefsd / user-preference-read. */
export const SEATBELT_PREFERENCES = load("preferences.sbpl");
