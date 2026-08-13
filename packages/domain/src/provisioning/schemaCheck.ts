/**
 * Asking the panel what it actually accepts.
 *
 * This exists because of one wrong sentence. I recorded that the shape of
 * Marzban's `expire` field "can only be settled on a real panel", and it could
 * not — `legacy/` answered it, differently per operation, and reading it found
 * a real bug in our renewal. But the next such question will not always have a
 * PHP answer: the legacy bot does not send `note` on an extend, so nothing in
 * `legacy/` says whether a panel keeps it — and the once-only guard on renewal
 * reads it back.
 *
 * Marzban serves its own OpenAPI document. That document is the panel stating,
 * in writing, what it takes. Reading it is a GET, touches no account, and
 * settles this class of question for every field at once instead of one smoke
 * test per doubt.
 *
 * What is compared is not a hand-written list of fields — that would be a
 * second copy of the adapter, drifting from the first. The caller runs the
 * adapter against a recording `fetch`, hands over the bodies it actually
 * produced, and every field in them is checked. What is verified is therefore
 * what is sent, by construction.
 */

/** The subset of an OpenAPI document this needs. Everything else is ignored. */
export interface OpenApiDocument {
  components?: { schemas?: Record<string, unknown> };
}

export type Verdict =
  /** The panel declares this field and our type is among the ones it allows. */
  | 'ok'
  /** Declared, but not as the type we send. This is the one that breaks things. */
  | 'type-mismatch'
  /** Not declared at all. Usually ignored by the panel — so a field we rely on
   *  being stored (`note`) landing here is a silent failure, not a loud one. */
  | 'not-in-schema'
  /** Declared with no usable type — `{}`, a bare `$ref`, an empty `anyOf`.
   *  Reported rather than guessed at. */
  | 'undeclared-type';

export interface FieldReport {
  field: string;
  /** The JSON type name for the value the adapter produced. */
  sends: string;
  /** Every type the panel says it accepts, or an empty list. */
  accepts: string[];
  verdict: Verdict;
}

export interface SchemaReport {
  /** The component that was inspected, e.g. `UserCreate`. */
  schema: string;
  /** True when the document has no such component at all. */
  missing: boolean;
  fields: FieldReport[];
}

/** The JSON Schema type name for a value we are about to send. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Every type a property node allows.
 *
 * Walks `anyOf`, `oneOf` and `allOf` because that is how a nullable field is
 * spelled in OpenAPI 3.1 (`anyOf: [{type: integer}, {type: null}]`) and how
 * Marzban spells one that takes either a timestamp or a date string. A `$ref`
 * contributes nothing and is deliberately not followed: a field of ours that
 * resolves to a named object type is not something this check can rule on, and
 * saying so beats resolving it badly.
 */
export function declaredTypes(property: unknown): string[] {
  if (property === null || typeof property !== 'object') return [];
  const node = property as Record<string, unknown>;
  const found = new Set<string>();

  const type = node['type'];
  if (typeof type === 'string') found.add(type);
  // OpenAPI 3.1 allows a list here.
  if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') found.add(t);
  // 3.0's way of saying the same thing.
  if (node['nullable'] === true) found.add('null');

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const child of branch) for (const t of declaredTypes(child)) found.add(t);
    }
  }
  return [...found];
}

/**
 * `integer` satisfies `number`, and a date string satisfies `string`.
 *
 * The first direction only: a panel that accepts `number` accepts our integer,
 * but one that accepts only `integer` does not accept 1.5 — and `expire` in
 * seconds is exactly where that would matter.
 */
function accepted(sends: string, accepts: string[]): boolean {
  if (accepts.includes(sends)) return true;
  return sends === 'integer' && accepts.includes('number');
}

/**
 * Checks one request body against one schema component.
 *
 * A body field the schema does not mention is reported rather than passed over.
 * Most panels ignore an unknown field silently, which is precisely why it needs
 * saying out loud: the request still succeeds and the value is simply gone.
 */
export function checkBody(
  doc: OpenApiDocument,
  schemaName: string,
  body: Record<string, unknown>,
): SchemaReport {
  const schema = doc.components?.schemas?.[schemaName];
  if (schema === undefined || schema === null || typeof schema !== 'object') {
    return { schema: schemaName, missing: true, fields: [] };
  }
  const properties = (schema as { properties?: unknown }).properties;
  const props =
    properties !== null && typeof properties === 'object'
      ? (properties as Record<string, unknown>)
      : {};

  const fields = Object.entries(body).map(([field, value]): FieldReport => {
    const sends = jsonTypeOf(value);
    if (!(field in props)) return { field, sends, accepts: [], verdict: 'not-in-schema' };
    const accepts = declaredTypes(props[field]);
    if (accepts.length === 0) return { field, sends, accepts, verdict: 'undeclared-type' };
    return { field, sends, accepts, verdict: accepted(sends, accepts) ? 'ok' : 'type-mismatch' };
  });

  return { schema: schemaName, missing: false, fields };
}

/** True when nothing in the report needs a person to look at it. */
export function isClean(reports: SchemaReport[]): boolean {
  return reports.every((r) => !r.missing && r.fields.every((f) => f.verdict === 'ok'));
}

/** A fixed-width table, because this is read in a terminal by a person. */
export function formatReport(reports: SchemaReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`── ${report.schema} ${'─'.repeat(Math.max(0, 56 - report.schema.length))}`);
    if (report.missing) {
      lines.push('   this panel does not declare that schema at all');
      lines.push('');
      continue;
    }
    const width = Math.max(5, ...report.fields.map((f) => f.field.length));
    for (const f of report.fields) {
      const mark = f.verdict === 'ok' ? ' ' : '!';
      lines.push(
        `${mark}  ${f.field.padEnd(width)}  we send ${f.sends.padEnd(8)}  ` +
          `panel takes ${f.accepts.length === 0 ? '—' : f.accepts.join(' | ')}` +
          (f.verdict === 'ok' ? '' : `   <- ${f.verdict}`),
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
