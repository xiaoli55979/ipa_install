import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distributionGroup,
  parseDistributionGroupId,
  platformBundleIdsDiffer,
} from '../scripts/build-metadata.mjs';

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
