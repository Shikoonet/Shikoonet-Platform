/**
 * The one interface every kind of thing we sell is delivered through.
 *
 * Mirzabot has no such seam: `marzban_panel` is 43 VPN-specific columns and
 * every panel type is a separate top-level PHP file that `index.php` branches
 * into. Selling something that is not a VPN means widening that table.
 *
 * Here the order, the wallet, the invoice and the payment verification never
 * learn what was sold. They hand a request to an adapter chosen by
 * `provisioning_providers.kind` and store whatever handle comes back in
 * `subscriptions.remote_ref`. Adding Spotify is a new file in this directory.
 *
 * `provision` and `listAccounts` exist. `revoke` is named in the plan and is
 * not declared here — an unimplemented branch per adapter buys nothing until
 * something calls it.
 */

/** What the customer bought, flattened so an adapter needs no SQL. */
export interface ProvisionRequest {
  /**
   * The remote account name. Deterministic, derived from the order — see
   * `remoteUsernameFor`. That is what makes retrying safe.
   */
  username: string;
  /** NULL means unmetered. */
  volumeGb: number | null;
  /** NULL means no expiry. */
  durationDays: number | null;
  /** Shown in the panel so a human can tell where an account came from. */
  note: string;
  /** `provisioning_providers.config` — inbounds, proxies, panel quirks. */
  providerConfig: Record<string, unknown>;
  /** `product_plans.attrs` — per-plan overrides of the above. */
  planAttrs: Record<string, unknown>;
  /** Absolute expiry, resolved by the caller so the adapter has no clock. */
  expiresAt: Date | null;
}

/**
 * The two ways a renewal is applied, both of them live.
 *
 * Legacy `panels.php:extend` offers five, selected per panel by
 * `marzban_panel.Methodextend`. The production rows use exactly two:
 *
 *     panel  Methodextend                         mode
 *       1    اضافه شدن زمان و حجم به ماه بعد        ADD
 *       8    ریست حجم و زمان                       RESET
 *      12    ریست حجم و زمان                       RESET
 *      13    ریست حجم و زمان                       RESET  (renewal switched off)
 *      14    ریست حجم و زمان                       RESET
 *
 * The other three are not implemented for the same reason the `on_hold` branches
 * of `provision` are not: nothing selects them, and a branch nobody runs is a
 * branch nobody notices is wrong.
 *
 * RESET  — the usage counter goes to zero, the quota becomes the plan's, and
 *          the clock starts again from the moment of renewal.
 * ADD    — the plan's volume is added to what is already there and its days are
 *          added to whatever time is left, so a customer who renews early loses
 *          nothing. Usage is NOT reset; the quota grows instead.
 * ADD_VOLUME_RESET_TIME
 *        — Sam asked for it on 2026-09-03: the half of each. The clock starts
 *          again from now, and the plan's volume is ADDED to whatever is left
 *          rather than replacing it, so a customer who renews with gigabytes
 *          unspent keeps them while their month restarts.
 *
 *          The usage counter is NOT reset in this mode, and that is the part
 *          worth reading twice. `/reset` zeroes the counter, and on a panel
 *          where the quota is being ADDED to, zeroing it would hand the
 *          customer everything they had already spent back as free traffic —
 *          the quota would say «old + new» while usage said zero.
 */
export type RenewMode = 'RESET' | 'ADD' | 'ADD_VOLUME_RESET_TIME';

