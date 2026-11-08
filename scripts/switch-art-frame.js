/**
 * name: SWITCH-ART-FRAME
 * version: 3.1.0
 * description: Switchs text between Artistic Text and Frame Text in place: each selected Artistic Text becomes Frame Text and each selected Frame Text becomes Artistic Text, including text inside selected groups, so running it again switchs back. Character styles (font, size, colour, tracking, baseline, super/subscript, stroke, underline …) and paragraph styles (alignment, indents, leading, space before/after …) are copied run by run, and line breaks inside paragraphs are kept. Artistic Text → Frame Text: the frame is placed on the original glyph ink (within 1 px) and sized so that single lines never wrap; scaled or rotated text, also inside transformed groups, is rebuilt with scaled point sizes and the same rotation, non-uniform scaling becomes horizontal glyph scaling, and shear cannot be reproduced. Frame Text → Artistic Text: lines wrapped by the frame become line breaks, and the text is matched glyph by glyph to the frame's position, rotation and visual size; linked text frames are skipped, and text hidden by overflow becomes visible. New items keep the originals' place in the Layers panel and are all selected. Undo: one step for a single item; when several are converted, the first undo restores the previous selection and the second undoes the conversion.
 * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
 */
'use strict';

const { Document } = require('/document');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand, InsertionMode } = require('/commands');
const { ArtTextNodeDefinition, FrameTextNodeDefinition, NodeChildType } = require('/nodes');
const { StoryBuilder } = require('/storybuilder');
const { StoryApi } = require('affinity:story');
const { GlyphAtts, GlyphAttDoubleType, GlyphAttStringType } = require('/glyphatts');
const { ParagraphAtts, ParagraphAttDoubleType, ParagraphAlignXType } = require('/paragraphatts');
const { Selection } = require('/selections');
const { Transform } = require('/geometry');

const CFG = {
  widthPadEm: 0.10,      // 宽度余量（按最大字号折算的 em）
  minWidthPad: 2,        // 最小宽度余量 px
  heightPadEm: 0.35,     // 文本框高度余量
  removeOriginal: true,  // 转换后删除原艺术字
  maxWidenPasses: 3,     // 检测到换行时最多加宽重排次数
  positionTolerance: 1.5,// 带变换时允许的位置偏差（超出则平移校正）
  uniformTolerance: 0.01,// 判定「均匀缩放」的容差
  debug: false,          // 打印每一步的变换状态
  verbose: true
};

/** 以 pt 为单位、需要随缩放因子一起缩放的属性 */
const GLYPH_LEN_ATTS = ['Height', 'BaselineAdvance', 'AbsoluteLeading', 'OffsetX', 'OffsetY', 'AutoKernMinHeight'];
const PARA_LEN_ATTS = ['AbsoluteLeading', 'SpaceBefore', 'SpaceAfter', 'FirstLineIndent', 'RightIndent', 'LeftIndent', 'DefaultTabStops', 'HyphenationZone'];

const META_KEYS = new Set(['entries', 'values', 'keys', 'parse', 'isEnum', 'length', 'name', 'arguments', 'caller', 'prototype']);
const enumKeys = e => Object.getOwnPropertyNames(e).filter(k => !META_KEYS.has(k));
const round = v => Math.round(v * 100) / 100;

// ── 样式复制 ───────────────────────────────────────────────────────────
function copyAccessors(src, dst) {
  const proto = Object.getPrototypeOf(src);
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (k === 'constructor') continue;
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (!d || typeof d.get !== 'function' || typeof d.set !== 'function') continue;
    try { dst[k] = src[k]; } catch (e) { /* 属性不可写，跳过 */ }
  }
}

function scaleGlyphAtts(dst, s) {
  for (const name of GLYPH_LEN_ATTS) {
    const t = GlyphAttDoubleType[name];
    if (!t) continue;
    try { dst.setDoubleValue(t.value, dst.getDoubleValue(t.value) * s); } catch (e) {}
  }
}

function scaleParagraphAtts(dst, s) {
  for (const name of PARA_LEN_ATTS) {
    const t = ParagraphAttDoubleType[name];
    if (!t) continue;
    try { dst.setDoubleValue(t.value, dst.getDoubleValue(t.value) * s); } catch (e) {}
  }
}

function cloneGlyphAtts(srcHandle, sizeScale, xStretch) {
  const src = new GlyphAtts(srcHandle);
  const dst = GlyphAtts.create();
  for (const k of enumKeys(GlyphAttDoubleType)) {
    try { dst.setDoubleValue(GlyphAttDoubleType[k].value, src.getDoubleValue(GlyphAttDoubleType[k].value)); } catch (e) {}
  }
  for (const k of enumKeys(GlyphAttStringType)) {
    if (k === 'StyleName') continue;   // 不复制样式名，避免文本样式把显式属性覆盖回去
    try { dst.setStringValue(GlyphAttStringType[k].value, src.getStringValue(GlyphAttStringType[k].value)); } catch (e) {}
  }
  try { dst.font = src.font; } catch (e) {}
  copyAccessors(src, dst);             // 填充、描边、下划线、大小写、上下标…
  if (sizeScale && Math.abs(sizeScale - 1) > 1e-9) scaleGlyphAtts(dst, sizeScale);
  // 非均匀缩放：横向拉伸交给字形自身的 ScaleX（文本框的变换只改框、不放大字形）
  if (xStretch && Math.abs(xStretch - 1) > 1e-9) {
    try {
      const t = GlyphAttDoubleType.ScaleX;
      dst.setDoubleValue(t.value, dst.getDoubleValue(t.value) * xStretch);
    } catch (e) {}
  }
  return dst;
}

