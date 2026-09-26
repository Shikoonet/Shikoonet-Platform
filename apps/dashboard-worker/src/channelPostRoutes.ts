/**
 * «پست کانال» (#473) — writing a post for the shop's channels, from the panel.
 *
 * It replaces a separate tool that sent text and buttons to one fixed channel,
 * kept nothing, and answered «Internal server error» to a post Telegram had
 * already accepted — so the operator sent it again, and the channel got it
 * twice.
 *
 * The life of a post:
 *
 *   write it (text, a picture or a video, rows of link buttons) → preview it:
 *   it is posted to the reports group exactly as it will look → schedule it,
 *   for now or for later → the bot copies that preview into the channel
 *   (`apps/bot/src/channelPosts.ts`) → edit, pin or delete it there.
 *
 * Three rules hold it together:
 *
 * - **What is sent is what was previewed.** The bot copies the preview message
 *   with the keyboard built here, so no second rendering can differ from the
 *   one the operator looked at. Changing anything a post says clears its
 *   preview; a post nobody has previewed cannot be scheduled (a CHECK says so).
 * - **At most once.** The bot claims a post before sending it; a send with no
 *   answer stays «در حال ارسال» until a person says whether it arrived. Every
 *   write here that races the bot is conditional on the status it expects.
 * - **The server builds every link and id.** A campaign button's URL is built
 *   here from the bot's username; the preview's chat and message id are written
 *   here, never taken from a request — otherwise this route could copy any
 *   message the bot can see, a customer's receipt included, into a public
 *   channel.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { EnvName } from '@shikoo/contracts';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';
import { botUsername, idOf } from './campaignRoutes.js';
import { CHAT_REF } from './channelRoutes.js';
import {
  attachmentOf,
  botTelegram,
  readCappedBody,
  reportsGroup,
  type TelegramCall,
} from './telegramCall.js';

type PostEnv = {
  Bindings: { DB: D1Database; ENV_NAME: EnvName; TELEGRAM_BOT_TOKEN?: string };
  Variables: { identity: Ident };
};
type Ctx = Context<PostEnv>;

/** Telegram's caps on what the bot uploads, less a margin. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
/** Telegram refuses a caption longer than this, and a text longer than 4096. */
const MAX_CAPTION = 1024;
const MAX_TEXT = 4096;
/** A post that has been «در حال ارسال» this long is stuck, not busy. */
const STUCK_AFTER = "interval '2 minutes'";
/** Far enough ahead for any campaign; beyond it is a typo in the year. */
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

const SLUG = /^[a-z0-9][a-z0-9-]{2,61}$/;

/**
 * One button: a link, or a campaign whose link is built here. Never
 * `callback_data` — in a public channel that would drive the bot's own callback
 * handler as whoever pressed it — and never plain http.
 */
const Button = z
  .object({
    text: z.string().trim().min(1).max(64),
    url: z
      .string()
      .trim()
      .max(512)
      .regex(/^(https|tg):\/\/\S+$/i, 'لینک دکمه باید با https:// یا tg:// شروع شود')
      .optional(),
    campaign: z.string().regex(SLUG).optional(),
    style: z.enum(['primary', 'success', 'danger']).optional(),
    emoji: z
      .string()
      .regex(/^[0-9]{5,30}$/, 'شناسهٔ ایموجی پرمیوم فقط عدد است')
      .optional(),
  })
  .strict()
  .refine((b) => (b.url === undefined) !== (b.campaign === undefined), {
    message: 'هر دکمه یا لینک دارد یا کمپین — یکی از این دو',
  });
type Button = z.infer<typeof Button>;

const Buttons = z
  .array(z.array(Button).min(1).max(8))
  .max(20)
  .refine((rows) => rows.flat().length <= 100, 'حداکثر ۱۰۰ دکمه');

const ChatRef = z
  .string()
  .trim()
  .refine(
    (v) => CHAT_REF.test(v),
    'کانال را به شکل @username یا عدد -100… بده — لینک t.me قبول نیست',
  );

const PostCreate = z
  .object({
    chat: ChatRef.optional(),
    text: z.string().max(MAX_TEXT).optional(),
    buttons: Buttons.optional(),
    /** «ارسال دوباره»: a new draft with this post's channel, words, media and buttons. */
    copyOf: z.number().int().positive().optional(),
  })
  .strict()
  .refine((b) => (b.copyOf === undefined) !== (b.chat === undefined), {
    message: 'یا کانال را بده یا پستی که از رویش کپی شود',
  });

