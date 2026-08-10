import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ObjectSchema } from './standard-schema.js';
import {
  type Conflicts,
  type Context,
  type Match,
  type Result,
  type Rule,
  type RuleFn,
  type Ruleset,
  type RulesetOptions,
  type Specificity,
  WILDCARD,
} from './types.js';

/**
 * Guards against rules that keep returning new rules forever.
 */
const MAX_DEPTH = 32;

/**
 * Thrown when the merged result fails the result schema for a reason unrelated to
 * the cascade, e.g. a declared value that breaks a constraint. That is the
 * schema's story to tell, not a routing gap, so it is kept distinct from
 * {@link UnresolvedError}.
 */
export class SchemaError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(`The result did not satisfy the schema: ${issues.map((issue) => issue.message).join('; ')}`);

    this.name = 'SchemaError';
    this.issues = issues;
  }
}

/**
 * Thrown when a result key was declared by no rule that matched, and the result
 * schema gives it no default to fall back on. Matching nothing is not an error in
 * itself, a key with a default resolves to it. This is the schema saying the key
 * has to come from somewhere and nothing supplied it.
 */
export class UnresolvedError extends Error {
  readonly context: Context;
  /** Result keys a matching rule did declare. */
  readonly resolved: Array<string>;
  /** Result keys nothing declared and the schema cannot default. */
  readonly unresolved: Array<string>;

  constructor(context: Context, resolved: Array<string>, unresolved: Array<string>, cause: unknown) {
    const keys = unresolved.map((key) => `"${key}"`).join(', ');
    const them = unresolved.length === 1 ? 'it' : 'them';

    super(
      `No rule declared ${keys}, and the result schema gives ${them} no default. ` +
        `Context: ${JSON.stringify(context)}`,
      { cause },
    );

    this.name = 'UnresolvedError';
    this.context = context;
    this.resolved = resolved;
    this.unresolved = unresolved;
  }
}

type Ranked = {
  specificity: Specificity;
  order: number;
};

/**
 * Compares two declarations so that the most specific one sorts first. Positions
 * are compared one by one, a higher count always beats any number of lower ranked
 * counts. Equal specificity falls back to source order, where the later
 * declaration wins.
 */
function compareMatches(a: Ranked, b: Ranked): number {
  for (let position = 0; position < a.specificity.length; position++) {
    const left = a.specificity[position] ?? 0;
    const right = b.specificity[position] ?? 0;

    if (left !== right) return right - left;
  }

  return b.order - a.order;
}

/**
 * JSON Schema dialects to ask for, in order. Some libraries default to a dialect
 * (Zod), others require one to be named (ArkType), so the first that converts is
 * used. Only the object's keys are read, which every dialect renders the same.
 */
const JSON_SCHEMA_TARGETS = ['draft-2020-12', 'draft-07'] as const;

/**
 * Reads an object schema's keys from its JSON Schema. This is the introspection
 * that plain Standard Schema does not offer, and the reason a ruleset schema
 * must also implement Standard JSON Schema.
 */
function keysOf(schema: ObjectSchema<unknown>): Set<string> {
  const converter = schema['~standard'].jsonSchema;
  const vendor = schema['~standard'].vendor;

  let jsonSchema: Record<string, unknown> | undefined;
  let failure: unknown;

  for (const target of JSON_SCHEMA_TARGETS) {
    try {
      jsonSchema = converter.output({ target });
      break;
    } catch (error) {
      failure = error;
    }
  }

  if (jsonSchema === undefined) {
    throw new TypeError(`Could not read the JSON Schema of the "${vendor}" schema.`, { cause: failure });
  }

  const properties = jsonSchema['properties'];

  if (properties === null || typeof properties !== 'object') {
    throw new TypeError(
      `A ruleset schema must be an object schema, but "${vendor}" produced a JSON Schema with no "properties".`,
    );
  }

  return new Set(Object.keys(properties));
}

type Counters = {
  exact: number;
  dynamic: number;
  wildcard: number;
};

