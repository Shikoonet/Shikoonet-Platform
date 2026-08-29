<?php


if (!defined('FAOXIMA_SKIP_BOTAPI_ROUTER')) {
    define('FAOXIMA_SKIP_BOTAPI_ROUTER', true);
}


if (!defined('FAOXIMA_SKIP_BOTAPI_ROUTER')) {
    define('FAOXIMA_SKIP_BOTAPI_ROUTER', true);
}
session_start();
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/lib/icons.php';

$query = $pdo->prepare("SELECT * FROM admin WHERE username=:username");
$query->bindValue(":username", $_SESSION["user"] ?? '', PDO::PARAM_STR);
$query->execute();
$adminRow = $query->fetch(PDO::FETCH_ASSOC);
if (!isset($_SESSION["user"]) || !$adminRow) {
    header('Location: login.php');
    exit;
}

$flash = ['ok' => '', 'err' => ''];


if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['_action'] ?? '';

    if ($action === 'add') {
        $code    = trim((string)($_POST['codeDiscount'] ?? ''));
        $vtype   = (string)($_POST['type']            ?? 'percent');
        $section = (string)($_POST['section']         ?? 'all');
        $value   = (string)($_POST['price']           ?? '0');
        $limit   = (int)($_POST['limitDiscount']      ?? 0);
        $agent   = (string)($_POST['agent']           ?? 'allusers');
        $first   = !empty($_POST['usefirst']) ? '1' : '0';
        $oneper  = !empty($_POST['useuser'])  ? '1' : '0';
        $target  = trim((string)($_POST['target_user'] ?? ''));
        $expDays = (int)($_POST['expire_days'] ?? 0);


        $errors = [];


        if ($code === '') {
            $errors[] = 'کد تخفیف نمی‌تواند خالی باشد.';
        } elseif (!preg_match('/^[A-Za-z0-9_\-]{2,40}$/', $code)) {
            $errors[] = 'کد تخفیف فقط شامل حروف انگلیسی، عدد، خط تیره و آندرلاین (۲ تا ۴۰ کاراکتر).';
        }


        if (!in_array($vtype, ['percent', 'amount', 'free'], true)) {
            $errors[] = 'نوع تخفیف نامعتبر است.';
        }

        if (!in_array($section, ['all', 'buy', 'extend', 'volume', 'time', 'charge'], true)) {
            $errors[] = 'بخش کد نامعتبر است.';
        }


        $numericValue = (float)$value;
        if ($vtype === 'percent') {
            if ($numericValue <= 0 || $numericValue > 100) {
                $errors[] = 'درصد تخفیف باید بین ۱ تا ۱۰۰ باشد.';
            }
        } elseif ($vtype === 'amount') {
            if ($numericValue <= 0) {
                $errors[] = 'مبلغ تخفیف باید بزرگ‌تر از صفر باشد.';
            } elseif ($numericValue > 100000000) {
                $errors[] = 'مبلغ تخفیف بیش از حد بزرگ است.';
            }
        } else {
            $value = '0';
        }


        if ($limit < 0) {
            $errors[] = 'سقف کل استفاده نمی‌تواند منفی باشد.';
        }


        if (!in_array($agent, ['allusers', 'f', 'n', 'n2'], true)) {
            $errors[] = 'گروه هدف نامعتبر است.';
        }

        if ($target !== '' && !ctype_digit($target)) {
            $errors[] = 'آیدی عددی کاربر هدف نامعتبر است.';
        }


        if (empty($errors)) {
            try {
                $dup = $pdo->prepare("SELECT 1 FROM DiscountSell WHERE codeDiscount = :c LIMIT 1");
                $dup->execute([':c' => $code]);
                if ($dup->fetchColumn()) {
                    $errors[] = 'این کد تخفیف از قبل ثبت شده است.';
                }
            } catch (\Throwable $e) {  }
        }

        if (!empty($errors)) {
            $flash['err'] = '• ' . implode("<br>• ", array_map(fn($e) => htmlspecialchars($e, ENT_QUOTES, 'UTF-8'), $errors));
        } else {
            try {
                $expiry = $expDays > 0 ? (string)(time() + $expDays * 86400) : '0';
                $stmt = $pdo->prepare(
                    "INSERT INTO DiscountSell
                     (codeDiscount, price, limitDiscount, agent, usefirst, useuser, code_product, code_panel, time, type, usedDiscount, section, value_type, target_user, status)
                     VALUES (:c, :p, :l, :a, :f, :u, 'all', '/all', :t, :sec, '0', :sec2, :vt, :tg, 'active')"
                );
                $stmt->execute([
                    ':c'   => $code,
                    ':p'   => $value,
                    ':l'   => (string)$limit,
                    ':a'   => $agent,
                    ':f'   => $first,
                    ':u'   => $oneper,
                    ':t'   => $expiry,
                    ':sec' => $section,
                    ':sec2'=> $section,
                    ':vt'  => $vtype,
                    ':tg'  => ($target === '' ? null : $target),
                ]);
                $flash['ok'] = 'کد تخفیف افزوده شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'خطا: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'edit') {
        $id      = (int)($_POST['id'] ?? 0);
        $code    = trim((string)($_POST['codeDiscount'] ?? ''));
        $vtype   = (string)($_POST['type']            ?? 'percent');
        $section = (string)($_POST['section']         ?? 'all');
        $value   = (string)($_POST['price']           ?? '0');
        $limit   = (int)($_POST['limitDiscount']      ?? 0);
        $agent   = (string)($_POST['agent']           ?? 'allusers');
        $first   = !empty($_POST['usefirst']) ? '1' : '0';
        $oneper  = !empty($_POST['useuser'])  ? '1' : '0';
        $target  = trim((string)($_POST['target_user'] ?? ''));
        $expDays = (int)($_POST['expire_days'] ?? 0);

        $errors = [];
        if ($id <= 0) {
            $errors[] = 'شناسه کد نامعتبر است.';
        }
        if ($code === '') {
            $errors[] = 'کد تخفیف نمی‌تواند خالی باشد.';
        } elseif (!preg_match('/^[A-Za-z0-9_\-]{2,40}$/', $code)) {
            $errors[] = 'کد تخفیف فقط شامل حروف انگلیسی، عدد، خط تیره و آندرلاین (۲ تا ۴۰ کاراکتر).';
        }
        if (!in_array($vtype, ['percent', 'amount', 'free'], true)) {
            $errors[] = 'نوع تخفیف نامعتبر است.';
        }
        if (!in_array($section, ['all', 'buy', 'extend', 'volume', 'time', 'charge'], true)) {
            $errors[] = 'بخش کد نامعتبر است.';
        }
        $numericValue = (float)$value;
        if ($vtype === 'percent') {
            if ($numericValue <= 0 || $numericValue > 100) {
                $errors[] = 'درصد تخفیف باید بین ۱ تا ۱۰۰ باشد.';
            }
        } elseif ($vtype === 'amount') {
            if ($numericValue <= 0) {
                $errors[] = 'مبلغ تخفیف باید بزرگ‌تر از صفر باشد.';
            } elseif ($numericValue > 100000000) {
                $errors[] = 'مبلغ تخفیف بیش از حد بزرگ است.';
            }
        } else {
            $value = '0';
        }
        if ($limit < 0) {
            $errors[] = 'سقف کل استفاده نمی‌تواند منفی باشد.';
        }
        if (!in_array($agent, ['allusers', 'f', 'n', 'n2'], true)) {
            $errors[] = 'گروه هدف نامعتبر است.';
        }
        if ($target !== '' && !ctype_digit($target)) {
            $errors[] = 'آیدی عددی کاربر هدف نامعتبر است.';
        }
        if (empty($errors)) {
            try {
                $dup = $pdo->prepare("SELECT 1 FROM DiscountSell WHERE codeDiscount = :c AND id <> :id LIMIT 1");
                $dup->execute([':c' => $code, ':id' => $id]);
                if ($dup->fetchColumn()) {
                    $errors[] = 'این کد تخفیف از قبل ثبت شده است.';
                }
            } catch (\Throwable $e) {  }
        }
        if (!empty($errors)) {
            $flash['err'] = '• ' . implode("<br>• ", array_map(fn($e) => htmlspecialchars($e, ENT_QUOTES, 'UTF-8'), $errors));
        } else {
            try {
                $expiry = $expDays > 0 ? (string)(time() + $expDays * 86400) : '0';
                $stmt = $pdo->prepare(
                    "UPDATE DiscountSell
                        SET codeDiscount = :c, price = :p, limitDiscount = :l, agent = :a,
                            usefirst = :f, useuser = :u, time = :t, section = :sec,
                            value_type = :vt, type = :sec2, target_user = :tg
                      WHERE id = :id"
                );
                $stmt->execute([
                    ':c'   => $code,
                    ':p'   => $value,
                    ':l'   => (string)$limit,
                    ':a'   => $agent,
                    ':f'   => $first,
                    ':u'   => $oneper,
                    ':t'   => $expiry,
                    ':sec' => $section,
                    ':sec2'=> $section,
                    ':vt'  => $vtype,
                    ':tg'  => ($target === '' ? null : $target),
                    ':id'  => $id,
                ]);
                $flash['ok'] = 'کد تخفیف ویرایش شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'خطا: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'gift_add') {
        $code    = trim((string)($_POST['code'] ?? ''));
        $price   = (int)($_POST['gift_price'] ?? 0);
        $limit   = (int)($_POST['gift_limit'] ?? 0);
        $target  = trim((string)($_POST['gift_target'] ?? ''));
        $expDays = (int)($_POST['gift_expire_days'] ?? 0);

        $errors = [];
        if ($code === '' || !preg_match('/^[A-Za-z0-9_\-]{2,40}$/', $code)) {
            $errors[] = 'کد هدیه نامعتبر است (۲ تا ۴۰ کاراکتر، حروف/عدد/-/_).';
        }
        if ($price <= 0) {
            $errors[] = 'مبلغ کد هدیه باید بزرگ‌تر از صفر باشد.';
        }
        if ($limit < 0) {
            $errors[] = 'سقف استفاده نمی‌تواند منفی باشد.';
        }
        if ($target !== '' && !ctype_digit($target)) {
            $errors[] = 'آیدی عددی کاربر هدف نامعتبر است.';
        }
        if (empty($errors)) {
            try {
                $dup = $pdo->prepare("SELECT 1 FROM Discount WHERE code = :c LIMIT 1");
                $dup->execute([':c' => $code]);
                if ($dup->fetchColumn()) {
                    $errors[] = 'این کد هدیه از قبل ثبت شده است.';
                }
            } catch (\Throwable $e) {  }
        }
        if (!empty($errors)) {
            $flash['err'] = '• ' . implode("<br>• ", array_map(fn($e) => htmlspecialchars($e, ENT_QUOTES, 'UTF-8'), $errors));
        } else {
            try {
                $expiry = $expDays > 0 ? (string)(time() + $expDays * 86400) : null;
                $stmt = $pdo->prepare(
                    "INSERT INTO Discount (code, price, limituse, limitused, target_user, expire_at, status)
                     VALUES (:c, :p, :l, '0', :tg, :ex, 'active')"
                );
                $stmt->execute([
                    ':c'  => $code,
                    ':p'  => (string)$price,
                    ':l'  => (string)$limit,
                    ':tg' => ($target === '' ? null : $target),
                    ':ex' => $expiry,
                ]);
                $flash['ok'] = 'کد هدیه افزوده شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'خطا: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'gift_edit') {
        $id      = (int)($_POST['id'] ?? 0);
        $code    = trim((string)($_POST['code'] ?? ''));
        $price   = (int)($_POST['gift_price'] ?? 0);
        $limit   = (int)($_POST['gift_limit'] ?? 0);
        $target  = trim((string)($_POST['gift_target'] ?? ''));
        $expDays = (int)($_POST['gift_expire_days'] ?? 0);

        $errors = [];
        if ($id <= 0) {
            $errors[] = 'شناسه کد نامعتبر است.';
        }
        if ($code === '' || !preg_match('/^[A-Za-z0-9_\-]{2,40}$/', $code)) {
            $errors[] = 'کد هدیه نامعتبر است (۲ تا ۴۰ کاراکتر، حروف/عدد/-/_).';
        }
        if ($price <= 0) {
            $errors[] = 'مبلغ کد هدیه باید بزرگ‌تر از صفر باشد.';
        }
        if ($limit < 0) {
            $errors[] = 'سقف استفاده نمی‌تواند منفی باشد.';
        }
        if ($target !== '' && !ctype_digit($target)) {
            $errors[] = 'آیدی عددی کاربر هدف نامعتبر است.';
        }
        if (empty($errors)) {
            try {
                $dup = $pdo->prepare("SELECT 1 FROM Discount WHERE code = :c AND id <> :id LIMIT 1");
                $dup->execute([':c' => $code, ':id' => $id]);
                if ($dup->fetchColumn()) {
                    $errors[] = 'این کد هدیه از قبل ثبت شده است.';
                }
            } catch (\Throwable $e) {  }
        }
        if (!empty($errors)) {
            $flash['err'] = '• ' . implode("<br>• ", array_map(fn($e) => htmlspecialchars($e, ENT_QUOTES, 'UTF-8'), $errors));
        } else {
            try {
                $expiry = $expDays > 0 ? (string)(time() + $expDays * 86400) : null;
                $stmt = $pdo->prepare(
                    "UPDATE Discount SET code = :c, price = :p, limituse = :l, target_user = :tg, expire_at = :ex WHERE id = :id"
                );
                $stmt->execute([
                    ':c'  => $code,
                    ':p'  => (string)$price,
                    ':l'  => (string)$limit,
                    ':tg' => ($target === '' ? null : $target),
                    ':ex' => $expiry,
                    ':id' => $id,
                ]);
                $flash['ok'] = 'کد هدیه ویرایش شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'خطا: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'gift_delete') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            try {
                $pdo->prepare("DELETE FROM Discount WHERE id = :id")->execute([':id' => $id]);
                $flash['ok'] = 'کد هدیه حذف شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'حذف ناموفق: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'delete') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            try {
                $pdo->prepare("DELETE FROM DiscountSell WHERE id = :id")->execute([':id' => $id]);
                $flash['ok'] = 'کد تخفیف حذف شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'حذف ناموفق: ' . $e->getMessage();
            }
        }
    }
    elseif ($action === 'reset_usage') {
        $id = (int)($_POST['id'] ?? 0);
        if ($id > 0) {
            try {
                $pdo->prepare("UPDATE DiscountSell SET usedDiscount = '0' WHERE id = :id")->execute([':id' => $id]);
                $flash['ok'] = 'شمارنده استفاده صفر شد.';
            } catch (\Throwable $e) {
                $flash['err'] = 'بازنشانی ناموفق: ' . $e->getMessage();
            }
        }
    }
}


$list = [];
try {
    $r = $pdo->query("SELECT * FROM DiscountSell ORDER BY id DESC");
    if ($r) $list = $r->fetchAll(PDO::FETCH_ASSOC);
} catch (\Throwable $e) {
    $flash['err'] = 'بارگذاری ناموفق: ' . $e->getMessage();
}

$giftList = [];
try {
    $rg = $pdo->query("SELECT * FROM Discount ORDER BY id DESC");
    if ($rg) $giftList = $rg->fetchAll(PDO::FETCH_ASSOC);
} catch (\Throwable $e) {  }

function faoxima_d_label_type($t) {
    switch ($t) {
        case 'percent': return ['درصدی', 'badge-success'];
        case 'amount':  return ['مبلغی', 'badge-info'];
        case 'free':    return ['رایگان', 'badge-purple'];
        default:        return [htmlspecialchars((string)$t, ENT_QUOTES), 'badge-gray'];
    }
}
function faoxima_d_label_agent($a) {
    switch ($a) {
        case 'f':        return ['کاربر عادی', 'badge-info'];
        case 'n':        return ['نماینده', 'badge-purple'];
        case 'n2':       return ['نماینده+', 'badge-warning'];
        case 'all':
        case 'allusers': return ['همه', 'badge-success'];
        default:         return [htmlspecialchars((string)$a, ENT_QUOTES), 'badge-gray'];
    }
}
function faoxima_d_label_section($s) {
    switch ($s) {
        case 'buy':    return ['خرید', 'badge-info'];
        case 'extend': return ['تمدید', 'badge-purple'];
        case 'volume': return ['حجم', 'badge-warning'];
        case 'time':   return ['زمان', 'badge-warning'];
        case 'charge': return ['شارژ', 'badge-success'];
        case 'all':
        default:       return ['همه بخش‌ها', 'badge-gray'];
    }
}
?>
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>کدهای تخفیف | پنل فاکسیما</title>
    <link rel="stylesheet" href="css/theme.css">
    <script src="js/theme.js" defer>

</script>
</head>
<body>

<section id="container">
    <?php include("header.php"); ?>

    <section id="main-content">
        <div class="wrapper">

            <div class="page-head">
                <div>
                    <div class="page-head__title">
                        <?php echo icon('ticket', 'svg-icon svg-lg'); ?>
                        کدهای تخفیف
                    </div>
                    <div class="page-head__sub">مدیریت کدهای تخفیف و هدیه</div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="btn btn-soft-success" onclick="openModal('modal-add-gift')">
                        <?php echo icon('plus', 'svg-icon svg-sm'); ?>
                        <span>افزودن کد هدیه</span>
                    </button>
                    <button class="btn btn-primary" onclick="openModal('modal-add-discount')">
                        <?php echo icon('plus', 'svg-icon svg-sm'); ?>
                        <span>افزودن کد تخفیف</span>
                    </button>
                </div>
            </div>

            <?php if ($flash['ok']): ?>
                <div class="alert" style="background:var(--color-success-soft); border:1px solid var(--color-success); color:var(--color-success); padding:12px 16px; border-radius:10px; margin-bottom:18px; display:flex; align-items:center; gap:10px;">
                    <?php echo icon('circle-check', 'svg-icon'); ?>
                    <span><?php echo htmlspecialchars($flash['ok'], ENT_QUOTES); ?></span>
                </div>
            <?php endif; ?>
            <?php if ($flash['err']): ?>
                <div class="alert" style="background:var(--color-danger-soft); border:1px solid var(--color-danger); color:var(--color-danger); padding:12px 16px; border-radius:10px; margin-bottom:18px;">
                    <?php echo htmlspecialchars($flash['err'], ENT_QUOTES); ?>
                </div>
            <?php endif; ?>

            <div class="card">
                <div class="table-wrap">
                    <table id="discountsTable" class="display app-table" style="width:100%">
                        <thead>
                            <tr>
                                <th>کد</th>
                                <th>نوع</th>
                                <th>مقدار</th>
                                <th>سقف کل</th>
                                <th>تعداد استفاده</th>
                                <th>گروه هدف</th>
                                <th>محدودیت</th>
                                <th>عملیات</th>
                            </tr>
                        </thead>
                        <tbody>
                        <?php if (empty($list)): ?>
                            <tr><td colspan="8" style="text-align:center; padding:30px 0; color:var(--text-muted);">
                                هنوز کدی ثبت نشده است.
                            </td></tr>
                        <?php else: foreach ($list as $d):
                            $kind = $d['value_type'] ?? '';
                            if (!in_array($kind, ['percent','amount','free'], true)) {
                                $kind = in_array(($d['type'] ?? ''), ['percent','amount','free'], true) ? $d['type'] : 'percent';
                            }
                            [$typeLabel, $typeBadge] = faoxima_d_label_type($kind);
                            $sectionVal = $d['section'] ?? '';
                            if ($sectionVal === '') $sectionVal = in_array(($d['type'] ?? ''), ['buy','extend'], true) ? $d['type'] : 'all';
                            [$secLabel, $secBadge] = faoxima_d_label_section($sectionVal);
                            [$agentLabel, $agentBadge] = faoxima_d_label_agent($d['agent'] ?? '');
                            $valDisplay = htmlspecialchars((string)$d['price'], ENT_QUOTES);
                            if ($kind === 'percent') $valDisplay .= '%';
                            elseif ($kind === 'amount') $valDisplay = number_format((int)$d['price']) . ' <small>تومان</small>';
                            elseif ($kind === 'free') $valDisplay = 'رایگان';
                            $limit = (int)$d['limitDiscount'];
                            $used  = (int)$d['usedDiscount'];
                            $remaining = $limit > 0 ? max(0, $limit - $used) : -1;
                            $targetUser = trim((string)($d['target_user'] ?? ''));
                            $editAgent = in_array(($d['agent'] ?? ''), ['f','n','n2'], true) ? $d['agent'] : 'allusers';
                            $editExpTs = (int)($d['time'] ?? 0);
                            $editExpDays = ($editExpTs > time()) ? (int)ceil(($editExpTs - time()) / 86400) : 0;
                        ?>
                            <tr>
                                <td data-label="کد"><code style="direction:ltr; background:var(--accent-soft); color:var(--accent); padding:4px 8px; border-radius:6px; font-weight:700;"><?php echo htmlspecialchars($d['codeDiscount'], ENT_QUOTES); ?></code></td>
                                <td data-label="نوع">
                                    <span class="badge <?php echo $typeBadge; ?>"><?php echo $typeLabel; ?></span>
                                    <span class="badge <?php echo $secBadge; ?>"><?php echo $secLabel; ?></span>
                                    <?php if ($targetUser !== ''): ?><span class="badge badge-warning">کاربر <?php echo htmlspecialchars($targetUser, ENT_QUOTES); ?></span><?php endif; ?>
                                </td>
                                <td data-label="مقدار"><?php echo $valDisplay; ?></td>
                                <td data-label="سقف کل"><?php echo $limit > 0 ? $limit : '<span class="text-muted">نامحدود</span>'; ?></td>
                                <td data-label="تعداد استفاده">
                                    <b style="color:<?php echo ($remaining === 0) ? 'var(--color-danger)' : 'var(--color-success)'; ?>;"><?php echo $used; ?></b>
                                    <?php if ($limit > 0): ?>/ <?php echo $limit; ?><?php endif; ?>
                                </td>
                                <td data-label="گروه هدف"><span class="badge <?php echo $agentBadge; ?>"><?php echo $agentLabel; ?></span></td>
                                <td data-label="محدودیت">
                                    <?php if ($d['usefirst'] == '1'): ?>
                                        <span class="badge badge-warning">فقط خرید اول</span>
                                    <?php endif; ?>
                                    <?php if ($d['useuser'] == '1'): ?>
                                        <span class="badge badge-info">یک بار/کاربر</span>
                                    <?php endif; ?>
                                    <?php if ($d['usefirst'] != '1' && $d['useuser'] != '1'): ?>
                                        <span class="text-muted">نامحدود</span>
                                    <?php endif; ?>
                                </td>
                                <td data-label="عملیات" class="cell-actions">
                                    <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                                        <button type="button" class="btn btn-sm btn-soft-info" title="ویرایش"
                                            data-id="<?php echo (int)$d['id']; ?>"
                                            data-code="<?php echo htmlspecialchars($d['codeDiscount'], ENT_QUOTES); ?>"
                                            data-vt="<?php echo htmlspecialchars($kind, ENT_QUOTES); ?>"
                                            data-section="<?php echo htmlspecialchars($sectionVal, ENT_QUOTES); ?>"
                                            data-price="<?php echo htmlspecialchars((string)$d['price'], ENT_QUOTES); ?>"
                                            data-limit="<?php echo (int)$d['limitDiscount']; ?>"
                                            data-agent="<?php echo htmlspecialchars($editAgent, ENT_QUOTES); ?>"
                                            data-first="<?php echo $d['usefirst'] == '1' ? '1' : '0'; ?>"
                                            data-useuser="<?php echo $d['useuser'] == '1' ? '1' : '0'; ?>"
                                            data-target="<?php echo htmlspecialchars($targetUser, ENT_QUOTES); ?>"
                                            data-exp="<?php echo (int)$editExpDays; ?>"
                                            onclick="editDiscount(this)">
                                            <?php echo icon('pen-to-square', 'svg-icon'); ?>
                                        </button>
                                        <form method="POST" style="display:inline" onsubmit="return confirm('شمارنده استفاده این کد صفر شود؟');">
                                            <input type="hidden" name="_action" value="reset_usage">
                                            <input type="hidden" name="id" value="<?php echo (int)$d['id']; ?>">
                                            <button type="submit" class="btn btn-sm btn-soft-warning" title="بازنشانی شمارنده استفاده">
                                                <?php echo icon('rotate-left', 'svg-icon'); ?>
                                            </button>
                                        </form>
                                        <form method="POST" style="display:inline" onsubmit="return confirm('کد <?php echo htmlspecialchars($d['codeDiscount'], ENT_QUOTES); ?> حذف شود؟');">
                                            <input type="hidden" name="_action" value="delete">
                                            <input type="hidden" name="id" value="<?php echo (int)$d['id']; ?>">
                                            <button type="submit" class="btn btn-sm btn-soft-danger">
                                                <?php echo icon('trash', 'svg-icon'); ?>
                                            </button>
                                        </form>
                                    </div>
                                </td>
                            </tr>
                        <?php endforeach; endif; ?>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="card" style="margin-top:18px">
                <div style="padding:14px 16px; font-weight:700; display:flex; align-items:center; gap:8px;">
                    <?php echo icon('gift', 'svg-icon'); ?> کدهای هدیه (شارژ کیف پول)
                </div>
                <div class="table-wrap">
                    <table id="giftsTable" class="display app-table" style="width:100%">
                        <thead>
                            <tr>
                                <th>کد</th>
                                <th>مبلغ</th>
                                <th>سقف کل</th>
                                <th>تعداد استفاده</th>
                                <th>اختصاصی</th>
                                <th>عملیات</th>
                            </tr>
                        </thead>
                        <tbody>
                        <?php if (empty($giftList)): ?>
                            <tr><td colspan="6" style="text-align:center; padding:30px 0; color:var(--text-muted);">هنوز کد هدیه‌ای ثبت نشده است.</td></tr>
                        <?php else: foreach ($giftList as $g):
                            $glimit = (int)($g['limituse'] ?? 0);
                            $gused  = (int)($g['limitused'] ?? 0);
                            $gtarget = trim((string)($g['target_user'] ?? ''));
                            $gEditExpTs = (int)($g['expire_at'] ?? 0);
                            $gEditExpDays = ($gEditExpTs > time()) ? (int)ceil(($gEditExpTs - time()) / 86400) : 0;
                        ?>
                            <tr>
                                <td data-label="کد"><code style="direction:ltr; background:var(--accent-soft); color:var(--accent); padding:4px 8px; border-radius:6px; font-weight:700;"><?php echo htmlspecialchars((string)$g['code'], ENT_QUOTES); ?></code></td>
                                <td data-label="مبلغ"><?php echo number_format((int)($g['price'] ?? 0)); ?> <small>تومان</small></td>
                                <td data-label="سقف کل"><?php echo $glimit > 0 ? $glimit : '<span class="text-muted">نامحدود</span>'; ?></td>
                                <td data-label="تعداد استفاده"><?php echo $gused; ?><?php if ($glimit > 0): ?> / <?php echo $glimit; ?><?php endif; ?></td>
                                <td data-label="اختصاصی"><?php echo $gtarget !== '' ? '<span class="badge badge-warning">کاربر ' . htmlspecialchars($gtarget, ENT_QUOTES) . '</span>' : '<span class="text-muted">عمومی</span>'; ?></td>
                                <td data-label="عملیات" class="cell-actions">
                                    <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                                        <button type="button" class="btn btn-sm btn-soft-info" title="ویرایش"
                                            data-id="<?php echo (int)$g['id']; ?>"
                                            data-code="<?php echo htmlspecialchars((string)$g['code'], ENT_QUOTES); ?>"
                                            data-price="<?php echo (int)($g['price'] ?? 0); ?>"
                                            data-limit="<?php echo (int)($g['limituse'] ?? 0); ?>"
                                            data-target="<?php echo htmlspecialchars($gtarget, ENT_QUOTES); ?>"
                                            data-exp="<?php echo (int)$gEditExpDays; ?>"
                                            onclick="editGift(this)">
                                            <?php echo icon('pen-to-square', 'svg-icon'); ?>
                                        </button>
                                        <form method="POST" style="display:inline" onsubmit="return confirm('کد هدیه حذف شود؟');">
                                            <input type="hidden" name="_action" value="gift_delete">
                                            <input type="hidden" name="id" value="<?php echo (int)$g['id']; ?>">
                                            <button type="submit" class="btn btn-sm btn-soft-danger"><?php echo icon('trash', 'svg-icon'); ?></button>
                                        </form>
                                    </div>
                                </td>
                            </tr>
                        <?php endforeach; endif; ?>
                        </tbody>
                    </table>
                </div>
            </div>


<div id="modal-add-discount" class="modal-overlay">
    <div class="modal-box" style="max-width: 560px;">
        <div class="modal-head">
            <span class="modal-head__title">افزودن کد تخفیف جدید</span>
            <button type="button" class="modal-close" onclick="closeModal('modal-add-discount')">&times;</button>
        </div>
        <form method="POST" action="discounts.php">
            <input type="hidden" name="_action" value="add">

            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">کد تخفیف</label>
                    <input type="text" name="codeDiscount" class="form-control" style="direction:ltr; font-family:'JetBrains Mono', monospace;" placeholder="FAOXIMA20" required>
                </div>
                <div class="form-group">
                    <label class="form-label">نوع تخفیف</label>
                    <select name="type" class="form-control" required onchange="updateValueHint(this.value)">
                        <option value="percent">درصدی (٪)</option>
                        <option value="amount">مبلغی (تومان)</option>
                        <option value="free">رایگان (۱۰۰٪)</option>
                    </select>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" id="valueLabel">مقدار تخفیف (٪)</label>
                    <input type="number" name="price" class="form-control" placeholder="20" required min="0">
                </div>
                <div class="form-group">
                    <label class="form-label">سقف کل استفاده <small style="color:var(--text-muted)">(۰ = نامحدود)</small></label>
                    <input type="number" name="limitDiscount" class="form-control" placeholder="100" value="0" min="0">
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">بخش کد</label>
                    <select name="section" class="form-control">
                        <option value="all">همه بخش‌ها</option>
                        <option value="buy">خرید سرویس</option>
                        <option value="extend">تمدید سرویس</option>
                        <option value="volume">حجم اضافه</option>
                        <option value="time">زمان اضافه</option>
                        <option value="charge">شارژ کیف پول</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">انقضا (روز) <small style="color:var(--text-muted)">(۰ = بدون انقضا)</small></label>
                    <input type="number" name="expire_days" class="form-control" placeholder="0" value="0" min="0">
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">گروه هدف</label>
                    <select name="agent" class="form-control">
                        <option value="allusers">همه کاربران</option>
                        <option value="f">فقط کاربر عادی</option>
                        <option value="n">فقط نمایندگان</option>
                        <option value="n2">فقط نمایندگان پیشرفته</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">کد اختصاصی کاربر <small style="color:var(--text-muted)">(آیدی عددی، اختیاری)</small></label>
                    <input type="text" name="target_user" class="form-control" style="direction:ltr" placeholder="123456789">
                </div>
            </div>

            <div class="form-group" style="display:flex; flex-direction:column; gap:8px;">
                <label style="display:flex; align-items:center; gap:10px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" name="usefirst" value="1">
                    فقط برای خرید اول کاربر قابل استفاده باشد
                </label>
                <label style="display:flex; align-items:center; gap:10px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" name="useuser" value="1">
                    هر کاربر فقط یک بار بتواند استفاده کند
                </label>
            </div>

            <div class="modal-foot">
                <button type="button" class="btn btn-outline btn-sm" onclick="closeModal('modal-add-discount')">انصراف</button>
                <button type="submit" class="btn btn-primary btn-sm">
                    <?php echo icon('plus', 'svg-icon svg-sm'); ?>
                    افزودن کد
                </button>
            </div>
        </form>
    </div>
</div>

<div id="modal-add-gift" class="modal-overlay">
    <div class="modal-box" style="max-width: 480px;">
        <div class="modal-head">
            <span class="modal-head__title">افزودن کد هدیه</span>
            <button type="button" class="modal-close" onclick="closeModal('modal-add-gift')">&times;</button>
        </div>
        <form method="POST" action="discounts.php">
            <input type="hidden" name="_action" value="gift_add">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">کد هدیه</label>
                    <input type="text" name="code" class="form-control" style="direction:ltr;" placeholder="GIFT50" required>
                </div>
                <div class="form-group">
                    <label class="form-label">مبلغ (تومان)</label>
                    <input type="number" name="gift_price" class="form-control" placeholder="50000" required min="1">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">سقف کل استفاده <small style="color:var(--text-muted)">(۰ = نامحدود)</small></label>
                    <input type="number" name="gift_limit" class="form-control" value="0" min="0">
                </div>
                <div class="form-group">
                    <label class="form-label">انقضا (روز) <small style="color:var(--text-muted)">(۰ = بدون انقضا)</small></label>
                    <input type="number" name="gift_expire_days" class="form-control" value="0" min="0">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">کد اختصاصی کاربر <small style="color:var(--text-muted)">(آیدی عددی، اختیاری)</small></label>
                <input type="text" name="gift_target" class="form-control" style="direction:ltr" placeholder="123456789">
            </div>
            <div class="modal-foot">
                <button type="button" class="btn btn-outline btn-sm" onclick="closeModal('modal-add-gift')">انصراف</button>
                <button type="submit" class="btn btn-primary btn-sm"><?php echo icon('plus', 'svg-icon svg-sm'); ?> افزودن</button>
            </div>
        </form>
    </div>
</div>

<div id="modal-edit-discount" class="modal-overlay">
    <div class="modal-box" style="max-width: 560px;">
        <div class="modal-head">
            <span class="modal-head__title">ویرایش کد تخفیف</span>
            <button type="button" class="modal-close" onclick="closeModal('modal-edit-discount')">&times;</button>
        </div>
        <form method="POST" action="discounts.php">
            <input type="hidden" name="_action" value="edit">
            <input type="hidden" name="id" id="ed_id">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">کد تخفیف</label>
                    <input type="text" name="codeDiscount" id="ed_code" class="form-control" style="direction:ltr; font-family:'JetBrains Mono', monospace;" required>
                </div>
                <div class="form-group">
                    <label class="form-label">نوع تخفیف</label>
                    <select name="type" id="ed_type" class="form-control" required onchange="updateEditValueHint(this.value)">
                        <option value="percent">درصدی (٪)</option>
                        <option value="amount">مبلغی (تومان)</option>
                        <option value="free">رایگان (۱۰۰٪)</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" id="ed_valueLabel">مقدار تخفیف (٪)</label>
                    <input type="number" name="price" id="ed_price" class="form-control" required min="0">
                </div>
                <div class="form-group">
                    <label class="form-label">سقف کل استفاده <small style="color:var(--text-muted)">(۰ = نامحدود)</small></label>
                    <input type="number" name="limitDiscount" id="ed_limit" class="form-control" min="0">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">بخش کد</label>
                    <select name="section" id="ed_section" class="form-control">
                        <option value="all">همه بخش‌ها</option>
                        <option value="buy">خرید سرویس</option>
                        <option value="extend">تمدید سرویس</option>
                        <option value="volume">حجم اضافه</option>
                        <option value="time">زمان اضافه</option>
                        <option value="charge">شارژ کیف پول</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">انقضا (روز) <small style="color:var(--text-muted)">(۰ = بدون انقضا)</small></label>
                    <input type="number" name="expire_days" id="ed_exp" class="form-control" min="0">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">گروه هدف</label>
                    <select name="agent" id="ed_agent" class="form-control">
                        <option value="allusers">همه کاربران</option>
                        <option value="f">فقط کاربر عادی</option>
                        <option value="n">فقط نمایندگان</option>
                        <option value="n2">فقط نمایندگان پیشرفته</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">کد اختصاصی کاربر <small style="color:var(--text-muted)">(آیدی عددی، اختیاری)</small></label>
                    <input type="text" name="target_user" id="ed_target" class="form-control" style="direction:ltr">
                </div>
            </div>
            <div class="form-group" style="display:flex; flex-direction:column; gap:8px;">
                <label style="display:flex; align-items:center; gap:10px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" name="usefirst" id="ed_first" value="1">
                    فقط برای خرید اول کاربر قابل استفاده باشد
                </label>
                <label style="display:flex; align-items:center; gap:10px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" name="useuser" id="ed_useuser" value="1">
                    هر کاربر فقط یک بار بتواند استفاده کند
                </label>
            </div>
            <div class="modal-foot">
                <button type="button" class="btn btn-outline btn-sm" onclick="closeModal('modal-edit-discount')">انصراف</button>
                <button type="submit" class="btn btn-primary btn-sm"><?php echo icon('pen-to-square', 'svg-icon svg-sm'); ?> ذخیره تغییرات</button>
            </div>
        </form>
    </div>
</div>

<div id="modal-edit-gift" class="modal-overlay">
    <div class="modal-box" style="max-width: 480px;">
        <div class="modal-head">
            <span class="modal-head__title">ویرایش کد هدیه</span>
            <button type="button" class="modal-close" onclick="closeModal('modal-edit-gift')">&times;</button>
        </div>
        <form method="POST" action="discounts.php">
            <input type="hidden" name="_action" value="gift_edit">
            <input type="hidden" name="id" id="ed_g_id">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">کد هدیه</label>
                    <input type="text" name="code" id="ed_g_code" class="form-control" style="direction:ltr;" required>
                </div>
                <div class="form-group">
                    <label class="form-label">مبلغ (تومان)</label>
                    <input type="number" name="gift_price" id="ed_g_price" class="form-control" required min="1">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">سقف کل استفاده <small style="color:var(--text-muted)">(۰ = نامحدود)</small></label>
                    <input type="number" name="gift_limit" id="ed_g_limit" class="form-control" min="0">
                </div>
                <div class="form-group">
                    <label class="form-label">انقضا (روز) <small style="color:var(--text-muted)">(۰ = بدون انقضا)</small></label>
                    <input type="number" name="gift_expire_days" id="ed_g_exp" class="form-control" min="0">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">کد اختصاصی کاربر <small style="color:var(--text-muted)">(آیدی عددی، اختیاری)</small></label>
                <input type="text" name="gift_target" id="ed_g_target" class="form-control" style="direction:ltr">
            </div>
            <div class="modal-foot">
                <button type="button" class="btn btn-outline btn-sm" onclick="closeModal('modal-edit-gift')">انصراف</button>
                <button type="submit" class="btn btn-primary btn-sm"><?php echo icon('pen-to-square', 'svg-icon svg-sm'); ?> ذخیره تغییرات</button>
            </div>
        </form>
    </div>
</div>

<script src="js/datatable.js" defer>

</script>
<script>
document.addEventListener('DOMContentLoaded', function () {
    FaoximaDT.init('#discountsTable');
    FaoximaDT.init('#giftsTable');
});

function openModal(id) { var m = document.getElementById(id); if (m) m.classList.add('active'); }
function closeModal(id) { var m = document.getElementById(id); if (m) m.classList.remove('active'); }

function updateValueHint(type) {
    var lbl = document.getElementById('valueLabel');
    if (type === 'percent') lbl.textContent = 'مقدار تخفیف (٪)';
    else if (type === 'amount') lbl.textContent = 'مقدار تخفیف (تومان)';
    else lbl.textContent = 'مقدار (استفاده‌نمی‌شود)';
}

function updateEditValueHint(type) {
    var lbl = document.getElementById('ed_valueLabel');
    if (!lbl) return;
    if (type === 'percent') lbl.textContent = 'مقدار تخفیف (٪)';
    else if (type === 'amount') lbl.textContent = 'مقدار تخفیف (تومان)';
    else lbl.textContent = 'مقدار (استفاده‌نمی‌شود)';
}
function editDiscount(btn) {
    document.getElementById('ed_id').value      = btn.getAttribute('data-id');
    document.getElementById('ed_code').value    = btn.getAttribute('data-code');
    document.getElementById('ed_type').value    = btn.getAttribute('data-vt');
    document.getElementById('ed_section').value = btn.getAttribute('data-section');
    document.getElementById('ed_price').value   = btn.getAttribute('data-price');
    document.getElementById('ed_limit').value   = btn.getAttribute('data-limit');
    document.getElementById('ed_agent').value   = btn.getAttribute('data-agent');
    document.getElementById('ed_exp').value      = btn.getAttribute('data-exp');
    document.getElementById('ed_target').value  = btn.getAttribute('data-target');
    document.getElementById('ed_first').checked   = btn.getAttribute('data-first') === '1';
    document.getElementById('ed_useuser').checked = btn.getAttribute('data-useuser') === '1';
    updateEditValueHint(btn.getAttribute('data-vt'));
    openModal('modal-edit-discount');
}
function editGift(btn) {
    document.getElementById('ed_g_id').value     = btn.getAttribute('data-id');
    document.getElementById('ed_g_code').value   = btn.getAttribute('data-code');
    document.getElementById('ed_g_price').value  = btn.getAttribute('data-price');
    document.getElementById('ed_g_limit').value  = btn.getAttribute('data-limit');
    document.getElementById('ed_g_target').value = btn.getAttribute('data-target');
    document.getElementById('ed_g_exp').value    = btn.getAttribute('data-exp');
    openModal('modal-edit-gift');
}
</script>
</body>
</html>


