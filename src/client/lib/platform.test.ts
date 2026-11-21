import { afterEach, describe, expect, it } from 'vitest'
import { isIosTouch } from './platform'

function setAgent(userAgent: string, maxTouchPoints = 0) {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
}

afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).userAgent
    delete (navigator as unknown as Record<string, unknown>).maxTouchPoints
})

describe('isIosTouch', () => {
    it('识别 iPhone', () => {
        setAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')
        expect(isIosTouch()).toBe(true)
    })

    it('识别经典 iPad UA', () => {
        setAgent('Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15')
        expect(isIosTouch()).toBe(true)
    })

    it('识别 iPadOS 的桌面版 UA（Macintosh + 多点触控）', () => {
        setAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5)
        expect(isIosTouch()).toBe(true)
    })

    it('真正的 Mac 不算', () => {
        setAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0)
        expect(isIosTouch()).toBe(false)
    })

    it('安卓与桌面浏览器不算', () => {
        setAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 5)
        expect(isIosTouch()).toBe(false)
        setAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
        expect(isIosTouch()).toBe(false)
    })
})
