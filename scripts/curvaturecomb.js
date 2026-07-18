/**
 * name: Curvature Comb (曲率梳)
 * description: Select 1 curve object, then run. Generates a curvature comb for curve quality analysis.
 * version: 1.0.1
 * author: Moryn Sun
 */

"use strict";

// ============================================================
// 曲率梳 v1.0 —— 曲线质量分析工具
//
// 用法：在 Affinity 中选中一条矢量曲线，运行本脚本。
// 脚本沿曲线按弧长等距采样，在每个采样点计算符号曲率
//   κ = (x'y'' − y'x'') / (x'² + y'²)^1.5
// 并沿法线方向画出与 κ 成比例的梳齿，外加一条包络线，
// 全部放进一个新 Group，不改动原曲线。
//
// 所有 API 用法均逐字对齐你机器上已验证可运行的
// Blend Tool v2.0.0 与 rename-artboards.js。
// ============================================================

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const {
  PolyCurveNodeDefinition,
  ContainerNodeDefinition,
  NodeChildType,
} = require("/nodes");
const { AddChildNodesCommandBuilder } = require("/commands");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyle, LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");
const { UnitType } = require("/units");

// ── 基础数学 ────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpPt(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }; }
function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }

const ARC_SAMPLE_STEPS = 64; // 弧长表每段 bezier 的细分步数

// 三次 Bezier 求值：B(t)
function evalBez(b, t) {
  const u = 1 - t;
  return {
    x: u*u*u*b.start.x + 3*u*u*t*b.c1.x + 3*u*t*t*b.c2.x + t*t*t*b.end.x,
    y: u*u*u*b.start.y + 3*u*u*t*b.c1.y + 3*u*t*t*b.c2.y + t*t*t*b.end.y,
  };
}

// 一阶导 B'(t) = 3(1-t)²(c1-p0) + 6(1-t)t(c2-c1) + 3t²(p3-c2)
function bezD1(b, t) {
  const u = 1 - t;
  return {
    x: 3*u*u*(b.c1.x - b.start.x) + 6*u*t*(b.c2.x - b.c1.x) + 3*t*t*(b.end.x - b.c2.x),
    y: 3*u*u*(b.c1.y - b.start.y) + 6*u*t*(b.c2.y - b.c1.y) + 3*t*t*(b.end.y - b.c2.y),
  };
}

// 二阶导 B''(t) = 6(1-t)(c2-2c1+p0) + 6t(p3-2c2+c1)
function bezD2(b, t) {
  const u = 1 - t;
  return {
    x: 6*u*(b.c2.x - 2*b.c1.x + b.start.x) + 6*t*(b.end.x - 2*b.c2.x + b.c1.x),
    y: 6*u*(b.c2.y - 2*b.c1.y + b.start.y) + 6*t*(b.end.y - 2*b.c2.y + b.c1.y),
  };
}

// 符号曲率 κ = (x'y'' − y'x'') / |B'|³
// 端点处 B' 可能退化（c1 与锚点重合），此时把 t 微移后重算。
function signedCurvature(b, t) {
  let d1 = bezD1(b, t);
  let len2 = d1.x*d1.x + d1.y*d1.y;
  if (len2 < 1e-12) {
    const t2 = t < 0.5 ? t + 1e-4 : t - 1e-4;
    d1 = bezD1(b, t2);
    len2 = d1.x*d1.x + d1.y*d1.y;
    if (len2 < 1e-12) return { kappa: 0, tangent: null };
    const d2b = bezD2(b, t2);
    return {
      kappa: (d1.x*d2b.y - d1.y*d2b.x) / Math.pow(len2, 1.5),
      tangent: d1,
    };
  }
  const d2 = bezD2(b, t);
  return {
    kappa: (d1.x*d2.y - d1.y*d2.x) / Math.pow(len2, 1.5),
    tangent: d1,
  };
}

// ── 世界坐标转换（照抄 Blend Tool） ─────────────────────────
function bezToWorld(xf, seg) {
  return {
    start: xf.applyToPoint(seg.start),
    c1: xf.applyToPoint(seg.c1),
    c2: xf.applyToPoint(seg.c2),
    end: xf.applyToPoint(seg.end),
  };
}

