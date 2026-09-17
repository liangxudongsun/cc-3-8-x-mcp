'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseAnimation, queryAnimation, editAnimation } = require('../src/animation.js');
const { parsePrefab } = require('../src/parse.js');
const { makeRealCurve, makeRealKeyframe } = require('../src/anim-primitives.js');
const cli = path.resolve(__dirname, '../bin/cocos-mcp-cli.js');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-anim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ref = id => ({ __id__: id });
  const elements = [
    { __type__: 'cc.AnimationClip', _name: 'unlock', sample: 30, _duration: 0.8, _tracks: [ref(1), ref(7), ref(10)] },
    { __type__: 'cc.animation.VectorTrack', _binding: { path: ref(2) }, _channels: [ref(4), ref(4), ref(4)], _nComponents: 3 },
    { __type__: 'cc.animation.TrackPath', _paths: [ref(3), 'position'] },
    { __type__: 'cc.animation.HierarchyPath', path: 'content/lock' },
    { __type__: 'cc.animation.Channel', _curve: ref(5) },
    makeRealCurve({ times: [0, 0.8], values: [makeRealKeyframe({ value: 10, interpolationMode: 2, easingMethod: 3 }), makeRealKeyframe({ value: 20 })] }),
    { __type__: 'cc.animation.ComponentPath', component: 'cc.UIOpacity' },
    { __type__: 'cc.animation.RealTrack', _binding: { path: ref(8) }, _channel: ref(4) },
    { __type__: 'cc.animation.TrackPath', _paths: [ref(3), ref(6), 'opacity'] },
    { __type__: 'cc.ObjectCurve', _times: [0], _values: [{ __uuid__: 'asset-uuid' }] },
    { __type__: 'cc.animation.ObjectTrack', _binding: { path: ref(11) }, _channel: ref(12) },
    { __type__: 'cc.animation.TrackPath', _paths: ['spriteFrame'] },
    { __type__: 'cc.animation.Channel', _curve: ref(9) },
  ];
  elements[5]._values[0].rightTangent = 8;
  elements[5]._values[0].__editorExtras__ = { broken: true };
  const file = path.join(dir, 'unlock.anim');
  const raw = JSON.stringify(elements, null, 4) + '\n';
  fs.writeFileSync(file, raw);
  const run = args => spawnSync(process.execPath, [cli, 'anim', ...args], { encoding: 'utf8' });
  return { dir, file, raw, elements, run };
}
test('动画查询识别 AnimationClip，展开多通道、单通道和对象轨道', t => {
  const f = fixture(t), q = queryAnimation(f.file);
  assert.equal(q.name, 'unlock');assert.equal(q.tracks.length, 3);
  assert.equal(q.tracks[0].channels[0].curveId, 5);
  assert.equal(q.tracks[1].path[1].component, 'cc.UIOpacity');
  assert.equal(q.tracks[2].channels[0].curve._values[0].__uuid__, 'asset-uuid');
  assert.deepEqual(queryAnimation(f.file, { type: 'find', nodeType: 'cc.RealCurve' }), [5]);
  assert.equal(queryAnimation(f.file, { type: 'field', field: '_duration' }), 0.8);
  assert.deepEqual(queryAnimation(f.file, { type: 'field', id: 5, field: '_times' }), [0, 0.8]);
  assert.equal(queryAnimation(f.file, { type: 'node', name: 'content/lock' }).length, 2);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
});
test('动画与预制体解析入口保持各自的资产头校验', t => {
  const f = fixture(t);assert.throws(() => parsePrefab(f.file), /cc.Prefab/);
  fs.writeFileSync(f.file, JSON.stringify([{ __type__: 'cc.Prefab', data: { __id__: 1 } }, { __type__: 'cc.Node', _name: 'Root', _children: [] }]));
  assert.equal(parsePrefab(f.file).getRoot()._name, 'Root');
  assert.throws(() => parseAnimation(f.file), /cc.AnimationClip/);
});
test('CLI 默认查询与 find/field 查询使用动画解析器', t => {
  const f = fixture(t);
  const q = f.run(['query', f.file]);assert.equal(q.status, 0, q.stderr);assert.equal(JSON.parse(q.stdout).tracks.length, 3);
  const find = f.run(['query', f.file, '--selector', 'find', '--type', 'cc.RealCurve']);assert.equal(find.status, 0);assert.deepEqual(JSON.parse(find.stdout), [5]);
  const field = f.run(['query', f.file, '--selector', 'field', '--id', '5', '--field', '_times']);assert.equal(field.status, 0);assert.deepEqual(JSON.parse(field.stdout), [0, 0.8]);
});
test('曲线平移 dry-run 不写盘，实际修改保留时间、切线、缓动及格式', t => {
  const f = fixture(t), ops = [{ op: 'offset-curve', curveId: 5, offset: -3 }];
  const dry = editAnimation(f.file, ops, { dryRun: true });assert.equal(dry.changed, false);assert.equal(dry.diff.length, 1);assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  assert.equal(editAnimation(f.file, ops).changed, true);
  const actual = JSON.parse(fs.readFileSync(f.file, 'utf8'));const expected = structuredClone(f.elements);expected[5]._values.forEach(x => x.value -= 3);
  assert.deepEqual(actual, expected);assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(expected, null, 4) + '\n');
});
test('CLI batch 支持 dry-run 和单个关键帧修改', t => {
  const f = fixture(t), opsFile = path.join(f.dir, 'ops.json');
  fs.writeFileSync(opsFile, JSON.stringify([{ op: 'set-keyframe-value', curveId: 5, index: 1, value: 99 }]));
  const dry = f.run(['batch', f.file, opsFile, '--dry-run']);assert.equal(dry.status, 0, dry.stderr);assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  const result = f.run(['batch', f.file, opsFile]);assert.equal(result.status, 0, result.stderr);
  assert.equal(parseAnimation(f.file).elements[5]._values[1].value, 99);
});
test('后续操作无效时整批不写盘，拒绝预制体操作及非数值曲线', t => {
  const f = fixture(t);
  for (const bad of [
    { op: 'set-position', node: 'lock', x: 1, y: 2 },
    { op: 'offset-curve', curveId: 9, offset: 1 },
    { op: 'offset-curve', curveId: 99, offset: 1 },
    { op: 'offset-curve', curveId: 5, offset: Infinity },
    { op: 'set-keyframe-value', curveId: 5, index: -1, value: 1 },
    { op: 'set-keyframe-value', curveId: 5, index: 1, value: NaN },
  ]) {
    assert.throws(() => editAnimation(f.file, [{ op: 'offset-curve', curveId: 5, offset: 3 }, bad]));
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  }
});
test('无效引用、字段和曲线长度返回明确错误', t => {
  const f = fixture(t);
  assert.throws(() => queryAnimation(f.file, { type: 'field', id: -1, field: '_times' }), /无效引用/);
  assert.throws(() => queryAnimation(f.file, { type: 'field', field: 'missing' }), /不存在字段/);
  f.elements[5]._times.pop();fs.writeFileSync(f.file, JSON.stringify(f.elements));
  assert.throws(() => editAnimation(f.file, [{ op: 'offset-curve', curveId: 5, offset: 1 }]), /数量不一致/);
  f.elements[0]._tracks = [{ __id__: 99 }];fs.writeFileSync(f.file, JSON.stringify(f.elements));
  assert.throws(() => queryAnimation(f.file), /无效引用/);
});
