<div align="center">

<h1>ai-ruleset</h1>

<p align="center">Resolve nested rules from runtime context, like a decision tree</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ai-ruleset" alt="ai-ruleset"><img src="https://img.shields.io/npm/dt/ai-ruleset?label=ai-ruleset"></a> <a href="https://github.com/zirkelc/ai-ruleset/actions/workflows/ci.yml" alt="CI"><img src="https://img.shields.io/github/actions/workflow/status/zirkelc/ai-ruleset/ci.yml?branch=main"></a>
</p>

</div>

`ai-ruleset` resolves a result from the runtime context of a request. You declare the mapping in code as a nested tree of rules, a decision tree that branches on fields like plan, task, or feature flags. It resolves like the [CSS cascade](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade): every rule that matches is collected, and per result key the most specific one wins. The running example throughout routes a request to an AI model and its generation parameters, but the result is any object you define. Types come from any [Standard Schema](https://standardschema.dev) library, so you bring your own [Zod](https://zod.dev) or [ArkType](https://arktype.io).

## Why?

Every app that calls an LLM has this function somewhere: look at the request and decide which model to call, with which parameters. Free users get the small model. Pro users get the big one. Code tasks want temperature 0. Long inputs need the long-context model. Beta testers get the new release. Each decision is one more `if`, and together they grow into a function nobody wants to touch.

- **Branching logic sprawls**: the mapping from request to model ends up as conditionals scattered across call sites, each with its own copy of the rules.
- **Precedence is accidental**: when the pro-plan rule and the long-input rule both apply, the winner is whichever branch you happened to write first, not the one you meant.
- **The mapping lives nowhere**: there is no single object you can read, test, or hand to a teammate to explain why a request got the model it got.

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
> A schema must implement [Standard Schema](https://standardschema.dev) (for validation and type inference) **and** [Standard JSON Schema](https://standardschema.dev/json-schema) (for key introspection). Verified with **Zod** 4.2+ and **ArkType** 2.1+. See [`ObjectSchema`](#objectschemavalue) for the details and current caveats.

## Usage

Describe the request with a **context** schema and the answer with a **result** schema, then declare rules that branch on the context's fields and set the result's keys.

```typescript
import { z } from 'zod';
import { createRuleset } from 'ai-ruleset';

/** What a request looks like. */
const contextSchema = z.object({
  plan: z.enum(['free', 'pro']),
  task: z.enum(['chat', 'code', 'summarize']),
  reasoning: z.boolean().optional(),
  inputTokens: z.number().optional(),
});

/** What every request must resolve to. */
const resultSchema = z.object({
  model: z.string().default('claude-haiku-4-5'),
  temperature: z.number().default(1),
});

const ruleset = createRuleset({
  contextSchema,
  resultSchema,
  rules: {
    plan: {
      pro: {
        model: 'claude-sonnet-5',
        task: {
          code: { model: 'claude-opus-5' },
        },
      },
    },
  },
});

ruleset.resolve({ plan: 'pro', task: 'code' });
// { model: 'claude-opus-5', temperature: 1 }
ruleset.resolve({ plan: 'pro', task: 'chat' });
// { model: 'claude-sonnet-5', temperature: 1 }
ruleset.resolve({ plan: 'free', task: 'chat' });
// { model: 'claude-haiku-4-5', temperature: 1 } — both from the schema defaults
```

The tree reads as the policy it implements: pro users get `claude-sonnet-5`, except code tasks, which get `claude-opus-5`. Everyone else gets the default. `resolve` always returns a complete result: any key no rule set falls back to the result schema's `.default()`.

The examples below all reuse this `contextSchema` and `resultSchema` pair.

### Schemas

The context and result schemas are **not** there to validate the context, the types already do that. They are there so the ruleset can tell, at run time, which keys of a rule are identifiers to branch on (`plan`, `task`) and which are result keys to declare (`model`, `temperature`). Types are erased at run time, so only a schema can answer that.

The two must not share a key, because that key would be a branch and a declaration at the same time:

```typescript
createRuleset({
  contextSchema: z.object({ plan: z.enum(['free', 'pro']), model: z.string() }), // the model the client requests
  resultSchema: z.object({ model: z.string().default('claude-haiku-4-5') }), //   the model to use
  rules: {},
});
// Compile error: 'Context and Result must not share keys': "model"
// (a plain JavaScript caller gets a TypeError at run time instead)
```

Rename one side to break the tie, e.g. `requestedModel` in the context.

### Rules

A rule is an **object** or a **function**.

An **object** declares result keys, branches on one identifier, or does both at once:

```typescript
rules: {
  model: 'claude-haiku-4-5', //           declares a result key
  plan: {
    pro: { model: 'claude-sonnet-5' }, // branches on one identifier
  },
}
```

A **function** receives the context and returns another rule, or a falsy value for "does not match". The returned rule is often just an object declaring a result key:

```typescript
rules: ({ inputTokens }) => (inputTokens ?? 0) > 100_000 ? { model: 'claude-opus-5' } : undefined,
```

The two shapes nest in any order:

```typescript
rules: {
  model: 'claude-haiku-4-5',
  plan: {
    pro: ({ inputTokens }) => (inputTokens ?? 0) > 100_000 ? { model: 'claude-opus-5' } : { model: 'claude-sonnet-5' },
  },
}
```

An **array** applies several rules at the same level, which is also how two identifiers branch side by side. It is not limited to the top level: an array fits wherever a rule fits, under a branch value or returned from a function.

```typescript
rules: [
  // pro users get the bigger model
  { plan: { pro: { model: 'claude-sonnet-5' } } },
  // long requests escalate, whatever the plan
  ({ inputTokens }) => (inputTokens ?? 0) > 100_000 && { model: 'claude-opus-5' },
];

// resolve({ plan: 'free', task: 'chat', inputTokens: 200_000 })
// => { model: 'claude-opus-5', temperature: 1 }
```

### Branching on identifiers

A branch maps values of one context field to nested rules. Values are stringified for lookup, so strings, numbers, and booleans all work as keys. An object branches on **at most one** identifier: nest them when one qualifies the other, and reach for an array when they are independent.

```typescript
rules: {
  reasoning: {
    true: { model: 'claude-opus-5' }, // boolean keys work, the value is stringified
    false: { model: 'claude-haiku-4-5' },
  },
  task: { code: { temperature: 0 } }, // Error: an object branches on one identifier, use an array
}
```

An identifier whose value is not a string, number, or boolean (an object, an array, a `Date`) has no sensible key form and cannot head a branch. It is still readable inside a function.

### Non-primitive identifiers

A function receives the whole context and can read its rich values with the full language.

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({
    user: z.object({ id: z.string(), roles: z.array(z.string()) }),
    flags: z.array(z.string()),
  }),
  resultSchema: z.object({ model: z.string().default('claude-haiku-4-5') }),
  rules: ({ user, flags }) => user.roles.includes('tester') && flags.includes('beta') && { model: 'claude-fable-5' },
});
```

> [!TIP]
> To branch on something rich statically, project it into a scalar identifier in the context, e.g. `plan: 'free' | 'pro'` instead of `subscribedAt: Date`.

### Universal match

`'*'` (exported as `WILDCARD`) matches any value of an identifier, which still means there has to be one: a branch on an identifier never matches when the context carries no value for it.

```typescript
rules: {
  task: {
    code: { model: 'claude-opus-5' },
    '*': { model: 'claude-sonnet-5' }, // every other task
  },
}
```

### Narrowing

Descending into an identifier **consumes** it: it disappears from the types below, so you cannot branch on it twice down a path. Functions see the same narrowed view. They only receive the identifiers still in play, at compile time and at run time.

```typescript
rules: {
  plan: {
    pro: {
      task: {
        // context here has neither plan nor task, both are already fixed
        code: (context) => (context.inputTokens ?? 0) > 50_000
          ? { model: 'claude-opus-5' }
          : { model: 'claude-sonnet-5' },
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

1. More **conditions**: the more that had to be true, the more specific
2. Then more **exact** matches: a value equality beats an opaque function
3. Then greater **depth**: a declaration always beats the ones it is nested under
4. Then **source order**: the later declaration in the tree wins
5. Below everything, the result schema's `.default()`

> [!NOTE]
> Specificity is the only ranking, so a cross-cutting rule cannot beat a more specific one. A two-deep exact path outranks a "long input wins" function. To force an override, make it at least as specific as what it must beat.

### Per-key cascade

Each result key resolves on its own, exactly like CSS resolves each property independently. A broad rule can set one key while a deeper rule sets another, and both survive into the result.

```typescript
rules: {
  plan: {
    pro: {
      temperature: 0.7, //                          set once, applies to every pro task
      task: {
        code: { model: 'claude-opus-5' }, //        more specific, but only for `model`
      },
    },
  },
}

// resolve({ plan: 'pro', task: 'code' })
// => { model: 'claude-opus-5', temperature: 0.7 }
```

The flip side: because each key cascades on its own, `model` can come from one rule and `temperature` from another. When two values are only valid together, that mix would be wrong. Make them one result key holding an object, and each rule declares the pair whole, so the cascade picks one rule's pair or another's, never a blend.

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({ plan: z.enum(['free', 'pro']) }),
  resultSchema: z.object({
    preset: z
      .object({ model: z.string(), temperature: z.number() })
      .default({ model: 'claude-haiku-4-5', temperature: 1 }),
  }),
  rules: {
    plan: {
      pro: { preset: { model: 'claude-opus-5', temperature: 0.7 } },
    },
  },
});

ruleset.resolve({ plan: 'pro' });
// { preset: { model: 'claude-opus-5', temperature: 0.7 } }
ruleset.resolve({ plan: 'free' });
// { preset: { model: 'claude-haiku-4-5', temperature: 1 } }
```

### When nothing matches

Matching nothing is not an error; the result schema decides, key by key. A key with a `.default()` falls back to it. A key **without** a default has to come from a rule, so if none supplies it, that is a hole in your routing and `resolve` throws an [`UnresolvedError`](#unresolvederror):

```typescript
const ruleset = createRuleset({
  contextSchema: z.object({ plan: z.enum(['free', 'pro']) }),
  resultSchema: z.object({ model: z.string(), maxOutputTokens: z.number() }), // no defaults
  rules: { plan: { pro: { model: 'claude-sonnet-5' } } },
});

ruleset.resolve({ plan: 'pro' });
// UnresolvedError: No rule declared "maxOutputTokens", and the result schema gives it no default.
//   error.resolved   ['model']
//   error.unresolved ['maxOutputTokens']
```

Give every key a default and the ruleset is total: it can never throw.

### Explaining a decision

`explain` prints the full cascade per key, like the CSS pane in devtools, so it is obvious why a value was picked.

```typescript
const ruleset = createRuleset({
  contextSchema,
  resultSchema,
  rules: {
    plan: {
      pro: {
        temperature: 0.7,
        task: {
          code: ({ inputTokens }) =>
            (inputTokens ?? 0) > 50_000 ? { model: 'claude-opus-5' } : { model: 'claude-sonnet-5' },
        },
      },
      '*': { model: 'claude-haiku-4-5' },
    },
  },
});

console.log(ruleset.explain({ plan: 'pro', task: 'code', inputTokens: 80_000 }));
// model:
//   plan=pro > task=code > fn() (3,2,3) -> claude-opus-5
//   plan=* (0,0,1) -> claude-haiku-4-5 [overridden]
// temperature:
//   plan=pro (1,1,1) -> 0.7
// => {"model":"claude-opus-5","temperature":0.7}
```

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

Resolves the complete result, each key cascaded on its own and validated by the result schema. Throws [`UnresolvedError`](#unresolvederror) when a key has neither a rule nor a default, and [`SchemaError`](#schemaerror) when a declared value fails a schema constraint.

> [!IMPORTANT]
> `resolve` is synchronous. If the result schema validates asynchronously (returns a `Promise` from `~standard.validate`), `resolve` throws a `TypeError` rather than silently awaiting. Use a synchronous schema.

### `ruleset.matchAll(context)`

```ts
matchAll(context: Context): Array<Match<Result>>
```

Returns every declaration that matched, most specific first. When nothing matched, it returns an empty array rather than throwing, so it is the safe way to inspect a decision before committing to it.

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

The universal branch key. `{ task: { [WILDCARD]: rule } }` is `{ task: { '*': rule } }` with the intent named.

## Types

### `ObjectSchema<Value>`

A schema implementing both standards over an object value, the type of `contextSchema` and `resultSchema`.

```ts
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';

type ObjectSchema<Value> = StandardSchemaV1<unknown, Value> & StandardJSONSchemaV1<unknown, Value>;
```

The ruleset never depends on a validation library. It reads schemas through two standards, both exposed under one `~standard` key:

- [**Standard Schema**](https://standardschema.dev) infers the types and validates the merged result, via `~standard.validate`.
- [**Standard JSON Schema**](https://standardschema.dev/json-schema) supplies the object's keys, via `~standard.jsonSchema`. This is the introspection that Standard Schema deliberately omits, and the reason both are needed.

The interfaces come from [`@standard-schema/spec`](https://www.npmjs.com/package/@standard-schema/spec), a types-only package, so `ObjectSchema` is satisfied structurally by Zod, ArkType, and any library exposing `~standard.jsonSchema`.

> [!IMPORTANT]
> A library whose JSON Schema conversion lives in a separate package rather than on `~standard`, such as **Valibot** today, is not enough on its own. Use Zod or ArkType, or any library that exposes `~standard.jsonSchema`.

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
  path: Array<string>; //         the selector path, e.g. ['plan=pro', 'task=code']
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

The context a function sees at a given depth: the full context with the already-consumed identifiers removed. It is `Omit<Context, Used>`.

### `Context`, `Result`, `Conflicts`

The base constraints. `Context` and `Result` are both `Record<string, unknown>`, the shapes your schemas infer to. `Conflicts<Context, Result>` is the set of keys the two share, which `createRuleset` rejects at compile time.

## License

MIT
