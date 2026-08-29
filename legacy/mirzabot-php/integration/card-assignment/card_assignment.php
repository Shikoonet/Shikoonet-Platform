<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hub_eligibility.php';
require_once __DIR__ . '/schema.php';

function cardAssignmentEnabled(): bool
{
    if (!function_exists('paymentHubIntegrationId')) {
        $hub = __DIR__ . '/../reconciliation/payment_hub.php';
        if (is_file($hub)) {
            require_once $hub;
        }
    }
    $flag = getenv('CARD_ASSIGNMENT_ENABLED');
    if ($flag !== '1' && $flag !== 'true' && $flag !== 'TRUE') {
        return false;
    }
    if (!function_exists('paymentHubIntegrationId')) {
        return false;
    }
    return in_array(paymentHubIntegrationId(), ['mirzabot-test', 'mirzabot-prod'], true);
}

function cardAssignmentNow(): int
{
    return time();
}

/** @return array{0: int, 1: int} Tehran calendar day [start, end) unix seconds */
function cardAssignmentTehranDayBounds(?int $now = null): array
{
    $tz = new DateTimeZone('Asia/Tehran');
    $dt = new DateTime('@' . ($now ?? cardAssignmentNow()));
    $dt->setTimezone($tz);
    $start = clone $dt;
    $start->setTime(0, 0, 0);
    $end = clone $start;
    $end->modify('+1 day');
    return [$start->getTimestamp(), $end->getTimestamp()];
}

if (!function_exists('getPaymentCardTempPath')) {
    function getPaymentCardTempPath(string $userId, string $orderId): string
    {
        $safeUser = preg_replace('/[^a-zA-Z0-9._-]/', '_', $userId);
        $safeOrder = preg_replace('/[^a-zA-Z0-9._-]/', '_', $orderId);
        return __DIR__ . '/../../data/payment-cards/' . $safeUser . '/' . $safeOrder . '.json';
    }
}

function cardAssignmentPersistOrderCardState(string $userId, string $orderId, string $cardNumber, string $cardName): void
{
    if (!function_exists('paymentHubPatchCardState')) {
        return;
    }
    paymentHubPatchCardState($userId, $orderId, [
        'card_number' => $cardNumber,
        'card_name' => $cardName,
        'assigned_at' => cardAssignmentNow(),
    ]);
}

function expireStaleCardLeases(?PDO $db = null): int
{
    global $pdo;
    $db = $db ?? $pdo;
    $now = cardAssignmentNow();
    $stmt = $db->prepare(
        "UPDATE card_assignment_leases
         SET status = 'EXPIRED', released_at = :now, updated_at = :now2
         WHERE status = 'ACTIVE' AND expires_at <= :now3"
    );
    $stmt->execute([':now' => $now, ':now2' => $now, ':now3' => $now]);
    return $stmt->rowCount();
}

