<?php
/**
 * Payment Hub → Mirzabot verified webhook (TEST).
 * POST /integration/reconciliation/webhook.php
 */
declare(strict_types=1);

require_once __DIR__ . '/../../config.php';
require_once __DIR__ . '/../../function.php';
require_once __DIR__ . '/payment_hub.php';
require_once __DIR__ . '/../../panels.php';
$ManagePanel = new ManagePanel();

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

if (!paymentHubEnabled()) {
    http_response_code(404);
    echo json_encode(['ok' => false, 'error' => 'integration_disabled']);
    exit;
}

$rawBody = file_get_contents('php://input') ?: '';
$headers = function_exists('getallheaders') ? getallheaders() : [];
$path = '/api/v1/integrations/payment-hub/verified';

if (!paymentHubVerifyWebhook('POST', $path, $rawBody, $headers)) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'unauthorized']);
    exit;
}

$payload = json_decode($rawBody, true);
if (!is_array($payload) || ($payload['type'] ?? '') !== 'payment.verified') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid_body']);
    exit;
}

$orderId = $payload['mirzabotOrderId'] ?? '';
$eventId = $payload['eventId'] ?? ($headers['X-Event-Id'] ?? $headers['x-event-id'] ?? '');
if ($orderId === '' || $eventId === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing_fields']);
    exit;
}

$result = paymentHubFulfillVerifiedOrder((string) $orderId, (string) $eventId);
http_response_code($result['ok'] ? 200 : 409);
echo json_encode($result);
