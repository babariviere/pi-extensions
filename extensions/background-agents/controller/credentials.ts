import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** Read a controller credential without ever validating one path and reading another. */
export function readSecureCredential(path: string, ownerUid = process.getuid?.()): Buffer {
	if (ownerUid === undefined) throw new Error(`credential owner cannot be verified: ${path}`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(descriptor);
		const mode = stat.mode & 0o777;
		if (!stat.isFile()) throw new Error(`credential file is not a regular file: ${path}`);
		if (stat.uid !== ownerUid) throw new Error(`credential file is not owned by the controller user: ${path}`);
		if (mode !== 0o400 && mode !== 0o600)
			throw new Error(`credential file must use owner-only non-executable mode 0400 or 0600: ${path}`);
		return readFileSync(descriptor);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("credential file")) throw error;
		throw new Error(`unable to securely read credential file ${path}`, { cause: error });
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function readSecureCredentialText(path: string, ownerUid = process.getuid?.()): string {
	return readSecureCredential(path, ownerUid).toString("utf8");
}