function cloneParagraphAtts(srcHandle, sizeScale) {
  const src = new ParagraphAtts(srcHandle);
  const dst = ParagraphAtts.create();
  for (const k of enumKeys(ParagraphAttDoubleType)) {
    try { dst.setDoubleValue(ParagraphAttDoubleType[k].value, src.getDoubleValue(ParagraphAttDoubleType[k].value)); } catch (e) {}
  }
  copyAccessors(src, dst);
  if (sizeScale && Math.abs(sizeScale - 1) > 1e-9) scaleParagraphAtts(dst, sizeScale);
  return dst;
}

// ── story 复刻 ─────────────────────────────────────────────────────────
// 段内换行（Shift+Enter）写成 U+2028；StoryBuilder 把 '\n' 当作新段落
const LINE_BREAK = '\u2028';

function glyphText(glyph) {
  if (glyph.isHardBreakGlyph) return LINE_BREAK;   // 段落符在 rebuildStory 里单独处理，这里只会是段内换行
  try { return typeof glyph.string === 'string' ? glyph.string : ''; } catch (e) { return ''; }
}

/**
 * 重建 story。opts.artistic：生成艺术字用的 story；
 * opts.breakBefore / opts.drop：文本框自动换行处的处理（在该位置前插换行符 / 删掉行尾空格）
 */
function rebuildStory(node, doc, alignOverride, sizeScale, xStretch, opts) {
  const story = node.story;
  const len = story.length;
  const sb = StoryBuilder.create();
  if (opts && opts.artistic) sb.setToArtisticTextDefaultStyle(doc.dpi, 'left');
  else sb.setToFrameTextDefaultStyle(doc.dpi, 'left');
  const sc = sizeScale || 1;
  const breakBefore = opts && opts.breakBefore, drop = opts && opts.drop;

  let maxSize = 0, paragraphs = 0, needParaAtts = true, plain = '';
  let i = 0;
  while (i < len) {
    if (story.isParagraphBreak(i)) {
      sb.addParagraphBreak();
      plain += '\n';
      needParaAtts = true;
      i++;
      continue;
    }
    if (needParaAtts) {
      const pa = cloneParagraphAtts(StoryApi.getParagraphAtts(story.handle, i), sc);
      if (alignOverride !== undefined) { try { pa.alignXType = alignOverride; } catch (e) {} }
      sb.setParagraphAtts(pa);
      needParaAtts = false;
      paragraphs++;
    }
    let end = len;
    try { end = StoryApi.getGlyphAttsRunEnd(story.handle, i, len); } catch (e) { end = len; }
    if (!(end > i)) end = i + 1;

    let cursor = i, text = '';
    while (cursor < Math.min(end, len) && !story.isParagraphBreak(cursor)) {
      if (breakBefore && breakBefore.has(cursor)) text += LINE_BREAK;
      if (!(drop && drop.has(cursor))) text += glyphText(story.getGlyph(cursor));
      cursor++;
    }
    const atts = cloneGlyphAtts(StoryApi.getGlyphAtts(story.handle, i), sc, xStretch);
    try {
      const h = atts.getDoubleValue(GlyphAttDoubleType.Height.value);
      if (h > maxSize) maxSize = h;
    } catch (e) {}
    if (text.length) {
      sb.setGlyphAtts(atts);
      sb.addText(text);
      plain += text;
    }
    i = cursor > i ? cursor : i + 1;
  }

  let align = ParagraphAlignXType.Left;
  try { align = new ParagraphAtts(StoryApi.getParagraphAtts(story.handle, 0)).alignXType; } catch (e) {}

  return { sb: sb, maxSize: maxSize || 12 * sc, paragraphs: Math.max(1, paragraphs), align: align, plain: plain };
}

// ── 几何 / 节点工具 ────────────────────────────────────────────────────
function boxParts(b) {
  const mn = b.minPoint, mx = b.maxPoint;
  return { x: mn.x, y: mn.y, w: mx.x - mn.x, h: mx.y - mn.y, right: mx.x, bottom: mx.y };
}

function inkOf(node) {          // 墨迹（含字形溢出）在跨页空间
  const p = boxParts(node.spreadVisibleBox);
  p.right = p.x + p.w;
  return p;
}

/** 文本框的「框」在跨页空间（文字溢出时不会长大） */
function frameRectOf(node) {
  try { return boxParts(node.spreadBaseBox); } catch (e) { return null; }
}

/** 节点自身几何在 base 空间（未施加任何变换） */
function baseInkOf(node) {
  try {
    const p = boxParts(node.baseBox);
    p.right = p.x + p.w;
    return p;
  } catch (e) { return null; }
}

const IDENTITY = [1, 0, 0, 0, 1, 0];
const tfData = t => { const d = t.data; return [d[0], d[1], d[2], d[3], d[4], d[5]]; };  // a,b,e,c,d,f（行向量：x'=ax+by+e）
const isIdentity = d => d.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-6);

