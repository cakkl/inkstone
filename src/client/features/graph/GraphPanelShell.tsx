import { createPortal } from 'react-dom';
import { LoadingBlock } from '../../components/feedback';
import { OverlayHeader } from '../../components/overlay-header';
import { useEscape } from '../../components/overlay';
import { t } from '../../lib/i18n';

/** chunk 未就绪时的图谱外壳，避免点击后毫无反馈。 */
export function GraphPanelShell({ onClose }: {
    onClose: () => void;
}) {
    useEscape(true, onClose);
    return createPortal(<div role="dialog" aria-modal="true" aria-label={t('common.graph')}
      className="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none md:py-0">
      <OverlayHeader title={t('common.graph')} onClose={onClose}/>
      <div className="min-h-0 flex-1">
        <LoadingBlock label={t('graph.building_graph')}/>
      </div>
    </div>, document.body);
}