/** What a renewal buys, flattened the same way `ProvisionRequest` is. */
export interface RenewRequest {
  /** The account already on the panel. Not derived — read off the subscription. */
  username: string;
  /** The plan's volume. NULL means unmetered. */
  volumeGb: number | null;
  /** The plan's duration. NULL means no expiry. */
  durationDays: number | null;
  note: string;
  providerConfig: Record<string, unknown>;
  planAttrs: Record<string, unknown>;
  mode: RenewMode;
  /**
   * The tier the customer is renewing INTO, or absent to leave the account's
   * groups alone.
   *
   * A renewal used to send only quota, expiry and note, which meant the panel
   * account kept whichever groups it was created with. That is invisible until
   * somebody renews from a DIFFERENT service — and the whole point of a
   * first-timers-only tier is that they must, because it disappears from its
   * own renewal list the moment they own anything. So the customer paid
   * «طلایی» prices and kept the starter tier's inbounds, quietly, forever.
   *
   * Set by the caller and only for a real renewal. An add-on — five more
   * gigabytes, ten more days — buys no tier and must not touch the groups, and
   * `mode` cannot answer that question: `renewModeFor` returns 'ADD' for
   * ordinary renewals in some shops too.
   */
  groupIds?: unknown;
  /**
   * The moment the renewal takes effect, resolved by the caller so the adapter
   * still has no clock. In ADD mode the new expiry is measured from whichever
   * is later, this or the account's own remaining time — which is what stops an
   * early renewal from throwing away the days already paid for.
   */
  renewFrom: Date;
}

export interface ProvisionOk {
  ok: true;
  /** Goes to `subscriptions.remote_username`. */
  remoteUsername: string;
  /**
   * Goes to `subscriptions.remote_ref`. Adapter-owned; nothing outside the
   * adapter that wrote it may interpret its keys.
   */
  remoteRef: Record<string, unknown>;
  /** What the customer is actually given. NULL when there is nothing to link. */
  subscriptionUrl: string | null;
  /**
   * True when the account was already there and this call found it rather than
   * created it. A retry after a timeout is the normal way to see this, and it
   * must not be treated as a failure.
   */
  alreadyExisted: boolean;
  /**
   * What the account's limits are now, as the adapter set them.
   *
   * Only a renewal fills these in, and only because the answer is not
   * derivable outside the adapter: in ADD mode the new expiry is measured from
   * the panel's own remaining time and the new quota from the panel's own
   * counter. Recomputing either in the caller would be two implementations of
   * one rule, drifting apart the first time a panel's clock does.
   *
   * `undefined` means "unchanged / not applicable"; `null` means "no limit".
   */
  expiresAt?: Date | null;
  volumeGb?: number | null;
}

export interface ProvisionFailed {
  ok: false;
  /** Stored in `orders.failure_reason`, so it is read by a human. Never a stack. */
  reason: string;
  /**
   * Whether trying again could plausibly work. A refused password is not
   * retryable; a timeout is. The sweep uses this to decide between leaving the
   * order for the next pass and stopping to wait for a person.
   */
  retryable: boolean;
  /**
   * What the panel was already made to do before this failed.
   *
   * A renewal is two calls to the panel and only the pair is meaningful. If the
   * first one lands and the second is refused, the account has moved and the
   * order has not — the customer is refunded and told it failed, while their
   * usage counter really is back at zero. Nothing can put that back: no panel
   * API accepts a used-traffic figure.
   *
   * So the adapter says what it did, and the sweep writes it down where a
   * person can find it. An empty array is the ordinary case and the default;
   * a failure before any call has nothing to report.
   */
  applied?: string[];
}

export type ProvisionResult = ProvisionOk | ProvisionFailed;

/**
 * One remote account as the provider currently sees it.
 *
 * Deliberately small, and not the panel's whole user object: what is left out
 * cannot be mapped without guessing, and a sync that guesses is a sync that can
 * mark a paid service dead because a panel had a bad minute.
 *
 * ## `expiresAtMs`, and the rule that was wrong
 *
 * It was left out on those grounds too, and the grounds were wrong. «We sell
 * the duration, so we own the date» is true of every service THIS bot has sold
 * and false of the 5,352 it inherited: the importer has no expiry to read —
 * `invoice` never stored one, and `legacy_attrs` carries an `expire` key on
 * zero rows of 8,428 — so those services arrived with no date at all. Not a
 * date we own: no date. Issue #92.
 *
 * ## `status` and `onlineAt`, and why the rule above still holds
 *
 * The comment here used to say status could not be mapped. That is still true
 * of `subscriptions.status` — six words of ours against five of the panel's,
 * and `sync.ts` still refuses to write one from the other.
 *
 * What changed is that two jobs now need to know what the PANEL thinks, kept
 * apart from what WE think. Mirzabot's two removal crons
 * (`cronbot/NoticationsService.php`) both gate on it: neither will remove an
 * account unless the panel itself reports `limited` or `expired`, and the
 * volume one also needs the last connection time. Deleting on our dates alone
 * would remove a service the panel considers live — which is precisely the
 * failure the original rule was written against.
 *
 * So these are stored verbatim, under names that say whose opinion they are,
 * and nothing maps them onto our own status.
 */
