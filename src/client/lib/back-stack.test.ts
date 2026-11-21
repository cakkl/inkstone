import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    canGoBack,
    pushBackLayer,
    removeBackLayer,
    requestBack,
    resetBackStack,
} from './back-stack';

beforeEach(() => {
    vi.useRealTimers();
    resetBackStack();
    window.history.replaceState(null, '');
});

afterEach(() => {
    resetBackStack();
    vi.restoreAllMocks();
});

describe('back stack', () => {
    it('pushes a history entry per layer and reports it can go back', () => {
        expect(canGoBack()).toBe(false);
        pushBackLayer('note', () => {});
        expect(canGoBack()).toBe(true);
        expect(typeof (window.history.state as { inkstoneBack?: unknown }).inkstoneBack).toBe('string');
    });

    it('treats the same key as one layer', async () => {
        const first = vi.fn();
        const second = vi.fn();
        pushBackLayer('note', first);
        pushBackLayer('note', second);
        requestBack();
        await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
        expect(first).not.toHaveBeenCalled();
        expect(canGoBack()).toBe(false);
    });

    it('pops the newest layer first', async () => {
        const note = vi.fn();
        const panel = vi.fn();
        pushBackLayer('note', note);
        pushBackLayer('panel', panel);
        requestBack();
        await vi.waitFor(() => expect(panel).toHaveBeenCalledTimes(1));
        expect(note).not.toHaveBeenCalled();
        expect(canGoBack()).toBe(true);
    });

    it('clears the history marker when a layer is removed', () => {
        pushBackLayer('note', () => {});
        removeBackLayer('note');
        expect(canGoBack()).toBe(false);
        expect((window.history.state as { inkstoneBack?: unknown } | null)?.inkstoneBack ?? null).toBeNull();
    });

    it('runs the handler on a system back even after the marker was cleared', async () => {
        const handler = vi.fn();
        pushBackLayer('note', handler);
        window.history.replaceState({ ...(window.history.state ?? {}), inkstoneBack: null }, '');
        requestBack();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    });

    it('does not add an extra history entry when closing a layer', async () => {
        // 截断前进栈只能在当前位置再 push 一条，会让「返回退出」的次数随关面板累加；
        // 这条断言锁住「关层不额外写历史」。
        const before = window.history.length;
        const handler = vi.fn();
        pushBackLayer('note', handler);
        requestBack();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        expect(window.history.length).toBe(before + 1);
        expect(canGoBack()).toBe(false);
    });

    it('reports code-driven back as not from gesture', async () => {
        const handler = vi.fn();
        pushBackLayer('note', handler);
        requestBack();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        expect(handler).toHaveBeenCalledWith(false);
    });

    it('reports browser back as from gesture', async () => {
        const handler = vi.fn();
        pushBackLayer('note', handler);
        window.history.back();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        expect(handler).toHaveBeenCalledWith(true);
    });
});
