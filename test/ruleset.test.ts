import { describe, expect, expectTypeOf, test } from 'vitest';
import { type } from 'arktype';
import { z } from 'zod';
import {
  createRuleset,
  type ObjectSchema,
  type RuleFn,
  type Scoped,
  SchemaError,
  UnresolvedError,
  WILDCARD,
} from '../src/index.js';

const contextSchema = z.object({
  tenantId: z.string(),
  serviceTier: z.enum(['free', 'premium']),
  hasPremium: z.boolean().optional(),
  requestTokens: z.number().optional(),
});

const resultSchema = z.object({
  model: z.string().default('default'),
  temperature: z.number().default(1),
});

type ModelContext = z.infer<typeof contextSchema>;
type ModelResult = z.infer<typeof resultSchema>;

describe('static rules', () => {
  test('should resolve a nested static rule', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: {
            serviceTier: {
              free: { model: 'a-free' },
              premium: { model: 'a-premium' },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium' });

    // Assert
    expect(result).toEqual({ model: 'a-premium', temperature: 1 });
    expectTypeOf(result).toEqualTypeOf<ModelResult>();
  });

  test('should fall back to a less specific declaration', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: {
            model: 'a-default',
            serviceTier: {
              premium: { model: 'a-premium' },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'a-default', temperature: 1 });
  });

  test('should match a boolean identifier', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        hasPremium: {
          true: { model: 'premium' },
          false: { model: 'basic' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result).toEqual({ model: 'premium', temperature: 1 });
  });

  test('should skip an identifier that is missing from the context', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        hasPremium: {
          true: { model: 'premium' },
          false: { model: 'basic' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'default', temperature: 1 });
  });
});

describe('dynamic rules', () => {
  test('should resolve a function used as a value of a static rule', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantB: ({ serviceTier }) => (serviceTier === 'free' ? { model: 'b-free' } : { model: 'b-premium' }),
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantB', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'b-free', temperature: 1 });
  });

  test('should resolve a function used as the whole rule tree', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: ({ requestTokens }) => (requestTokens ?? 0) > 100_000 && { model: 'long-context' },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', requestTokens: 200_000 });

    // Assert
    expect(result).toEqual({ model: 'long-context', temperature: 1 });
  });

  test('should ignore a function that does not match', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: ({ requestTokens }) => (requestTokens ?? 0) > 100_000 && { model: 'long-context' },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', requestTokens: 1_000 });

    // Assert
    expect(result).toEqual({ model: 'default', temperature: 1 });
  });

  test('should let a function return a nested static rule', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: ({ hasPremium }) =>
        hasPremium && {
          serviceTier: {
            free: { model: 'premium-trial' },
            premium: { model: 'premium-full' },
          },
        },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium', hasPremium: true });

    // Assert
    expect(result).toEqual({ model: 'premium-full', temperature: 1 });
  });

  test('should hide identifiers that a higher level already narrowed', () => {
    // Arrange
    const seen: Array<unknown> = [];
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: {
            serviceTier: {
              premium: (context) => {
                seen.push(context);
                expectTypeOf(context).toEqualTypeOf<Scoped<ModelContext, 'tenantId' | 'serviceTier'>>();

                return { model: 'a-premium' };
              },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium', hasPremium: true });

    // Assert
    expect(result).toEqual({ model: 'a-premium', temperature: 1 });
    expect(seen[0]).toEqual({ hasPremium: true });
  });

  test('should throw when functions keep returning functions past the depth limit', () => {
    // Arrange
    const endless: RuleFn<ModelContext, ModelResult> = () => endless;
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: endless,
    });

    // Act
    let error: Error | undefined;
    try {
      ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });
    } catch (caught) {
      error = caught as Error;
    }

    // Assert
    expect(error?.message).toContain('Maximum rule depth');
  });
});

describe('branches', () => {
  test('should reject a node that branches on two identifiers', () => {
    // Arrange
    // Act
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      // @ts-expect-error a node branches on at most one identifier, use a list for two
      rules: {
        tenantId: { tenantA: { model: 'a' } },
        serviceTier: { free: { model: 'b' } },
      },
    });

    // Assert
    expect(ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' }).model).toBe('b');
  });

  test('should not match a wildcard when the identifier is absent from the context', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        hasPremium: {
          '*': { model: 'any-value' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result.model).toBe('default');
  });

  test('should match a wildcard on any value the identifier does carry', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        hasPremium: {
          '*': { model: 'any-value' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: false });

    // Assert
    expect(result.model).toBe('any-value');
  });

  test('should branch on two identifiers side by side through a list', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [{ tenantId: { tenantA: { temperature: 0.5 } } }, { serviceTier: { free: { model: 'free-model' } } }],
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'free-model', temperature: 0.5 });
  });

  test('should match a branch declared with the exported wildcard', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          [WILDCARD]: { model: 'any-tenant' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(WILDCARD).toBe('*');
    expect(result.model).toBe('any-tenant');
  });
});

