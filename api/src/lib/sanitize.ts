import sanitizeHtml from 'sanitize-html';

/**
 * The privacy policy is HTML written in the admin's rich-text editor and rendered to every visitor
 * with dangerouslySetInnerHTML, so it is sanitised on the way in (stored XSS defence). Only the tags
 * and Quill alignment classes the editor can produce survive.
 */
const options: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'blockquote',
    'ul',
    'ol',
    'li',
    'a',
    'span',
    'div',
  ],
  allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['class'] },
  allowedClasses: {
    '*': ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer',
    }),
  },
};

export function sanitizePrivacyHtml(html: string): string {
  return sanitizeHtml(html, options);
}
