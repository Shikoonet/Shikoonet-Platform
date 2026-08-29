<?php


declare(strict_types=1);

require_once __DIR__ . '/BaseHandler.php';

final class PendingPaymentsHandler extends BaseHandler
{

    public function handle(): void
    {
        $this->requireMethod('GET');

        $userId = (string)($this->user['id'] ?? '');
        if ($userId === '') {
            FaoximaResponse::ok(['pending' => []]);
        }

        try {
            $rows = FaoximaDb::fetchAll(
                "SELECT id, id_order, time, price, payment_Status, Payment_Method,
                        dec_not_confirmed, crypto_currency, crypto_tx_hash
                   FROM Payment_report
                  WHERE id_user = :u
                    AND payment_Status IN ('Unpaid','waiting','AwaitingHash','pending')
                    AND Payment_Method IN ('plisio','nowpayment','digitaltron','arze digital offline','cart to cart','carttocart_pv','iranpay1')
                    AND source = 'miniapp'
                  ORDER BY id DESC
                  LIMIT 8",
                [':u' => $userId]
            );
        } catch (Throwable $e) {
            FaoximaLogger::userFacing('PendingPayments fetch failed', ['err' => $e->getMessage()]);
            FaoximaResponse::ok(['pending' => []]);
        }

        if (!is_array($rows) || empty($rows)) {
            FaoximaResponse::ok(['pending' => []]);
        }

        $now = time();
        $pending = [];
        foreach ($rows as $r) {
            $createdAt = $this->parseLegacyTime((string)($r['time'] ?? ''));
            if ($createdAt === null) continue;

            $method = (string)$r['Payment_Method'];
            $methodLc = strtolower($method);
            $hashVal = trim((string)($r['crypto_tx_hash'] ?? ''));
            $decVal = trim((string)($r['dec_not_confirmed'] ?? ''));

            if ($methodLc === 'arze digital offline') {
                if ($hashVal === '') continue;
            } elseif (in_array($methodLc, ['cart to cart', 'carttocart_pv'], true)) {
                if ($decVal === '') continue;
            } elseif (in_array($methodLc, ['plisio', 'nowpayment', 'digitaltron', 'iranpay1'], true)) {
                if ($decVal === '') continue;
            }

            $windowSec = $this->methodWindow($method, false);
            $expiresAt = $createdAt + $windowSec;
            if ($expiresAt < $now) continue;

            $pending[] = [
                'order_id'      => (string)$r['id_order'],
                'method'        => $method,
                'amount'        => (int)$r['price'],
                'status'        => (string)$r['payment_Status'],
                'created_at'    => $createdAt,
                'expires_at'    => $expiresAt,
                'remaining_sec' => max(0, $expiresAt - $now),
                'currency_code' => trim((string)($r['crypto_currency'] ?? '')) ?: null,
            ];
        }

        FaoximaResponse::ok(['pending' => $pending]);
    }


    private function methodWindow(string $method, bool $iranian): int
    {
        return 1800;
    }


    private function parseLegacyTime(string $raw): ?int
    {
        $raw = trim($raw);
        if ($raw === '') return null;
        if (ctype_digit($raw)) return (int)$raw;

        $raw = strtr($raw, [
            '۰'=>'0','۱'=>'1','۲'=>'2','۳'=>'3','۴'=>'4',
            '۵'=>'5','۶'=>'6','۷'=>'7','۸'=>'8','۹'=>'9',
        ]);

        $ts = strtotime(str_replace('/', '-', $raw));
        return $ts === false ? null : $ts;
    }
}
