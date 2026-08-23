/**
 * Making, changing and deleting a group on the panel — the product tier itself.
 *
 * Every shape asserted here was measured against the live PasarGuard test panel
 * on 2026-08-23 before a line of the adapter was written, because three of them
 * are not guessable from the rest of the API and each wrong guess is silent:
 *
 *   POST   /api/group        201   — the PLURAL answers 405, two lines under a
 *                                    `GET /api/groups` that is plural.
 *   PUT    /api/group/{id}   200   — a FULL replacement. A body carrying only
 *                                    `{is_disabled: true}` answers
 *                                    `422 {"detail":{"name":"Field required"}}`,
 *                                    the exact opposite of `PUT /api/user/{u}`,
 *                                    which IS a partial update.
 *   DELETE /api/group/{id}   204   — no body.
 *   GET    /api/inbounds     200   — a bare array of tag STRINGS, not objects.
 *
 * The fake below answers those statuses and those shapes. It is a fake precisely
 * so this file can assert the failures too: a panel that refuses, a panel that
 * answers a shape nobody expected, a host listing that times out. None of those
 * are reproducible on demand against a real panel, and every one of them decides
 * what an operator is told.
 */

import { describe, expect, it } from 'vitest';
import { marzbanAdapter, type ProviderContext } from '../src/index.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Group {
  id: number;
  name: string;
  inbound_tags: string[];
  is_disabled: boolean;
  total_users: number;
}

/**
 * A panel with groups, inbounds and hosts.
 *
 * `hostFor` is which inbound tags carry an enabled host, and it is a separate
 * knob from `inbounds` on purpose: the gap between the two is the bug this
 * whole feature exists around — an inbound with no host is in every listing,
 * counts toward every total, and hands the customer nothing.
 */
