import {readdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export async function generateOfflineWorker(directory) {
  async function files(path = '') {
    const entries = await readdir(join(directory, path), {withFileTypes: true});
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]));
    return nested.flat();
  }
  const names = (await files()).filter(name => name !== 'sw.js' && !name.endsWith('.map')).sort();
  const assets = await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')]));
  const template = await readFile(new URL('./offline-worker.js', import.meta.url), 'utf8');
  const version = createHash('sha256').update(JSON.stringify(assets)).update(template).digest('hex');
  await writeFile(join(directory, 'sw.js'), `const VERSION = ${JSON.stringify(version)};\nconst ASSETS = ${JSON.stringify(assets)};\n${template}`);
  process.stdout.write(`Offline application: ${assets.length} verified assets\n`);
}
