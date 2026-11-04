import { Type } from "typebox";

/** JSON Schema string enum with TypeBox inference for native tool definitions. */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
