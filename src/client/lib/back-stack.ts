import { useEffect, useRef } from 'react'

interface BackLayer {
  key: string
  token: string
  handler: (fromGesture: boolean) => void
}

const TOKEN_FIELD = 'inkstoneBack'
const BACK_SETTLE_MS = 800
const layers: BackLayer[] = []
let sequence = 0
let listening = false
let backPending = false

function readToken(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const token = (state as Record<string, unknown>)[TOKEN_FIELD]
  return typeof token === 'string' ? token : null
}

function currentToken(): string | null {
  return readToken(window.history.state)
}

function onPopState(event: PopStateEvent): void {
  // backPending 为真说明是代码自己调的 history.back()；否则来自系统返回手势。
  const fromGesture = !backPending
  backPending = false
  const target = readToken(event.state)
  let left: BackLayer | undefined
  while (layers.length && layers[layers.length - 1]!.token !== target) left = layers.pop()
  left?.handler(fromGesture)
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('popstate', onPopState)
}

export function pushBackLayer(key: string, handler: (fromGesture: boolean) => void): void {
  listen()
  const existing = layers.find((layer) => layer.key === key)
  if (existing) {
    existing.handler = handler
    return
  }
  const token = `${key}#${++sequence}`
  layers.push({ key, token, handler })
  window.history.pushState({ ...(window.history.state ?? {}), [TOKEN_FIELD]: token }, '')
}

export function removeBackLayer(key: string): void {
  const index = layers.findIndex((layer) => layer.key === key)
  if (index < 0) return
  const [layer] = layers.splice(index, 1)
  if (layer && currentToken() === layer.token) {
    window.history.replaceState({ ...(window.history.state ?? {}), [TOKEN_FIELD]: null }, '')
  }
}

export function canGoBack(): boolean {
  return layers.length > 0
}

export function requestBack(): boolean {
  const top = layers[layers.length - 1]
  if (!top || backPending) return false
  if (currentToken() === top.token) {
    backPending = true
    window.setTimeout(() => {
      backPending = false
    }, BACK_SETTLE_MS)
    window.history.back()
    return true
  }
  layers.pop()
  top.handler(false)
  return true
}

export function resetBackStack(): void {
  layers.length = 0
  backPending = false
  if (typeof window !== 'undefined' && readToken(window.history.state) !== null) {
    window.history.replaceState({ ...(window.history.state ?? {}), [TOKEN_FIELD]: null }, '')
  }
}

export function useBackLayer(active: boolean, key: string, handler: (fromGesture: boolean) => void): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })
  useEffect(() => {
    if (!active) {
      removeBackLayer(key)
      return
    }
    pushBackLayer(key, (fromGesture) => handlerRef.current(fromGesture))
    return () => removeBackLayer(key)
  }, [active, key])
}
