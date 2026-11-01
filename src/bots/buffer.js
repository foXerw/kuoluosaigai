// 每 bot 一个的房间消息环形缓冲（ContextBuffer）。
// 纯 ESM 模块，不依赖 Vue。内部用变长数组 + splice 做尾部淘汰：push 超 max 时
// splice(0, len - max) 裁掉最旧帧。all() / recent(n) 统一返回浅拷贝——与 roomCache
// "get 返回内部引用"刻意不同，因为观战窗是长命视图、LLM 上下文读取方也不应意外污染
// 缓冲区数据源（B18：不 import roomCache；两者职责独立）。
// 消息帧视为不透明对象原样存储（共享引用），不深拷贝、不修改帧内容。

/**
 * 创建 ContextBuffer。
 * @param {{ max?: number }} [options]  max 最大帧数上限，默认 200
 * @returns {{
 *   push: (frame: object) => void,
 *   replace: (frames: object[]) => void,
 *   recent: (n?: number) => object[],
 *   all: () => object[],
 *   clear: () => void,
 *   get size: () => number,
 * }}
 */
export function createContextBuffer({ max = 200 } = {}) {
  const frames = []

  return {
    /** 推入一帧，超限自动丢弃最旧。 */
    push(frame) {
      frames.push(frame)
      if (frames.length > max) {
        frames.splice(0, frames.length - max)
      }
    },

    /** 替换全部内容，截断到 max。空数组 → 清空。 */
    replace(framesInput) {
      const src = Array.isArray(framesInput) ? framesInput : []
      frames.length = 0
      const keep = src.slice(-max)
      frames.push(...keep)
    },

    /** 返回末尾 n 帧的浅拷贝；省略 n 默认 40。不足则全量。 */
    recent(n = 40) {
      if (n >= frames.length) return frames.slice()
      return frames.slice(frames.length - n)
    },

    /** 返回全部帧的浅拷贝。 */
    all() {
      return frames.slice()
    },

    /** 清空所有帧。 */
    clear() {
      frames.length = 0
    },

    /** 当前帧数（getter）。 */
    get size() {
      return frames.length
    },
  }
}
