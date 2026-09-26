/**
 * A minimal, dependency-free JSON Schema (draft-07 subset) validator, just
 * large enough for `schema/report.schema.json` and
 * `schema/mismatch.schema.json`: `type` (single or array), `enum`,
 * `properties`/`required`/`additionalProperties`, `items`, and `oneOf`.
 * Q ships no runtime dependency on a JSON Schema library so its own tests
 * have no dependency surface beyond `@skipruntime/core` (AE8/AE10).
 * docs/plans/2026-09-14-skip-shared-prerequisites-plan.md, U12,
 * Q10, Q12.
 */

export type JsonSchema = {
	readonly type?: string | readonly string[];
	readonly enum?: readonly unknown[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly items?: JsonSchema;
	readonly oneOf?: readonly JsonSchema[];
};

export type SchemaValidationError = { readonly path: string; readonly message: string };

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	const aKeys = Object.keys(a as Record<string, unknown>);
	const bKeys = Object.keys(b as Record<string, unknown>);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			// JSON.stringify serializes NaN/Infinity/-Infinity to null, so an
			// in-memory-valid record would silently change meaning once written
			// as the JSONL line this schema guards. Reject non-finite numbers
			// up front instead.
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			return false;
	}
}

/** Validates `value` against `schema`, returning every structural error (empty means valid). */
export function validate(schema: JsonSchema, value: unknown, path = "$"): SchemaValidationError[] {
	if (schema.oneOf !== undefined) {
		const matchCount = schema.oneOf.filter((variant) => validate(variant, value, path).length === 0).length;
		return matchCount === 1
			? []
			: [{ path, message: `matched ${matchCount} of ${schema.oneOf.length} oneOf variants (expected exactly 1)` }];
	}

	const errors: SchemaValidationError[] = [];

	if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
		errors.push({ path, message: `value is not one of the allowed enum values` });
	}

	if (schema.type !== undefined) {
		const types = typeof schema.type === "string" ? [schema.type] : schema.type;
		if (!types.some((t) => matchesType(t, value))) {
			errors.push({ path, message: `expected type ${types.join(" | ")}, got ${typeof value}` });
			return errors;
		}
	}

	if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const obj = value as Record<string, unknown>;
			for (const key of schema.required ?? []) {
				if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "missing required property" });
			}
			for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
				if (key in obj) errors.push(...validate(propSchema, obj[key], `${path}.${key}`));
			}
			if (schema.additionalProperties === false) {
				const allowed = new Set(Object.keys(schema.properties ?? {}));
				for (const key of Object.keys(obj)) {
					if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: "additional property not allowed" });
				}
			}
		}
	}

	if (schema.items !== undefined && Array.isArray(value)) {
		value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${path}[${i}]`)));
	}

	return errors;
}
