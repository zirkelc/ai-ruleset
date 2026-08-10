<div align="center">

<h1>ai-ruleset</h1>

<p align="center">Resolve nested rules from runtime context, like a decision tree</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ai-ruleset" alt="ai-ruleset"><img src="https://img.shields.io/npm/dt/ai-ruleset?label=ai-ruleset"></a> <a href="https://github.com/zirkelc/ai-ruleset/actions/workflows/ci.yml" alt="CI"><img src="https://img.shields.io/github/actions/workflow/status/zirkelc/ai-ruleset/ci.yml?branch=main"></a>
</p>

</div>

`ai-ruleset` resolves a result from the runtime context of a request. You declare the mapping in code as a nested tree of rules — a decision tree that branches on fields like tenant, service tier, or feature flags — and it resolves like the [CSS cascade](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade): every rule that matches is collected, and per result key the most specific one wins. The running example throughout resolves an AI model and its generation parameters, but the result is any object you define. Types come from any [Standard Schema](https://standardschema.dev) library, so you bring your own [Zod](https://zod.dev) or [ArkType](https://arktype.io).

## Why?

Turning request data into a decision — which model, which parameters, which config — starts as one `if` and grows into something no one wants to touch. A tenant on an enterprise plan, a premium flag, a long-context request, each adds another branch.

- **Branching logic sprawls**: the mapping from context to result ends up as conditionals scattered across call sites, each with its own copy of the rules.
- **Precedence is accidental**: when a tenant rule and a feature-flag rule both apply, which one wins is decided by the order you happened to write the branches in, not by intent.
- **The mapping lives nowhere**: there is no single object you can read, test, or hand to someone to explain why a request got the result it got.

This library makes that mapping one declarative, type-safe rule tree with explicit, CSS-like precedence.

## Installation

```bash
npm install ai-ruleset
```

`ai-ruleset` has no runtime dependencies. It reads your schemas through two open standards, so you also install a schema library that implements both:

```bash
npm install zod # or arktype
```

> [!NOTE]
> A schema must implement [Standard Schema](https://standardschema.dev) (for validation and type inference) **and** [Standard JSON Schema](https://standardschema.dev/json-schema) (for key introspection). Verified with **Zod** 4.2+ and **ArkType** 2.1+. See [Any Standard Schema library](#any-standard-schema-library) for the details and current caveats.

## Usage

Describe the request with a **context** schema and the answer with a **result** schema, then declare rules that branch on the context's fields and set the result's keys.

```typescript
import { z } from 'zod';
import { createRuleset } from 'ai-ruleset';

const ruleset = createRuleset({
  contextSchema: z.object({ tenantId: z.string(), serviceTier: z.enum(['free', 'premium']) }),
  resultSchema: z.object({ model: z.string().default('gpt-5-mini') }),
  rules: {
    tenantId: {
      tenantA: {
        serviceTier: {
          premium: { model: 'gpt-5' },
        },
      },
    },
  },
});

ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium' }); // { model: 'gpt-5' }
ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' }); //    { model: 'gpt-5-mini' } — schema default
ruleset.resolve({ tenantId: 'other', serviceTier: 'free' }); //      { model: 'gpt-5-mini' } — schema default
```

`resolve` always returns a complete result: any key no rule set falls back to the schema's `.default()`.

The context and result schemas are **not** there to validate the context — the types already do that. They are there so the ruleset can tell, at run time, which keys of a rule are identifiers to branch on and which are result keys to declare. The two must not share a key; that is a compile error.

### Rules

A rule is one of three shapes, and they nest in any order:

| Shape        | Written as                   | Use it to                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------- |
| **Node**     | an object                    | declare result keys, branch on one identifier, or both              |
| **Function** | `(context) => rule \| falsy` | decide dynamically; a falsy return means "does not match"           |
| **List**     | an array of rules            | apply several rules at one level, or branch two identifiers at once |

`rules` itself is any of the three, so a whole ruleset can be a single function.

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({ tenantId: z.string(), serviceTier: z.enum(['free', 'premium']) }),
  resultSchema: z.object({ model: z.string().default('haiku-4-5') }),
  rules: [
    // a node with a nested branch
    { tenantId: { tenantA: { model: 'gpt-5' } } },
    // a function that returns a rule, or a falsy value to opt out
    ({ serviceTier }) => serviceTier === 'premium' && { model: 'opus-4-8' },
  ],
});
```

### Branching on identifiers

A branch maps values of one context field to nested rules. Values are stringified for lookup, so strings, numbers, and booleans all work as keys. A node branches on **at most one** identifier — nest them when one qualifies the other, and reach for a list when they are independent.

```typescript
rules: {
  hasPremium: {
    true: { model: 'opus-4-8' }, //  boolean keys work — the value is stringified
    false: { model: 'haiku-4-5' },
  },
  serviceTier: { free: { model: 'gpt-5-mini' } }, // Error: a node branches on one identifier, use a list
}
```

An identifier whose value is not a string, number, or boolean — an object, an array, a `Date` — has no sensible key form and cannot head a branch. It is still readable inside a function (see [Non-primitive identifiers](#non-primitive-identifiers)).

### The universal match

`'*'` (exported as `WILDCARD`) matches any value of an identifier, which still means there has to be one: a branch on an identifier never matches when the context carries no value for it.

```typescript
rules: {
  tenantId: {
    tenantA: { model: 'gpt-5' },
    '*': { model: 'sonnet-5' }, // every other tenant
  },
}
```

### Narrowing

Descending into an identifier **consumes** it: it disappears from the types below, so you cannot branch on it twice down a path. Functions see the same narrowed view — they only receive the identifiers still in play, at compile time and at run time.

```typescript
rules: {
  tenantId: {
    tenantA: {
      serviceTier: {
        // context here has neither tenantId nor serviceTier — both are already fixed
        premium: (context) => (context.requestTokens ?? 0) > 50_000
          ? { model: 'gpt-5-long' }
          : { model: 'gpt-5' },
      },
    },
  },
}
```

### Specificity

Every declaration that matches is collected, and the most specific one wins. Specificity is a vector, `[conditions, exact, depth]`, compared left to right; a higher number in an earlier position beats any number in a later one.

| Position       | Counts                                                                |
| -------------- | --------------------------------------------------------------------- |
| **conditions** | everything that had to hold: exact value matches + matching functions |
| **exact**      | of those, the ones that are an exact value match                      |
| **depth**      | every step down the tree, a `'*'` included                            |

**Precedence** for which declaration of a key wins (highest to lowest):

1. More **conditions** — the more that had to be true, the more specific
2. Then more **exact** matches — a value equality beats an opaque function
3. Then greater **depth** — a declaration always beats the ones it is nested under
4. Then **source order** — the later declaration in the tree wins
5. Below everything, the result schema's `.default()`

### Per-key cascade

Each result key resolves on its own, exactly like CSS resolves each property independently. A broad rule can set one key while a deeper rule sets another, and both survive into the result.

```typescript
rules: {
  tenantId: {
    tenantA: {
      temperature: 0.5, //                             set once, applies to every tier of tenantA
      serviceTier: {
        premium: { model: 'gpt-5' }, //                more specific, but only for `model`
      },
    },
  },
}

