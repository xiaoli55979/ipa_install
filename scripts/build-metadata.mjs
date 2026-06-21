#!/usr/bin/env node
// 从 GitHub Releases 拉取所有 IPA/APK/DMG/EXE/ZIP 资产，解析元数据并生成 apps.json + manifest.plist
// DMG(mac) / EXE|ZIP(win) 不解析内容，归组优先级:
//   1) config.json 的 pcMatchers 按文件名前缀匹配 bundleId
//   2) 同 Release 里 IPA/APK 解析出的 bundleId 兜底
// 版本号用 Release tag
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import simplePlist from 'simple-plist';
import * as peLib from 'pe-library';
import * as reseditMod from 'resedit';
import cgbi from 'cgbi-to-png';

const require = createRequire(import.meta.url);
const ApkParser = require('app-info-parser/src/apk');

// IPA 内的 png 多是 Xcode pngcrush 转出的 CgBI 苹果优化格式(BGR 通道 + raw deflate),浏览器无法渲染,要转回标准 PNG
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function normalizeIpaPng(buf) {
  if (!buf || buf.length < 16) return buf;
  if (!buf.slice(0, 8).equals(PNG_MAGIC)) return buf;
  if (buf.slice(12, 16).toString('ascii') !== 'CgBI') return buf;
  try { return cgbi.revert(buf); } catch { return buf; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
const PUBLIC_URL = CONFIG.publicUrl.replace(/\/$/, '');
const REPO = CONFIG.repo;
if (!REPO) { console.error('config.json 缺少 "repo" 字段'); process.exit(1); }

const MANIFEST_DIR = path.join(ROOT, 'docs/manifest');
const ICON_DIR = path.join(ROOT, 'docs/icons');
const APPS_JSON = path.join(ROOT, 'docs/apps.json');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-build-'));

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}
function slugify(s) { return String(s).replace(/[^a-zA-Z0-9._-]/g, '_'); }

// pcMatchers: [{ bundleId, prefixes: [...] }] —— 按文件名前缀把 dmg/exe/zip 归到指定 bundleId
// 长前缀优先,大小写不敏感
const PC_MATCHERS = (() => {
  const raw = Array.isArray(CONFIG.pcMatchers) ? CONFIG.pcMatchers : [];
  return raw
    .flatMap(m => (m.prefixes || []).map(p => ({ bundleId: m.bundleId, prefix: String(p).toLowerCase() })))
    .sort((a, b) => b.prefix.length - a.prefix.length);
})();
function matchPcByFilename(name) {
  const lower = String(name).toLowerCase();
  for (const { bundleId, prefix } of PC_MATCHERS) {
    if (lower.startsWith(prefix)) return bundleId;
  }
  return null;
}

function fetchReleases() {
  const out = sh('gh', ['api', '--paginate', `/repos/${REPO}/releases?per_page=100`]);
  const arr = JSON.parse(out);
  return arr.filter(r => !r.draft);
}

function downloadAsset(tag, name) {
  const sub = path.join(TMP_DIR, slugify(tag));
  fs.mkdirSync(sub, { recursive: true });
  sh('gh', ['release', 'download', tag,
    '--repo', REPO,
    '--pattern', name,
    '--dir', sub,
    '--clobber']);
  return path.join(sub, name);
}

function parseIpa(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const infoEntry = entries.find(e => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.entryName));
  if (!infoEntry) throw new Error('Info.plist not found');
  const appDir = path.posix.dirname(infoEntry.entryName);
  const info = simplePlist.parse(infoEntry.getData());

  const bundleId = info.CFBundleIdentifier;
  const version = info.CFBundleShortVersionString || info.CFBundleVersion || '0.0.0';
  const name = info.CFBundleDisplayName || info.CFBundleName || bundleId;

  const iconFiles =
    info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ||
    info['CFBundleIcons~ipad']?.CFBundlePrimaryIcon?.CFBundleIconFiles ||
    (info.CFBundleIconFile ? [info.CFBundleIconFile] : []);

  const inAppPng = entries.filter(e => e.entryName.startsWith(appDir + '/') && /\.png$/i.test(e.entryName));
  const pickLargest = (list) => list.length
    ? list.slice().sort((a, b) => b.header.size - a.header.size)[0].getData()
    : null;

  // 优先 Info.plist 声明的图标 → 再扫 .app 目录里所有 AppIcon/Icon 前缀的 png → 兜底 iTunesArtwork
  let iconData = null;
  if (iconFiles.length) {
    iconData = pickLargest(inAppPng.filter(e => {
      const base = path.posix.basename(e.entryName);
      return iconFiles.some(n => base.startsWith(n));
    }));
  }
  if (!iconData) {
    iconData = pickLargest(inAppPng.filter(e => {
      const base = path.posix.basename(e.entryName).toLowerCase();
      return base.includes('appicon') || base.startsWith('icon');
    }));
  }
  if (!iconData) {
    iconData = pickLargest(inAppPng);
  }
  if (!iconData) {
    const itunes = entries.filter(e => /(^|\/)iTunesArtwork(@2x)?$/.test(e.entryName));
    if (itunes.length) {
      itunes.sort((a, b) => b.header.size - a.header.size);
      iconData = itunes[0].getData();
    }
  }
  iconData = normalizeIpaPng(iconData);
  return { bundleId, version, name, iconData, iconExt: 'png' };
}

