<?php
declare(strict_types=1);

/**
 * Card assignment unit/integration tests (DEV module).
 * Run: php integration/card-assignment/tests/card_assignment_test.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../hub_eligibility.php';
require_once __DIR__ . '/../card_assignment.php';

$passed = 0;
$failed = 0;

function assert_true(bool $cond, string $label): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
        echo "PASS  $label\n";
    } else {
        $failed++;
        echo "FAIL  $label\n";
    }
}

function assert_eq($expected, $actual, string $label): void
{
    assert_true($expected === $actual, $label . ' (expected ' . json_encode($expected) . ', got ' . json_encode($actual) . ')');
}
// The pool is a queue: the card assigned longest ago goes first, and a card just
// handed out drops to the back. Nothing about how much a card has been paid may
// jump that queue. These tests pin that policy.

/** One candidate row, as getEligibleAvailableCards() would produce it. */
function q(
    string $card,
    int $lastAssignedAt,
    int $paidToday = 0,
    int $paid7d = 0,
    int $paidLifetime = 0,
    int $assignmentsToday = 0
): array {
    return [
        'cardnumber' => $card,
        'namecard' => 'T',
        'successful_today' => $paidToday,
        'successful_7d' => $paid7d,
        'successful_lifetime' => $paidLifetime,
        'assignments_today' => $assignmentsToday,
        'last_assigned_at' => $lastAssignedAt,
    ];
}

/** Runs the queue for $n turns, stamping each pick as just-used. */
function runQueue(array $pool, int $n, int $clock = 100000): array
{
    $picks = [];
    for ($i = 0; $i < $n; $i++) {
        $pick = cardAssignmentPickLeastUsed($pool)['cardnumber'] ?? null;
        if ($pick === null) {
            break;
        }
        $picks[] = $pick;
        foreach ($pool as $k => $c) {
            if ($c['cardnumber'] === $pick) {
                $pool[$k]['last_assigned_at'] = $clock++;
            }
        }
    }
    return $picks;
}

// TEST 8 — the card idle longest goes first, even if it is the busiest today.
$cards = [
    q('1111111111111111', 300, 1),
    q('2222222222222222', 100, 9),
    q('3333333333333333', 200, 0),
];
assert_eq('2222222222222222', cardAssignmentPickLeastUsed($cards)['cardnumber'] ?? null,
    'TEST 8 the card assigned longest ago goes first');

// TEST 9 — a card just used drops to the back.
$after = runQueue($cards, 2);
assert_eq('2222222222222222', $after[0] ?? null, 'TEST 9 first turn goes to the oldest');
assert_true(($after[1] ?? null) !== '2222222222222222', 'TEST 9 and it does not get the next turn too');

// TEST 12 — payment history must not jump the queue. This is the regression the
// queue exists to prevent: a card paid nothing but used a second ago used to
// outrank a card paid nine times but idle for an hour.
$hot = [
    q('1111111111111111', 100, 9, 40, 400),
    q('2222222222222222', 900, 0, 0, 0),
];
assert_eq('1111111111111111', cardAssignmentPickLeastUsed($hot)['cardnumber'] ?? null,
    'TEST 12 a zero-paid card that was just used does not jump the queue');

// TEST 13 — a full rotation hands out equal counts, in strict order.
$pool = [
    q('1111111111111111', 10),
    q('2222222222222222', 20),
    q('3333333333333333', 30),
    q('4444444444444444', 40),
];
$picks = runQueue($pool, 20);
$counts = array_count_values($picks);
assert_eq(0, max($counts) - min($counts), 'TEST 13 twenty turns over four cards land equally');
assert_eq(str_repeat('1234', 5), implode('', array_map(fn(string $p): string => $p[0], $picks)),
    'TEST 13 and they rotate in order');