function fakePanel(options: {
  groups?: Group[];
  inbounds?: string[];
  hostFor?: string[];
  hostStatus?: number;
  refuseWrite?: { status: number; detail?: string };
  inboundsBody?: unknown;
} = {}) {
  const calls: Call[] = [];
  const groups: Group[] = [...(options.groups ?? [])];
  const inbounds = options.inbounds ?? ['Shadowsocks TCP', 'VLESS TCP 17846'];
  const hostFor = options.hostFor ?? inbounds;
  let nextId = Math.max(0, ...groups.map((g) => g.id)) + 1;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string' && body.startsWith('{')) body = JSON.parse(body);
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    calls.push({ url, method, body });

    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/api/inbounds')) {
      const payload = options.inboundsBody === undefined ? inbounds : options.inboundsBody;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/api/hosts')) {
      if (options.hostStatus !== undefined && options.hostStatus !== 200) {
        return new Response('{}', { status: options.hostStatus });
      }
      return new Response(
        JSON.stringify(
          inbounds.map((tag, i) => ({
            id: i + 1,
            inbound_tag: tag,
            is_disabled: !hostFor.includes(tag),
          })),
        ),
        { status: 200 },
      );
    }
    if (method === 'GET' && url.endsWith('/api/groups')) {
      return new Response(JSON.stringify({ groups, total: groups.length }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/api/group')) {
      if (options.refuseWrite) {
        return new Response(JSON.stringify({ detail: options.refuseWrite.detail }), {
          status: options.refuseWrite.status,
        });
      }
      const spec = body as { name: string; inbound_tags: string[] };
      // The real panel requires both fields and answers 422 without them. The
      // adapter always sends both, so a fake that accepted a partial body would
      // be agreeing with a mistake nobody can make here.
      if (typeof spec?.name !== 'string' || !Array.isArray(spec?.inbound_tags)) {
        return new Response(JSON.stringify({ detail: { name: 'Field required' } }), {
          status: 422,
        });
      }
      const row: Group = {
        id: nextId++,
        name: spec.name,
        inbound_tags: spec.inbound_tags,
        is_disabled: false,
        total_users: 0,
      };
      groups.push(row);
      return new Response(JSON.stringify(row), { status: 201 });
    }
    const put = /\/api\/group\/(\d+)$/.exec(url);
    if (put && method === 'PUT') {
      if (options.refuseWrite) {
        return new Response(JSON.stringify({ detail: options.refuseWrite.detail }), {
          status: options.refuseWrite.status,
        });
      }
      const spec = body as { name?: unknown; inbound_tags?: unknown };
      if (typeof spec?.name !== 'string' || !Array.isArray(spec?.inbound_tags)) {
        return new Response(JSON.stringify({ detail: { name: 'Field required' } }), {
          status: 422,
        });
      }
      const found = groups.find((g) => g.id === Number(put[1]));
      if (!found) return new Response(JSON.stringify({ detail: 'Group not found' }), { status: 404 });
      found.name = spec.name;
      found.inbound_tags = spec.inbound_tags as string[];
      return new Response(JSON.stringify(found), { status: 200 });
    }
    if (put && method === 'DELETE') {
      const at = groups.findIndex((g) => g.id === Number(put[1]));
      if (at < 0) return new Response('{}', { status: 404 });
      groups.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  return { calls, groups, fetchImpl };
}

function provider(fetchImpl: typeof globalThis.fetch): ProviderContext {
  return {
    id: 1,
    code: '7e7a',
    name: 'VIP',
    baseUrl: 'https://panel.example.com',
    credentials: { username: 'admin', password: 'p:ss:word' },
    config: { group_ids: [1] },
    fetch: fetchImpl,
  };
}

describe('listInbounds', () => {
  it('reads the bare array of strings the panel actually answers', async () => {
    // `GET /api/inbounds` → `["Shadowsocks TCP","VLESS TCP 17846"]`. Measured;
    // it is not a list of objects and it is not wrapped.
    const panel = fakePanel();
    const result = await marzbanAdapter.listInbounds!(provider(panel.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inbounds.map((i) => i.tag)).toEqual(['Shadowsocks TCP', 'VLESS TCP 17846']);
  });

  it('says which inbounds have no host, because those deliver nothing', async () => {
    // The whole reason this field exists. A tier built out of an unhosted
    // inbound costs more than the cheap one and hands the customer the same
    // thing, and nothing downstream ever complains.
    const panel = fakePanel({ hostFor: ['Shadowsocks TCP'] });
    const result = await marzbanAdapter.listInbounds!(provider(panel.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inbounds).toEqual([
      { tag: 'Shadowsocks TCP', hosted: true },
      { tag: 'VLESS TCP 17846', hosted: false },
    ]);
  });

  it('leaves `hosted` ABSENT when the host listing could not be read', async () => {
    // Absent, never false. "We could not ask" and "nothing delivers" are
    // different sentences, and only one of them should stop an operator from
    // building a tier.
    const panel = fakePanel({ hostStatus: 503 });
    const result = await marzbanAdapter.listInbounds!(provider(panel.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inbounds).toEqual([{ tag: 'Shadowsocks TCP' }, { tag: 'VLESS TCP 17846' }]);
  });

  it('treats an unreadable shape as an error, not as an empty panel', async () => {
    // Reporting "this panel has no inbounds" for "we could not parse the reply"
    // sends an operator to build a tier out of nothing.
    const panel = fakePanel({ inboundsBody: { unexpected: true } });
    const result = await marzbanAdapter.listInbounds!(provider(panel.fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('inbound listing');
  });
});

describe('createGroup', () => {
  it('POSTs the SINGULAR path with both required fields', async () => {
    // `/api/groups` — the plural, the one you would copy from the GET two lines
    // up — answers 405. Measured 2026-08-23.
    const panel = fakePanel();
    const result = await marzbanAdapter.createGroup!(provider(panel.fetchImpl), {
      name: 'پلاتینیوم',
      inboundTags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const call = panel.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/group'));
    expect(call).toBeDefined();
    expect(call!.body).toEqual({
      name: 'پلاتینیوم',
      inbound_tags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
    });
    expect(panel.calls.some((c) => c.url.endsWith('/api/groups') && c.method === 'POST')).toBe(
      false,
    );
  });

  it('returns the group the PANEL made, not the one we asked for', async () => {
    // The id is the panel's to assign, and so is the final tag list: a panel
    // that silently drops a tag it does not recognise produces a tier that
    // delivers less than it claims, and its reply is the only place that shows.
    const panel = fakePanel();
    const result = await marzbanAdapter.createGroup!(provider(panel.fetchImpl), {
      name: 'platinum',
      inboundTags: ['Shadowsocks TCP'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.id).toBe(1);
    expect(result.group.name).toBe('platinum');
    expect(result.group.inboundTags).toEqual(['Shadowsocks TCP']);
    expect(result.group.memberCount).toBe(0);
  });

  it('counts the deliverable inbounds of the group it just made', async () => {
    // So the screen can warn on the same breath as the create, rather than
    // after somebody has already priced the tier.
    const panel = fakePanel({ hostFor: ['Shadowsocks TCP'] });
    const result = await marzbanAdapter.createGroup!(provider(panel.fetchImpl), {
      name: 'platinum',
      inboundTags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.inboundTags).toHaveLength(2);
    expect(result.group.deliverableInbounds).toBe(1);
  });

  it('carries the panel’s own refusal message, and nothing else from the body', async () => {
    // `detail` is a validation string («Group already exists»). The rest of a
    // rejected body is not repeated: some deployments echo the submitted
    // credentials back in it, and this text reaches a browser.
    const panel = fakePanel({ refuseWrite: { status: 409, detail: 'Group already exists' } });
    const result = await marzbanAdapter.createGroup!(provider(panel.fetchImpl), {
      name: 'vip',
      inboundTags: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('409');
    expect(result.reason).toContain('Group already exists');
    expect(result.reason).not.toContain('p:ss:word');
  });
});

describe('updateGroup', () => {
  it('sends the WHOLE spec, because the panel rejects a partial one', async () => {
    // `PUT /api/group/{id}` with `{is_disabled: true}` alone answers
    // `422 {"detail":{"name":"Field required"}}` — measured. This is the
    // opposite of `PUT /api/user/{u}`, which is a genuine partial update, so
    // the two must not be reasoned about together.
    const panel = fakePanel({
      groups: [
        { id: 2, name: 'vip', inbound_tags: ['Shadowsocks TCP'], is_disabled: false, total_users: 1 },
      ],
    });
    const result = await marzbanAdapter.updateGroup!(provider(panel.fetchImpl), 2, {
      name: 'vip',
      inboundTags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const call = panel.calls.find((c) => c.method === 'PUT');
    expect(call!.url).toMatch(/\/api\/group\/2$/);
    expect(call!.body).toEqual({
      name: 'vip',
      inbound_tags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
    });
    expect(result.group.inboundTags).toEqual(['Shadowsocks TCP', 'VLESS TCP 17846']);
  });

  it('keeps the member count in the reply, since that is who the change reaches', async () => {
    // A PasarGuard subscription is resolved when it is fetched, so changing a
    // group's inbounds reaches everybody already in it on their next refresh.
    // The number belongs next to the button.
    const panel = fakePanel({
      groups: [
        { id: 2, name: 'vip', inbound_tags: [], is_disabled: false, total_users: 37 },
      ],
    });
    const result = await marzbanAdapter.updateGroup!(provider(panel.fetchImpl), 2, {
      name: 'vip',
      inboundTags: ['Shadowsocks TCP'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.group.memberCount).toBe(37);
  });

  it('reports a group the panel does not have rather than pretending', async () => {
    const panel = fakePanel({ groups: [] });
    const result = await marzbanAdapter.updateGroup!(provider(panel.fetchImpl), 42, {
      name: 'ghost',
      inboundTags: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('404');
  });
});

describe('deleteGroup', () => {
  it('DELETEs the singular path and reads 204 as success', async () => {
    const panel = fakePanel({
      groups: [
        { id: 3, name: 'normal', inbound_tags: ['Shadowsocks TCP'], is_disabled: false, total_users: 0 },
      ],
    });
    const result = await marzbanAdapter.deleteGroup!(provider(panel.fetchImpl), 3);
    expect(result.ok).toBe(true);
    expect(panel.groups).toHaveLength(0);
  });

  it('treats a group that is already gone as done, not as a failure', async () => {
    // 404 on a delete is the requested state. Reporting it as an error leaves
    // an operator pressing a button that already worked.
    const panel = fakePanel({ groups: [] });
    const result = await marzbanAdapter.deleteGroup!(provider(panel.fetchImpl), 99);
    expect(result.ok).toBe(true);
  });
});

describe('listGroups, after the refactor that gave create and list one parser', () => {
  it('still reports members, tags, the deliverable count and the panel’s switch', async () => {
    const panel = fakePanel({
      groups: [
        {
          id: 2,
          name: 'vip',
          inbound_tags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
          is_disabled: true,
          total_users: 5,
        },
      ],
      hostFor: ['Shadowsocks TCP'],
    });
    const result = await marzbanAdapter.listGroups!(provider(panel.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups).toEqual([
      {
        id: 2,
        name: 'vip',
        memberCount: 5,
        inboundTags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
        deliverableInbounds: 1,
        disabled: true,
      },
    ]);
  });
});