// resolve({ tenantId: 'tenantA', serviceTier: 'premium' })
// => { model: 'gpt-5', temperature: 0.5 }
```

### When nothing matches

Matching nothing is not an error; the result schema decides, key by key. A key with a `.default()` falls back to it. A key **without** a default has to come from a rule, so if none supplies it, that is a hole in your routing and `resolve` throws an [`UnresolvedError`](#unresolvederror):

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({ tenantId: z.string() }),
  resultSchema: z.object({ model: z.string(), maxTokens: z.number() }), // no defaults
  rules: { tenantId: { tenantA: { model: 'gpt-5' } } },
});

ruleset.resolve({ tenantId: 'tenantA' });
// UnresolvedError: No rule declared "maxTokens", and the result schema gives it no default.
//   error.resolved   ['model']
//   error.unresolved ['maxTokens']
```

Give every key a default and the ruleset is total — it can never throw.

### Explaining a decision

`explain` prints the full cascade per key, like the CSS pane in devtools, so it is obvious why a value was picked.

```typescript
console.log(ruleset.explain({ tenantId: 'tenantA', serviceTier: 'premium' }));
// model:
//   tenantId=tenantA > serviceTier=premium > fn() (3,2,3) -> gpt-5
//   tenantId=* (0,0,1) -> sonnet-5 [overridden]
// temperature:
//   tenantId=tenantA (1,1,1) -> 0.5
// => {"model":"gpt-5","temperature":0.5}
```

