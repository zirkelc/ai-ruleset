import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

/**
 * A schema that implements both standards over an object value.
 *
 * - [Standard Schema](https://standardschema.dev) gives the ruleset a validator
 *   and the inferred type, via `~standard.validate`.
 * - [Standard JSON Schema](https://standardschema.dev/json-schema) gives it the
 *   object's keys, via `~standard.jsonSchema`. This is the introspection that
 *   plain Standard Schema deliberately omits, and the reason both are required.
 *
 * The interfaces come from `@standard-schema/spec`, a types-only package, so any
 * library that implements both, e.g. Zod or ArkType, satisfies this structurally.
 */
export type ObjectSchema<VALUE> = StandardSchemaV1<unknown, VALUE> & StandardJSONSchemaV1<unknown, VALUE>;
