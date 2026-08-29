<?php
/**
 * Acceptance test for the eligibility-sync fix. Touches no database row.
 *
 * Removes one card from the cache file by hand — reproducing exactly the state
 * the bug produced (active in the bot, absent from the file) — then waits for
 * cron to heal it. Card is out of rotation for under 60 seconds, fail-closed.
 */
declare(strict_types=1);

$BOT  = '/var/www/html/mirzaprobotconfig';
$FILE = $BOT . '/integration/card-assignment/data/hub-eligible-cards.json';

require $BOT . '/config.php';
require $BOT . '/integration/reconciliation/local.php';
require $BOT . '/integration/card-assignment/card_assignment.php';

function verdict(string $card, string $file): string
{
    // fresh process: the map is a per-process static, so shell out.
    // card goes through the environment — interpolating a 16-digit number into
    // the source makes PHP read it as an int and every === against it fails.
    $script = '
        require "/var/www/html/mirzaprobotconfig/config.php";
        require "/var/www/html/mirzaprobotconfig/integration/reconciliation/local.php";
        require "/var/www/html/mirzaprobotconfig/integration/card-assignment/card_assignment.php";
        $c = (string) getenv("ACC_CARD");
        $inFile  = cardAssignmentIsHubEligible($c) ? "yes" : "NO";
        $offered = "no";
        foreach (getEligibleAvailableCards() as $e) { if ((string) $e["cardnumber"] === $c) $offered = "yes"; }
        $reason = "?";
        foreach (cardAssignmentBuildAuditReport() as $r) { if ((string) $r["card_number"] === $c) $reason = $r["exclusion_reason"]; }
        echo "in_file=$inFile  offered_to_customer=$offered  reason=$reason";
    ';
    $cmd = 'ACC_CARD=' . escapeshellarg($card) . ' ' . escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($script) . ' 2>&1';
    return trim((string) shell_exec($cmd));
}

$before = (string) file_get_contents($FILE);
$data   = json_decode($before, true);
$all    = array_column($data['cards'], 'card_digits');

// pick a card with no active lease, so nobody is mid-payment on it
$busy = [];
foreach ($pdo->query("SELECT card_number FROM card_assignment_leases WHERE status = 'ACTIVE'")->fetchAll(PDO::FETCH_COLUMN) as $b) {
    $busy[preg_replace('/\D/', '', (string) $b)] = true;
}
$victim = null;
foreach ($all as $c) {
    if (!isset($busy[$c])) { $victim = $c; break; }
}
if ($victim === null) {
    exit("every card has an active lease right now — rerun in a few minutes\n");
}

echo "card under test : $victim\n";
echo "cards in file   : " . count($all) . "\n\n";
echo "STEP 1  baseline\n        " . verdict($victim, $FILE) . "\n\n";

// --- reproduce the bug: same file, minus one card ---
$data['cards'] = array_values(array_filter($data['cards'], fn($c) => $c['card_digits'] !== $victim));
file_put_contents($FILE . '.tmp', json_encode($data, JSON_PRETTY_PRINT) . "\n");
chmod($FILE . '.tmp', 0644);
rename($FILE . '.tmp', $FILE);
$t = time();

echo "STEP 2  card removed from the cache file (still active in the bot)\n";
echo "        " . verdict($victim, $FILE) . "\n";
echo "        ^ this is the bug: active in card_number, never offered\n\n";

echo "STEP 3  waiting for cron to heal it...\n";
$healed = false;
for ($i = 0; $i < 75; $i++) {
    sleep(1);
    if (cardAssignmentIsHubEligibleFresh($victim, $FILE)) { $healed = true; break; }
}
printf("        healed after %d seconds: %s\n", time() - $t, $healed ? 'YES' : 'NO — TIMED OUT');
echo "        " . verdict($victim, $FILE) . "\n\n";

// --- cleanup verification ---
$after = json_decode((string) file_get_contents($FILE), true);
$now   = array_column($after['cards'], 'card_digits');
sort($all); sort($now);
echo "STEP 4  file restored identically: " . ($all === $now ? 'YES' : 'NO') . "\n";
echo "        cards before=" . count($all) . " after=" . count($now) . "\n";

function cardAssignmentIsHubEligibleFresh(string $card, string $file): bool
{
    $raw = @file_get_contents($file);
    $d   = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($d) || !is_array($d['cards'] ?? null)) { return false; }
    return in_array($card, array_column($d['cards'], 'card_digits'), true);
}
