/**
 * 本工具的全部共享类型定义。
 * @module dsh-clean-sessions/types
 */

import type { MessageKey } from './i18n.ts'

/** 支持的语言,CLI 与 README 均以中英双语提供。 */
export type Language = 'zh' | 'en'

/** 语言选项:auto 表示按主机语言自动检测,中文简繁归为 zh,其余归为 en。 */
export type LanguageChoice = Language | 'auto'

/** 命令行选项,由参数解析阶段填充,供主流程消费。 */
export interface CliOptions {
  /** 是否真正执行删除与配置更新,默认仅预览。 */
  apply: boolean
  /** 最近多少分钟内有写入的归档会话视为可能活跃,0 表示不启用守卫。 */
  minAgeMinutes: number
  /** 是否强制纳入最近有写入的归档会话,默认排除。 */
  includeRecent: boolean
  /** 是否只删除归档名单内的会话,默认继续级联删除子代理后代。 */
  keepChildren: boolean
  /** 是否跳过附件对象回收,默认回收只被待删会话引用的对象。 */
  keepAttachments: boolean
  /** 会话目录的备份目标,缺省时直接删除。 */
  backupDir?: string
  /** 是否同步 workspace.json 配置,默认同步。 */
  updateConfig: boolean
  /** 会话根目录缺失或不可用时是否继续执行,默认终止。 */
  allowMissingSessions: boolean
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

/** 面向用户的阻止原因,key 由消息字典渲染,params 为占位符取值。 */
export interface BlockedReason {
  key: MessageKey
  params: Record<string, string | number>
}

/** 单个归档会话的清理计划项。 */
export interface SessionPlan {
  id: string
  location?: SessionLocation
  /** 会话目录内全部文件的总字节数,null 表示目录不可读、大小未知。 */
  sizeBytes: number | null
  recent: boolean
  state: 'exists' | 'ghost'
  /** 后代由级联纳入删除时记录其直接父会话 id,用于在预览中标注来源。 */
  cascadeSource?: string
  /** 被子代理后代阻止删除时的原因,仅 blocked 项携带。 */
  blockedReason?: BlockedReason
}

/** 全部归档会话的清理计划,按磁盘状态、活跃度与子代理关系处置归类。 */
export interface CleanPlan {
  toDelete: SessionPlan[]
  /** 待删会话衍生的子代理后代,随其父会话一并删除。 */
  cascade: SessionPlan[]
  /** 因后代无法安全处理而本次保留的归档会话,不进入删除集合。 */
  blocked: SessionPlan[]
  recentExcluded: SessionPlan[]
  ghosts: SessionPlan[]
  unsafe: SessionPlan[]
  /** 子代理关系扫描的诊断信息,例如日志不可读导致父子关系无法确认。 */
  cascadeWarnings: string[]
}

/** workspace.json 的持久化结构,字段与 workspace 域 schema 保持一致。 */
export interface WorkspaceState {
  unit: { name: string; version: number }
  global: {
    initialized: boolean
    workspaceIds: string[]
    archivedSessionIds?: string[]
    pinnedSessionIds?: string[]
    defaultWorkspaceId?: string
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
  /** 跳过附件对象回收,缺省或 false 表示执行回收。 */
  keepAttachments?: boolean
}

/** 附件对象回收的结果汇总,单项失败不改变会话删除的既有结果。 */
export interface AttachmentReclaimOutcome {
  /** 实际移除或移入备份的对象数量。 */
  removedCount: number
  /** 实际移除或移入备份的对象字节数。 */
  removedBytes: number
  /** 整体跳过回收的原因,undefined 表示已尝试回收。 */
  skippedReason?: string
  /** 单项移除失败的描述。 */
  failures: string[]
}

/** applyClean 的执行结果,失败项以列表形式返回而非中断整体流程。 */
export interface ApplyOutcome {
  removedCount: number
  /** 其中由子代理级联纳入并成功移除的数量。 */
  cascadeRemovedCount: number
  failures: string[]
  cleanedCacheCount: number
  emptiedProjects: string[]
  configResult?: ConfigUpdateResult
  /** 配置同步失败的错误描述,undefined 表示同步成功或已跳过。 */
  configError?: string
  /** 附件对象回收结果,undefined 表示按 --keep-attachments 跳过或本次无需回收。 */
  attachments?: AttachmentReclaimOutcome
}
