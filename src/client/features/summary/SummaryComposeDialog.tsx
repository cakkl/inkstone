import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Textarea } from '../../components/form'

type Mode = 'fresh' | 'refine'

/** 智能生成弹窗：输入补充要求，再选择补充或重新生成。 */
export function SummaryComposeDialog({ open, onClose, hasSummary, disabled, onGenerate }: {
  open: boolean
  onClose: () => void
  /** 没有现有摘要时无法「补充」，只能重新生成。 */
  hasSummary: boolean
  disabled?: boolean
  onGenerate: (mode: Mode, instruction?: string) => Promise<void>
}) {
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState<Mode | null>(null)

  useEffect(() => {
    if (!open) {
      setInstruction('')
      setBusy(null)
    }
  }, [open])

  const run = async (mode: Mode) => {
    if (busy) return
    setBusy(mode)
    try {
      await onGenerate(mode, mode === 'refine' ? instruction.trim() : undefined)
    } finally {
      setBusy(null)
    }
  }

  const blocked = disabled || busy !== null
  const text = instruction.trim()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('summary.smart_generate')}
      description={hasSummary ? t('summary.compose_hint') : t('summary.compose_hint_fresh')}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        <Textarea
          value={instruction}
          rows={3}
          maxLength={500}
          autoFocus
          placeholder={t('summary.compose_placeholder')}
          disabled={blocked}
          onChange={(event) => setInstruction(event.target.value)}
          aria-label={t('summary.compose_placeholder')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<Sparkles size={12} />}
            loading={busy === 'refine'}
            disabled={blocked || !hasSummary || !text}
            onClick={() => void run('refine')}
          >
            {t('summary.compose_refine')}
          </Button>
          <Button
            variant="ghost"
            title={text ? t('summary.compose_fresh_hint') : undefined}
            loading={busy === 'fresh'}
            disabled={blocked}
            onClick={() => void run('fresh')}
          >
            {t('summary.compose_fresh')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
