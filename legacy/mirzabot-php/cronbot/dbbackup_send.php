<?php
// filepath: /var/www/html/mirzaprobotconfig/cronbot/dbbackup_send.php
// Hourly job: dump the mirzaprobot MySQL database, gzip it, then
// deliver it to the configured Telegram admin chat via sendDocument().
date_default_timezone_set('Asia/Tehran');
ini_set('error_log', __DIR__ . '/error_log');

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../botapi.php';
require_once __DIR__ . '/../function.php';

// ─── config ─────────────────────────────────────────────────────────────
$DB_NAME    = 'mirzaprobot';
$DB_USER    = 'nVoPqjCg';
$DB_PASS    = 'QyfiM9Ax';
$DB_HOST    = 'localhost';

// Telegram upload size limit is 50MB; stay at 49MB.
$MAX_SEND_BYTES = 49 * 1024 * 1024;
$KEEP_LOCAL_COPIES = 5;

// Dumps behind .htaccess (cronbot dir already blocks .sql/.gz/.zip/.json)
$DUMP_DIR = __DIR__ . '/dbbackups';
if (!is_dir($DUMP_DIR)) {
    @mkdir($DUMP_DIR, 0750, true);
}
@file_put_contents($DUMP_DIR . '/.htaccess', "Require all denied\n");

function micro_bytes($n): string {
    $units = ['B','KB','MB','GB'];
    $i = 0;
    while ($n >= 1024 && $i < count($units) - 1) { $n /= 1024; $i++; }
    return number_format($n, ($i ? 2 : 0)) . ' ' . $units[$i];
}
function safe_filename(string $prefix): string {
    return $prefix . '_' . date('Ymd_His') . '.sql.gz';
}

// ─── choose chat_id(s) to send to ──────────────────────────────────────
$chatIds = [$adminnumber];
$extraIds = getenv('DBBACKUP_CHAT_IDS');
if ($extraIds) {
    foreach (explode(',', $extraIds) as $id) {
        $id = trim($id);
        if ($id !== '' && ctype_digit(ltrim($id, '-'))) $chatIds[] = $id;
    }
}
$chatIds = array_values(array_unique($chatIds));

// ─── 1. dump ───────────────────────────────────────────────────────────
$dumpPath = $DUMP_DIR . '/' . safe_filename('mirza_hourly');
$dumpCmd  = sprintf(
    '/usr/bin/mysqldump --host=%s --user=%s --password=%s '.
    '--default-character-set=utf8mb4 '.
    '--single-transaction --quick --skip-lock-tables '.
    '--skip-add-drop-table --no-tablespaces '.
    '--routines --triggers --events '.
    '%s 2>/tmp/mirza_dump.err | /bin/gzip -9 > %s',
    escapeshellarg($DB_HOST),
    escapeshellarg($DB_USER),
    escapeshellarg($DB_PASS),
    escapeshellarg($DB_NAME),
    escapeshellarg($dumpPath)
);

$ok = false;
$rc = 0;
$stdout = [];
$stderr = '';
exec($dumpCmd, $stdout, $rc);
if (is_file('/tmp/mirza_dump.err')) $stderr = (string) file_get_contents('/tmp/mirza_dump.err');

$size = is_file($dumpPath) ? (int) filesize($dumpPath) : 0;
if ($rc !== 0 || $size === 0) {
    $msg = "❌ Mirza hourly DB dump FAILED.\n".
           "rc=$rc, size=" . micro_bytes($size) . "\n".
           "stderr (first 400 chars):\n" . substr($stderr, 0, 400);
    foreach ($chatIds as $cid) @sendmessage((int) $cid, $msg, null, 'HTML');
    error_log('dbbackup_send: dump failed rc=' . $rc . ' stderr=' . $stderr);
    exit(1);
}

// ─── 2. prune local copies (keep most recent N) ───────────────────────
$files = glob($DUMP_DIR . '/mirza_hourly_*.sql.gz') ?: [];
usort($files, fn($a, $b) => filemtime($b) - filemtime($a));
foreach (array_slice($files, $KEEP_LOCAL_COPIES) as $old) @unlink($old);

// ─── 3. tiny stats ────────────────────────────────────────────────────
$stats = ['users' => 0, 'invoices' => 0, 'paid_txs' => 0];
try {
    $stats['users']    = (int) db_count($pdo, "SELECT COUNT(*) FROM user");
    $stats['invoices'] = (int) db_count($pdo, "SELECT COUNT(*) FROM invoice");
    $stats['paid_txs'] = (int) db_count($pdo, "SELECT COUNT(*) FROM Payment_report WHERE payment_Status='paid'");
} catch (Throwable $e) {}

// ─── 4. deliver via Telegram ──────────────────────────────────────────
$caption =
    "🗄 *Mirza hourly DB backup*\n".
    "Server: " . gethostname() . "\n".
    "When: " . date('Y-m-d H:i:s T') . "\n".
    "Size: " . micro_bytes($size) . "\n".
    "Stats: users=" . number_format($stats['users']) .
    ", invoices=" . number_format($stats['invoices']) .
    ", paid_tx=" . number_format($stats['paid_txs']) . "\n".
    "_The .sql.gz file is attached._";

if ($size > $MAX_SEND_BYTES) {
    $text = "⚠ Mirza hourly DB backup is " . micro_bytes($size) .
            " (>49 MB Telegram limit). File kept locally at:\n`$dumpPath`\n".
            "Please copy it manually.";
    foreach ($chatIds as $cid) @sendmessage((int) $cid, $text, null, 'Markdown');
    exit(0);
}

$deliveriesOk = 0;
foreach ($chatIds as $cid) {
    $r = @sendDocument((int) $cid, $dumpPath, $caption);
    if (is_array($r) && ($r['ok'] ?? false)) $deliveriesOk++;
    else error_log('dbbackup_send: sendDocument failed for chat ' . $cid . ': ' . json_encode($r));
}

if ($deliveriesOk === 0)
    error_log('dbbackup_send: ALL Telegram deliveries failed. Dump retained at ' . $dumpPath);
exit(0);
