import { hapticImpact, hapticNotify } from '../telegram.js';
import { icon } from '../icons.js';
import { call } from '../api.js';
import { getToken } from '../state.js';
import { toast } from '../utils.js';
import { applyBrand } from '../brand.js';

const THEMES = [
    { key: 'gold',   name: 'طلایی',   color: '#d4b878', bright: '#e2c98c' },
    { key: 'red',    name: 'قرمز',    color: '#e57373', bright: '#ef9a9a' },
    { key: 'blue',   name: 'آبی',     color: '#64a8e8', bright: '#82bdf3' },
    { key: 'purple', name: 'بنفش',    color: '#7c5cff', bright: '#a98bff' },
    { key: 'yellow', name: 'زرد',     color: '#f4d35e', bright: '#f8e285' },
    { key: 'green',  name: 'سبز',     color: '#7fc987', bright: '#9bd5a3' },
    { key: 'orange', name: 'نارنجی',   color: '#f0a868', bright: '#f5be8b' },
];

function normalizeHex(s) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s == null ? '' : s).trim());
    return m ? ('#' + m[1].toLowerCase()) : null;
}
function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
function hexDarken(hex, f) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgb(${Math.round(((n >> 16) & 255) * f)}, ${Math.round(((n >> 8) & 255) * f)}, ${Math.round((n & 255) * f)})`;
}
function hexLighten(hex, f) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * f);
    g = Math.round(g + (255 - g) * f);
    b = Math.round(b + (255 - b) * f);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function onAccent(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(normalizeHex(hex) || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.45 ? '#14121d' : '#ffffff';
}

export function applyTheme(themeKeyOrHex) {
    const hex = normalizeHex(themeKeyOrHex);
    let color, bright, key;
    if (hex) {
        color = hex; bright = hexLighten(hex, 0.28); key = 'custom';
    } else {
        const theme = THEMES.find((t) => t.key === themeKeyOrHex) || THEMES.find((t) => t.key === 'purple');
        color = theme.color; bright = theme.bright; key = theme.key;
    }
    const root = document.documentElement;
    root.style.setProperty('--gold', color);
    root.style.setProperty('--gold-bright', bright);
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-bright', bright);
    root.style.setProperty('--gold-soft',   hexToRgba(color, 0.10));
    root.style.setProperty('--gold-soft-2', hexToRgba(color, 0.18));
    root.style.setProperty('--accent-soft',   hexToRgba(color, 0.10));
    root.style.setProperty('--accent-soft-2', hexToRgba(color, 0.18));
    root.style.setProperty('--accent-glow',  hexToRgba(color, 0.40));
    root.style.setProperty('--accent-ink',   hexDarken(color, 0.5));
    root.style.setProperty('--border',        hexToRgba(color, 0.12));
    root.style.setProperty('--border-strong', hexToRgba(color, 0.28));
    root.style.setProperty('--on-accent', onAccent(color));
    root.dataset.theme = key;
    return color;
}

function applyDarkMode() {
    document.documentElement.dataset.mode = 'dark';
    try {
        const mc = document.querySelector('meta[name="theme-color"]');
        if (mc) mc.setAttribute('content', '#0a0a14');
    } catch (_) {  }
}

function globalAccent() {
    try {
        const f = (window.__FAOXIMA__ || {});
        if (f.brand && f.brand.accent) return f.brand.accent;
    } catch (_) {  }
    try {
        const c = (window.__APP_CONFIG__ || {});
        if (c.brand && c.brand.accent) return c.brand.accent;
    } catch (_) {  }
    try {
        const raw = localStorage.getItem('faoxima.brand');
        if (raw) { const o = JSON.parse(raw); if (o && o.accent) return o.accent; }
    } catch (_) {  }
    return 'purple';
}

export function loadSavedTheme() {
    const accent = globalAccent();
    applyTheme(accent);
    applyDarkMode();
    try { window.__applyAccent = applyTheme; } catch (_) {  }
    return accent;
}

try { window.__applyAccent = applyTheme; } catch (_) {  }

function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;');
}
function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
}

export async function settings(view) {
    loadSavedTheme();

    view.innerHTML = `
        <a href="#/" class="page-back">
            ${icon('chevronLeft', 'class="ico"')}
            <span>بازگشت</span>
        </a>

        <article class="card card-window">
            <header class="card-window-bar">
                <span class="dots"><span></span><span></span><span></span></span>
                <span class="window-url">faoxima/settings</span>
            </header>
            <div class="card-body" id="settings-body">
                <div class="empty">
                    ${icon('settings', 'class="ico ico-xxl ico-accent"')}
                    <h3>تنظیمات</h3>
                    <p class="muted">در حال بارگذاری…</p>
                </div>
            </div>
        </article>
    `;

    let obj = {};
    try {
        const res = await call('brand_info');
        obj = res?.obj || {};
    } catch (_) {  }

    const body = view.querySelector('#settings-body');
    if (!body) return;

    if (!obj.is_admin) {
        body.innerHTML = `
            <div class="empty">
                ${icon('settings', 'class="ico ico-xxl"')}
                <h3>این بخش مخصوص ادمین است</h3>
                <p class="muted">ظاهرِ مینی‌اپ توسط ادمین تنظیم می‌شود.</p>
                <a href="#/" class="btn btn-primary mt-md">
                    ${icon('chevronLeft', 'class="ico ico-leading"')}
                    <span>بازگشت به خانه</span>
                </a>
            </div>
        `;
        return;
    }

    renderAdminPanel(body, obj);
}

function renderAdminPanel(host, brand) {
    const curHex = normalizeHex(brand.accent) || THEMES.find((t) => t.key === 'purple').color;

    const tiles = THEMES.map((t) => `
        <button class="theme-tile ${normalizeHex(t.color) === normalizeHex(curHex) ? 'is-active' : ''}" data-accent="${t.color}" type="button" aria-label="${escapeAttr(t.name)}">
            <span class="theme-swatch" style="background:${t.color}"></span>
            <span class="theme-name">${t.name}</span>
            ${normalizeHex(t.color) === normalizeHex(curHex) ? icon('check', 'class="ico ico-accent"') : ''}
        </button>
    `).join('');

    host.innerHTML = `
        <p class="section-title">${icon('settings')} رنگ اصلی مینی‌اپ</p>
        <h2 class="section-headline">یک رنگ برای همهٔ کاربران انتخاب کنید</h2>
        <p class="muted center mb-md" style="font-size:13px">این رنگ به‌صورت سراسری ذخیره و برای همهٔ کاربران اعمال می‌شود.</p>

        <div class="theme-grid" id="accent-grid">${tiles}</div>

        <div class="card-section">
            <p class="section-title">رنگ دلخواه</p>
            <div class="form-row">
                <label class="muted" style="font-size:12px" for="accent-hex">کد رنگ (مثلاً ‎#eaedf8)</label>
                <div class="row-spread" style="gap:10px;align-items:center">
                    <input id="accent-hex" type="text" inputmode="latin" maxlength="7" placeholder="#eaedf8" value="${escapeAttr(curHex)}" class="input-mono" dir="ltr" style="flex:1" />
                    <input id="accent-native" type="color" value="${escapeAttr(curHex)}" aria-label="انتخابگر رنگ" style="width:48px;height:48px;border:none;background:none;padding:0;border-radius:12px" />
                </div>
            </div>
        </div>

        <button id="accent-save" type="button" class="btn btn-primary btn-block mt-sm">
            ${icon('check', 'class="ico ico-leading"')}
            <span class="accent-save-label">ذخیره رنگ برای همه</span>
        </button>

        <div id="admin-brand-host" class="card-section"></div>
    `;

    const grid = host.querySelector('#accent-grid');
    const $hex = host.querySelector('#accent-hex');
    const $native = host.querySelector('#accent-native');
    const $save = host.querySelector('#accent-save');
    const $saveLabel = $save.querySelector('.accent-save-label');
    let pending = curHex;

    function setPending(hex) {
        const norm = normalizeHex(hex);
        if (!norm) return;
        pending = norm;
        applyTheme(norm);
        $hex.value = norm;
        try { $native.value = norm; } catch (_) {  }
        grid.querySelectorAll('[data-accent]').forEach((b) => {
            const match = normalizeHex(b.dataset.accent) === norm;
            b.classList.toggle('is-active', match);
            const c = b.querySelector('svg'); if (c) c.remove();
            if (match) b.insertAdjacentHTML('beforeend', icon('check', 'class="ico ico-accent"'));
        });
    }

    grid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-accent]');
        if (!btn) return;
        hapticImpact('light');
        setPending(btn.dataset.accent);
    });
    $native.addEventListener('input', () => setPending($native.value));
    $hex.addEventListener('input', () => { const n = normalizeHex($hex.value); if (n) setPending(n); });

    $save.addEventListener('click', async () => {
        const norm = normalizeHex($hex.value) || pending;
        if (!norm) { toast('کد رنگ نامعتبر است', 'error', 3000); return; }
        const old = $saveLabel.textContent;
        $save.disabled = true;
        $saveLabel.textContent = 'در حال ذخیره…';
        try {
            const res = await call('brand_save', { method: 'POST', body: { accent: norm } });
            const o = res?.obj || {};
            const saved = normalizeHex(o.accent) || norm;
            applyTheme(saved);
            try {
                const raw = localStorage.getItem('faoxima.brand');
                const cache = raw ? JSON.parse(raw) : {};
                cache.accent = saved;
                localStorage.setItem('faoxima.brand', JSON.stringify(cache));
            } catch (_) {  }
            hapticNotify('success');
            toast(o.message || 'رنگ برای همهٔ کاربران ذخیره شد', 'success', 2800);
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'خطا در ذخیره رنگ', 'error', 4000);
        } finally {
            $save.disabled = false;
            $saveLabel.textContent = old;
        }
    });

    renderBrandFields(host.querySelector('#admin-brand-host'), brand);
}

function renderBrandFields(host, brand) {
    if (!host) return;
    host.innerHTML = `
        <p class="section-title">${icon('settings')} برند مینی‌اپ</p>
        <p class="muted" style="font-size:13px">نام و نشانِ نوار بالای مینی‌اپ. تصویر آپلودی به‌صورت خودکار به اندازه‌ی مناسب درآورده می‌شود.</p>

        <div class="form-row mt-md">
            <label class="muted" style="font-size:12px" for="brand-name-input">نام برند</label>
            <input id="brand-name-input" type="text" maxlength="40" placeholder="Faoxima" value="${escapeAttr(brand.name || '')}" />
        </div>
        <div class="form-row mt-sm">
            <label class="muted" style="font-size:12px" for="brand-mark-input">حروف نشان (۱ تا ۴ کاراکتر)</label>
            <input id="brand-mark-input" type="text" maxlength="4" placeholder="M" value="${escapeAttr(brand.mark || '')}" />
        </div>
        <button id="brand-save-btn" type="button" class="btn btn-primary btn-block mt-sm">
            ${icon('check', 'class="ico ico-leading"')}
            <span class="brand-save-label">ذخیره نام و نشان</span>
        </button>

        <p class="section-title mt-md">لوگو (اختیاری)</p>
        <div class="row-spread" style="gap:10px;align-items:center">
            <div id="brand-logo-preview" style="width:64px;height:64px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--on-accent);font-weight:700">
                ${brand.logo_url
                    ? `<img src="${escapeAttr(brand.logo_url)}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`
                    : escapeHtml(brand.mark || 'M')}
            </div>
            <div style="flex:1">
                <input id="brand-logo-file" type="file" accept="image/*" style="display:none" />
                <button id="brand-logo-pick" type="button" class="btn btn-ghost btn-block">
                    ${icon('download', 'class="ico ico-leading"')}
                    <span>انتخاب تصویر</span>
                </button>
                ${brand.logo_url ? `
                <button id="brand-logo-clear" type="button" class="btn btn-ghost btn-block mt-sm">
                    ${icon('close', 'class="ico ico-leading"')}
                    <span>حذف لوگو</span>
                </button>` : ''}
            </div>
        </div>
        <p class="muted mono mt-sm" style="font-size:11px">PNG/JPG/WebP — حداکثر ۴ مگابایت. اندازه نهایی ۲۵۶×۲۵۶ پیکسل.</p>
    `;

    const $name = host.querySelector('#brand-name-input');
    const $mark = host.querySelector('#brand-mark-input');
    const $save = host.querySelector('#brand-save-btn');
    const $saveLabel = $save.querySelector('.brand-save-label');

    $save.addEventListener('click', async () => {
        const name = ($name.value || '').trim();
        const mark = ($mark.value || '').trim();
        const old = $saveLabel.textContent;
        $save.disabled = true;
        $saveLabel.textContent = 'در حال ذخیره…';
        try {
            const res = await call('brand_save', { method: 'POST', body: { name, mark } });
            const obj = res?.obj || {};
            applyBrand(obj);
            hapticNotify('success');
            toast(obj.message || 'برند ذخیره شد', 'success', 2500);
        } catch (err) {
            hapticNotify('error');
            toast(err.message || 'خطا در ذخیره برند', 'error', 4000);
        } finally {
            $save.disabled = false;
            $saveLabel.textContent = old;
        }
    });

    const $file = host.querySelector('#brand-logo-file');
    const $pick = host.querySelector('#brand-logo-pick');
    $pick.addEventListener('click', () => $file.click());
    $file.addEventListener('change', async () => {
        const f = $file.files && $file.files[0];
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) {
            toast('حجم فایل نباید بیشتر از ۴ مگابایت باشد', 'error', 4000);
            $file.value = '';
            return;
        }
        await uploadLogo(host, f, brand);
        $file.value = '';
    });

    const $clear = host.querySelector('#brand-logo-clear');
    if ($clear) {
        $clear.addEventListener('click', async () => {
            try {
                const fd = new FormData();
                fd.append('clear', '1');
                const obj = await uploadBrandLogoForm(fd);
                applyBrand(obj);
                renderBrandFields(host, obj);
                toast('لوگو حذف شد', 'success', 2000);
            } catch (err) {
                toast(err.message || 'خطا در حذف لوگو', 'error', 4000);
            }
        });
    }
}

async function uploadLogo(host, file, brand) {
    const $pick = host.querySelector('#brand-logo-pick');
    const $oldLabel = $pick && $pick.querySelector('span');
    const old = $oldLabel ? $oldLabel.textContent : '';
    if ($pick) { $pick.disabled = true; }
    if ($oldLabel) { $oldLabel.textContent = 'در حال آپلود…'; }
    try {
        const fd = new FormData();
        fd.append('logo', file);
        const obj = await uploadBrandLogoForm(fd);
        applyBrand(obj);
        renderBrandFields(host, obj);
        hapticNotify('success');
        toast(obj.message || 'لوگو ذخیره شد', 'success', 2500);
    } catch (err) {
        hapticNotify('error');
        toast(err.message || 'خطا در آپلود لوگو', 'error', 4000);
        if ($pick) $pick.disabled = false;
        if ($oldLabel) $oldLabel.textContent = old;
    }
}

async function uploadBrandLogoForm(formData) {
    const apiUrl = (window.__APP_CONFIG__ || {}).apiUrl || '';
    const tok = getToken();
    const res = await fetch(`${apiUrl}/miniapp.php?actions=brand_upload_logo`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (tok || '') },
        body: formData,
    });
    let envelope = null;
    try { envelope = await res.json(); } catch (_) {}
    if (!res.ok || !envelope || !envelope.status) {
        const msg = (envelope && envelope.msg) || `Upload failed (${res.status})`;
        throw new Error(msg);
    }
    return envelope.obj || {};
}
