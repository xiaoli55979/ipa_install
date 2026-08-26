import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactProjectKey,
  distributionGroup,
  parseDistributionGroupId,
  platformBundleIdsDiffer,
  releaseProjectKeys,
  retainLatestVersions,
  selectRecentProjectReleases,
} from '../scripts/build-metadata.mjs';
import { planReleasePrune } from '../scripts/prune-releases.mjs';

test('reads a distribution group ID from release notes', () => {
  assert.equal(
    parseDistributionGroupId('Distribution-Group-ID: quickchat\n\nRelease notes'),
    'quickchat',
  );
  assert.equal(parseDistributionGroupId('Release notes only'), null);
});

test('groups by configured ID and falls back to bundle ID', () => {
  assert.deepEqual(distributionGroup('com.quickchat.cn.dev', 'quickchat'), {
    key: 'group:quickchat',
    id: 'quickchat',
  });
  assert.deepEqual(distributionGroup('com.quickchat.cn', null), {
    key: 'com.quickchat.cn',
    id: 'com.quickchat.cn',
  });
});

test('shows platform bundle IDs only when iOS and Android differ', () => {
  assert.equal(platformBundleIdsDiffer({
    ios: [{ bundleId: 'com.quickchat.cn.dev' }],
    android: [{ bundleId: 'com.quickchat.cn' }],
  }), true);

  assert.equal(platformBundleIdsDiffer({
    ios: [{ bundleId: 'com.example.app' }],
    android: [{ bundleId: 'com.example.app' }],
  }), false);

  assert.equal(platformBundleIdsDiffer({
    ios: [{ bundleId: 'com.example.app' }],
    android: [],
  }), false);
});

test('infers a stable project key from release asset names', () => {
  assert.equal(artifactProjectKey('50-mobile_7.1.3_26081301.apk'), '50-mobile');
  assert.equal(artifactProjectKey('YunXiaoLiao-mobile_1.1.53_test.ipa'), 'yunxiaoliao-mobile');
  assert.equal(artifactProjectKey('TFSystem-desktop_1.0.6-arm64.dmg'), 'tfsystem-desktop');
  assert.equal(artifactProjectKey('YunXiaoLiao-Setup-1.1.33-x64.zip'), 'yunxiaoliao');
  assert.equal(artifactProjectKey('1.1.6.1.apk'), null);
});

test('uses the distribution group as the release project key when present', () => {
  assert.deepEqual(releaseProjectKeys({
    body: 'Distribution-Group-ID: QuickChat',
    assets: [
      { name: 'ios-client_1.0.0.ipa' },
      { name: 'android-client_1.0.0.apk' },
    ],
  }), ['group:quickchat']);
});

test('selects at most three recent releases per inferred project before downloads', () => {
  const release = (tag, project, day) => ({
    tag_name: tag,
    published_at: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`,
    assets: [{ name: `${project}_${tag.match(/\d+(?:\.\d+)*/)[0]}.apk` }],
  });
  const selected = selectRecentProjectReleases([
    release('app-a-1.0.1', 'app-a', 1),
    release('app-a-1.0.4', 'app-a', 4),
    release('app-b-2.0.1', 'app-b', 2),
    release('app-a-1.0.2', 'app-a', 2),
    release('app-a-1.0.3', 'app-a', 3),
    { tag_name: 'empty-1.0.0', published_at: '2026-08-05T00:00:00Z', assets: [] },
  ], 3);

  assert.deepEqual(selected.map(item => item.tag_name), [
    'app-a-1.0.4',
    'app-a-1.0.3',
    'app-b-2.0.1',
    'app-a-1.0.2',
  ]);
});

test('retains three distinct versions while preserving same-version variants', () => {
  const entries = [
    { version: '4.0.0', file: 'app-4.0.0-arm64.dmg' },
    { version: '4.0.0', file: 'app-4.0.0-x64.dmg' },
    { version: '3.0.0', file: 'app-3.0.0.dmg' },
    { version: '2.0.0', file: 'app-2.0.0.dmg' },
    { version: '1.0.0', file: 'app-1.0.0.dmg' },
  ];

  assert.deepEqual(retainLatestVersions(entries, 3).map(entry => entry.version), [
    '4.0.0', '4.0.0', '3.0.0', '2.0.0',
  ]);
});

test('plans deletion of the fourth and older online release per project', () => {
  const releases = [4, 3, 2, 1].map(version => ({
    id: version,
    tag_name: `app-a-1.0.${version}`,
    published_at: `2026-08-0${version}T00:00:00Z`,
    assets: [{ name: `app-a_1.0.${version}.apk` }],
  }));
  const plan = planReleasePrune(releases, 3);

  assert.deepEqual(plan.keep.map(release => release.tag_name), [
    'app-a-1.0.4', 'app-a-1.0.3', 'app-a-1.0.2',
  ]);
  assert.deepEqual(plan.releaseDeletions.map(release => release.tag_name), ['app-a-1.0.1']);
  assert.deepEqual(plan.assetDeletions, []);
  assert.deepEqual(plan.unmanaged, []);
});

test('deletes only an obsolete project asset from a mixed release', () => {
  const releases = [
    ...[4, 3, 2].map(version => ({
      id: version + 10,
      tag_name: `app-a-1.0.${version}`,
      published_at: `2026-08-0${version}T00:00:00Z`,
      assets: [{ id: version + 100, name: `app-a_1.0.${version}.apk` }],
    })),
    {
      id: 1,
      tag_name: 'mixed-1.0.1',
      published_at: '2026-08-01T00:00:00Z',
      assets: [
        { id: 201, name: 'app-a_1.0.1.apk' },
        { id: 202, name: 'app-b_1.0.1.apk' },
      ],
    },
  ];
  const plan = planReleasePrune(releases, 3);

  assert.deepEqual(plan.releaseDeletions, []);
  assert.deepEqual(plan.assetDeletions.map(item => item.asset.name), ['app-a_1.0.1.apk']);
  assert.equal(plan.keep.some(release => release.tag_name === 'mixed-1.0.1'), true);
});
