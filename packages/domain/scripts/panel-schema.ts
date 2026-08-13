/**
 * Ask a panel what it accepts, and compare that with what we send it.
 *
 *   corepack pnpm --filter @shikoo/domain panel:schema https://panel.example.com
 *
 * READ-ONLY, and structurally so: the only request that leaves this process is
 * a GET for the panel's own OpenAPI document. No login, no token, no account is
 * created, read, changed or deleted, and no customer data is touched. The
 * request bodies it checks are produced by running the real adapter against an
 * in-process fake — nothing it builds is ever sent anywhere.
 *
 * That last part is the point. A hand-written list of "the fields we send"
 * would be a second copy of `marzban.ts` and would drift from it the first time
 * somebody adds a field. Here the adapter itself produces the bodies, so what
 * is checked is what is sent.
 *
 * Exit code is 0 when every field lines up and 1 when a person needs to look,
 * so this can sit in front of a release without anybody reading it.
 */

import {
  checkBody,
  formatReport,
  isClean,
  marzbanAdapter,
  type OpenApiDocument,
  type ProviderContext,
  type SchemaReport,
} from '../src/index.js';

const NOW = Date.now();

/**
 * A panel that answers nothing and records everything. Never reaches a network.
 *
 * `exists` decides what the lookup says, and both adapters need a different
 * answer: `provision` returns the account it finds instead of creating one, so
 * a create probe has to be told the account is absent, while `renew` refuses
 * outright on an account that is not there. Getting this wrong does not
 * misreport — it produces no body at all, which is what the caller checks for.
 */
function recorder(exists: boolean): {
  bodies: Record<string, unknown>[];
  fetch: typeof globalThis.fetch;
} {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'recording' }), { status: 200 });
    }
    if (url.endsWith('/reset')) return new Response('{}', { status: 200 });
    if (method === 'GET') {
      // Unmetered and never expiring, so `renew` takes its ordinary path.
      return exists
        ? new Response(JSON.stringify({ username: 'probe', expire: 0, data_limit: 0 }), {
            status: 200,
          })
        : new Response('{}', { status: 404 });
    }
    if (typeof init?.body === 'string' && init.body.startsWith('{')) {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(JSON.stringify({ username: 'probe' }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch: fetchImpl };
}

function context(fetchImpl: typeof globalThis.fetch): ProviderContext {
  return {
    id: 0,
    code: 'probe',
    name: 'probe',
    baseUrl: 'https://probe.invalid',
    credentials: { username: 'probe', password: 'probe' },
    // The same shape the live panels carry, so optional fields appear in the
    // body and get checked rather than being silently absent.
    config: { group_ids: [1], proxy_settings: { vless: {} } },
    fetch: fetchImpl,
  };
}

/** The body `provision` builds, taken from the adapter rather than retyped. */
async function createBody(): Promise<Record<string, unknown>> {
  const rec = recorder(false);
  await marzbanAdapter.provision(
    {
      username: 'probe',
      volumeGb: 50,
      durationDays: 30,
      note: 'shikoo probe',
      providerConfig: { group_ids: [1], proxy_settings: { vless: {} } },
      planAttrs: {},
      expiresAt: new Date(NOW + 30 * 86_400_000),
    },
    context(rec.fetch),
  );
  const body = rec.bodies[0];
  if (!body) throw new Error('the adapter sent no create body — has provision changed?');
  return body;
}

/** The body `renew` builds. */
async function modifyBody(): Promise<Record<string, unknown>> {
  const rec = recorder(true);
  await marzbanAdapter.renew!(
    {
      username: 'probe',
      volumeGb: 50,
      durationDays: 30,
      note: 'shikoo probe',
      providerConfig: {},
      planAttrs: {},
      mode: 'RESET',
      renewFrom: new Date(NOW),
    },
    context(rec.fetch),
  );
  const body = rec.bodies[0];
  if (!body) throw new Error('the adapter sent no modify body — has renew changed?');
  return body;
}

async function main(): Promise<number> {
  const base = process.argv[2]?.replace(/\/+$/, '');
  if (!base) {
    console.error('usage: panel-schema <panel base url>');
    console.error('reads <base>/openapi.json. Read-only: no login, no account touched.');
    return 2;
  }

  const url = `${base}/openapi.json`;
  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`panel would not serve its schema (HTTP ${res.status})`);
    // Not a failure of ours. Some deployments put the docs behind auth or off.
    return 2;
  }
  const doc = (await res.json()) as OpenApiDocument;

  const reports: SchemaReport[] = [
    checkBody(doc, 'UserCreate', await createBody()),
    checkBody(doc, 'UserModify', await modifyBody()),
  ];

  console.log('');
  console.log(formatReport(reports));

  if (isClean(reports)) {
    console.log('every field we send is declared, with a type this panel accepts.');
    return 0;
  }
  console.log('lines marked ! need a person. `not-in-schema` is the quiet one:');
  console.log('the request still succeeds and the value is simply dropped.');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