// TEST 14 — a newly added card takes one turn, then queues like the rest. It
// must not absorb turn after turn to "catch up" on history.
$withNew = [
    q('1111111111111111', 1000, 5, 30, 300),
    q('2222222222222222', 1001, 5, 30, 300),
    q('9999999999999999', 0),
];
$firstRound = runQueue($withNew, 3);
assert_eq('9999999999999999', $firstRound[0] ?? null, 'TEST 14 a card never used before goes first');
assert_eq(3, count(array_unique($firstRound)), 'TEST 14 and the first round gives every card exactly one turn');

// TEST 15 — several new cards tie on last_assigned_at and are taken in a
// deterministic order, one at a time, so a batch intake spreads evenly.
$batch = [q('3333333333333333', 0), q('1111111111111111', 0), q('2222222222222222', 0)];
$intake = runQueue($batch, 6);
assert_eq(3, count(array_unique(array_slice($intake, 0, 3))), 'TEST 15 a batch of new cards is taken one at a time');
assert_eq(0, max(array_count_values($intake)) - min(array_count_values($intake)), 'TEST 15 and ends up even');

// Stable card_number tie-breaker
$cardTie = [q('2222222222222222', 0), q('1111111111111111', 0)];
assert_eq('1111111111111111', cardAssignmentPickLeastUsed($cardTie)['cardnumber'] ?? null, 'stable card_number tie-breaker');
assert_eq(600, CARD_LEASE_TTL_SECONDS, 'CARD_LEASE_TTL_SECONDS is 600');

$bounds = cardAssignmentTehranDayBounds(strtotime('2026-08-07 15:00:00 Asia/Tehran'));
assert_true($bounds[1] - $bounds[0] === 86400, 'Tehran day bounds span 24h');

