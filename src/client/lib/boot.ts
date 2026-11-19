
export function dismissBootScreen(): void {
  const boot = document.getElementById('boot')
  if (!boot) return
  performance.mark('inkstone:boot-dismissed')
  boot.classList.add('done')
  window.setTimeout(() => boot.remove(), 400)
}