/** 读节点的 base→spread 总变换并分解为 缩放 / 旋转 / 平移 */
function readTransform(node) {
  let d;
  try { d = tfData(node.baseToSpreadTransform); } catch (e) { return null; }
  if (isIdentity(d)) return null;
  const a = d[0], b = d[1], e = d[2], c = d[3], dd = d[4], f = d[5];
  // 分解为 A = T(e,f) · R(θ) · S(sx,sy)（行向量：先缩放再旋转再平移）
  // 于是 a = sx·cosθ, b = -sx·sinθ, c = sy·sinθ, d = sy·cosθ
  const det = a * dd - b * c;
  const sx = Math.hypot(a, b), sy = Math.hypot(c, dd);
  const theta = Math.atan2(-b, a);
  const s = Math.sqrt(Math.abs(det)) || 1;
  // 该分解成立的条件：矩阵两行正交（无剪切）
  const ortho = (sx * sy) ? Math.abs(a * c + b * dd) / (sx * sy) : 1;
  const uniform = Math.abs(sx - sy) / Math.max(sx, sy, 1e-9) <= CFG.uniformTolerance;
  const shearFree = ortho <= CFG.uniformTolerance;
  const raw = Transform.createIdentity();
  try { raw.assign(node.baseToSpreadTransform); } catch (e) {}
  // 实际会施加到新文本框上的变换：只有旋转 + 平移（缩放已折算进字号）
  let applied = Transform.createIdentity();
  try {
    if (Math.abs(theta) > 1e-9) applied = applied.rotated(theta);
    applied = applied.translated(e, f);
  } catch (err) { applied = raw; }
  return { data: d, s: s, theta: theta, tx: e, ty: f, sx: sx, sy: sy, ortho: ortho,
           uniform: uniform, shearFree: shearFree, raw: raw, applied: applied };
}

function collectArtText(node, out) {
  if (!node) return out;
  if (node.isArtTextNode) { out.push(node); return out; }
  if (node.children) for (let i = 0; i < node.children.length; i++) collectArtText(node.children.at(i), out);
  return out;
}

function deleteNodes(doc, nodes) {
  if (!nodes.length) return;
  const sel = Selection.create(doc, null, false);
  for (const n of nodes) sel.addNode(n);
  doc.executeCommand(DocumentCommand.createDeleteSelection(sel));
}

function applyTransform(doc, node, t) {
  doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, [node], false), t));
}

function translateNode(doc, node, dx, dy) {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
  applyTransform(doc, node, Transform.createTranslate(dx, dy));
}

function dbgNode(n, tag) {
  const d = t => { const x = t.data; return [x[0], x[1], x[2], x[3], x[4], x[5]].map(v => round(v)).join(','); };
  const b = x => { try { return [x.minPoint.x, x.minPoint.y, x.maxPoint.x, x.maxPoint.y].map(v => round(v)).join(','); } catch (e) { return 'n/a'; } };
  console.log('   ' + tag + ' tf=[' + d(n.transform) + '] B2S=[' + d(n.baseToSpreadTransform) + ']');
  console.log('        base=[' + b(n.baseBox) + '] spreadBase=[' + b(n.spreadBaseBox) + '] spreadVis=[' + b(n.spreadVisibleBox) + ']');
}

/** 把 base 空间的矩形经变换 t 后的包围盒 */
function aabbOfBox(t, box) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const x of [box.x, box.x + box.width]) {
    for (const y of [box.y, box.y + box.height]) {
      const p = t.applyToPoint({ x: x, y: y });
      if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
      if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
    }
  }
  return { x: mnx, y: mny, right: mxx, bottom: mxy, w: mxx - mnx, h: mxy - mny };
}

/** 创建一批 FrameText；命令返回的 newNodes 是「后进先出」，索引要倒着取 */
function createFrames(doc, items) {
  const parent = items[0].parent;
  const B = AddChildNodesCommandBuilder.create();
  if (parent) B.setInsertionTarget(parent);
  for (const it of items) B.addNode(FrameTextNodeDefinition.createFromStoryBuilder(it.box, it.sb));
  const cmd = B.createCommand(false, NodeChildType.Main);
  doc.executeCommand(cmd);

  const n = cmd.newNodes.length;
  for (let i = 0; i < items.length; i++) {
    const idx = n - 1 - i;
    items[i].newNode = idx >= 0 ? cmd.newNodes.at(idx) : null;
  }
  // 带变换的节点：字形已按 sx/sy 调整，这里只需补上「旋转 + 平移」（试算阶段，最终由 commitAll 一步重建）
  for (const it of items) {
    if (!it.newNode || !it.tf) continue;
    if (CFG.debug) dbgNode(it.newNode, '[前] s=' + round(it.tf.sx) + '×' + round(it.tf.sy) + ' θ=' + round(it.tf.theta * 180 / Math.PI) +
      ' t=(' + round(it.tf.tx) + ',' + round(it.tf.ty) + ') applied=' + round(it.tf.applied.data[0]) + ',' + round(it.tf.applied.data[1]) + ',' +
      round(it.tf.applied.data[2]) + ',' + round(it.tf.applied.data[3]) + ',' + round(it.tf.applied.data[4]) + ',' + round(it.tf.applied.data[5]));
    applyTransform(doc, it.newNode, it.tf.applied);
    if (CFG.debug) dbgNode(it.newNode, '[后]');
  }
  return items;
}

