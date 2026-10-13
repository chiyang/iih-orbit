import http from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

// A fresh port creates an isolated origin; never open this harness on the user's Orbit origin.
const require = createRequire(import.meta.url), {build} = createRequire(require.resolve('@angular/build/package.json'))('esbuild');
const directory = resolve('.angular/workspace-records-browser');
await mkdir(directory, {recursive: true});
await build({stdin: {
  contents: `import {runRecordBrowserTests} from './tests/workspace-records.browser.ts';
    runRecordBrowserTests().then(results => report({ok: true, results})).catch(error => report({ok: false, error: error.stack}));
    async function report(result) {document.body.textContent = result.ok ? 'PASS\\n' + result.results.join('\\n') : 'FAIL\\n' + result.error; await fetch('/result', {method: 'POST', body: JSON.stringify(result)});}`,
  resolveDir: process.cwd()
}, bundle: true, platform: 'browser', format: 'esm', outfile: resolve(directory, 'tests.js'), tsconfig: 'tsconfig.json'});
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/result' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) {body += chunk; if (body.length > 100000) throw new Error('Result too large');}
      const result = JSON.parse(body); await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
      response.end('ok'); clearTimeout(timeout); server.close();
      process.stdout.write(result.ok ? 'PASS: ' + result.results.length + ' native browser checks\n' : 'FAIL: ' + result.error + '\n');
      if (!result.ok) process.exitCode = 1;
    } else if (request.url === '/tests.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(await readFile(resolve(directory, 'tests.js')));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Orbit 原生儲存驗證</title><body style="white-space:pre-wrap">測試中…<script type="module" src="/tests.js"></script></body></html>');
    } else {response.statusCode = 404; response.end('Not found');}
  } catch (error) {response.statusCode = 500; response.end(String(error));}
});
const timeout = setTimeout(() => {server.close(); process.stderr.write('Browser test timed out\n'); process.exitCode = 1;}, 300000);
server.listen(0, '127.0.0.1', () => process.stdout.write('Open the isolated browser test: http://127.0.0.1:' + server.address().port + '/\n'));
process.on('SIGINT', () => {clearTimeout(timeout); server.close();});
