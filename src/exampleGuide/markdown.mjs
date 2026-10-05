/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A frontmatter block opens with `---` on the very first line (optionally after a leading HTML
// comment such as the copyright header) and its first line is a `key:` entry. Requiring that key is
// what stops a document that merely opens with a horizontal rule (`---`) from being mistaken for
// frontmatter and losing everything up to its next `---`.
const frontmatterPattern = /^((?:<!--[\s\S]*?-->\s*)?)---\r?\n(?=[A-Za-z_][\w-]*:)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

// Removes only the YAML frontmatter block, keeping everything else (including comments) intact.
// Used where the markdown is served as-is, e.g. the web edition's raw help page.
export function stripFrontmatter(markdown) {
    if (typeof markdown !== 'string') return '';
    return markdown.replace(frontmatterPattern, '$1');
}

// Everything the in-app guide renderer wants removed before rendering: carriage returns, the
// frontmatter block and every HTML comment.
export function prepareGuideMarkdown(markdown) {
    return stripFrontmatter(markdown)
        .replace(/\r/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}
