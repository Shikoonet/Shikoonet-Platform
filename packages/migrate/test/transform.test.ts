import { describe, expect, it } from 'vitest';
import * as t from '../src/transform.js';

describe('legacy 0/1 flags', () => {
  // The values mysql2 actually produces for `tinyint(1)`, which is where this
  // came from: `roll_Status !== '0'` compared a number to a string, was true for
  // every row, and let 963 customers past the rules gate.
  it('reads a tinyint the driver returned as a number', () => {
    expect(t.legacyBool(0, 'f')).toBe(false);
    expect(t.legacyBool(1, 'f')).toBe(true);
  });

  it('still reads the string form, in case the driver changes', () => {
    expect(t.legacyBool('0', 'f')).toBe(false);
    expect(t.legacyBool('1', 'f')).toBe(true);
    expect(t.legacyBool(' 1 ', 'f')).toBe(true);
  });

  it('treats never-set as false', () => {
    expect(t.legacyBool(null, 'f')).toBe(false);
    expect(t.legacyBool(undefined, 'f')).toBe(false);
    expect(t.legacyBool('', 'f')).toBe(false);
  });

  it('throws rather than defaulting, and names the field', () => {
    // The `isReseller` rule: a wrong `false` here is invisible, and «a customer
    // silently skipped a gate» is not a failure anyone reports. `2` is the
    // realistic one — a third state added to the legacy column by a panel we do
    // not control.
    expect(() => t.legacyBool(2, 'user.roll_Status')).toThrow(/user\.roll_Status/);
    expect(() => t.legacyBool('yes', 'user.roll_Status')).toThrow(/unmapped legacy flag/);
    expect(() => t.legacyBool({}, 'user.roll_Status')).toThrow();
  });
});

describe('money', () => {
  it('converts Toman to IRR', () => {
    expect(t.tomanToIrr('100000')).toBe(1_000_000n);
    expect(t.tomanToIrr(150000)).toBe(1_500_000n);
  });

  it('carries a negative balance through unchanged', () => {
    // Production user 314985971. The migration must reproduce this, not fix it.
    expect(t.tomanToIrr('-5940000')).toBe(-59_400_000n);
  });

  it('treats missing as zero, not as a failure', () => {
    expect(t.tomanToIrr(null)).toBe(0n);
    expect(t.tomanToIrr('')).toBe(0n);
  });

  it('refuses anything that is not an integer amount', () => {
    expect(() => t.tomanToIrr('100,000')).toThrow(t.TransformError);
    expect(() => t.tomanToIrr('12.5')).toThrow(t.TransformError);
    expect(() => t.tomanToIrr('۱۰۰۰')).toThrow(t.TransformError); // Persian digits
  });

  it('stays exact past the float safe range', () => {
    const huge = '10000000000000000'; // 1e16 Toman
    expect(t.tomanToIrr(huge)).toBe(100_000_000_000_000_000n);
  });
});

describe('identity', () => {
  it('parses telegram ids', () => {
    expect(t.telegramId('6714538686')).toBe(6714538686n);
    expect(t.telegramId(' 358123646 ')).toBe(358123646n);
  });

  it('refuses a non-numeric or missing id', () => {
    expect(() => t.telegramId('abc')).toThrow(t.TransformError);
    expect(() => t.telegramId(null)).toThrow(t.TransformError);
  });

  it('drops the NOT_USERNAME sentinel', () => {
    expect(t.username('NOT_USERNAME')).toBeNull();
    expect(t.username('Rezaahmadi2494')).toBe('Rezaahmadi2494');
    expect(t.username('  ')).toBeNull();
  });

  it('drops the "none" phone sentinel', () => {
    expect(t.phone('none')).toBeNull();
    expect(t.phone('09121234567')).toBe('09121234567');
  });
});

