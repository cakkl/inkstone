import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from '../../components/primitives';
import { LoadingBlock } from '../../components/feedback';
import { Tooltip, useEscape } from '../../components/overlay';
import { t } from '../../lib/i18n';

/** chunk 未就绪时的图谱外壳，避免点击后毫无反馈。 */
export function GraphPanelShell({ onClose }: {
    onClose: () => void;
}) {
    useEscape(true, onClose);
    return createPortal(<div role="dialog" aria-modal="true" aria-label={t('common.graph')}
      className="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none md:py-0">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4">
        <h2 className="text-[14px] font-semibold tracking-[-0.014em]">{t('common.graph')}</h2>
        <Tooltip label={t('common.close')} combo="escape" side="left">
          <IconButton label={t('common.close')} size="sm" onClick={onClose}>
            <X size={15}/>
          </IconButton>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1">
        <LoadingBlock label={t('graph.building_graph')}/>
      </div>
    </div>, document.body);
}
