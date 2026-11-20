import type { ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { cn } from '../lib/cn'
import { IconButton } from './primitives'
import { Tooltip } from './overlay'
import { t } from '../lib/i18n'

/**
 * 面板头部两个形态，同一形态下尺寸与位置必须完全一致：
 * - `close`：桌面浮层 —— `h-12`、`px-4 md:px-5`、右上 `X` 15
 * - `back`：移动端进入式页面 —— `h-11`、`px-3`、左上 `ArrowLeft` 16
 */
export function OverlayHeader({ variant = 'close', title, titleId, summary, children, onClose, className }: {
    variant?: 'close' | 'back'
    title: string
    titleId?: string
    /** 标题旁的灰字摘要（如图谱的节点/链接计数） */
    summary?: ReactNode
    /** back 形态放在标题右侧、close 形态放在关闭按钮左侧的工具区 */
    children?: ReactNode
    onClose: () => void
    className?: string
}) {
    const back = variant === 'back'
    return (
        <header className={cn('flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)]',
            back ? 'h-11 px-3' : 'h-12 px-4 md:px-5', className)}>
            {back && (<Tooltip label={t('common.back')} side="right">
                <IconButton label={t('common.back')} size="sm" onClick={onClose}>
                    <ArrowLeft size={16}/>
                </IconButton>
            </Tooltip>)}
            <div className={cn('flex min-w-0 items-baseline gap-2.5', !children && 'flex-1')}>
                <h2 id={titleId} className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.014em]">{title}</h2>
                {summary && <span className="whitespace-nowrap text-[11.5px] text-[var(--text-quaternary)]">{summary}</span>}
            </div>
            {children && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
            {!back && (<Tooltip label={t('common.close')} combo="escape" side="left">
                <IconButton label={t('common.close')} size="sm" onClick={onClose}>
                    <X size={15}/>
                </IconButton>
            </Tooltip>)}
        </header>
    )
}