// ── PolyCurve 子曲线遍历（照抄 Blend Tool 的容错写法） ──────
function polyCurveAt(pc, index) {
  if (!pc || typeof pc.at !== "function") return null;
  try {
    const curve = pc.at(index);
    return curve && curve.beziers ? curve : null;
  } catch (e) {
    return null;
  }
}
function polyCurveCount(pc) {
  if (!pc) return 0;
  let reported = null;
  try {
    if (typeof pc.curveCount === "number") reported = pc.curveCount;
    else if (typeof pc.curveCount === "function") reported = pc.curveCount();
    else if (typeof pc.count === "number") reported = pc.count;
    else if (typeof pc.count === "function") reported = pc.count();
    else if (typeof pc.length === "number") reported = pc.length;
  } catch (e) { reported = null; }
  if (reported && reported > 0) return reported;
  if (!polyCurveAt(pc, 0)) return 0;
  let n = 0, prev = null;
  for (; n < 2048; n++) {
    const curve = polyCurveAt(pc, n);
    if (!curve || curve === prev) break;
    prev = curve;
  }
  return Math.max(1, n);
}

// 取选中对象的全部子曲线（世界坐标）
// 返回 [{ bez: [...], isClosed: bool }, ...]
function getWorldSubcurves(node) {
  const xf = node.transformInterface.transform;
  const pc = node.polyCurve;
  const subs = [];
  const total = polyCurveCount(pc);
  for (let i = 0; i < total; i++) {
    const curve = polyCurveAt(pc, i);
    if (!curve) continue;
    const bez = [...curve.beziers].map((s) => bezToWorld(xf, s));
    if (bez.length) subs.push({ bez, isClosed: curve.isClosed });
  }
  return subs;
}

// ── 选区节点解析 ────────────────────────────────────────────
// rename-artboards 用 sel.at(i).node 可用；Blend Tool 证明
// 有些环境 sel.at(i) 本身就是节点。两种都试。
function resolveNode(item) {
  if (!item) return null;
  try {
    if (item.node && item.node.polyCurve) return item.node;
  } catch (e) {}
  try {
    if (item.polyCurve) return item;
  } catch (e) {}
  try {
    if (item.node) return item.node;
  } catch (e) {}
  return item;
}

function hasCurveData(node) {
  try {
    return !!node && !!node.polyCurve &&
      polyCurveCount(node.polyCurve) > 0 && !!node.transformInterface;
  } catch (e) { return false; }
}

// ── 弧长表与均匀采样 ────────────────────────────────────────
// 对一个子曲线（bezier 数组）建弧长表；
// 每条记录 { bi, t, cum }，与 Blend Tool 的 buildArcTable 同构。
function buildArcTable(beziers) {
  const tbl = [];
  let cum = 0;
  for (let bi = 0; bi < beziers.length; bi++) {
    const b = beziers[bi];
    let prev = evalBez(b, 0);
    if (bi === 0) tbl.push({ bi, t: 0, cum: 0 });
    for (let s = 1; s <= ARC_SAMPLE_STEPS; s++) {
      const t = s / ARC_SAMPLE_STEPS;
      const pt = evalBez(b, t);
      cum += dist(pt, prev);
      tbl.push({ bi, t, cum });
      prev = pt;
    }
  }
  return tbl;
}

// 按弧长比例 frac ∈ [0,1] 反查参数位置 { bi, t }
function paramAtFrac(tbl, frac) {
  const total = tbl[tbl.length - 1].cum;
  const c = Math.min(Math.max(frac, 0), 1) * total;
  let lo = 0, hi = tbl.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid].cum <= c) lo = mid;
    else hi = mid;
  }
  const a = tbl[lo], b = tbl[hi];
  const span = b.cum - a.cum;
  const f = span < 1e-9 ? 0 : (c - a.cum) / span;
  // 跨 bezier 边界时取占比更大的那段，t 在段内插值
  if (a.bi === b.bi) return { bi: a.bi, t: a.t + (b.t - a.t) * f };
  return f < 0.5 ? { bi: a.bi, t: a.t + (1 - a.t) * f * 2 }
                 : { bi: b.bi, t: b.t * (f - 0.5) * 2 };
}

// 对一个子曲线做 n 个等弧长采样，返回
// [{ pos, normal, kappa }]；normal 为单位法向（切向左转 90°）
function sampleSubcurve(sub, n) {
  const tbl = buildArcTable(sub.bez);
  const total = tbl[tbl.length - 1].cum;
  if (total < 1e-9) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    // 闭合曲线不重复首尾；开放曲线包含两端
    const frac = sub.isClosed ? i / n : i / (n - 1);
    const { bi, t } = paramAtFrac(tbl, frac);
    const b = sub.bez[bi];
    const pos = evalBez(b, t);
    const { kappa, tangent } = signedCurvature(b, t);
    if (!tangent) { out.push({ pos, normal: null, kappa: 0 }); continue; }
    const tl = Math.hypot(tangent.x, tangent.y);
    // 单位法向：切向 (tx,ty) 左转 90° → (-ty, tx)
    out.push({
      pos,
      normal: { x: -tangent.y / tl, y: tangent.x / tl },
      kappa,
    });
  }
  return out;
}

