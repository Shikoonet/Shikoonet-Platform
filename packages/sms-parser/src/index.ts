export { normalizeText, extractAmount, extractAllAmounts, parseIrr } from './normalize.js';
export type { NormalizedNumber, NormalizedText } from './normalize.js';
export { parseSms, REGISTRY } from './parsers/registry.js';
// The redaction half of the OTP work. `isAuthenticationOtp` is what the
// classifier asks; `redactOtp` is what the PERSISTENCE boundary asks, and the
// two are deliberately different in temperament — see the header of
// `parsers/otp.ts`. Exported because `apps/ingest-worker` has to reach the
// second one before it writes a row.
export { isAuthenticationOtp, mightCarryOtp, redactOtp } from './parsers/otp.js';
export type { OtpRedaction } from './parsers/otp.js';
export type { SmsParser } from './parsers/types.js';
export { compilePatterns, compilePatternSource, validatePattern } from './parsers/dbPatterns.js';
export type { BankSmsPatternRow, FallbackParser } from './parsers/dbPatterns.js';
export { jalaliToGregorianEpochMs, gregorianToJalali } from './jalali.js';
export { normalizeIdentifier, maskIdentifier } from './identifier.js';
