/**
 * 本工具的全部共享类型定义。
 * @module dsh-clean-sessions/types
 */

/** 支持的语言,CLI 与 README 均以中英双语提供。 */
export type Language = 'zh' | 'en'

/** 语言选项:auto 表示按主机语言自动检测,中文简繁归为 zh,其余归为 en。 */
export type LanguageChoice = Language | 'auto'

/** 命令行选项,由参数解析阶段填充,供主流程消费。 */
export interface CliOptions {
  /** 是否真正执行删除与配置更新,默认仅预览。 */
  apply: boolean
  /** 是否跳过删除前的确认提示,仅配合 apply 使用。 */
  yes: boolean
  /** 最近多少分钟内有写入的归档会话视为可能活跃,0 表示不启用守卫。 */
  minAgeMinutes: number
  /** 是否强制纳入最近有写入的归档会话,默认排除。 */
  includeRecent: boolean
  /** 会话目录的备份目标,缺省时直接删除。 */
  backupDir?: string
  /** 是否同步 workspace.json 配置,默认同步。 */
  updateConfig: boolean
  /** DSH 主目录,默认来自 DSH_HOME 或用户主目录下的 .dsh。 */
  dshHome: string
  /** 是否只输出帮助文本。 */
  help: boolean
  /** 是否只输出版本号。 */
  version: boolean
  /** 提示信息语言,auto 表示按主机语言自动检测。 */
  lang: LanguageChoice
}

/** 会话在磁盘上的定位结果:会话目录与所属项目分组目录名。 */
export interface SessionLocation {
  dir: string
  projectDir: string
}

/** 单个归档会话的清理计划项。 */
export interface SessionPlan {
  id: string
  location?: SessionLocation
  /** 会话目录内全部文件的总字节数,null 表示目录不可读、大小未知。 */
  sizeBytes: number | null
  recent: boolean
  state: 'exists' | 'ghost'
}

/** 全部归档会话的清理计划,按磁盘状态与活跃度归类。 */
export interface CleanPlan {
  toDelete: SessionPlan[]
  recentExcluded: SessionPlan[]
  ghosts: SessionPlan[]
  unsafe: SessionPlan[]
}

/** workspace.json 的持久化结构,字段与 workspace 域 schema 保持一致。 */
export interface WorkspaceState {
  unit: { name: string; version: number }
  global: {
    initialized: boolean
    workspaceIds: string[]
    archivedSessionIds?: string[]
    pendingMutation?: unknown
  }
  tables: {
    workspaces: Record<string, {
      path: string
      title: string
      sessionIds: string[]
      createdAt: string
      updatedAt: string
    }>
  }
}

/** 配置同步的结果汇总,供主流程打印与判断。 */
export interface ConfigUpdateResult {
  archivedKept: number
  slotsRemoved: number
}

/** applyClean 的执行选项。 */
export interface ApplyOptions {
  backupDir?: string
  updateConfig: boolean
}

/** applyClean 的执行结果,失败项以列表形式返回而非中断整体流程。 */
export interface ApplyOutcome {
  removedCount: number
  failures: string[]
  cleanedCacheCount: number
  emptiedProjects: string[]
  configResult?: ConfigUpdateResult
  /** 配置同步失败的错误描述,undefined 表示同步成功或已跳过。 */
  configError?: string
}