export interface RemoteAccount {
  username: string;
  /** Bytes consumed. NULL when the provider does not count. */
  usedBytes: number | null;
  /** Absolute, tappable. NULL when this provider hands out no link. */
  subscriptionUrl: string | null;
  /**
   * When the panel says this account runs out, in epoch milliseconds.
   *
   * NULL when the panel names no expiry — an unmetered account, or one being
   * held until its first connection. The caller may only ever fill a gap with
   * this and never overwrite; `writeAccounts` in the bot's sync sweep is where
   * that rule is spelled out and enforced.
   */
  expiresAtMs: number | null;
  /**
   * The panel's own word for this account, unmapped and lowercased.
   *
   * `active`, `limited`, `expired`, `disabled`, `on_hold` on PasarGuard and
   * Marzban. NULL when the provider does not say — and NULL must never be read
   * as «not limited»: a removal gated on this requires the word to be PRESENT
   * and to be one of the two, so a panel that stops reporting stops removals
   * rather than starting them.
   */
  status: string | null;
  /** When the panel last saw this account connect. NULL when it does not say. */
  onlineAt: string | null;
}

/** One group as the panel reports it. `name` is for a person to recognise. */
export interface PanelGroup {
  id: number;
  name: string;
  /** How many accounts the panel says are in it, when it says. */
  memberCount?: number;
  /** The inbounds this group carries, by tag. */
  inboundTags?: string[];
  /**
   * How many of those inbounds can actually hand the customer a config.
   *
   * Measured on the live test panel 2026-08-23, and it is not the same number
   * as `inboundTags.length`. PasarGuard builds a subscription from HOSTS, and a
   * host belongs to one inbound tag. A group whose second inbound has no host
   * delivers exactly as much as a group without it:
   *
   *   vip    — 2 inbounds, 1 with a host  → 1 config
   *   normal — 1 inbound,  1 with a host  → 1 config
   *
   * A host was then added on the vip-only inbound and the SAME subscription
   * link went to two configs, with nothing re-delivered. So an operator reading
   * "this VIP group has more inbounds" is reading the wrong number; this is the
   * one that decides what the customer receives.
   */
  deliverableInbounds?: number;
  /**
   * The panel's own on/off switch for this group, when it has one.
   *
   * Not our `status`: a disabled group still exists, still holds its accounts,
   * and a purchase that sends it still names something real. Shown because a
   * tier that quietly stopped working looks identical to one that never did.
   */
  disabled?: boolean;
}

export type GroupsResult = { ok: true; groups: PanelGroup[] } | { ok: false; reason: string };

/**
 * One inbound the panel has, and whether it can actually deliver.
 *
 * `hosted` is the same distinction `PanelGroup.deliverableInbounds` counts, at
 * the level where somebody is choosing. Putting an unhosted inbound into a new
 * "platinum" group produces a tier that looks richer in every listing and hands
 * the customer exactly what the cheap tier hands them, so the choice has to
 * carry the warning.
 *
 * Absent, not false, when the host listing could not be read: "we could not
 * ask" and "nothing delivers" are different sentences and only one of them
 * should stop an operator.
 */
export interface PanelInbound {
  tag: string;
  hosted?: boolean;
}

export type InboundsResult =
  | { ok: true; inbounds: PanelInbound[] }
  | { ok: false; reason: string };

/**
 * What a group looks like after we changed it — read back from the panel's own
 * reply, never assembled from what we sent. A panel that silently drops an
 * unknown inbound tag would otherwise be reported as having accepted it.
 */
export type GroupWriteResult = { ok: true; group: PanelGroup } | { ok: false; reason: string };

export type GroupDeleteResult = { ok: true } | { ok: false; reason: string };

