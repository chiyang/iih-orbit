import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sourceFileKind, sourceFileLabel} from '../src/app/source-file-type.ts';

test('檔案 metadata 與捷徑目標優先辨識，檔名不把 Google 檔案或資料夾誤判為 ECMX', () => {
  for (const [mimeType, kind] of [['document', 'document'], ['spreadsheet', 'sheet'], ['presentation', 'presentation'], ['folder', 'folder']]) {
    const file = {name: '名稱.ecmx', mimeType: 'application/vnd.google-apps.' + mimeType};
    assert.equal(sourceFileKind(file), kind);
    assert.equal(sourceFileKind({...file, mimeType: 'application/vnd.google-apps.shortcut', shortcut: {mimeType: file.mimeType}}), kind);
  }
  assert.equal(sourceFileLabel({name: '試算表', mimeType: 'application/vnd.google-apps.shortcut', shortcut: {mimeType: 'application/vnd.google-apps.spreadsheet'}}), 'Google 試算表捷徑');
});
test('Colab、ipynb 與附圖 ECMX 支援無專屬 MIME、大小寫副檔名與通用檔案回退', () => {
  assert.equal(sourceFileKind({name: '分析', mimeType: 'application/vnd.google.colaboratory'}), 'notebook');
  assert.equal(sourceFileKind({name: '分析.IPYNB ', mimeType: 'application/json'}), 'notebook');
  assert.equal(sourceFileKind({name: '研究流程.ECMX', mimeType: 'application/octet-stream'}), 'ecmx');
  assert.equal(sourceFileKind({name: '研究流程.ecmx.txt'}), 'file');
  assert.equal(sourceFileKind({name: 'folder.ipynb', mimeType: 'application/vnd.google-apps.folder'}), 'folder');
  assert.equal(sourceFileLabel({name: '研究流程.ecmx'}), 'ECMX 檔案');
});
test('已保存的手動 Google 連結也可辨識圖示，Gmail 與一般檔案保持各自類型', () => {
  assert.equal(sourceFileKind({name: '報告', url: 'https://docs.google.com/document/d/report/edit'}), 'document');
  assert.equal(sourceFileKind({name: '報告', url: 'https://docs.google.com/spreadsheets/d/report/edit'}), 'sheet');
  assert.equal(sourceFileKind({name: '報告', url: 'https://docs.google.com/presentation/d/report/edit'}), 'presentation');
  assert.equal(sourceFileKind({name: '報告.ecmx', provider: 'gmail'}), 'mail');
  assert.equal(sourceFileKind({name: 'report.PDF'}), 'pdf');
  assert.equal(sourceFileKind({name: 'image', mimeType: 'image/jpeg'}), 'image');
  assert.equal(sourceFileKind({name: 'document', url: 'https://example.test/document/d/report/edit'}), 'file');
  assert.equal(sourceFileKind({name: 'document', url: 'invalid'}), 'file');
});
