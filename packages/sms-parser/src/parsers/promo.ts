import type { NormalizedSms } from '@shikoo/contracts';
import { type SmsParser, unmatched } from './types.js';

const PROMO_PATTERNS: RegExp[] = [
  /تبلیغ|پیشنهاد\s+ویژه|تخفیف|قرعه‌کشی/i,
  /promo|offer|discount|cashback|win|reward/i,
];

export const promoParser: SmsParser = {
  id: 'generic-promo',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    return PROMO_PATTERNS.some((re) => re.test(input.text));
  },
  parse(_input: NormalizedSms) {
    return unmatched('PROMOTIONAL', { parserId: this.id, parserVersion: this.version });
  },
};
