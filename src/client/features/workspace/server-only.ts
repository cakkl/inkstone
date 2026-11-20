/**
 * 移动端菜单没有悬停提示的位置，禁用项点了毫无反馈。这里只承载移动端语义：
 * 有阻塞理由就提示一次，否则执行动作；桌面端仍用禁用 + tooltip。
 */
export function runServerOnly(reason: string | null, notify: (title: string) => void, run: () => void): void {
    if (reason) {
        notify(reason);
        return;
    }
    run();
}