describe('status mapping', () => {
  it('maps every payment status present in production', () => {
    expect(t.paymentStatus('paid')).toBe('PAID');
    expect(t.paymentStatus('expire')).toBe('EXPIRED');
    expect(t.paymentStatus('reject')).toBe('REJECTED');
    expect(t.paymentStatus('Unpaid')).toBe('PENDING');
    expect(t.paymentStatus('processing')).toBe('PROCESSING');
    expect(t.paymentStatus('waiting')).toBe('AWAITING_REVIEW');
  });

  it('collapses both spellings of disabled', () => {
    // 'disabledn' is a real production value, from a bug in the PHP writer.
    expect(t.subscriptionStatus('disabled')).toBe('DISABLED');
    expect(t.subscriptionStatus('disabledn')).toBe('DISABLED');
  });

  describe('an invoice read as a sale', () => {
    /**
     * A service that was later switched off was still bought. Reading these as
     * anything but COMPLETED is how «درآمد کل» loses most of the shop's money —
     * `disabled` alone is 241 of the 7,889 invoices in the production dump.
     */
    it('counts every delivered service as a completed sale', () => {
      for (const legacy of ['active', 'send_on_hold', 'disabled', 'disabledn',
        'disablebyadmin', 'removeTime', 'removevolume', 'removebyuser']) {
        expect(t.invoiceOrderStatus(legacy)).toBe('COMPLETED');
      }
    });

    /**
     * This is the assertion that is not about accounting.
     *
     * `AWAITING_PAYMENT` is the literal reading of `unpaid`, and it is the one
     * value this function must never return: `expireUnpaidOrders` sweeps every
     * AWAITING_PAYMENT order past its `expires_at` and, in the same
     * transaction, messages the customer on Telegram. Every unpaid row in the
     * dump is long past its day, so the first worker tick after an import
     * would send 1,886 expiry notices about carts abandoned in a bot we do not
     * run. Nothing else in the suite would go red if this changed.
     */
    it('never leaves an imported invoice waiting to be paid', () => {
      expect(t.invoiceOrderStatus('unpaid')).toBe('EXPIRED');
    });

    it('keeps a failed provisioning failed', () => {
      expect(t.invoiceOrderStatus('Unsuccessful')).toBe('FAILED');
    });

    it('refuses a status it has not been taught', () => {
      // Inherited from `subscriptionStatus` rather than re-declared, so a new
      // legacy spelling cannot become a silent COMPLETED here while stopping
      // the migration one column over.
      expect(() => t.invoiceOrderStatus('paid_maybe')).toThrow(t.TransformError);
    });
  });

  it('stops the migration on an unmapped value instead of guessing', () => {
    expect(() => t.paymentStatus('something_new')).toThrow(t.TransformError);
    expect(() => t.subscriptionStatus('')).toThrow(t.TransformError);
    expect(() => t.orderKind('extra_seats')).toThrow(t.TransformError);
  });

  it('reads the reseller flag', () => {
    expect(t.isReseller('n')).toBe(true);
    expect(t.isReseller('f')).toBe(false);
  });

  it("counts 'n2' as a reseller too", () => {
    // index.php:299 pins the domain to ["n","n2","f"]. Testing only 'n' and 'f'
    // is what let the second tier read as an ordinary customer: on a user that
    // is a lost reseller, on a product one that anybody can buy.
    expect(t.isReseller('n2')).toBe(true);
  });

  /**
   * Which tier, not merely whether. `is_reseller` folds 'n' and 'n2' onto one
   * boolean, and `agent` is in the importer's `claimed` list — so it does not
   * reach `legacy_attrs` either. The tier was not stored anywhere: it was lost
   * at import, and the shop charges two different prices for it
   * (`{"f":"50000","n":"5000","n2":"5000"}` on the VIP panel).
   *
   * `users.reseller_tier` has existed since migration 0047 and the panel reads
   * it; this is the half that fills it in.
   */
  it('keeps WHICH reseller tier, not just that there is one', () => {
    expect(t.resellerTier('n')).toBe('n');
    expect(t.resellerTier('n2')).toBe('n2');
    // Not a reseller is not tier one — it is no tier, and the column is NULL.
    expect(t.resellerTier('f')).toBeNull();
    expect(t.resellerTier(null)).toBeNull();
    expect(t.resellerTier('')).toBeNull();
  });

  it('refuses an unknown agent when reading the tier, exactly as the flag does', () => {
    expect(() => t.resellerTier('reseller')).toThrow(/unmapped legacy agent value/);
    expect(() => t.resellerTier('N2')).toThrow(/unmapped legacy agent value/);
  });

  it('refuses an agent value outside the legacy domain', () => {
    // A wrong `false` here is invisible — the product simply never appears for
    // the customer it was meant for — so it must stop the migration instead.
    expect(() => t.isReseller('reseller')).toThrow(/unmapped legacy agent value/);
    expect(() => t.isReseller('N')).toThrow(/unmapped legacy agent value/);
  });

  it('treats an absent agent as an ordinary customer', () => {
    expect(t.isReseller(null)).toBe(false);
    expect(t.isReseller(undefined)).toBe(false);
    expect(t.isReseller('  ')).toBe(false);
  });

  it('maps user status in either capitalisation', () => {
    // Production holds both spellings: 'Active' on 11,192 rows, 'active' on 5.
    expect(t.userStatus('Active')).toBe('ACTIVE');
    expect(t.userStatus('active')).toBe('ACTIVE');
    expect(t.userStatus('block')).toBe('BLOCKED');
    expect(() => t.userStatus('banned')).toThrow(t.TransformError);
  });
});

describe('step token', () => {
  it('promotes only the operation prefix', () => {
    expect(t.stepToken('getconfigafterpay|6714538686_28ed')).toEqual({
      operationType: 'getconfigafterpay',
      raw: 'getconfigafterpay|6714538686_28ed',
    });
  });

  it('keeps the literal 0 rows without inventing an operation', () => {
    expect(t.stepToken('0')).toEqual({ operationType: null, raw: '0' });
  });

  it('handles the 22 null rows', () => {
    expect(t.stepToken(null)).toEqual({ operationType: null, raw: null });
  });
});

