<?php


if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

// Panel version (read from the project root `version` file). Displayed in the
// sidebar footer on every page. Always shown with a leading "v".
$__panelVersionRaw = trim((string)@file_get_contents(__DIR__ . '/../version'));
if ($__panelVersionRaw === '') $__panelVersionRaw = '0.0.2';
$__panelVersion = (stripos($__panelVersionRaw, 'v') === 0) ? $__panelVersionRaw : ('v' . $__panelVersionRaw);

if (isset($_SESSION["user"])) {
    $__can_check = false;
    $__ip_list   = [];
    $__iplogin_unlimited = false;
    if (isset($pdo) && $pdo instanceof PDO) {
        $__can_check   = true;
        $__stmt_ip     = $pdo->query("SELECT iplogin FROM setting LIMIT 1");
        $__raw_iplogin = $__stmt_ip ? (string)$__stmt_ip->fetchColumn() : '';
        if ($__raw_iplogin === '*' || $__raw_iplogin === 'all' || $__raw_iplogin === 'unlimited') {
            $__iplogin_unlimited = true;
        } elseif ($__raw_iplogin !== '' && $__raw_iplogin !== '0') {
            $__decoded = json_decode($__raw_iplogin, true);
            if (is_array($__decoded)) {
                if (in_array('*', $__decoded, true) || in_array('all', $__decoded, true) || in_array('unlimited', $__decoded, true)) {
                    $__iplogin_unlimited = true;
                } else {
                    $__ip_list = $__decoded;
                }
            } elseif (filter_var($__raw_iplogin, FILTER_VALIDATE_IP)) {
                $__ip_list = [$__raw_iplogin];
            }
        }
    }
    if ($__can_check) {
        $__current_ip = $_SERVER['REMOTE_ADDR'] ?? '';
        $__allowed    = $__iplogin_unlimited || (!empty($__ip_list) && in_array($__current_ip, $__ip_list, true));
        if (!$__allowed) {
            session_unset();
            session_destroy();
            header('Location: login.php', true, 302);
            exit;
        }
        unset($__current_ip, $__allowed);
    }
    unset($__can_check, $__ip_list, $__raw_iplogin, $__decoded, $__stmt_ip, $__iplogin_unlimited);
}


if (!function_exists('icon')) {
    $__iconsLib = __DIR__ . '/lib/icons.php';
    if (is_file($__iconsLib) && is_readable($__iconsLib)) {
        @include_once $__iconsLib;
    }
}
if (!function_exists('icon')) {
    function icon(string $name, string $class = 'svg-icon'): string {
        static $paths = [
            'bars'        => '<line x1="4" y1="6"  x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
            'robot'       => '<rect x="3" y="11" width="18" height="10" rx="2" ry="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8"  y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/>',
            'chevron-down'=> '<polyline points="6 9 12 15 18 9"/>',
            'moon'        => '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
            'arrow-right-from-bracket' => '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
            'home'        => '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
            'users'       => '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
            'dollar-sign' => '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
            'package'     => '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
            'grid'        => '<rect x="3"  y="3"  width="7" height="7"/><rect x="14" y="3"  width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3"  y="14" width="7" height="7"/>',
            'wallet'      => '<rect x="2" y="6" width="20" height="14" rx="2"/><polyline points="22 12 18 12 18 16 22 16"/><path d="M2 10V6a2 2 0 0 1 2-2h14"/>',
            'ban'         => '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
            'keyboard'    => '<rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="6"  y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="7"  y1="16" x2="17" y2="16"/>',
        ];
        $p = $paths[$name] ?? '<circle cx="12" cy="12" r="3"/>';
        return '<svg class="' . htmlspecialchars($class, ENT_QUOTES, 'UTF-8') . '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . $p . '</svg>';
    }
}

$__user    = isset($_SESSION["user"]) ? htmlspecialchars($_SESSION["user"], ENT_QUOTES, 'UTF-8') : 'admin';
$__current = strtolower(basename($_SERVER['SCRIPT_NAME'] ?? 'index.php'));
$__avatar  = function_exists('mb_substr') ? mb_substr($__user, 0, 1, 'UTF-8') : substr($__user, 0, 1);


$__schemaLib = __DIR__ . '/lib/schema.php';
if (is_file($__schemaLib) && is_readable($__schemaLib)) {
    @include_once $__schemaLib;
    if (function_exists('faoxima_schema_ready') && isset($pdo) && $pdo instanceof PDO) {
        try { faoxima_schema_ready($pdo); } catch (\Throwable $e) { error_log('[header] schema_ready failed: ' . $e->getMessage()); }
    }
}
?>

<script>
(function () {
    try {


        var color = localStorage.getItem('faoxima_color') || 'blue';
        var html = document.documentElement;
        var s = html.style;
        var PRESET = { red:'#ef4444', blue:'#3b82f6', purple:'#a855f7', yellow:'#facc15', orange:'#f97316', green:'#22c55e' };
        function fg(r,g,b){ function lin(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); } var L=0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b); return L>0.45?'#14121d':'#ffffff'; }
        var hex;
        if (PRESET[color]) { hex = PRESET[color]; html.setAttribute('data-color', color); }
        else {
            var m=/^#?([0-9a-f]{6})$/i.exec(color);
            if (m) { hex='#'+m[1].toLowerCase(); var n=parseInt(m[1],16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
                s.setProperty('--accent',hex); s.setProperty('--accent-soft','rgba('+r+','+g+','+b+',0.15)');
                s.setProperty('--accent-mid','rgba('+r+','+g+','+b+',0.35)'); s.setProperty('--accent-glow','rgba('+r+','+g+','+b+',0.5)');
                html.setAttribute('data-color','custom'); }
            else { hex=PRESET.blue; html.setAttribute('data-color','blue'); }
        }
        var pn=parseInt(hex.slice(1),16); s.setProperty('--accent-fg', fg((pn>>16)&255,(pn>>8)&255,pn&255));
        html.setAttribute('data-theme','dark');
    } catch (e) {  }
})();
</script>

