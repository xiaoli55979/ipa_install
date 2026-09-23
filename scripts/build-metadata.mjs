#!/usr/bin/env node
// 从 GitHub Releases 拉取每个项目最近的 IPA/APK/DMG/EXE/ZIP 资产，解析元数据并生成 apps.json + manifest.plist
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
export const REPO = CONFIG.repo;
if (!REPO) { console.error('config.json 缺少 "repo" 字段'); process.exit(1); }
const DEFAULT_MAX_VERSIONS_PER_APP = 3;
export const MAX_VERSIONS_PER_APP = Number.isInteger(CONFIG.maxVersionsPerApp) && CONFIG.maxVersionsPerApp > 0
  ? CONFIG.maxVersionsPerApp
  : DEFAULT_MAX_VERSIONS_PER_APP;

export function parseDistributionGroupId(releaseBody) {
  const match = String(releaseBody || '').match(
    /^\s*Distribution-Group-ID:\s*([a-zA-Z0-9._-]+)\s*$/im,
  );
  return match?.[1] || null;
}

export function distributionGroup(bundleId, groupId) {
  // key 统一小写,与 assetProjectKeyForRelease 的归一化一致,避免 MyApp/myapp 被展示层当两张卡、保留层当一个额度。
  return groupId
    ? { key: `group:${groupId.toLowerCase()}`, id: groupId }
    : { key: bundleId, id: bundleId };
}

export function platformBundleIdsDiffer(app) {
  const bundleIds = [app?.ios?.[0]?.bundleId, app?.android?.[0]?.bundleId].filter(Boolean);
  return bundleIds.length > 1 && new Set(bundleIds).size > 1;
}

const MANIFEST_DIR = path.join(ROOT, 'docs/manifest');
const ICON_DIR = path.join(ROOT, 'docs/icons');
const APPS_JSON = path.join(ROOT, 'docs/apps.json');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ipa-build-'));

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}
// gh 调用带退避重试:网络抖动 / 5xx / 二级速率限制在 CI 里常见,一次瞬时失败不该让 App 静默消失。
// 4xx(404/410/422)是确定性错误(字节不存在等),直接抛不重试。
function ghWithRetry(args, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024, ...opts });
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(String(e.stderr || e.message || ''))) throw e;
      if (i < tries - 1) execFileSync('sleep', [String((i + 1) * 2)]);
    }
  }
  throw lastErr;
}
function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}
function slugify(s) { return String(s).replace(/[^a-zA-Z0-9._-]/g, '_'); }

const PACKAGE_EXT_RE = /\.(ipa|apk|dmg|exe|zip)$/i;

export function packageExtension(name) {
  return (String(name).match(PACKAGE_EXT_RE) || [])[1]?.toLowerCase() || '';
}

// 发布脚本的文件名通常是 <project>_<version>.<ext>。先用这个无需下载即可取得的
// 项目标识裁掉老 Release；无法识别的资产保持独立，避免误删。
export function artifactProjectKey(name) {
  const stem = String(name).replace(PACKAGE_EXT_RE, '');
  const match = stem.match(/^(.*?)(?:[_-])v?\d+(?:\.\d+){0,3}(?=$|[_-])/i);
  const prefix = match?.[1]
    ?.replace(/(?:[_-]setup)$/i, '')
    .replace(/[_-]+$/, '')
    .trim();
  return prefix ? prefix.toLowerCase() : null;
}

export function assetProjectKeyForRelease(release, asset) {
  const groupId = parseDistributionGroupId(release?.body);
  if (groupId) return `group:${groupId.toLowerCase()}`;
  // 文件名无法唯一标识项目(如 Flutter 默认的 app-release.apk / Runner.ipa)时,兜底 key 并入 release 标识,
  // 使不同 release 永不共享保留额度——否则多个 bundleId 不同的 App 会挤同一个桶、老的被静默删/藏。
  const artifactKey = artifactProjectKey(asset?.name);
  if (artifactKey) return artifactKey;
  return `asset:${String(release?.id ?? release?.tag_name)}:${String(asset?.name || '').toLowerCase()}`;
}

