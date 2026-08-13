/**
 * Reading a panel's own schema, offline.
 *
 * The fixture below is shaped like the parts of a real Marzban OpenAPI
 * document this touches — nullable spelled two ways, a union, a `$ref` — rather
 * than like whatever would make the code pass. Every case here is one the
 * checker has to get right to be worth running against a panel at all.
 */

import { describe, expect, it } from 'vitest';
import {
  checkBody,
  declaredTypes,
  formatReport,
  isClean,
  jsonTypeOf,
  type OpenApiDocument,
} from '../src/index.js';

const DOC: OpenApiDocument = {
  components: {
    schemas: {
      UserCreate: {
        properties: {
          username: { type: 'string' },
          // 3.1's nullable, and the shape Marzban uses for a field that takes
          // either a timestamp or a date string.
          expire: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
          // 3.0's nullable.
          data_limit: { type: 'integer', nullable: true },
          note: { type: 'string', nullable: true },
          group_ids: { type: 'array' },
          data_limit_reset_strategy: { $ref: '#/components/schemas/ResetStrategy' },
          proxy_settings: { type: 'object' },
        },
      },
      UserModify: {
        properties: {
          expire: { type: 'integer' },
          data_limit: { type: 'integer' },
          // Deliberately absent: `note`. This is the real open question about
          // renewal, reproduced as a fixture.
        },
      },
    },
  },
};

describe('the type of a value we are about to send', () => {
  it('separates integer from number, because a panel does', () => {
    expect(jsonTypeOf(1)).toBe('integer');
    expect(jsonTypeOf(1.5)).toBe('number');
  });

  it('names null and array rather than calling both object', () => {
    expect(jsonTypeOf(null)).toBe('null');
    expect(jsonTypeOf([1, 2])).toBe('array');
    expect(jsonTypeOf({})).toBe('object');
    expect(jsonTypeOf('x')).toBe('string');
    expect(jsonTypeOf(true)).toBe('boolean');
  });
});

describe('what a property says it accepts', () => {
  it('reads a plain type', () => {
    expect(declaredTypes({ type: 'string' })).toEqual(['string']);
  });

  it('reads both spellings of nullable', () => {
    expect(declaredTypes({ type: 'integer', nullable: true }).sort()).toEqual(['integer', 'null']);
    expect(declaredTypes({ anyOf: [{ type: 'integer' }, { type: 'null' }] }).sort()).toEqual([
      'integer',
      'null',
    ]);
  });

  it('reads a 3.1 type list', () => {
    expect(declaredTypes({ type: ['string', 'null'] }).sort()).toEqual(['null', 'string']);
  });

  it('says nothing rather than guessing at a $ref', () => {
    // Following it would mean ruling on a named object type this check has no
    // business ruling on. Reporting "undeclared" sends it to a person instead.
    expect(declaredTypes({ $ref: '#/components/schemas/Whatever' })).toEqual([]);
    expect(declaredTypes({})).toEqual([]);
    expect(declaredTypes(null)).toEqual([]);
  });
});

describe('checking a request body against a schema', () => {
  it('passes a body whose every field lines up', () => {
    const report = checkBody(DOC, 'UserCreate', {
      username: 'u',
      expire: '2026-09-12T00:00:00.000Z',
      data_limit: 53_687_091_200,
      note: 'shikoo abc',
      group_ids: [1],
      proxy_settings: {},
    });

    expect(report.missing).toBe(false);
    expect(report.fields.every((f) => f.verdict === 'ok')).toBe(true);
    expect(isClean([report])).toBe(true);
  });

  it('catches the field a panel will silently drop', () => {
    // The whole reason this tool exists. `note` is not in UserModify, the PUT
    // still succeeds, and the once-only guard on renewal reads back a value
    // that was never stored.
    const report = checkBody(DOC, 'UserModify', {
      expire: 1_789_214_400,
      data_limit: 0,
      note: 'shikoo abc',
    });

    const note = report.fields.find((f) => f.field === 'note');
    expect(note?.verdict).toBe('not-in-schema');
    expect(isClean([report])).toBe(false);
  });

  it('catches sending a date string where seconds are declared', () => {
    // Exactly the bug that was live in renewal until the PHP was read.
    const report = checkBody(DOC, 'UserModify', { expire: '2026-09-12T00:00:00.000Z' });

    expect(report.fields[0]).toMatchObject({
      field: 'expire',
      sends: 'string',
      verdict: 'type-mismatch',
    });
  });

  it('lets an integer satisfy a field declared as number, but not the reverse', () => {
    const doc: OpenApiDocument = {
      components: { schemas: { S: { properties: { a: { type: 'number' } } } } },
    };
    expect(checkBody(doc, 'S', { a: 5 }).fields[0]?.verdict).toBe('ok');

    const strict: OpenApiDocument = {
      components: { schemas: { S: { properties: { a: { type: 'integer' } } } } },
    };
    expect(checkBody(strict, 'S', { a: 1.5 }).fields[0]?.verdict).toBe('type-mismatch');
  });

  it('reports a $ref field as undeclared rather than as a failure', () => {
    const report = checkBody(DOC, 'UserCreate', { data_limit_reset_strategy: 'no_reset' });

    expect(report.fields[0]?.verdict).toBe('undeclared-type');
  });

  it('says so when the panel has no such schema at all', () => {
    const report = checkBody(DOC, 'UserNonsense', { a: 1 });

    expect(report).toMatchObject({ missing: true, fields: [] });
    expect(isClean([report])).toBe(false);
  });
});

describe('the report a person reads', () => {
  it('marks only the lines that need attention', () => {
    const text = formatReport([
      checkBody(DOC, 'UserModify', { expire: 1, data_limit: 0, note: 'x' }),
    ]);

    expect(text).toContain('not-in-schema');
    expect(text).toContain('note');
    // The lines that are fine carry no marker, so the eye lands on the others.
    const noteLine = text.split('\n').find((l) => l.includes('note'));
    expect(noteLine?.startsWith('!')).toBe(true);
    const expireLine = text.split('\n').find((l) => l.includes('expire'));
    expect(expireLine?.startsWith('!')).toBe(false);
  });

  it('names a schema the panel does not have', () => {
    expect(formatReport([checkBody(DOC, 'UserNonsense', {})])).toContain('does not declare');
  });
});