// DB-backed tests when CARD_ASSIGNMENT_TEST_DSN is set
$dsn = getenv('CARD_ASSIGNMENT_TEST_DSN');
if ($dsn) {
    $pdo = new PDO($dsn, getenv('CARD_ASSIGNMENT_TEST_USER') ?: null, getenv('CARD_ASSIGNMENT_TEST_PASS') ?: null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
    putenv('CARD_ASSIGNMENT_ENABLED=true');
    putenv('PAYMENT_HUB_INTEGRATION_ID=mirzabot-test');

    cardAssignmentEnsureSchema();

    echo "\n-- integration tests (DB) --\n";

    $pdo->exec("DELETE FROM card_assignment_leases");
    $pdo->exec("DELETE FROM Payment_report WHERE id_order LIKE 'test-%'");

    $now = cardAssignmentNow();

    // TEST 1 — first user gets an eligible card
    $first = getOrAssignCard('user-a', 'test-order-1', $pdo);
    assert_true(($first['ok'] ?? false) && !($first['reused'] ?? true), 'TEST 1 first user assigned eligible card');
    assert_true(strlen($first['cardnumber'] ?? '') === 16, 'TEST 1 card number is 16 digits');

    // TEST 2 — same user reuse
    $reuse = getOrAssignCard('user-a', 'test-order-2', $pdo);
    assert_true(($reuse['ok'] ?? false) && ($reuse['reused'] ?? false), 'TEST 2 same user reuse');
    assert_eq($first['cardnumber'] ?? null, $reuse['cardnumber'] ?? null, 'TEST 2 same card');

    // TEST 3 — TTL not extended on retry
    $expiresBefore = (int) ($reuse['expires_at'] ?? 0);
    $retry = getOrAssignCard('user-a', 'test-order-3', $pdo);
    assert_eq($expiresBefore, (int) ($retry['expires_at'] ?? -1), 'TEST 3 TTL not extended on retry');

    // TEST 4 — expiry marks EXPIRED
    $pdo->exec("UPDATE card_assignment_leases SET status = 'EXPIRED', released_at = $now WHERE telegram_user_id = 'user-a'");
    createCardLease('user-a', 'test-order-exp', '5047061674560137', 'Test', $pdo, $now - 700);
    $pdo->exec("UPDATE card_assignment_leases SET expires_at = " . ($now - 100) . " WHERE order_id = 'test-order-exp'");
    expireStaleCardLeases($pdo);
    $stmt = $pdo->query("SELECT status FROM card_assignment_leases WHERE order_id = 'test-order-exp'");
    assert_eq('EXPIRED', $stmt ? $stmt->fetchColumn() : null, 'TEST 4 expiry marks EXPIRED');

    // TEST 5 — payment completion releases lease
    $pdo->exec("DELETE FROM card_assignment_leases");
    createCardLease('user-pay', 'test-order-pay', '5047061674560137', 'Test', $pdo, $now);
    $pdo->exec(
        "INSERT INTO Payment_report (id_user,id_order,time,price,payment_Status,Payment_Method,id_invoice,assigned_card_number,assigned_card_name)
         VALUES ('user-pay','test-order-pay','2026/01/01',1000,'paid','cart to cart','inv','5047061674560137','Test')"
    );
    completeCardLeaseForOrder('test-order-pay', $pdo);
    $stmt = $pdo->query("SELECT status FROM card_assignment_leases WHERE order_id = 'test-order-pay'");
    assert_eq('COMPLETED', $stmt ? $stmt->fetchColumn() : null, 'TEST 5 payment completion releases lease');

    // TEST 6 — next user may receive released card
    $pdo->exec("UPDATE card_assignment_leases SET status = 'COMPLETED', completed_at = $now, released_at = $now WHERE order_id = 'test-order-pay'");
    $second = getOrAssignCard('user-b', 'test-order-6', $pdo);
    assert_true($second['ok'] ?? false, 'TEST 6 next user after completion gets a card');

    // TEST 7 — one card per active user
    $pdo->exec("DELETE FROM card_assignment_leases");
    createCardLease('user-x', 'test-order-x', '5047061674560137', 'Test', $pdo, $now);
    $other = getOrAssignCard('user-y', 'test-order-y', $pdo);
    assert_true(($other['ok'] ?? false) && ($other['cardnumber'] ?? '') !== '5047061674560137', 'TEST 7 active card not assigned to second user');

    // TEST 10 — expired lease does not increment successful_today
    $pdo->exec("DELETE FROM card_assignment_leases");
    createCardLease('user-exp', 'test-order-10', '5047061674560137', 'Test', $pdo, $now - 700);
    $pdo->exec("UPDATE card_assignment_leases SET status = 'EXPIRED', released_at = $now WHERE order_id = 'test-order-10'");
    $before = getSuccessfulTransactionCountToday('5047061674560137', $pdo);
    assert_eq(0, $before, 'TEST 10 expired lease does not count toward successful_today');

    // TEST 11 — idempotent completion count
    $pdo->exec("DELETE FROM card_assignment_leases");
    createCardLease('user-idem', 'test-order-11', '5047061674560137', 'Test', $pdo, $now);
    $pdo->exec(
        "INSERT INTO Payment_report (id_user,id_order,time,price,payment_Status,Payment_Method,id_invoice,assigned_card_number,assigned_card_name)
         VALUES ('user-idem','test-order-11','2026/01/01',1000,'paid','cart to cart','inv','5047061674560137','Test')"
    );
    completeCardLeaseForOrder('test-order-11', $pdo);
    $cnt1 = getSuccessfulTransactionCountToday('5047061674560137', $pdo);
    completeCardLeaseForOrder('test-order-11', $pdo);
    $cnt2 = getSuccessfulTransactionCountToday('5047061674560137', $pdo);
    assert_eq($cnt1, $cnt2, 'TEST 11 idempotent completion count');
    assert_eq(1, $cnt2, 'TEST 11 completion increments once');
} else {
    echo "\n(skip DB integration — set CARD_ASSIGNMENT_TEST_DSN to run TEST 1-7, 10-11)\n";
}

echo "\n{$passed} passed, {$failed} failed\n";
exit($failed > 0 ? 1 : 0);