## Advanced

### Non-primitive identifiers

An identifier holding an object, array, or `Date` cannot be a static branch, but a function receives the whole context and can read it with the full language.

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({
    user: z.object({ id: z.string(), roles: z.array(z.string()) }),
    flags: z.array(z.string()),
  }),
  resultSchema: z.object({ model: z.string().default('gpt-5-mini') }),
  rules: ({ user, flags }) => user.roles.includes('admin') && flags.includes('beta') && { model: 'opus-4-8' },
});
```

> [!TIP]
> To branch on something rich statically, project it into a scalar identifier in the context, e.g. `plan: 'trial' | 'paid'` instead of `since: Date`.

### Keeping values together

The per-key cascade means `model` may come from one rule and `temperature` from another. If two values must travel as a unit, make them a single result key holding an object, so they are atomic by construction.

```typescript
resultSchema: z.object({
  preset: z
    .object({ model: z.string(), temperature: z.number() })
    .default({ model: 'gpt-5-mini', temperature: 1 }),
}),
```

### Any Standard Schema library

`ai-ruleset` never depends on a validation library. It reads schemas through two standards, both exposed under one `~standard` key:

- [**Standard Schema**](https://standardschema.dev) — infers the types and validates the merged result, via `~standard.validate`.
- [**Standard JSON Schema**](https://standardschema.dev/json-schema) — supplies the object's keys, via `~standard.jsonSchema`. This is the introspection that Standard Schema deliberately omits, and the reason both are needed.

The interfaces come from [`@standard-schema/spec`](https://www.npmjs.com/package/@standard-schema/spec), a types-only package, so a ruleset schema is just their intersection over an object value.

> [!IMPORTANT]
> A library whose JSON Schema conversion lives in a separate package rather than on `~standard` — such as **Valibot** today — is not enough on its own. Use Zod or ArkType, or any library that exposes `~standard.jsonSchema`.

### Synchronous only

> [!IMPORTANT]
> `resolve` is synchronous. If the result schema validates asynchronously (returns a `Promise` from `~standard.validate`), `resolve` throws a `TypeError` rather than silently awaiting. Use a synchronous schema.

### No layering yet

> [!NOTE]
> Specificity is the only ranking, so a cross-cutting rule cannot beat a more specific one. A two-deep exact path outranks a "long context wins" function. To force an override today, make it at least as specific as what it must beat. Cascade layers (a CSS `@layer` equivalent) are a possible future addition.

## API

### `createRuleset(options)`

```ts
function createRuleset<Context, Result>(options: {
  contextSchema: ObjectSchema<Context>; // identifiers a rule may branch on; keys read from its JSON Schema
  resultSchema: ObjectSchema<Result>; //  keys a rule may declare; validates and defaults the merged result
  rules: Rule<Context, Result>; //        the rule tree
}): Ruleset<Context, Result>;
```

Both `Context` and `Result` are inferred from the schemas. Throws a `TypeError` at creation if the context and result schemas share a key, or if a schema cannot produce an object JSON Schema.

### `ruleset.resolve(context)`

```ts
resolve(context: Context): Result
```

Resolves the complete result, each key cascaded on its own and validated by the result schema. Throws [`UnresolvedError`](#unresolvederror) when a key has neither a rule nor a default, [`SchemaError`](#schemaerror) when a declared value fails a schema constraint, and `TypeError` when the schema validates asynchronously.

### `ruleset.matchAll(context)`

```ts
matchAll(context: Context): Array<Match<Result>>
```

Returns every declaration that matched, most specific first, as an empty array when nothing matched. This is the non-throwing way to inspect a decision before committing to it.

### `ruleset.explain(context)`

```ts
explain(context: Context): string
```

Returns a human-readable cascade per result key, ending with the resolved value. For debugging; it resolves internally, so it can throw the same errors as `resolve`.

### `ruleset.options`

```ts
options: RulesetOptions<Context, Result>;
```

The options the ruleset was created with, verbatim: `contextSchema`, `resultSchema`, and `rules`.

### `UnresolvedError`

```ts
class UnresolvedError extends Error {
  context: Context; //          the context being resolved
  resolved: Array<string>; //   result keys a matching rule declared
  unresolved: Array<string>; // result keys nothing declared and the schema cannot default
  cause: unknown; //            the underlying Standard Schema issues
}
```

Thrown by `resolve` when a required result key was reached by no rule.

### `SchemaError`

```ts
class SchemaError extends Error {
  issues: ReadonlyArray<StandardSchemaV1.Issue>; // the Standard Schema validation issues
}
```

Thrown by `resolve` when the merged result fails the schema for a reason unrelated to the cascade, e.g. a declared value that breaks a constraint.

### `WILDCARD`

```ts
const WILDCARD = '*';
```

The universal branch key. `{ tenantId: { [WILDCARD]: rule } }` is `{ tenantId: { '*': rule } }` with the intent named.

## Types

### `ObjectSchema<Value>`

A schema implementing both standards over an object value — the type of `contextSchema` and `resultSchema`. Satisfied structurally by Zod, ArkType, and any library exposing `~standard.jsonSchema`.

```ts
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

