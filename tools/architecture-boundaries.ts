/**
 * Architectural boundary validation, through the TypeScript compiler API.
 *
 * ## Why this replaced a grep
 *
 * The first version of this file matched `/from\s+['"]pg['"]/` against file
 * text. Three things a grep cannot do, and each one is a rule this repository
 * actually depends on:
 *
 *   - **Tell an import from a mention.** `import type { D1Database }` is a
 *     type-only edge that vanishes at runtime; `import { createPostgresD1 }`
 *     is a real dependency. A grep counts both, so the rule had to be written
 *     loosely enough to let the first through — which let the second through
 *     too.
 *   - **See through a re-export.** `export * from './provisioning/index.js'`
 *     is how `packages/domain` publishes its surface. A grep reading
 *     `index.ts` sees no `pg`; the compiler follows the edge.
 *   - **Report more than the first hit.** A grep-and-exit tells you about one
 *     violation per run, so a branch that broke four boundaries takes four
 *     round trips through CI to find out.
 *
 * The compiler API is already a dependency (`typescript@5.6.3`, root
 * devDependency) and `tsx` is already a runtime dependency of every app. No
 * new package.
 *
 * ## What it does
 *
 * Parses every `.ts`/`.tsx` under the configured roots with
 * `ts.createSourceFile`, walks the AST for every module-level specifier —
 * `import`, `export … from`, `import type`, and `import()` in type position —
 * and asks each rule whether that edge is allowed.
 *
 * It does NOT typecheck. A full program takes tens of seconds and would make
 * this the slowest job in the workflow for no gain: every rule here is about
 * WHICH module is reached, not what its type is. `pnpm typecheck` is the job
 * that answers the other question.
 *
 * ## Output contract
 *
 *   exit 0 — every rule clean
 *   exit 1 — at least one violation; EVERY violation is printed, grouped by
 *            rule, with `file:line:col` so an editor can jump to it.
 *
 * Run it directly:
 *
 *     pnpm exec tsx tools/architecture-boundaries.ts
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'test-results', 'playwright-report']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mts|cts)$/.test(path)) yield path;
  }
}

/**
 * Every module specifier this file depends on, with its position.
 *
 * `isTypeOnly` matters: a type-only edge disappears at runtime, so a rule
 * about *runtime* I/O must not fire on it, while a rule about layering
 * («packages must not know apps exist») applies to both.
 */
interface Edge {
  specifier: string;
  line: number;
  col: number;
  isTypeOnly: boolean;
}

