<?php
/**
 * Keep hub-eligible-cards.json in step with the cards the admin has marked
 * active in the bot. Without this the file stays frozen at whatever the last
 * deploy wrote, and every card added afterwards is silently never assigned.
 *
 * Writes nothing unless the card set actually changed.
 * Backs off entirely if a real Hub sync has populated the file.
 *
 * Set SYNC_OUT to write elsewhere (dry run). Exit 0 = no change, 10 = changed.
 */
declare(strict_types=1);

$BOT  = '/var/www/html/mirzaprobotconfig';
$LIVE = $BOT . '/integration/card-assignment/data/hub-eligible-cards.json';
$LOG  = $BOT . '/integration/card-assignment/data/sync.log';
$OUT  = getenv('SYNC_OUT') ?: $LIVE;

require $BOT . '/config.php';

$existing = is_file($LIVE) ? json_decode((string) file_get_contents($LIVE), true) : null;
$oldCards = (is_array($existing) && is_array($existing['cards'] ?? null)) ? $existing['cards'] : [];

// A real Hub sync names the financial account. Never overwrite that.
foreach ($oldCards as $c) {
    if (($c['financial_account_id'] ?? '') !== 'bot-active') {
        fwrite(STDERR, "real hub sync detected, leaving file alone\n");
        exit(0);
    }
}

$cards = [];
foreach ($pdo->query("SELECT cardnumber FROM card_number WHERE status = 'active'")->fetchAll(PDO::FETCH_COLUMN) as $n) {
    $d = preg_replace('/\D/', '', (string) $n);
    if (strlen($d) === 16) {
        $cards[$d] = ['card_digits' => $d, 'financial_account_id' => 'bot-active', 'account_status' => 'ACTIVE'];
    }
}
ksort($cards);

// array_keys() gives ints here — PHP casts 16-digit numeric keys — so restring them
// before comparing against the strings that came out of the JSON.
$new = array_map('strval', array_keys($cards));
$old = array_map('strval', array_column($oldCards, 'card_digits'));
sort($old);

// An empty card table almost certainly means a failed query, not zero cards.
if ($new === [] && $old !== []) {
    fwrite(STDERR, "refusing to write an empty eligibility list\n");
    exit(1);
}

if ($new === $old && $OUT === $LIVE) {
    exit(0);
}

$payload = json_encode([
    'synced_at'      => time(),
    'integration_id' => (string) ($existing['integration_id'] ?? 'mirzabot-prod'),
    'cards'          => array_values($cards),
], JSON_PRETTY_PRINT) . "\n";

$tmp = $OUT . '.tmp';
if (file_put_contents($tmp, $payload) === false) {
    fwrite(STDERR, "write failed: $tmp\n");
    exit(1);
}
if (is_file($LIVE)) {
    @chmod($tmp, fileperms($LIVE) & 0777);
    @chown($tmp, fileowner($LIVE));
    @chgrp($tmp, filegroup($LIVE));
}
rename($tmp, $OUT);

$added   = array_diff($new, $old);
$removed = array_diff($old, $new);
fwrite(STDERR, sprintf("%d -> %d cards  added:[%s] removed:[%s]\n", count($old), count($new), implode(' ', $added), implode(' ', $removed)));

if ($OUT === $LIVE) {
    @file_put_contents($LOG, sprintf(
        "%s  %d -> %d  added:[%s] removed:[%s]\n",
        gmdate('Y-m-d H:i:s'),
        count($old),
        count($new),
        implode(' ', $added),
        implode(' ', $removed)
    ), FILE_APPEND);
}
exit(10);
