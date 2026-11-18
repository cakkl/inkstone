// Node 22+ 内置实验性 Web Storage：未传 --localstorage-file 时
// globalThis.localStorage 是值为 undefined 的 getter，会遮蔽 jsdom 提供的实现。
// 这里补一个内存实现，保证 jsdom 环境下的测试能拿到可用的 localStorage。
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(String(key)) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(String(key)),
    setItem: (key, value) => void store.set(String(key), String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  })
}