/**
 * The outcome of removing one customer's account from a panel.
 *
 * `gone` on the success arm distinguishes «we deleted it» from «it was not
 * there», and the caller records which. They are the same end state and a
 * different story: the second means somebody removed it by hand, or a previous
 * sweep did and the write that recorded it was lost — worth reading in the log
 * rather than counted as a deletion this run performed.
 */
export type AccountDeleteResult =
  | { ok: true; gone: boolean }
  | { ok: false; reason: string; retryable: boolean };

/**
 * The outcome of walking a panel's accounts and re-grouping the ones that were
 * in a group being retired.
 *
 * `moved` is on BOTH arms and that is the point. This is not one request: it is
 * one `PUT` per member, and the interesting failure is the sixth of nine. A
 * result that said only «failed» would leave an operator unable to tell «none
 * of them moved, try again» from «five moved, the rest did not», and those need
 * different next steps.
 *
 * `scanned` is the population it had to read to find them, because the panel
 * will not filter by group — see `moveGroupMembers`.
 */
export type GroupMoveResult =
  | { ok: true; moved: number; scanned: number }
  | { ok: false; reason: string; moved: number };

/**
 * One host, which is the thing a customer's subscription is actually built out
 * of.
 *
 * An inbound is a section of the panel's Xray core config and has no API of its
 * own — `POST /api/inbound` is 404 and `/api/inbounds` is 405, asked 2026-08-23.
 * The only way to add one is to rewrite the whole core config, and a dashboard
 * that does that can take every customer's proxy down with one bad edit, not
 * just one tier.
 *
 * A HOST is the piece that was actually missing. It points at an inbound by tag
 * and carries the address the customer connects to, and an inbound without one
 * contributes nothing to a subscription — measured: a `vip` group with two
 * inbounds delivered exactly what a `normal` group with one delivered, until a
 * host was added on the second and the same link went to two configs.
 *
 * So this is what «اینباند بساز» means here, and the naming on screen says so
 * rather than pretending the panel has an inbound endpoint it does not.
 */
export interface PanelHost {
  id: number;
  remark: string;
  /** The inbound this host serves. The panel rejects a tag it does not have. */
  inboundTag: string;
  /** Addresses the customer connects to. May be empty — the panel allows it. */
  addresses: string[];
  disabled: boolean;
}

export type HostsResult = { ok: true; hosts: PanelHost[] } | { ok: false; reason: string };
export type HostWriteResult = { ok: true; host: PanelHost } | { ok: false; reason: string };
export type HostDeleteResult = { ok: true } | { ok: false; reason: string };

export type AccountsResult =
  | { ok: true; accounts: RemoteAccount[] }
  | { ok: false; reason: string };

/**
 * Something the customer asks of an account they already own — not a purchase.
 *
 * Deliberately not folded into `renew`: nothing here changes what was paid for,
 * so none of it goes near an order. What comes back is only what the caller has
 * to store — a revoked link is a new link, and a status change is a status.
 */
export type AccountAction =
  | { kind: 'REVOKE_SUB'; username: string }
  | { kind: 'SET_ENABLED'; username: string; enabled: boolean }
  /**
   * Put the account on exactly these groups.
   *
   * Used at both ends of «اینباند اکانت غیرفعال»: down onto the panel's
   * downgrade groups when a service ends, and back onto what it was sold when
   * it is renewed. A REPLACEMENT, never a merge, because the point of the
   * downgrade is that the account stops carrying what it used to.
   *
   * The list may not be empty. PasarGuard reads `group_ids: []` as «belongs to
   * no group», which strips every inbound - the subscription link resolves and
   * returns nothing, which is exactly the failure `firstConfigured` was written
   * to prevent on the create side. A panel with no downgrade groups configured
   * must not be downgraded at all; that decision belongs to the caller.
   */
  | { kind: 'SET_GROUPS'; username: string; groupIds: number[] };

export type AccountActionResult =
  | {
      ok: true;
      /** Present when the action replaced it. `undefined` means unchanged. */
      subscriptionUrl?: string | null;
      /** What the account's status is now, as the panel reports it. */
      enabled?: boolean;
      /**
       * What the account was on before SET_GROUPS moved it.
       *
       * Read from the panel immediately before the write, because the panel is
       * the only place that knows: a service may have been moved by hand, or
       * bought before the plan carried groups at all. Absent when the panel did
       * not say - and the caller must survive that rather than storing an empty
       * list, which would restore an account onto nothing.
       */
      groupIdsBefore?: number[];
    }
  | { ok: false; reason: string; retryable: boolean };