export function releaseProjectKeys(release) {
  const assets = (release?.assets || []).filter(asset => packageExtension(asset?.name));
  if (!assets.length) return [];
  const keys = new Set(assets.map(asset => assetProjectKeyForRelease(release, asset)));
  return [...keys];
}

function releaseIdentity(release) {
  return String(release.id ?? release.tag_name);
}

export function retainedProjectKeysByRelease(releases, maxVersions = DEFAULT_MAX_VERSIONS_PER_APP) {
  const limit = Number.isInteger(maxVersions) && maxVersions > 0
    ? maxVersions
    : DEFAULT_MAX_VERSIONS_PER_APP;
  const counts = new Map();
  const retained = new Map();
  const ordered = releases.slice().sort((a, b) => {
    const aTime = a.published_at || a.created_at || '';
    const bTime = b.published_at || b.created_at || '';
    return bTime.localeCompare(aTime);
  });

  for (const release of ordered) {
    const keptKeys = new Set();
    for (const key of releaseProjectKeys(release)) {
      const count = counts.get(key) || 0;
      if (count >= limit) continue;
      counts.set(key, count + 1);
      keptKeys.add(key);
    }
    if (keptKeys.size) retained.set(releaseIdentity(release), keptKeys);
  }
  return retained;
}

export function selectRecentProjectReleases(releases, maxVersions = DEFAULT_MAX_VERSIONS_PER_APP) {
  const retained = retainedProjectKeysByRelease(releases, maxVersions);
  const ordered = releases.slice().sort((a, b) => {
    const aTime = a.published_at || a.created_at || '';
    const bTime = b.published_at || b.created_at || '';
    return bTime.localeCompare(aTime);
  });
  return ordered.filter(release => retained.has(releaseIdentity(release)));
}

export function retainLatestVersions(entries, maxVersions = DEFAULT_MAX_VERSIONS_PER_APP) {
  const limit = Number.isInteger(maxVersions) && maxVersions > 0
    ? maxVersions
    : DEFAULT_MAX_VERSIONS_PER_APP;
  const versions = new Set();
  const kept = [];

  for (const entry of entries) {
    const key = String(entry.version || entry.tag || entry.file || '');
    if (!versions.has(key)) {
      if (versions.size >= limit) continue;
      versions.add(key);
    }
    kept.push(entry);
  }
  return kept;
}

// pcMatchers: [{ bundleId, prefixes: [...] }] —— 按文件名前缀把 dmg/exe/zip 归到指定 bundleId
// 长前缀优先,大小写不敏感
const PC_MATCHERS = (() => {
  const raw = Array.isArray(CONFIG.pcMatchers) ? CONFIG.pcMatchers : [];
  return raw
    .flatMap(m => (m.prefixes || []).map(p => ({
      bundleId: m.bundleId,
      prefix: String(p).toLowerCase(),
      name: m.name,
      icon: m.icon || m.iconUrl,
    })))
    .sort((a, b) => b.prefix.length - a.prefix.length);
})();

const APP_METADATA = (() => {
  const raw = Array.isArray(CONFIG.appMetadata) ? CONFIG.appMetadata : [];
  const entries = [];
  for (const item of raw) {
    const ids = [item.id, item.bundleId, ...(Array.isArray(item.bundleIds) ? item.bundleIds : [])]
      .filter(Boolean)
      .map(id => String(id));
    for (const id of ids) entries.push([id, item]);
  }
  return new Map(entries);
})();

function appMetadataFor(...ids) {
  for (const id of ids) {
    const meta = APP_METADATA.get(String(id || ''));
    if (meta) return meta;
  }
  return null;
}

function publicAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  const rel = raw.replace(/^docs\//, '').replace(/^\/+/, '');
  return `${PUBLIC_URL}/${rel}`;
}