function layoutBox(p) {
  const lsb = p.lsb || 0;
  const ink = p.layoutInk;                     // base 空间（无变换时 == 跨页空间）
  // 宽度 = 墨迹宽 + 左侧边距 + 安全余量（余量同时覆盖右侧边距），保证单行不会被挤断
  const width = Math.max(ink.w + lsb + p.pad, 1);
  let x;
  if (p.isRight) x = ink.right - width;        // 右对齐：余量加在左侧
  else if (p.isCentre) x = ink.x + ink.w / 2 - width / 2;   // 居中：两侧均分
  else x = ink.x - lsb;                        // 左对齐：墨迹左缘对齐原位
  const base = {
    x: x,
    y: ink.y + (p.dy || 0),
    width: width,
    height: Math.max(ink.h + Math.max(2, CFG.heightPadEm * p.baseMaxSize), 1)
  };
  p.boxBase = base;
  // 字号按 sy 放大、字宽按 sx/sy 拉伸，因此框在 base 空间要各向异性放大 sx / sy，
  // 之后再叠加 rotate(θ) + translate(e,f)，才与 A(base) 严格等价
  const sx = p.tf ? p.tf.sx : 1;
  const sy = p.tf ? p.tf.sy : 1;
  p.box = { x: base.x * sx, y: base.y * sy, width: base.width * sx, height: base.height * sy };
}

/** 文字溢出到框底之外 = 被挤换行了。容差取半个行高：
 *  真正换行会多出一整行（≈1.2 倍字号），而字形下沿轻微溢出只有几个像素，据此区分 */
function isWrapped(p) {
  if (!p.newNode) return false;
  const ink = inkOf(p.newNode);
  const rect = frameRectOf(p.newNode);
  const bottom = rect ? rect.bottom : p.box.y + p.box.height;
  const tol = Math.max(1.5, 0.4 * (p.maxSize || 12));
  return ink.bottom > bottom + tol;
}

/** 带变换的节点：校正到「期望框位置」。FrameText 的 visibleBox 是框本身，
 *  不能当墨迹用，所以直接比对变换后的框包围盒 */
function fixPosition(doc, p) {
  if (!p.tf || !p.newNode) return 0;
  const rect = frameRectOf(p.newNode);
  if (!rect) return 0;
  // 目标是原艺术字的真实位置 A(base 框)；均匀缩放时该值与理论位置完全一致（不触发校正），
  // 非均匀缩放时字号只能等比近似，但位置必须对，于是这里平移归位。
  const exp = aabbOfBox(p.tf.raw, p.boxBase);
  const dx = exp.x - rect.x;
  const dy = exp.bottom - rect.bottom;
  if (Math.abs(dx) <= CFG.positionTolerance && Math.abs(dy) <= CFG.positionTolerance) return 0;
  translateNode(doc, p.newNode, dx, dy);
  return Math.max(Math.abs(dx), Math.abs(dy));
}

// ── 主流程 ─────────────────────────────────────────────────────────────
/** 记下试算文本框的最终框与变换（回滚后节点会消失，只保留数值）。
 *  节点定义的 transform 是 base→spread 总变换，插入时由 Affinity 自己扣除父级变换 */
function recordFrame(p) {
  if (!p.newNode) return;
  const b = p.newNode.baseBox;
  const t = Transform.createIdentity();
  t.assign(p.newNode.baseToSpreadTransform);
  p.final = { box: { x: b.x, y: b.y, width: b.width, height: b.height }, transform: t };
}

// ── FrameText → ArtText ────────────────────────────────────────────────
// 文本框的字形轮廓（curvesInterface）每个可见字符一条，按 story 顺序、在节点 base 坐标里。
// 据此找出自动换行的位置，并用「试建艺术字 ↔ 原文本框」的字形配对解出精确的位置 / 旋转 / 大小。

/** 会画出轮廓的 story 位置（非空白、非换行） */
function visiblePositions(story, end) {
  const out = [];
  for (let i = 0; i < end; i++) {
    if (story.isParagraphBreak(i)) continue;
    const s = glyphText(story.getGlyph(i));
    if (s && /\S/.test(s)) out.push(i);
  }
  return out;
}

/** 节点每个字形轮廓的包围盒（base 坐标） */
function glyphBoxes(node) {
  const out = [];
  try {
    const pp = node.curvesInterface.polyPolyCurves;
    for (let j = 0; j < pp.polyCurveCount; j++) {
      const b = pp.getTransformedPolyCurve(j).exactBoundingBox;
      out.push({ x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 });
    }
  } catch (e) {}
  return out;
}

/** 溢出：Affinity 默认在框下方照常显示溢出的文字；只有开启「隐藏溢出」时才藏起来 */
function overflowOf(node) {
  try {
    const flow = node.textFrameInterface.textFlow;
    const info = flow.getOverflowInfo();
    const over = String(info.state) !== 'None';
    const hidden = over && flow.hideOverflow === true;
    return { hidden: hidden, end: hidden && info.position >= 0 ? info.position : node.story.length };
  } catch (e) {
    return { hidden: false, end: node.story.length };
  }
}