export interface ProvisioningAdapter {
  readonly kind: string;
  /**
   * Create the thing, or return the one that is already there under this
   * username. Must be safe to call twice with the same request — the sweep
   * that calls it can be interrupted at any point and will call again.
   */
  provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult>;
  /**
   * Extend an account that already exists.
   *
   * Not idempotent the way `provision` is, and cannot be: adding thirty days
   * twice adds sixty. The caller is what makes it safe — an order is claimed
   * out of PAID before this runs and only ever reaches here once.
   *
   * Optional. Without it a renewal falls to a person, which is the right
   * answer for a product nobody automated.
   */
  renew?(request: RenewRequest, provider: ProviderContext): Promise<ProvisionResult>;
  /**
   * Every account this provider holds, for the sweep that refreshes what the
   * customer sees.
   *
   * Optional, and bulk on purpose. Mirzabot asks the panel about one account
   * every time anyone opens a service screen; with 3,139 live services that is
   * a panel request per glance. One listing per panel per sweep is the same
   * information for a thousandth of the traffic.
   *
   * An adapter with nothing to report — `manual` — simply does not have this,
   * and the sweep skips it rather than being told an empty list.
   */
  listAccounts?(provider: ProviderContext): Promise<AccountsResult>;

  /**
   * The groups this panel offers, as the panel itself reports them.
   *
   * The reason this belongs on the adapter rather than in a script: a group id
   * is not ours. `provisioning_providers.config.inbounds` carries `[42, 2]`
   * because the 2026-08-11 dump said so, and group 42 was deleted from the live
   * panel some time after — which PasarGuard answers with `404 Group not found`
   * and the adapter classifies as non-retryable, so every VIP order would have
   * gone FAILED and refunded on the first day of cutover.
   *
   * A number frozen in our configuration cannot notice that. A list the panel
   * supplies can, which is why «مدیریت پنل‌ها» picks from this rather than
   * taking a typed id.
   *
   * Optional: a `manual` panel has no groups, and neither does an `ai_account`.
   * A caller must treat absence as "cannot be asked", never as "has none".
   */
  listGroups?(provider: ProviderContext): Promise<GroupsResult>;

  /**
   * Every inbound this panel has, whether or not a group uses it.
   *
   * `listGroups` reports the tags each group already carries; this is the
   * superset somebody picks from when building a new one. They are separate
   * calls because they answer separate questions, and deriving the second from
   * the first would hide exactly the inbound nobody has used yet — which is the
   * one an operator is looking for when they add a tier.
   */
  listInbounds?(provider: ProviderContext): Promise<InboundsResult>;

  /**
   * Create a group on the panel.
   *
   * The panel owns the id. We ask for a name and a set of inbound tags and read
   * back whatever it made, because a tag it does not recognise is a tier that
   * delivers less than it claims and the reply is the only place that shows up.
   */
  createGroup?(
    provider: ProviderContext,
    spec: { name: string; inboundTags: string[] },
  ): Promise<GroupWriteResult>;

  /**
   * Replace a group's name and inbound set.
   *
   * A full replacement rather than a patch, and that is the panel's shape, not
   * a simplification: `PUT /api/group/{id}` with only `{is_disabled: true}`
   * answers `422 {"detail":{"name":"Field required"}}` — measured against the
   * test panel on 2026-08-23. This is the opposite of `PUT /api/user/{u}`,
   * which IS a partial update, so the two must not be reasoned about together.
   */
  updateGroup?(
    provider: ProviderContext,
    id: number,
    spec: { name: string; inboundTags: string[] },
  ): Promise<GroupWriteResult>;

  /**
   * Remove a group from the panel.
   *
   * Destructive on the panel side and irreversible from here — the accounts in
   * it keep existing but stop carrying its inbounds. The caller is responsible
   * for refusing to delete one that our own catalog still sends; the adapter
   * only asks.
   */
  deleteGroup?(provider: ProviderContext, id: number): Promise<GroupDeleteResult>;