type ObjectSchema<Value> = StandardSchemaV1<unknown, Value> & StandardJSONSchemaV1<unknown, Value>;
```

### `Rule`, `RuleNode`, `RuleFn`

The rule tree. A `Rule` is a `RuleNode` (object), a `RuleFn` (function), or an array of rules. A `RuleFn` receives the [narrowed](#narrowing) context and returns a nested rule or a falsy value.

```ts
type Rule<Context, Result, Used = never> =
  | RuleNode<Context, Result, Used>
  | RuleFn<Context, Result, Used>
  | Array<Rule<Context, Result, Used>>;
```

### `Match<Result>`

One matched declaration, as returned by `matchAll`.

```ts
type Match<Result> = {
  key: keyof Result; //           the result key it declares
  value: Result[keyof Result]; // the declared value
  specificity: Specificity; //    its rank
  path: Array<string>; //         the selector path, e.g. ['tenantId=tenantA', 'serviceTier=premium']
  order: number; //               position in source order, breaks ties
};
```

### `Specificity`

The rank of a declaration, compared left to right. See [Specificity](#specificity).

```ts
type Specificity = readonly [conditions: number, exact: number, depth: number];
```

### `Ruleset` and `RulesetOptions`

`Ruleset<Context, Result>` is the object `createRuleset` returns (`resolve`, `matchAll`, `explain`, `options`). `RulesetOptions<Context, Result>` is its input (`contextSchema`, `resultSchema`, `rules`).

### `Scoped<Context, Used>`

The context a function sees at a given depth — the full context with the already-consumed identifiers removed. It is `Omit<Context, Used>`.

### `Context`, `Result`, `Conflicts`

The base constraints. `Context` and `Result` are both `Record<string, unknown>` — the shapes your schemas infer to. `Conflicts<Context, Result>` is the set of keys the two share, which `createRuleset` rejects at compile time.

## License

MIT
