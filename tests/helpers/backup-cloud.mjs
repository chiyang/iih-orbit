import {createBackup} from '../../src/app/backup-data.ts';
import {emptyWorkspace} from '../../src/app/workspace-data.ts';
import {checksum} from '../../src/app/drive-data.ts';
import {DriveApi} from '../../src/app/drive-api.ts';
import {GoogleHttpError} from '../../src/app/google-api.ts';

export function backup(count = 200, width = 100) {
  const workspace = {...emptyWorkspace('workspace', '研究'), tasks: Array.from({length: count}, (_, index) => ({id: 'task-' + index, title: '任務 ' + index, description: '內容'.repeat(width), categoryId: '', projectId: '', status: 'todo', priority: 'medium', startDate: '', startTime: '', dueDate: '', dueTime: '', subtasks: []}))};
  return createBackup({version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]}, 'full');
}
export function cloud() {
  const files = new Map(), uploads = [], reads = []; let serial = 0, failBlock = false, lostReply = false, now = Date.parse('2026-10-13T00:00:00Z'), namespace = 'account-a';
  const info = entry => structuredClone(entry.metadata);
  const transport = {
    async api(path, parameters = {}, options = {}) {
      if (path === 'files/generateIds') return {ids: ['file_' + (++serial)]};
      if (path === 'files') {
        if (options.method === 'POST') {
          const metadata = JSON.parse(options.body); metadata.createdTime = metadata.modifiedTime = new Date(now).toISOString(); files.set(metadata.id, {metadata, data: null}); return {id: metadata.id};
        }
        const type = /key='type' and value='([^']+)'/.exec(parameters.q)?.[1];
        const dataset = /key='dataset' and value='([^']+)'/.exec(parameters.q)?.[1];
        const parent = /'([^']+)' in parents/.exec(parameters.q)?.[1];
        return {files: [...files.values()].filter(entry => entry.metadata.appProperties?.orbit === 'v1' && entry.metadata.appProperties.type === type && (!dataset || entry.metadata.appProperties.dataset === dataset) && (!parent || entry.metadata.parents?.includes(parent)) && (!parameters.q?.includes('trashed = false') || !entry.metadata.trashed)).map(info)};
      }
      const id = path.slice(6), entry = files.get(id);
      if (!entry) throw new GoogleHttpError(404, 'missing');
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        if (body.appProperties) {entry.metadata.appProperties = {...entry.metadata.appProperties, ...body.appProperties}; for (const [key, value] of Object.entries(entry.metadata.appProperties)) if (value === null) delete entry.metadata.appProperties[key]; delete body.appProperties;}
        Object.assign(entry.metadata, body); entry.metadata.modifiedTime = new Date(now).toISOString();
        if (parameters.removeParents) entry.metadata.parents = (entry.metadata.parents ?? []).filter(parent => !parameters.removeParents.split(',').includes(parent));
        if (parameters.addParents) entry.metadata.parents = [...new Set([...(entry.metadata.parents ?? []), parameters.addParents])];
        return info(entry);
      }
      if (parameters.alt === 'media') {reads.push({id, type: entry.metadata.appProperties.type}); return structuredClone(entry.data);}
      return info(entry);
    },
    async upload(url, options) {
      let metadata, data;
      if (url.includes('uploadType=multipart')) {
        const body = options.body, first = body.indexOf('\r\n\r\n') + 4, end = body.indexOf('\r\n--', first);
        metadata = JSON.parse(body.slice(first, end));
        const media = body.indexOf('\r\n\r\n', end) + 4; data = body.slice(media, body.lastIndexOf('\r\n--'));
      } else {
        const id = new URL(url).pathname.split('/').at(-1); metadata = files.get(id).metadata; data = options.body;
      }
      if (failBlock && metadata.appProperties.type === 'block') throw new Error('區塊上傳中斷');
      metadata = {...metadata, createdTime: metadata.createdTime ?? new Date(now).toISOString(), modifiedTime: new Date(now).toISOString(), size: String(new TextEncoder().encode(data).length), sha256Checksum: await checksum(JSON.parse(data))};
      files.set(metadata.id, {metadata, data: JSON.parse(data)}); uploads.push({type: JSON.parse(data).application === 'iih-orbit-chunked' ? 'version' : metadata.appProperties.type, bytes: +metadata.size, id: metadata.id});
      if (lostReply && metadata.appProperties.type === 'block') {lostReply = false; throw new Error('回覆遺失');}
      return new Response(JSON.stringify(metadata), {status: 200, headers: {'Content-Type': 'application/json'}});
    }
  };
  const api = new DriveApi(transport, () => namespace);
  return {api, transport, files, uploads, reads, now: () => now, advance(days) {now += days * 86400000;}, fail(value) {failBlock = value;}, lose() {lostReply = true;}, switch() {namespace = 'account-b';}};
}
