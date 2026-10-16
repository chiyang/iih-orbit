export type SourceFileKind = 'folder' | 'document' | 'sheet' | 'presentation' | 'notebook' | 'ecmx' | 'pdf' | 'image' | 'mail' | 'file';
export interface SourceFileInfo {name: string; mimeType?: string; provider?: string; url?: string; shortcut?: {id?: string; mimeType: string; resourceKey?: string}}
const GOOGLE_TYPES: Record<string, SourceFileKind> = {
  'application/vnd.google-apps.folder': 'folder',
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google.colaboratory': 'notebook',
  'application/x-ipynb+json': 'notebook'
};
const LABELS: Record<SourceFileKind, string> = {folder: '資料夾', document: 'Google 文件', sheet: 'Google 試算表', presentation: 'Google 簡報', notebook: 'Colab / Jupyter Notebook', ecmx: 'ECMX 檔案', pdf: 'PDF', image: '圖片', mail: 'Gmail 郵件', file: '檔案'};

/** Identify from metadata or the filename; never fetch file contents. */
export function sourceFileKind(file: SourceFileInfo): SourceFileKind {
  if (file.provider === 'gmail') return 'mail';
  const mime = (file.shortcut?.mimeType ?? file.mimeType ?? '').toLowerCase(), name = file.name.trim().toLowerCase();
  if (GOOGLE_TYPES[mime]) return GOOGLE_TYPES[mime];
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (file.url) {
    try {
      const url = new URL(file.url);
      if (url.hostname === 'docs.google.com') {
        const family = /^\/(document|spreadsheets|presentation)\/d\//.exec(url.pathname)?.[1];
        if (family) return family === 'document' ? 'document' : family === 'spreadsheets' ? 'sheet' : 'presentation';
      }
    } catch { /* Keep the generic icon when URL metadata is unavailable. */ }
  }
  if (name.endsWith('.ecmx')) return 'ecmx';
  if (name.endsWith('.ipynb')) return 'notebook';
  if (name.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|svg|heic|avif)$/.test(name)) return 'image';
  return 'file';
}
export function sourceFileLabel(file: SourceFileInfo): string {
  const label = LABELS[sourceFileKind(file)];
  return file.shortcut ? label + '捷徑' : file.mimeType === 'application/vnd.google-apps.shortcut' ? '檔案捷徑' : label;
}

/** Keep portable Drive URLs in saved data, and open notebooks in their editor. */
export function sourceOpenUrl(file: SourceFileInfo): string {
  if (!file.url || sourceFileKind(file) !== 'notebook' || file.provider && file.provider !== 'google-drive') return file.url ?? '';
  try {
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) return file.url;
    const id = file.shortcut?.id ?? /\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? (url.pathname === '/open' ? url.searchParams.get('id') : undefined);
    if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return file.url;
    const key = file.shortcut?.resourceKey ?? url.searchParams.get('resourcekey');
    return 'https://colab.research.google.com/drive/' + id + (key && /^[A-Za-z0-9_-]{1,200}$/.test(key) ? '?resourcekey=' + encodeURIComponent(key) : '');
  } catch {return file.url;}
}