function applyAppMetadata(app) {
  const meta = appMetadataFor(app?.id);
  if (!meta) return app;
  if (meta.name && (!app.name || app.name === app.id)) app.name = String(meta.name);
  const icon = publicAssetUrl(meta.icon || meta.iconUrl);
  if (!app.icon && icon) app.icon = icon;
  return app;
}

export function assetDownloadCount(asset) {
  const value = Number(asset?.download_count ?? asset?.downloadCount ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const DISPLAY_RANK = { ios: 1, android: 2, win: 3, mac: 4 };

function maybeSetName(app, platform, name, bundleId) {
  const value = String(name || '').trim();
  if (!value || value === bundleId) return;
  const rank = DISPLAY_RANK[platform];
  if (!rank) return;
  if (app._nameRank != null && rank >= app._nameRank) return;
  app.name = value;
  app._nameRank = rank;
}

function maybeSetIconUrl(app, platform, iconUrl) {
  const icon = publicAssetUrl(iconUrl);
  if (!icon) return;
  const rank = ICON_RANK[platform];
  if (!rank) return;
  if (app._iconRank != null && rank >= app._iconRank) return;
  app.icon = icon;
  app._iconRank = rank;
}

function matchPcByFilename(name) {
  const lower = String(name).toLowerCase();
  for (const matcher of PC_MATCHERS) {
    if (lower.startsWith(matcher.prefix)) return matcher;
  }
  return null;
}

function pcVersion(filename, fallback) {
  const matched = String(filename).match(/(?:^|[_-])(\d+\.\d+\.\d+)(?=[_.-]|$)/);
  return matched?.[1] || fallback;
}

function pcNameFromFilename(filename) {
  const stem = path.basename(String(filename)).replace(PACKAGE_EXT_RE, '');
  const withoutVersion = stem.replace(/(?:[_-])v?\d+(?:\.\d+){0,3}.*$/i, '');
  const cleaned = withoutVersion
    .replace(/(?:[_-])setup$/i, '')
    .replace(/[_-]+$/, '')
    .trim();
  return cleaned || null;
}

const REFETCH_WINDOW_MS = 20 * 60 * 1000;
const usableAssets = (assets) => (assets || []).filter(a => a.state == null || a.state === 'uploaded');

export function fetchReleases() {
  const out = sh('gh', ['api', '--paginate', `/repos/${REPO}/releases?per_page=100`]);
  const arr = JSON.parse(out).filter(r => !r.draft);
  for (const rel of arr) {
    if (!rel.id) continue;
    // 列表端点内嵌的 assets 有缓存滞后:刚发布的 release 可能返回空、只返回部分、或只返回未完成(starter)的资产。
    // 补拉条件必须看"可用(已完成上传)资产数"而非原始数——否则只缓存到 starter 资产(原始数>0)会跳过补拉,
    // 随后被 state 过滤清空,刚发布的 App 依旧静默消失。刚发布不久的 release 也补拉一次以覆盖"部分缓存"。
    const published = rel.published_at ? Date.parse(rel.published_at) : NaN;
    const recent = Number.isFinite(published) && (Date.now() - published < REFETCH_WINDOW_MS);
    if (usableAssets(rel.assets).length === 0 || recent) {
      try {
        const raw = ghWithRetry(['api', '--paginate', `/repos/${REPO}/releases/${rel.id}/assets?per_page=100`]);
        const live = JSON.parse(raw);
        if (Array.isArray(live) && usableAssets(live).length > usableAssets(rel.assets).length) rel.assets = live;
      } catch (e) {
        console.warn(`[assets-refetch] ${rel.tag_name}: ${e.message}`);
      }
    }
    // 丢弃未完成上传(state 非 uploaded,如 starter)的资产:元数据在但字节不存在,下载会 404。
    const all = rel.assets || [];
    const broken = all.filter(a => a.state != null && a.state !== 'uploaded');
    if (broken.length) {
      console.warn(`[broken-upload] ${rel.tag_name}: ${broken.map(a => `${a.name}(${a.state})`).join(', ')} —— 上传未完成,已忽略,需重新上传`);
    }
    rel.assets = usableAssets(all);
  }
  return arr;
}

function downloadAsset(tag, asset) {
  const sub = path.join(TMP_DIR, slugify(tag));
  fs.mkdirSync(sub, { recursive: true });
  const dest = path.join(sub, asset.name);
  // 按 asset id 走二进制端点直接下载(gh release download 靠 tag+pattern 再查列表,会撞上 assets 缓存滞后)。
  // stdout 直接写文件 fd:不经 Node Buffer,无 512MB 上限、无 OOM——否则 512MB~2GB 的包会抛 ENOBUFS 被跳过而整卡消失。
  const args = ['api', `/repos/${REPO}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'];
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const fd = fs.openSync(dest, 'w');
    try {
      execFileSync('gh', args, { stdio: ['ignore', fd, 'pipe'] });
      fs.closeSync(fd);
      return dest;
    } catch (e) {
      fs.closeSync(fd);
      try { fs.unlinkSync(dest); } catch {}  // 清掉半截文件,免得被 parse 误读
      lastErr = e;
      if (/HTTP 4\d\d/.test(String(e.stderr || e.message || '')) || i === 2) throw e;
      execFileSync('sleep', [String((i + 1) * 2)]);
    }
  }
  throw lastErr;
}

function parseIpa(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const infoEntry = entries.find(e => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.entryName));
  if (!infoEntry) throw new Error('Info.plist not found');
  const appDir = path.posix.dirname(infoEntry.entryName);
  const info = simplePlist.parse(infoEntry.getData());

  const bundleId = info.CFBundleIdentifier;
  if (typeof bundleId !== 'string' || !bundleId.trim()) throw new Error('CFBundleIdentifier 缺失/为空');
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

// 图标来源优先级:iOS=1,Android=2,Windows=3,Mac=4;数字越小越优先,可覆盖
const ICON_RANK = { ios: 1, android: 2, win: 3, mac: 4 };

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
  if (typeof bundleId !== 'string' || !bundleId.trim()) throw new Error('package(bundleId) 缺失/为空');
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

  const allReleases = fetchReleases();
  const releases = selectRecentProjectReleases(allReleases, MAX_VERSIONS_PER_APP);
  console.log(`Found ${allReleases.length} release(s); processing ${releases.length} recent release(s) (max ${MAX_VERSIONS_PER_APP} version(s) per app).`);

  const apps = new Map();

  for (const rel of releases) {
    // 先处理 ipa/apk 拿到 bundleId,再处理 dmg/exe/zip 挂到同一 app
    const rawAssets = rel.assets || [];
    const extOf = packageExtension;
    const platformOf = (ext) => ext === 'ipa' ? 'ios'
      : ext === 'apk' ? 'android'
      : ext === 'dmg' ? 'mac'
      : (ext === 'exe' || ext === 'zip') ? 'win' : null;
    const rank = (n) => { const p = platformOf(extOf(n)); return (p === 'ios' || p === 'android') ? 0 : p ? 1 : 2; };
    const orderedAssets = rawAssets.slice().sort((a, b) => rank(a.name) - rank(b.name));
    const releaseGroupId = parseDistributionGroupId(rel.body);

    let releaseBundleId = null;
    let releaseAppName = null;

    for (const asset of orderedAssets) {
      const ext = extOf(asset.name);
      const platform = platformOf(ext);
      if (!platform) continue;

      if (platform === 'mac' || platform === 'win') {
        // 优先用文件名前缀匹配,跨 release 也能正确归组;匹配不上再用同 release 的 ipa/apk 兜底
        const matcher = matchPcByFilename(asset.name);
        const matchedBundleId = matcher?.bundleId;
        const rawTargetBundleId = matchedBundleId || releaseBundleId;
        if (!rawTargetBundleId) {
          console.warn(`[skip] ${ext} ${asset.name}: 文件名前缀不在 pcMatchers 中,且 release ${rel.tag_name} 没有 ipa/apk 提供 bundleId`);
          continue;
        }
        const target = distributionGroup(rawTargetBundleId, releaseGroupId);
        const pkgUrl = asset.browser_download_url;
        const uploadedAt = asset.updated_at || asset.created_at || rel.published_at;
        if (!apps.has(target.key)) {
          apps.set(target.key, {
            id: target.id,
            name: matchedBundleId ? target.id : (releaseAppName || target.id),
            icon: null, ios: [], android: [], mac: [], win: []
          });
        }
        const app = apps.get(target.key);
        if (!app.mac) app.mac = [];
        if (!app.win) app.win = [];
        const configuredMeta = appMetadataFor(target.id, rawTargetBundleId);
        const pcName = matcher?.name || configuredMeta?.name || pcNameFromFilename(asset.name) || releaseAppName;
        const pcIcon = matcher?.icon || configuredMeta?.icon || configuredMeta?.iconUrl;
        maybeSetName(app, platform, pcName, rawTargetBundleId);
        maybeSetIconUrl(app, platform, pcIcon);
        app[platform].push({
          bundleId: rawTargetBundleId,
          version: pcVersion(asset.name, rel.tag_name),
          uploadedAt,
          tag: rel.tag_name,
          releaseName: rel.name || rel.tag_name,
          notes: rel.body || '',
          file: asset.name,
          size: asset.size,
          downloadCount: assetDownloadCount(asset),
          downloadUrl: pkgUrl
        });

        // 当 ios 还没贡献图标时,从 exe 抽一个兜底
        if (ext === 'exe' && (app._iconRank == null || app._iconRank > ICON_RANK.win)) {
          let exePath;
          try {
            exePath = downloadAsset(rel.tag_name, asset);
          } catch (e) {
            console.warn(`[skip-icon] download ${asset.name}: ${e.message}`);
          }
          if (exePath) {
            const got = parseExeIcon(exePath);
            if (got) maybeSetIcon(app, target.id, 'win', got.data, got.ext);
            else console.warn(`[skip-icon] no icon resource in ${asset.name}`);
            try { fs.unlinkSync(exePath); } catch {}
          }
        }
        continue;
      }

      const isIpa = ext === 'ipa';

      let localPath;
      try {
        localPath = downloadAsset(rel.tag_name, asset);
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
      const target = distributionGroup(parsed.bundleId, releaseGroupId);

      if (!apps.has(target.key)) {
        apps.set(target.key, {
          id: target.id,
          name: target.id,
          icon: null,
          ios: [],
          android: [],
          mac: [],
          win: []
        });
      }
      const app = apps.get(target.key);
      if (!app.mac) app.mac = [];
      if (!app.win) app.win = [];

      if (!releaseBundleId) { releaseBundleId = parsed.bundleId; releaseAppName = parsed.name; }

      // 图标来源优先级由 maybeSetIcon 控制:iOS 可覆盖 Android,Android 可覆盖 Windows
      maybeSetIcon(app, target.id, platform, parsed.iconData, parsed.iconExt);
      maybeSetName(app, platform, parsed.name, parsed.bundleId);

      const entry = {
        bundleId: parsed.bundleId,
        version: parsed.version,
        uploadedAt,
        tag: rel.tag_name,
        releaseName: rel.name || rel.tag_name,
        notes: rel.body || '',
        file: asset.name,
        size: asset.size,
        downloadCount: assetDownloadCount(asset),
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
    a.ios = retainLatestVersions(a.ios, MAX_VERSIONS_PER_APP);
    a.android = retainLatestVersions(a.android, MAX_VERSIONS_PER_APP);
    a.mac = retainLatestVersions(a.mac, MAX_VERSIONS_PER_APP);
    a.win = retainLatestVersions(a.win, MAX_VERSIONS_PER_APP);
    applyAppMetadata(a);
    a.showPlatformBundleIds = platformBundleIdsDiffer(a);
    const times = [a.ios[0]?.uploadedAt, a.android[0]?.uploadedAt, a.mac[0]?.uploadedAt, a.win[0]?.uploadedAt].filter(Boolean);
    a.latestAt = times.sort().pop() || null;
    delete a._iconRank;
    delete a._nameRank;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
