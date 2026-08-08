/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { EditorView } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const defaultThemeId = 'konjugateDark';

// Each preset supplies both the editor chrome colors (background, gutter, caret, selection)
// and the syntax token colors, so switching presets always yields one coherent theme rather
// than mixing a custom chrome with CodeMirror's theme-agnostic default token colors.
export const themePresets = {
    konjugateDark: {
        label: 'Konjugate Dark',
        chrome: {
            background: '#09131b', foreground: '#c7d4d9', gutterBackground: '#081119', gutterForeground: '#4c6069',
            caret: '#6ce0d5', selection: 'rgb(66 201 188 / 22%)', activeLine: 'rgb(66 201 188 / 4%)', activeLineGutter: 'rgb(66 201 188 / 6%)'
        },
        tokens: {
            comment: '#5b7285', keyword: '#c090e0', string: '#dfae6b', number: '#6ce0d5',
            function: '#6cb6e0', typeName: '#7fd9a8', operator: '#8fa5b0', invalid: '#e0838a'
        }
    },
    oneDark: {
        label: 'One Dark',
        chrome: {
            background: '#282c34', foreground: '#abb2bf', gutterBackground: '#252931', gutterForeground: '#636d83',
            caret: '#528bff', selection: 'rgb(82 139 255 / 25%)', activeLine: 'rgb(255 255 255 / 4%)', activeLineGutter: 'rgb(255 255 255 / 6%)'
        },
        tokens: {
            comment: '#5c6370', keyword: '#c678dd', string: '#98c379', number: '#d19a66',
            function: '#61afef', typeName: '#e5c07b', operator: '#abb2bf', invalid: '#e06c75'
        }
    },
    solarizedDark: {
        label: 'Solarized Dark',
        chrome: {
            background: '#002b36', foreground: '#93a1a1', gutterBackground: '#00252e', gutterForeground: '#586e75',
            caret: '#839496', selection: 'rgb(38 139 210 / 25%)', activeLine: 'rgb(255 255 255 / 4%)', activeLineGutter: 'rgb(255 255 255 / 6%)'
        },
        tokens: {
            comment: '#586e75', keyword: '#859900', string: '#2aa198', number: '#d33682',
            function: '#268bd2', typeName: '#b58900', operator: '#93a1a1', invalid: '#dc322f'
        }
    }
};

export const customThemeFields = ['background', 'foreground', 'gutterBackground', 'gutterForeground', 'caret'];
export const customTokenFields = ['comment', 'keyword', 'string', 'number', 'function', 'typeName'];

// A user-edited theme only exposes the fields plain <input type="color"> can drive; derived
// chrome values (selection/active-line tints) stay pinned to the accent so a fresh custom
// theme still looks coherent before every field has been touched.
export function themeFromCustomColors(colors, base = themePresets[defaultThemeId]) {
    const accent = colors.caret ?? base.chrome.caret;
    return {
        label: 'Custom',
        chrome: {
            background: colors.background ?? base.chrome.background,
            foreground: colors.foreground ?? base.chrome.foreground,
            gutterBackground: colors.gutterBackground ?? base.chrome.gutterBackground,
            gutterForeground: colors.gutterForeground ?? base.chrome.gutterForeground,
            caret: accent,
            selection: `${accent}38`,
            activeLine: `${accent}0a`,
            activeLineGutter: `${accent}12`
        },
        tokens: {
            comment: colors.comment ?? base.tokens.comment,
            keyword: colors.keyword ?? base.tokens.keyword,
            string: colors.string ?? base.tokens.string,
            number: colors.number ?? base.tokens.number,
            function: colors.function ?? base.tokens.function,
            typeName: colors.typeName ?? base.tokens.typeName,
            operator: base.tokens.operator,
            invalid: base.tokens.invalid
        }
    };
}

export function buildThemeExtensions(theme) {
    const chromeTheme = EditorView.theme({
        '&': { color: theme.chrome.foreground, backgroundColor: theme.chrome.background, height: '100%' },
        '.cm-content': { caretColor: theme.chrome.caret },
        '.cm-cursor': { borderLeftColor: theme.chrome.caret },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: theme.chrome.selection },
        '.cm-gutters': { color: theme.chrome.gutterForeground, backgroundColor: theme.chrome.gutterBackground, border: 'none' },
        '.cm-activeLine': { backgroundColor: theme.chrome.activeLine },
        '.cm-activeLineGutter': { backgroundColor: theme.chrome.activeLineGutter }
    }, { dark: true });

    const highlightStyle = HighlightStyle.define([
        { tag: t.comment, color: theme.tokens.comment, fontStyle: 'italic' },
        { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.self], color: theme.tokens.keyword },
        { tag: [t.string, t.special(t.string), t.regexp], color: theme.tokens.string },
        { tag: [t.number, t.bool, t.null, t.atom], color: theme.tokens.number },
        { tag: [t.function(t.variableName), t.function(t.propertyName)], color: theme.tokens.function },
        { tag: [t.typeName, t.className, t.namespace], color: theme.tokens.typeName },
        { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator], color: theme.tokens.operator },
        { tag: t.invalid, color: theme.tokens.invalid }
    ]);

    return [chromeTheme, syntaxHighlighting(highlightStyle)];
}
