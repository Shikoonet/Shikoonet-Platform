/**
 * A PasarGuard panel that answers, for a machine with no panel.
 *
 * The deferral ledger called this "the fake panel", and its job is narrow: let
 * the delivery, renewal, sync and service-action paths run end to end offline,
 * so a change can be walked in a browser instead of argued about.
 *
 * What it is NOT is evidence of the real panel's shape. It answers what our
 * adapter sends, so agreement between the two proves only that we are
 * consistent with ourselves — rule 6. The shapes here come from the live PHP
 * (`Marzban.php`, `panels.php`), which is the one outside source we have while
 * the real panel's `/openapi.json` is switched off.
 *
 *   node sim/fake-panel.mjs [port]        # default 8790
 *
 * State is in memory: restart it and every account is gone. That is deliberate
 * — a fake with a database is a second database to keep in step.
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8790);
const TOKEN = 'fake-panel-token';
const BASE = `http://127.0.0.1:${PORT}`;

/** username -> user object, in the shape the adapter reads. */
const users = new Map();

let subCounter = 0;
function newSubUrl(username) {
  subCounter += 1;
  // A revoke must produce a *different* link, which is the whole point of it.
  return `/sub/${encodeURIComponent(username)}/${subCounter}`;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // POST /api/admin/token — form encoded, like the real one.
  if (method === 'POST' && path === '/api/admin/token') {
    return json(res, 200, { access_token: TOKEN, token_type: 'bearer' });
  }

  // Everything else needs the bearer. Answering 401 rather than ignoring it is
  // the point: a credentials bug should look like a credentials bug here too.
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
    return json(res, 401, { detail: 'Not authenticated' });
  }

  if (method === 'GET' && path === '/api/users') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const all = [...users.values()];
    return json(res, 200, { users: all.slice(offset, offset + limit), total: all.length });
  }

  if (method === 'POST' && path === '/api/user') {
    const body = await readJson(req);
    const username = String(body.username ?? '');
    if (username.length === 0) return json(res, 422, { detail: 'username is required' });
    // Creating one that exists is a conflict, exactly as the real panel does —
    // which is why the adapter looks it up first.
    if (users.has(username)) return json(res, 409, { detail: 'user already exists' });
    const user = {
      username,
      status: 'active',
      data_limit: body.data_limit ?? 0,
      expire: body.expire ?? null,
      note: body.note ?? '',
      used_traffic: 0,
      subscription_url: newSubUrl(username),
      group_ids: body.group_ids ?? [],
      proxy_settings: body.proxy_settings ?? {},
    };
    users.set(username, user);
    return json(res, 200, user);
  }

  const single = /^\/api\/user\/([^/]+)(\/revoke_sub|\/reset)?$/.exec(path);
  if (single) {
    const username = decodeURIComponent(single[1]);
    const suffix = single[2] ?? '';
    const user = users.get(username);
    if (!user) return json(res, 404, { detail: 'User not found' });

    if (method === 'GET' && suffix === '') return json(res, 200, user);

    if (method === 'POST' && suffix === '/revoke_sub') {
      user.subscription_url = newSubUrl(username);
      return json(res, 200, user);
    }

    if (method === 'POST' && suffix === '/reset') {
      user.used_traffic = 0;
      return json(res, 200, user);
    }

    if (method === 'PUT' && suffix === '') {
      const body = await readJson(req);
      // Only the fields the adapter sends. Anything else is not exercised, and
      // accepting it silently would make this fake friendlier than the real one.
      if (body.status !== undefined) user.status = String(body.status);
      if (body.data_limit !== undefined) user.data_limit = body.data_limit;
      if (body.expire !== undefined) user.expire = body.expire;
      if (body.note !== undefined) user.note = body.note;
      return json(res, 200, user);
    }
  }

  // A subscription link that actually resolves, so a walkthrough can tap it.
  if (method === 'GET' && path.startsWith('/sub/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`# fake config for ${path}\n`);
  }

  return json(res, 404, { detail: 'Not Found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake PasarGuard panel on ${BASE} — any admin/password works`);
});
