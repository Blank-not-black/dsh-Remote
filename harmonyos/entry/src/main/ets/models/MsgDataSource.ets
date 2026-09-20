/**
 * 聊天消息懒加载数据源：实现 IDataSource（官方 BasicDataSource 模式，
 * 见 harmonyos-guides/arkts-rendering-control-lazyforeach「设置数据源」），
 * 供 ChatView 的 LazyForEach 按需渲染长会话——替代全量 ForEach，
 * 长会话（几百条消息）下滚动/新增消息不再整表重建。
 *
 * 键值规则：type + seq（与原 ForEach 键值一致，seq 单调递增保证唯一）。
 * 更新策略：整表替换走 reload（切换会话/历史加载），追加走 add（实时消息），
 * 单条内容刷新（图片解码回填）走 change——键值不变时需换键才触发刷新，
 * 故 change 用 item.uiRev 参与键值（decodeImages 回填时递增）。
 */
import { ChatMessage } from './ChatMessage'

export class MsgDataSource implements IDataSource {
  private items: ChatMessage[] = []
  private listeners: DataChangeListener[] = []
  setAll(list: ChatMessage[]): void {
    this.items = list
    this.listeners.forEach((listener: DataChangeListener) => {
      listener.onDataReloaded()
    })
  }

  /** 追加一条（实时事件），触发局部 add */
  append(item: ChatMessage): void {
    this.items.push(item)
    const idx = this.items.length - 1
    this.listeners.forEach((listener: DataChangeListener) => {
      listener.onDataAdd(idx)
    })
  }

  /** 单条内容变化（uiRev 已递增）时通知刷新该索引 */
  change(item: ChatMessage): void {
    const idx = this.items.indexOf(item)
    if (idx >= 0) {
      this.listeners.forEach((listener: DataChangeListener) => {
        listener.onDataChange(idx)
      })
    }
  }

  totalCount(): number {
    return this.items.length
  }

  getData(index: number): ChatMessage {
    return this.items[index]
  }

  /** LazyForEach 键值：type+seq+uiRev（uiRev 递增以触发不可变内容刷新） */
  keyOf(item: ChatMessage): string {
    return item.type + '-' + item.seq.toString() + '-' + item.uiRev.toString()
  }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener)
    }
  }

  unregisterDataChangeListener(listener: DataChangeListener): void {
    const pos = this.listeners.indexOf(listener)
    if (pos >= 0) {
      this.listeners.splice(pos, 1)
    }
  }
}
