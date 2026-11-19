import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE_SWIPE_WIDTH, shouldCompleteSwipe, useEdgeSwipeBack, type EdgeSwipeOptions } from './edge-swipe';

const originalInnerWidth = window.innerWidth;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function fire(target: EventTarget, type: string, x: number, y: number, timeStamp: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    target.dispatchEvent(event);
}

function renderSwipe(enabled: boolean, onBack: () => void, options: EdgeSwipeOptions = {}) {
    function Harness() {
        const swipe = useEdgeSwipeBack(enabled, onBack, options);
        return createElement('div', { 'data-swipe': '', ...swipe, style: { height: '400px' } });
    }
    act(() => root.render(createElement(Harness)));
    return container.querySelector<HTMLElement>('[data-swipe]')!;
}

function swipeBy(element: HTMLElement, from: number, to: number) {
    fire(element, 'pointerdown', from, 200, 0);
    fire(element, 'pointermove', from + 40, 204, 40);
    fire(element, 'pointermove', to, 204, 360);
    fire(element, 'pointerup', to, 204, 400);
}

describe('edge swipe thresholds', () => {
    it('completes on distance or velocity', () => {
        expect(shouldCompleteSwipe({ distance: 119, width: 400, velocity: 0 })).toBe(false);
        expect(shouldCompleteSwipe({ distance: 120, width: 400, velocity: 0 })).toBe(true);
        expect(shouldCompleteSwipe({ distance: 20, width: 400, velocity: 0.5 })).toBe(true);
    });
});

describe('edge swipe gesture', () => {
    it('slides the layer and goes back past the distance threshold', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const element = renderSwipe(true, onBack);
        await act(async () => {
            fire(element, 'pointerdown', 10, 200, 0);
            fire(element, 'pointermove', 50, 204, 40);
            fire(element, 'pointermove', 300, 204, 360);
        });
        expect(element.style.transform).toBe('translateX(290px)');
        await act(async () => {
            fire(element, 'pointerup', 300, 204, 400);
            vi.advanceTimersByTime(200);
        });
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(element.style.transform).toBe('translateX(100%)');
    });

    it('springs back when the swipe is short', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const element = renderSwipe(true, onBack);
        await act(async () => {
            swipeBy(element, 10, 90);
            vi.advanceTimersByTime(200);
        });
        expect(onBack).not.toHaveBeenCalled();
        expect(element.style.transform).toBe('');
    });

    it('ignores swipes that start away from the edge', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const element = renderSwipe(true, onBack);
        await act(async () => {
            swipeBy(element, EDGE_SWIPE_WIDTH + 60, 380);
            vi.advanceTimersByTime(200);
        });
        expect(element.style.transform).toBe('');
        expect(onBack).not.toHaveBeenCalled();
    });

    it('reports when the layer is being dragged', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const states: boolean[] = [];
        const element = renderSwipe(true, onBack, { onDragChange: (dragging) => states.push(dragging) });
        await act(async () => {
            fire(element, 'pointerdown', 10, 200, 0);
            fire(element, 'pointermove', 50, 204, 40);
        });
        expect(states).toEqual([true]);
        await act(async () => {
            fire(element, 'pointerup', 60, 204, 80);
            vi.advanceTimersByTime(200);
        });
        expect(states).toEqual([true, false]);
        expect(onBack).not.toHaveBeenCalled();
    });

    it('reports the drag distance so the layer behind can follow', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const distances: number[] = [];
        const element = renderSwipe(true, onBack, { onDrag: (distance) => distances.push(distance) });
        await act(async () => {
            fire(element, 'pointerdown', 10, 200, 0);
            fire(element, 'pointermove', 50, 204, 40);
            fire(element, 'pointermove', 160, 204, 120);
        });
        expect(distances).toEqual([40, 150]);
    });

    it('reports whether the gesture will commit when released', async () => {
        vi.useFakeTimers();
        const commits: boolean[] = [];
        const element = renderSwipe(true, vi.fn(), { onDragEnd: (commit) => commits.push(commit) });
        await act(async () => {
            fire(element, 'pointerdown', 10, 200, 0);
            fire(element, 'pointermove', 50, 204, 40);
            fire(element, 'pointerup', 60, 204, 80);
            vi.advanceTimersByTime(200);
        });
        expect(commits).toEqual([false]);
        await act(async () => {
            fire(element, 'pointerdown', 10, 200, 0);
            fire(element, 'pointermove', 200, 204, 40);
            fire(element, 'pointerup', 300, 204, 400);
            vi.advanceTimersByTime(200);
        });
        expect(commits).toEqual([false, true]);
        expect(element.style.transform).toBe('translateX(100%)');
    });

    it('ignores vertical drags and disabled states', async () => {
        vi.useFakeTimers();
        const onBack = vi.fn();
        const element = renderSwipe(true, onBack);
        await act(async () => {
            fire(element, 'pointerdown', 10, 100, 0);
            fire(element, 'pointermove', 14, 260, 120);
            fire(element, 'pointerup', 14, 260, 200);
            vi.advanceTimersByTime(200);
        });
        expect(element.style.transform).toBe('');
        expect(onBack).not.toHaveBeenCalled();
        const disabled = renderSwipe(false, onBack);
        await act(async () => {
            swipeBy(disabled, 10, 380);
            vi.advanceTimersByTime(200);
        });
        expect(onBack).not.toHaveBeenCalled();
    });
});
