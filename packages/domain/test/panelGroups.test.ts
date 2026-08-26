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
  /** Accounts, for the group-membership walk. */
  users?: Array<{ username: string; group_ids?: number[] }>;
  /** Usernames the panel refuses to update, so a partial failure can be asserted. */
  refuseUser?: string[];
} = {}) {
  const calls: Call[] = [];
  const groups: Group[] = [...(options.groups ?? [])];
  const users = (options.users ?? []).map((u) => ({ ...u }));
  const inbounds = options.inbounds ?? ['Shadowsocks TCP', 'VLESS TCP 17846'];
  const hostFor = options.hostFor ?? inbounds;
  let nextId = Math.max(0, ...groups.map((g) => g.id)) + 1;
  let nextHostId = 100;
  const extraHosts: Array<{
    id: number;
    remark: string;
    inbound_tag: string;
    address: unknown;
    is_disabled: boolean;
  }> = [];

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
        JSON.stringify([
          ...inbounds.map((tag, i) => ({
            id: i + 1,
            remark: `host-${tag}`,
            address: [],
            inbound_tag: tag,
            is_disabled: !hostFor.includes(tag),
          })),
          ...extraHosts,
        ]),
        { status: 200 },
      );
    }
    if (method === 'GET' && url.endsWith('/api/groups')) {
      return new Response(JSON.stringify({ groups, total: groups.length }), { status: 200 });
    }
    // Every account, and — deliberately — the whole list no matter what is in
    // the query string. The real panel does exactly this: `?group_id=3`,
    // `?group_id=7` and `?group_id=999` each answered 200 with all thirteen
    // accounts, measured 2026-08-26. A fake that honoured the parameter would
    // make a filter-on-the-panel implementation pass here and move every account
    // on a real one.
    if (method === 'GET' && url.includes('/api/users')) {
      return new Response(JSON.stringify({ users, total: users.length }), { status: 200 });
    }
    const userPut = /\/api\/user\/([^/?]+)$/.exec(url);
    if (userPut && method === 'PUT') {
      const name = decodeURIComponent(userPut[1]!);
      if ((options.refuseUser ?? []).includes(name)) {
        return new Response(JSON.stringify({ detail: 'nope' }), { status: 409 });
      }
      const found = users.find((u) => u.username === name);
      if (!found) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
      const spec = body as { group_ids?: unknown };
      // A PARTIAL update, which is the real panel's shape for users and the
      // opposite of `PUT /api/group/{id}` fifty lines down. A fake that demanded
      // the whole account here would hide a regression that stopped sending the
      // quota — by requiring the very field whose absence is the point.
      if (Array.isArray(spec?.group_ids)) found.group_ids = spec.group_ids as number[];
      return new Response(JSON.stringify(found), { status: 200 });
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
    if (method === 'POST' && url.endsWith('/api/host/')) {
      const spec = body as {
        remark?: unknown;
        inbound_tag?: unknown;
        address?: unknown;
        priority?: unknown;
      };
      // Every one of these is a 422 on the real panel if it is missing, and
      // `priority` is the one nobody would guess. The fake refuses it the same
      // way so a regression that drops it fails here rather than on a panel.
      if (typeof spec?.priority !== 'number') {
        return new Response(JSON.stringify({ detail: { priority: 'Field required' } }), {
          status: 422,
        });
      }
      if (!Array.isArray(spec?.address)) {
        return new Response(JSON.stringify({ detail: { address: 'Input should be a valid set' } }), {
          status: 422,
        });
      }
      if (!inbounds.includes(String(spec.inbound_tag))) {
        return new Response(JSON.stringify({ detail: `${String(spec.inbound_tag)} not found` }), {
          status: 400,
        });
      }
      const row = {
        id: nextHostId++,
        remark: String(spec.remark ?? ''),
        inbound_tag: String(spec.inbound_tag),
        address: spec.address,
        is_disabled: false,
      };
      extraHosts.push(row);
      return new Response(JSON.stringify(row), { status: 201 });
    }
    const hostPath = /\/api\/host\/(\d+)$/.exec(url);
    if (hostPath && method === 'DELETE') {
      const at = extraHosts.findIndex((h) => h.id === Number(hostPath[1]));
      if (at < 0) return new Response('{}', { status: 404 });
      extraHosts.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  return { calls, groups, users, fetchImpl };
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

describe('hosts, which is what «اینباند بساز» actually means', () => {
  it('POSTs the path WITH the trailing slash, and sends priority', () => {
    /**
     * Two things measured on the live panel that nothing in the API's shape
     * hints at: `/api/host` without the slash answers 307 and the redirect
     * drops the body, so the call looks like it worked and creates nothing;
     * and `priority` is required, answering
     * `422 {"detail":{"priority":"Field required"}}` when it is absent.
     *
     * Asserted on the request rather than on "it returned ok", because a fake
     * that accepted either would agree with a bug that only a real panel could
     * show.
     */
    const panel = fakePanel();
    return marzbanAdapter
      .createHost!(provider(panel.fetchImpl), {
        remark: 'آلمان-۱',
        inboundTag: 'Shadowsocks TCP',
        addresses: ['de1.example.com'],
      })
      .then((result) => {
        expect(result.ok).toBe(true);
        const call = panel.calls.find((c) => c.method === 'POST' && c.url.includes('/api/host'));
        expect(call!.url.endsWith('/api/host/'), 'the trailing slash is load-bearing').toBe(true);
        expect(call!.body).toEqual({
          remark: 'آلمان-۱',
          inbound_tag: 'Shadowsocks TCP',
          address: ['de1.example.com'],
          priority: 0,
        });
      });
  });

  it('accepts an empty address list, because the panel does', async () => {
    // A host with no address resolves to the panel's own, which is what a
    // single-server shop wants and what leaving the box blank means. Refusing
    // it would block the simplest thing an operator does.
    const panel = fakePanel();
    const result = await marzbanAdapter.createHost!(provider(panel.fetchImpl), {
      remark: 'default',
      inboundTag: 'Shadowsocks TCP',
      addresses: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host.addresses).toEqual([]);
    expect(result.host.inboundTag).toBe('Shadowsocks TCP');
  });

  it('carries the panel’s «not found» for an inbound that does not exist', async () => {
    // The panel is the only thing that knows its inbound tags, and a host on a
    // tag it does not have is a tier that would deliver nothing.
    const panel = fakePanel();
    const result = await marzbanAdapter.createHost!(provider(panel.fetchImpl), {
      remark: 'ghost',
      inboundTag: 'No Such Inbound',
      addresses: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not found');
    expect(result.reason).not.toContain('p:ss:word');
  });

  it('lists hosts with the disabled ones marked, not dropped', async () => {
    // A disabled host is the difference between «this inbound has no address»
    // and «somebody switched it off», and only one of those is fixed by adding
    // another host.
    const panel = fakePanel({ hostFor: ['Shadowsocks TCP'] });
    const result = await marzbanAdapter.listHosts!(provider(panel.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hosts.map((h) => [h.inboundTag, h.disabled])).toEqual([
      ['Shadowsocks TCP', false],
      ['VLESS TCP 17846', true],
    ]);
  });

  it('deletes a host, and treats one already gone as done', async () => {
    const panel = fakePanel();
    const made = await marzbanAdapter.createHost!(provider(panel.fetchImpl), {
      remark: 'temp',
      inboundTag: 'Shadowsocks TCP',
      addresses: [],
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect((await marzbanAdapter.deleteHost!(provider(panel.fetchImpl), made.host.id)).ok).toBe(
      true,
    );
    expect((await marzbanAdapter.deleteHost!(provider(panel.fetchImpl), 9999)).ok).toBe(true);
  });

  it('counts a new host toward what the group delivers, immediately', async () => {
    // The whole point of the feature. `vip` carries two inbounds and only one
    // has a host, so it delivers one config; adding a host on the other takes
    // the same group to two — which is exactly what was measured on the live
    // panel, subscription link and all.
    const panel = fakePanel({
      groups: [
        {
          id: 2,
          name: 'vip',
          inbound_tags: ['Shadowsocks TCP', 'VLESS TCP 17846'],
          is_disabled: false,
          total_users: 1,
        },
      ],
      hostFor: ['Shadowsocks TCP'],
    });
    const before = await marzbanAdapter.listGroups!(provider(panel.fetchImpl));
    expect(before.ok && before.groups[0]!.deliverableInbounds).toBe(1);

    await marzbanAdapter.createHost!(provider(panel.fetchImpl), {
      remark: 'vip-only',
      inboundTag: 'VLESS TCP 17846',
      addresses: [],
    });

    const after = await marzbanAdapter.listGroups!(provider(panel.fetchImpl));
    expect(after.ok && after.groups[0]!.deliverableInbounds).toBe(2);
  });
});

/**
 * Retiring a tier without emptying its members' subscriptions.
 *
 * The case is «خرید اولی‌ها»: a first-timers group is withdrawn and the people
 * who bought it still hold it. `deleteGroup` alone leaves their accounts alive
 * and their links empty — a PasarGuard subscription is resolved when it is
 * fetched, so nothing breaks at the moment of deletion and every one of them
 * quietly stops receiving configs on their next refresh.
 *
 * The fake above answers `/api/users` with the WHOLE list regardless of the
 * query string, because the panel does. That is what makes the first test here
 * a test rather than a restatement.
 */
describe('moving a group’s members', () => {
  const POPULATION = [
    { username: 'ali', group_ids: [3] },
    { username: 'sara', group_ids: [3, 6] },
    { username: 'reza', group_ids: [6] },
    { username: 'nobody', group_ids: [] },
  ];

  it('moves only the members of the group it was asked about', async () => {
    // The whole point. `?group_id=` is ignored by the panel, so a filter pushed
    // to it would move `reza` and `nobody` too — and the caller would be told
    // «۴ حساب جابه‌جا شد» about a panel where every tier had just collapsed into
    // one. Asserted on the fake's own rows, not on the return value.
    const panel = fakePanel({ users: POPULATION });
    const out = await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);

    expect(out.ok).toBe(true);
    expect(out.moved).toBe(2);
    expect(panel.users.find((u) => u.username === 'ali')!.group_ids).toEqual([7]);
    expect(panel.users.find((u) => u.username === 'reza')!.group_ids).toEqual([6]);
    expect(panel.users.find((u) => u.username === 'nobody')!.group_ids).toEqual([]);
  });

  it('keeps the other groups a member is in', async () => {
    // `sara` is in the retiring tier AND in 6. Replacing her groups with `[7]`
    // instead of amending them would take away a tier she also paid for, and
    // nothing would report it — she would simply receive less on her next
    // refresh, which is the same silent shape this whole route exists to stop.
    const panel = fakePanel({ users: POPULATION });
    await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);
    expect(panel.users.find((u) => u.username === 'sara')!.group_ids).toEqual([6, 7]);
  });

  it('sends only `group_ids`, so quota and expiry survive', async () => {
    // `PUT /api/user/{u}` is a PARTIAL update — proven against the live panel on
    // 2026-08-18 — and this route has no business resending an account's volume
    // or expiry. A body carrying more would silently rewrite what a customer
    // bought while moving them between tiers.
    const panel = fakePanel({ users: POPULATION });
    await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);
    const puts = panel.calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/user/'));
    expect(puts).toHaveLength(2);
    for (const put of puts) expect(Object.keys(put.body as object)).toEqual(['group_ids']);
  });

  it('is idempotent — running it again moves nobody', async () => {
    // What makes a retry after a partial failure safe. A member that already
    // moved no longer carries the old group, so the second pass finds nothing
    // and says so rather than doing it twice.
    const panel = fakePanel({ users: POPULATION });
    await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);
    const again = await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);
    expect(again.ok && again.moved).toBe(0);
  });

  it('reports how many moved when the panel refuses one of them', async () => {
    // Not one request — one per member. «It failed» and «it failed after one»
    // need different next steps from the operator, and only the second sentence
    // lets them tell a retry from a rollback. The count is on the failure arm of
    // the result type for exactly this.
    const panel = fakePanel({ users: POPULATION, refuseUser: ['sara'] });
    const out = await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);

    expect(out.ok).toBe(false);
    expect(out.moved, 'ali went through before sara was refused').toBe(1);
    expect(!out.ok && out.reason).toContain('sara');
    expect(panel.users.find((u) => u.username === 'ali')!.group_ids).toEqual([7]);
  });

  it('skips an account the panel described without any groups at all', async () => {
    // A missing `group_ids` must not become a written one. This says «skipped»,
    // not «treated as unknown»: an earlier version returned `null` for the
    // missing case to keep it apart from `[]`, and removing that distinction
    // turned nothing red — there is no branch where the two differ, because
    // neither carries the group being retired. The comment claiming otherwise
    // went with it.
    const panel = fakePanel({ users: [{ username: 'mystery' }, { username: 'ali', group_ids: [3] }] });
    const out = await marzbanAdapter.moveGroupMembers!(provider(panel.fetchImpl), 3, 7);
    expect(out.ok && out.moved).toBe(1);
    expect(panel.calls.some((c) => c.method === 'PUT' && c.url.includes('mystery'))).toBe(false);
  });
});
