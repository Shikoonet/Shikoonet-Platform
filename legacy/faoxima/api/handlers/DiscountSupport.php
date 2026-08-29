<?php


declare(strict_types=1);

require_once __DIR__ . '/../lib/Db.php';

if (class_exists('MiniDiscount')) {
    return;
}

final class MiniDiscount
{
    const SECTIONS = ['buy', 'extend', 'volume', 'time', 'charge', 'all'];

    public static function valueType(array $row): string
    {
        $vt = strtolower(trim((string)($row['value_type'] ?? '')));
        if (in_array($vt, ['percent', 'amount', 'free'], true)) {
            return $vt;
        }
        return 'percent';
    }

    public static function describe(array $row): string
    {
        $vt = self::valueType($row);
        $val = (float)($row['price'] ?? 0);
        if ($vt === 'free')   return 'رایگان';
        if ($vt === 'amount') return number_format($val) . ' تومان';
        return rtrim(rtrim((string)$val, '0'), '.') . '٪';
    }

    public static function applyToPrice(array $row, float $price): float
    {
        $vt = self::valueType($row);
        $val = (float)($row['price'] ?? 0);
        if ($vt === 'free') {
            return 0.0;
        }
        if ($vt === 'amount') {
            $p = $price - $val;
            return $p < 0 ? 0.0 : $p;
        }
        $p = $price - (($price * $val) / 100);
        return $p < 0 ? 0.0 : $p;
    }

    public static function redeemGift(string $code, array $user): array
    {
        $code = trim($code);
        if ($code === '') {
            return ['ok' => false, 'reason' => '❌ کد هدیه را وارد کنید.'];
        }

        $row = FaoximaDb::fetchOne('SELECT * FROM Discount WHERE code = :c LIMIT 1', [':c' => $code]);
        if ($row === null) {
            return ['ok' => false, 'reason' => '❌ کد هدیه نامعتبر است.'];
        }

        $status = strtolower(trim((string)($row['status'] ?? '')));
        if ($status !== '' && $status !== 'active') {
            return ['ok' => false, 'reason' => '❌ این کد هدیه غیرفعال است.'];
        }

        $target = trim((string)($row['target_user'] ?? ''));
        if ($target !== '' && $target !== (string)$user['id']) {
            return ['ok' => false, 'reason' => '❌ کد هدیه نامعتبر است.'];
        }

        $expire = (int)($row['expire_at'] ?? 0);
        if ($expire !== 0 && time() >= $expire) {
            return ['ok' => false, 'reason' => '❌ زمان این کد هدیه به پایان رسیده است.'];
        }

        $limitUse  = (int)($row['limituse'] ?? 0);
        $limitUsed = (int)($row['limitused'] ?? 0);
        if ($limitUse > 0 && $limitUsed >= $limitUse) {
            return ['ok' => false, 'reason' => '❌ ظرفیت استفاده از این کد هدیه به پایان رسیده است.'];
        }

        $amount = (int) round((float)($row['price'] ?? 0));
        if ($amount <= 0) {
            return ['ok' => false, 'reason' => '❌ این کد هدیه مبلغی ندارد.'];
        }

        $credited = balance_atomic_credit($user['id'], $amount);
        if ($credited === false) {
            return ['ok' => false, 'reason' => '❌ خطا در واریز هدیه. لطفاً دوباره تلاش کنید.'];
        }

        update('Discount', 'limitused', (string)($limitUsed + 1), 'code', $code);
        self::recordConsumed($code, (string)$user['id'], 'gift');

        $newBalance = FaoximaDb::fetchScalar('SELECT Balance FROM user WHERE id = :u', [':u' => $user['id']]);
        $newBalance = $newBalance === null ? ((float)($user['Balance'] ?? 0) + $amount) : (float)$newBalance;

        return ['ok' => true, 'amount' => $amount, 'new_balance' => $newBalance];
    }

