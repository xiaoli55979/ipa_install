(function () {
  const ua = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/i.test(ua);
  const IS_ANDROID = /Android/i.test(ua);

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
    const a = document.createElement('a');
    a.className = 'btn ' + (platform === 'ios' ? 'btn-ios' : 'btn-android');
    const label = platform === 'ios' ? 'iOS 安装' : 'Android 安装';
    a.innerHTML = `${label}<small>v${entry.version} · ${fmtSize(entry.size)}</small>`;
    const url = platform === 'ios' ? entry.installUrl : entry.downloadUrl;
    a.href = url;
    a.addEventListener('click', (ev) => {
      const matchUa = (platform === 'ios' && IS_IOS) || (platform === 'android' && IS_ANDROID);
      if (!matchUa) {
        ev.preventDefault();
        openQr(platform === 'ios' ? '用 iOS 手机扫码安装' : '用 Android 手机扫码下载', url,
          platform === 'ios'
            ? '仅白名单（UDID）设备可安装'
            : '下载后请允许"未知来源"安装');
      }
    });
    return a;
  }

  function historySection(platform, list) {
    if (!list.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'history-group';
    const h = document.createElement('h4');
    h.textContent = platform === 'ios' ? 'iOS 历史版本' : 'Android 历史版本';
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
      const a = document.createElement('a');
      a.textContent = platform === 'ios' ? '安装' : '下载';
      const url = platform === 'ios' ? e.installUrl : e.downloadUrl;
      a.href = url;
      a.addEventListener('click', (ev) => {
        const matchUa = (platform === 'ios' && IS_IOS) || (platform === 'android' && IS_ANDROID);
        if (!matchUa) { ev.preventDefault(); openQr('扫码安装 v' + e.version, url, ''); }
      });
      row.append(ver, when, a);
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

    const platforms = document.createElement('div');
    platforms.className = 'platforms';
    if (app.ios[0]) platforms.appendChild(platformBtn('ios', app.ios[0]));
    if (app.android[0]) platforms.appendChild(platformBtn('android', app.android[0]));
    card.appendChild(platforms);

    const hasHistory = app.ios.length > 1 || app.android.length > 1;
    if (hasHistory) {
      const toggle = document.createElement('button');
      toggle.className = 'history-toggle';
      toggle.textContent = '▸ 历史版本';
      const history = document.createElement('div');
      history.className = 'history';
      history.hidden = true;
      const iosHist = historySection('ios', app.ios.slice(1));
      const andHist = historySection('android', app.android.slice(1));
      if (iosHist) history.appendChild(iosHist);
      if (andHist) history.appendChild(andHist);
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
      QRCode.toCanvas(url, { width: 240, margin: 1 }, (err, canvas) => {
        if (err) { canvasWrap.textContent = url; return; }
        canvasWrap.appendChild(canvas);
      });
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