/** 相邻两个可见字形 a → b 之间是否换到了下一行（框内坐标，行是水平的） */
function startsNewLine(a, b) {
  const drop = b.cy - a.cy, h = Math.max(a.h, b.h, 1e-6);
  return drop > 0.6 * h && (b.x < a.x + a.w / 2 || drop > 1.0 * h);
}

/** 找出自动换行：返回 { breakBefore, drop, count }，count 为自动换行处数 */
function findSoftWraps(story, positions, boxes) {
  const breakBefore = new Set(), drop = new Set();
  for (let k = 1; k < positions.length; k++) {
    const pa = positions[k - 1], pb = positions[k];
    let hard = false;
    for (let i = pa + 1; i < pb && !hard; i++) hard = story.isParagraphBreak(i) || story.getGlyph(i).isHardBreakGlyph;
    if (hard || !startsNewLine(boxes[k - 1], boxes[k])) continue;
    breakBefore.add(pb);
    for (let i = pb - 1; i > pa && /^\s+$/.test(glyphText(story.getGlyph(i))); i--) drop.add(i);   // 行尾空格不带过去
  }
  return { breakBefore, drop, count: breakBefore.size };
}

/** 读文本框，准备转换成艺术字 */
function buildFramePlan(doc, node) {
  let label = '';
  try { label = node.descriptionInterface.description; } catch (e) {}
  let linked = false;
  try { linked = node.textFrameInterface.isMultiFrameTextFlow; } catch (e) {}
  if (linked) { console.log('[跳过] 串接的文本框（多个框共用一段文字）：' + label); return null; }
  const story = node.story;
  const over = overflowOf(node);
  const positions = visiblePositions(story, over.end);
  const boxes = glyphBoxes(node);
  const paired = positions.length > 0 && positions.length === boxes.length;
  const wraps = paired ? findSoftWraps(story, positions, boxes) : { breakBefore: new Set(), drop: new Set(), count: 0 };
  if (!paired && positions.length) console.log('[注意] 「' + label + '」的字形无法逐个对应（连字、下划线或特殊字符），自动换行不保留，位置按整体包围盒对齐。');
  const opts = { artistic: true, breakBefore: wraps.breakBefore, drop: wraps.drop };
  const built = rebuildStory(node, doc, undefined, 1, 1, opts);
  return {
    kind: 'frame', node: node, parent: node.parent, label: label, opts: opts,
    sb: built.sb, plain: built.plain, maxSize: built.maxSize, paragraphs: built.paragraphs,
    positions: positions, boxes: paired ? boxes : [], allBoxes: boxes,
    wraps: wraps.count, overflow: over.hidden
  };
}

function applyPoint(t, x, y) { return t.applyToPoint({ x: x, y: y }); }

/** 最小二乘相似变换 q ≈ k·R(θ)·p + t（2 对以上点） */
function fitSimilarity(ps, qs) {
  const n = ps.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) { px += ps[i].x; py += ps[i].y; qx += qs[i].x; qy += qs[i].y; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const ux = ps[i].x - px, uy = ps[i].y - py, vx = qs[i].x - qx, vy = qs[i].y - qy;
    sa += ux * vx + uy * vy; sb += ux * vy - uy * vx; ss += ux * ux + uy * uy;
  }
  if (ss < 1e-9) return null;
  const A = sa / ss, B = sb / ss;
  return { k: Math.hypot(A, B), theta: Math.atan2(B, A), tx: qx - (A * px - B * py), ty: qy - (B * px + A * py) };
}

/** 由相似变换参数建 Transform（行向量 x' = a·x + b·y + e） */
function similarityTransform(m, withScale) {
  let t = Transform.createTranslate(m.tx, m.ty);
  if (Math.abs(m.theta) > 1e-9) t = t.multiply(Transform.createRotate(m.theta));
  if (withScale && Math.abs(m.k - 1) > 1e-9) t = t.multiply(Transform.createScale(m.k, m.k));
  return t;
}

function insertProbeArt(doc, p, sb) {
  const def = ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, sb);
  def.transform = Transform.createIdentity();          // 节点定义的 transform = base→spread
  const B = AddChildNodesCommandBuilder.create();
  B.setInsertionTarget(p.node);
  B.setInsertionMode(InsertionMode.Behind);
  B.addNode(def);
  const cmd = B.createCommand(false, NodeChildType.Main);
  doc.executeCommand(cmd);
  return cmd.newNodes.at(0);
}

