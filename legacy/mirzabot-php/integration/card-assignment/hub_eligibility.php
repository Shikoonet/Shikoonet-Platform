<?php
declare(strict_types=1);

/**
 * Hub-mapped cards eligible for assignment (DEV sync file — not live D1 from PHP).
 *
 * @return array<string, array{financial_account_id: string, account_status: string}>
 */
function cardAssignmentHubEligibleMap(): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }

    $path = getenv('CARD_ASSIGNMENT_HUB_ELIGIBLE_PATH');
    if ($path === false || $path === '') {
        $path = __DIR__ . '/data/hub-eligible-cards.json';
    }

    if (!is_file($path) || !is_readable($path)) {
        error_log('card-assignment: hub eligible cards file missing: ' . $path);
        $cache = [];
        return $cache;
    }

    $raw = file_get_contents($path);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($data) || !isset($data['cards']) || !is_array($data['cards'])) {
        error_log('card-assignment: invalid hub eligible cards JSON');
        $cache = [];
        return $cache;
    }

    $map = [];
    foreach ($data['cards'] as $row) {
        if (!is_array($row)) {
            continue;
        }
        $digits = preg_replace('/\D/', '', (string) ($row['card_digits'] ?? ''));
        if (strlen($digits) !== 16) {
            continue;
        }
        $status = strtoupper((string) ($row['account_status'] ?? ''));
        if ($status !== 'ACTIVE') {
            continue;
        }
        $map[$digits] = [
            'financial_account_id' => (string) ($row['financial_account_id'] ?? ''),
            'account_status' => $status,
        ];
    }

    $cache = $map;
    return $cache;
}

function cardAssignmentIsHubEligible(string $cardDigits): bool
{
    $digits = preg_replace('/\D/', '', $cardDigits);
    if (strlen($digits) !== 16) {
        return false;
    }
    return isset(cardAssignmentHubEligibleMap()[$digits]);
}
