#!/usr/bin/env node
// Resolve the release version for packaging:
// - if the local app version is higher than the latest GitHub release version, use local
// - otherwise bump the latest GitHub release version
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage:
  node scripts/resolve-release-version.mjs --local-version <version> [--prefix <tag-prefix>] [--repo owner/name]
  node scripts/resolve-release-version.mjs --local-version 6.1.18 --prefix 50-mobile --github-version 6.1.20

Options:
  --local-version    Local package version, for example 6.1.18 or 6.1.18+42
  --prefix           Release tag prefix, for example 50-mobile. Output tag becomes <prefix>-<version>
  --repo             GitHub repo, default reads config.json repo
  --github-version   Override GitHub latest version for offline tests
  --json             Print JSON instead of key=value lines
  --github-output    Also append resolved values to $GITHUB_OUTPUT
`;
}

function parseArgs(argv) {
  const out = { json: false, githubOutput: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'json' || key === 'githubOutput') {
      out[key] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (!value) throw new Error(`Missing value for --${arg.slice(2)}`);
    out[key] = value;
  }
  return out;
}

function readDefaultRepo() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return config.repo || '';
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseVersion(value, prefix = '', options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const source = raw.replace(/\+/g, '-');
  const pattern = prefix
    ? new RegExp(`(?:^|[/_-])${escapeRegExp(prefix)}[-_v]*([0-9]+(?:\\.[0-9]+)*)`, 'i')
    : /v?([0-9]+(?:\.[0-9]+)*)/i;
  const prefixedMatch = source.match(pattern);
  if (prefix && options.requirePrefix && !prefixedMatch) return null;
  const fallbackMatch = source.match(/v?([0-9]+(?:\.[0-9]+)*)/i);
  const core = (prefixedMatch || fallbackMatch)?.[1];
  if (!core) return null;

  const parts = core.split('.').map(n => Number.parseInt(n, 10));
  if (!parts.length || parts.some(n => Number.isNaN(n))) return null;
  return { raw, core, parts };
}

function compareVersions(a, b) {
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.parts[i] || 0;
    const bv = b.parts[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

function bumpVersion(version) {
  const parts = version.parts.slice();
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function fetchReleaseVersions(repo, prefix) {
  const out = execFileSync('gh', ['api', '--paginate', `/repos/${repo}/releases?per_page=100`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const releases = JSON.parse(out).filter(r => !r.draft);
  return releases
    .map(r => parseVersion(r.tag_name, prefix, { requirePrefix: Boolean(prefix) }))
    .filter(Boolean);
}

function latestVersion(versions) {
  return versions.reduce((best, current) => {
    if (!best || compareVersions(current, best) > 0) return current;
    return best;
  }, null);
}

function formatTag(prefix, version) {
  return prefix ? `${prefix}-${version}` : version;
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key}=${value ?? ''}`);
  }
}

function writeGithubOutput(result) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('--github-output requires GITHUB_OUTPUT to be set');
  fs.appendFileSync(output, Object.entries(result).map(([key, value]) => `${key}=${value ?? ''}`).join('\n') + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.localVersion) {
    console.error(usage());
    throw new Error('--local-version is required');
  }

  const prefix = args.prefix || '';
  const local = parseVersion(args.localVersion);
  if (!local) throw new Error(`Invalid local version: ${args.localVersion}`);

  const githubVersions = args.githubVersion
    ? [parseVersion(args.githubVersion, prefix)]
    : fetchReleaseVersions(args.repo || readDefaultRepo(), prefix);
  const github = latestVersion(githubVersions.filter(Boolean));

  let resolvedVersion;
  let strategy;
  if (!github) {
    resolvedVersion = local.core;
    strategy = 'local-no-github-version';
  } else if (compareVersions(local, github) > 0) {
    resolvedVersion = local.core;
    strategy = 'local';
  } else {
    resolvedVersion = bumpVersion(github);
    strategy = compareVersions(local, github) === 0 ? 'bump-github-equal' : 'bump-github';
  }

  const result = {
    local_version: local.core,
    github_version: github?.core || '',
    resolved_version: resolvedVersion,
    resolved_tag: formatTag(prefix, resolvedVersion),
    strategy,
  };

  printResult(result, args.json);
  if (args.githubOutput) writeGithubOutput(result);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
