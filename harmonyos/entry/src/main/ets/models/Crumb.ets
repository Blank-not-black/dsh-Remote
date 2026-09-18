/**
 * 文件页面包屑段（FilesPage.crumbs 使用）：显示名 + 可跳转的完整路径。
 */
export class Crumb {
  label: string
  path: string

  constructor(label: string, path: string) {
    this.label = label
    this.path = path
  }
}
