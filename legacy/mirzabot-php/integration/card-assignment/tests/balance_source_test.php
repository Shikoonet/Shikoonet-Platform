<?php
/**
 * Balancing counters must follow real payments, not lease completion.
 *
 * completeCardLeaseForOrder() only runs when an order is fulfilled through
 * index.php, so webhook- and cron-fulfilled payments never marked their lease
 * COMPLETED. successful_today therefore sat at 0 for nearly every card, and
 * being the first sort key it handed a whole day of traffic to one card.
 *
 * Run against the sim MySQL, never production:
 *   CARD_ASSIGNMENT_TEST_DSN='mysql:host=127.0.0.1;port=3307;dbname=mirzabot;charset=utf8mb4' \
 *   php integration/card-assignment/tests/balance_source_test.php
 */
declare(strict_types=1);

// No default DSN on purpose: without one this file cannot run at all, so it can
// never be pointed at production by accident.
$dsn = getenv('CARD_ASSIGNMENT_TEST_DSN');
if (!$dsn) {
    fwrite(STDERR, "CARD_ASSIGNMENT_TEST_DSN is required. Use the sim MySQL, never production.\n");
    exit(2);
}
$pdo = new PDO(
    $dsn,
    getenv('CARD_ASSIGNMENT_TEST_USER') ?: 'root',
    getenv('CARD_ASSIGNMENT_TEST_PASS') ?: 'shikoo_local',
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../hub_eligibility.php';
require_once __DIR__ . '/../card_assignment.php';

$passed = 0;
$failed = 0;
function ck($expected, $actual, string $label): void
{
    global $passed, $failed;
    if ($expected === $actual) {
        $passed++;
        echo "PASS  $label\n";
    } else {
        $failed++;
        echo "FAIL  $label (expected " . json_encode($expected) . ", got " . json_encode($actual) . ")\n";
    }
}

const PAID_CARD = '9999999999999999';   // a paid payment, no COMPLETED lease
const DONE_CARD = '8888888888888888';   // a COMPLETED lease, no paid payment

$teh   = new DateTimeZone('Asia/Tehran');
$nowTs = time();
$today = (new DateTime('@' . $nowTs))->setTimezone($teh)->format('Y/m/d H:i:s');

$insertPayment = $pdo->prepare(
    "INSERT INTO Payment_report
     (id_user,id_order,time,price,payment_Status,Payment_Method,id_invoice,assigned_card_number,assigned_card_name)
     VALUES (?,?,?,?,?,?,?,?,?)"
);
$insertPayment->execute(['9001', 'test-balance-paid', $today, '50000', 'paid', 'cart to cart', 'inv-test-balance', PAID_CARD, 'T']);

$pdo->prepare(
    "INSERT INTO card_assignment_leases
     (telegram_user_id, order_id, card_number, card_name, status, assigned_at, expires_at, completed_at, released_at, created_at, updated_at)
     VALUES (?,?,?,?,'COMPLETED',?,?,?,?,?,?)"
)->execute(['9002', 'test-balance-done', DONE_CARD, 'T', $nowTs - 60, $nowTs + 540, $nowTs - 30, $nowTs - 30, $nowTs - 60, $nowTs - 30]);

try {
    ck(1, getSuccessfulTransactionCountToday(PAID_CARD, $pdo, $nowTs),
        'a paid payment counts today even though its lease is not COMPLETED');
    ck(1, getSuccessfulTransactionCount7d(PAID_CARD, $pdo, $nowTs + 1),
        'the same payment counts in the 7d window');
    ck(1, getSuccessfulTransactionCountLifetime(PAID_CARD, $pdo),
        'the same payment counts lifetime');
    ck(0, getSuccessfulTransactionCountToday(DONE_CARD, $pdo, $nowTs + 2),
        'a COMPLETED lease with no paid payment does not count');

    // Tehran boundary: one second before midnight belongs to yesterday. This is
    // the assertion that would catch an ambient-timezone regression, since
    // php.ini is UTC while index.php runs in Tehran.
    [$dayStart] = cardAssignmentTehranDayBounds($nowTs);
    $justBefore = (new DateTime('@' . ($dayStart - 1)))->setTimezone($teh)->format('Y/m/d H:i:s');
    $insertPayment->execute(['9003', 'test-balance-edge', $justBefore, '50000', 'paid', 'cart to cart', 'inv-test-edge', PAID_CARD, 'T']);
    ck(1, getSuccessfulTransactionCountToday(PAID_CARD, $pdo, $nowTs + 3),
        'a payment one second before Tehran midnight is not counted as today');
    ck(2, getSuccessfulTransactionCount7d(PAID_CARD, $pdo, $nowTs + 4),
        'but it does count in the 7d window');
} finally {
    $pdo->exec("DELETE FROM Payment_report WHERE id_order LIKE 'test-balance-%'");
    $pdo->exec("DELETE FROM card_assignment_leases WHERE order_id LIKE 'test-balance-%'");
    $left = (int) $pdo->query("SELECT COUNT(*) FROM Payment_report WHERE id_order LIKE 'test-balance-%'")->fetchColumn()
          + (int) $pdo->query("SELECT COUNT(*) FROM card_assignment_leases WHERE order_id LIKE 'test-balance-%'")->fetchColumn();
    echo "\ncleanup: {$left} fixture rows left behind\n";
}

echo "{$passed} passed, {$failed} failed\n";
exit($failed > 0 ? 1 : 0);
