/**
 * 文件系统条目（/fs/list 响应项）。
 */
export class FsEntry {
  type: string
  name: string
  path: string
  size: number
  mtimeMs: number

  constructor(type: string, name: string, path: string, size: number, mtimeMs: number) {
    this.type = type
    this.name = name
    this.path = path
    this.size = size
    this.mtimeMs = mtimeMs
  }

  isDir(): boolean {
    return this.type === 'dir'
  }

  static fromRecord(r: Record<string, Object>): FsEntry {
    return new FsEntry(
      String(r['type'] ?? 'file'),
      String(r['name'] ?? ''),
      String(r['path'] ?? ''),
      Number(r['size'] ?? 0),
      Number(r['mtimeMs'] ?? 0)
    )
  }

  sizeLabel(): string {
    if (this.isDir()) {
      return '目录'
    }
    const n = this.size
    if (n >= 1024 * 1024 * 1024) {
      return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    }
    if (n >= 1024 * 1024) {
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }
    if (n >= 1024) {
      return (n / 1024).toFixed(1) + ' KB'
    }
    return n.toString() + ' B'
  }
}