/** 试算：建一个位于原点、无变换的艺术字探针，与原文本框的字形配对，解出最终变换 */
function trialArts(doc, plan) {
  for (const p of plan) {
    const probe = insertProbeArt(doc, p, p.sb);
    const pb = glyphBoxes(probe);
    const fT = p.node.baseToSpreadTransform;
    let m = null;
    const n = p.boxes.length;
    if (n && pb.length >= n) {
      const ps = [], qs = [];
      for (let j = 0; j < n; j++) { ps.push({ x: pb[j].cx, y: pb[j].cy }); qs.push(applyPoint(fT, p.boxes[j].cx, p.boxes[j].cy)); }
      m = fitSimilarity(ps, qs);
      if (!m) {   // 只有一个字形：旋转取自文本框，大小按字高比
        const tf = readTransform(p.node);
        const det = tfData(fT); const s = Math.sqrt(Math.abs(det[0] * det[4] - det[1] * det[3])) || 1;
        const k = pb[0].h > 0 ? p.boxes[0].h * s / pb[0].h : 1;
        const th = tf ? tf.theta : 0;
        const c = Math.cos(th) * k, sn = Math.sin(th) * k;
        m = { k: k, theta: th, tx: qs[0].x - (c * ps[0].x - sn * ps[0].y), ty: qs[0].y - (sn * ps[0].x + c * ps[0].y) };
      }
      let worst = 0;
      const c = Math.cos(m.theta) * m.k, sn = Math.sin(m.theta) * m.k;
      for (let j = 0; j < n; j++) {
        const x = c * ps[j].x - sn * ps[j].y + m.tx, y = sn * ps[j].x + c * ps[j].y + m.ty;
        worst = Math.max(worst, Math.hypot(x - qs[j].x, y - qs[j].y));
      }
      p.residual = worst;
    } else {
      // 无法逐字配对：旋转取自文本框，按整体包围盒左上角对齐
      const tf = readTransform(p.node);
      const th = tf ? tf.theta : 0;
      const src = p.allBoxes.length ? p.allBoxes : [boxFromNode(p.node)];
      const ux = Math.min(...src.map(b => b.x)), uy = Math.min(...src.map(b => b.y));
      const vx = pb.length ? Math.min(...pb.map(b => b.x)) : 0, vy = pb.length ? Math.min(...pb.map(b => b.y)) : 0;
      const q = applyPoint(fT, ux, uy), c = Math.cos(th), sn = Math.sin(th);
      m = { k: 1, theta: th, tx: q.x - (c * vx - sn * vy), ty: q.y - (sn * vx + c * vy) };
      p.residual = null;
    }
    // 大小差异折算进字号（与艺术字 → 文本框方向一致：字号即视觉大小，变换不含缩放）
    p.sizeScale = Math.abs(m.k - 1) > 0.002 ? m.k : 1;
    if (p.sizeScale !== 1) p.sb = rebuildStory(p.node, doc, undefined, p.sizeScale, 1, p.opts).sb;
    p.final = { kind: 'art', transform: similarityTransform(m, false) };
  }
}

function boxFromNode(node) {
  const b = node.baseBox;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

// ── 提交 ───────────────────────────────────────────────────────────────
/** 一条复合命令：每个新节点插在原节点正下方（保持图层顺序），再删除原节点 —— 只占 1 步撤销 */
function commitAll(doc, items) {
  const done = items.filter(p => p.final);
  if (!done.length) return;
  const cb = CompoundCommandBuilder.create();
  for (const p of done) {
    let def;
    if (p.final.kind === 'art') def = ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, p.sb);
    else def = FrameTextNodeDefinition.createFromStoryBuilder(p.final.box, p.sb);
    def.transform = p.final.transform;
    const B = AddChildNodesCommandBuilder.create();
    B.setInsertionTarget(p.node);
    B.setInsertionMode(InsertionMode.Behind);
    B.addNode(def);
    // 每条建框命令都会把选区替换成自己的新节点：只转换一个时直接选中它（不占额外步骤），
    // 多个时由 selectNew 在提交后一次性全选
    cb.addCommand(B.createCommand(done.length === 1, NodeChildType.Main));
  }
  if (CFG.removeOriginal) {
    const sel = Selection.create(doc, null, false);
    for (const p of done) sel.addNode(p.node);
    cb.addCommand(DocumentCommand.createDeleteSelection(sel));
  }
  doc.executeCommand(cb.createCommand(), false);
  // 复合命令里的子命令不能读 newNodes（INVALID_OP），改在原父级里按类型、变换与内容对上号
  const claimed = [];
  for (const p of done) {
    p.newNode = null;
    if (!p.parent) continue;
    for (const n of p.parent.children) {
      if (claimed.some(c => c.isSameNode(n)) || !matchesFinal(n, p)) continue;
      p.newNode = n;
      claimed.push(n);
      break;
    }
  }
}

function matchesFinal(node, p) {
  if (p.final.kind === 'art') {
    if (!node.isArtTextNode) return false;
    const d = tfData(node.baseToSpreadTransform), e = tfData(p.final.transform);
    return d.every((v, i) => Math.abs(v - e[i]) < 1e-3) && storyPlain(node) === p.plain.replace(/\n+$/, '');
  }
  return node.isFrameTextNode && sameFrame(node, p.final);
}

function storyPlain(node) {
  const st = node.story;
  let s = '';
  for (let i = 0; i < st.length; i++) s += st.isParagraphBreak(i) ? '\n' : glyphText(st.getGlyph(i));
  return s.replace(/\n+$/, '');
}

function sameFrame(node, f) {
  const b = node.baseBox, d = tfData(node.baseToSpreadTransform), e = tfData(f.transform);
  const near = (u, v) => Math.abs(u - v) < 1e-3;
  return near(b.x, f.box.x) && near(b.y, f.box.y) && near(b.width, f.box.width) && near(b.height, f.box.height) &&
    d.every((v, i) => near(v, e[i]));
}