// ── 生成描边节点定义（照抄 Blend Tool makeDef 结构） ────────
// subPaths: [{ bez: [...], isClosed }], 生成一个无填充纯描边节点
function makeStrokedDef(subPaths, name, rgba, weight) {
  const pc = PolyCurve.create();
  for (const sp of subPaths) {
    if (!sp.bez.length) continue;
    const builder = CurveBuilder.create();
    builder.begin(sp.bez[0].start);
    for (const b of sp.bez) builder.addBezier(b.c1, b.c2, b.end);
    if (sp.isClosed) builder.close();
    pc.addCurve(builder.createCurve());
  }
  const def = PolyCurveNodeDefinition.createDefault();
  def.setCurves(pc);
  def.setBrushFillDescriptor(FillDescriptor.createNone(), 0);
  def.setLineDescriptors(
    FillDescriptor.createSolid(RGBA8(rgba[0], rgba[1], rgba[2], rgba[3]), BlendMode.Normal),
    LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(weight)),
    0,
  );
  def.userDescription = name;
  return def;
}

// 两点直线段表达成 bezier（控制点在 1/3、2/3 处）
function lineBez(p, q) {
  return { start: p, c1: lerpPt(p, q, 1/3), c2: lerpPt(p, q, 2/3), end: q };
}

// ── 错误弹窗 ────────────────────────────────────────────────
function showError(msg) {
  const d = Dialog.create("曲率梳");
  d.initialWidth = 420;
  const col = d.addColumn();
  const grp = col.addGroup("错误");
  const txt = grp.addStaticText("", msg);
  txt.isFullWidth = true;
  d.runModal();
}

function dialogOk(result) {
  try {
    if (result && DialogResult.Ok && result.value !== undefined) {
      return result.value === DialogResult.Ok.value;
    }
  } catch (e) {}
  return result === DialogResult.Ok;
}

