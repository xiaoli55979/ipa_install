import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distributionGroup,
  parseDistributionGroupId,
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
