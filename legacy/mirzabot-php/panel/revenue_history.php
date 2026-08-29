<?php
// filepath: /var/www/html/mirzaprobotconfig/panel/revenue_history.php
// Full audit history of every manual revenue adjustment ever made.
// Supports pagination, search, type filter, delete, edit-note and shows a running cumulative total.
require_once __DIR__ . '/inc/config.php';
require_once __DIR__ . '/inc/icons.php';
require_auth();

$page   = max(1, (int) ($_GET['page'] ?? 1));
$perPage = 25;
$offset = ($page - 1) * $perPage;

$typeFilter = $_GET['type'] ?? '';   // '' | 'add' | 'deduct'
$q          = trim($_GET['q'] ?? '');

// Build WHERE
$where = [];
$params = [];
if ($typeFilter === 'add' || $typeFilter === 'deduct') {
  $where[] = 'type = ?';
  $params[] = $typeFilter;
}
if ($q !== '') {
  $where[] = '(note LIKE ? OR created_by LIKE ? OR CAST(amount AS CHAR) LIKE ?)';
  $like = '%' . $q . '%';
  $params[] = $like; $params[] = $like; $params[] = $like;
}
$whereSQL = $where ? 'WHERE ' . implode(' AND ', $where) : '';

try {
  $total = (int) db_count($pdo, "SELECT COUNT(*) FROM revenue_adjustment_log $whereSQL", $params);
  $rows  = db_fetchAll(
    $pdo,
    "SELECT id, amount, type, note, created_by, created_at
       FROM revenue_adjustment_log
       $whereSQL
       ORDER BY created_at DESC, id DESC
       LIMIT $perPage OFFSET $offset",
    $params
  );

  // For the running cumulative total, fetch ALL matching rows (cheap up to a few thousand).
  $allMatching = db_fetchAll(
    $pdo,
    "SELECT id, amount, type, created_at FROM revenue_adjustment_log $whereSQL ORDER BY created_at ASC, id ASC",
    $params
  );
  $running = 0;
  $runningMap = []; // id => cumulative total at that point (signed sum up to and including this row)
  foreach ($allMatching as $r) {
    $running += (int) $r['amount'];
    $runningMap[(int) $r['id']] = $running;
  }

  // Also fetch the overall (unfiltered) total adjustment that the dashboard uses
  $overallAdj = (int) (db_fetch($pdo, "SELECT revenue_adjustment FROM setting LIMIT 1")['revenue_adjustment'] ?? 0);

  // Totals per type (within current filter)
  $filterSumAdd    = 0;
  $filterSumDeduct = 0;
  foreach ($allMatching as $r) {
    if ($r['type'] === 'add')    $filterSumAdd    += (int) $r['amount'];
    if ($r['type'] === 'deduct') $filterSumDeduct += (int) $r['amount'];
  }
} catch (Throwable $e) {
  $total = 0;
  $rows = [];
  $runningMap = [];
  $allMatching = [];
  $overallAdj = 0;
  $filterSumAdd = 0;
  $filterSumDeduct = 0;
  error_log('revenue_history.php: ' . $e->getMessage());
}

$totalPages = max(1, (int) ceil($total / $perPage));

$pageTitle = 'Revenue adjustment history';
$activeNav = 'settings';
include __DIR__ . '/inc/layout_head.php';

// Page-active helpers
$qs = function (array $extra) use ($q, $typeFilter, $page) {
  return '?' . http_build_query(array_merge(['q' => $q, 'type' => $typeFilter, 'page' => $page], $extra));
};
?>

<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;flex-wrap:wrap" class="fade-up">
  <div>
    <a href="settings.php?tab=system" style="display:inline-flex;align-items:center;gap:6px;color:var(--mute);text-decoration:none;font-size:.82rem;margin-bottom:8px">
      <?= icon('back', 14) ?> Back to Settings
    </a>
    <h1 style="font-size:1.4rem;font-weight:700;margin:0">Revenue adjustment history</h1>
    <div style="color:var(--mute);font-size:.85rem;margin-top:4px">Every manual add/deduct made to the dashboard's revenue total.</div>
  </div>
</div>

<div class="stats fade-up d1" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
  <div class="stat ok">
    <div class="stat-label">Total adds (matching filter)</div>
    <div class="stat-num">+<?= number_format($filterSumAdd) ?> <span style="font-size:.55em;color:var(--mute)">T</span></div>
    <div class="stat-meta"><?= count(array_filter($allMatching, fn($r) => $r['type']==='add')) ?> entries</div>
  </div>
  <div class="stat no">
    <div class="stat-label">Total deducts (matching filter)</div>
    <div class="stat-num"><?= $filterSumDeduct >= 0 ? '−' : '' ?><?= number_format(abs($filterSumDeduct)) ?> <span style="font-size:.55em;color:var(--mute)">T</span></div>
    <div class="stat-meta"><?= count(array_filter($allMatching, fn($r) => $r['type']==='deduct')) ?> entries</div>
  </div>
  <div class="stat">
    <div class="stat-label">Current panel adjustment</div>
    <div class="stat-num"><?= number_format($overallAdj) ?> <span style="font-size:.55em;color:var(--mute)">T</span></div>
    <div class="stat-meta">shown beside total revenue</div>
  </div>
</div>

