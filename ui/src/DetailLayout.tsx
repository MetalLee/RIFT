import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './components/ui/button';

/** Keep the list mounted so returning preserves filters and the selected row. */
export function DetailLayout({ className, list, children, initialDetail = false }: { initialDetail?: boolean; className: string; list: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => initialDetail && typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches);
  const panel = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  const origin = useRef<{ element: HTMLElement; scroll: number } | null>(null);
  useLayoutEffect(() => {
    if (open && origin.current) {
      panel.current?.focus({ preventScroll: true });
      panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    else if (origin.current?.element.isConnected) {
      origin.current.element.focus({ preventScroll: true });
      window.scrollTo({ top: origin.current.scroll, behavior: 'instant' });
    } else if (!open && returning.current) {
      panel.current?.parentElement?.querySelector<HTMLElement>('[data-detail-select][aria-pressed=true]')?.focus();
    }
    returning.current = false;
  }, [open]);
  return <div className={`${className} progressive-detail${open ? ' detail-open' : ''}`} onClickCapture={event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-detail-select]');
    if (row && window.matchMedia('(max-width: 1100px)').matches) {
      origin.current = { element: row, scroll: window.scrollY };
      setOpen(true);
    }
  }}>
    {list}
    <div className="detail-pane" ref={panel} tabIndex={-1} role="region" aria-label="选中条目的详情">
      <Button variant="secondary" className="detail-back" onClick={() => { returning.current = true; setOpen(false); }}>返回列表</Button>
      {children}
    </div>
  </div>;
}