type Walk<CONTEXT extends Context, RESULT extends Result> = {
  context: CONTEXT;
  /** Keys of the context schema. Every other key of a rule declares a result key. */
  identifiers: Set<string>;
  matches: Array<Match<RESULT>>;
  order: number;
};

/**
 * Ranks a declaration by how constrained the path to it was. Every step down the
 * tree raises the depth, and an exact or dynamic match also raises the number of
 * conditions, so a declaration is always stronger than the ones it is nested
 * under, and a wildcard step never makes it look more specific than it is.
 */
function toSpecificity(counters: Counters): Specificity {
  const conditions = counters.exact + counters.dynamic;

  return [conditions, counters.exact, conditions + counters.wildcard];
}

/**
 * Builds the context a dynamic rule sees. Identifiers already fixed by the path
 * are removed, because their value is implied by where the rule is declared.
 */
function scope<CONTEXT extends Context>(context: CONTEXT, used: Set<string>): CONTEXT {
  if (used.size === 0) return context;

  const scoped: Record<string, unknown> = {};

  for (const key of Object.keys(context)) {
    if (!used.has(key)) scoped[key] = context[key];
  }

  return scoped as CONTEXT;
}

/**
 * Walks the rule tree and collects every declaration that matches the context.
 * Keys are visited in source order, so the collected order breaks specificity ties.
 */
function walk<CONTEXT extends Context, RESULT extends Result>(
  rule: Rule<CONTEXT, RESULT>,
  counters: Counters,
  path: Array<string>,
  used: Set<string>,
  walker: Walk<CONTEXT, RESULT>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`Maximum rule depth of ${MAX_DEPTH} exceeded at "${path.join(' > ')}"`);
  }

  if (Array.isArray(rule)) {
    for (const nested of rule) {
      walk(nested, counters, path, used, walker, depth + 1);
    }
    return;
  }

  /**
   * A dynamic rule is an extra condition on top of the path that led to it, so a
   * match counts towards the dynamic part of the specificity.
   */
  if (typeof rule === 'function') {
    const result = (rule as RuleFn<CONTEXT, RESULT>)(scope(walker.context, used));
    if (!result) return;

    walk(result, { ...counters, dynamic: counters.dynamic + 1 }, [...path, 'fn()'], used, walker, depth + 1);
    return;
  }

  if (rule === null || typeof rule !== 'object') return;

  const node = rule as Record<string, unknown>;

  for (const key of Object.keys(node)) {
    if (!walker.identifiers.has(key)) {
      walker.matches.push({
        key,
        value: node[key],
        specificity: toSpecificity(counters),
        path: [...path],
        order: walker.order++,
      } as Match<RESULT>);
      continue;
    }

    /**
     * Branching on an identifier is a statement about that identifier, so nothing
     * below it can match unless the context actually carries a value for it. That
     * holds for the universal match too: it stands for any value, which still
     * means there has to be one.
     */
    const value = walker.context[key];

    if (value === undefined || value === null) continue;

    /**
     * The value is stringified so that booleans and numbers can be used as object
     * keys. Descending marks the identifier as used for everything below it.
     */
    const values = node[key] as Record<string, Rule<CONTEXT, RESULT> | undefined>;
    const nestedUsed = new Set(used).add(key);
    const nested = values[String(value)];

    if (nested !== undefined) {
      walk(
        nested,
        { ...counters, exact: counters.exact + 1 },
        [...path, `${key}=${String(value)}`],
        nestedUsed,
        walker,
        depth + 1,
      );
    }

    const wildcard = values[WILDCARD];

    if (wildcard !== undefined) {
      walk(
        wildcard,
        { ...counters, wildcard: counters.wildcard + 1 },
        [...path, `${key}=${WILDCARD}`],
        nestedUsed,
        walker,
        depth + 1,
      );
    }
  }
}

/**
 * Rejects a result type that shares keys with the context. Such a key would be a
 * branch and a declaration at the same time, so it has to be renamed.
 */
