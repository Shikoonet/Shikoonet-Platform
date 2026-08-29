<?php
declare(strict_types=1);

function cardAssignmentEnsureSchema(): void
{
    global $pdo;
    if (!isset($pdo) || !($pdo instanceof PDO)) {
        return;
    }

    try {
        $col = $pdo->query("SHOW COLUMNS FROM card_number LIKE 'status'");
        if ($col && $col->rowCount() === 0) {
            $pdo->exec(
                "ALTER TABLE card_number ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active' AFTER namecard"
            );
        }
        $col = $pdo->query("SHOW COLUMNS FROM card_number LIKE 'last_assigned_at'");
        if ($col && $col->rowCount() === 0) {
            $pdo->exec(
                "ALTER TABLE card_number ADD COLUMN last_assigned_at INT UNSIGNED NULL DEFAULT NULL AFTER status"
            );
        }

        $col = $pdo->query("SHOW COLUMNS FROM Payment_report LIKE 'assigned_card_number'");
        if ($col && $col->rowCount() === 0) {
            $pdo->exec(
                "ALTER TABLE Payment_report ADD COLUMN assigned_card_number VARCHAR(32) NULL DEFAULT NULL AFTER id_invoice"
            );
        }
        $col = $pdo->query("SHOW COLUMNS FROM Payment_report LIKE 'assigned_card_name'");
        if ($col && $col->rowCount() === 0) {
            $pdo->exec(
                "ALTER TABLE Payment_report ADD COLUMN assigned_card_name VARCHAR(255) NULL DEFAULT NULL AFTER assigned_card_number"
            );
        }

        $exists = $pdo->query("SHOW TABLES LIKE 'card_assignment_leases'");
        if ($exists && $exists->rowCount() === 0) {
            $versionRow = $pdo->query('SELECT VERSION()')->fetch(PDO::FETCH_NUM);
            $version = is_array($versionRow) ? (string) ($versionRow[0] ?? '') : '';
            $supportsGenerated = version_compare(preg_replace('/[^0-9.].*$/', '', $version), '5.7.6', '>=');

            if ($supportsGenerated) {
                $pdo->exec(
                    "CREATE TABLE card_assignment_leases (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        telegram_user_id VARCHAR(64) NOT NULL,
                        order_id VARCHAR(64) NOT NULL,
                        card_number VARCHAR(32) NOT NULL,
                        card_name VARCHAR(255) NOT NULL DEFAULT '',
                        status ENUM('ACTIVE','COMPLETED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
                        assigned_at INT UNSIGNED NOT NULL,
                        expires_at INT UNSIGNED NOT NULL,
                        completed_at INT UNSIGNED NULL DEFAULT NULL,
                        released_at INT UNSIGNED NULL DEFAULT NULL,
                        created_at INT UNSIGNED NOT NULL,
                        updated_at INT UNSIGNED NOT NULL,
                        active_user_slot VARCHAR(64) GENERATED ALWAYS AS (
                            IF(status = 'ACTIVE', telegram_user_id, NULL)
                        ) STORED,
                        active_card_slot VARCHAR(32) GENERATED ALWAYS AS (
                            IF(status = 'ACTIVE', card_number, NULL)
                        ) STORED,
                        UNIQUE KEY uniq_active_user (active_user_slot),
                        UNIQUE KEY uniq_active_card (active_card_slot),
                        INDEX idx_order_id (order_id),
                        INDEX idx_status_expires (status, expires_at),
                        INDEX idx_card_completed (card_number, status, completed_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
                );
            } else {
                $pdo->exec(
                    "CREATE TABLE card_assignment_leases (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        telegram_user_id VARCHAR(64) NOT NULL,
                        order_id VARCHAR(64) NOT NULL,
                        card_number VARCHAR(32) NOT NULL,
                        card_name VARCHAR(255) NOT NULL DEFAULT '',
                        status ENUM('ACTIVE','COMPLETED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
                        assigned_at INT UNSIGNED NOT NULL,
                        expires_at INT UNSIGNED NOT NULL,
                        completed_at INT UNSIGNED NULL DEFAULT NULL,
                        released_at INT UNSIGNED NULL DEFAULT NULL,
                        created_at INT UNSIGNED NOT NULL,
                        updated_at INT UNSIGNED NOT NULL,
                        INDEX idx_order_id (order_id),
                        INDEX idx_user_active (telegram_user_id, status),
                        INDEX idx_card_active (card_number, status),
                        INDEX idx_status_expires (status, expires_at),
                        INDEX idx_card_completed (card_number, status, completed_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
                );
            }
        }
    } catch (Throwable $e) {
        error_log('card-assignment: schema ensure failed: ' . $e->getMessage());
    }
}
