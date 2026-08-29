<?php
require_once __DIR__ . '/inc/config.php';
require_once __DIR__ . '/inc/icons.php';
require_auth();

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'adjust_revenue') {
    csrf_check_post();
    $amount = filter_input(INPUT_POST, 'revenue_amount', FILTER_VALIDATE_INT);
    $type = (($_POST['revenue_adjustment_type'] ?? 'add') === 'deduct') ? 'deduct' : 'add';
    $note = trim((string) ($_POST['revenue_note'] ?? ''));
    $noteMaxLength = 500;
    if ($amount === false || $amount < 0 || $amount === 0) {
        flash('error', $textbotlang['panel']['settingsRevenueInvalidAmount'] ?? 'Please enter a valid amount.');
    } elseif ($note === '' || mb_strlen($note, 'UTF-8') > $noteMaxLength) {
        flash('error', $note === '' ? ($textbotlang['panel']['settingsRevenueNoteRequired'] ?? 'Note is required.') : ($textbotlang['panel']['settingsRevenueNoteTooLong'] ?? 'Note is too long.'));
    } else {
        $signedAmount = $type === 'deduct' ? -$amount : $amount;
        $admin = $_SESSION['admin_user'] ?? null;
        try {
            $pdo->beginTransaction();
            $ins = $pdo->prepare("INSERT INTO revenue_adjustment_log (amount, type, note, created_by, created_at) VALUES (?, ?, ?, ?, NOW())");
            $ins->execute([$signedAmount, $type, $note, $admin]);
            $currentSum = (int) $pdo->query("SELECT COALESCE(SUM(amount),0) FROM revenue_adjustment_log")->fetchColumn();
            $row = db_fetch($pdo, "SELECT * FROM setting LIMIT 1");
            if (!$row) {
                db_query($pdo, "INSERT INTO setting (revenue_adjustment) VALUES (?)", [$currentSum]);
            } else {
                db_query($pdo, "UPDATE setting SET revenue_adjustment = ?", [$currentSum]);
            }
            $pdo->commit();
            flash('success', sprintf('Revenue %s adjustment of %s saved.', $type, number_format($amount)));
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) { $pdo->rollBack(); }
            error_log('Revenue adjustment failed: ' . $e->getMessage());
            flash('error', 'Revenue adjustment failed.');
        }
    }
    $back = $_POST['redirect'] ?? '';
    if ($back && strpos($back, 'revenue_history.php') !== false) {
        header('Location: ' . $back);
    } else {
        header('Location: settings.php?tab=system');
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'delete_revenue_log') {
    csrf_check_post();
    $logId = filter_input(INPUT_POST, 'log_id', FILTER_VALIDATE_INT);
    if (!$logId || $logId <= 0) {
        flash('error', 'Invalid entry.');
    } else {
        try {
            $pdo->beginTransaction();
            $del = $pdo->prepare("DELETE FROM revenue_adjustment_log WHERE id = ?");
            $del->execute([$logId]);
            if ($del->rowCount() === 0) {
                $pdo->rollBack();
                flash('error', 'Invalid entry.');
                header('Location: settings.php?tab=system');
                exit;
            }
            $currentSum = (int) $pdo->query("SELECT COALESCE(SUM(amount),0) FROM revenue_adjustment_log")->fetchColumn();
            $row = db_fetch($pdo, "SELECT * FROM setting LIMIT 1");
            if (!$row) db_query($pdo, "INSERT INTO setting (revenue_adjustment) VALUES (?)", [$currentSum]);
            else        db_query($pdo, "UPDATE setting SET revenue_adjustment = ?", [$currentSum]);
            $pdo->commit();
            flash('success', 'Entry removed.');
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) { $pdo->rollBack(); }
            error_log('Revenue log deletion failed: ' . $e->getMessage());
            flash('error', 'Revenue adjustment failed.');
        }
    }
    $back = $_POST['redirect'] ?? '';
    if ($back && strpos($back, 'revenue_history.php') !== false) {
        header('Location: ' . $back);
    } else {
        header('Location: settings.php?tab=system');
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'update_revenue_log') {
    csrf_check_post();
    $logId = filter_input(INPUT_POST, 'log_id', FILTER_VALIDATE_INT);
    $note = trim((string) ($_POST['note'] ?? ''));
    if (!$logId || $logId <= 0 || $note === '' || mb_strlen($note, 'UTF-8') > 500) {
        flash('error', $note === '' ? 'Note is required.' : 'Note is too long.');
    } else {
        try {
            $upd = $pdo->prepare("UPDATE revenue_adjustment_log SET note = ? WHERE id = ?");
            $upd->execute([$note, $logId]);
            if ($upd->rowCount() === 0) flash('error', 'Invalid entry.');
            else flash('success', 'Note updated.');
        } catch (Throwable $e) {
            error_log('Revenue log update failed: ' . $e->getMessage());
            flash('error', 'Revenue adjustment failed.');
        }
    }
    $back = $_POST['redirect'] ?? '';
    if ($back && strpos($back, 'revenue_history.php') !== false) {
        header('Location: ' . $back);
    } else {
        header('Location: settings.php?tab=system');
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'change_password') {
    csrf_check_post();
    $cur = $_POST['current_password'] ?? '';
    $new = $_POST['new_password'] ?? '';
    $confirm = $_POST['confirm_password'] ?? '';
    $admin = db_fetch($pdo, "SELECT * FROM admin WHERE username = ?", [$_SESSION['admin_user']]);
    $valid = password_verify($cur, $admin['password']) || $cur === $admin['password'];

    if (!$valid) {
        flash('error', $textbotlang['panel']['settingsCurrentPasswordWrong']);
    } elseif ($new !== $confirm) {
        flash('error', $textbotlang['panel']['settingsNewPasswordMismatch']);
    } elseif (strlen($new) < 6) {
        flash('error', $textbotlang['panel']['settingsPasswordMinLength']);
    } else {
        db_query(
            $pdo,
            "UPDATE admin SET password = ? WHERE username = ?",
            [password_hash($new, PASSWORD_BCRYPT, ['cost' => 12]), $_SESSION['admin_user']]
        );
        flash('success', $textbotlang['panel']['settingsPasswordChanged']);
    }
    header('Location: settings.php?tab=security');
    exit;
}

$tab = $_GET['tab'] ?? 'appearance';

$revenueAdjustment = 0;
$revenueLog = [];
$revenueLogTotal = 0;
try {
    $rev = db_fetch($pdo, "SELECT revenue_adjustment FROM setting LIMIT 1");
    $revenueAdjustment = (int) ($rev['revenue_adjustment'] ?? 0);
    $revenueLog = db_fetchAll($pdo, "SELECT id, amount, type, note, created_by, created_at FROM revenue_adjustment_log ORDER BY created_at DESC, id DESC LIMIT 50");
    $revenueLogTotal = (int) db_count($pdo, "SELECT COUNT(*) FROM revenue_adjustment_log");
} catch (Throwable $e) {
    error_log('revenue settings error: ' . $e->getMessage());
}


$themes = [
    'navy' => ['name' => $textbotlang['panel']['settingsThemeBlueSea'], 'desc' => $textbotlang['panel']['settingsThemeBlueSeaDesc'], 'c' => ['#0F172A', '#1E293B', '#06B6D4', '#22C55E'], 'dark' => true],
    'purple' => ['name' => $textbotlang['panel']['settingsThemeDreamPurple'], 'desc' => $textbotlang['panel']['settingsThemeDreamPurpleDesc'], 'c' => ['#180D2E', '#231545', '#A855F7', '#F43F5E'], 'dark' => true],
    'emerald' => ['name' => $textbotlang['panel']['settingsThemeEmeraldGreen'], 'desc' => $textbotlang['panel']['settingsThemeEmeraldGreenDesc'], 'c' => ['#0A1F1C', '#132E2A', '#10B981', '#84CC16'], 'dark' => true],
    'sunset' => ['name' => $textbotlang['panel']['settingsThemeWarmSunset'], 'desc' => $textbotlang['panel']['settingsThemeWarmSunsetDesc'], 'c' => ['#1A0D0D', '#2A1615', '#F97316', '#FBBF24'], 'dark' => true],
    'slate' => ['name' => $textbotlang['panel']['settingsThemeBlack'], 'desc' => $textbotlang['panel']['settingsThemeBlackDesc'], 'c' => ['#080808', '#141414', '#E2E8F0', '#22C55E'], 'dark' => true],
    'light' => ['name' => $textbotlang['panel']['settingsThemeLightWhite'], 'desc' => $textbotlang['panel']['settingsThemeLightWhiteDesc'], 'c' => ['#F1F5F9', '#FFFFFF', '#0891B2', '#16A34A'], 'dark' => false],
    'linen' => ['name' => $textbotlang['panel']['settingsThemeCreamPaper'], 'desc' => $textbotlang['panel']['settingsThemeCreamPaperDesc'], 'c' => ['#FAF7F2', '#FFFFFF', '#B87333', '#5D7C4A'], 'dark' => false],
    'mint' => ['name' => $textbotlang['panel']['settingsThemeMintGreen'], 'desc' => $textbotlang['panel']['settingsThemeMintGreenDesc'], 'c' => ['#F0FDF4', '#FFFFFF', '#166534', '#1D4ED8'], 'dark' => false],
    'lavender' => ['name' => $textbotlang['panel']['settingsThemeLavender'], 'desc' => $textbotlang['panel']['settingsThemeLavenderDesc'], 'c' => ['#FAF5FF', '#FFFFFF', '#6D28D9', '#15803D'], 'dark' => false],
];

$tabs = [
    'appearance' => ['icon' => 'settings', 'label' => $textbotlang['panel']['settingsTabAppearance']],
    'security' => ['icon' => 'block', 'label' => $textbotlang['panel']['settingsTabSecurity']],
    'system' => ['icon' => 'dashboard', 'label' => $textbotlang['panel']['settingsTabSystem']],
];

$pageTitle = $textbotlang['panel']['settingsTitle'];
$activeNav = 'settings';
$showPageHead = false;
include __DIR__ . '/inc/layout_head.php';
?>

<div style="display:flex;gap:4px;margin-bottom:18px;background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:5px;overflow-x:auto"
    class="fade-up">
    <?php foreach ($tabs as $key => $tab_data): ?>
        <a href="?tab=<?= $key ?>"
            style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:7px;font-size:.82rem;font-weight:600;white-space:nowrap;flex-shrink:0;transition:all .15s;text-decoration:none;
                  <?= $tab === $key ? 'background:var(--ac);color:#fff;box-shadow:0 0 14px var(--acg)' : 'color:var(--mute)' ?>">
            <?= icon($tab_data['icon'], 15) ?>     <?= $tab_data['label'] ?>
        </a>
    <?php endforeach; ?>
</div>

<?php if ($tab === 'appearance'): ?>

    <div class="card fade-up">
        <div class="card-head">
            <div>
                <div class="card-title"><?= $textbotlang['panel']['settingsHeading'] ?></div>
                <div class="card-subtitle"><?= $textbotlang['panel']['settingsAppearanceSection'] ?></div>
            </div>
        </div>
        <div class="card-body">
            <div
                style="font-size:.75rem;font-weight:700;color:var(--mute);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">
                <?= $textbotlang['panel']['settingsThemeLabel'] ?></div>
            <div class="theme-grid" style="margin-bottom:20px">
                <?php foreach ($themes as $key => $theme):
                    if (!$theme['dark'])
                        continue; ?>
                    <div class="theme-card" data-tk="<?= $key ?>" onclick="pickTheme('<?= $key ?>')">
                        <div class="theme-preview">
                            <?php foreach ($theme['c'] as $color): ?>
                                <div style="background:<?= $color ?>"></div>
                            <?php endforeach; ?>
                        </div>
                        <div class="theme-name"><?= htmlspecialchars($theme['name']) ?></div>
                        <div class="theme-desc"><?= htmlspecialchars($theme['desc']) ?></div>
                    </div>
                <?php endforeach; ?>
            </div>
            <div
                style="font-size:.75rem;font-weight:700;color:var(--mute);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">
                <?= $textbotlang['panel']['settingsSecuritySection'] ?></div>
            <div class="theme-grid">
                <?php foreach ($themes as $key => $theme):
                    if ($theme['dark'])
                        continue; ?>
                    <div class="theme-card" data-tk="<?= $key ?>" onclick="pickTheme('<?= $key ?>')">
                        <div class="theme-preview" style="border:1px solid var(--bd)">
                            <?php foreach ($theme['c'] as $color): ?>
                                <div style="background:<?= $color ?>"></div>
                            <?php endforeach; ?>
                        </div>
                        <div class="theme-name"><?= htmlspecialchars($theme['name']) ?></div>
                        <div class="theme-desc"><?= htmlspecialchars($theme['desc']) ?></div>
                    </div>
                <?php endforeach; ?>
            </div>
        </div>
    </div>

    <div class="card fade-up d1" style="margin-top:14px">
        <div class="card-head">
            <div>
                <div class="card-title"><?= $textbotlang['panel']['settingsCurrentPasswordLabel'] ?></div>
            </div>
        </div>
        <div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap">
            <button onclick="setSidebarMode(false)" class="btn btn-ghost" id="modeExpanded"
                style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 20px;flex:1;min-width:120px">
                <svg width="44" height="32" viewBox="0 0 44 32" fill="none">
                    <rect x="0" y="0" width="13" height="32" rx="3" fill="var(--sf3)" />
                    <rect x="2" y="5" width="9" height="2" rx="1" fill="var(--ac)" />
                    <rect x="2" y="10" width="9" height="2" rx="1" fill="var(--bd)" />
                    <rect x="15" y="0" width="29" height="32" rx="3" fill="var(--sf3)" />
                </svg>
                <span style="font-size:.78rem;font-weight:600"><?= $textbotlang['panel']['settingsNewPasswordLabel'] ?></span>
            </button>
            <button onclick="setSidebarMode(true)" class="btn btn-ghost" id="modeCollapsed"
                style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 20px;flex:1;min-width:120px">
                <svg width="44" height="32" viewBox="0 0 44 32" fill="none">
                    <rect x="0" y="0" width="7" height="32" rx="3" fill="var(--sf3)" />
                    <rect x="2" y="5" width="3" height="2" rx="1" fill="var(--ac)" />
                    <rect x="2" y="10" width="3" height="2" rx="1" fill="var(--bd)" />
                    <rect x="9" y="0" width="35" height="32" rx="3" fill="var(--sf3)" />
                </svg>
                <span style="font-size:.78rem;font-weight:600"><?= $textbotlang['panel']['settingsConfirmPasswordLabel'] ?></span>
            </button>
        </div>
    </div>

<?php elseif ($tab === 'security'): ?>

    <div class="two-col">
        <div class="card fade-up">
            <div class="card-head">
                <div>
                    <div class="card-title"><?= $textbotlang['panel']['settingsChangePasswordBtn'] ?></div>
                    <div class="card-subtitle"><?= $textbotlang['panel']['settingsSystemSection'] ?></div>
                </div>
            </div>
            <form method="POST" class="card-body">
                <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
                <input type="hidden" name="action" value="change_password">
                <div style="display:flex;flex-direction:column;gap:14px">
                    <div class="field">
                        <label><?= $textbotlang['panel']['settingsSaveBtn'] ?></label>
                        <div style="position:relative">
                            <input type="password" name="current_password" id="pw1" class="input" required
                                autocomplete="current-password" style="padding-left:40px">
                            <button type="button" onclick="togglePw('pw1', this)"
                                style="position:absolute;left:10px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--dim);cursor:pointer">
                                <?= icon('eye', 16) ?>
                            </button>
                        </div>
                    </div>
                    <div class="field">
                        <label><?= $textbotlang['panel']['settingsCurrentPasswordPlaceholder'] ?></label>
                        <div style="position:relative">
                            <input type="password" name="new_password" id="pw2" class="input" minlength="6" required
                                autocomplete="new-password" style="padding-left:40px" oninput="checkPwStr(this.value)">
                            <button type="button" onclick="togglePw('pw2', this)"
                                style="position:absolute;left:10px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--dim);cursor:pointer">
                                <?= icon('eye', 16) ?>
                            </button>
                        </div>
                        <div style="height:4px;background:var(--sf3);border-radius:99px;margin-top:5px">
                            <div id="pwBar"
                                style="height:100%;width:0;border-radius:99px;transition:all .3s;background:var(--no)">
                            </div>
                        </div>
                        <span id="pwHint" class="field-hint"><?= $textbotlang['panel']['settingsNewPasswordPlaceholder'] ?></span>
                    </div>
                    <div class="field">
                        <label><?= $textbotlang['panel']['settingsConfirmPasswordPlaceholder'] ?></label>
                        <input type="password" name="confirm_password" class="input" required autocomplete="new-password">
                    </div>
                    <button type="submit" class="btn btn-primary"><?= icon('check', 14) ?> <?= $textbotlang['panel']['settingsPasswordStrengthLabel'] ?></button>
                </div>
            </form>
        </div>

        <div class="card fade-up d1" style="height:fit-content">
            <div class="card-head">
                <div>
                    <div class="card-title"><?= $textbotlang['panel']['settingsLogoutBtn'] ?></div>
                </div>
                <a href="logout.php" class="btn btn-no btn-sm"><?= icon('logout', 13) ?> <?= $textbotlang['panel']['settingsSystemInfoTitle'] ?></a>
            </div>
            <div class="kv-list">
                <div class="kv">
                    <span class="kv-key"><?= $textbotlang['panel']['settingsThemePreviewLabel'] ?></span>
                    <span class="kv-val"><?= htmlspecialchars($_SESSION['admin_user']) ?></span>
                </div>
                <div class="kv">
                    <span class="kv-key"><?= $textbotlang['panel']['settingsApplyThemeBtn'] ?></span>
                    <span class="kv-val">
                        <?= isset($_SESSION['login_time']) ? date('Y/m/d H:i:s', $_SESSION['login_time']) : '—' ?>
                    </span>
                </div>
                <div class="kv">
                    <span class="kv-key"><?= $textbotlang['panel']['settingsSidebarToggleLabel'] ?></span>
                    <span class="kv-val cm"><?= htmlspecialchars($_SERVER['REMOTE_ADDR'] ?? '—') ?></span>
                </div>
            </div>
        </div>
    </div>

<?php elseif ($tab === 'system'): ?>

    <div class="card fade-up">
        <div class="card-head">
            <div>
                <div class="card-title">Manual revenue adjustment</div>
                <div class="card-subtitle">Add or deduct an amount from the displayed total revenue.</div>
            </div>
        </div>
        <form method="POST" class="card-body">
            <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
            <input type="hidden" name="action" value="adjust_revenue">
            <div style="display:flex;flex-direction:column;gap:14px">
                <div class="field">
                    <label>Amount</label>
                    <input type="number" name="revenue_amount" class="input" min="0" step="1" value="0" required>
                    <div class="field-hint">Enter the amount in toman</div>
                </div>
                <div class="field">
                    <label>Action</label>
                    <div style="display:flex;gap:12px;flex-wrap:wrap">
                        <label style="display:flex;align-items:center;gap:6px;font-weight:600;color:var(--mute)">
                            <input type="radio" name="revenue_adjustment_type" value="add" checked> Add
                        </label>
                        <label style="display:flex;align-items:center;gap:6px;font-weight:600;color:var(--mute)">
                            <input type="radio" name="revenue_adjustment_type" value="deduct"> Deduct
                        </label>
                    </div>
                </div>
                <div class="field">
                    <label>Note</label>
                    <textarea name="revenue_note" class="input" rows="2" maxlength="500" required placeholder="e.g. server payment, refund, ..."></textarea>
                    <div class="field-hint">Required</div>
                </div>
                <div class="kv-list" style="padding:0;border:none">
                    <div class="kv">
                        <span class="kv-key">Current manual adjustment</span>
                        <span class="kv-val cm"><?= number_format($revenueAdjustment) ?> T</span>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary">Apply change</button>
            </div>
        </form>
    </div>

    <div class="card fade-up d1" style="margin-bottom:14px">
        <div class="card-head">
            <div>
                <div class="card-title">Revenue adjustment history</div>
                <div class="card-subtitle">All manual revenue changes with their notes.</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <span class="btn btn-ghost btn-sm" style="pointer-events:none">
                    Current adjustment: <span class="cm"><?= number_format($revenueAdjustment) ?></span>
                </span>
                <a href="revenue_history.php" class="btn btn-primary btn-sm">Open full history →</a>
            </div>
        </div>
        <div class="tbl-wrap">
            <table class="tbl-sm">
                <thead>
                    <tr>
                        <th>Date</th><th>Type</th><th>Amount</th><th>Note</th><th>By</th><th style="text-align:left">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <?php if (empty($revenueLog)): ?>
                        <tr><td colspan="6"><div class="empty" style="padding:24px"><p>No adjustments recorded yet.</p></div></td></tr>
                    <?php else: foreach ($revenueLog as $log):
                        $isDeduct = ($log['type'] ?? '') === 'deduct';
                        $tagClass = $isDeduct ? 'tag-no' : 'tag-ok';
                        $tagLabel = $isDeduct ? 'Deduct' : 'Add';
                        $createdAt = $log['created_at'] ?? '';
                        $formattedDate = $createdAt !== '' ? date('Y/m/d H:i', strtotime($createdAt)) : '—';
                        $logId = (int) ($log['id'] ?? 0);
                    ?>
                        <tr>
                            <td class="cm" style="white-space:nowrap"><?= htmlspecialchars($formattedDate) ?></td>
                            <td><span class="tag <?= $tagClass ?>"><?= $tagLabel ?></span></td>
                            <td class="cn" style="white-space:nowrap"><?= $isDeduct ? '−' : '+' ?><?= number_format(abs((int)($log['amount'] ?? 0))) ?> <span class="cf">T</span></td>
                            <td style="max-width:320px">
                                <form method="POST" style="display:flex;gap:6px;align-items:center">
                                    <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
                                    <input type="hidden" name="action" value="update_revenue_log">
                                    <input type="hidden" name="log_id" value="<?= $logId ?>">
                                    <input type="hidden" name="redirect" value="settings.php?tab=system">
                                    <input type="text" name="note" class="input" value="<?= htmlspecialchars((string)($log['note'] ?? '')) ?>" maxlength="500" required style="flex:1;min-width:160px">
                                    <button type="submit" class="btn btn-ghost btn-sm" title="Save note"><?= icon('check', 14) ?></button>
                                </form>
                            </td>
                            <td class="cm" style="white-space:nowrap"><?= htmlspecialchars((string)($log['created_by'] ?? '—')) ?></td>
                            <td style="text-align:left;white-space:nowrap">
                                <form method="POST" style="display:inline">
                                    <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
                                    <input type="hidden" name="action" value="delete_revenue_log">
                                    <input type="hidden" name="log_id" value="<?= $logId ?>">
                                    <input type="hidden" name="redirect" value="settings.php?tab=system">
                                    <button type="submit" class="btn btn-no btn-sm" onclick="return confirm('Remove this entry from history?')"><?= icon('trash', 14) ?></button>
                                </form>
                            </td>
                        </tr>
                    <?php endforeach; endif; ?>
                </tbody>
            </table>
        </div>
    </div>

    <div class="card fade-up">
        <div class="card-head">
            <div>
                <div class="card-title"><?= $textbotlang['panel']['settingsAboutPanelLabel'] ?></div>
            </div>
        </div>
        <div class="kv-list">
            <?php
            $dbVer = '—';
            try {
                $dbVer = $pdo->getAttribute(PDO::ATTR_SERVER_VERSION);
            } catch (Exception $e) {
            }
            $sysInfo = [
                [$textbotlang['panel']['settingsPanelVersion'], 1.0],
                ['PHP', phpversion()],
                ['MySQL', $dbVer],
                [$textbotlang['panel']['settingsWebServer'], $_SERVER['SERVER_SOFTWARE'] ?? '—'],
                [$textbotlang['panel']['settingsCurrentAdmin'], $_SESSION['admin_user']],
                [$textbotlang['panel']['settingsServerTime'], date('Y/m/d H:i:s')],
                [$textbotlang['panel']['settingsPhpMemory'], ini_get('memory_limit')],
            ];
            foreach ($sysInfo as [$key, $value]):
                ?>
                <div class="kv">
                    <span class="kv-key"><?= $key ?></span>
                    <span class="kv-val cm" style="font-size:.78rem"><?= htmlspecialchars($value) ?></span>
                </div>
            <?php endforeach; ?>
        </div>
    </div>

<?php endif; ?>

<script src="js/settings.js"></script>

<?php include __DIR__ . '/inc/layout_foot.php'; ?>