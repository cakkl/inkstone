let warming: Promise<unknown> | null = null;

/** 提前取回图谱 chunk。 */
export function warmGraphPanel(): void {
    if (warming) return;
    warming = import('./GraphPanel').catch(() => {
        warming = null;
    });
}
