<?php
/**
 * Payment Hub integration (TEST only).
 * Secrets via environment — never commit local.php with real secrets.
 */

declare(strict_types=1);

(function () {
    $local = __DIR__ . '/local.php';
    if (is_file($local) && is_readable($local)) {
        require_once $local;
    }
})();

function paymentHubEnabled(): bool
{
    $v = getenv('MIRZABOT_INTEGRATION_ENABLED');
    return $v === '1' || $v === 'true' || $v === 'TRUE';
}

function paymentHubClaimsUrl(): string
{
    return getenv('PAYMENT_HUB_CLAIMS_URL')
        ?: 'https://ingest-worker.samsos.workers.dev/api/v1/integrations/mirzabot/claims';
}

function paymentHubIntegrationId(): string
{
    return getenv('PAYMENT_HUB_INTEGRATION_ID') ?: 'mirzabot-test';
}

function paymentHubHmacSecret(): ?string
{
    $s = getenv('PAYMENT_HUB_HMAC_SECRET');
    return ($s !== false && $s !== '') ? $s : null;
}

function paymentHubLoadCardState(string $userId, string $orderId): ?array
{
    if (!function_exists('getPaymentCardTempPath')) {
        return null;
    }
    $path = getPaymentCardTempPath($userId, $orderId);
    if (!is_file($path)) {
        return null;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function paymentHubPatchCardState(string $userId, string $orderId, array $patch): void
{
    if (!function_exists('getPaymentCardTempPath')) {
        return;
    }
    $path = getPaymentCardTempPath($userId, $orderId);
    $state = paymentHubLoadCardState($userId, $orderId) ?? [
        'order_id' => (string) $orderId,
    ];
    foreach ($patch as $k => $v) {
        $state[$k] = $v;
    }
    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    @file_put_contents($path, json_encode($state, JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function paymentHubRecordPaidClicked(string $userId, string $orderId): void
{
    paymentHubPatchCardState($userId, $orderId, [
        'paid_clicked_at' => (int) round(microtime(true) * 1000),
    ]);
}

function paymentHubRecordReceiptSubmitted(string $userId, string $orderId): int
{
    $ts = (int) round(microtime(true) * 1000);
    paymentHubPatchCardState($userId, $orderId, [
        'receipt_submitted_at' => $ts,
    ]);
    return $ts;
}

function paymentHubCardDigits(string $userId, string $orderId): ?string
{
    $state = paymentHubLoadCardState($userId, $orderId);
    if (!$state || empty($state['card_number'])) {
        return null;
    }
    $digits = preg_replace('/\D/', '', (string) $state['card_number']);
    return strlen($digits) === 16 ? $digits : null;
}

function paymentHubSignRequest(string $method, string $path, string $rawBody, string $eventId): array
{
    $secret = paymentHubHmacSecret();
    if ($secret === null) {
        throw new RuntimeException('PAYMENT_HUB_HMAC_SECRET not configured');
    }
    $ts = (string) time();
    $bodyHash = hash('sha256', $rawBody);
    $payload = $ts . "\n" . strtoupper($method) . "\n" . $path . "\n" . $bodyHash;
    $sig = hash_hmac('sha256', $payload, $secret);
    return [
        'X-Integration-Id' => paymentHubIntegrationId(),
        'X-Event-Id' => $eventId,
        'X-Timestamp' => $ts,
        'X-Signature' => 'sha256=' . $sig,
    ];
}

function paymentHubVerifyWebhook(string $method, string $path, string $rawBody, array $headers): bool
{
    $secret = paymentHubHmacSecret();
    if ($secret === null) {
        return false;
    }
    $integrationId = $headers['X-Integration-Id'] ?? $headers['x-integration-id'] ?? '';
    $eventId = $headers['X-Event-Id'] ?? $headers['x-event-id'] ?? '';
    $ts = $headers['X-Timestamp'] ?? $headers['x-timestamp'] ?? '';
    $sigHeader = $headers['X-Signature'] ?? $headers['x-signature'] ?? '';
    if ($integrationId !== paymentHubIntegrationId() || $eventId === '' || $ts === '') {
        return false;
    }
    if (abs(time() - (int) $ts) > 300) {
        return false;
    }
    if (!str_starts_with($sigHeader, 'sha256=')) {
        return false;
    }
    $bodyHash = hash('sha256', $rawBody);
    $payload = $ts . "\n" . strtoupper($method) . "\n" . $path . "\n" . $bodyHash;
    $expected = hash_hmac('sha256', $payload, $secret);
    return hash_equals($expected, substr($sigHeader, 7));
}

function paymentHubSubmitMirzabotClaim(
    string $telegramUserId,
    ?string $telegramUsername,
    array $paymentReport,
    ?string $telegramFileUniqueId
): void {
    if (!paymentHubEnabled()) {
        return;
    }
    $secret = paymentHubHmacSecret();
    if ($secret === null) {
        error_log('payment-hub: HMAC secret missing, skip claim');
        return;
    }
    $orderId = (string) $paymentReport['id_order'];
    $state = paymentHubLoadCardState($telegramUserId, $orderId);
    $cardDigits = paymentHubCardDigits($telegramUserId, $orderId);
    $paidClickedAt = isset($state['paid_clicked_at']) ? (int) $state['paid_clicked_at'] : null;
    $receiptSubmittedAt = paymentHubRecordReceiptSubmitted($telegramUserId, $orderId);
    if ($paidClickedAt === null) {
        error_log('payment-hub: paid_clicked_at missing for order ' . $orderId);
        $paidClickedAt = $receiptSubmittedAt;
    }
    if ($cardDigits === null) {
        error_log('payment-hub: card digits missing for order ' . $orderId);
        return;
    }
    $amountToman = (int) $paymentReport['price'];
    $expectedAmountIrr = $amountToman * 10;
    $eventId = 'mirzabot-' . $orderId . '-' . bin2hex(random_bytes(8));
    $body = [
        'eventId' => $eventId,
        'source' => 'MIRZABOT',
        'orderId' => $orderId,
        'telegramUserId' => (string) $telegramUserId,
        'telegramUsername' => $telegramUsername,
        'amountToman' => $amountToman,
        'expectedAmountIrr' => $expectedAmountIrr,
        'cardNumber' => $cardDigits,
        'paidClickedAt' => $paidClickedAt,
        'receiptSubmittedAt' => $receiptSubmittedAt,
        'receipt' => $telegramFileUniqueId ? ['telegramFileUniqueId' => $telegramFileUniqueId] : null,
    ];
    if ($body['receipt'] === null) {
        unset($body['receipt']);
    }
    $rawBody = json_encode($body, JSON_UNESCAPED_UNICODE);
    $path = '/api/v1/integrations/mirzabot/claims';
    try {
        $headers = paymentHubSignRequest('POST', $path, $rawBody, $eventId);
    } catch (Throwable $e) {
        error_log('payment-hub: sign failed ' . $e->getMessage());
        return;
    }
    $url = paymentHubClaimsUrl();
    $httpHeaders = ['Content-Type: application/json'];
    foreach ($headers as $k => $v) {
        $httpHeaders[] = $k . ': ' . $v;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $rawBody,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => $httpHeaders,
    ]);
    $response = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code < 200 || $code >= 300) {
        error_log('payment-hub: claim HTTP ' . $code . ' body=' . substr((string) $response, 0, 500));
    }
}

function paymentHubFulfillmentEventPath(string $eventId): string
{
    $safe = preg_replace('/[^a-zA-Z0-9._-]/', '', $eventId);
    return __DIR__ . '/../../data/integration-events/' . $safe . '.done';
}

function paymentHubFulfillVerifiedOrder(string $orderId, string $eventId): array
{
    $flag = paymentHubFulfillmentEventPath($eventId);
    if (is_file($flag)) {
        return ['ok' => true, 'duplicate' => true];
    }
    $report = select('Payment_report', '*', 'id_order', $orderId, 'select');
    if (!$report) {
        return ['ok' => false, 'error' => 'order_not_found'];
    }
    $steppay = explode('|', $report['id_invoice']);
    // [HUB FIX] do NOT pre-mark Payment_report.paid; DirectPayment is the
    // authoritative owner of that write (post successful delivery).
    $result = DirectPayment($orderId);
    if (!is_array($result) || empty($result['ok'])) {
        $state = is_array($result) ? ($result['state'] ?? 'unknown') : 'unknown';
        return ['ok' => false, 'error' => 'settlement_failed', 'state' => $state, 'retryable' => (bool) ($result['retryable'] ?? true)];
    }
    // [HUB FIX] durable post-condition: only mark .done if DirectPayment reports
    // a real fulfilled outcome AND invoice.Status==='active' AND Payment_report.paid.
    if (($result['state'] ?? null) !== 'fulfilled' && ($result['state'] ?? null) !== 'already_fulfilled') {
        return ['ok' => false, 'error' => 'settlement_not_fulfilled', 'state' => $result['state'] ?? null];
    }
    $reReport = select('Payment_report', 'payment_Status', 'id_order', $orderId, 'select');
    if (!$reReport || $reReport['payment_Status'] !== 'paid') {
        return ['ok' => false, 'error' => 'paid_state_missing', 'state' => $result['state'] ?? null];
    }
    $reUsername = $steppay[1] ?? null;
    $reInvoice = $reUsername ? select('invoice', 'Status', 'username', $reUsername, 'select') : null;
    if (!$reInvoice || $reInvoice['Status'] !== 'active') {
        return ['ok' => false, 'error' => 'invoice_state_missing', 'state' => $result['state'] ?? null];
    }
    @mkdir(dirname($flag), 0755, true);
    @file_put_contents($flag, (string) time());
    return ['ok' => true, 'duplicate' => false, 'state' => $result['state']];
}
