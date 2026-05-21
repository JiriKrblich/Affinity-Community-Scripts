"use strict";

// Extrude Tool v4.9b - Affinity Designer
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
// - v4 adds Bevel Perimeter (%) for an outer bevel band around the front and back profiles
// - v4.1 keeps the v4 bevel geometry, defaults bevel to 0, and separates bevel output into dedicated containers
// - v4.2 always places the Front Bevel container above all generated containers
// - v4.4 keeps the v4.2 container sorting and removes the 60% bevel cap
// - v4.5 adds a Bevel Preserve Bounds toggle that keeps bevel output inside the selected objects' bounding box
// - v4.6 lets Steps segment the bevel bands too, and applies final output in one undo step
// - v4.7 restores the v4.5 container output system while keeping v4.6 bevel step segmentation
// - v4.8 separates Bevel activation from three bevel amount controls: center, high-z to low-z, and low-z to high-z
// - v4.9a keeps the v4.8 container output, defaults the Bevel switch on, and keeps bevel inactive while all amounts are 0
// - v4.9b keeps containers but batches all final organization into one compound command, minimising undo steps

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
const BEVEL_EDITOR_MAX = 10000;

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
  const scalePtFromCenter = (p, c, scale) => ({
    x: c.x + (p.x - c.x) * scale,
    y: c.y + (p.y - c.y) * scale
  });
  const scaleSegFromCenter = (seg, center, scale) => ({
    start: scalePtFromCenter(seg.start, center, scale),
    c1: scalePtFromCenter(seg.c1, center, scale),
    c2: scalePtFromCenter(seg.c2, center, scale),
    end: scalePtFromCenter(seg.end, center, scale)
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

  function scaleSegsFromCenter(segs, center, scale) {
    return segs.map(seg => scaleSegFromCenter(seg, center, scale));
  }

  function addPointToBounds(bounds, p) {
    bounds.minX = Math.min(bounds.minX, p.x);
    bounds.minY = Math.min(bounds.minY, p.y);
    bounds.maxX = Math.max(bounds.maxX, p.x);
    bounds.maxY = Math.max(bounds.maxY, p.y);
  }

  function boundsFromSegGroups(segGroups) {
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const segs of segGroups) {
      for (const seg of segs) {
        addPointToBounds(bounds, seg.start);
        addPointToBounds(bounds, seg.c1);
        addPointToBounds(bounds, seg.c2);
        addPointToBounds(bounds, seg.end);
      }
    }
    return bounds;
  }

  function boundsCenter(bounds) {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    };
  }

  function fitScaleForBounds(segGroups, bounds, anchor) {
    let scale = 1;
    const EPS = 0.0001;
    const checkPoint = p => {
      if (p.x > bounds.maxX && p.x > anchor.x + EPS) scale = Math.min(scale, (bounds.maxX - anchor.x) / (p.x - anchor.x));
      if (p.x < bounds.minX && p.x < anchor.x - EPS) scale = Math.min(scale, (bounds.minX - anchor.x) / (p.x - anchor.x));
      if (p.y > bounds.maxY && p.y > anchor.y + EPS) scale = Math.min(scale, (bounds.maxY - anchor.y) / (p.y - anchor.y));
      if (p.y < bounds.minY && p.y < anchor.y - EPS) scale = Math.min(scale, (bounds.minY - anchor.y) / (p.y - anchor.y));
    };

    for (const segs of segGroups) {
      for (const seg of segs) {
        checkPoint(seg.start);
        checkPoint(seg.c1);
        checkPoint(seg.c2);
        checkPoint(seg.end);
      }
    }

    return Math.max(0.001, Math.min(1, scale));
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

    function addFacesBetween(faceList, A, B, exNx, exNy) {
      const n = Math.min(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const cx = (A[i].start.x + A[i].end.x + B[i].start.x + B[i].end.x) / 4;
        const cy = (A[i].start.y + A[i].end.y + B[i].start.y + B[i].end.y) / 4;
        faceList.push({ pc: facePC(A[i], B[i]), depth: cx * exNx + cy * exNy, sa: faceSignedArea(A[i], B[i]) });
      }
    }

    function nodeZRank(node) {
      let zRank = 0;
      try {
        let p = node.previousSibling;
        while (p) {
          zRank++;
          p = p.previousSibling;
        }
      } catch (e) {}
      return zRank;
    }

    function bevelIsActive(p) {
      return p.bevelEnabled && Math.max(p.bevelCenter, p.bevelHighToLow, p.bevelLowToHigh) > 0;
    }

    function profileBevelAmount(active, index, p, zRanks) {
      if (!bevelIsActive(p)) return 0;

      const zMin = Math.min(...zRanks);
      const zMax = Math.max(...zRanks);
      let highT = 0.5;
      if (zMax > zMin) {
        highT = (zRanks[index] - zMin) / (zMax - zMin);
      } else if (active.length > 1) {
        highT = 1 - index / (active.length - 1);
      }

      const lowT = 1 - highT;
      return p.bevelCenter + p.bevelHighToLow * highT + p.bevelLowToHigh * lowT;
    }

    function build(active, p) {
      const sideFaces = [];
      const frontBevelFaces = [];
      const backBevelFaces = [];
      const cFront = segsCenter(active[0].d.segs), cBack = segsCenter(active[active.length - 1].d.segs);
      const exDx = cBack.x - cFront.x, exDy = cBack.y - cFront.y;
      const exLen = Math.hypot(exDx, exDy) || 1;
      const exNx = exDx / exLen, exNy = exDy / exLen;
      const bevelOn = bevelIsActive(p);
      const zRanks = active.map(sh => nodeZRank(sh.node));
      let profiles = active.map((sh, index) => {
        const center = segsCenter(sh.d.segs);
        const amount = profileBevelAmount(active, index, p, zRanks);
        const bevelScale = amount > 0 ? 1 + amount / 100 : 1;
        const sideSegs = bevelScale > 1 ? scaleSegsFromCenter(sh.d.segs, center, bevelScale) : sh.d.segs;
        return {
          base: subdivide(sh.d.segs, p.subdivs),
          side: subdivide(sideSegs, p.subdivs)
        };
      });

      if (bevelOn && p.preserveBevelBounds) {
        const selectedBounds = boundsFromSegGroups(active.map(sh => sh.d.segs));
        const anchor = boundsCenter(selectedBounds);
        const fitScale = fitScaleForBounds(profiles.map(profile => profile.side), selectedBounds, anchor);
        if (fitScale < 1) {
          profiles = profiles.map(profile => ({
            base: profile.base,
            side: scaleSegsFromCenter(profile.side, anchor, fitScale)
          }));
        }
      }

      const subN = profiles[0].side.length;

      if (bevelOn) {
        const bevelSteps = Math.max(1, p.steps);
        const frontBase = profiles[0].base;
        const frontSide = profiles[0].side;
        const backProfile = profiles[profiles.length - 1];

        for (let k = 0; k < bevelSteps; k++) {
          const t0 = k / bevelSteps, t1 = (k + 1) / bevelSteps;
          const frontA = frontBase.map((a, i) => lerpSeg(a, frontSide[i], t0));
          const frontB = frontBase.map((a, i) => lerpSeg(a, frontSide[i], t1));
          const backA = backProfile.side.map((a, i) => lerpSeg(a, backProfile.base[i], t0));
          const backB = backProfile.side.map((a, i) => lerpSeg(a, backProfile.base[i], t1));
          addFacesBetween(frontBevelFaces, frontA, frontB, exNx, exNy);
          addFacesBetween(backBevelFaces, backA, backB, exNx, exNy);
        }
      }

      for (let s = 0; s < profiles.length - 1; s++) {
        const A = profiles[s].side, B = profiles[s + 1].side;
        for (let k = 0; k < p.steps; k++) {
          const t0 = k / p.steps, t1 = (k + 1) / p.steps;
          const slA = A.map((a, i) => lerpSeg(a, B[i], t0));
          const slB = A.map((a, i) => lerpSeg(a, B[i], t1));
          addFacesBetween(sideFaces, slA.slice(0, subN), slB.slice(0, subN), exNx, exNy);
        }
      }
      return {
        allFaces: [...backBevelFaces, ...sideFaces, ...frontBevelFaces],
        sideFaces,
        frontBevelFaces,
        backBevelFaces
      };
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
      const style = readStyle(mainNode, p.opacity);

      if (bevelIsActive(p)) {
        const sideSplit = splitFaces(built.sideFaces, active);
        const groups = [
          { name: "Back Wall", defs: makeDefs(sideSplit.backFaces, style.fill, style.stroke, style.lsd) },
          { name: "Back Bevel", defs: makeDefs(built.backBevelFaces, style.fill, style.stroke, style.lsd) },
          { name: "Front Wall", defs: makeDefs(sideSplit.frontFaces, style.fill, style.stroke, style.lsd) },
          { name: "Front Bevel", defs: makeDefs(built.frontBevelFaces, style.fill, style.stroke, style.lsd) }
        ].filter(g => g.defs.length > 0);
        const total = groups.reduce((sum, g) => sum + g.defs.length, 0);

        if (total === 0) return null;

        return { mainNode, secNode, groups, total, bevelMode: true };
      }

      const split = splitFaces(built.allFaces, active);
      const fDefs = makeDefs(split.frontFaces, style.fill, style.stroke, style.lsd);
      const bDefs = makeDefs(split.backFaces, style.fill, style.stroke, style.lsd);
      const F = fDefs.length, B = bDefs.length;

      if (F === 0 && B === 0) return null;

      return { mainNode, secNode, fDefs, bDefs, F, B };
    }

    function createPreviewAddCommand(active, p) {
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) return null;

      const allDefs = faceDefs.bevelMode
        ? faceDefs.groups.flatMap(g => g.defs)
        : [...faceDefs.bDefs, ...faceDefs.fDefs];

      const addBuilder = AddChildNodesCommandBuilder.create();
      addBuilder.setInsertionTargetSelection(mkSel(faceDefs.secNode));
      addBuilder.setInsertionMode(InsertionMode.Top);
      allDefs.forEach(d => addBuilder.addNode(d));

      return addBuilder.createCommand(false, NodeChildType.Main);
    }

    function createFinalCommands(active, p) {
      const faceDefs = buildFaceDefinitions(active, p);
      if (!faceDefs) return null;

      if (faceDefs.bevelMode) {
        const parentNode = faceDefs.secNode.parent;
        const groups = faceDefs.groups.map(group => ({ name: group.name, defs: group.defs }));
        const layout = [];
        let offset = 0;

        for (const group of groups) {
          for (let i = 0; i < group.defs.length; i++) {
            group.defs[i].userDescription = group.name + " curve" + (i + 1);
          }
          layout.push({ name: group.name, start: offset, count: group.defs.length });
          offset += group.defs.length;
        }

        const addBuilder = AddChildNodesCommandBuilder.create();
        if (parentNode && !parentNode.isSpreadNode) addBuilder.setInsertionTarget(parentNode);
        groups.forEach(group => addBuilder.addContainerNode(ContainerNodeDefinition.create(group.name)));
        for (let g = groups.length - 1; g >= 0; g--) {
          groups[g].defs.forEach(d => addBuilder.addNode(d));
        }
        const addCmd = addBuilder.createCommand(false, NodeChildType.Main);

        return { addCmd, moveFinal: addCmdExecuted => {
          const totalDefs = offset;
          const compound = CompoundCommandBuilder.create();

          if (p.swap) {
            compound.addCommand(DocumentCommand.createMoveNodes(mkSel(faceDefs.mainNode), faceDefs.secNode, NodeMoveType.After, NodeChildType.Main));
          }

          let afterNode = faceDefs.secNode;
          for (let g = 0; g < layout.length; g++) {
            const group = layout[g];
            const cont = addCmdExecuted.newNodes[totalDefs + (layout.length - 1 - g)];

            for (let i = group.start + group.count - 1; i >= group.start; i--) {
              compound.addCommand(DocumentCommand.createMoveNodes(mkSel(addCmdExecuted.newNodes[i]), cont, NodeMoveType.Inside, NodeChildType.Main));
            }

            compound.addCommand(DocumentCommand.createMoveNodes(mkSel(cont), afterNode, NodeMoveType.After, NodeChildType.Main));
            afterNode = cont;
          }

          return compound.createCommand();
        }};
      }

      const mainNode = faceDefs.mainNode;
      const secNode = faceDefs.secNode;
      const fDefs = faceDefs.fDefs;
      const bDefs = faceDefs.bDefs;
      const F = faceDefs.F;
      const B = faceDefs.B;
      const parentNode = secNode.parent;
      for (let i = 0; i < F; i++) fDefs[i].userDescription = "Front curve" + (i + 1);
      for (let i = 0; i < B; i++) bDefs[i].userDescription = "Back curve" + (i + 1);

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

      if (commands.applyFinal) {
        commands.applyFinal();
      } else {
        doc.executeCommand(commands.addCmd);
        doc.executeCommand(commands.moveFinal(commands.addCmd));
      }
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

    const gBevel = col.addGroup("Bevel");
    const sBevelEnabled = gBevel.addSwitch("Enable", true);
    const eBevelCenter = gBevel.addUnitValueEditor("Center (%)", "", "%", 0, 0, BEVEL_EDITOR_MAX);
    eBevelCenter.precision = 0;
    eBevelCenter.showPopupSlider = false;
    const eBevelHighToLow = gBevel.addUnitValueEditor("High Z -> Low Z (%)", "", "%", 0, 0, BEVEL_EDITOR_MAX);
    eBevelHighToLow.precision = 0;
    eBevelHighToLow.showPopupSlider = false;
    const eBevelLowToHigh = gBevel.addUnitValueEditor("Low Z -> High Z (%)", "", "%", 0, 0, BEVEL_EDITOR_MAX);
    eBevelLowToHigh.precision = 0;
    eBevelLowToHigh.showPopupSlider = false;
    const sPreserveBevelBounds = gBevel.addSwitch("Preserve Bounds", false);

    const gOpts = col.addGroup("Options");
    const sSwap = gOpts.addSwitch("Swap Main/Secondary", false);

    const getP = () => ({
      steps: Math.max(1, Math.round(eSteps.value)),
      subdivs: Math.max(1, Math.round(eSubdivs.value)),
      opacity: eOp.value,
      bevelEnabled: sBevelEnabled.value,
      bevelCenter: Math.max(0, Math.round(eBevelCenter.value)),
      bevelHighToLow: Math.max(0, Math.round(eBevelHighToLow.value)),
      bevelLowToHigh: Math.max(0, Math.round(eBevelLowToHigh.value)),
      preserveBevelBounds: sPreserveBevelBounds.value,
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
    sBevelEnabled.onValueChangedHandler = applyPreview;
    eBevelCenter.onValueChangedHandler = applyPreview;
    eBevelHighToLow.onValueChangedHandler = applyPreview;
    eBevelLowToHigh.onValueChangedHandler = applyPreview;
    sPreserveBevelBounds.onValueChangedHandler = applyPreview;
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