function selectNew(doc, items) {
  const nodes = items.filter(p => p.newNode).map(p => p.newNode);
  if (nodes.length < 2) return;   // 单个时建节点命令已选中它
  const sel = Selection.create(doc, null, false);
  for (const n of nodes) sel.addNode(n);
  doc.executeCommand(DocumentCommand.createSetSelection(sel));
}

// ── 主流程 ─────────────────────────────────────────────────────────────
/** 选中的艺术字 / 文本框（含选中组内的） */
function collectText(node, arts, frames) {
  if (!node) return;
  if (node.isArtTextNode) { arts.push(node); return; }
  if (node.isFrameTextNode) { frames.push(node); return; }
  if (node.children) for (let i = 0; i < node.children.length; i++) collectText(node.children.at(i), arts, frames);
}

/** 读艺术字，准备转换成文本框 */
function buildArtPlan(doc, node) {
  const ink = inkOf(node);
  const tf = readTransform(node);
  const sx = tf ? tf.sx : 1;
  const sy = tf ? tf.sy : 1;
  const built = rebuildStory(node, doc);   // 未缩放：用于标定探针
  // 真正建框用的 story：字号 ×sy（纵向），字形 ScaleX ×(sx/sy)（横向拉伸）
  const sized = tf ? rebuildStory(node, doc, undefined, sy, sx / sy) : built;
  const isLeft = built.align && built.align.value === ParagraphAlignXType.Left.value;
  const probeSb = isLeft ? built.sb : rebuildStory(node, doc, ParagraphAlignXType.Left).sb;
  const isRight = built.align && built.align.value === ParagraphAlignXType.Right.value;
  const isCentre = built.align && built.align.value === ParagraphAlignXType.Centre.value;
  const baseInk = tf ? baseInkOf(node) : null;
  if (tf && !tf.shearFree) {
    console.log('[注意] 「' + built.plain.slice(0, 12) + '…」的变换含剪切（正交性偏差 ' +
      round(tf.ortho * 100) + '%），剪切无法完全还原。');
  }
  return {
    kind: 'art', node: node, ink: ink, sb: sized.sb, probeSb: probeSb,
    layoutInk: baseInk || ink,          // 有变换时用 base 空间几何参与布局
    tf: tf,
    maxSize: sized.maxSize, baseMaxSize: built.maxSize, paragraphs: sized.paragraphs,
    align: built.align, plain: built.plain, parent: node.parent,
    isRight: isRight, isCentre: isCentre,
    pad: Math.max(CFG.minWidthPad, CFG.widthPadEm * built.maxSize) / sx   // pad 属 base 空间横向量
  };
}

function main() {
  const doc = Document.current;
  if (!doc) throw new Error('请先打开一个文档。');

  const arts = [], frames = [];
  const sel = doc.selection;
  if (sel && sel.length) for (const n of sel.nodes) collectText(n, arts, frames);
  if (!arts.length && !frames.length) throw new Error('请先选中要互转的艺术字或文本框。');

  // 1) 读取原样式并重建 story：艺术字 → 文本框、文本框 → 艺术字
  const artPlan = [], framePlan = [];
  for (const node of arts.concat(frames)) {
    if (!node.story || node.story.length === 0) {
      let label = '';
      try { label = node.descriptionInterface.description; } catch (e) {}
      console.log('[跳过] 空文本：' + label);
      continue;
    }
    if (node.isArtTextNode) artPlan.push(buildArtPlan(doc, node));
    else { const p = buildFramePlan(doc, node); if (p) framePlan.push(p); }
  }
  if (!artPlan.length && !framePlan.length) { console.log('没有可转换的文字。'); return; }
  if (CFG.debug) for (const p of artPlan) dbgNode(p.node, '[原] ' + JSON.stringify(p.plain.slice(0, 12)));

  // 2)–5) 是试算：探针、建框、加宽、校正都会产生历史记录，记下最终结果后全部回滚，
  //         再由 commitAll 一步重建。中途出错时同样回滚，文档不会停在半转换状态。
  const historyStart = doc.history.position;
  try {
    if (artPlan.length) {
      trialLayout(doc, artPlan);
      for (const p of artPlan) recordFrame(p);
    }
    if (framePlan.length) trialArts(doc, framePlan);
  } finally {
    while (doc.history.position > historyStart) doc.undo();
  }

  // 6) 建新节点、删除原节点：一条复合命令（顺序按原选区）
  const items = artPlan.concat(framePlan);
  commitAll(doc, items);
  // 7) 选中全部新节点（多个时设选区会多占 1 步撤销，SDK 无法合并）
  selectNew(doc, items);
  report(artPlan, framePlan);
}

