/**
 * iOS / iPadOS 触摸设备。iOS 13+ 的 iPad 默认报 `Macintosh` UA，靠触点数区分；
 * `navigator.platform` 已被冻结，统一读 UA。
 */
export function isIosTouch(): boolean {
    if (typeof navigator === 'undefined') return false
    const agent = navigator.userAgent || ''
    if (/iPhone|iPad|iPod/i.test(agent)) return true
    return /Macintosh/i.test(agent) && (navigator.maxTouchPoints ?? 0) > 1
}