type Guard<CONTEXT extends Context, RESULT extends Result> = [Conflicts<CONTEXT, RESULT>] extends [never]
  ? unknown
  : {
      'Context and Result must not share keys': Conflicts<CONTEXT, RESULT>;
    };

/**
 * Creates a ruleset that resolves a result from a context at run time.
 *
 * Rules are a nested tree of identifiers, values and dynamic functions. Every
 * declaration that matches the context is collected, and per result key the most
 * specific one wins, like the CSS cascade.
 *
 * Both types are inferred from the schemas. A schema is not there to validate the
 * context, the types already do that. It is there so that the ruleset knows
 * which keys of a rule are identifiers to branch on and which ones are result
 * keys to declare, which no type can answer once it is erased.
 */
export function createRuleset<CONTEXT extends Context, RESULT extends Result>(
  options: RulesetOptions<CONTEXT, RESULT> & Guard<CONTEXT, RESULT>,
): Ruleset<CONTEXT, RESULT> {
  const { contextSchema, resultSchema, rules } = options as RulesetOptions<CONTEXT, RESULT>;

  const identifiers = keysOf(contextSchema);
  const declarations = keysOf(resultSchema);

  /**
   * The type level guard already rejects this, but a schema can be built at run
   * time and a plain JavaScript caller has no guard at all.
   */
  const conflicts = [...identifiers].filter((key) => declarations.has(key));

  if (conflicts.length > 0) {
    throw new TypeError(`Context and result must not share keys: ${conflicts.join(', ')}`);
  }

  const matchAll = (context: CONTEXT): Array<Match<RESULT>> => {
    const walker: Walk<CONTEXT, RESULT> = {
      context,
      identifiers,
      matches: [],
      order: 0,
    };

    walk(rules, { exact: 0, dynamic: 0, wildcard: 0 }, [], new Set(), walker, 0);

    return walker.matches.sort(compareMatches);
  };

  /**
   * Merges the winning declaration of every key. Matches are sorted, so the first
   * declaration of a key is the winning one.
   */
  const merge = (context: CONTEXT): Record<string, unknown> => {
    const merged: Record<string, unknown> = {};

    for (const match of matchAll(context)) {
      if (match.key in merged) continue;

      merged[match.key as string] = match.value;
    }

    return merged;
  };

  const resolve = (context: CONTEXT): RESULT => {
    const merged = merge(context);
    const parsed = resultSchema['~standard'].validate(merged);

    if (parsed instanceof Promise) {
      throw new TypeError('The result schema validates asynchronously, which resolve cannot await.');
    }

    if (parsed.issues) {
      const unresolved = [...declarations].filter((key) => !(key in merged));

      /**
       * A schema can reject a value for reasons that have nothing to do with the
       * cascade, e.g. a declared value that fails a constraint. Only a key that
       * no rule reached is this ruleset's story to tell.
       */
      if (unresolved.length === 0) throw new SchemaError(parsed.issues);

      throw new UnresolvedError(context, Object.keys(merged), unresolved, parsed.issues);
    }

    return parsed.value;
  };

  const explain = (context: CONTEXT): string => {
    const matches = matchAll(context);

    const cascade = [...declarations].map((key) => {
      const declared = matches.filter((match) => match.key === key);

      if (declared.length === 0) return `${key}:\n  :schema`;

      const lines = declared.map(({ value, specificity, path }, index) => {
        const selector = path.length > 0 ? path.join(' > ') : ':root';
        const score = `(${specificity.join(',')})`;
        const declaration = typeof value === 'string' ? value : JSON.stringify(value);
        const suffix = index === 0 ? '' : ' [overridden]';

        return `  ${selector} ${score} -> ${declaration}${suffix}`;
      });

      return [`${key}:`, ...lines].join('\n');
    });

    return [...cascade, `=> ${JSON.stringify(resolve(context))}`].join('\n');
  };

  return { resolve, matchAll, explain, options };
}
