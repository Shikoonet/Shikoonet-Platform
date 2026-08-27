/**
 * How a plan's button is written, when the shop wants to write it itself.
 *
 * The plans screen draws one button per row of `product_plans`, and its label
 * has always been the admin-typed `name` with the price appended — «۱ ماهه ·
 * نامحدود · چند کاربره — 350,000 تومان». That is one long run of text, and a
 * shop that wants «۱ ماهه | نامحدود | 350,000 تومان» has no way to ask for it
 * except by retyping every name.
 *
 * ## Why this is not in `botTexts.ts`
 *
 * Two reasons, and the file says the first one itself: button labels are not
 * there, because a chrome button means something by where it sits and
 * `botKeyboard.ts` owns the layout. But `botKeyboard.ts` excludes this one too
 * — a plan row is DATA, there is a variable number of them, and their position
 * is generated. Neither file owns «how is a generated row's label composed».
 *
 * The second reason is the placeholder contract. `checkOverride` requires an
 * override to use EXACTLY the declared slots, because dropping `{handle}` from
 * the support screen silently removes the only way to reach a human. Here the
 * opposite is true: choosing which parts appear IS the feature. A shop that
 * does not want the volume on the button drops `{volume}`, and that is an
 * answer rather than a mistake. Putting this in `bot_texts` would have meant
 * weakening a rule that protects thirty other screens.
 *
 * ## Why unset means «exactly what it says today»
 *
 * The default is not a template. It is `null`, and `null` renders through the
 * path that has always drawn these buttons — including the rule that a name
 * already quoting its own price does not get the price appended twice. Every
 * migrated product has the price typed into its name (`money.ts:55`), so a
 * default of `{name} — {price}` would put the number on the button twice for
 * every one of them the moment this shipped. A shop opts in, or nothing about
 * its screens changes.
 */

/**
 * Where the template is stored.
 *
 * Here rather than in the bot because the panel writes this row and the bot
 * reads it, and a key spelled differently at the two ends is a setting that
 * saves and never applies — with nothing on either screen to say so.
 */
export const PLAN_LABEL_SETTING = { scope: 'shop', key: 'plan_button_template' } as const;

/** A slot, as an admin writes it. Same spelling as `botTexts`. */
const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * What a shop may put on a plan button.
 *
 * `name` and `badge` are the admin's own text; the other four are derived from
 * the plan's columns, which is the point — `duration_days` and `volume_gb` are
 * already there and already correct, and a label built from them cannot drift
 * from what the customer is actually buying the way a hand-typed name can.
 */
export const PLAN_LABEL_TOKENS = {
  name: 'نام پلن، همان‌طور که در پنل نوشته شده',
  badge: 'نشان پلن — «🆕»، «🔥 آف»',
  duration: 'مدت — «1 ماهه»، «7 روزه»',
  volume: 'حجم — «100 گیگ»، «نامحدود»',
  users: 'تعداد کاربر — «چند کاربره»',
  price: 'قیمت با تخفیف کاربر — «350,000 تومان»',
} as const;

export type PlanLabelToken = keyof typeof PLAN_LABEL_TOKENS;

const KNOWN = new Set(Object.keys(PLAN_LABEL_TOKENS));

/** What a shop is most likely to want, offered as one click in the panel. */
export const PLAN_LABEL_PRESETS: readonly string[] = [
  '{duration} | {volume} | {price}',
  '{duration} | {volume} {price}',
  '{badge} {duration} · {volume} — {price}',
  '{name} | {price}',
];

/** A button label is one line on a phone, shared with nothing else. */
export const PLAN_LABEL_MAX = 96;

export interface PlanLabelProblem {
  /** Said to the operator, in the language the panel is written in. */
  message: string;
  /** The offending slot, when one slot is to blame. */
  token?: string;
}

/**
 * Whether a template may be saved.
 *
 * Refuses rather than warns, and refuses on the way IN. A template reaches the
 * send path on every shop screen; the moment to find out that `{prise}` is not
 * a token is while somebody is typing it, not while a customer is looking at
 * the literal characters `{prise}` on a button.
 */
export function checkPlanLabel(template: string): PlanLabelProblem | null {
  const t = template.trim();
  if (t === '') return { message: 'قالب خالی است.' };
  if (t.length > PLAN_LABEL_MAX) {
    return { message: `قالب نباید بیشتر از ${PLAN_LABEL_MAX} نویسه باشد.` };
  }
  if (/[\r\n\t]/.test(t)) {
    return { message: 'قالب باید یک خط باشد — دکمه یک خط بیشتر ندارد.' };
  }

  const used: string[] = [];
  for (const match of t.matchAll(TOKEN)) {
    const token = match[1]!;
    if (!KNOWN.has(token)) {
      return { message: `«{${token}}» جزو فیلدهای مجاز نیست.`, token };
    }
    used.push(token);
  }
  if (used.length === 0) {
    // Otherwise every plan draws the same button and the customer cannot tell
    // two of them apart — the exact bug `planMenu` was rewritten to fix.
    return { message: 'قالب باید دست‌کم یکی از فیلدها را داشته باشد.' };
  }
  return null;
}

/**
 * The label, with the shop's slots filled in.
 *
 * Values arrive already formatted: the money and the digits belong to the bot,
 * which is the only place that knows this customer's discount. This function
 * does the substitution and the tidying, and nothing else.
 *
 * A slot the caller has no value for collapses to nothing, and the separators
 * left stranded around it collapse with it — a plan with unlimited volume under
 * `{duration} | {volume} | {price}` must not draw «1 ماهه |  | 350,000 تومان».
 */
export function renderPlanLabel(
  template: string,
  values: Partial<Record<PlanLabelToken, string>>,
): string {
  const filled = template.replace(TOKEN, (whole, token: string) =>
    KNOWN.has(token) ? (values[token as PlanLabelToken] ?? '').trim() : whole,
  );

  return (
    filled
      // A separator with nothing after it but another separator. The space
      // BEFORE it is deliberately not consumed: eating that too turns
      // «1 ماهه |  | 350,000» into «1 ماهه| 350,000», which is the bug this
      // line exists to prevent rather than cause.
      .replace(/([|·—-])\s*(?=[|·—-])/g, '')
      .replace(/^[\s|·—-]+/, '')
      .replace(/[\s|·—-]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