// 从 EXE 的 PE 资源段提取最大尺寸图标。优先内嵌 PNG;否则包成单图标 ICO。
function parseExeIcon(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const exe = peLib.NtExecutable.from(ab, { ignoreCert: true });
    const res = peLib.NtExecutableResource.from(exe);
    const groups = reseditMod.Resource.IconGroupEntry.fromEntries(res.entries);
    if (!groups.length) return null;
    const rtIcons = res.entries.filter(e => e.type === 3);
    const candidates = [];
    for (const grp of groups) {
      for (const ic of grp.icons) {
        const ent = rtIcons.find(e => e.id === ic.iconID && e.lang === grp.lang);
        if (!ent) continue;
        const view = new DataView(ent.bin);
        const isPng = view.byteLength >= 4 && view.getUint32(0, false) === 0x89504E47;
        candidates.push({
          width: ic.width || 256,
          height: ic.height || 256,
          isPng,
          bin: Buffer.from(ent.bin),
        });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      if (a.isPng !== b.isPng) return a.isPng ? -1 : 1;
      return (b.width * b.height) - (a.width * a.height);
    });
    const top = candidates[0];
    if (top.isPng) return { data: top.bin, ext: 'png' };
    return { data: buildSingleIco(top), ext: 'ico' };
  } catch {
    return null;
  }
}

function buildSingleIco(c) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(c.width >= 256 ? 0 : c.width, 6);
  header.writeUInt8(c.height >= 256 ? 0 : c.height, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(c.bin.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, c.bin]);
}

// 图标来源优先级:iOS=1,Android=2,Windows=3;数字越小越优先,可覆盖
const ICON_RANK = { ios: 1, android: 2, win: 3 };

function maybeSetIcon(app, bundleId, platform, iconData, iconExt) {
  if (!iconData) return;
  const rank = ICON_RANK[platform];
  if (!rank) return;
  if (app._iconRank != null && rank >= app._iconRank) return;
  const ext = iconExt || 'png';
  const iconName = `${slugify(bundleId)}-${platform}.${ext}`;
  fs.writeFileSync(path.join(ICON_DIR, iconName), iconData);
  app.icon = `${PUBLIC_URL}/icons/${iconName}`;
  app._iconRank = rank;
}