// ════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════
function main() {
  console.log("[comb] 脚本启动");

  const doc = Document.current;
  if (!doc) { showError("没有打开的文档。"); return; }

  // ---- 读取选区 ----
  const sel = doc.selection;
  if (!sel || sel.length < 1) {
    showError("请先选中一条矢量曲线，再运行脚本。");
    return;
  }
  const node = resolveNode(sel.at(0));
  if (!hasCurveData(node)) {
    showError("选中对象不是可编辑曲线（需要 Curve / 形状转曲后的对象）。");
    return;
  }
  const nodeName = node.userDescription || node.defaultDescription || "Curve";
  const subs = getWorldSubcurves(node);
  if (!subs.length) {
    showError("选中曲线没有可用的 bezier 段。");
    return;
  }
  console.log("[comb] 曲线 \"" + nodeName + "\": " + subs.length + " 条子曲线");

  // ---- 参数对话框 ----
  const dlg = Dialog.create("曲率梳");
  dlg.initialWidth = 380;
  const col = dlg.addColumn();

  const gS = col.addGroup("采样");
  const samplesCtrl = gS.addUnitValueEditor("采样点数", UnitType.Number, UnitType.Number, 120, 8, 2000);
  samplesCtrl.precision = 0;
  samplesCtrl.showPopupSlider = true;

  const gL = col.addGroup("梳齿");
  const lenCtrl = gL.addUnitValueEditor("最大齿长 (px)", UnitType.Number, UnitType.Number, 60, 1, 5000);
  lenCtrl.precision = 0;
  lenCtrl.showPopupSlider = true;
  const flipCtrl = gL.addSwitch("翻转方向", false);
  const signedCtrl = gL.addSwitch("按曲率符号分侧（显示拐点）", true);
  const scaleMode = gL.addComboBox("长度映射", [
    "线性（齿长 ∝ κ）",
    "平方根（压缩高曲率差异）",
  ], 0);

  const gE = col.addGroup("包络线");
  const envCtrl = gE.addSwitch("生成包络线", true);

  const gI = col.addGroup("信息");
  const infoTxt = gI.addStaticText("", "目标: " + nodeName + "（" + subs.length + " 条子曲线）");
  infoTxt.isFullWidth = true;

  const result = dlg.runModal();
  console.log("[comb] runModal 返回 value=" +
    (result && result.value !== undefined ? result.value : String(result)));
  if (!dialogOk(result)) {
    console.log("[comb] 用户取消");
    return;
  }

  const nSamples = Math.max(8, Math.min(2000, Math.round(Number(samplesCtrl.value)) || 120));
  const maxLen = Math.max(1, Number(lenCtrl.value) || 60);
  // Affinity 文档 Y 轴朝下，基准方向取反才符合直觉；开关打开则再翻回去
  const flip = flipCtrl.value ? 1 : -1;
  const useSigned = signedCtrl.value;
  const useSqrt = scaleMode.selectedIndex === 1;
  const drawEnvelope = envCtrl.value;

  try {
    // ---- 采样与曲率计算 ----
    // 采样数按子曲线长度比例分配，每条至少 8 个
    const lengths = subs.map((s) => {
      const t = buildArcTable(s.bez);
      return t[t.length - 1].cum;
    });
    const totalLen = lengths.reduce((a, v) => a + v, 0);
    if (totalLen < 1e-9) { showError("曲线长度为 0。"); return; }

    const allSamples = []; // 每条子曲线一个数组
    let kMax = 0;
    for (let i = 0; i < subs.length; i++) {
      const n = Math.max(8, Math.round(nSamples * (lengths[i] / totalLen)));
      const samples = sampleSubcurve(subs[i], n);
      for (const s of samples) kMax = Math.max(kMax, Math.abs(s.kappa));
      allSamples.push(samples);
    }
    console.log("[comb] κmax = " + kMax);
    if (kMax < 1e-12) {
      showError("该曲线曲率处处接近 0（近似直线），没有可显示的梳齿。");
      return;
    }

    // ---- 生成梳齿与包络 ----
    const teethBez = [];        // 所有齿：开放直线段
    const envelopeSubs = [];    // 每条子曲线一条包络折线
    for (let i = 0; i < subs.length; i++) {
      const tips = [];
      for (const s of allSamples[i]) {
        if (!s.normal) { tips.push(s.pos); continue; }
        let ratio = Math.abs(s.kappa) / kMax;
        if (useSqrt) ratio = Math.sqrt(ratio);
        // 符号模式：齿的方向随 κ 符号翻转，拐点处梳齿换边
        const side = useSigned ? Math.sign(s.kappa) || 1 : 1;
        const L = ratio * maxLen * side * flip;
        const tip = { x: s.pos.x + s.normal.x * L, y: s.pos.y + s.normal.y * L };
        tips.push(tip);
        if (ratio * maxLen > 0.25) teethBez.push(lineBez(s.pos, tip));
      }
      if (drawEnvelope && tips.length > 1) {
        const envBez = [];
        for (let k = 0; k < tips.length - 1; k++) envBez.push(lineBez(tips[k], tips[k + 1]));
        if (subs[i].isClosed) envBez.push(lineBez(tips[tips.length - 1], tips[0]));
        envelopeSubs.push({ bez: envBez, isClosed: subs[i].isClosed });
      }
    }
    console.log("[comb] 梳齿 " + teethBez.length + " 根");

    // ---- 插入文档：Group( 齿 + 包络 ) ----
    // 与 Blend Tool 的 execVectorBlend 相同的两步命令模式
    const cb = AddChildNodesCommandBuilder.create();
    cb.addContainerNode(ContainerNodeDefinition.create("Curvature Comb: " + nodeName));
    const ccmd = cb.createCommand(false, NodeChildType.Main);
    doc.executeCommand(ccmd);
    const group = ccmd.newNodes[0];

    const ch = AddChildNodesCommandBuilder.create();
    ch.setInsertionTarget(group);
    // 所有齿放进同一个 PolyCurve 节点（每根齿一条子曲线），
    // 避免生成几百个独立图层
    ch.addNode(makeStrokedDef(
      teethBez.map((b) => ({ bez: [b], isClosed: false })),
      "Comb Teeth", [255, 60, 60, 255], 0.5,
    ));
    if (drawEnvelope && envelopeSubs.length) {
      ch.addNode(makeStrokedDef(envelopeSubs, "Comb Envelope", [60, 120, 255, 255], 1));
    }
    doc.executeCommand(ch.createCommand(false, NodeChildType.Main));

    console.log("[comb] 完成：已插入 Group \"Curvature Comb: " + nodeName + "\"");
  } catch (e) {
    console.log("[comb] 失败: " + e.message + "\n" + e.stack);
    showError("生成失败: " + e.message);
  }
}

main();
