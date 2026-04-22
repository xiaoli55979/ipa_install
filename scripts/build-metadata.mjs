#!/usr/bin/env node
// 从 GitHub Releases 拉取所有 IPA/APK/DMG/EXE/ZIP 资产，解析元数据并生成 apps.json + manifest.plist
// DMG(mac) / EXE|ZIP(win) 不解析内容，靠同 Release 里的 IPA/APK 提供 bundleId，版本号用 Release tag
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import simplePlist from 'simple-plist';

const require = createRequire(import.meta.url);
const ApkParser = require('app-info-parser/src/apk');

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

  let iconData = null;
  if (iconFiles.length) {
    const candidates = entries.filter(e => {
      if (!e.entryName.startsWith(appDir + '/')) return false;
      const base = path.posix.basename(e.entryName);
      if (!base.endsWith('.png')) return false;
      return iconFiles.some(n => base.startsWith(n));
    });
    if (candidates.length) {
      candidates.sort((a, b) => b.header.size - a.header.size);
      iconData = candidates[0].getData();
    }
  }
  return { bundleId, version, name, iconData };
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
    if (m) iconData = Buffer.from(m[1], 'base64');
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
        if (!releaseBundleId) {
          console.warn(`[skip] ${ext} ${asset.name}: release ${rel.tag_name} 没有同包名的 ipa/apk，无法归组`);
          continue;
        }
        const pkgUrl = asset.browser_download_url;
        const uploadedAt = asset.updated_at || asset.created_at || rel.published_at;
        if (!apps.has(releaseBundleId)) {
          apps.set(releaseBundleId, {
            id: releaseBundleId, name: releaseAppName || releaseBundleId,
            icon: null, ios: [], android: [], mac: [], win: []
          });
        }
        const app = apps.get(releaseBundleId);
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

      if (parsed.iconData && !app.icon) {
        const iconName = `${slugify(parsed.bundleId)}-${platform}.png`;
        fs.writeFileSync(path.join(ICON_DIR, iconName), parsed.iconData);
        app.icon = `${PUBLIC_URL}/icons/${iconName}`;
      }
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
