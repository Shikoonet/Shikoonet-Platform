import { call } from './api.js';


function ensureAdminGear() {
    if (document.getElementById('admin-settings-btn')) return;
    var header = document.querySelector('.app-header');
    if (!header) return;
    var b = document.createElement('button');
    b.id = 'admin-settings-btn';
    b.className = 'icon-btn';
    b.type = 'button';
    b.setAttribute('aria-label', 'تنظیمات');
    b.title = 'تنظیمات';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    b.addEventListener('click', function () { try { location.hash = '#/settings'; } catch (_) {  } });
    var reload = document.getElementById('reload-btn');
    if (reload && reload.parentNode) reload.parentNode.insertBefore(b, reload.nextSibling);
    else header.appendChild(b);
}


export function applyBrand(brand) {
    if (!brand || typeof brand !== 'object') return;

    const cfg = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};
    const prefix = cfg.assetPrefix || '/';

    const $mark = document.querySelector('.brand-mark');
    const $name = document.querySelector('.brand-name');

    const name = String(brand.name || '').trim() || 'Faoxima';
    const mark = String(brand.mark || '').trim() || (name.charAt(0) || 'F');
    let logoUrl = String(brand.logo_url || '').trim();

    if (logoUrl !== '' && !/^https?:/i.test(logoUrl) && !logoUrl.startsWith(prefix)) {
        logoUrl = prefix + logoUrl.replace(/^\/+/, '');
    }

    if ($mark) {
        if (logoUrl !== '') {
            $mark.innerHTML = `<img src="${logoUrl}" alt="logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" />`;
            $mark.style.background = 'transparent';
            $mark.style.padding = '0';
            $mark.style.overflow = 'hidden';
        } else {
            $mark.textContent = mark;
            $mark.style.background = '';
            $mark.style.padding = '';
            $mark.style.overflow = '';
        }
    }
    if ($name) {
        $name.textContent = name;
    }

    try {
        var ac = (typeof brand.accent === 'string') ? brand.accent.trim() : '';
        if (/^#?[0-9a-fA-F]{6}$/.test(ac) && typeof window.__applyAccent === 'function') {
            window.__applyAccent(ac.charAt(0) === '#' ? ac : ('#' + ac));
        }
    } catch (_) {  }

    try {
        document.title = name + ' — ' + name;
    } catch (_) {  }


    try {
        localStorage.setItem('faoxima.brand', JSON.stringify({
            name: brand.name || '',
            mark: brand.mark || '',
            logo_url: brand.logo_url || '',
            accent: brand.accent || '',
        }));
    } catch (_) {  }
}


export async function loadBrandFromServer() {

    try {
        const cfg = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};
        if (cfg.brand && (cfg.brand.name || cfg.brand.mark || cfg.brand.logo_url)) {
            applyBrand(cfg.brand);
        } else {
            const cachedRaw = localStorage.getItem('faoxima.brand');
            if (cachedRaw) {
                try { applyBrand(JSON.parse(cachedRaw)); } catch (_) {  }
            }
        }
    } catch (_) {  }

    try {
        const res = await call('brand_info');
        const obj = res?.obj || {};
        applyBrand(obj);
        try { if (obj && obj.is_admin) ensureAdminGear(); } catch (_) {  }
        try {
            localStorage.setItem('faoxima.brand', JSON.stringify({
                name: obj.name, mark: obj.mark, logo_url: obj.logo_url, accent: obj.accent,
            }));
        } catch (_) {  }
        return obj;
    } catch (_) {
        return null;
    }
}
