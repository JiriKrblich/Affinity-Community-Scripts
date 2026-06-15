/**
 * name: Envelope Studio Pro
 * description: Multi-stage Illustrator-style warp engine with origin, direction, advanced falloff, custom profiles, live preview, and JSON presets.
 * version: 3.0.0
 * author:tzvi20 + ChatGPT
 */

"use strict";

(function () {
  const { app } = require("/application");
  const { File, FileSystemApi } = require("/fs");
  const { Document } = require("/document");
  const { DocumentCommand, CompoundCommandBuilder } = require("/commands");
  const { CurveBuilder, PolyCurve } = require("/geometry");
  const { Dialog, DialogResult } = require("/dialog");
  const { Selection } = require("/selections");
  const { UnitType } = require("/units");

  const doc = Document.current;
  const TITLE = "Envelope Studio Pro v3";

  if (!doc) {
    alert(TITLE + "\n\nOpen a document first.");
    return;
  }

  const MODES = [
    "Arc",
    "Arch",
    "Bulge",
    "Pinch",
    "Wave",
    "Ripple",
    "Flag",
    "Twist",
    "Fish",
    "Fisheye",
    "Inflate",
    "Bloat",
    "Barrel",
    "Pillow",
    "Hourglass",
    "Funnel",
    "Cone",
    "Trapezoid",
    "Skew",
    "Shell Up",
    "Shell Down",
    "Lens",
    "Perspective",
    "Mesh Bend",
    "Mesh Perspective",
    "Mesh Bulge",
    "Mesh Wave",
    "Mesh Twist",
    "Corner Pull",
  ];

  const DIRECTIONS = ["Horizontal", "Vertical", "Radial"];

  const ORIGINS = [
    "Center",
    "Top",
    "Bottom",
    "Left",
    "Right",
    "Top Left",
    "Top Right",
    "Bottom Left",
    "Bottom Right",
  ];

  const FALLOFFS = [
    "Linear",
    "S-Curve",
    "Ease In",
    "Ease Out",
    "Bell",
    "Gaussian",
    "Sharp Center",
    "Edge",
    "Horizontal Bell",
    "Vertical Bell",
    "Radial Bell",
    "Custom Profile",
  ];

  const DEFAULT_PROFILE = "0,1;0.5,1;1,1";

  const DEFAULT_CONFIG = {
    version: 3,
    origin: 0,
    falloff: 0,
    profileAmount: 1,
    profilePower: 1.5,
    customProfile: DEFAULT_PROFILE,
    frequency: 2,
    phaseDeg: 0,
    taper: 0.3,
    quality: 4,
    livePreview: false,
    stages: [
      { enabled: true, mode: 0, direction: 0, strength: 0.35 },
      { enabled: false, mode: 4, direction: 0, strength: 0.15 },
      { enabled: false, mode: 7, direction: 2, strength: 0.15 },
    ],
  };

  let currentConfig = clonePlain(DEFAULT_CONFIG);

  function clonePlain(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function okPressed(result) {
    return (
      result == DialogResult.Ok.value || result?.value == DialogResult.Ok.value
    );
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function degToRad(v) {
    return (v * Math.PI) / 180;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothStep(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  function lerpPoint(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }

  function pointOf(p) {
    return { x: Number(p.x), y: Number(p.y) };
  }

  function bezC1(b) {
    return pointOf(
      b.c1 ||
        b.control1 ||
        b.ctrl1 ||
        b.handle1 ||
        b.startControl ||
        b.startHandle ||
        b.start,
    );
  }

  function bezC2(b) {
    return pointOf(
      b.c2 ||
        b.control2 ||
        b.ctrl2 ||
        b.handle2 ||
        b.endControl ||
        b.endHandle ||
        b.end,
    );
  }

  function pushUnique(arr, node) {
    if (!node) return;
    for (const n of arr) {
      try {
        if (n === node || (n.isSameNode && n.isSameNode(node))) return;
      } catch (e) {}
    }
    arr.push(node);
  }

  function isCandidate(n) {
    try {
      return !!(n && n.curvesInterface && n.curvesInterface.polyCurve);
    } catch (e) {
      return false;
    }
  }

  function collectVectorNodes(nodesIn) {
    const out = [];

    function visit(node) {
      if (!node) return;

      let child = null;
      try {
        child = node.firstChild;
      } catch (e) {}

      if ((node.isGroupNode || node.isContainerNode) && child) {
        while (child) {
          visit(child);
          try {
            child = child.nextSibling;
          } catch (e) {
            child = null;
          }
        }
        return;
      }

      if (isCandidate(node)) pushUnique(out, node);

      while (child) {
        visit(child);
        try {
          child = child.nextSibling;
        } catch (e) {
          child = null;
        }
      }
    }

    for (const n of nodesIn || []) visit(n);
    return out;
  }

  function getSelectedVectorNodes() {
    try {
      const nodes = [];
      for (const item of doc.selection.items) {
        if (item.node) {
          for (const n of collectVectorNodes([item.node])) pushUnique(nodes, n);
        }
      }
      if (nodes.length) return nodes;
    } catch (e) {}

    try {
      return collectVectorNodes(doc.selection.nodes.toArray());
    } catch (e) {
      return [];
    }
  }

  function isMutableCurveNode(n) {
    try {
      return !!(
        n &&
        n.curvesInterface &&
        n.curvesInterface.isMutable &&
        n.curvesInterface.polyCurve
      );
    } catch (e) {
      return false;
    }
  }

  function ensureMutableCurveNodes(raw) {
    const result = [];
    const convert = [];

    for (const n of raw) {
      if (isMutableCurveNode(n)) pushUnique(result, n);
      else pushUnique(convert, n);
    }

    if (convert.length) {
      try {
        const cmd = DocumentCommand.createConvertToCurves(
          Selection.create(doc, convert, true),
        );
        doc.executeCommand(cmd);

        for (const n of collectVectorNodes(cmd.newNodes)) {
          if (isMutableCurveNode(n)) pushUnique(result, n);
        }
      } catch (e) {
        console.log(TITLE + " convert failed: " + e);
      }
    }

    return result;
  }

  function makeTargets(nodes) {
    const out = [];

    for (const n of nodes) {
      try {
        out.push({
          curvesInterface: n.curvesInterface,
          sourcePolyCurve: n.curvesInterface.polyCurve.clone(),
        });
      } catch (e) {}
    }

    return out;
  }

  function boundsOfTargets(targets) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let count = 0;

    for (const t of targets) {
      try {
        for (const curve of t.sourcePolyCurve) {
          for (const b of curve.beziers) {
            const pts = [pointOf(b.start), bezC1(b), bezC2(b), pointOf(b.end)];
            for (const p of pts) {
              minX = Math.min(minX, p.x);
              minY = Math.min(minY, p.y);
              maxX = Math.max(maxX, p.x);
              maxY = Math.max(maxY, p.y);
              count++;
            }
          }
        }
      } catch (e) {}
    }

    if (!count) return null;

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(0.0001, maxX - minX),
      height: Math.max(0.0001, maxY - minY),
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };
  }

  function originPoint(bounds, originIndex) {
    const b = bounds;
    switch (originIndex) {
      case 1:
        return { x: b.cx, y: b.minY };
      case 2:
        return { x: b.cx, y: b.maxY };
      case 3:
        return { x: b.minX, y: b.cy };
      case 4:
        return { x: b.maxX, y: b.cy };
      case 5:
        return { x: b.minX, y: b.minY };
      case 6:
        return { x: b.maxX, y: b.minY };
      case 7:
        return { x: b.minX, y: b.maxY };
      case 8:
        return { x: b.maxX, y: b.maxY };
      default:
        return { x: b.cx, y: b.cy };
    }
  }

  function normalize(p, b) {
    return {
      x: (p.x - b.minX) / b.width,
      y: (p.y - b.minY) / b.height,
    };
  }

  function parseCustomProfile(text) {
    const pts = [];
    const chunks = String(text || "").split(";");

    for (const ch of chunks) {
      const parts = ch.split(",");
      if (parts.length !== 2) continue;

      const x = Number(parts[0]);
      const y = Number(parts[1]);

      if (isFinite(x) && isFinite(y)) {
        pts.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 2) });
      }
    }

    pts.sort(function (a, b) {
      return a.x - b.x;
    });

    if (!pts.length)
      return [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];

    if (pts[0].x > 0) pts.unshift({ x: 0, y: pts[0].y });
    if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: pts[pts.length - 1].y });

    return pts;
  }

  function evalCustomProfile(t, points) {
    t = clamp(t, 0, 1);

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];

      if (t >= a.x && t <= b.x) {
        const span = Math.max(0.0001, b.x - a.x);
        const u = smoothStep((t - a.x) / span);
        return lerp(a.y, b.y, u);
      }
    }

    return points[points.length - 1].y;
  }

  function falloffValue(x, y, cfg) {
    const x2 = Math.abs(x * 2 - 1);
    const y2 = Math.abs(y * 2 - 1);
    const dx = x * 2 - 1;
    const dy = y * 2 - 1;
    const r = clamp(Math.sqrt(dx * dx + dy * dy), 0, 1);

    let t = 1;

    if (cfg.falloff === 0) {
      t = 1;
    } else if (cfg.falloff === 1) {
      t = smoothStep(x);
    } else if (cfg.falloff === 2) {
      t = x * x;
    } else if (cfg.falloff === 3) {
      t = 1 - (1 - x) * (1 - x);
    } else if (cfg.falloff === 4) {
      t = Math.sin(x * Math.PI);
    } else if (cfg.falloff === 5) {
      const d = x - 0.5;
      t = Math.exp(-(d * d) / 0.08);
    } else if (cfg.falloff === 6) {
      t = Math.pow(Math.max(0, 1 - r), cfg.profilePower);
    } else if (cfg.falloff === 7) {
      t = Math.pow(Math.max(x2, y2), cfg.profilePower);
    } else if (cfg.falloff === 8) {
      t = Math.pow(Math.max(0, 1 - x2), cfg.profilePower);
    } else if (cfg.falloff === 9) {
      t = Math.pow(Math.max(0, 1 - y2), cfg.profilePower);
    } else if (cfg.falloff === 10) {
      t = Math.pow(Math.max(0, 1 - r), cfg.profilePower);
    } else {
      const pts = parseCustomProfile(cfg.customProfile);
      t = evalCustomProfile(x, pts);
    }

    return clamp(t * cfg.profileAmount + (1 - cfg.profileAmount), 0, 2.5);
  }

  function splitCubic(c, t) {
    const p01 = lerpPoint(c.p0, c.c1, t);
    const p12 = lerpPoint(c.c1, c.c2, t);
    const p23 = lerpPoint(c.c2, c.p3, t);
    const p012 = lerpPoint(p01, p12, t);
    const p123 = lerpPoint(p12, p23, t);
    const p0123 = lerpPoint(p012, p123, t);

    return {
      left: { p0: c.p0, c1: p01, c2: p012, p3: p0123 },
      right: { p0: p0123, c1: p123, c2: p23, p3: c.p3 },
    };
  }

  function cubicSegment(c, t0, t1) {
    if (t0 <= 0 && t1 >= 1) return c;
    const first = splitCubic(c, t1).left;
    if (t0 <= 0) return first;
    return splitCubic(first, t0 / t1).right;
  }

  function makeDirectionalPoint(p, b, direction) {
    const n = normalize(p, b);

    if (direction === 1) {
      return {
        p: {
          x: b.minX + n.y * b.width,
          y: b.minY + n.x * b.height,
        },
        unmap: function (q) {
          const du = (q.x - (b.minX + n.y * b.width)) / b.width;
          const dv = (q.y - (b.minY + n.x * b.height)) / b.height;
          return {
            x: p.x + dv * b.width,
            y: p.y + du * b.height,
          };
        },
      };
    }

    return {
      p: { x: p.x, y: p.y },
      unmap: function (q) {
        return q;
      },
    };
  }

  function deformOneMode(p, b, cfg, stage) {
    const mapped = makeDirectionalPoint(p, b, stage.direction);
    const q = mapped.p;

    const n = normalize(q, b);
    const x = n.x;
    const y = n.y;
    const x2 = x * 2 - 1;
    const y2 = y * 2 - 1;
    const origin = originPoint(b, cfg.origin);

    let s = stage.strength * falloffValue(x, y, cfg);
    let nx = q.x;
    let ny = q.y;

    if (stage.direction === 2) {
      const dx = q.x - origin.x;
      const dy = q.y - origin.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = Math.sqrt(b.width * b.width + b.height * b.height) * 0.5;
      const r = clamp(dist / Math.max(0.0001, maxR), 0, 1);
      s *= Math.max(0, 1 - r * 0.25);
    }

    if (stage.mode === 0) {
      const arch = 1 - x2 * x2;
      ny = q.y - arch * s * b.height * 0.45;
    } else if (stage.mode === 1) {
      const arch = Math.sin(x * Math.PI);
      ny = q.y - arch * s * b.height * 0.55;
    } else if (stage.mode === 2) {
      const r2 = x2 * x2 + y2 * y2;
      const scale = 1 + s * Math.max(0, 1 - r2) * 0.75;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 3) {
      const r2 = x2 * x2 + y2 * y2;
      const scale = 1 - s * Math.max(0, 1 - r2) * 0.65;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 4) {
      const amp = s * b.height * 0.22;
      ny = q.y + Math.sin(x * Math.PI * 2 * cfg.frequency + cfg.phase) * amp;
    } else if (stage.mode === 5) {
      const amp = s * b.height * 0.14;
      const w1 = Math.sin(x * Math.PI * 2 * cfg.frequency + cfg.phase);
      const w2 =
        Math.sin(x * Math.PI * 4 * cfg.frequency + cfg.phase * 0.7) * 0.35;
      const v = Math.sin(y * Math.PI * 2 + cfg.phase) * 0.25;
      ny = q.y + (w1 + w2) * amp;
      nx = q.x + v * amp * 0.7;
    } else if (stage.mode === 6) {
      const amp = s * b.height * 0.24;
      const fade = 0.15 + 0.85 * x;
      ny =
        q.y +
        Math.sin(x * Math.PI * 2 * cfg.frequency + cfg.phase) * amp * fade;
      nx = q.x + Math.sin(y * Math.PI + cfg.phase) * amp * 0.1;
    } else if (stage.mode === 7) {
      const dx = (q.x - origin.x) / (b.width * 0.5);
      const dy = (q.y - origin.y) / (b.height * 0.5);
      const radius = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const twist = s * Math.PI * 1.25 * Math.max(0, 1 - Math.min(1, radius));
      const a = angle + twist;
      nx = origin.x + Math.cos(a) * radius * b.width * 0.5;
      ny = origin.y + Math.sin(a) * radius * b.height * 0.5;
    } else if (stage.mode === 8) {
      const bulge = Math.sin(x * Math.PI);
      const scaleY = 1 + s * bulge * 0.65;
      ny = origin.y + (q.y - origin.y) * scaleY;
      nx = q.x + y2 * s * b.width * 0.08 * Math.sin(x * Math.PI);
    } else if (stage.mode === 9) {
      const dx = (q.x - origin.x) / (b.width * 0.5);
      const dy = (q.y - origin.y) / (b.height * 0.5);
      const r = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const newR = r * (1 + s * (1 - r) * 0.75);
      nx = origin.x + Math.cos(angle) * newR * b.width * 0.5;
      ny = origin.y + Math.sin(angle) * newR * b.height * 0.5;
    } else if (stage.mode === 10) {
      const edgeFalloff = (1 - Math.abs(x2)) * (1 - Math.abs(y2));
      const scale = 1 + s * edgeFalloff * 0.8;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 11) {
      const r = Math.sqrt(x2 * x2 + y2 * y2);
      const scale = 1 + s * (0.35 + Math.max(0, 1 - r)) * 0.75;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 12) {
      const scaleX = 1 + s * (1 - y2 * y2) * 0.55;
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 13) {
      const scaleX = 1 - s * (1 - y2 * y2) * 0.55;
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 14) {
      const waist = 1 - Math.abs(y2);
      const scaleX = 1 - s * waist * 0.65;
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 15) {
      const scaleX = 1 - s * y * 0.75;
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 16) {
      const scaleX = 1 + s * (y - 0.5);
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 17) {
      const scaleX = 1 + y2 * s * 0.55;
      nx = origin.x + (q.x - origin.x) * scaleX;
    } else if (stage.mode === 18) {
      nx = q.x + y2 * s * b.width * 0.35;
    } else if (stage.mode === 19) {
      const f = 1 - y;
      const arch = 1 - x2 * x2;
      ny = q.y - arch * f * s * b.height * 0.55;
    } else if (stage.mode === 20) {
      const f = y;
      const arch = 1 - x2 * x2;
      ny = q.y + arch * f * s * b.height * 0.55;
    } else if (stage.mode === 21) {
      const dx = (q.x - origin.x) / (b.width * 0.5);
      const dy = (q.y - origin.y) / (b.height * 0.5);
      const r = Math.sqrt(dx * dx + dy * dy);
      const fall = Math.max(0, 1 - r);
      const scale = 1 + s * fall * fall * 0.9;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 22) {
      const scaleX = 1 + y2 * cfg.taper * 0.55;
      const skew = y2 * s * b.width * 0.22;
      nx = origin.x + (q.x - origin.x) * scaleX + skew;
    } else if (stage.mode === 23) {
      const mx = smoothStep(x);
      const my = smoothStep(y);
      ny = q.y - Math.sin(mx * Math.PI) * s * b.height * 0.5;
      nx = q.x + (my - 0.5) * Math.sin(mx * Math.PI) * s * b.width * 0.12;
    } else if (stage.mode === 24) {
      const topPull = (1 - y) * s * b.width * 0.28;
      const bottomPull = y * cfg.taper * b.width * 0.28;
      nx = q.x + x2 * (topPull - bottomPull);
    } else if (stage.mode === 25) {
      const fx = Math.sin(x * Math.PI);
      const fy = Math.sin(y * Math.PI);
      const scale = 1 + s * fx * fy * 0.9;
      nx = origin.x + (q.x - origin.x) * scale;
      ny = origin.y + (q.y - origin.y) * scale;
    } else if (stage.mode === 26) {
      const fx = Math.sin(x * Math.PI * 2 * cfg.frequency + cfg.phase);
      const fy = Math.sin(y * Math.PI);
      ny = q.y + fx * fy * s * b.height * 0.28;
      nx =
        q.x + Math.cos(y * Math.PI * 2 + cfg.phase) * fx * s * b.width * 0.05;
    } else if (stage.mode === 27) {
      const dx = (q.x - origin.x) / (b.width * 0.5);
      const dy = (q.y - origin.y) / (b.height * 0.5);
      const radius = Math.sqrt(dx * dx + dy * dy);
      const fall = Math.max(0, 1 - radius);
      const angle = Math.atan2(dy, dx);
      const a = angle + s * Math.PI * 1.6 * fall * smoothStep(fall);
      nx = origin.x + Math.cos(a) * radius * b.width * 0.5;
      ny = origin.y + Math.sin(a) * radius * b.height * 0.5;
    } else {
      const pullX = (x > 0.5 ? 1 : -1) * x * y * s * b.width * 0.2;
      const pullY = (y > 0.5 ? 1 : -1) * x * y * s * b.height * 0.2;
      nx = q.x + pullX;
      ny = q.y + pullY;
    }

    return mapped.unmap({ x: nx, y: ny });
  }

  function deformPoint(p, b, cfg) {
    let out = { x: p.x, y: p.y };

    for (let i = 0; i < cfg.stages.length; i++) {
      const st = cfg.stages[i];
      if (!st.enabled) continue;
      if (Math.abs(st.strength) < 0.00001) continue;

      out = deformOneMode(out, b, cfg, st);
    }

    return out;
  }

  function buildEnvelopeCurve(curve, bounds, cfg) {
    const beziers = [...curve.beziers];
    if (!beziers.length) return curve.clone();

    const builder = CurveBuilder.create();
    const pieces = cfg.quality;
    let firstDone = false;

    for (const bz of beziers) {
      const cubic = {
        p0: pointOf(bz.start),
        c1: bezC1(bz),
        c2: bezC2(bz),
        p3: pointOf(bz.end),
      };

      for (let i = 0; i < pieces; i++) {
        const seg = cubicSegment(cubic, i / pieces, (i + 1) / pieces);

        const p0 = deformPoint(seg.p0, bounds, cfg);
        const c1 = deformPoint(seg.c1, bounds, cfg);
        const c2 = deformPoint(seg.c2, bounds, cfg);
        const p3 = deformPoint(seg.p3, bounds, cfg);

        if (!firstDone) {
          builder.beginXY(p0.x, p0.y);
          firstDone = true;
        }

        builder.addBezierXY(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
      }
    }

    if (curve.isClosed) builder.close();
    return builder.createCurve();
  }

  function buildEnvelopePolyCurve(sourcePolyCurve, bounds, cfg) {
    const out = PolyCurve.create();

    for (const curve of sourcePolyCurve) {
      try {
        out.addCurve(buildEnvelopeCurve(curve, bounds, cfg));
      } catch (e) {
        try {
          out.addCurve(curve.clone());
        } catch (ignore) {}
      }
    }

    return out;
  }

  function createEnvelopeCommand(targets, bounds, cfg) {
    const cb = CompoundCommandBuilder.create();
    let count = 0;

    for (const t of targets) {
      try {
        cb.addCommand(
          DocumentCommand.createSetCurves(
            t.curvesInterface,
            buildEnvelopePolyCurve(t.sourcePolyCurve, bounds, cfg),
          ),
        );
        count++;
      } catch (e) {
        console.log(TITLE + " skipped object: " + e);
      }
    }

    return count ? cb.createCommand() : null;
  }

  function clearPreview() {
    try {
      doc.executeCommand(DocumentCommand.createClearPreviews());
    } catch (e) {}
  }

  function configToPreset(cfg) {
    return JSON.stringify(cfg, null, 2);
  }

  function normalizePresetConfig(obj) {
    const cfg = clonePlain(DEFAULT_CONFIG);

    if (!obj || typeof obj !== "object") return cfg;

    cfg.origin = clamp(
      Math.round(obj.origin ?? cfg.origin),
      0,
      ORIGINS.length - 1,
    );
    cfg.falloff = clamp(
      Math.round(obj.falloff ?? cfg.falloff),
      0,
      FALLOFFS.length - 1,
    );
    cfg.profileAmount = clamp(
      Number(obj.profileAmount ?? cfg.profileAmount),
      0,
      2,
    );
    cfg.profilePower = clamp(
      Number(obj.profilePower ?? cfg.profilePower),
      0.1,
      8,
    );
    cfg.customProfile = String(obj.customProfile ?? cfg.customProfile);
    cfg.frequency = clamp(Number(obj.frequency ?? cfg.frequency), 1, 20);
    cfg.phaseDeg = clamp(Number(obj.phaseDeg ?? cfg.phaseDeg), -360, 360);
    cfg.taper = clamp(Number(obj.taper ?? cfg.taper), -2, 2);
    cfg.quality = clamp(Math.round(obj.quality ?? cfg.quality), 1, 20);
    cfg.livePreview = !!obj.livePreview;

    if (Array.isArray(obj.stages)) {
      for (let i = 0; i < Math.min(3, obj.stages.length); i++) {
        const s = obj.stages[i] || {};
        cfg.stages[i] = {
          enabled: !!s.enabled,
          mode: clamp(
            Math.round(s.mode ?? cfg.stages[i].mode),
            0,
            MODES.length - 1,
          ),
          direction: clamp(
            Math.round(s.direction ?? cfg.stages[i].direction),
            0,
            DIRECTIONS.length - 1,
          ),
          strength: clamp(Number(s.strength ?? cfg.stages[i].strength), -2, 2),
        };
      }
    }

    cfg.stages[0].enabled = true;
    return cfg;
  }

  function presetFolder() {
    return app.userDesktopPath + "/EnvelopeStudio";
  }

  function safePresetName(name) {
    let s = String(name || "")
      .replace(/[\\\/:*?"<>|]/g, "_")
      .trim();
    if (!s) s = "Envelope Preset";
    if (!/\.json$/i.test(s)) s += ".json";
    return s;
  }

  function savePreset(cfg) {
    try {
      const folder = presetFolder();

      try {
        FileSystemApi.createDirectories(folder);
      } catch (e) {
        try {
          FileSystemApi.createDirectory(folder);
        } catch (ignore) {}
      }

      const name = app.prompt("Preset name:", TITLE, "My Envelope Preset");
      if (!name) return false;

      const path = folder + "/" + safePresetName(name);
      const f = new File(path, "wb");
      f.writeString(configToPreset(cfg));
      f.close();

      app.alert("Preset saved:\n\n" + path, TITLE);
      return true;
    } catch (e) {
      app.alert("Could not save preset:\n\n" + e.message, TITLE);
      return false;
    }
  }

  function loadPreset() {
    try {
      const path = app.chooseFile();
      if (!path) return null;

      const buf = File.readAll(path);
      const txt = String(buf);
      const obj = JSON.parse(txt);

      return normalizePresetConfig(obj);
    } catch (e) {
      app.alert("Could not load preset:\n\n" + e.message, TITLE);
      return null;
    }
  }

  const raw = getSelectedVectorNodes();

  if (!raw.length) {
    alert(TITLE + "\n\nSelect one or more vector objects.");
    return;
  }

  const historyStart = (() => {
    try {
      return doc.history.position;
    } catch (e) {
      return null;
    }
  })();

  const nodes = ensureMutableCurveNodes(raw);
  const targets = makeTargets(nodes);
  const bounds = boundsOfTargets(targets);

  if (!targets.length || !bounds) {
    alert(TITLE + "\n\nCould not read editable vector curves.");
    return;
  }

  function restoreStart() {
    if (historyStart == null) return;

    try {
      if (doc.history.position !== historyStart) {
        doc.history.position = historyStart;
      }
    } catch (e) {}
  }

  function applyConfigToDocument(cfg, previewMode) {
    clearPreview();
    const cmd = createEnvelopeCommand(targets, bounds, cfg);
    if (cmd) doc.executeCommand(cmd, !!previewMode);
  }

  function buildDialog(cfg) {
    const dlg = Dialog.create(TITLE);
    dlg.initialWidth = 680;
    try {
      dlg.isResizable = true;
    } catch (e) {}

    const c1 = dlg.addColumn();
    const c2 = dlg.addColumn();

    const main = c1.addGroup("Global");
    const originCombo = main.addComboBox("Origin", ORIGINS, cfg.origin);
    originCombo.isFullWidth = true;

    const falloffCombo = main.addComboBox("Falloff", FALLOFFS, cfg.falloff);
    falloffCombo.isFullWidth = true;

    const profileAmountEd = main.addUnitValueEditor(
      "Profile Amount",
      UnitType.Percentage,
      UnitType.Percentage,
      cfg.profileAmount * 100,
      0,
      200,
    );
    profileAmountEd.precision = 1;
    profileAmountEd.showPopupSlider = true;

    const profilePowerEd = main.addUnitValueEditor(
      "Profile Power",
      UnitType.Number,
      UnitType.Number,
      cfg.profilePower,
      0.1,
      8,
    );
    profilePowerEd.precision = 1;
    profilePowerEd.showPopupSlider = true;

    const customBox = main.addTextBox("Custom Profile", cfg.customProfile);
    customBox.isFullWidth = true;

    const wave = c1.addGroup("Wave / Perspective / Quality");

    const freqEd = wave.addUnitValueEditor(
      "Frequency",
      UnitType.Number,
      UnitType.Number,
      cfg.frequency,
      1,
      20,
    );
    freqEd.precision = 1;
    freqEd.showPopupSlider = true;

    const phaseEd = wave.addUnitValueEditor(
      "Phase",
      UnitType.Degree,
      UnitType.Degree,
      cfg.phaseDeg,
      -360,
      360,
    );
    phaseEd.precision = 1;
    phaseEd.showPopupSlider = true;

    const taperEd = wave.addUnitValueEditor(
      "Taper",
      UnitType.Percentage,
      UnitType.Percentage,
      cfg.taper * 100,
      -200,
      200,
    );
    taperEd.precision = 1;
    taperEd.showPopupSlider = true;

    const qualityEd = wave.addUnitValueEditor(
      "Curve Quality",
      UnitType.Number,
      UnitType.Number,
      cfg.quality,
      1,
      20,
    );
    qualityEd.precision = 0;
    qualityEd.showPopupSlider = true;

    const stControls = [];

    function addStageUI(parent, label, st, index) {
      const g = parent.addGroup(label);

      let enabledSw = null;
      if (index > 0) {
        enabledSw = g.addSwitch("Enable Stage", st.enabled);
      }

      const modeCombo = g.addComboBox("Mode", MODES, st.mode);
      modeCombo.isFullWidth = true;

      const dirCombo = g.addComboBox("Direction", DIRECTIONS, st.direction);
      dirCombo.isFullWidth = true;

      const strengthEd = g.addUnitValueEditor(
        "Strength",
        UnitType.Percentage,
        UnitType.Percentage,
        st.strength * 100,
        -200,
        200,
      );
      strengthEd.precision = 1;
      strengthEd.showPopupSlider = true;

      stControls[index] = {
        enabledSw,
        modeCombo,
        dirCombo,
        strengthEd,
      };
    }

    addStageUI(c2, "Stage 1", cfg.stages[0], 0);
    addStageUI(c2, "Stage 2", cfg.stages[1], 1);
    addStageUI(c2, "Stage 3", cfg.stages[2], 2);

    const action = c1.addGroup("Preview / Presets / Apply");

    const liveSw = action.addSwitch("Live Preview", cfg.livePreview);

    const statusTxt = action.addStaticText("", "Ready");
    statusTxt.isFullWidth = true;

    const actionSet = action.addButtonSet(
      "",
      ["↺ Preview", "✓ Apply", "Save Preset", "Load Preset"],
      0,
    );
    actionSet.isFullWidth = true;

    function readConfig() {
      const out = clonePlain(DEFAULT_CONFIG);

      out.origin = clamp(originCombo.selectedIndex, 0, ORIGINS.length - 1);
      out.falloff = clamp(falloffCombo.selectedIndex, 0, FALLOFFS.length - 1);
      out.profileAmount = clamp(profileAmountEd.value / 100, 0, 2);
      out.profilePower = clamp(profilePowerEd.value, 0.1, 8);
      out.customProfile = customBox.text || DEFAULT_PROFILE;
      out.frequency = clamp(freqEd.value, 1, 20);
      out.phaseDeg = clamp(phaseEd.value, -360, 360);
      out.phase = degToRad(out.phaseDeg);
      out.taper = clamp(taperEd.value / 100, -2, 2);
      out.quality = clamp(Math.round(qualityEd.value), 1, 20);
      out.livePreview = !!liveSw.value;

      for (let i = 0; i < 3; i++) {
        const c = stControls[i];
        out.stages[i] = {
          enabled: i === 0 ? true : !!c.enabledSw.value,
          mode: clamp(c.modeCombo.selectedIndex, 0, MODES.length - 1),
          direction: clamp(c.dirCombo.selectedIndex, 0, DIRECTIONS.length - 1),
          strength: clamp(c.strengthEd.value / 100, -2, 2),
        };
      }

      return out;
    }

    function doPreview() {
      try {
        const rcfg = readConfig();
        applyConfigToDocument(rcfg, true);

        const active = rcfg.stages
          .filter((s) => s.enabled)
          .map((s) => MODES[s.mode])
          .join(" → ");

        statusTxt.text =
          "• Preview active — " + active + " / " + FALLOFFS[rcfg.falloff];
      } catch (e) {
        clearPreview();
        statusTxt.text = "✖ Preview error: " + e.message;
      }
    }

    let livePreviewBusy = false;

    try {
      dlg.onControlValueChangedHandler = function () {
        if (!liveSw.value) return;
        if (livePreviewBusy) return;

        livePreviewBusy = true;

        try {
          doPreview();
        } catch (e) {
          try {
            clearPreview();
            statusTxt.text = "✖ Live preview error: " + e.message;
          } catch (ignore) {}
        } finally {
          livePreviewBusy = false;
        }
      };
    } catch (e) {}

    return {
      dlg,
      actionSet,
      readConfig,
      doPreview,
    };
  }

  let running = true;

  while (running) {
    const ui = buildDialog(currentConfig);

    try {
      if (currentConfig.livePreview) {
        ui.doPreview();
      } else {
        applyConfigToDocument(currentConfig, true);
      }
    } catch (e) {}

    const result = ui.dlg.runModal();
    const act = ui.actionSet.selectedIndex;

    if (!okPressed(result)) {
      clearPreview();
      restoreStart();
      running = false;
      break;
    }

    currentConfig = normalizePresetConfig(ui.readConfig());
    currentConfig.phase = degToRad(currentConfig.phaseDeg);

    if (act === 0) {
      ui.doPreview();
      continue;
    }

    if (act === 1) {
      try {
        clearPreview();
        applyConfigToDocument(currentConfig, false);
        app.alert(TITLE + " complete.", TITLE);
      } catch (e) {
        app.alert(TITLE + " error:\n\n" + e.message, TITLE);
      }
      running = false;
      break;
    }

    if (act === 2) {
      savePreset(currentConfig);
      continue;
    }

    if (act === 3) {
      const loaded = loadPreset();
      if (loaded) {
        currentConfig = loaded;
        currentConfig.phase = degToRad(currentConfig.phaseDeg);
      }
      continue;
    }
  }
})();