function getActiveLeaseForUser(string $telegramUserId, ?PDO $db = null): ?array
{
    global $pdo;
    $db = $db ?? $pdo;
    $stmt = $db->prepare(
        "SELECT * FROM card_assignment_leases
         WHERE telegram_user_id = :uid AND status = 'ACTIVE'
         LIMIT 1"
    );
    $stmt->execute([':uid' => $telegramUserId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function getSuccessfulTransactionCountToday(string $cardNumber, ?PDO $db = null, ?int $now = null): int
{
    $digits = preg_replace('/\D/', '', $cardNumber);
    $stats = cardAssignmentLoadBalancingStats($db, $now);
    return $stats[$digits]['successful_today'] ?? 0;
}

function getSuccessfulTransactionCount7d(string $cardNumber, ?PDO $db = null, ?int $now = null): int
{
    $digits = preg_replace('/\D/', '', $cardNumber);
    $stats = cardAssignmentLoadBalancingStats($db, $now);
    return $stats[$digits]['successful_7d'] ?? 0;
}

function getSuccessfulTransactionCountLifetime(string $cardNumber, ?PDO $db = null): int
{
    $digits = preg_replace('/\D/', '', $cardNumber);
    $stats = cardAssignmentLoadBalancingStats($db);
    return $stats[$digits]['successful_lifetime'] ?? 0;
}

function getAssignmentsTodayCount(string $cardNumber, ?PDO $db = null, ?int $now = null): int
{
    $digits = preg_replace('/\D/', '', $cardNumber);
    $stats = cardAssignmentLoadBalancingStats($db, $now);
    return $stats[$digits]['assignments_today'] ?? 0;
}

function getLastAssignedAt(string $cardNumber, ?PDO $db = null): int
{
    $digits = preg_replace('/\D/', '', $cardNumber);
    $stats = cardAssignmentLoadBalancingStats($db);
    return $stats[$digits]['last_assigned_at'] ?? 0;
}

/**
 * Batch balancing counters for all cards (Tehran day/week boundaries).
 *
 * @return array<string, array{
 *   successful_today: int,
 *   successful_7d: int,
 *   successful_lifetime: int,
 *   assignments_today: int,
 *   last_assigned_at: int
 * }>
 */
function cardAssignmentLoadBalancingStats(?PDO $db = null, ?int $now = null): array
{
    global $pdo;
    $db = $db ?? $pdo;
    static $cache = [];
    $cacheKey = ($now ?? cardAssignmentNow()) . '@' . spl_object_id($db);
    if (isset($cache[$cacheKey])) {
        return $cache[$cacheKey];
    }

    [$dayStart, $dayEnd] = cardAssignmentTehranDayBounds($now);
    $weekStart = $dayStart - 6 * 86400;

    $stats = [];

    // successful_* come from Payment_report, not from lease completion.
    //
    // completeCardLeaseForOrder() only runs when the order is fulfilled through
    // index.php, so payments finished by the Hub webhook or by cron never marked
    // their lease COMPLETED — 50 of 1475 leases did. That left successful_today
    // flat at 0 for nearly every card, and because it is the first sort key a
    // card stuck at 0 outranked every card at 1 no matter how many payments it
    // had already taken that day. One card absorbed 43 of 177 payments on
    // 2026-08-17 this way. Payment_report records every paid order whichever
    // path fulfilled it, so it is the honest source.
    //
    // Payment_report.time is a fixed-width 'Y/m/d H:i:s' string written in
    // Tehran time (index.php:3 sets the timezone; php.ini is UTC). The bounds
    // are therefore formatted in Tehran explicitly — date() here would be 3.5h
    // out in any CLI or cron context. Fixed width and zero padded means string
    // order equals chronological order, verified against all 5859 rows.
    $tehran = new DateTimeZone('Asia/Tehran');
    $asTehran = static function (int $ts) use ($tehran): string {
        return (new DateTime('@' . $ts))->setTimezone($tehran)->format('Y/m/d H:i:s');
    };

    $paidStmt = $db->prepare(
        "SELECT assigned_card_number AS card_number,
                SUM(CASE WHEN time >= :day_start AND time < :day_end THEN 1 ELSE 0 END) AS successful_today,
                SUM(CASE WHEN time >= :week_start THEN 1 ELSE 0 END) AS successful_7d,
                COUNT(*) AS successful_lifetime
         FROM Payment_report
         WHERE payment_Status = 'paid' AND assigned_card_number <> ''
         GROUP BY assigned_card_number"
    );
    $paidStmt->execute([
        ':day_start' => $asTehran($dayStart),
        ':day_end' => $asTehran($dayEnd),
        ':week_start' => $asTehran($weekStart),
    ]);
    while ($row = $paidStmt->fetch(PDO::FETCH_ASSOC)) {
        $digits = preg_replace('/\D/', '', (string) ($row['card_number'] ?? ''));
        if (strlen($digits) !== 16) {
            continue;
        }
        $stats[$digits] = [
            'successful_today' => (int) ($row['successful_today'] ?? 0),
            'successful_7d' => (int) ($row['successful_7d'] ?? 0),
            'successful_lifetime' => (int) ($row['successful_lifetime'] ?? 0),
            'assignments_today' => 0,
            'last_assigned_at' => 0,
        ];
    }

    $assignStmt = $db->prepare(
        "SELECT card_number, COUNT(*) AS assignments_today
         FROM card_assignment_leases
         WHERE assigned_at >= :day_start AND assigned_at < :day_end
         GROUP BY card_number"
    );
    $assignStmt->execute([':day_start' => $dayStart, ':day_end' => $dayEnd]);
    while ($row = $assignStmt->fetch(PDO::FETCH_ASSOC)) {
        $digits = preg_replace('/\D/', '', (string) ($row['card_number'] ?? ''));
        if (strlen($digits) !== 16) {
            continue;
        }
        if (!isset($stats[$digits])) {
            $stats[$digits] = [
                'successful_today' => 0,
                'successful_7d' => 0,
                'successful_lifetime' => 0,
                'assignments_today' => 0,
                'last_assigned_at' => 0,
            ];
        }
        $stats[$digits]['assignments_today'] = (int) ($row['assignments_today'] ?? 0);
    }

    $lastStmt = $db->query(
        "SELECT card_number, COALESCE(MAX(assigned_at), 0) AS last_assigned_at
         FROM card_assignment_leases
         GROUP BY card_number"
    );
    if ($lastStmt !== false) {
        while ($row = $lastStmt->fetch(PDO::FETCH_ASSOC)) {
            $digits = preg_replace('/\D/', '', (string) ($row['card_number'] ?? ''));
            if (strlen($digits) !== 16) {
                continue;
            }
            if (!isset($stats[$digits])) {
                $stats[$digits] = [
                    'successful_today' => 0,
                    'successful_7d' => 0,
                    'successful_lifetime' => 0,
                    'assignments_today' => 0,
                    'last_assigned_at' => 0,
                ];
            }
            $stats[$digits]['last_assigned_at'] = (int) ($row['last_assigned_at'] ?? 0);
        }
    }

    $cache[$cacheKey] = $stats;
    return $stats;
}

/**
 * @return array<int, array{
 *   cardnumber: string,
 *   namecard: string,
 *   successful_today: int,
 *   successful_7d: int,
 *   successful_lifetime: int,
 *   assignments_today: int,
 *   last_assigned_at: int
 * }>
 */
function getEligibleAvailableCards(?PDO $db = null): array
{
    global $pdo;
    $db = $db ?? $pdo;

    $stmt = $db->query("SELECT cardnumber, namecard, status, last_assigned_at FROM card_number");
    if ($stmt === false) {
        return [];
    }

    $leasedCards = [];
    $leaseStmt = $db->query(
        "SELECT card_number FROM card_assignment_leases WHERE status = 'ACTIVE'"
    );
    if ($leaseStmt !== false) {
        while ($lr = $leaseStmt->fetch(PDO::FETCH_ASSOC)) {
            $leasedCards[preg_replace('/\D/', '', (string) $lr['card_number'])] = true;
        }
    }

    $stats = cardAssignmentLoadBalancingStats($db);
    $eligible = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $digits = preg_replace('/\D/', '', (string) ($row['cardnumber'] ?? ''));
        if (strlen($digits) !== 16) {
            continue;
        }
        $status = strtolower((string) ($row['status'] ?? 'active'));
        if ($status !== '' && $status !== 'active') {
            continue;
        }
        if (!cardAssignmentIsHubEligible($digits)) {
            continue;
        }
        if (isset($leasedCards[$digits])) {
            continue;
        }
        $cardStats = $stats[$digits] ?? [
            'successful_today' => 0,
            'successful_7d' => 0,
            'successful_lifetime' => 0,
            'assignments_today' => 0,
            'last_assigned_at' => 0,
        ];
        $lastFromCol = isset($row['last_assigned_at']) ? (int) $row['last_assigned_at'] : 0;
        $eligible[] = [
            'cardnumber' => $digits,
            'namecard' => (string) ($row['namecard'] ?? ''),
            'successful_today' => $cardStats['successful_today'],
            'successful_7d' => $cardStats['successful_7d'],
            'successful_lifetime' => $cardStats['successful_lifetime'],
            'assignments_today' => $cardStats['assignments_today'],
            'last_assigned_at' => max($lastFromCol, $cardStats['last_assigned_at']),
        ];
    }

    return $eligible;
}

/**
 * @param array<int, array{
 *   cardnumber: string,
 *   namecard: string,
 *   successful_today: int,
 *   successful_7d: int,
 *   successful_lifetime: int,
 *   assignments_today: int,
 *   last_assigned_at: int
 * }> $cards
 */
function cardAssignmentPickLeastUsed(array $cards): ?array
{
    if ($cards === []) {
        return null;
    }
    usort($cards, static function (array $a, array $b): int {
        // A queue: whoever was assigned longest ago goes first, and a card just
        // handed out drops to the back. last_assigned_at leads deliberately.
        //
        // Leading with successful_today instead — "give it to whoever has been
        // paid least today" — lets a card sitting at zero outrank every card at
        // one no matter how many times it was already handed out minutes ago. A
        // freshly added card then swallows payment after payment until it caught
        // up. That is the behaviour this ordering replaces.
        //
        // A card never used before has last_assigned_at = 0, so it goes first
        // once and then rotates like everyone else.
        //
        // The trade-off, plainly: this equalises how often a card is offered,
        // not how often it is paid. About 72% of offers get paid and whether a
        // customer pays is a property of the customer, not of the card, so paid
        // counts track offers closely — closely, not exactly. successful_* stay
        // below last_assigned_at, where they only separate cards never used.
        foreach (['last_assigned_at', 'successful_today', 'successful_7d', 'successful_lifetime', 'assignments_today'] as $key) {
            if ($a[$key] !== $b[$key]) {
                return $a[$key] <=> $b[$key];
            }
        }
        return strcmp($a['cardnumber'], $b['cardnumber']);
    });
    return $cards[0];
}

function createCardLease(
    string $telegramUserId,
    string $orderId,
    string $cardNumber,
    string $cardName,
    ?PDO $db = null,
    ?int $assignedAt = null
): ?array {
    global $pdo;
    $db = $db ?? $pdo;
    $now = $assignedAt ?? cardAssignmentNow();
    $expires = $now + CARD_LEASE_TTL_SECONDS;
    $digits = preg_replace('/\D/', '', $cardNumber);

    $stmt = $db->prepare(
        "INSERT INTO card_assignment_leases
         (telegram_user_id, order_id, card_number, card_name, status, assigned_at, expires_at, created_at, updated_at)
         VALUES (:uid, :oid, :card, :cname, 'ACTIVE', :assigned, :expires, :created, :updated)"
    );
    try {
        $stmt->execute([
            ':uid' => $telegramUserId,
            ':oid' => $orderId,
            ':card' => $digits,
            ':cname' => $cardName,
            ':assigned' => $now,
            ':expires' => $expires,
            ':created' => $now,
            ':updated' => $now,
        ]);
    } catch (PDOException $e) {
        if ((int) ($e->errorInfo[1] ?? 0) === 1062) {
            return null;
        }
        throw $e;
    }

    $db->prepare(
        "UPDATE card_number SET last_assigned_at = :ts WHERE cardnumber = :card OR cardnumber = :card2"
    )->execute([':ts' => $now, ':card' => $digits, ':card2' => $cardNumber]);

    return [
        'telegram_user_id' => $telegramUserId,
        'order_id' => $orderId,
        'card_number' => $digits,
        'card_name' => $cardName,
        'status' => 'ACTIVE',
        'assigned_at' => $now,
        'expires_at' => $expires,
    ];
}

/**
 * @return array{ok: bool, cardnumber?: string, namecard?: string, reused?: bool, error?: string}
 */
function getOrAssignCard(string $telegramUserId, string $orderId, ?PDO $db = null): array
{
    global $pdo;
    $db = $db ?? $pdo;

    $db->beginTransaction();
    try {
        expireStaleCardLeases($db);

        $existing = getActiveLeaseForUser($telegramUserId, $db);
        if ($existing !== null) {
            if ((int) $existing['expires_at'] <= cardAssignmentNow()) {
                $now = cardAssignmentNow();
                $upd = $db->prepare(
                    "UPDATE card_assignment_leases SET status = 'EXPIRED', released_at = :now, updated_at = :now2
                     WHERE id = :id AND status = 'ACTIVE'"
                );
                $upd->execute([':now' => $now, ':now2' => $now, ':id' => $existing['id']]);
                $existing = null;
            }
        }

        if ($existing !== null) {
            $db->commit();
            return [
                'ok' => true,
                'cardnumber' => (string) $existing['card_number'],
                'namecard' => (string) $existing['card_name'],
                'reused' => true,
                'expires_at' => (int) $existing['expires_at'],
            ];
        }

        $cards = getEligibleAvailableCards($db);
        $picked = cardAssignmentPickLeastUsed($cards);
        if ($picked === null) {
            $db->rollBack();
            return ['ok' => false, 'error' => 'all_cards_leased_or_unavailable'];
        }

        $lease = createCardLease(
            $telegramUserId,
            $orderId,
            $picked['cardnumber'],
            $picked['namecard'],
            $db
        );
        if ($lease === null) {
            $db->rollBack();
            return ['ok' => false, 'error' => 'lease_conflict'];
        }

        $db->commit();
        return [
            'ok' => true,
            'cardnumber' => $picked['cardnumber'],
            'namecard' => $picked['namecard'],
            'reused' => false,
            'expires_at' => $lease['expires_at'],
        ];
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        error_log('card-assignment: getOrAssignCard failed: ' . $e->getMessage());
        return ['ok' => false, 'error' => 'internal'];
    }
}

function cardAssignmentAllCardsBusyMessage(): string
{
    return "⏳ همه کارت‌های پرداخت در حال استفاده هستند. لطفاً چند دقیقه دیگر دوباره تلاش کنید.";
}

/** Idempotent — safe to call from every successful-payment path. */
function completeCardLeaseForOrder(string $orderId, ?PDO $db = null): bool
{
    global $pdo;
    $db = $db ?? $pdo;
    $report = select('Payment_report', '*', 'id_order', $orderId, 'select');
    if (!$report) {
        return false;
    }
    if (($report['Payment_Method'] ?? '') !== 'cart to cart') {
        return false;
    }

    $now = cardAssignmentNow();
    $userId = (string) $report['id_user'];

    $stmt = $db->prepare(
        "SELECT * FROM card_assignment_leases
         WHERE telegram_user_id = :uid AND status = 'ACTIVE'
         ORDER BY id DESC LIMIT 1"
    );
    $stmt->execute([':uid' => $userId]);
    $lease = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$lease) {
        $stmt2 = $db->prepare(
            "SELECT * FROM card_assignment_leases WHERE order_id = :oid LIMIT 1"
        );
        $stmt2->execute([':oid' => $orderId]);
        $lease = $stmt2->fetch(PDO::FETCH_ASSOC);
        if ($lease && $lease['status'] === 'COMPLETED') {
            return true;
        }
        if (!$lease) {
            return false;
        }
    }

    if ($lease['status'] === 'COMPLETED') {
        return true;
    }

    if ($lease['status'] !== 'ACTIVE') {
        return false;
    }

    $upd = $db->prepare(
        "UPDATE card_assignment_leases
         SET status = 'COMPLETED', completed_at = :now, released_at = :now2, updated_at = :now3
         WHERE id = :id AND status = 'ACTIVE'"
    );
    $upd->execute([
        ':now' => $now,
        ':now2' => $now,
        ':now3' => $now,
        ':id' => $lease['id'],
    ]);
    return $upd->rowCount() > 0 || $lease['status'] === 'COMPLETED';
}

/** @return array<string, int> card last4 => successful count today */
function cardAssignmentSuccessfulCountsToday(?PDO $db = null): array
{
    global $pdo;
    $db = $db ?? $pdo;
    $stats = cardAssignmentLoadBalancingStats($db);
    $out = [];
    foreach ($stats as $digits => $row) {
        if (($row['successful_today'] ?? 0) > 0) {
            // PHP casts a numeric-string array key to int, so cast it back
            // before substr(). Latent since this helper was written; it only
            // became reachable once successful_today stopped being always zero.
            $out['****' . substr((string) $digits, -4)] = $row['successful_today'];
        }
    }
    ksort($out);
    return $out;
}

/**
 * DEV diagnostic: full pool audit with eligibility and exclusion reasons.
 *
 * @return array<int, array<string, mixed>>
 */
function cardAssignmentBuildAuditReport(?PDO $db = null, ?int $now = null): array
{
    global $pdo;
    $db = $db ?? $pdo;
    $hub = cardAssignmentHubEligibleMap();
    $stats = cardAssignmentLoadBalancingStats($db, $now);

    $leased = [];
    $leaseStmt = $db->query("SELECT card_number FROM card_assignment_leases WHERE status = 'ACTIVE'");
    if ($leaseStmt !== false) {
        while ($lr = $leaseStmt->fetch(PDO::FETCH_ASSOC)) {
            $leased[preg_replace('/\D/', '', (string) $lr['card_number'])] = true;
        }
    }

    $rows = $db->query("SELECT cardnumber, namecard, status, last_assigned_at FROM card_number ORDER BY cardnumber");
    $report = [];
    if ($rows === false) {
        return $report;
    }

    while ($row = $rows->fetch(PDO::FETCH_ASSOC)) {
        $digits = preg_replace('/\D/', '', (string) ($row['cardnumber'] ?? ''));
        if (strlen($digits) !== 16) {
            continue;
        }
        $botActive = strtolower((string) ($row['status'] ?? 'active')) === 'active' || ($row['status'] ?? '') === '';
        $hubMapped = isset($hub[$digits]);
        $financialAccount = $hubMapped ? ($hub[$digits]['financial_account_id'] ?? '') : '';
        $accountActive = $hubMapped && strtoupper((string) ($hub[$digits]['account_status'] ?? '')) === 'ACTIVE';
        $activeLease = isset($leased[$digits]);
        $eligible = $botActive && $hubMapped && $accountActive && !$activeLease;

        $reasons = [];
        if (!$botActive) {
            $reasons[] = 'bot_inactive';
        }
        if (!$hubMapped) {
            $reasons[] = 'not_hub_mapped';
        } elseif (!$accountActive) {
            $reasons[] = 'account_inactive';
        }
        if ($activeLease) {
            $reasons[] = 'active_lease';
        }
        if ($eligible) {
            $reasons[] = 'eligible';
        }

        $cardStats = $stats[$digits] ?? [
            'successful_today' => 0,
            'successful_7d' => 0,
            'successful_lifetime' => 0,
            'assignments_today' => 0,
            'last_assigned_at' => 0,
        ];
        $lastFromCol = isset($row['last_assigned_at']) ? (int) $row['last_assigned_at'] : 0;

        $report[] = [
            'card_number' => $digits,
            'card_masked' => '****' . substr($digits, -4),
            'bot_active' => $botActive,
            'hub_mapped' => $hubMapped,
            'financial_account' => $financialAccount,
            'account_active' => $accountActive,
            'active_lease' => $activeLease,
            'eligible' => $eligible,
            'successful_today' => $cardStats['successful_today'],
            'successful_7d' => $cardStats['successful_7d'],
            'successful_lifetime' => $cardStats['successful_lifetime'],
            'assignments_today' => $cardStats['assignments_today'],
            'last_assigned_at' => max($lastFromCol, $cardStats['last_assigned_at']),
            'exclusion_reason' => implode('|', $reasons),
        ];
    }

    return $report;
}
