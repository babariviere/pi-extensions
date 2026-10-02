import type { SecretEntry } from "./secret-mask.ts";

/** Update only the secrets-owned prompt section, clearing stale guidance when none are available. */
export function updateSecretPromptSection(sections: Record<string, string>, secrets: SecretEntry[]): void {
	if (secrets.length === 0) {
		delete sections.secrets;
		return;
	}

	const names = secrets.map((secret) => secret.name).join(", ");
	sections.secrets = [
		"## secrets — Secret Management",
		`Available secrets (injected as env vars in bash): ${names}`,
		"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
		"Secret values never appear in tool output. They are replaced by references of the form `<secret:type:id>`.",
		"Copy a reference verbatim. Written to a file with write, edit, or applyPatch, it expands to the real value; in bash it becomes the matching variable.",
		"To place a secret you have never seen into a file, write `<\\secret:NAME>` using a name from the list above.",
		"Never transcribe a partially masked value: that destroys the secret. Use the reference.",
	].join("\n");
}