describe('luhn', () => {
  it('accepts the card the bot hands out', () => {
    expect(t.isLuhnValid('5054161706277062')).toBe(true);
  });

  it('rejects the hub copy that differs by one digit', () => {
    // The proof behind BUGS-FOR-ADMIN.md item 4.
    expect(t.isLuhnValid('5054161716277062')).toBe(false);
  });

  it('rejects non-digits and wrong lengths', () => {
    expect(t.isLuhnValid('5054-1617-0627-7062')).toBe(false);
    expect(t.isLuhnValid('123')).toBe(false);
    expect(t.isLuhnValid('')).toBe(false);
  });
});

describe('timestamps', () => {
  it('accepts the bot string format', () => {
    expect(t.tehranString('2026/08/11 23:26:33', 'time')).toBe('2026/08/11 23:26:33');
  });

  it('accepts the MySQL DATETIME form and normalises the separator', () => {
    // revenue_adjustment_log.created_at is a DATETIME, also in Tehran local.
    expect(t.tehranString('2026-08-11 21:58:13', 'created_at')).toBe('2026/08/11 21:58:13');
  });

  it('treats the MySQL zero date as absent rather than year 0', () => {
    expect(t.tehranString('0000-00-00 00:00:00', 'time')).toBeNull();
  });

  it('refuses a format it was not built for', () => {
    expect(() => t.tehranString('11/08/2026 23:26', 'time')).toThrow(t.TransformError);
    expect(() => t.tehranString('yesterday', 'time')).toThrow(t.TransformError);
  });

  it('accepts epoch seconds inside the plausible window', () => {
    expect(t.epochSeconds('1786478188', 'time_sell')).toBe('1786478188');
  });

  it('catches milliseconds pasted into a seconds column', () => {
    expect(() => t.epochSeconds('1786478188000', 'time_sell')).toThrow(t.TransformError);
    expect(() => t.epochSeconds('0', 'time_sell')).toThrow(t.TransformError);
  });

  it('builds DateStyle-independent SQL', () => {
    expect(t.sqlExpr.tehranString('$1')).toContain("'YYYY/MM/DD HH24:MI:SS'");
    expect(t.sqlExpr.tehranString('$1')).toContain("AT TIME ZONE 'Asia/Tehran'");
  });
});

describe('hub epoch columns', () => {
  it('passes numbers straight through', () => {
    expect(t.hubEpochMillis(1786094815726, 'created_at')).toBe(1786094815726);
  });

  it('rescues the three access_users rows holding a UTC datetime string', () => {
    // SQLite does not enforce column types, so an INTEGER column holds text.
    expect(t.hubEpochMillis('2026-08-04 20:32:43', 'access_users.created_at')).toBe(
      Date.UTC(2026, 7, 4, 20, 32, 43),
    );
  });

  it('accepts a numeric string', () => {
    expect(t.hubEpochMillis('1786094815726', 'created_at')).toBe(1786094815726);
  });

  it('refuses anything else rather than storing a wrong instant', () => {
    expect(() => t.hubEpochMillis('soon', 'created_at')).toThrow(t.TransformError);
  });

  it('knows which columns are timestamps', () => {
    expect(t.HUB_EPOCH_COLUMNS.has('bank_timestamp')).toBe(true);
    expect(t.HUB_EPOCH_COLUMNS.has('amount_irr')).toBe(false);
  });
});

describe('legacyAttrs', () => {
  it('keeps what no column claimed and drops legacy empties', () => {
    const row = { id: '1', username: 'a', score: '5', pagenumber: '0', token: null };
    expect(t.legacyAttrs(row, ['id', 'username'], ['token'])).toEqual({ score: '5' });
  });
});

describe('json', () => {
  it('falls back instead of throwing on malformed input', () => {
    expect(t.json('{"volume":true}')).toEqual({ volume: true });
    expect(t.json('not json')).toEqual({});
    expect(t.json(null, [])).toEqual([]);
  });
});

describe('maskPan', () => {
  it('keeps the issuer and the tail, and removes the middle', () => {
    expect(t.maskPan('5022291621285129')).toBe('502229\u2022\u2022\u2022\u2022\u2022\u20225129');
  });

  it('leaves anything that is not a card number alone', () => {
    // Hiding a malformed value would hide the very thing the reader has to fix.
    for (const v of ['', '12345', 'not-a-card', '502229162128512X']) {
      expect(t.maskPan(v)).toBe(v);
    }
  });

  it('never returns something that still passes Luhn as a card', () => {
    const masked = t.maskPan('5022291621285129');
    expect(masked.replace(/\D/g, '')).not.toBe('5022291621285129');
    expect(t.isLuhnValid(masked.replace(/\D/g, ''))).toBe(false);
  });
});
