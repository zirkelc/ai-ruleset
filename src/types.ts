import type { ObjectSchema } from './standard-schema.js';

/**
 * Context describing the request at run time. Every field can be used as a rule
 * identifier, e.g. tenant ID, service tier, feature flags.
 */
export type Context = Record<string, unknown>;

/**
 * What a rule resolves to. Its keys are declared inside rules and must not
 * collide with the identifiers of the context.
 */
export type Result = Record<string, unknown>;

/**
 * Identifiers that also exist as result keys. Declaring one is ambiguous, since
 * a key cannot be a branch and a declaration at the same time.
 */
export type Conflicts<CONTEXT extends Context, RESULT extends Result> = Extract<keyof CONTEXT, keyof RESULT>;

/**
 * Object keys a context value can be looked up under. Values are stringified at
 * run time, so booleans and numbers become their literal string form.
 *
 * Anything else, an object, an array, a `Date`, has no lossless key form and
 * resolves to `never`, which takes the identifier out of {@link Branchable}.
 */
type ValueKey<VALUE> = VALUE extends boolean
  ? `${VALUE}`
  : VALUE extends number
    ? VALUE | `${VALUE}`
    : VALUE extends string
      ? VALUE
      : never;

/**
 * Identifiers that can be branched on statically, i.e. the ones whose values can
 * be written as object keys. An identifier holding anything richer is still there
 * to be read inside a dynamic rule, it just cannot be the head of a value map.
 */
type Branchable<CONTEXT extends Context> = {
  [KEY in Extract<keyof CONTEXT, string>]: [ValueKey<NonNullable<CONTEXT[KEY]>>] extends [never] ? never : KEY;
}[Extract<keyof CONTEXT, string>];

/**
 * Context fields usable as branch keys. Result keys are excluded because they
 * declare a value, and identifiers already narrowed on a higher level are
 * excluded so the same identifier cannot be branched on twice along a path.
 */
type BranchKey<CONTEXT extends Context, RESULT extends Result, USED extends keyof CONTEXT> = Exclude<
  Branchable<CONTEXT>,
  Extract<keyof RESULT, string> | USED
>;

/**
 * Universal selector. Matches any value of an identifier and contributes the
 * lowest specificity, like `*` in CSS.
 */
export const WILDCARD = '*';

/**
 * The context still open for narrowing. Identifiers fixed on a higher level are
 * removed, because their value is already implied by the path.
 */
export type Scoped<CONTEXT extends Context, USED extends keyof CONTEXT> = Omit<CONTEXT, USED>;

/**
 * Maps each possible value of one identifier to a nested rule. Descending into a
 * value marks the identifier as used for everything below it.
 */
type ValueMap<CONTEXT extends Context, RESULT extends Result, KEY extends keyof CONTEXT, USED extends keyof CONTEXT> = {
  [VALUE in ValueKey<NonNullable<CONTEXT[KEY]>>]?: Rule<CONTEXT, RESULT, USED | KEY>;
} & {
  [WILDCARD]?: Rule<CONTEXT, RESULT, USED | KEY>;
};

/**
 * A dynamic rule. Receives the identifiers that are still open and returns a
 * nested rule, or a falsy value to signal that it does not match.
 */
export type RuleFn<CONTEXT extends Context, RESULT extends Result, USED extends keyof CONTEXT = never> = (
  context: Scoped<CONTEXT, USED>,
) => Rule<CONTEXT, RESULT, USED> | undefined | null | false;

/**
 * The branch of a node. A node picks **at most one** identifier, so every level
 * narrows exactly one thing and the path to a declaration reads as a single
 * chain. Branching on a second identifier at the same level is a compile error,
 * a list of rules is how you branch on two identifiers side by side.
 *
 * Built as one variant per identifier, each of which forbids the others. Once
 * every identifier is used up it collapses to `unknown`, so a leaf is still a
 * valid node.
 */
type Branch<CONTEXT extends Context, RESULT extends Result, USED extends keyof CONTEXT> = [
  BranchKey<CONTEXT, RESULT, USED>,
] extends [never]
  ? unknown
  : {
      [KEY in BranchKey<CONTEXT, RESULT, USED>]: { [SELF in KEY]?: ValueMap<CONTEXT, RESULT, KEY, USED> } & {
        [OTHER in Exclude<BranchKey<CONTEXT, RESULT, USED>, KEY>]?: never;
      };
    }[BranchKey<CONTEXT, RESULT, USED>];

/**
 * A node in the rule tree. It declares result keys, branches on one identifier,
 * or both. Every result key is declared on its own, so a node can set one key and
 * leave the rest to be cascaded from elsewhere.
 */
export type RuleNode<
  CONTEXT extends Context,
  RESULT extends Result,
  USED extends keyof CONTEXT = never,
> = Partial<RESULT> & Branch<CONTEXT, RESULT, USED>;

/**
 * A rule is a node, a dynamic function, or a list of rules that all apply at the
 * same level.
 */
export type Rule<CONTEXT extends Context, RESULT extends Result, USED extends keyof CONTEXT = never> =
  | RuleNode<CONTEXT, RESULT, USED>
  | RuleFn<CONTEXT, RESULT, USED>
  | Array<Rule<CONTEXT, RESULT, USED>>;

/**
 * Specificity of a matched declaration, compared position by position. A
 * declaration is more specific the more had to be true for it to apply.
 *
 * 1. conditions: everything that had to hold, an exact identifier value match
 *    (`tenantId: { tenantA: ... }`) or a dynamic rule that matched
 * 2. exact: of those conditions, the ones that are an exact value match. Breaks a
 *    tie towards a value equality and away from an opaque predicate
 * 3. depth: every step down the tree, a universal match (`'*'`) included. A
 *    wildcard adds no condition, so this is what keeps a declaration stronger
 *    than the ones it is nested under
 */
export type Specificity = readonly [conditions: number, exact: number, depth: number];

/**
 * A single result key declared by a rule that matched the context.
 */
export type Match<RESULT extends Result> = {
  [KEY in keyof RESULT]: {
    key: KEY;
    value: RESULT[KEY];
    specificity: Specificity;
    /** Selector path that led to the declaration, e.g. `tenantId=tenantA > serviceTier=premium`. */
    path: Array<string>;
    /** Position in the rule tree in source order. Breaks ties, later declarations win. */
    order: number;
  };
}[keyof RESULT];

export type RulesetOptions<CONTEXT extends Context, RESULT extends Result> = {
  /**
   * Identifiers of the context. Its keys, read from the schema's JSON Schema, are
   * the keys a rule may branch on. The context itself is never validated.
   */
  contextSchema: ObjectSchema<CONTEXT>;
  /**
   * Shape of the result. Its keys are the keys a rule may declare. The merged
   * result is validated with it, which strips anything it does not declare and
   * fills in its defaults.
   */
  resultSchema: ObjectSchema<RESULT>;
  /** The rule tree. */
  rules: Rule<CONTEXT, RESULT>;
};

export type Ruleset<CONTEXT extends Context, RESULT extends Result> = {
  /** Resolves the result. Every key is cascaded on its own. */
  resolve: (context: CONTEXT) => RESULT;
  /** Returns every declaration that matched, most specific first. */
  matchAll: (context: CONTEXT) => Array<Match<RESULT>>;
  /** Human readable cascade per result key, like the CSS pane in devtools. */
  explain: (context: CONTEXT) => string;
  /** The options this ruleset was created with. */
  options: RulesetOptions<CONTEXT, RESULT>;
};
