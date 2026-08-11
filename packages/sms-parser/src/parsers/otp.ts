import type { NormalizedSms } from '@shikoo/contracts';
import { type SmsParser, unmatched } from './types.js';

// Persian + English OTP markers. Treated as OTP unless an amount + balance pattern is also present.
const OTP_PATTERNS: RegExp[] = [
  /رمز\s*(?:یکبار|موقت|پویا|دومرحله|otp)/i,
  /کد\s*(?:تایید|تأیید|فعالسازی|ورود|احراز)/i,
  /otp|one[-\s]?time|verification\s+code|2fa/i,
  /کد\s*:?\s*\d{4,8}/,
];

export const otpParser: SmsParser = {
  id: 'generic-otp',
  version: '1.0.0',
  supports(input: NormalizedSms): boolean {
    return OTP_PATTERNS.some((re) => re.test(input.text));
  },
  parse(_input: NormalizedSms) {
    return unmatched('OTP', { parserId: this.id, parserVersion: this.version });
  },
};
