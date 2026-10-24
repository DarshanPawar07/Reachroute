import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, formatMetric } from '../src/utils/metrics.js';

test('counters add up per label set and print in Prometheus format', () => {
  const r = createRegistry();
  r.inc('jobs_total', 'Jobs.', { kind: 'a' });
  r.inc('jobs_total', 'Jobs.', { kind: 'a' });
  r.inc('jobs_total', 'Jobs.', { kind: 'b' }, 5);
  const text = r.render();
  assert.match(text, /# HELP jobs_total Jobs\./);
  assert.match(text, /# TYPE jobs_total counter/);
  assert.match(text, /jobs_total\{kind="a"\} 2/);
  assert.match(text, /jobs_total\{kind="b"\} 5/);
});

test('label order does not create a second series, and values are escaped', () => {
  const r = createRegistry();
  r.inc('x_total', 'x', { b: '1', a: '2' });
  r.inc('x_total', 'x', { a: '2', b: '1' });
  r.inc('y_total', 'y', { path: 'say "hi"\\\nnow' });
  const text = r.render();
  assert.match(text, /x_total\{a="2",b="1"\} 2/);
  assert.match(text, /y_total\{path="say \\"hi\\"\\\\\\nnow"\} 1/);
});

test('histograms are cumulative and end with +Inf, sum and count', () => {
  const r = createRegistry();
  const buckets = [0.1, 1];
  r.observe('t_seconds', 'T.', { route: '/a' }, 0.05, buckets);
  r.observe('t_seconds', 'T.', { route: '/a' }, 0.5, buckets);
  r.observe('t_seconds', 'T.', { route: '/a' }, 5, buckets);
  const text = r.render();
  assert.match(text, /# TYPE t_seconds histogram/);
  assert.match(text, /t_seconds_bucket\{route="\/a",le="0.1"\} 1/);
  assert.match(text, /t_seconds_bucket\{route="\/a",le="1"\} 2/);
  assert.match(text, /t_seconds_bucket\{route="\/a",le="\+Inf"\} 3/);
  assert.match(text, /t_seconds_sum\{route="\/a"\} 5\.55/);
  assert.match(text, /t_seconds_count\{route="\/a"\} 3/);
});

test('gauges without labels have no braces, and bad numbers print as 0', () => {
  const text = formatMetric({ name: 'g', help: 'G.', samples: [{ value: 3 }] });
  assert.equal(text, '# HELP g G.\n# TYPE g gauge\ng 3');
  assert.match(formatMetric({ name: 'h', help: 'H.', samples: [{ labels: { c: 'x' }, value: NaN }] }), /h\{c="x"\} 0/);
});

test('one metric never keeps more than 500 label combinations', () => {
  const r = createRegistry();
  for (let i = 0; i < 700; i++) r.inc('many_total', 'm', { id: String(i) });
  assert.equal(r.render().split('\n').filter((l) => l.startsWith('many_total{')).length, 500);
  r.inc('many_total', 'm', { id: '0' }); // existing series still count
  assert.match(r.render(), /many_total\{id="0"\} 2/);
});

test('extra gauges are appended after recorded metrics, and reset clears everything', () => {
  const r = createRegistry();
  r.inc('c_total', 'c');
  const text = r.render([{ name: 'up', help: 'Up.', samples: [{ value: 1 }] }]);
  assert.ok(text.indexOf('c_total') < text.indexOf('# HELP up'));
  assert.ok(text.endsWith('\n'));
  r.reset();
  assert.equal(r.render().trim(), '');
});