function edgesOf(file: string, text: string): Edge[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: Edge[] = [];

  const push = (spec: ts.Expression | undefined, typeOnly: boolean, node: ts.Node): void => {
    if (spec === undefined || !ts.isStringLiteral(spec)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ specifier: spec.text, line: line + 1, col: character + 1, isTypeOnly: typeOnly });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // `import type { X } from 'y'` — whole clause is type-only.
      // `import { type X } from 'y'` — individual specifiers are; treated as
      // a value import, because at least one value binding may sit beside it.
      const typeOnly = node.importClause?.isTypeOnly === true;
      push(node.moduleSpecifier, typeOnly, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // `export * from './x.js'` and `export { a } from './x.js'` are real
      // edges: a re-export makes this module's consumers depend on the target.
      push(node.moduleSpecifier, node.isTypeOnly, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) push(ref.expression, false, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // Dynamic `import('x')` — a runtime edge.
      push(node.arguments[0], false, node);
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import('x')` in a type position — type-only.
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ specifier: arg.literal.text, line: line + 1, col: character + 1, isTypeOnly: true });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// Classifying a file
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slashed, so rules read the same on every platform. */
function rel(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/');
}

/**
 * Whether this file is test-only.
 *
 * Test code is allowed edges production code is not: a domain test may open a
 * Postgres to prove a query, and a bot test may import `@shikoo/db` to build a
 * fixture. Applying the production rules to tests would produce false
 * positives that teach people to widen the rule rather than fix the code —
 * which is how a boundary check stops meaning anything.
 *
 * Deliberately narrow: a `src/` file named `foo.test.ts` would still be test
 * code, but a file named `testHelpers.ts` inside `src/` would NOT be, because
 * it ships in the production image.
 */
function isTestFile(path: string): boolean {
  return (
    /(^|\/)test\//.test(path) ||
    /(^|\/)e2e\//.test(path) ||
    /\.(test|spec)\.tsx?$/.test(path) ||
    /(^|\/)tools\//.test(path) ||
    /(^|\/)scripts\//.test(path)
  );
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

interface Violation {
  rule: string;
  file: string;
  line: number;
  col: number;
  detail: string;
}

interface Rule {
  name: string;
  /** Why this boundary exists, printed once when the rule reports anything. */
  because: string;
  /** Which files the rule applies to, repo-relative. */
  applies: (path: string) => boolean;
  /** Return a reason string to report a violation, or null to allow. */
  check: (edge: Edge, path: string) => string | null;
}

const under = (...prefixes: string[]) => (p: string) => prefixes.some((x) => p.startsWith(x));

/** Node built-ins that perform I/O. `node:crypto` is not one of them. */
const IO_BUILTINS = /^node:(fs|fs\/promises|net|tls|http|https|http2|dgram|child_process|worker_threads|cluster|dns|readline|repl|v8|vm|inspector)$/;

/** Third-party I/O clients. */
const IO_PACKAGES = /^(pg|pg-pool|mysql2?|axios|undici|node-fetch|got|superagent|ioredis|redis)(\/|$)/;

const RULES: Rule[] = [
  {
    name: 'domain-is-io-free',
    because:
      'packages/domain is pure business logic. Every I/O dependency is injected — `provider.fetch`, a `D1Database` handle — so the same code runs in a test with no network and in production with one. An import here is a dependency the caller cannot substitute.',
    applies: under('packages/domain/src/'),
    check: (edge) => {
      // Type-only edges vanish at runtime. `import type { D1Database } from
      // '@shikoo/database'` is the shape of an injected handle, not a way to
      // open one.
      if (edge.isTypeOnly) return null;
      if (IO_BUILTINS.test(edge.specifier)) return `runtime import of ${edge.specifier}`;
      if (IO_PACKAGES.test(edge.specifier)) return `runtime import of ${edge.specifier}`;
      if (/^@shikoo\/db(\/|$)/.test(edge.specifier)) {
        return 'runtime import of @shikoo/db — the Postgres adapter. Take a `D1Database` as a parameter instead.';
      }
      return null;
    },
  },
  {
    name: 'contracts-is-pure',
    because:
      'packages/contracts is the shared type and validation surface. It is imported by the browser bundle, so a `node:` import there is a build failure in `apps/admin-web` rather than a design opinion.',
    applies: under('packages/contracts/src/'),
    check: (edge) => {
      if (edge.isTypeOnly) return null;
      if (/^node:/.test(edge.specifier)) return `node: import (${edge.specifier}) reaches the browser bundle`;
      if (IO_PACKAGES.test(edge.specifier)) return `I/O package ${edge.specifier}`;
      if (/^@shikoo\/(db|database|domain)(\/|$)/.test(edge.specifier)) {
        return `${edge.specifier} — contracts sits below every other package and must not depend on one`;
      }
      return null;
    },
  },
  {
    name: 'database-is-pure',
    because:
      'packages/database holds row shapes and SQL fragments as constants. The adapter that executes them is @shikoo/db. Keeping the two apart is what lets a test build a statement without opening a connection.',
    applies: under('packages/database/src/'),
    check: (edge) => {
      if (edge.isTypeOnly) return null;
      if (IO_BUILTINS.test(edge.specifier)) return `runtime import of ${edge.specifier}`;
      if (IO_PACKAGES.test(edge.specifier)) return `runtime import of ${edge.specifier}`;
      return null;
    },
  },
  {
    name: 'packages-do-not-import-apps',
    because:
      'The dependency arrow points from apps to packages. A package that reaches back into an app cannot be reused by the other three, and makes the build order a cycle.',
    applies: under('packages/'),
    check: (edge) => {
      // Applies to type-only edges too: knowing an app's types is still
      // knowing the app exists.
      if (/^@shikoo\/(bot|dashboard|dashboard-worker|admin-web|ingest)(\/|$)/.test(edge.specifier)) {
        return `package imports application ${edge.specifier}`;
      }
      if (/(^|\/)\.\.\/\.\.\/apps\//.test(edge.specifier) || edge.specifier.includes('/apps/')) {
        return `package reaches into apps/ by relative path: ${edge.specifier}`;
      }
      return null;
    },
  },
  {
    name: 'spa-does-not-reach-the-database',
    because:
      'apps/admin-web is a browser bundle. Importing the Postgres adapter would put `pg` — and every credential path it opens — into JavaScript served to a browser. `@shikoo/contracts` is the only shared package it may use.',
    applies: under('apps/admin-web/src/'),
    check: (edge) => {
      if (/^@shikoo\/(db|database|domain|seed|migrate)(\/|$)/.test(edge.specifier)) {
        return `SPA imports ${edge.specifier}`;
      }
      if (edge.isTypeOnly) return null;
      if (/^node:/.test(edge.specifier)) return `SPA imports ${edge.specifier}`;
      if (IO_PACKAGES.test(edge.specifier)) return `SPA imports ${edge.specifier}`;
      return null;
    },
  },
  {
    name: 'sql-stays-in-the-database-layer',
    because:
      'SQL belongs to `packages/database` (as constants), `packages/db` (the adapter), `packages/domain` and the app route files that own a query. What must never happen is a NEW module type growing its own SQL: the SPA, the contracts package, or the seed guards.',
    applies: under('apps/admin-web/src/', 'packages/contracts/src/'),
    check: (_edge, _path) => null, // specifier-level rule cannot see SQL; handled by textual rule below
  },
  {
    name: 'no-cloudflare-runtime',
    because:
      'The platform left Workers and D1 on 2026-08-17 and runs Node 22 against Postgres. A Cloudflare import coming back means the next deploy target is wrong, and the gate must say so before the image is built.',
    applies: under('apps/', 'packages/'),
    check: (edge) => {
      if (/^(cloudflare:|@cloudflare\/|wrangler(\/|$)|workers-types)/.test(edge.specifier)) {
        return `Cloudflare/Workers dependency: ${edge.specifier}`;
      }
      return null;
    },
  },
  {
    name: 'legacy-is-never-imported',
    because:
      'legacy/mirzabot-php is read-only reference code for the strangler migration, and it is git-ignored. Importing it into production code would make the build depend on a directory that does not exist in a fresh clone.',
    applies: under('apps/', 'packages/', 'tools/'),
    check: (edge) => {
      if (/(^|\/)legacy\//.test(edge.specifier)) return `imports from legacy/: ${edge.specifier}`;
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// A textual rule the AST cannot express: raw SQL outside the approved layer.
//
// SQL is a string, not an import, so the compiler API has nothing to say about
// it. The check is narrow on purpose — it looks for a statement keyword at the
// start of a template literal, which is how every query in this repository is
// written — and it applies ONLY to the two places that must never grow one.
// ---------------------------------------------------------------------------

/**
 * A statement, not a word, and only inside a real string.
 *
 * Two false positives were found writing this, and both taught the same
 * lesson. Matching `` `SELECT `` against raw file text reported
 * `aria-label={`Select declined income ${id}`}` — English prose starting
 * with the same five letters. Requiring the `FROM` clause fixed that one and
 * then matched a JSDoc paragraph containing the words «update» and «Set»
 * eleven lines apart.
 *
 * So the scan walks the AST and looks only at STRING and TEMPLATE literal
 * nodes. A comment is not a node; prose in a doc block cannot be reported at
 * all, which is the correct answer rather than a tuned-down one.
 *
 * The patterns still require the clause that makes a statement a statement —
 * a `SELECT` needs its `FROM`, an `UPDATE` needs its `SET` — because a
 * user-facing string may legitimately contain one of those words on its own.
 */
const SQL_STATEMENTS: readonly RegExp[] = [
  /\bSELECT\b[\s\S]{0,400}?\bFROM\b/i,
  /\bINSERT\s+INTO\b[\s\S]{0,400}?\b(VALUES|SELECT)\b/i,
  /\bUPDATE\b[\s\S]{0,200}?\bSET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(TABLE|(UNIQUE\s+)?INDEX|TRIGGER)\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(TABLE|INDEX|TRIGGER)\b/i,
  /\bTRUNCATE\s+\w/i,
];

const SQL_FORBIDDEN_ROOTS = ['apps/admin-web/src/', 'packages/contracts/src/'];

function sqlViolations(path: string, text: string): Violation[] {
  if (!SQL_FORBIDDEN_ROOTS.some((r) => path.startsWith(r))) return [];

  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];

  const report = (node: ts.Node, literal: string): void => {
    for (const pattern of SQL_STATEMENTS) {
      const m = pattern.exec(literal);
      if (m === null) continue;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({
        rule: 'sql-stays-in-the-database-layer',
        file: path,
        line: line + 1,
        col: 1,
        detail: `SQL in a module that must not carry any: ${m[0].replace(/\s+/g, ' ').slice(0, 60)}…`,
      });
      return;
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      report(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      // `SELECT ... ${id} ... FROM x` — the interpolations are dropped and
      // the fixed spans joined, so a statement split across a substitution is
      // still seen as one.
      const joined = node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ');
      report(node, joined);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const ROOTS = ['apps', 'packages', 'tools'];

const violations: Violation[] = [];
let filesScanned = 0;
let edgesScanned = 0;

for (const rootName of ROOTS) {
  for (const abs of walk(join(ROOT, rootName))) {
    const path = rel(abs);
    const text = readFileSync(abs, 'utf8');
    filesScanned++;

    // Test code gets the layering rules but not the purity rules — see
    // `isTestFile`. The two rules that apply to everything are the ones about
    // reaching somewhere that should not exist at all.
    const testOnly = isTestFile(path);

    const edges = edgesOf(abs, text);
    edgesScanned += edges.length;

    for (const rule of RULES) {
      if (!rule.applies(path)) continue;
      // Purity rules are about what ships. Layering rules are about what the
      // repository is allowed to know.
      const isLayering =
        rule.name === 'packages-do-not-import-apps' ||
        rule.name === 'no-cloudflare-runtime' ||
        rule.name === 'legacy-is-never-imported';
      if (testOnly && !isLayering) continue;

      for (const edge of edges) {
        const detail = rule.check(edge, path);
        if (detail !== null) {
          violations.push({ rule: rule.name, file: path, line: edge.line, col: edge.col, detail });
        }
      }
    }

    if (!testOnly) violations.push(...sqlViolations(path, text));
  }
}

if (violations.length > 0) {
  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  for (const [name, list] of byRule) {
    const rule = RULES.find((r) => r.name === name);
    console.error(`\n✗ ${name}  (${list.length})`);
    if (rule) console.error(`  ${rule.because}\n`);
    for (const v of list) console.error(`  ${v.file}:${v.line}:${v.col}  ${v.detail}`);
  }
  console.error(
    `\n${violations.length} boundary violation(s) across ${byRule.size} rule(s).\n` +
      `Scanned ${filesScanned} files, ${edgesScanned} module edges.`,
  );
  process.exit(1);
}

console.log(
  `Architecture boundaries: ${RULES.length} rules, 0 violations ` +
    `(${filesScanned} files, ${edgesScanned} module edges).`,
);