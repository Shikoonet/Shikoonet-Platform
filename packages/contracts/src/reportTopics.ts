/**
 * The kinds of report the shop sends, and the topic each one goes to.
 *
 * Sam, 2026-09-03: one Telegram group with a topic per kind — «مثل میرزا و
 * فاکسیما». Both legacy bots do exactly that, and neither uses separate
 * channels: there is ONE destination, `setting.Channel_Report`, and a
 * `message_thread_id` tells the reports apart.
 *
 * ## The names are legacy's, deliberately
 *
 * They are `topicid.report` verbatim, which means `packages/migrate` has
 * already carried the ids of a live shop into `settings(scope='bot',
 * key='topic_<report>')` — a shop migrating from MySQL keeps the topics it
 * already had, rather than being handed ten new ones and a group with twenty.
 *
 * That is also why they are not renamed to something tidier in English:
 * `topic_porsantreport` is a strange name for referral commission, and it is
 * the name in the database.
 *
 * ## What we do NOT send
 *
 * Sam also asked for media, support-question and fraud reports. Neither legacy
 * bot has the first two — there is no eleventh key in either codebase — and
 * support tickets are a feature Sam himself decided on 2026-08-22 not to build.
 * Fraud goes to `otherreport`, which is where legacy puts everything that has
 * no topic of its own.
 *
 * ## The order is legacy's too
 *
 * `admin.php:2371-2513` creates the topics in this sequence, and a forum group
 * lists its topics in creation order — so this is the order an operator sees
 * in the group. Sam, 2026-09-19: the group has to look exactly like mirzabot's.
 */
export const REPORT_KINDS = [
  /** A completed new purchase. Legacy: `function.php:1023`. */
  'buyreport',
  /** Renewals and add-ons on a service that already exists. */
  'otherservice',
  /** A free trial account handed out. */
  'reporttest',
  /** Everything without a topic of its own — new customers, blocks, fraud. */
  'otherreport',
  /** Failures. Ours are `alert()`'s, which is already a reports channel. */
  'errorreport',
  /** Money in, whatever the gateway. Legacy sends one per payment method. */
  'paymentreport',
  /** Referral commission paid. */
  'porsantreport',
  /** The nightly figures. */
  'reportnight',
  /** Expiry and low-volume notices actually delivered to customers. */
  'reportcron',
  /** The database dump `apps/bot/src/backup.ts` posts every three hours. */
  'backupfile',
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/** The settings key holding one kind's topic id, in the spelling the importer writes. */
export function reportTopicKey(kind: ReportKind): string {
  return `topic_${kind}`;
}

/**
 * The Persian titles the topics are created with.
 *
 * `lang/fa.php` verbatim — spaces where legacy has spaces, not the ZWNJ a
 * careful writer would use. A shop moving from mirzabot must see the same
 * words in the same group. Sam, 2026-09-19. Faoxima hardcodes the same
 * strings inline.
 */
export const REPORT_TOPIC_TITLES: Record<ReportKind, string> = {
  buyreport: '🛍 گزارش های خرید',
  otherservice: '📌 گزارش خرید خدمات',
  reporttest: '🔑 گزارش اکانت تست',
  otherreport: '⚙️ سایر گزارشات',
  errorreport: '❌ گزارش خطا ها',
  paymentreport: '💰 گزارش مالی',
  porsantreport: '🎁 گزارش پورسانت ها',
  reportnight: '🌙 گزارش شبانه',
  reportcron: '📝 گزارش اطلاع رسانی ها',
  backupfile: '🤖 بکاپ ربات',
};