describe('non primitive identifiers', () => {
  const richSchema = z.object({
    tenantId: z.string(),
    user: z.object({ id: z.string(), roles: z.array(z.string()) }),
    flags: z.array(z.string()),
  });

  test('should read a non primitive identifier inside a dynamic rule', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema: richSchema,
      resultSchema,
      rules: ({ user, flags }) => user.roles.includes('admin') && flags.includes('beta') && { model: 'admin-beta' },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 't', user: { id: 'u', roles: ['admin'] }, flags: ['beta'] });

    // Assert
    expect(result.model).toBe('admin-beta');
  });

  test('should reject a branch on a non primitive identifier', () => {
    // Arrange
    // Act
    const ruleset = createRuleset({
      contextSchema: richSchema,
      resultSchema,
      // @ts-expect-error an object has no lossless key form, use a dynamic rule
      rules: { user: { '*': { model: 'any-user' } } },
    });

    // Assert
    expect(ruleset.resolve({ tenantId: 't', user: { id: 'u', roles: [] }, flags: [] }).model).toBe('any-user');
  });
});

describe('rule lists', () => {
  test('should collect every rule of a list', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [{ tenantId: { tenantA: { model: 'a' } } }, ({ hasPremium }) => hasPremium && { model: 'premium' }],
    });

    // Act
    const result = ruleset.matchAll({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result.map((match) => match.value)).toEqual(['a', 'premium']);
  });

  test('should nest a list inside a static rule', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: [
            { model: 'a-default' },
            ({ requestTokens }) => (requestTokens ?? 0) > 100_000 && { model: 'a-long-context' },
          ],
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', requestTokens: 200_000 });

    // Assert
    expect(result).toEqual({ model: 'a-long-context', temperature: 1 });
  });
});

describe('specificity', () => {
  test('should prefer a deeper static rule over a shallower one', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        model: 'root',
        tenantId: {
          tenantA: {
            model: 'tenant',
            serviceTier: {
              premium: { model: 'tenant-tier' },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.matchAll({ tenantId: 'tenantA', serviceTier: 'premium' });

    // Assert
    expect(result.map((match) => match.value)).toEqual(['tenant-tier', 'tenant', 'root']);
  });

  test('should prefer a static match over a dynamic match at the same depth', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [{ tenantId: { tenantA: { model: 'static' } } }, ({ hasPremium }) => hasPremium && { model: 'dynamic' }],
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result.model).toBe('static');
  });

  test('should prefer a dynamic match over a wildcard match', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [{ tenantId: { '*': { model: 'wildcard' } } }, ({ hasPremium }) => hasPremium && { model: 'dynamic' }],
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result.model).toBe('dynamic');
  });

  test('should prefer an exact value over a wildcard of the same identifier', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          '*': { model: 'wildcard' },
          tenantA: { model: 'exact' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result.model).toBe('exact');
  });

  test('should let the last declaration win on equal specificity', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [{ tenantId: { tenantA: { model: 'first' } } }, { serviceTier: { free: { model: 'last' } } }],
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result.model).toBe('last');
  });

  test('should report the specificity of a match', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: ({ hasPremium }) => hasPremium && { model: 'a-premium' },
        },
      },
    });

    // Act
    const result = ruleset.matchAll({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result[0]?.specificity).toEqual([2, 1, 2]);
    expect(result[0]?.path).toEqual(['tenantId=tenantA', 'fn()']);
  });

  test('should prefer more conditions over fewer, whether they are exact or dynamic', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: [
        { tenantId: { tenantA: { model: 'one-exact' } } },
        ({ hasPremium }) => hasPremium && (({ serviceTier }) => serviceTier === 'free' && { model: 'two-dynamic' }),
      ],
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free', hasPremium: true });

    // Assert
    expect(result.model).toBe('two-dynamic');
  });

  test('should keep a declaration stronger than the ones it is nested under, even below a wildcard', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        /** The shallower declaration is written last, so only depth can decide. */
        tenantId: { '*': { model: 'deep' } },
        model: 'shallow',
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result.model).toBe('deep');
  });
});

