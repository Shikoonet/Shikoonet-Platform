/**
 * A bank talking about its own SMS service — not about money.
 *
 * Melli, 2026-09-21 16:36: «به میزان 80.0 درصد از حجم بسته پیامکی "شارژ 300
 * پیامکی" خود را استفاده کرده اید … با اتمام بسته فعلی سیستم ارسال پیامکی شما
 * غیرفعال خواهد شد». No amount, no balance, so every money parser passed and
 * `fallback-unknown` filed it under «ناخوانده» — one red row on the coverage
 * page, and nothing said that in three days the Melli deposits would stop
 * arriving at all.
 *
 * Classified IGNORED (filtered on purpose, no row) rather than PROMOTIONAL:
 * an advert is decided and forgotten; this one `ingest.ts` raises to a human.
 * The evidence carries what that human needs — which bank, how much of the
 * quota is gone, which package — and never the account number in the body.
 */
import type { NormalizedSms } from '@shikoo/contracts';
import { type SmsParser, unmatched } from './types.js';

const PACKAGE = /بسته\s*(?:ی\s*)?پیامکی|سرویس\s*پیام\s*کوتاه/;
const QUOTA = /(\d+(?:\.\d+)?)\s*درصد/;
const DEACTIVATE = /غیرفعال|شارژ\s*اتوماتیک|بسته\s*رزرو/;
const PACKAGE_NAME = /["«]([^"»]+)["»]/;

export const serviceNoticeParser: SmsParser = {
  id: 'bank-service-notice',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    // A deposit «بابت بسته پیامکی» has an amount and belongs to a money parser.
    return PACKAGE.test(input.text) && (QUOTA.test(input.text) || DEACTIVATE.test(input.text)) && !/ریال|تومان/.test(input.text);
  },
  parse(input: NormalizedSms) {
    const percent = QUOTA.exec(input.text)?.[1];
    return {
      ...unmatched('IGNORED', { parserId: this.id, parserVersion: this.version, confidence: 0.9 }),
      evidence: {
        bank: /بانک\s*ملی/.test(input.text) ? 'MELLI' : 'UNKNOWN',
        kind: 'sms-quota',
        ...(percent !== undefined ? { percentUsed: Number(percent) } : {}),
        ...(PACKAGE_NAME.exec(input.text)?.[1] !== undefined ? { package: PACKAGE_NAME.exec(input.text)![1]!.trim() } : {}),
      },
    };
  },
};