/** Every change to a post, one `op` at a time — each is its own audit action. */
const PostPatch = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('edit'),
      chat: ChatRef.optional(),
      text: z.string().max(MAX_TEXT).optional(),
      buttons: Buttons.optional(),
      removeMedia: z.literal(true).optional(),
    })
    .strict(),
  /** `sendAt` null is «now». */
  z
    .object({
      op: z.literal('schedule'),
      sendAt: z
        .string()
        .max(40)
        .refine((v) => !Number.isNaN(Date.parse(v)), 'زمان نامعتبر است')
        .nullable(),
    })
    .strict(),
  z.object({ op: z.literal('cancel') }).strict(),
  z.object({ op: z.literal('pin'), pinned: z.boolean() }).strict(),
  /** A post stuck «در حال ارسال»: is it in the channel or not? A person looked. */
  z.object({ op: z.literal('resolve'), inChannel: z.boolean() }).strict(),
  /** Gives the post its own campaign, `post-<id>`, for its buy button. */
  z.object({ op: z.literal('track') }).strict(),
]);

const MediaQuery = z.object({
  kind: z.enum(['photo', 'video']),
  name: z.string().trim().min(1).max(200),
});

interface PostRow {
  id: number;
  chat_id: number;
  chat_title: string;
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';
  text: string;
  media_kind: 'NONE' | 'PHOTO' | 'VIDEO';
  media_file_id: string | null;
  buttons: Button[][];
  preview_message_id: number | null;
  send_at: string | null;
  sent_at: string | null;
  message_id: number | null;
  error: string | null;
  campaign_slug: string | null;
  created_by: string;
  created_at: string;
  stuck: boolean;
  stamp: string;
}

const COLUMNS = `id, chat_id, chat_title, status, text, media_kind, media_file_id, buttons,
  preview_message_id, send_at, sent_at, message_id, error, campaign_slug, created_by, created_at,
  (status = 'SENDING' AND claimed_at < now() - ${STUCK_AFTER}) AS stuck,
  updated_at::text AS stamp`;

const ms = (v: string | null) => (v === null ? null : new Date(v).getTime());

const shape = (r: PostRow) => ({
  id: Number(r.id),
  chatId: Number(r.chat_id),
  chatTitle: r.chat_title,
  status: r.status,
  text: r.text,
  mediaKind: r.media_kind,
  buttons: r.buttons,
  previewed: r.preview_message_id !== null,
  sendAt: ms(r.send_at),
  sentAt: ms(r.sent_at),
  inChannel: r.message_id !== null,
  error: r.error,
  campaignSlug: r.campaign_slug,
  createdBy: r.created_by,
  createdAt: ms(r.created_at),
  stuck: r.stuck,
});

async function load(db: D1Database, id: number): Promise<PostRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM channel_posts WHERE id = ?1`).bind(id).first<PostRow>();
}

/**
 * The keyboard Telegram is handed, or why it cannot be built. A campaign
 * button's link is made here, from the bot's own username.
 */
function markupOf(
  rows: Button[][],
  bot: string | null,
): { inline_keyboard: Array<Array<Record<string, string>>> } | null | 'no_bot_username' {
  if (rows.length === 0) return null;
  if (bot === null && rows.some((r) => r.some((b) => b.campaign !== undefined))) {
    return 'no_bot_username';
  }
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ({
        text: b.text,
        url: b.url ?? `https://t.me/${bot}?start=c_${b.campaign}`,
        ...(b.style ? { style: b.style } : {}),
        ...(b.emoji ? { icon_custom_emoji_id: b.emoji } : {}),
      })),
    ),
  };
}

