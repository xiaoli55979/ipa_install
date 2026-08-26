#!/usr/bin/env node
// 删除每个项目超出保留数量的 GitHub Release 及其 tag。
// 项目标识优先使用 Distribution-Group-ID，否则从发布物文件名前缀推断。
import { execFileSync } from 'node:child_process';
import {
  assetProjectKeyForRelease,
  fetchReleases,
  MAX_VERSIONS_PER_APP,
  packageExtension,
  releaseProjectKeys,
  REPO,
  retainedProjectKeysByRelease,
} from './build-metadata.mjs';

function parseArgs(argv) {
  let dryRun = false;
  let maxVersions = MAX_VERSIONS_PER_APP;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--max-versions') {
      maxVersions = Number(argv[++i]);
    } else if (arg.startsWith('--max-versions=')) {
      maxVersions = Number(arg.slice('--max-versions='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(maxVersions) || maxVersions < 1) {
    throw new Error('--max-versions must be a positive integer');
  }
  return { dryRun, maxVersions };
}

export function planReleasePrune(releases, maxVersions = MAX_VERSIONS_PER_APP) {
  const retained = retainedProjectKeysByRelease(releases, maxVersions);
  const keep = [];
  const releaseDeletions = [];
  const assetDeletions = [];
  const unmanaged = [];

  for (const release of releases) {
    const assets = release.assets || [];
    const packageAssets = assets.filter(asset => packageExtension(asset.name));
    if (!packageAssets.length) {
      unmanaged.push(release);
      continue;
    }

    const keptKeys = retained.get(String(release.id ?? release.tag_name)) || new Set();
    const obsoleteAssets = packageAssets.filter(asset => (
      !keptKeys.has(assetProjectKeyForRelease(release, asset))
    ));

    if (!obsoleteAssets.length) {
      keep.push(release);
      continue;
    }

    if (obsoleteAssets.length === assets.length) {
      releaseDeletions.push(release);
      continue;
    }

    keep.push(release);
    for (const asset of obsoleteAssets) {
      assetDeletions.push({
        release,
        asset,
        projectKey: assetProjectKeyForRelease(release, asset),
      });
    }
  }
  return { keep, releaseDeletions, assetDeletions, unmanaged };
}

function deleteRelease(release) {
  execFileSync('gh', [
    'release', 'delete', release.tag_name,
    '--repo', REPO,
    '--cleanup-tag',
    '--yes',
  ], { stdio: 'inherit' });
}

function deleteAsset(asset) {
  execFileSync('gh', [
    'api', '--method', 'DELETE',
    `/repos/${REPO}/releases/assets/${asset.id}`,
  ], { stdio: 'inherit' });
}

async function main() {
  const { dryRun, maxVersions } = parseArgs(process.argv.slice(2));
  const releases = fetchReleases();
  const plan = planReleasePrune(releases, maxVersions);

  console.log(`Repository: ${REPO}`);
  console.log(`Keep: ${plan.keep.length} release(s); delete: ${plan.releaseDeletions.length} release(s); delete assets: ${plan.assetDeletions.length}; unmanaged: ${plan.unmanaged.length} release(s).`);
  for (const release of plan.releaseDeletions) {
    const keys = releaseProjectKeys(release).join(', ');
    console.log(`${dryRun ? '[dry-run]' : '[delete]'} ${release.tag_name} (${keys})`);
    if (!dryRun) deleteRelease(release);
  }
  for (const item of plan.assetDeletions) {
    console.log(`${dryRun ? '[dry-run-asset]' : '[delete-asset]'} ${item.release.tag_name}/${item.asset.name} (${item.projectKey})`);
    if (!dryRun) deleteAsset(item.asset);
  }
  for (const release of plan.unmanaged) {
    console.warn(`[keep-unmanaged] ${release.tag_name}: no supported package asset`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