<header class="app-header">
    <div class="app-header__left">
        <button class="btn-icon" id="sidebar-toggle" aria-label="منو">
            <?php echo icon('bars'); ?>
        </button>
        <a href="index.php" class="app-logo">
            <span class="app-logo__mark"><?php echo icon('robot', 'svg-icon svg-sm'); ?></span>
            ربات&nbsp;<span>فاکسیما</span>
        </a>
        <span class="app-status-pill">پنل آنلاین — اتصال برقرار</span>
    </div>

    <div class="profile-wrap">
        <button class="profile-trigger" type="button" aria-label="حساب کاربری">
            
            <span class="profile-avatar"
                  style="background:transparent; border-color:rgba(255,255,255,0.18); border-radius:10px; overflow:hidden; padding:0;"
                  title="فاکسیما">
                <img src="https://avatars.githubusercontent.com/u/238855591?s=80&v=4"
                     alt="Faoxima"
                     loading="lazy"
                     referrerpolicy="no-referrer"
                     width="36" height="36"
                     style="width:100%; height:100%; object-fit:cover; display:block; border:0;">
            </span>
            <span class="profile-info">
                <b>حساب کاربری</b>
                <small><?php echo $__user; ?></small>
            </span>
            <?php echo icon('chevron-down', 'svg-icon svg-xs'); ?>
        </button>

        <div class="profile-menu">
            <div class="profile-menu__head">
                <b><?php echo $__user; ?></b>
                <small>مدیر کل</small>
            </div>

            <a href="appearance.php" class="menu-item">
                <svg class="svg-icon svg-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                <span>تنظیمات</span>
            </a>

            <hr>

            <a href="login.php" class="menu-danger">
                <?php echo icon('arrow-right-from-bracket', 'svg-icon svg-sm'); ?>
                <span>خروج از حساب</span>
            </a>
        </div>
    </div>
</header>

<aside class="app-sidebar">
    <div class="sidebar-section-label">منوی اصلی</div>
    <ul class="sidebar-menu">
        <li><a href="index.php"><span class="menu-symbol"><?php echo icon('home', 'svg-icon svg-sm'); ?></span><span>صفحه اصلی</span></a></li>
        <li><a href="users.php"><span class="menu-symbol"><?php echo icon('users', 'svg-icon svg-sm'); ?></span><span>کاربران</span></a></li>
        <li><a href="invoice.php"><span class="menu-symbol"><?php echo icon('dollar-sign', 'svg-icon svg-sm'); ?></span><span>سفارشات</span></a></li>
        <li><a href="service.php"><span class="menu-symbol"><?php echo icon('package', 'svg-icon svg-sm'); ?></span><span>سرویس‌ها</span></a></li>
        <li><a href="product.php"><span class="menu-symbol"><?php echo icon('grid', 'svg-icon svg-sm'); ?></span><span>محصولات</span></a></li>
        <li><a href="payment.php"><span class="menu-symbol"><?php echo icon('wallet', 'svg-icon svg-sm'); ?></span><span>تراکنش‌ها</span></a></li>
        <li><a href="cancelService.php"><span class="menu-symbol"><?php echo icon('list', 'svg-icon svg-sm'); ?></span><span>لیست درخواست‌ها</span></a></li>
    </ul>

    <div class="sidebar-section-label">مدیریت</div>
    <ul class="sidebar-menu">
        <li><a href="panels.php"><span class="menu-symbol"><?php echo icon('server', 'svg-icon svg-sm'); ?></span><span>مدیریت پنل‌ها</span></a></li>
        <li><a href="stock.php"><span class="menu-symbol"><?php echo icon('package', 'svg-icon svg-sm'); ?></span><span>انبار شبکه ملی</span></a></li>
        <li><a href="discounts.php"><span class="menu-symbol"><?php echo icon('ticket', 'svg-icon svg-sm'); ?></span><span>کدهای تخفیف</span></a></li>
    </ul>

    <div class="sidebar-section-label">پیکربندی</div>
    <ul class="sidebar-menu">
        <li><a href="textbot.php"><span class="menu-symbol"><?php echo icon('text', 'svg-icon svg-sm'); ?></span><span>متن‌های ربات</span></a></li>
        <li><a href="keyboard.php"><span class="menu-symbol"><?php echo icon('keyboard', 'svg-icon svg-sm'); ?></span><span>چیدمان کیبورد</span></a></li>
        <li><a href="service_keyboard.php"><span class="menu-symbol"><?php echo icon('palette', 'svg-icon svg-sm'); ?></span><span>رنگ‌بندی دکمه‌ها</span></a></li>
    </ul>

    <div class="sidebar-version" style="margin-top:auto; padding:14px 16px; border-top:1px solid var(--border-soft,#2a2a35); display:flex; align-items:center; gap:8px; color:var(--text-muted,#8a8a9a); font-size:12px;">
        <span class="menu-symbol"><?php echo icon('robot', 'svg-icon svg-sm'); ?></span>
        <span>نسخه</span>
        <span class="badge badge-info" style="direction:ltr; font-family:'JetBrains Mono',monospace;"><?php echo htmlspecialchars($__panelVersion, ENT_QUOTES, 'UTF-8'); ?></span>
    </div>
</aside>

<div class="sidebar-overlay"></div>