/** A button pointing at a campaign that does not exist would count nothing, silently. */
async function unknownCampaigns(db: D1Database, rows: Button[][]): Promise<string[]> {
  const slugs = [...new Set(rows.flat().flatMap((b) => (b.campaign ? [b.campaign] : [])))];
  if (slugs.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT slug FROM campaigns WHERE slug = ANY(?1)`)
    .bind(slugs)
    .all<{ slug: string }>();
  const known = new Set((results ?? []).map((r) => r.slug));
  return slugs.filter((s) => !known.has(s));
}

type Resolved = { chatId: number; title: string } | { error: string; detail: string };

/**
 * A channel by name or id, as its numeric id — and only if the bot can post
 * there. The id, not the name, is what is stored: a @username can change
 * hands, and a scheduled post must not follow it to a stranger's channel.
 */
async function resolveChat(call: TelegramCall, ref: string): Promise<Resolved> {
  const chat = await call('getChat', { chat_id: ref });
  if (chat.ok !== true) {
    return {
      error: 'chat_not_found',
      detail: `تلگرام این کانال را پیدا نکرد: ${chat.description ?? 'بدون توضیح'}`,
    };
  }
  const found = chat.result as unknown as { id: number; title?: string; type?: string };
  const me = await call('getMe', {});
  const botId = (me.result as unknown as { id?: number } | undefined)?.id;
  // Asked before «can it post?», or a Telegram having a bad minute would be
  // reported as the bot lacking rights it has.
  if (me.ok !== true || botId === undefined) {
    return { error: 'telegram_refused', detail: `تلگرام جواب نداد: ${me.description ?? 'getMe'}` };
  }
  const member = await call('getChatMember', { chat_id: found.id, user_id: botId });
  const role = member.result as unknown as { status?: string; can_post_messages?: boolean };
  const canPost =
    member.ok === true &&
    (found.type === 'channel'
      ? role?.status === 'administrator' && role.can_post_messages === true
      : ['administrator', 'creator', 'member'].includes(role?.status ?? ''));
  if (!canPost) {
    return {
      error: 'bot_cannot_post',
      detail:
        'ربات در این کانال اجازهٔ ارسال ندارد — ربات را مدیر کانال کن و «ارسال پیام» را برایش روشن کن.',
    };
  }
  return { chatId: Number(found.id), title: found.title ?? String(found.id) };
}

/** A call to Telegram that may throw, turned into the panel's answer. */
async function viaTelegram<T>(
  c: Ctx,
  run: (call: TelegramCall) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const bot = await botTelegram(c.env);
  if (!bot.ok) {
    return {
      ok: false,
      response: c.json({ ok: false, error: bot.error, detail: bot.detail }, bot.status),
    };
  }
  try {
    return { ok: true, value: await run(bot.call) };
  } catch {
    return {
      ok: false,
      response: c.json(
        { ok: false, error: 'telegram_unreachable', detail: 'تلگرام جواب نداد.' },
        502,
      ),
    };
  }
}

const refused = (c: Ctx, description: string | undefined) =>
  c.json(
    {
      ok: false,
      error: 'telegram_refused',
      detail: `تلگرام نپذیرفت: ${description ?? 'بدون توضیح'}`,
    },
    422,
  );

const conflict = (c: Ctx, error: string, detail: string) =>
  c.json({ ok: false, error, detail }, 409);

export function registerChannelPostRoutes(app: Hono<PostEnv>) {
  app.get('/api/v1/admin/channel-posts', async (c) => {
    const [posts, chats, required, bot] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${COLUMNS} FROM channel_posts
          ORDER BY COALESCE(sent_at, send_at, created_at) DESC, id DESC
          LIMIT 200`,
      ).all<PostRow>(),
      // Every channel posted to before, by the name it had last.
      c.env.DB.prepare(
        `SELECT DISTINCT ON (chat_id) chat_id, chat_title FROM channel_posts
          ORDER BY chat_id, created_at DESC`,
      ).all<{ chat_id: number; chat_title: string }>(),
      c.env.DB.prepare(`SELECT chat_ref, title FROM required_channels ORDER BY id`).all<{
        chat_ref: string;
        title: string;
      }>(),
      botUsername(c.env.DB),
    ]);
    return c.json({
      ok: true,
      botUsername: bot,
      items: (posts.results ?? []).map(shape),
      // What the channel picker offers: channels posted to before, and the
      // shop's own required channels. Anything else can be typed.
      chats: [
        ...new Map(
          [
            ...(chats.results ?? []).map((r) => ({ ref: String(r.chat_id), title: r.chat_title })),
            ...(required.results ?? []).map((r) => ({ ref: r.chat_ref, title: r.title })),
          ].map((c) => [c.ref, c]),
        ).values(),
      ],
    });
  });

  app.post('/api/v1/admin/channel-posts', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = PostCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    if (body.data.copyOf !== undefined) {
      const row = await c.env.DB.withSession(async (tx) => {
        const made = await tx
          .prepare(
            `INSERT INTO channel_posts
               (chat_id, chat_title, text, media_kind, media_file_id, buttons, created_by)
             -- Not the campaign: a resend is a new post and may want its own.
             -- Its buttons still point where the original's did until edited.
             SELECT chat_id, chat_title, text, media_kind, media_file_id, buttons, ?2
               FROM channel_posts WHERE id = ?1
             RETURNING id`,
          )
          .bind(body.data.copyOf, ident.email)
          .first<{ id: number }>();
        if (made) {
          await audit(
            tx,
            ident,
            'channel_post.copied',
            'CHANNEL_POST',
            String(made.id),
            null,
            {
              copy_of: body.data.copyOf,
            },
            null,
          );
        }
        return made;
      });
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true, id: Number(row.id) });
    }

    const rows = body.data.buttons ?? [];
    const unknown = await unknownCampaigns(c.env.DB, rows);
    if (unknown.length > 0) {
      return c.json(
        { ok: false, error: 'unknown_campaign', detail: `کمپین پیدا نشد: ${unknown.join('، ')}` },
        400,
      );
    }
    const chat = await viaTelegram(c, (call) => resolveChat(call, body.data.chat!));
    if (!chat.ok) return chat.response;
    if ('error' in chat.value) return c.json({ ok: false, ...chat.value }, 422);
    const { chatId, title } = chat.value;

    const id = await c.env.DB.withSession(async (tx) => {
      const made = await tx
        .prepare(
          `INSERT INTO channel_posts (chat_id, chat_title, text, buttons, created_by)
           VALUES (?1, ?2, ?3, ?4::jsonb, ?5) RETURNING id`,
        )
        .bind(chatId, title, body.data.text ?? '', JSON.stringify(rows), ident.email)
        .first<{ id: number }>();
      await audit(
        tx,
        ident,
        'channel_post.created',
        'CHANNEL_POST',
        String(made!.id),
        null,
        {
          chat_id: chatId,
          chat_title: title,
        },
        null,
      );
      return Number(made!.id);
    });
    return c.json({ ok: true, id });
  });

  app.patch('/api/v1/admin/channel-posts/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const body = PostPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const post = await load(c.env.DB, id);
    if (!post) return c.json({ ok: false, error: 'not_found' }, 404);
    const db = c.env.DB;
    const op = body.data;

    switch (op.op) {
      case 'edit':
        return edit(c, post, op, ident);

      case 'schedule': {
        const now = Date.now();
        const at = op.sendAt === null ? now : Date.parse(op.sendAt);
        // A time already gone is a mistake to show, not «now»: moving it to
        // now would put a post meant for tomorrow into the channel this second.
        if (at < now - 60_000) {
          return c.json(
            {
              ok: false,
              error: 'in_the_past',
              detail: 'این زمان گذشته — برای همین حالا «ارسال الان» را بزن.',
            },
            400,
          );
        }
        if (at - now > MAX_SCHEDULE_AHEAD_MS) {
          return c.json(
            { ok: false, error: 'too_far', detail: 'بیشتر از ۹۰ روز جلوتر نمی‌شود.' },
            400,
          );
        }
        const done = await db.withSession(async (tx) => {
          const row = await tx
            .prepare(
              `UPDATE channel_posts
                  SET status = 'SCHEDULED', send_at = to_timestamp(?2 / 1000.0), error = NULL,
                      updated_at = now()
                WHERE id = ?1 AND status IN ('DRAFT', 'FAILED') AND preview_message_id IS NOT NULL
               RETURNING id`,
            )
            .bind(id, at)
            .first();
          if (row) {
            await audit(
              tx,
              ident,
              'channel_post.scheduled',
              'CHANNEL_POST',
              String(id),
              null,
              {
                send_at: new Date(at).toISOString(),
              },
              null,
            );
          }
          return row !== null;
        });
        if (done) return c.json({ ok: true });
        return post.preview_message_id === null
          ? conflict(c, 'not_previewed', 'اول پیش‌نمایش را در گروه گزارش ببین، بعد زمان‌بندی کن.')
          : conflict(c, 'not_schedulable', 'این پست در وضعیتی نیست که بشود زمان‌بندی‌اش کرد.');
      }

      case 'cancel': {
        const done = await db.withSession(async (tx) => {
          const row = await tx
            .prepare(
              `UPDATE channel_posts SET status = 'DRAFT', send_at = NULL, updated_at = now()
                WHERE id = ?1 AND status = 'SCHEDULED' RETURNING id`,
            )
            .bind(id)
            .first();
          if (row)
            await audit(
              tx,
              ident,
              'channel_post.cancelled',
              'CHANNEL_POST',
              String(id),
              null,
              null,
              null,
            );
          return row !== null;
        });
        return done
          ? c.json({ ok: true })
          : conflict(c, 'not_scheduled', 'این پست دیگر در صف نیست — شاید همین الان ارسال شد.');
      }

      case 'pin': {
        if (post.status !== 'SENT' || post.message_id === null) {
          return conflict(
            c,
            'not_in_channel',
            'فقط پستی را که در کانال است و شناسه‌اش معلوم است می‌شود سنجاق کرد.',
          );
        }
        const reply = await viaTelegram(c, (call) =>
          call(op.pinned ? 'pinChatMessage' : 'unpinChatMessage', {
            chat_id: post.chat_id,
            message_id: post.message_id,
            ...(op.pinned ? { disable_notification: true } : {}),
          }),
        );
        if (!reply.ok) return reply.response;
        if (reply.value.ok !== true) return refused(c, reply.value.description);
        await audit(
          db,
          ident,
          op.pinned ? 'channel_post.pinned' : 'channel_post.unpinned',
          'CHANNEL_POST',
          String(id),
          null,
          null,
          null,
        );
        return c.json({ ok: true });
      }

      case 'resolve': {
        const done = await db.withSession(async (tx) => {
          const row = await tx
            .prepare(
              op.inChannel
                ? `UPDATE channel_posts SET status = 'SENT', sent_at = now(), updated_at = now()
                    WHERE id = ?1 AND status = 'SENDING' AND claimed_at < now() - ${STUCK_AFTER}
                   RETURNING id`
                : `UPDATE channel_posts
                      SET status = 'FAILED', error = 'به کانال نرسید — اپراتور بررسی کرد.', updated_at = now()
                    WHERE id = ?1 AND status = 'SENDING' AND claimed_at < now() - ${STUCK_AFTER}
                   RETURNING id`,
            )
            .bind(id)
            .first();
          if (row) {
            await audit(
              tx,
              ident,
              'channel_post.resolved',
              'CHANNEL_POST',
              String(id),
              null,
              {
                in_channel: op.inChannel,
              },
              null,
            );
          }
          return row !== null;
        });
        return done
          ? c.json({ ok: true })
          : conflict(c, 'not_stuck', 'این پست گیر نکرده — یا هنوز در حال ارسال است یا تمام شده.');
      }

      case 'track': {
        const slug = `post-${id}`;
        const name = `پست کانال #${id}${
          post.text
            ? ` — ${post.text
                .replace(/<[^>]*>/g, '')
                .trim()
                .slice(0, 60)}`
            : ''
        }`.slice(0, 100);
        await db.withSession(async (tx) => {
          await tx
            .prepare(
              `INSERT INTO campaigns (slug, name, source, created_by)
               VALUES (?1, ?2, 'channel', ?3) ON CONFLICT (slug) DO NOTHING`,
            )
            .bind(slug, name, ident.email)
            .run();
          await tx
            .prepare(
              `UPDATE channel_posts SET campaign_slug = ?2, updated_at = now() WHERE id = ?1`,
            )
            .bind(id, slug)
            .run();
          await audit(
            tx,
            ident,
            'channel_post.tracked',
            'CHANNEL_POST',
            String(id),
            null,
            { campaign: slug },
            null,
          );
        });
        return c.json({ ok: true, campaign: slug });
      }
    }
  });

  /**
   * The picture or video, as the request body. Sent once to the reports group
   * for its `file_id` — the bot sends it on from there — and that message is
   * then removed, so the group holds previews and not uploads.
   */
  app.post('/api/v1/admin/channel-posts/:id/media', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const q = MediaQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const post = await load(c.env.DB, id);
    if (!post) return c.json({ ok: false, error: 'not_found' }, 404);
    if (!['DRAFT', 'SCHEDULED', 'FAILED'].includes(post.status)) {
      return conflict(c, 'not_editable', 'پستی که ارسال شده یا در حال ارسال است عوض نمی‌شود.');
    }
    const group = await reportsGroup(c.env.DB);
    if (group === null) {
      return conflict(
        c,
        'no_report_group',
        'اول باید گروه گزارش وصل باشد — پیش‌نمایش پست آن‌جا فرستاده می‌شود.',
      );
    }

    const max = q.data.kind === 'photo' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    const chunks = await readCappedBody(c.req.raw.body, max);
    if (chunks === 'too_large') {
      return c.json(
        {
          ok: false,
          error: 'too_large',
          detail: `فایل نباید از ${max / 1024 / 1024} مگابایت بزرگ‌تر باشد.`,
        },
        413,
      );
    }
    if (chunks === 'empty')
      return c.json({ ok: false, error: 'empty_upload', detail: 'فایلی فرستاده نشد.' }, 400);

    const sent = await viaTelegram(c, async (call) => {
      const form = new FormData();
      form.set('chat_id', String(group.chatId));
      if (group.threadId !== null) form.set('message_thread_id', String(group.threadId));
      form.set(q.data.kind, new Blob(chunks), q.data.name);
      const reply = await call(q.data.kind === 'photo' ? 'sendPhoto' : 'sendVideo', form);
      const messageId = reply.result?.message_id;
      if (reply.ok === true && messageId !== undefined) {
        await call('deleteMessage', { chat_id: group.chatId, message_id: messageId }).catch(
          () => undefined,
        );
      }
      return reply;
    });
    if (!sent.ok) return sent.response;
    if (sent.value.ok !== true) return refused(c, sent.value.description);
    const file = attachmentOf(sent.value.result);
    if (file === null || file.kind === 'document') {
      return c.json(
        { ok: false, error: 'not_media', detail: 'تلگرام این فایل را عکس یا ویدیو نشناخت.' },
        422,
      );
    }

    const done = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `UPDATE channel_posts
              SET media_kind = ?2, media_file_id = ?3,
                  preview_chat_id = NULL, preview_message_id = NULL, reply_markup = NULL,
                  status = 'DRAFT', send_at = NULL, updated_at = now()
            WHERE id = ?1 AND status IN ('DRAFT', 'SCHEDULED', 'FAILED')
           RETURNING id`,
        )
        .bind(id, file.kind === 'photo' ? 'PHOTO' : 'VIDEO', file.fileId)
        .first();
      if (row) {
        await audit(
          tx,
          ident,
          'channel_post.media_set',
          'CHANNEL_POST',
          String(id),
          null,
          {
            kind: file.kind,
            size_bytes: file.sizeBytes,
          },
          null,
        );
      }
      return row !== null;
    });
    return done
      ? c.json({ ok: true, kind: file.kind })
      : conflict(c, 'sending', 'پست همین الان به ارسال رفت — فایل عوض نشد.');
  });

  /**
   * Posts the post, exactly as it will go out, into the reports group — and
   * that message is what the bot later copies into the channel.
   */
  app.post('/api/v1/admin/channel-posts/:id/preview', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const post = await load(c.env.DB, id);
    if (!post) return c.json({ ok: false, error: 'not_found' }, 404);
    if (post.status !== 'DRAFT' && post.status !== 'FAILED') {
      return conflict(
        c,
        'not_editable',
        'فقط پیش‌نویس یا پست ناموفق پیش‌نمایش می‌گیرد — پست زمان‌بندی‌شده را اول لغو کن.',
      );
    }
    const media = post.media_kind !== 'NONE';
    if (!media && post.text.trim() === '') {
      return c.json(
        { ok: false, error: 'empty', detail: 'پست بدون عکس و ویدیو متن لازم دارد.' },
        400,
      );
    }
    if (media && post.text.length > MAX_CAPTION) {
      return c.json(
        {
          ok: false,
          error: 'caption_too_long',
          detail: `متن زیر عکس یا ویدیو حداکثر ${MAX_CAPTION} کاراکتر است.`,
        },
        400,
      );
    }
    const group = await reportsGroup(c.env.DB);
    if (group === null) {
      return conflict(
        c,
        'no_report_group',
        'اول باید گروه گزارش وصل باشد — پیش‌نمایش آن‌جا فرستاده می‌شود.',
      );
    }
    const markup = markupOf(post.buttons, await botUsername(c.env.DB));
    if (markup === 'no_bot_username') {
      return conflict(
        c,
        'no_bot_username',
        'نام کاربری ربات هنوز ثبت نشده، پس لینک کمپین ساخته نمی‌شود.',
      );
    }

    const base = {
      chat_id: group.chatId,
      ...(group.threadId === null ? {} : { message_thread_id: group.threadId }),
      parse_mode: 'HTML',
      ...(markup === null ? {} : { reply_markup: markup }),
    };
    const sent = await viaTelegram(c, (call) =>
      post.media_kind === 'PHOTO'
        ? call('sendPhoto', { ...base, photo: post.media_file_id, caption: post.text })
        : post.media_kind === 'VIDEO'
          ? call('sendVideo', { ...base, video: post.media_file_id, caption: post.text })
          : call('sendMessage', {
              ...base,
              text: post.text,
              link_preview_options: { is_disabled: true },
            }),
    );
    if (!sent.ok) return sent.response;
    const messageId = sent.value.result?.message_id;
    if (sent.value.ok !== true || messageId === undefined)
      return refused(c, sent.value.description);

    // Only if nothing changed while Telegram was answering: a preview of words
    // the post no longer has would be copied into the channel as if checked.
    const done = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `UPDATE channel_posts
              SET preview_chat_id = ?2, preview_message_id = ?3, reply_markup = ?4::jsonb,
                  status = 'DRAFT', error = NULL, updated_at = now()
            WHERE id = ?1 AND status IN ('DRAFT', 'FAILED') AND updated_at::text = ?5
           RETURNING id`,
        )
        .bind(
          id,
          group.chatId,
          messageId,
          markup === null ? null : JSON.stringify(markup),
          post.stamp,
        )
        .first();
      if (row) {
        await audit(
          tx,
          ident,
          'channel_post.previewed',
          'CHANNEL_POST',
          String(id),
          null,
          {
            preview_message_id: messageId,
          },
          null,
        );
      }
      return row !== null;
    });
    return done
      ? c.json({ ok: true })
      : conflict(c, 'changed', 'پست وسط پیش‌نمایش عوض شد — دوباره پیش‌نمایش بگیر.');
  });

  /** From the channel too, when it is there. The campaign and its numbers stay. */
  app.delete('/api/v1/admin/channel-posts/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const post = await load(c.env.DB, id);
    if (!post) return c.json({ ok: false, error: 'not_found' }, 404);
    if (post.status === 'SENDING') {
      return conflict(c, 'sending', 'پست در حال ارسال است — اول معلوم شود به کانال رسید یا نه.');
    }
    if (post.status === 'SENT' && post.message_id !== null) {
      const reply = await viaTelegram(c, (call) =>
        call('deleteMessage', { chat_id: post.chat_id, message_id: post.message_id }),
      );
      if (!reply.ok) return reply.response;
      // Already gone from the channel — deleted there by hand, or by a delete
      // whose answer was lost — is what was asked for.
      const gone = /message to delete not found/i.test(reply.value.description ?? '');
      if (reply.value.ok !== true && !gone) return refused(c, reply.value.description);
    }
    // Only in the state it was read in: a post the bot sent meanwhile is in
    // the channel now, and dropping its row would leave it there unreachable.
    const removed = await c.env.DB.prepare(
      `DELETE FROM channel_posts WHERE id = ?1 AND status = ?2 RETURNING id`,
    )
      .bind(id, post.status)
      .first();
    if (!removed) return conflict(c, 'changed', 'پست همین الان عوض شد — فهرست را تازه کن.');
    // After Telegram, on the bare connection: the message is already gone from
    // the channel, and a failed audit row must not bring the post back.
    await audit(
      c.env.DB,
      ident,
      'channel_post.deleted',
      'CHANNEL_POST',
      String(id),
      {
        chat_id: post.chat_id,
        status: post.status,
        text: post.text.slice(0, 500),
      },
      null,
      null,
    );
    return c.json({ ok: true });
  });
}

