import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SEATBELT_BASE,
	SEATBELT_NETWORK,
	SEATBELT_PREFERENCES,
	SEATBELT_PROCESS_PLATFORM_DEFAULTS,
	SEATBELT_READ_ONLY_PLATFORM_DEFAULTS,
} from "./fragments.ts";

const fragments = {
	SEATBELT_BASE,
	SEATBELT_READ_ONLY_PLATFORM_DEFAULTS,
	SEATBELT_PROCESS_PLATFORM_DEFAULTS,
	SEATBELT_NETWORK,
	SEATBELT_PREFERENCES,
};

test("every fragment is non-empty", () => {
	for (const [name, text] of Object.entries(fragments)) {
		assert.ok(text.trim().length > 0, `${name} is empty`);
	}
});

test("the base policy starts closed by default", () => {
	assert.ok(SEATBELT_BASE.trimStart().startsWith("(version 1)"));
	assert.ok(SEATBELT_BASE.includes("(deny default)"));
});

test("the network fragment carries the trust/DNS mach-lookups", () => {
	assert.ok(SEATBELT_NETWORK.includes("com.apple.trustd.agent"));
	assert.ok(SEATBELT_NETWORK.includes("com.apple.SecurityServer"));
	assert.ok(SEATBELT_NETWORK.includes("com.apple.ocspd"));
	assert.ok(SEATBELT_NETWORK.includes("com.apple.SystemConfiguration.DNSConfiguration"));
});

test("the stripped process defaults grant no writes", () => {
	assert.ok(!SEATBELT_PROCESS_PLATFORM_DEFAULTS.includes("file-write"));
});
