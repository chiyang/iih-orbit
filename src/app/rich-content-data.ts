import createDOMPurify, { type WindowLike } from 'dompurify';
import { Marked } from 'marked';

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const markdown = new Marked({gfm: true, breaks: true, renderer: {
  html: ({text}) => escapeHtml(text),
  checkbox: ({checked}) => checked ? '☑ ' : '☐ ',
  image: ({text, href}) => '<a href="' + escapeHtml(href) + '">圖片：' + escapeHtml(text || '開啟圖片') + '</a>'
}});
const tags = ['p', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 's', 'del', 'u', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'hr', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'sub', 'sup'];

/** Keep passive document content only. The same policy protects mail and task previews. */
export function sanitizeRichHtml(source: string, browser: WindowLike = window): string {
  const purifier = createDOMPurify(browser);
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return purifier.sanitize(source, {
    ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, SANITIZE_NAMED_PROPS: true
  });
}
export function renderMarkdown(source: string, browser: WindowLike = window): string {
  return sanitizeRichHtml(markdown.parse(source, {async: false}), browser);
}

/** Email tables usually arrange a newsletter, rather than represent tabular data. */
export function sanitizeMailHtml(source: string, browser: WindowLike = window): string {
  const document = browser.document;
  if (!document) return sanitizeRichHtml(source, browser);
  const template = document.createElement('template');
  template.innerHTML = sanitizeRichHtml(source, browser);
  for (const table of [...template.content.querySelectorAll('table')].reverse()) {
    if ([...table.querySelectorAll('th,caption')].some(cell => cell.closest('table') === table)) continue;
    const content = document.createDocumentFragment();
    for (const row of [...table.rows]) for (const cell of [...row.cells]) {
      if (!cell.textContent?.trim()) continue;
      const block = document.createElement('div');
      block.append(...cell.childNodes); content.append(block);
    }
    table.replaceWith(content);
  }
  return template.innerHTML;
}
