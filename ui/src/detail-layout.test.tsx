import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DetailLayout } from './DetailLayout';
const render = (detailKey?: string) => renderToStaticMarkup(<DetailLayout className="list-detail" detailKey={detailKey} list={<section>列表</section>}>详情</DetailLayout>);
it('derives routed detail visibility from the current route, including list navigation', () => {
  expect(render('task-106')).toContain('detail-open');
  expect(render('')).not.toContain('detail-open');
  expect(render('task-105')).toContain('detail-open');
});
it('keeps non-routed skill/activity consumers initially in the list', () => {
  expect(render()).not.toContain('detail-open');
});
it('retains the list and accessible detail region in both route states', () => {
  for (const key of ['', 'task-106']) {
    const html = render(key);
    expect(html).toContain('<section>列表</section>');
    expect(html).toContain('aria-label="选中条目的详情"');
    expect(html).toContain('返回列表');
  }
});