/**
 * A change to what a post says. Before it goes out, the post is simply saved —
 * and back to a draft that needs a new preview. Once it is in the channel, the
 * message there is edited, and the row follows only when Telegram agreed.
 */
async function edit(
  c: Ctx,
  post: PostRow,
  op: {
    chat?: string | undefined;
    text?: string | undefined;
    buttons?: Button[][] | undefined;
    removeMedia?: true | undefined;
  },
  ident: Ident,
): Promise<Response> {
  const db = c.env.DB;
  if (op.buttons) {
    const unknown = await unknownCampaigns(db, op.buttons);
    if (unknown.length > 0) {
      return c.json(
        { ok: false, error: 'unknown_campaign', detail: `کمپین پیدا نشد: ${unknown.join('، ')}` },
        400,
      );
    }
  }

  if (['DRAFT', 'SCHEDULED', 'FAILED'].includes(post.status)) {
    let chat: { chatId: number; title: string } | null = null;
    if (op.chat !== undefined) {
      const found = await viaTelegram(c, (call) => resolveChat(call, op.chat!));
      if (!found.ok) return found.response;
      if ('error' in found.value) return c.json({ ok: false, ...found.value }, 422);
      chat = found.value;
    }
    const done = await db.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `UPDATE channel_posts
              SET chat_id = COALESCE(?2, chat_id), chat_title = COALESCE(?3, chat_title),
                  text = COALESCE(?4, text), buttons = COALESCE(?5::jsonb, buttons),
                  media_kind = CASE WHEN ?6 THEN 'NONE' ELSE media_kind END,
                  media_file_id = CASE WHEN ?6 THEN NULL ELSE media_file_id END,
                  preview_chat_id = NULL, preview_message_id = NULL, reply_markup = NULL,
                  status = 'DRAFT', send_at = NULL, error = NULL, updated_at = now()
            WHERE id = ?1 AND status IN ('DRAFT', 'SCHEDULED', 'FAILED')
           RETURNING id`,
        )
        .bind(
          post.id,
          chat?.chatId ?? null,
          chat?.title ?? null,
          op.text ?? null,
          op.buttons ? JSON.stringify(op.buttons) : null,
          op.removeMedia === true,
        )
        .first();
      if (row) {
        await audit(
          tx,
          ident,
          'channel_post.edited',
          'CHANNEL_POST',
          String(post.id),
          {
            chat_id: post.chat_id,
            text: post.text,
            buttons: post.buttons,
          },
          {
            chat_id: chat?.chatId ?? post.chat_id,
            text: op.text ?? post.text,
            buttons: op.buttons ?? post.buttons,
            remove_media: op.removeMedia === true,
          },
          null,
        );
      }
      return row !== null;
    });
    return done
      ? c.json({ ok: true })
      : conflict(c, 'sending', 'پست همین الان به ارسال رفت — تغییر ذخیره نشد.');
  }

  if (post.status !== 'SENT' || post.message_id === null) {
    return conflict(
      c,
      'not_editable',
      'پستی که در حال ارسال است یا شناسه‌اش در کانال معلوم نیست ویرایش نمی‌شود.',
    );
  }
  if (op.chat !== undefined || op.removeMedia) {
    return c.json(
      {
        ok: false,
        error: 'invalid_body',
        detail: 'کانال و عکس یا ویدیوی پستی که ارسال شده عوض نمی‌شود.',
      },
      400,
    );
  }
  const text = op.text ?? post.text;
  const rows = op.buttons ?? post.buttons;
  const media = post.media_kind !== 'NONE';
  if (media ? text.length > MAX_CAPTION : text.trim() === '') {
    return c.json(
      {
        ok: false,
        error: 'invalid_body',
        detail: media
          ? `متن زیر عکس یا ویدیو حداکثر ${MAX_CAPTION} کاراکتر است.`
          : 'متن خالی نمی‌شود.',
      },
      400,
    );
  }
  const markup = markupOf(rows, await botUsername(db));
  if (markup === 'no_bot_username') {
    return conflict(
      c,
      'no_bot_username',
      'نام کاربری ربات هنوز ثبت نشده، پس لینک کمپین ساخته نمی‌شود.',
    );
  }
  const target = {
    chat_id: post.chat_id,
    message_id: post.message_id,
    parse_mode: 'HTML',
    // An empty keyboard removes the buttons; leaving the field out would keep them.
    reply_markup: markup ?? { inline_keyboard: [] },
  };
  const reply = await viaTelegram(c, (call) =>
    media
      ? call('editMessageCaption', { ...target, caption: text })
      : call('editMessageText', { ...target, text, link_preview_options: { is_disabled: true } }),
  );
  if (!reply.ok) return reply.response;
  // Nothing to change is not a failure: the channel already says this.
  if (reply.value.ok !== true && !/not modified/i.test(reply.value.description ?? '')) {
    return refused(c, reply.value.description);
  }
  await db
    .prepare(
      `UPDATE channel_posts SET text = ?2, buttons = ?3::jsonb, reply_markup = ?4::jsonb, updated_at = now()
        WHERE id = ?1 AND status = 'SENT'`,
    )
    .bind(post.id, text, JSON.stringify(rows), markup === null ? null : JSON.stringify(markup))
    .run();
  // After Telegram, on the bare connection: the channel already shows the edit.
  await audit(
    db,
    ident,
    'channel_post.edited_in_channel',
    'CHANNEL_POST',
    String(post.id),
    {
      text: post.text,
      buttons: post.buttons,
    },
    { text, buttons: rows },
    null,
  );
  return c.json({ ok: true });
}