function trialLayout(doc, plan) {

  // 2) 标定（两个一次性探针，创建后立即删除，均在 base 空间测量）：
  //    ① 左对齐艺术字：墨迹左边界 = 字体左侧边距，用于水平精确落位
  //    ② 高 1px 的超宽文本框：文字必然纵向溢出，可量出墨迹底部，用于垂直精确落位
  {
    const B = AddChildNodesCommandBuilder.create();
    for (const p of plan) {
      B.addNode(ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, p.probeSb));
      // 探针必须用「未缩放」的 story：layoutInk / dy 都是 base 空间未缩放量，框会整体 ×s
      B.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
        { x: 0, y: p.layoutInk.y, width: p.layoutInk.w * 4 + 3 * p.maxSize + 40, height: 1 }, p.probeSb));
    }
    const cmd = B.createCommand(false, NodeChildType.Main);
    doc.executeCommand(cmd);
    const n = cmd.newNodes.length;
    const probes = [];
    for (let k = 0; k < n; k++) probes.push(cmd.newNodes.at(k));

    for (let i = 0; i < plan.length; i++) {
      const artProbe = probes[n - 1 - (2 * i)];         // newNodes 后进先出，倒着取
      const frameProbe = probes[n - 2 - (2 * i)];
      if (artProbe) {
        const ai = inkOf(artProbe);
        plan[i].lsb = ai.x;                             // 未缩放字号下的左侧边距（base 空间）
        // 带变换时，base 空间宽度用探针实测的「可见墨迹宽」，而不是 baseBox 的逻辑宽
        //（后者略窄，临界情况下会让文本框换行）
        if (plan[i].tf) {
          plan[i].layoutInk.w = ai.w;
          plan[i].layoutInk.right = plan[i].layoutInk.x + ai.w;
        }
      }
      if (frameProbe) plan[i].dy = plan[i].layoutInk.bottom - inkOf(frameProbe).bottom;
    }
    deleteNodes(doc, probes);
  }

  // 3) 建 FrameText（按父节点分组，保持原层级）
  const groups = new Map();
  for (const p of plan) {
    const key = p.parent ? (p.parent.nodeId || 'root') : 'root';
    if (!groups.has(key)) groups.set(key, { parent: p.parent, items: [] });
    groups.get(key).items.push(p);
    layoutBox(p);
  }
  for (const g of groups.values()) createFrames(doc, g.items);

  // 4) 换行检测：文本框过窄导致换行时自动加宽重排
  for (let pass = 0; pass < CFG.maxWidenPasses; pass++) {
    const wrapped = plan.filter(isWrapped);
    if (!wrapped.length) break;
    if (CFG.verbose) console.log('[加宽] ' + wrapped.length + ' 个文本框过窄，自动加宽重排…');
    if (CFG.debug) for (const p of wrapped) {
      const r = frameRectOf(p.newNode), k = inkOf(p.newNode);
      console.log('   ↳ ' + JSON.stringify(p.plain.slice(0, 10)) + ' box(h' + round(p.box.height) + ') ink.bottom=' +
        round(k.bottom) + ' rect.bottom=' + round(r.bottom) + ' 溢出=' + round(k.bottom - r.bottom));
    }
    deleteNodes(doc, wrapped.map(p => p.newNode));
    for (const p of wrapped) {
      p.pad += Math.max(4, 0.18 * p.baseMaxSize) / (p.tf ? p.tf.sx : 1);
      p.widened = (p.widened || 0) + 1;
      layoutBox(p);
    }
    for (const g of groups.values()) {
      const need = g.items.filter(p => wrapped.indexOf(p) >= 0);
      if (need.length) createFrames(doc, need);
    }
  }

  // 5) 带变换的节点做位置校正（安全网，正常情况下不应触发）
  for (const g of groups.values()) for (const p of g.items) p.fixed = fixPosition(doc, p);
}

// 8) 汇报
function report(artPlan, framePlan) {
  if (!CFG.verbose) return;
  for (const p of artPlan) {
    const r = p.newNode ? frameRectOf(p.newNode) : { w: 0, h: 0 };
    const tfNote = p.tf ? ('  变换[缩放 ' + round(p.tf.sx) + '×' + round(p.tf.sy) +
      '  旋转 ' + round(p.tf.theta * 180 / Math.PI) + '°]' +
      (p.fixed ? ' 位置校正 ' + round(p.fixed) + 'px' : '')) : '';
    console.log('✓ 艺术字 → 文本框  字号 ' + round(p.maxSize) + '  段落 ' + p.paragraphs +
      '  墨迹 ' + round(p.ink.w) + '×' + round(p.ink.h) +
      '  → 文本框 ' + round(r ? r.w : 0) + '×' + round(r ? r.h : 0) +
      (p.tf ? '' : '  (宽 +' + round((r ? r.w : 0) - p.ink.w) + 'px)') +
      (p.widened ? ' 加宽 ' + p.widened + ' 次' : '') + tfNote +
      '  ' + JSON.stringify(p.plain.slice(0, 16)));
  }
  for (const p of framePlan) {
    console.log('✓ 文本框 → 艺术字  段落 ' + p.paragraphs +
      (p.wraps ? '  自动换行 ' + p.wraps + ' 处转为换行符' : '') +
      (p.sizeScale && p.sizeScale !== 1 ? '  字号 ×' + round(p.sizeScale) : '') +
      (p.residual !== null && p.residual !== undefined ? '  字形偏差 ' + round(p.residual) + 'px' : '  按包围盒对齐') +
      (p.overflow ? '  [注意] 原文本框有溢出隐藏的文字，现已全部显示' : '') +
      '  ' + JSON.stringify(p.plain.slice(0, 16)));
  }
  const n = artPlan.filter(p => p.newNode).length, m = framePlan.filter(p => p.newNode).length;
  console.log('完成：' + n + ' 个 ArtText → FrameText，' + m + ' 个 FrameText → ArtText');
}

main();