<div class="card fade-up d2">
  <div class="toolbar">
    <div class="toolbar-title">
      History
      <small>(<?= number_format($total) ?> <?= $q || $typeFilter ? 'matching' : 'total' ?>)</small>
    </div>
    <form method="GET" class="toolbar-end" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select name="type" class="select" style="width:auto" onchange="this.form.submit()">
        <option value="">All types</option>
        <option value="add"    <?= $typeFilter === 'add'    ? 'selected' : '' ?>>Adds only</option>
        <option value="deduct" <?= $typeFilter === 'deduct' ? 'selected' : '' ?>>Deducts only</option>
      </select>
      <div class="search-box" style="min-width:220px">
        <?= icon('search', 14) ?>
        <input type="text" name="q" placeholder="Note, admin, amount..." value="<?= htmlspecialchars($q) ?>" autocomplete="off">
        <button type="button" class="search-clear">✕</button>
        <button type="submit" class="search-btn">Search</button>
      </div>
      <?php if ($q || $typeFilter): ?>
        <a href="revenue_history.php" class="btn-link" style="font-size:.78rem">Clear</a>
      <?php endif; ?>
    </form>
  </div>

  <div class="tbl-wrap">
    <table class="tbl-lg">
      <thead>
        <tr>
          <th style="width:120px">Date</th>
          <th style="width:80px">Type</th>
          <th style="width:140px">Amount</th>
          <th>Note</th>
          <th style="width:130px">By</th>
          <th style="width:140px">Running total</th>
          <th style="width:60px"></th>
        </tr>
      </thead>
      <tbody>
        <?php if (empty($rows)): ?>
          <tr>
            <td colspan="7">
              <div class="empty" style="padding:32px">
                <p><?= $q || $typeFilter ? 'No entries match your filters.' : 'No adjustments recorded yet.' ?></p>
              </div>
            </td>
          </tr>
        <?php else: ?>
          <?php
            $redirectBack = 'revenue_history.php?' . http_build_query(['q' => $q, 'type' => $typeFilter, 'page' => $page]);
            foreach ($rows as $log):
            $isDeduct = ($log['type'] ?? '') === 'deduct';
            $amt = (int) ($log['amount'] ?? 0);
            $tag = $isDeduct ? ['tag-no','Deduct'] : ['tag-ok','Add'];
            $createdAt = $log['created_at'] ?? '';
            $formatted = $createdAt !== '' ? date('Y/m/d H:i', strtotime($createdAt)) : '—';
            $logId = (int) ($log['id'] ?? 0);
            $cumulative = $runningMap[$logId] ?? 0;
          ?>
          <tr>
            <td class="cm" style="white-space:nowrap"><?= htmlspecialchars($formatted) ?></td>
            <td><span class="tag <?= $tag[0] ?>"><?= $tag[1] ?></span></td>
            <td class="cn cs" style="white-space:nowrap">
              <?= $isDeduct ? '−' : '+' ?><?= number_format(abs($amt)) ?>
              <span class="cf">T</span>
            </td>
            <td style="max-width:480px">
              <form method="POST" action="settings.php?tab=system" style="display:flex;gap:6px;align-items:center">
                <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
                <input type="hidden" name="action" value="update_revenue_log">
                <input type="hidden" name="log_id" value="<?= $logId ?>">
                <input type="hidden" name="redirect" value="<?= htmlspecialchars($redirectBack) ?>">
                <input type="text" name="note" class="input"
                       value="<?= htmlspecialchars((string) ($log['note'] ?? '')) ?>"
                       maxlength="500" required
                       style="flex:1;min-width:160px;font-size:.82rem">
                <button type="submit" class="btn btn-ghost btn-sm" title="Save note">
                  <?= icon('check', 14) ?>
                </button>
              </form>
            </td>
            <td class="cm" style="white-space:nowrap"><?= htmlspecialchars((string) ($log['created_by'] ?? '—')) ?></td>
            <td class="cn" style="white-space:nowrap">
              <?= $cumulative >= 0 ? '+' : '−' ?><?= number_format(abs($cumulative)) ?>
              <span class="cf">T</span>
            </td>
            <td style="text-align:left">
              <form method="POST" action="settings.php?tab=system" style="display:inline">
                <input type="hidden" name="_csrf" value="<?= csrf_token() ?>">
                <input type="hidden" name="action" value="delete_revenue_log">
                <input type="hidden" name="log_id" value="<?= $logId ?>">
                <input type="hidden" name="redirect" value="<?= htmlspecialchars($redirectBack) ?>">
                <button type="submit" class="btn btn-no btn-sm"
                        onclick="return confirm('Remove this entry from history?')"
                        title="Delete entry">
                  <?= icon('trash', 14) ?>
                </button>
              </form>
            </td>
          </tr>
          <?php endforeach; ?>
        <?php endif; ?>
      </tbody>
    </table>
  </div>

  <?php if ($totalPages > 1): ?>
  <div class="tbl-foot">
    <span>Page <?= $page ?> of <?= $totalPages ?> · <?= number_format($total) ?> entries</span>
    <div class="pager">
      <a class="<?= $page <= 1 ? 'dis' : '' ?>" href="<?= $qs(['page' => max(1, $page - 1)]) ?>">‹</a>
      <?php for ($p = max(1, $page - 2); $p <= min($totalPages, $page + 2); $p++): ?>
        <a class="<?= $p === $page ? 'cur' : '' ?>" href="<?= $qs(['page' => $p]) ?>"><?= $p ?></a>
      <?php endfor; ?>
      <a class="<?= $page >= $totalPages ? 'dis' : '' ?>" href="<?= $qs(['page' => min($totalPages, $page + 1)]) ?>">›</a>
    </div>
  </div>
  <?php endif; ?>
</div>

<?php include __DIR__ . '/inc/layout_foot.php'; ?>