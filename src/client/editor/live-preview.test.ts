import { describe, expect, it } from 'vitest';
import { renderMarkdownBlocks } from '../lib/markdown/renderer';
import { mergeSettings, mergeSettingsPatch } from '@shared/constants';
import { shiftBlockLineNumbers } from './live-preview';

describe('shiftBlockLineNumbers', () => {
    it('shifts data-line, data-task-line and data-code-start together', () => {
        const html = '<div class="code-block" data-line="10" data-code-start="11"><span data-task-line="12"></span></div>';
        const shifted = shiftBlockLineNumbers(html, 3);
        expect(shifted).toContain('data-line="13"');
        expect(shifted).toContain('data-code-start="14"');
        expect(shifted).toContain('data-task-line="15"');
    });

    it('is a no-op for delta 0', () => {
        const html = '<p data-line="5">x</p>';
        expect(shiftBlockLineNumbers(html, 0)).toBe(html);
    });

    it('handles negative deltas (deleting lines above a block)', () => {
        const html = '<div class="code-block" data-line="10" data-code-start="11"></div>';
        const shifted = shiftBlockLineNumbers(html, -4);
        expect(shifted).toContain('data-line="6"');
        expect(shifted).toContain('data-code-start="7"');
    });

    it('leaves unrelated attributes untouched', () => {
        const html = '<div data-lang="js" data-line-numbers="true" data-line="2"></div>';
        const shifted = shiftBlockLineNumbers(html, 1);
        expect(shifted).toContain('data-lang="js"');
        expect(shifted).toContain('data-line-numbers="true"');
        expect(shifted).toContain('data-line="3"');
    });

    it('covers the real renderer output, whose code blocks carry data-code-start', () => {
        const { blocks } = renderMarkdownBlocks('```js\nconst a = 1\n```');
        const html = blocks[0]!.html;
        expect(html).toContain('data-code-start=');
        expect(shiftBlockLineNumbers(html, 2)).toContain('data-code-start="3"');
    });
});

describe('live preview Markdown compatibility', () => {
    it('defaults to live rendering and preserves an explicit opt-out across settings updates', () => {
        expect(mergeSettings({}).editor.livePreview).toBe(true);
        expect(mergeSettings({ editor: { livePreview: 'false' } }).editor.livePreview).toBe(true);
        const settings = mergeSettings({ editor: { livePreview: false } });
        expect(settings.editor.livePreview).toBe(false);
        expect(mergeSettingsPatch(settings, { editor: { fontSize: 18 }, preview: { layout: 'split' } }).editor.livePreview).toBe(false);
    });
    it('migrates old layouts while preserving split and unrelated settings', () => {
        for (const layout of ['edit', 'live']) {
            const settings = mergeSettings({ preview: { layout, math: false }, editor: { tabSize: 4 } });
            expect(settings.preview.layout).toBe('live');
            expect(settings.preview.math).toBe(false);
            expect(settings.editor.tabSize).toBe(4);
        }
        for (const layout of ['split', 'preview']) expect(mergeSettings({ preview: { layout } }).preview.layout).toBe(layout);
    });
    it('retains document-wide references and source lines across nested blocks', () => {
        const source = '# Heading\n\n[Reference][ref]\n\n- [ ] one\n  - [x] two\n\n| A | B |\n| - | - |\n| C | D |\n\n[ref]: https://example.com';
        const { blocks, headings } = renderMarkdownBlocks(source);
        expect(blocks.map((block) => [block.startLine, block.endLine])).toEqual([[0, 1], [2, 3], [4, 7], [7, 10]]);
        expect(blocks[1]!.html).toContain('href="https://example.com"');
        expect(blocks[2]!.html).toContain('data-task-line="4"');
        expect(blocks[2]!.html).toContain('data-task-line="5"');
        expect(blocks[3]!.html).toContain('<table');
        expect(headings[0]?.line).toBe(0);
    });
    it('keeps sanitization and comments source mapping intact', () => {
        const { blocks } = renderMarkdownBlocks('%% SECRET_COMMENT %%\n\n# Visible\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>');
        const html = blocks.map((block) => block.html).join('');
        expect(html).not.toContain('onerror');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('SECRET_COMMENT');
        expect(blocks.find((block) => block.html.includes('Visible'))?.startLine).toBe(2);
    });
});