    public static function validateSell(string $code, string $section, string $codeProduct, string $codePanel, array $user, bool $blockIfUserDiscount = true): array
    {
        $code = trim($code);
        if ($code === '') {
            return ['ok' => false, 'reason' => '❌ کد تخفیف را وارد کنید.'];
        }

        $section = in_array($section, self::SECTIONS, true) ? $section : 'all';

        if ($blockIfUserDiscount && $section !== 'charge') {
            $userDiscount = (int)($user['pricediscount'] ?? 0);
            if ($userDiscount !== 0) {
                return ['ok' => false, 'reason' => '❌ شما تخفیف اختصاصی دارید و امکان استفاده از کد تخفیف وجود ندارد.'];
            }
        }

        $agent = (string)($user['agent'] ?? 'f');
        if ($codeProduct === '') $codeProduct = 'all';
        if ($codePanel === '')   $codePanel = '/all';

        $row = FaoximaDb::fetchOne(
            "SELECT * FROM DiscountSell
              WHERE codeDiscount = :code
                AND (code_product = :cp OR code_product = 'all')
                AND (code_panel = :cpan OR code_panel = '/all')
                AND (agent = :agent OR agent = 'allusers' OR agent = 'all')
                AND (COALESCE(NULLIF(section, ''), type, 'all') = :section
                     OR COALESCE(NULLIF(section, ''), type, 'all') = 'all')
                AND (status IS NULL OR status = '' OR status = 'active')
                AND (target_user IS NULL OR target_user = '' OR target_user = :uid)
              LIMIT 1",
            [
                ':code' => $code,
                ':cp' => $codeProduct,
                ':cpan' => $codePanel,
                ':agent' => $agent,
                ':section' => $section,
                ':uid' => (string)$user['id'],
            ]
        );
        if ($row === null) {
            return ['ok' => false, 'reason' => '❌ کد تخفیف نامعتبر است یا برای این بخش فعال نیست.'];
        }

        $expiry = (int)($row['time'] ?? 0);
        if ($expiry !== 0 && time() >= $expiry) {
            return ['ok' => false, 'reason' => '❌ زمان کد تخفیف به پایان رسیده است.'];
        }

        $limitTotal = (int)($row['limitDiscount'] ?? 0);
        if ($limitTotal > 0 && (int)($row['usedDiscount'] ?? 0) >= $limitTotal) {
            return ['ok' => false, 'reason' => '❌ ظرفیت استفاده از این کد تخفیف به پایان رسیده است.'];
        }

        $usedByUser = (int) FaoximaDb::fetchScalar(
            'SELECT COUNT(*) FROM Giftcodeconsumed WHERE id_user = :u AND code = :c',
            [':u' => (string)$user['id'], ':c' => $code]
        );
        $useUser = (int)($row['useuser'] ?? 0);
        if ($useUser > 0 && $usedByUser >= $useUser) {
            return ['ok' => false, 'reason' => '⭕️ سقف استفاده شما از این کد تخفیف پر شده است.'];
        }

        if ((string)($row['usefirst'] ?? '') === '1') {
            $invoiceCount = (int) FaoximaDb::fetchScalar(
                'SELECT COUNT(*) FROM invoice WHERE id_user = :u',
                [':u' => (string)$user['id']]
            );
            if ($invoiceCount != 0) {
                return ['ok' => false, 'reason' => '❌ این کد تخفیف فقط برای اولین خرید قابل استفاده است.'];
            }
        }

        $vt = self::valueType($row);
        $val = (float)($row['price'] ?? 0);
        if ($vt === 'percent' && ($val <= 0 || $val > 100)) {
            return ['ok' => false, 'reason' => '❌ درصد کد تخفیف نامعتبر است.'];
        }
        if ($vt === 'amount' && $val <= 0) {
            return ['ok' => false, 'reason' => '❌ مبلغ کد تخفیف نامعتبر است.'];
        }

        return [
            'ok'         => true,
            'code'       => $code,
            'value_type' => $vt,
            'value'      => $val,
            'label'      => self::describe($row),
            'row'        => $row,
        ];
    }

    public static function markSellUsed(string $code, array $user): void
    {
        $code = trim($code);
        if ($code === '') return;
        try {
            $pdo = FaoximaDb::pdo();
            $row = FaoximaDb::fetchOne('SELECT usedDiscount FROM DiscountSell WHERE codeDiscount = :c LIMIT 1', [':c' => $code]);
            $used = $row !== null ? ((int)($row['usedDiscount'] ?? 0) + 1) : 1;
            $pdo->prepare('UPDATE DiscountSell SET usedDiscount = :v WHERE codeDiscount = :c')
                ->execute([':v' => (string)$used, ':c' => $code]);
        } catch (Throwable $e) {
        }
        self::recordConsumed($code, (string)$user['id'], 'sell');
    }

    private static function recordConsumed(string $code, string $userId, string $kind): void
    {
        try {
            $pdo = FaoximaDb::pdo();
            $pdo->prepare('INSERT INTO Giftcodeconsumed (id_user, code, kind, consumed_at) VALUES (:u, :c, :k, :t)')
                ->execute([':u' => $userId, ':c' => $code, ':k' => $kind, ':t' => (string)time()]);
        } catch (Throwable $e) {
            try {
                $pdo = FaoximaDb::pdo();
                $pdo->prepare('INSERT INTO Giftcodeconsumed (id_user, code) VALUES (:u, :c)')
                    ->execute([':u' => $userId, ':c' => $code]);
            } catch (Throwable $e2) {
            }
        }
    }

    public static function releaseLastUnpaidDiscount(string $userId, ?string $discountCode = null, ?int $referenceTime = null): bool
    {
        $userId = trim($userId);
        if ($userId === '') return false;
        try {
            $pdo = FaoximaDb::pdo();
            if ($referenceTime !== null && $referenceTime > 0) {
                $low = (string)($referenceTime - 900);
                $high = (string)($referenceTime + 900);
            } else {
                $low = (string)(time() - 1800);
                $high = (string)(time() + 60);
            }
            $params = [':u' => $userId, ':lo' => $low, ':hi' => $high];
            $codeClause = '';
            if ($discountCode !== null && trim($discountCode) !== '') {
                $codeClause = ' AND code = :c';
                $params[':c'] = trim($discountCode);
            }
            $row = FaoximaDb::fetchOne(
                "SELECT id, code FROM Giftcodeconsumed
                  WHERE id_user = :u
                    AND kind = 'sell'
                    AND (released IS NULL OR released = 0)
                    AND consumed_at <> ''
                    AND CAST(consumed_at AS UNSIGNED) BETWEEN :lo AND :hi" . $codeClause . "
                  ORDER BY id DESC LIMIT 1",
                $params
            );
            if (!is_array($row) || empty($row['code'])) return false;

            $code = (string)$row['code'];
            $rowId = (int)$row['id'];

            $marked = $pdo->prepare('UPDATE Giftcodeconsumed SET released = 1 WHERE id = :id AND (released IS NULL OR released = 0)');
            $marked->execute([':id' => $rowId]);
            if ($marked->rowCount() < 1) return false;

            $dsRow = FaoximaDb::fetchOne('SELECT usedDiscount FROM DiscountSell WHERE codeDiscount = :c LIMIT 1', [':c' => $code]);
            if (is_array($dsRow)) {
                $used = (int)($dsRow['usedDiscount'] ?? 0) - 1;
                if ($used < 0) $used = 0;
                $pdo->prepare('UPDATE DiscountSell SET usedDiscount = :v WHERE codeDiscount = :c')
                    ->execute([':v' => (string)$used, ':c' => $code]);
            }
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }
}