  /**
   * Removes one account from the panel. Irreversible.
   *
   * Optional, and the only method on this interface that destroys a thing a
   * customer paid for. It exists for the two removal sweeps and nothing else
   * calls it; an adapter without it makes those sweeps skip its panels, which
   * is the correct behaviour for `manual` — there is nothing there to delete.
   *
   * The guards do NOT live here. Whether this account has been expired long
   * enough, whether the panel agrees it is finished, and whether the shop has
   * even asked for removals to happen are all questions the caller answers,
   * because this layer knows nothing about our dates or our settings. What
   * this owes the caller is an honest report of what happened to the panel.
   */
  deleteAccount?(provider: ProviderContext, username: string): Promise<AccountDeleteResult>;

  /**
   * Move every account out of one group and into another.
   *
   * What this exists for: retiring a tier. «خرید اولی‌ها» stops being offered,
   * and the people who bought it are still holding it. `deleteGroup` alone
   * leaves them in no group at all — their accounts survive and their configs
   * stop arriving, silently, on the next subscription refresh. So the deletion
   * has a step in front of it.
   *
   * **The panel cannot be asked for one group's members.** `GET /api/users`
   * accepts `?group_id=` and ignores it: measured against the live panel on
   * 2026-08-26, `group_id=3`, `group_id=7` and even `group_id=999` each answered
   * `200` with all thirteen accounts. So the whole population is read, page by
   * page, and the filter is applied here. Any implementation that trusts that
   * parameter moves every account on the panel.
   *
   * One `PUT /api/user/{u}` per member, which is a partial update — the quota,
   * expiry and proxy settings of an account this touches are not resent and do
   * not change. Idempotent by construction: a member that already moved no
   * longer carries `from`, so a retry after a partial failure resumes rather
   * than repeating.
   */
  moveGroupMembers?(
    provider: ProviderContext,
    from: number,
    to: number,
  ): Promise<GroupMoveResult>;

  /**
   * Every host on the panel, so a screen can say which inbounds actually
   * deliver and which are decoration.
   */
  listHosts?(provider: ProviderContext): Promise<HostsResult>;

  /**
   * Point a new host at an inbound.
   *
   * `priority` is required by the panel and is not asked for here — a person
   * adding an address for a tier has no opinion about it, and 0 is what the
   * existing hosts carry. `addresses` may be empty and the panel accepts it,
   * which produces a host that resolves to the panel's own address.
   */
  createHost?(
    provider: ProviderContext,
    spec: { remark: string; inboundTag: string; addresses: string[] },
  ): Promise<HostWriteResult>;

  /**
   * Remove a host.
   *
   * Removing the last one on an inbound silently empties every tier that
   * carries that inbound — the customers keep their links and the links stop
   * producing that config. The caller is what knows which tiers those are.
   */
  deleteHost?(provider: ProviderContext, id: number): Promise<HostDeleteResult>;

  /**
   * Act on an existing account at the customer's request: replace its
   * subscription link, or turn it off and on.
   *
   * Optional, and a provider that lacks it simply does not offer the buttons —
   * a `manual` product has no panel to ask, and pretending otherwise would tell
   * the customer something happened when nothing did.
   */
  act?(action: AccountAction, provider: ProviderContext): Promise<AccountActionResult>;
}

/** Everything about the provider except its secrets. */
export interface ProviderContext {
  id: number;
  code: string;
  name: string;
  baseUrl: string | null;
  /**
   * Resolved credentials, looked up from the environment by `secret_ref` —
   * never read out of the database, which is why the column holds a name and
   * not a password.
   *
   * That keeps the login out of the row. It does not make the row harmless:
   * `config.proxies` carries a hysteria shared secret, because provisioning
   * sends it. See `migrations/0002_catalog.sql`.
   */
  credentials: { username: string; password: string } | null;
  config: Record<string, unknown>;
  /** Injected so tests do not reach the network and never need a real panel. */
  fetch: typeof globalThis.fetch;
}
