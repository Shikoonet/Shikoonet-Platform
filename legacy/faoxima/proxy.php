<?php

/**
 * Outbound proxy support for Faoxima.
 *
 * Some operators run the bot on Iran-based hosts that cannot reach
 * api.telegram.org or foreign VPN panels directly. They can configure an
 * HTTP/SOCKS proxy (separately for Telegram and for panel connections) from
 * the admin settings page; these helpers read that configuration and apply it
 * to any cURL handle.
 *
 * Settings live on the single `setting` row:
 *   proxy_telegram_status / proxy_telegram_url
 *   proxy_panel_status    / proxy_panel_url
 * A URL looks like: socks5h://user:pass@1.2.3.4:1080  (scheme optional, http assumed)
 */

if (!function_exists('faoxima_proxy_settings')) {
    function faoxima_proxy_settings($forceReload = false)
    {
        static $cache = null;
        if ($cache !== null && !$forceReload) {
            return $cache;
        }
        $cache = [
            'telegram_status' => '0',
            'telegram_url'    => '',
            'panel_status'    => '0',
            'panel_url'       => '',
        ];
        $pdo = $GLOBALS['pdo'] ?? null;
        if ($pdo instanceof PDO) {
            try {
                $stmt = $pdo->query("SELECT proxy_telegram_status, proxy_telegram_url, proxy_panel_status, proxy_panel_url FROM setting LIMIT 1");
                $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : null;
                if (is_array($row)) {
                    $cache['telegram_status'] = (string) ($row['proxy_telegram_status'] ?? '0');
                    $cache['telegram_url']    = trim((string) ($row['proxy_telegram_url'] ?? ''));
                    $cache['panel_status']    = (string) ($row['proxy_panel_status'] ?? '0');
                    $cache['panel_url']       = trim((string) ($row['proxy_panel_url'] ?? ''));
                }
            } catch (\Throwable $e) {
                // Columns may not exist yet on an un-migrated DB — fall back to "off".
            }
        }
        return $cache;
    }
}

if (!function_exists('faoxima_parse_proxy_url')) {
    /**
     * Parse a proxy URL into cURL options. Returns null when the URL is empty
     * or unusable. Defaults to an HTTP proxy when no scheme is given.
     */
    function faoxima_parse_proxy_url($url)
    {
        $url = trim((string) $url);
        if ($url === '') {
            return null;
        }
        if (!preg_match('~^[a-z0-9]+://~i', $url)) {
            $url = 'http://' . $url;
        }
        $p = parse_url($url);
        if (!is_array($p) || empty($p['host'])) {
            return null;
        }
        $scheme = strtolower($p['scheme'] ?? 'http');
        $typeMap = [
            'http'    => CURLPROXY_HTTP,
            'https'   => CURLPROXY_HTTP,
            'socks4'  => CURLPROXY_SOCKS4,
            'socks4a' => CURLPROXY_SOCKS4A,
            'socks5'  => CURLPROXY_SOCKS5,
            'socks5h' => CURLPROXY_SOCKS5_HOSTNAME,
        ];
        $type = $typeMap[$scheme] ?? CURLPROXY_HTTP;
        $port = isset($p['port']) ? (int) $p['port'] : (strpos($scheme, 'socks') === 0 ? 1080 : 8080);
        $userpwd = '';
        if (isset($p['user'])) {
            $userpwd = rawurldecode($p['user']) . ':' . rawurldecode($p['pass'] ?? '');
        }
        return [
            'type'    => $type,
            'host'    => $p['host'],
            'port'    => $port,
            'userpwd' => $userpwd,
            'scheme'  => $scheme,
        ];
    }
}

if (!function_exists('faoxima_proxy_for')) {
    /**
     * Resolve the active proxy options for a scope ('telegram' | 'panel').
     * Returns null when no proxy is enabled/configured for that scope.
     */
    function faoxima_proxy_for($scope)
    {
        $s = faoxima_proxy_settings();
        if ($scope === 'telegram') {
            $status = $s['telegram_status'];
            $url    = $s['telegram_url'];
        } else {
            $status = $s['panel_status'];
            $url    = $s['panel_url'];
        }
        if ((string) $status !== '1' || $url === '') {
            return null;
        }
        return faoxima_parse_proxy_url($url);
    }
}

if (!function_exists('faoxima_apply_curl_proxy')) {
    /**
     * Apply the configured proxy for $scope to an existing cURL handle.
     * Returns true when a proxy was applied, false otherwise.
     */
    function faoxima_apply_curl_proxy($ch, $scope)
    {
        if (!is_resource($ch) && !($ch instanceof \CurlHandle)) {
            return false;
        }
        $proxy = faoxima_proxy_for($scope);
        if ($proxy === null) {
            return false;
        }
        curl_setopt($ch, CURLOPT_PROXY, $proxy['host']);
        curl_setopt($ch, CURLOPT_PROXYPORT, $proxy['port']);
        curl_setopt($ch, CURLOPT_PROXYTYPE, $proxy['type']);
        curl_setopt($ch, CURLOPT_HTTPPROXYTUNNEL, true);
        if ($proxy['userpwd'] !== '') {
            curl_setopt($ch, CURLOPT_PROXYUSERPWD, $proxy['userpwd']);
        }
        return true;
    }
}
