const {test} = require('node:test');
const assert = require('node:assert/strict');
require('./model.js');
const model = globalThis.CommandSetPreview;

test('fill merges the 15 read-only presets without replacing custom rules or mutating saved data', () => {
  const saved = [{kind: 'exact', text: 'docker inspect demo'}, {kind: 'family', text: 'docker ps'}];
  const result = model.fill(saved);
  assert.equal(result.length, 16);
  assert.deepEqual(result[0], saved[0]);
  assert.equal(saved.length, 2);
  assert.deepEqual(model.fill(result), result);
  assert.ok(!result.some(rule => ['mkdir', 'touch'].includes(rule.text)));
});

test('over-limit fill fails atomically', () => {
  const saved = Array.from({length: 128}, (_, i) => ({kind: 'exact', text: `echo ${i}`}));
  const before = structuredClone(saved);
  assert.throws(() => model.fill(saved), /128/);
  assert.deepEqual(saved, before);
});

test('copy and import round-trip local rules and reject actual plugin data', () => {
  const rules = [model.validate([{kind: 'family', text: 'docker ps'}])[0], {kind: 'exact', text: 'docker inspect demo'}];
  assert.deepEqual(model.importSet(model.exportSet(rules)), rules);
  assert.throws(() => model.importSet('{"format":"tabby-secure-mcp-command-set","version":1,"rules":[]}'), /预览/);
  assert.throws(() => model.importSet('{broken'), /有效 JSON/);
});

test('merge preserves existing rules, deduplicates incoming, and rejects broad families', () => {
  assert.deepEqual(model.merge([{kind: 'family', text: 'pwd'}], [{kind: 'family', text: 'pwd'}, {kind: 'family', text: 'whoami'}]), [{kind: 'family', text: 'pwd'}, {kind: 'family', text: 'whoami'}]);
  for (const text of ['docker *', 'uci *', 'ip -4 *', 'rm']) assert.throws(() => model.validate([{kind: 'family', text}]), /精确匹配/);
});

test('rejects invalid entries, control characters, oversized commands and imports', () => {
  for (const value of [null, {}, [{kind: 'exact', text: 'a\nb'}], [{kind: 'exact', text: 'x'.repeat(513)}], [{kind: 'other', text: 'pwd'}]]) assert.throws(() => model.validate(value));
  assert.throws(() => model.importSet('x'.repeat(65537)), /64 KiB/);
  assert.throws(() => model.validate(Array.from({length: 128}, (_, i) => ({kind: 'exact', text: String(i).padStart(512, 'x')}))), /64 KiB/);
});

test('copy checks the final formatted export size', () => {
  const rules = Array.from({length: 125}, (_, i) => ({kind: 'exact', text: String(i).padStart(490, 'x')}));
  assert.equal(model.validate(rules).length, 125);
  assert.throws(() => model.exportSet(rules), /64 KiB/);
});
