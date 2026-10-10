import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCENT_COLORS, DEFAULT_APPEARANCE, PRESET_COLORS, categoryPalette, colorHex, contrast, readAppearance, themeTokens, validColor } from '../src/app/appearance-data.ts';
import { createBackup, readBackup } from '../src/app/backup-data.ts';
import { emptyWorkspace } from '../src/app/workspace-data.ts';

test('外觀讀取升級舊字體設定，驗證主題與 HEX，過濾未定義欄位', () => {
  assert.deepEqual(readAppearance({textSize: 'small'}), {...DEFAULT_APPEARANCE, textSize: 'small'});
  assert.deepEqual(readAppearance({textSize: 'standard', theme: 'system', accent: '#AABBCC', accessToken: 'hidden'}), {...DEFAULT_APPEARANCE, theme: 'system', accent: '#aabbcc'});
  for (const value of [{textSize: 'unknown'}, {textSize: 'small', theme: 'unknown'}, {textSize: 'small', accent: '#abc'}, {textSize: 'small', accent: 'red'}, null]) assert.equal(readAppearance(value), null);
  assert.equal(validColor('toString'), false);
  assert.equal(colorHex('toString'), '#929992');
});

test('極端自訂色及舊色票在深淺色下保持標籤文字與圖示對比', () => {
  for (const dark of [false, true]) {
    for (const color of [...Object.keys(PRESET_COLORS), '#ffffff', '#000000', '#ffff00', '#ff0000', '#00ffff', '#ff00ff', '#1e242a']) {
      const palette = categoryPalette(color, dark);
      assert.ok(contrast(palette.text, palette.background) >= 4.5, `${color}, dark=${dark}: text`);
      assert.ok(contrast(palette.color, dark ? '#1e242a' : '#ffffff') >= 3, `${color}, dark=${dark}: marker`);
      assert.ok(contrast(palette.onColor, palette.color) >= 4.5);
    }
  }
});

test('主題色、按鈕文字及一般文字在深淺色表面維持對比', () => {
  const surfaces = ['--surface', '--page', '--surface-soft', '--surface-hover', '--sidebar-bg', '--section-bg', '--control-bg', '--header-bg', '--footer-bg', '--calendar-outside-bg', '--calendar-weekend-bg', '--calendar-today-bg', '--accent-soft'];
  for (const dark of [false, true]) {
    for (const accent of [...ACCENT_COLORS.map(item => item.color), '#ffffff', '#000000', '#ffff00', '#ff0000', '#00ffff', '#ff00ff', '#808080', '#1e242a']) {
      const tokens = themeTokens(accent, dark);
      assert.ok(contrast(tokens['--on-accent'], tokens['--accent-strong']) >= 4.5);
      for (const surface of surfaces) {
        for (const foreground of ['--text', '--text-muted', '--text-soft', '--accent-text']) {
          assert.ok(contrast(tokens[foreground], tokens[surface]) >= 4.5, `${accent}, dark=${dark}: ${foreground} on ${surface}`);
        }
      }
    }
  }
});

test('側欄、專案、搜尋、表頭與月曆底色隨主題色改變，今天與非當月區分', () => {
  const regions = ['--surface-soft', '--surface-hover', '--sidebar-bg', '--section-bg', '--control-bg', '--header-bg', '--footer-bg', '--calendar-outside-bg', '--calendar-weekend-bg', '--calendar-today-bg', '--border'];
  for (const dark of [false, true]) {
    const palettes = ACCENT_COLORS.map(item => themeTokens(item.color, dark));
    for (const region of regions) assert.equal(new Set(palettes.map(tokens => tokens[region])).size, ACCENT_COLORS.length, `${region}, dark=${dark}`);
    for (const accent of [...ACCENT_COLORS.map(item => item.color), '#ffffff', '#000000', '#ffff00']) {
      const tokens = themeTokens(accent, dark);
      assert.notEqual(tokens['--calendar-today-bg'], tokens['--calendar-outside-bg']);
      assert.notEqual(tokens['--calendar-outside-bg'], tokens['--surface']);
      assert.notEqual(tokens['--calendar-outside-bg'], tokens['--calendar-weekend-bg']);
    }
  }
});

test('格式 5 備份包含完整外觀，舊格式 2 升級與非法顏色拒絕', () => {
  const workspace = emptyWorkspace('workspace', '工作');
  workspace.categories.push({id: 'custom', name: '分類', color: '#112233'});
  const state = {version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]};
  const backup = createBackup(state, 'full', [], {textSize: 'extra-small', theme: 'dark', accent: '#3264ad'});
  assert.equal(backup.formatVersion, 5);
  assert.deepEqual(readBackup(JSON.parse(JSON.stringify(backup))).preferences, backup.preferences);
  const old = {...backup, formatVersion: 2, preferences: {textSize: 'small'}};
  assert.deepEqual(readBackup(old).preferences, {...DEFAULT_APPEARANCE, textSize: 'small'});
  const invalid = structuredClone(backup);
  invalid.data.workspaces[0].categories[0].color = 'url(example)';
  assert.throws(() => readBackup(invalid));
});
