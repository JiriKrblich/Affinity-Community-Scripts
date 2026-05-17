"use strict";

// Extrude Tool v3.8 - Affinity Designer
//
// v3 updates the v2 preview flow for MCP 3.2.1:
// - no repeated dialog show loop
// - live preview is rebuilt from dialog value-change handlers
// - preview commands are executed as preview state
// - createClearPreviews() clears preview geometry on every rebuild, cancel, and commit
// - OK clears previews first, then applies the final result once as normal history
// - v3.1 avoids reading/moving preview-created newNodes, which can crash Affinity
// - v3.2 capped preview complexity to avoid crashes during parameter adjustment
// - v3.3 removes the preview face-count cap by request
// - v3.4 explicitly executes rebuilt preview geometry as preview state
// - v3.5 shows the initial parameter preview immediately and inserts live preview behind the front object
// - v3.6 inserted live preview with a node target, which can nest geometry inside the selected shape
// - v3.7 uses an insertion target selection so the back object stays behind generated preview siblings
// - v3.8 keeps v3.7 logic and removes the version suffix from the dialog title

const { Document } = require("/document");
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder, InsertionMode, NodeChildType, NodeMoveType } = require("/commands");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

const doc = Document.current;

if (!doc) {
  alert("No document open.");
} else {
  const mkSel = n => Selection.create(doc, n);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpPt = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
  const lerpSeg = (a, b, t) => ({
    start: lerpPt(a.start, b.start, t),
    c1: lerpPt(a.c1, b.c1, t),
    c2: lerpPt(a.c2, b.c2, t),
    end: lerpPt(a.end, b.end, t)
  });

  function splitAt(seg, t) {
    const p0 = seg.start, p1 = seg.c1, p2 = seg.c2, p3 = seg.end;
    const a = lerpPt(p0, p1, t), b = lerpPt(p1, p2, t), c = lerpPt(p2, p3, t);
    const d = lerpPt(a, b, t), e = lerpPt(b, c, t), f = lerpPt(d, e, t);
    return {
      left: { start: p0, c1: a, c2: d, end: f },
      right: { start: f, c1: e, c2: c, end: p3 }
    };
  }

  function subdivide(segs, n) {
    if (n <= 1) return segs;
    const out = [];
    for (const seg of segs) {
      let rem = seg;
      for (let i = 0; i < n - 1; i++) {
        const parts = splitAt(rem, 1 / (n - i));
        out.push(parts.left);
        rem = parts.right;
      }
      out.push(rem);
    }
    return out;
  }

  function extractSegs(node) {
    try {
      const ci = node.curvesInterface;
      if (!ci) return null;
      const raw = ci.polyCurve;
      if (!raw || raw.curveCount === 0) return null;

      const pc = raw.clone();
      pc.transform(node.baseToSpreadTransform);

      const curve = pc.at(0);
      const segs = [];
      for (const b of curve.beziers) {
        segs.push({
          start: { x: b.start.x, y: b.start.y },
          c1: { x: b.c1.x, y: b.c1.y },
          c2: { x: b.c2.x, y: b.c2.y },
          end: { x: b.end.x, y: b.end.y }
        });
      }
      return segs.length > 0 ? { segs, closed: curve.isClosed, n: segs.length } : null;
    } catch (e) {
      return null;
    }
  }

  function bestAlign(segsA, segsB) {
    const n = segsA.length;
    if (n !== segsB.length || n === 0) return segsB;
    let bestRot = 0, bestDist = Infinity;
    for (let r = 0; r < n; r++) {
      let dist = 0;
      for (let i = 0; i < n; i++) {
        const a = segsA[i].start, b = segsB[(i + r) % n].start;
        dist += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestRot = r;
      }
    }
    return bestRot === 0 ? segsB : [...segsB.slice(bestRot), ...segsB.slice(0, bestRot)];
  }

  function approxPerimeter(segs) {
    let len = 0;
    for (const s of segs) {
      const chord = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
      const poly = Math.hypot(s.c1.x - s.start.x, s.c1.y - s.start.y) +
        Math.hypot(s.c2.x - s.c1.x, s.c2.y - s.c1.y) +
        Math.hypot(s.end.x - s.c2.x, s.end.y - s.c2.y);
      len += (chord + poly) / 2;
    }
    return len;
  }

  function segsCenter(segs) {
    let cx = 0, cy = 0;
    for (const s of segs) {
      cx += s.start.x;
      cy += s.start.y;
    }
    return { x: cx / segs.length, y: cy / segs.length };
  }

  function approxSegLen(s) {
    return (Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) +
      Math.hypot(s.c1.x - s.start.x, s.c1.y - s.start.y) +
      Math.hypot(s.c2.x - s.c1.x, s.c2.y - s.c1.y) +
      Math.hypot(s.end.x - s.c2.x, s.end.y - s.c2.y)) / 2;
  }

  function resampleToCount(segs, targetN) {
    const result = segs.map(s => ({ ...s }));
    while (result.length < targetN) {
      let maxLen = -1, maxIdx = 0;
      for (let i = 0; i < result.length; i++) {
        const l = approxSegLen(result[i]);
        if (l > maxLen) {
          maxLen = l;
          maxIdx = i;
        }
      }
      const parts = splitAt(result[maxIdx], 0.5);
      result.splice(maxIdx, 1, parts.left, parts.right);
    }
    return result;
  }

  function facePC(sA, sB) {
    const cb = CurveBuilder.create();
    cb.beginXY(sA.start.x, sA.start.y);
    cb.addBezierXY(sA.c1.x, sA.c1.y, sA.c2.x, sA.c2.y, sA.end.x, sA.end.y);
    cb.lineToXY(sB.end.x, sB.end.y);
    cb.addBezierXY(sB.c2.x, sB.c2.y, sB.c1.x, sB.c1.y, sB.start.x, sB.start.y);
    cb.close();
    const pc = new PolyCurve();
    pc.addCurve(cb.createCurve());
    return pc;
  }

  function mkNode(poly, fill, strokeFill, lsd) {
    return PolyCurveNodeDefinition.create(poly, fill, lsd, strokeFill, FillDescriptor.createNone());
  }

  function faceSignedArea(sA, sB) {
    const pts = [sA.start, sA.end, sB.end, sB.start];
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const p = pts[k], q = pts[(k + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    return area / 2;
  }

  function pathSignedArea(segs) {
    let area = 0;
    for (const s of segs) area += s.start.x * s.end.y - s.end.x * s.start.y;
    return area / 2;
  }

  const rawSel = doc.selection.nodes.toArray().filter(Boolean);

  if (rawSel.length < 2) {
    alert("Select at least 2 shapes.");
  } else {
    let shapes = rawSel.map(n => {
      const d = extractSegs(n);
      return d ? { node: n, d } : null;
    }).filter(Boolean);

    if (shapes.length < 2) {
      alert("Could not read curves. Select vector shapes.");
    } else {
      const maxN = Math.max(...shapes.map(s => s.d.n));
      shapes = shapes.map(sh => {
        if (sh.d.n < maxN) {
          const resampled = resampleToCount(sh.d.segs, maxN);
          return { node: sh.node, d: { segs: resampled, closed: sh.d.closed, n: maxN } };
        }
        return sh;
      });

      const scored = shapes.map(sh => {
        const perim = approxPerimeter(sh.d.segs);
        let zRank = 0;
        try {
          let p = sh.node.previousSibling;
          while (p) {
            zRank++;
            p = p.previousSibling;
          }
        } catch (e) {}
        return { sh, perim, zRank };
      });
      const maxP = Math.max(...scored.map(d => d.perim)) || 1;
      const maxZ = Math.max(...scored.map(d => d.zRank)) || 1;
      scored.sort((a, b) => {
        const sa = (a.perim / maxP) * 0.6 + (a.zRank / maxZ) * 0.4;
        const sb = (b.perim / maxP) * 0.6 + (b.zRank / maxZ) * 0.4;
        return sb - sa;
      });
      shapes = scored.map(d => d.sh);

      main(shapes);
    }
  }

  function main(shapes) {
    const historyStart = doc.history.position;

    function restoreHistoryStart() {
      if (doc.history.position !== historyStart) {
        doc.history.position = historyStart;
      }
    }

    function getActive(swap) {
      const base = swap ? [...shapes].reverse() : shapes;
      const active = base.map(sh => ({
        node: sh.node,
        d: { segs: [...sh.d.segs], closed: sh.d.closed, n: sh.d.n }
      }));
      if (active[0].d.closed) {
        for (let i = 1; i < active.length; i++) {
          active[i].d.segs = bestAlign(active[i - 1].d.segs, active[i].d.segs);
        }
      }
      return active;
    }

    function build(active, p) {
      const allFaces = [];
      const sub = active.map(sh => ({ segs: subdivide(sh.d.segs, p.subdivs) }));
      const subN = sub[0].segs.length;
      const cFront = segsCenter(active[0].d.segs), cBack = segsCenter(active[active.length - 1].d.segs);
      const exDx = cBack.x - cFront.x, exDy = cBack.y - cFront.y;
      const exLen = Math.hypot(exDx, exDy) || 1;
      const exNx = exDx / exLen, exNy = exDy / exLen;

      for (let s = 0; s < sub.length - 1; s++) {
        const A = sub[s].segs, B = sub[s + 1].segs;
        for (let k = 0; k < p.steps; k++) {
          const t0 = k / p.steps, t1 = (k + 1) / p.steps;
          const slA = A.map((a, i) => lerpSeg(a, B[i], t0));
          const slB = A.map((a, i) => lerpSeg(a, B[i], t1));
          for (let i = 0; i < subN; i++) {
            const cx = (slA[i].start.x + slA[i].end.x + slB[i].start.x + slB[i].end.x) / 4;
            const cy = (slA[i].start.y + slA[i].end.y + slB[i].start.y + slB[i].end.y) / 4;
            allFaces.push({ pc: facePC(slA[i], slB[i]), depth: cx * exNx + cy * exNy, sa: faceSignedArea(slA[i], slB[i]) });
          }
        }
      }
      return { allFaces };
    }

    function splitFaces(allFaces, active) {
      const psa = pathSignedArea(active[0].d.segs);
      const fs = psa > 0 ? -1 : 1;
      return {
        frontFaces: allFaces.filter(f => f.sa * fs >= 0),
        backFaces: allFaces.filter(f => f.sa * fs < 0)
      };
    }

    function makeDefs(faces, fill, stroke, lsd) {
      return [...faces].sort((a, b) => a.depth - b.depth).map(f => mkNode(f.pc, fill, stroke, lsd));
    }

    function readStyle(node, opacity) {
      const f = opacity / 100;
      let fill = FillDescriptor.createNone();
      try {
        const bfd = node.brushFillDescriptor;
        if (bfd && bfd.type !== "none" && bfd.fill && bfd.fill.colour) {
          const c = bfd.fill.colour.rgba8;
          fill = FillDescriptor.createSolid(RGBA8(c.r, c.g, c.b, Math.min(255, Math.round(c.alpha * f))), BlendMode.Normal);
        }
      } catch (e) {}

      let stroke = FillDescriptor.createNone();
      try {
        const pfd = node.penFillDescriptor;
        if (pfd && pfd.type !== "none") stroke = pfd;
      } catch (e) {}

      let lsd = null;
      try {
        lsd = node.lineStyleDescriptor;
      } catch (e) {}
      if (!lsd) lsd = LineStyleDescriptor.createDefault(4.166);

      return { fill, stroke, lsd };
    }

    function buildFaceDefinitions(active, p) {
      const mainNode = active[0].node;
      const secNode = active[active.length - 1].node;
      const built = build(active, p);
      const split = splitFaces(built.allFaces, active);
      const style = readStyle(mainNode, p.opacity);
      const fDefs = makeDefs(split.frontFaces, style.fill, style.stroke, style.lsd);
      const bDefs = makeDefs(split.backFaces, style.fill, style.stroke, style.lsd);
      const F = fDefs.length, B = bDefs.length;

      if (F === 0 && B === 0) return null;

      return { mainNode, secNode, fDefs, bDefs, F, B };
    }

    function createPreviewAddCommand(active, p) {
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) return null;

      const allDefs = [...faceDefs.bDefs, ...faceDefs.fDefs];

      const addBuilder = AddChildNodesCommandBuilder.create();
      addBuilder.setInsertionTargetSelection(mkSel(faceDefs.secNode));
      addBuilder.setInsertionMode(InsertionMode.Top);
      allDefs.forEach(d => addBuilder.addNode(d));

      return addBuilder.createCommand(false, NodeChildType.Main);
    }

    function createFinalCommands(active, p) {
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) return null;

      const mainNode = faceDefs.mainNode;
      const secNode = faceDefs.secNode;
      const fDefs = faceDefs.fDefs;
      const bDefs = faceDefs.bDefs;
      const F = faceDefs.F;
      const B = faceDefs.B;
      const parentNode = secNode.parent;

      const addBuilder = AddChildNodesCommandBuilder.create();
      if (parentNode && !parentNode.isSpreadNode) addBuilder.setInsertionTarget(parentNode);
      addBuilder.addContainerNode(ContainerNodeDefinition.create("Back"));
      addBuilder.addContainerNode(ContainerNodeDefinition.create("Front"));
      fDefs.forEach(d => addBuilder.addNode(d));
      bDefs.forEach(d => addBuilder.addNode(d));
      const addCmd = addBuilder.createCommand(false, NodeChildType.Main);

      return { addCmd, moveFinal: addCmdExecuted => {
        const frontCont = addCmdExecuted.newNodes[B + F];
        const backCont = addCmdExecuted.newNodes[B + F + 1];
        const compound = CompoundCommandBuilder.create();

        if (p.swap) {
          compound.addCommand(DocumentCommand.createMoveNodes(mkSel(mainNode), secNode, NodeMoveType.After, NodeChildType.Main));
        }
        for (let i = B + F - 1; i >= B; i--) {
          compound.addCommand(DocumentCommand.createMoveNodes(mkSel(addCmdExecuted.newNodes[i]), frontCont, NodeMoveType.Inside, NodeChildType.Main));
        }
        for (let i = B - 1; i >= 0; i--) {
          compound.addCommand(DocumentCommand.createMoveNodes(mkSel(addCmdExecuted.newNodes[i]), backCont, NodeMoveType.Inside, NodeChildType.Main));
        }
        compound.addCommand(DocumentCommand.createMoveNodes(mkSel(frontCont), secNode, NodeMoveType.After, NodeChildType.Main));
        compound.addCommand(DocumentCommand.createMoveNodes(mkSel(backCont), secNode, NodeMoveType.After, NodeChildType.Main));
        for (let i = 0; i < F; i++) {
          compound.addCommand(DocumentCommand.createSetDescription(mkSel(addCmdExecuted.newNodes[B + i]), `curve${i + 1}`));
        }
        for (let i = 0; i < B; i++) {
          compound.addCommand(DocumentCommand.createSetDescription(mkSel(addCmdExecuted.newNodes[i]), `curve${F + 1 + i}`));
        }

        return compound.createCommand();
      }};
    }

    function doPreview(p) {
      const active = getActive(p.swap);
      const addCmd = createPreviewAddCommand(active, p);
      if (!addCmd) return;

      doc.executeCommand(addCmd, true);
    }

    function doApply(p) {
      const active = getActive(p.swap);
      const commands = createFinalCommands(active, p);
      if (!commands) {
        alert("No geometry generated.");
        return;
      }

      doc.executeCommand(commands.addCmd);
      doc.executeCommand(commands.moveFinal(commands.addCmd));
    }

    const dlg = Dialog.create("Extrude Tool");
    dlg.initialWidth = 340;
    const col = dlg.addColumn();

    const gBlend = col.addGroup("Blend");
    const eSteps = gBlend.addUnitValueEditor("Steps", "", "", 1, 1, 20);
    eSteps.precision = 0;
    eSteps.showPopupSlider = false;
    const eSubdivs = gBlend.addUnitValueEditor("Smoothness", "", "", 5, 1, 16);
    eSubdivs.precision = 0;
    eSubdivs.showPopupSlider = false;

    const gStyle = col.addGroup("Style");
    const eOp = gStyle.addUnitValueEditor("Opacity (%)", "", "%", 100, 0, 100);
    eOp.precision = 0;
    eOp.showPopupSlider = false;

    const gOpts = col.addGroup("Options");
    const sSwap = gOpts.addSwitch("Swap Main/Secondary", false);

    const getP = () => ({
      steps: Math.max(1, Math.round(eSteps.value)),
      subdivs: Math.max(1, Math.round(eSubdivs.value)),
      opacity: eOp.value,
      swap: sSwap.value
    });

    let inPreview = false;

    function applyPreview() {
      if (inPreview) return;
      inPreview = true;
      try {
        doc.executeCommand(DocumentCommand.createClearPreviews());
        doPreview(getP());
      } finally {
        inPreview = false;
      }
    }

    eSteps.onValueChangedHandler = applyPreview;
    eSubdivs.onValueChangedHandler = applyPreview;
    eOp.onValueChangedHandler = applyPreview;
    sSwap.onValueChangedHandler = applyPreview;

    applyPreview();

    const result = dlg.show();
    const finalValues = getP();

    doc.executeCommand(DocumentCommand.createClearPreviews());
    restoreHistoryStart();

    if (result.value === DialogResult.Ok.value) {
      doApply(finalValues);
    }
  }
}
