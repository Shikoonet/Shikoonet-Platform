import type { NormalizedSms } from '@hub/contracts';
import { type SmsParser, unmatched } from './types.js';

export const unknownParser: SmsParser = {
  id: 'fallback-unknown',
  version: '1.0.0',
  supports(_input: NormalizedSms): boolean {
    return true;
  },
  parse(_input: NormalizedSms) {
    return unmatched('UNKNOWN', { parserId: this.id, parserVersion: this.version });
  },
};
