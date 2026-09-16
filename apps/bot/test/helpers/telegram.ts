/**
 * A TelegramApi with everything stubbed, so a test overrides only the one or
 * two calls it is actually about. Adding a method to the interface then costs
 * one line here instead of one per fake.
 *
 * Lived in `poll.test.ts` until 2026-08-19, when a second suite needed it. Its
 * own docstring was already the argument for putting it somewhere shared.
 */

import type { TelegramApi } from '../../src/telegram.js';

export function stubApi(overrides: Partial<TelegramApi> = {}): TelegramApi {
  return {
    getMe: async () => ({ username: 'Test_Shikoo_bot' }),
    getUpdates: async () => [],
    sendMessage: async () => undefined,
    sendPhoto: async () => undefined,
    sendPhotoBytes: async () => undefined,
    sendDocument: async () => undefined,
    editMessageText: async () => undefined,
    deleteMessage: async () => undefined,
    forwardMessage: async () => undefined,
    answerCallbackQuery: async () => undefined,
    getChatMember: async () => 'member',
    ...overrides,
  };
}
