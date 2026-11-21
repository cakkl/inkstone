/**
 * 存 IANA 名称而不是偏移量，夏令时由 `Intl` 在运行时解析。
 */

/** 拿不到或为 UTC 时返回空串（服务端按 UTC 处理）。 */
export function detectedTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    return zone === 'UTC' ? '' : zone
  } catch {
    return ''
  }
}

/**
 * 只在变化时写：用户换时区（出差、改系统设置）后窗口才不会按旧时区算。
 */
export function shouldUpdateTimezone(stored: string | null | undefined, detected: string): boolean {
  if (!detected) return false
  return (stored ?? '') !== detected
}