async function parseApk(filePath) {
  const parser = new ApkParser(filePath);
  const info = await parser.parse();
  const bundleId = info.package;
  const version = info.versionName || String(info.versionCode || '0.0.0');
  let name = bundleId;
  if (typeof info.application?.label === 'string') name = info.application.label;
  else if (Array.isArray(info.application?.label) && info.application.label.length) name = info.application.label[0];
  else if (typeof info.label === 'string') name = info.label;
  else if (Array.isArray(info.label) && info.label.length) name = info.label[0];

  let iconData = null;
  if (info.icon && typeof info.icon === 'string') {
    const m = info.icon.match(/^data:image\/\w+;base64,(.+)$/);
    iconData = Buffer.from(m ? m[1] : info.icon, 'base64');
  }
  return { bundleId, version, name, iconData };
}

function makeManifest({ bundleId, version, name, ipaUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${escapeXml(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${escapeXml(bundleId)}</string>
        <key>bundle-version</key><string>${escapeXml(version)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${escapeXml(name)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f === '.gitkeep') continue;
    fs.unlinkSync(path.join(dir, f));
  }
}

async function main() {
  cleanDir(MANIFEST_DIR);
  cleanDir(ICON_DIR);

  const releases = fetchReleases();
  console.log(`Found ${releases.length} release(s).`);

  const apps = new Map();

  for (const rel of releases) {
    // 先处理 ipa/apk 拿到 bundleId,再处理 dmg/exe/zip 挂到同一 app
    const rawAssets = rel.assets || [];
    const extOf = (n) => (n.match(/\.(ipa|apk|dmg|exe|zip)$/i) || [])[1]?.toLowerCase() || '';
    const platformOf = (ext) => ext === 'ipa' ? 'ios'
      : ext === 'apk' ? 'android'
      : ext === 'dmg' ? 'mac'
      : (ext === 'exe' || ext === 'zip') ? 'win' : null;
    const rank = (n) => { const p = platformOf(extOf(n)); return (p === 'ios' || p === 'android') ? 0 : p ? 1 : 2; };
    const orderedAssets = rawAssets.slice().sort((a, b) => rank(a.name) - rank(b.name));

    let releaseBundleId = null;
    let releaseAppName = null;

    for (const asset of orderedAssets) {
      const ext = extOf(asset.name);
      const platform = platformOf(ext);
      if (!platform) continue;

      if (platform === 'mac' || platform === 'win') {
        // 优先用文件名前缀匹配,跨 release 也能正确归组;匹配不上再用同 release 的 ipa/apk 兜底
        const matchedBundleId = matchPcByFilename(asset.name);
        const targetBundleId = matchedBundleId || releaseBundleId;
        if (!targetBundleId) {
          console.warn(`[skip] ${ext} ${asset.name}: 文件名前缀不在 pcMatchers 中,且 release ${rel.tag_name} 没有 ipa/apk 提供 bundleId`);
          continue;
        }
        const pkgUrl = asset.browser_download_url;
        const uploadedAt = asset.updated_at || asset.created_at || rel.published_at;
        if (!apps.has(targetBundleId)) {
          apps.set(targetBundleId, {
            id: targetBundleId,
            name: matchedBundleId ? targetBundleId : (releaseAppName || targetBundleId),
            icon: null, ios: [], android: [], mac: [], win: []
          });
        }
        const app = apps.get(targetBundleId);
        if (!app.mac) app.mac = [];
        if (!app.win) app.win = [];
        app[platform].push({
          version: rel.tag_name,
          uploadedAt,
          tag: rel.tag_name,
          releaseName: rel.name || rel.tag_name,
          notes: rel.body || '',
          file: asset.name,
          size: asset.size,
          downloadUrl: pkgUrl
        });

        // 当 ios 还没贡献图标时,从 exe 抽一个兜底
        if (ext === 'exe' && (app._iconRank == null || app._iconRank > ICON_RANK.win)) {
          let exePath;
          try {
            exePath = downloadAsset(rel.tag_name, asset.name);
          } catch (e) {
            console.warn(`[skip-icon] download ${asset.name}: ${e.message}`);
          }
          if (exePath) {
            const got = parseExeIcon(exePath);
            if (got) maybeSetIcon(app, targetBundleId, 'win', got.data, got.ext);
            else console.warn(`[skip-icon] no icon resource in ${asset.name}`);
            try { fs.unlinkSync(exePath); } catch {}
          }
        }
        continue;
      }

      const isIpa = ext === 'ipa';

      let localPath;
      try {
        localPath = downloadAsset(rel.tag_name, asset.name);
      } catch (e) {
        console.warn(`[skip] download ${rel.tag_name}/${asset.name}: ${e.message}`);
        continue;
      }

      let parsed;
      try {
        parsed = isIpa ? parseIpa(localPath) : await parseApk(localPath);
      } catch (e) {
        console.warn(`[skip] parse ${asset.name}: ${e.message}`);
        continue;
      }

      const pkgUrl = asset.browser_download_url;
      const uploadedAt = asset.updated_at || asset.created_at || rel.published_at;

      if (!apps.has(parsed.bundleId)) {
        apps.set(parsed.bundleId, {
          id: parsed.bundleId,
          name: parsed.name,
          icon: null,
          ios: [],
          android: [],
          mac: [],
          win: []
        });
      }
      const app = apps.get(parsed.bundleId);
      if (!app.mac) app.mac = [];
      if (!app.win) app.win = [];

      if (!releaseBundleId) { releaseBundleId = parsed.bundleId; releaseAppName = parsed.name; }

      // 图标来源优先级由 maybeSetIcon 控制:iOS 可覆盖 Android,Android 可覆盖 Windows
      maybeSetIcon(app, parsed.bundleId, platform, parsed.iconData, parsed.iconExt);
      if (parsed.name && parsed.name !== parsed.bundleId) app.name = parsed.name;

      const entry = {
        version: parsed.version,
        uploadedAt,
        tag: rel.tag_name,
        releaseName: rel.name || rel.tag_name,
        notes: rel.body || '',
        file: asset.name,
        size: asset.size,
        downloadUrl: pkgUrl
      };

      if (isIpa) {
        const manifestName = `${slugify(parsed.bundleId)}-${slugify(rel.tag_name)}.plist`;
        fs.writeFileSync(path.join(MANIFEST_DIR, manifestName), makeManifest({
          bundleId: parsed.bundleId, version: parsed.version, name: parsed.name, ipaUrl: pkgUrl
        }));
        entry.manifestUrl = `${PUBLIC_URL}/manifest/${manifestName}`;
        entry.installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(entry.manifestUrl)}`;
        app.ios.push(entry);
      } else {
        app.android.push(entry);
      }

      try { fs.unlinkSync(localPath); } catch {}
    }
  }

  const out = [...apps.values()].map(a => {
    if (!a.mac) a.mac = [];
    if (!a.win) a.win = [];
    a.ios.sort((x, y) => y.uploadedAt.localeCompare(x.uploadedAt));
    a.android.sort((x, y) => y.uploadedAt.localeCompare(x.uploadedAt));
    a.mac.sort((x, y) => y.uploadedAt.localeCompare(x.uploadedAt));
    a.win.sort((x, y) => y.uploadedAt.localeCompare(x.uploadedAt));
    const times = [a.ios[0]?.uploadedAt, a.android[0]?.uploadedAt, a.mac[0]?.uploadedAt, a.win[0]?.uploadedAt].filter(Boolean);
    a.latestAt = times.sort().pop() || null;
    delete a._iconRank;
    return a;
  });
  out.sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''));

  fs.writeFileSync(APPS_JSON, JSON.stringify({
    siteTitle: CONFIG.siteTitle || 'App 分发',
    publicUrl: PUBLIC_URL,
    generatedAt: new Date().toISOString(),
    apps: out
  }, null, 2));

  console.log(`Built ${out.length} app(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
