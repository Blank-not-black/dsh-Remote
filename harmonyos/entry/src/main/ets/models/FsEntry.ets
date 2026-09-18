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

  /** 修改时间（列表副行展示）：今年省略年份，与系统文件管理器惯例一致 */
  mtimeLabel(): string {
    if (this.mtimeMs <= 0) {
      return ''
    }
    const d = new Date(this.mtimeMs)
    const now = new Date()
    const pad = (n: number): string => n < 10 ? '0' + n : String(n)
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    if (d.getFullYear() === now.getFullYear()) {
      return (d.getMonth() + 1).toString() + '-' + d.getDate().toString() + ' ' + hm
    }
    return d.getFullYear().toString() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  /**
   * 按扩展名判断是否可走 /fs/preview 文本预览。
   * 白名单与网关 FS_PREVIEW_EXTENSIONS（gateway.js）逐项对齐——两端不一致时
   * 会出现"点进预览才报 415"或"可预览文件被误判为只可另存"。
   * 特例：无扩展名的 dockerfile 网关按 '.dockerfile' 放行，这里按文件名判断。
   */
  previewable(): boolean {
    if (this.isDir()) {
      return false
    }
    const name = this.name.toLowerCase()
    if (name === 'dockerfile') {
      return true
    }
    const dot = name.lastIndexOf('.')
    if (dot < 0) {
      return false
    }
    const ext = name.substring(dot)
    return ['.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.jsx',
      '.ts', '.tsx', '.py', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
      '.ini', '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.sql', '.java', '.kt',
      '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.vue',
      '.svelte', '.gradle', '.properties', '.gitignore', '.dockerfile'].indexOf(ext) >= 0
  }
}