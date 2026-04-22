(function () {
  const ua = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/i.test(ua);
  const IS_ANDROID = /Android/i.test(ua);
  const IS_MAC = /Macintosh|Mac OS X/i.test(ua) && !IS_IOS;
  const IS_WIN = /Windows/i.test(ua);

  const PLATFORM_META = {
    ios:     { btnLabel: 'iOS 安装',     qrTitle: '用 iOS 手机扫码安装',   hint: '仅白名单（UDID）设备可安装', histLabel: '安装', histTitle: 'iOS 历史版本' },
    android: { btnLabel: 'Android 安装', qrTitle: '用 Android 手机扫码下载', hint: '下载后请允许"未知来源"安装', histLabel: '下载', histTitle: 'Android 历史版本' },
    mac:     { btnLabel: 'Mac 下载',     qrTitle: '扫码在 Mac 上下载',      hint: '下载后双击 .dmg 拖入 Applications', histLabel: '下载', histTitle: 'Mac 历史版本' },
    win:     { btnLabel: 'Windows 下载', qrTitle: '扫码在 Windows 上下载',  hint: '.exe 直接运行；.zip 解压后运行',   histLabel: '下载', histTitle: 'Windows 历史版本' }
  };

  const matchUa = (p) => (p === 'ios' && IS_IOS) || (p === 'android' && IS_ANDROID) || (p === 'mac' && IS_MAC) || (p === 'win' && IS_WIN);
  const entryUrl = (p, e) => p === 'ios' ? e.installUrl : e.downloadUrl;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function iconFallback(name) {
    const div = document.createElement('div');
    div.className = 'icon icon-fallback';
    div.textContent = (name || '?').slice(0, 1).toUpperCase();
    return div;
  }

  function renderIcon(app) {
    if (app.icon) {
      const img = new Image();
      img.src = app.icon;
      img.className = 'icon';
      img.alt = app.name;
      img.onerror = () => img.replaceWith(iconFallback(app.name));
      return img;
    }
    return iconFallback(app.name);
  }

  function platformBtn(platform, entry) {
    const meta = PLATFORM_META[platform];
    const wrap = document.createElement('div');
    wrap.className = `btn-group btn-group-${platform}`;

    const a = document.createElement('a');
    a.className = `btn btn-${platform}`;
    a.innerHTML = `${meta.btnLabel}<small>v${entry.version} · ${fmtSize(entry.size)}</small>`;
    const url = entryUrl(platform, entry);
    a.href = url;
    a.addEventListener('click', (ev) => {
      if (!matchUa(platform)) {
        ev.preventDefault();
        openQr(meta.qrTitle, url, meta.hint);
      }
    });

    const qr = document.createElement('button');
    qr.type = 'button';
    qr.className = `btn-qr btn-qr-${platform}`;
    qr.title = '扫码下载';
    qr.setAttribute('aria-label', '扫码下载');
    qr.innerHTML = qrIconSvg();
    qr.addEventListener('click', () => openQr(meta.qrTitle, url, meta.hint));

    wrap.append(a, qr);
    return wrap;
  }

  function qrIconSvg() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
      '<path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8 0h2v2h-2v-2zm4 0h2v2h-2v-2zm2 2h2v2h-2v-2zm-6 2h2v2h-2v-2zm4 0h2v2h-2v-2zm2 2h2v2h-2v-2zm-6 0h2v2h-2v-2z"/>' +
      '</svg>';
  }

  function historySection(platform, list) {
    if (!list.length) return null;
    const meta = PLATFORM_META[platform];
    const wrap = document.createElement('div');
    wrap.className = 'history-group';
    const h = document.createElement('h4');
    h.textContent = meta.histTitle;
    wrap.appendChild(h);
    list.forEach(e => {
      const row = document.createElement('div');
      row.className = 'history-item';
      const ver = document.createElement('span');
      ver.className = 'ver';
      ver.textContent = 'v' + e.version;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtTime(e.uploadedAt) + ' · ' + fmtSize(e.size);
      const url = entryUrl(platform, e);
      const a = document.createElement('a');
      a.textContent = meta.histLabel;
      a.href = url;
      a.addEventListener('click', (ev) => {
        if (!matchUa(platform)) { ev.preventDefault(); openQr('扫码' + meta.histLabel + ' v' + e.version, url, ''); }
      });
      const qr = document.createElement('button');
      qr.type = 'button';
      qr.className = 'history-qr';
      qr.title = '扫码' + meta.histLabel;
      qr.setAttribute('aria-label', '扫码' + meta.histLabel);
      qr.innerHTML = qrIconSvg();
      qr.addEventListener('click', () => openQr('扫码' + meta.histLabel + ' v' + e.version, url, ''));
      row.append(ver, when, a, qr);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderCard(app) {
    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    head.appendChild(renderIcon(app));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';
    const name = document.createElement('p');
    name.className = 'app-name';
    name.textContent = app.name;
    const bid = document.createElement('p');
    bid.className = 'bundle-id';
    bid.textContent = app.id;
    titleWrap.append(name, bid);
    head.appendChild(titleWrap);
    card.appendChild(head);

    const mac = app.mac || [];
    const win = app.win || [];
    const platforms = document.createElement('div');
    platforms.className = 'platforms';
    if (app.ios[0]) platforms.appendChild(platformBtn('ios', app.ios[0]));
    if (app.android[0]) platforms.appendChild(platformBtn('android', app.android[0]));
    if (mac[0]) platforms.appendChild(platformBtn('mac', mac[0]));
    if (win[0]) platforms.appendChild(platformBtn('win', win[0]));
    card.appendChild(platforms);

    const hasHistory = app.ios.length > 1 || app.android.length > 1 || mac.length > 1 || win.length > 1;
    if (hasHistory) {
      const toggle = document.createElement('button');
      toggle.className = 'history-toggle';
      toggle.textContent = '▸ 历史版本';
      const history = document.createElement('div');
      history.className = 'history';
      history.hidden = true;
      const iosHist = historySection('ios', app.ios.slice(1));
      const andHist = historySection('android', app.android.slice(1));
      const macHist = historySection('mac', mac.slice(1));
      const winHist = historySection('win', win.slice(1));
      if (iosHist) history.appendChild(iosHist);
      if (andHist) history.appendChild(andHist);
      if (macHist) history.appendChild(macHist);
      if (winHist) history.appendChild(winHist);
      toggle.addEventListener('click', () => {
        history.hidden = !history.hidden;
        toggle.textContent = history.hidden ? '▸ 历史版本' : '▾ 收起';
      });
      card.append(toggle, history);
    }

    return card;
  }

  function openQr(title, url, hint) {
    const modal = $('#qr-modal');
    $('#qr-title').textContent = title;
    $('#qr-hint').textContent = hint || '';
    const canvasWrap = $('#qr-canvas');
    canvasWrap.innerHTML = '';
    if (window.QRCode) {
      try {
        new QRCode(canvasWrap, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
      } catch (e) {
        canvasWrap.textContent = url;
      }
    } else {
      canvasWrap.textContent = url;
    }
    modal.hidden = false;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) $('#qr-modal').hidden = true;
  });

  async function load() {
    try {
      const res = await fetch('apps.json?t=' + Date.now());
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      if (data.siteTitle) {
        $('#site-title').textContent = data.siteTitle;
        document.title = data.siteTitle;
      }
      if (data.generatedAt) {
        $('#generated-at').textContent = '更新于 ' + fmtTime(data.generatedAt);
      }
      const list = $('#app-list');
      list.innerHTML = '';
      if (!data.apps || !data.apps.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '还没有任何 App，把 .ipa / .apk 放进 docs/packages/ 再 push 即可。';
        list.appendChild(empty);
        return;
      }
      data.apps.forEach(app => list.appendChild(renderCard(app)));
    } catch (err) {
      $('#app-list').innerHTML = `<div class="empty">加载失败: ${err.message}</div>`;
    }
  }

  load();
})();