describe('result schema', () => {
  test('should cascade every result key on its own', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: {
            temperature: 0.5,
            serviceTier: {
              premium: { model: 'large' },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium' });

    // Assert
    expect(result).toEqual({ model: 'large', temperature: 0.5 });
  });

  test('should fill in the defaults of the schema', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {},
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'default', temperature: 1 });
  });

  test('should throw when a key has no declaration and no default', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema: z.object({ model: z.string() }),
      rules: {},
    });

    // Act
    const result = () => ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toThrow(UnresolvedError);
  });

  test('should report which keys resolved and which did not', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema: z.object({ model: z.string(), maxTokens: z.number() }),
      rules: { tenantId: { tenantA: { model: 'gpt-5' } } },
    });

    // Act
    let error: UnresolvedError | undefined;
    try {
      ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });
    } catch (caught) {
      error = caught as UnresolvedError;
    }

    // Assert
    expect(error?.resolved).toEqual(['model']);
    expect(error?.unresolved).toEqual(['maxTokens']);
    expect(error?.context).toEqual({ tenantId: 'tenantA', serviceTier: 'free' });
    expect(error?.message).toContain('"maxTokens"');
    expect(error?.cause).toBeDefined();
  });

  test('should not reinterpret a schema failure that is not about a missing key', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema: z.object({ model: z.string().min(5) }),
      rules: { tenantId: { tenantA: { model: 'ab' } } },
    });

    // Act
    let error: unknown;
    try {
      ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });
    } catch (caught) {
      error = caught;
    }

    // Assert
    expect(error).toBeInstanceOf(SchemaError);
    expect(error).not.toBeInstanceOf(UnresolvedError);
    expect((error as SchemaError).issues.length).toBe(1);
  });

  test('should branch on an optional identifier that is absent from the context', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        model: 'root',
        hasPremium: {
          true: { model: 'premium' },
        },
      },
    });

    // Act
    const result = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toEqual({ model: 'root', temperature: 1 });
  });

  test('should throw when the result schema validates asynchronously', () => {
    // Arrange
    const properties = { type: 'object', properties: { model: { type: 'string' } } };
    const asyncSchema: ObjectSchema<{ model: string }> = {
      '~standard': {
        version: 1,
        vendor: 'async',
        validate: (value) => Promise.resolve({ value: value as { model: string } }),
        jsonSchema: {
          input: () => properties,
          output: () => properties,
        },
      },
    };
    const ruleset = createRuleset({
      contextSchema,
      resultSchema: asyncSchema,
      rules: { model: 'a' },
    });

    // Act
    const result = () => ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'free' });

    // Assert
    expect(result).toThrow(TypeError);
  });
});

describe('schemas', () => {
  test('should throw when the context and the result share a key', () => {
    // Arrange
    const clashing = z.object({ tenantId: z.string(), model: z.string() });

    // Act
    const result = () =>
      createRuleset({
        contextSchema: clashing as never,
        resultSchema,
        rules: {},
      });

    // Assert
    expect(result).toThrow();
  });

  test('should work with any Standard + JSON Schema library, not only zod', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema: type({ tenantId: 'string', serviceTier: "'free' | 'premium'" }),
      resultSchema: type({ model: "string = 'small'", temperature: 'number = 1' }),
      rules: {
        tenantId: {
          tenantA: { temperature: 0.5, serviceTier: { premium: { model: 'large' } } },
        },
      },
    });

    // Act
    const premium = ruleset.resolve({ tenantId: 'tenantA', serviceTier: 'premium' });
    const missing = ruleset.resolve({ tenantId: 'nobody', serviceTier: 'free' });

    // Assert
    expect(premium).toEqual({ model: 'large', temperature: 0.5 });
    expect(missing).toEqual({ model: 'small', temperature: 1 });
  });

  test('should throw when a schema does not describe an object', () => {
    // Arrange
    const notAnObject = z.string();

    // Act
    const result = () =>
      createRuleset({
        contextSchema: notAnObject as never,
        resultSchema,
        rules: {},
      });

    // Assert
    expect(result).toThrow(TypeError);
  });
});

describe('options', () => {
  test('should expose the options it was created with', () => {
    // Arrange
    const rules = { tenantId: { tenantA: { model: 'a' } } };
    const options = { contextSchema, resultSchema, rules };

    // Act
    const ruleset = createRuleset(options);

    // Assert
    expect(ruleset.options).toBe(options);
    expect(ruleset.options.rules).toBe(rules);
  });
});

describe('explain', () => {
  test('should list the cascade of every result key', () => {
    // Arrange
    const ruleset = createRuleset({
      contextSchema,
      resultSchema,
      rules: {
        tenantId: {
          tenantA: {
            model: 'tenant',
            serviceTier: {
              premium: { model: 'tenant-tier' },
            },
          },
        },
      },
    });

    // Act
    const result = ruleset.explain({ tenantId: 'tenantA', serviceTier: 'premium' });

    // Assert
    expect(result).toBe(
      [
        'model:',
        '  tenantId=tenantA > serviceTier=premium (2,2,2) -> tenant-tier',
        '  tenantId=tenantA (1,1,1) -> tenant [overridden]',
        'temperature:',
        '  :schema',
        '=> {"model":"tenant-tier","temperature":1}',
      ].join('\n'),
    );
  });
});
