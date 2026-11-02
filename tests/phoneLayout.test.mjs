/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { phoneMaxHeight, phoneMaxWidth, phoneMediaQuery } from '../src/renderer/phoneLayout.mjs';
import { fitPlotToNarrowScreen, isNarrowPlot } from '../src/renderer/resultPlot.mjs';

test('the phone media query names the same sizes as the style sheet\'s phone blocks', async () => {
    const css = await readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    assert.match(phoneMediaQuery, new RegExp(`max-width: ${phoneMaxWidth}px`));
    assert.match(phoneMediaQuery, new RegExp(`max-height: ${phoneMaxHeight}px`));
    // Every media rule that makes a layout a phone's names both of its ways to be one, with the same numbers.
    const phoneRules = css.match(/@media [^{]*\(max-width: \d+px\)[^{]*\(pointer: coarse\) and \(max-height: \d+px\)[^{]*\{/g) ?? [];
    assert.ok(phoneRules.length >= 3);
    for (const rule of phoneRules) {
        assert.match(rule, new RegExp(`\\(max-width: ${phoneMaxWidth}px\\)`));
        assert.match(rule, new RegExp(`\\(max-height: ${phoneMaxHeight}px\\)`));
    }
    // The touch-sized controls are for what is not a phone's layout, by the same bounds.
    assert.match(css, new RegExp(`@media \\(pointer: coarse\\) and \\(min-width: ${phoneMaxWidth + 1}px\\) and \\(min-height: ${phoneMaxHeight + 1}px\\)`));
});

test('a plot is narrow below 460 pixels, and its layout then drops the legend, the toolbar and the extra axes\' labels', () => {
    assert.equal(isNarrowPlot({ clientWidth: 300 }), true);
    assert.equal(isNarrowPlot({ clientWidth: 700 }), false);
    const layout = { margin: { l: 48, r: 90, t: 42, b: 38 }, showlegend: true, yaxis: { title: 'm' }, yaxis2: { title: 'rad' }, yaxis3: { title: 'm/s' } };
    const config = { displayModeBar: true };
    fitPlotToNarrowScreen(layout, config);
    assert.equal(layout.showlegend, false);
    assert.equal(config.displayModeBar, false);
    assert.equal(layout.dragmode, 'pan');
    assert.equal(layout.yaxis.title, 'm');
    assert.equal(layout.yaxis2.showticklabels, false);
    assert.equal(layout.yaxis3.showticklabels, false);
    assert.equal(layout.margin.l, 48);
});
