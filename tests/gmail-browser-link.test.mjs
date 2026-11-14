import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gmailBrowserLink} from '../src/app/gmail-browser-link.ts';
import {gmailMessageLink} from '../src/app/gmail-data.ts';
import {mailInformationSource} from '../src/app/mail-information-data.ts';
import {sourceOpenUrl} from '../src/app/source-file-type.ts';

const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36';
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const mail = {id: 'mail', threadId: 'thread', messageId: '<mail+test/path@example.test>', subject: '討論「中文」與 "報告"', from: '寄件人 <sender@example.test>', senderEmail: 'sender@example.test'};
const saved = gmailMessageLink(mail, 'me+work@example.test');
const destination = value => new URL(new URL(value).searchParams.get('continue'));

test('Android 與 iPhone 外部 Gmail 連結保留帳號與完整搜尋條件，使用手機網頁路由且不發出請求', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {throw new Error('外部連結不得呼叫 API');});
  for (const userAgent of [android, iphone]) {
    const opened = gmailBrowserLink(saved, userAgent), chooser = new URL(opened), target = destination(opened);
    assert.equal(chooser.origin, 'https://accounts.google.com'); assert.equal(chooser.searchParams.get('Email'), 'me+work@example.test');
    assert.equal(target.pathname, '/mail/mu/mp/'); assert.equal(target.searchParams.get('authuser'), 'me+work@example.test');
    assert.equal(decodeURIComponent(target.hash), '#tl/search/in:anywhere rfc822msgid:mail+test/path@example.test');
    assert.equal(gmailBrowserLink(opened, userAgent), opened);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('電腦、Android 平板、iPad 與要求桌面網站的瀏覽器保留原有 Gmail 連結', () => {
  for (const userAgent of [
    '',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
  ]) assert.equal(gmailBrowserLink(saved, userAgent), saved);
});

test('舊任務資訊連結在手機顯示時調整，儲存內容與桌面結果不改寫；無 Message-ID 時保留原搜尋', () => {
  for (const messageId of [mail.messageId, '']) {
    const source = mailInformationSource({...mail, messageId}, 'me+work@example.test', 'account'), before = structuredClone(source);
    const opened = sourceOpenUrl(source, android), target = destination(opened), canonical = destination(source.url);
    assert.equal(target.hash.slice('#tl/search/'.length), canonical.hash.slice('#search/'.length));
    assert.deepEqual(source, before); assert.equal(sourceOpenUrl(source, ''), source.url);
    if (!messageId) assert.match(decodeURIComponent(target.hash), /subject:.*中文.*from:sender@example.test/);
  }
});

test('直接 Gmail 搜尋也可調整，其他網站、無搜尋目標或無效連結保持原值', () => {
  const direct = destination(saved).href, target = new URL(gmailBrowserLink(direct, android));
  assert.equal(target.pathname, '/mail/mu/mp/'); assert.equal(target.hash.replace('#tl/', '#'), new URL(direct).hash);
  for (const value of [
    'invalid',
    'javascript:alert(1)',
    'https://example.test/#search/mail',
    'http://mail.google.com/mail/#search/mail',
    'https://mail.google.com.evil.test/mail/#search/mail',
    'https://user:password@mail.google.com/mail/#search/mail',
    'https://mail.google.com/mail/#inbox/thread',
    'https://mail.google.com/mail/#search/',
    'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fevil.test%2F%23search%2Fmail',
    'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Faccounts.google.com%2FAccountChooser',
    'https://accounts.google.com/AccountChooser?continue=invalid'
  ]) assert.equal(gmailBrowserLink(value, android), value);
});
