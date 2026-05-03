/**
 * name: Affinity Consistency Checker
 * description: Easily maintain design consistency by inspecting and remapping font faces, sizes, and stroke weights. Also includes a tool to clean up invisible garbage nodes.
 * version: 1.0.1
 * author: Shigeru Kobayashi
 */

var app = require('/application.js').app;
var Commands = require('/commands.js');
var Dialog = require('/dialog.js').Dialog;
var DialogResult = require('/dialog.js').DialogResult;
var GlyphAttDoubleType = require('/glyphatts.js').GlyphAttDoubleType;
var StoryDelta = require('/storydelta.js').StoryDelta;
var TextSelection = require('/selections.js').TextSelection;
var Selection = require('/selections.js').Selection;
var Font = require('/fonts.js').Font;
var doc = app.documents.current;
var dpi = doc.dpi;
var pxToPt = 72 / dpi;

function r2(v) { return Math.round(v * 100) / 100; }

function setSpread(sp) {
  if (!doc.currentSpread.isSameNode(sp)) {
    doc.executeCommand(Commands.DocumentCommand.createSetCurrentSpread(sp));
  }
}

function findFont(name) {
  var all = Font.all;
  for (var i = 0; i < all.length; i++) {
    if (all[i].postscriptName === name) return all[i];
  }
  for (var j = 0; j < all.length; j++) {
    if (all[j].familyName === name) return all[j];
  }
  return null;
}

function applyTextDelta(node, delta, range) {
  var sel = Selection.create(doc, node);
  var textSel = TextSelection.create([range]);
  sel.addSubSelectionForNode(node, textSel);
  doc.formatText(delta, sel);
}

function isTextNode(node) {
  return node.isArtTextNode || node.isFrameTextNode;
}

// Walk starting from the spread itself (sp.children), then recurse.
// This works for both layered Publisher docs and flat Designer-style docs.
function scanAll() {
  var pathWs = {}, shapeWs = {}, ss = {}, gb = [];

  for (var sp of doc.spreads) {
    (function walk(parent) {
      for (var node of parent.children) {
        // Garbage: zero-size PolyCurveNode
        try {
          if (node.isPolyCurveNode) {
            var bb = node.baseBox;
            if (bb.height === 0 && bb.width < 10) { gb.push(node); }
          }
        } catch (e) { }

        // Stroke weight — skip text nodes, split paths vs shapes
        try {
          if (!isTextNode(node)) {
            var lsi = node.lineStyleInterface;
            if (lsi) {
              var w = r2(lsi.lineWeightPts);
              if (node.isPolyCurveNode) {
                pathWs[w] = (pathWs[w] || 0) + 1;
              } else {
                shapeWs[w] = (shapeWs[w] || 0) + 1;
              }
            }
          }
        } catch (e) { }

        // Font size
        try {
          var si = node.storyInterface;
          if (si) {
            var story = si.story, rng = si.storyRange, seen = {};
            for (var i = rng.begin; i < rng.begin + rng.length; i++) {
              try {
                var pt = r2(story.getGlyphAtts(i).getDoubleValue(GlyphAttDoubleType.Height) * pxToPt);
                if (pt >= 4 && !seen[pt]) { seen[pt] = true; ss[pt] = (ss[pt] || 0) + 1; }
              } catch (e2) { }
            }
          }
        } catch (e) { }

        try { walk(node); } catch (e) { }
      }
    })(sp);  // <-- walk starts from spread, not from individual layers
  }

  var fn = []; try { fn = doc.getFontNames(); } catch (e) { }
  return { pathWs: pathWs, shapeWs: shapeWs, ss: ss, gb: gb, faces: fn.slice().sort() };
}

var s = scanAll();
var pathWeights = Object.keys(s.pathWs).map(Number).sort(function (a, b) { return a - b; });
var shapeWeights = Object.keys(s.shapeWs).map(Number).sort(function (a, b) { return a - b; });
var allWeightsSet = {};
pathWeights.forEach(function (w) { allWeightsSet[w] = true; });
shapeWeights.forEach(function (w) { allWeightsSet[w] = true; });
var allWeights = Object.keys(allWeightsSet).map(Number).sort(function (a, b) { return a - b; });
var sizes = Object.keys(s.ss).map(Number).sort(function (a, b) { return a - b; });
var faces = s.faces;
var gcnt = s.gb.length;

var dlg = Dialog.create('Style Consistency Checker');
var col = dlg.addColumn();

var delID = null;
if (gcnt > 0) {
  var gg = col.addGroup('Garbage nodes (' + gcnt + ')');
  delID = gg.addCheckBox('Delete them', false).controlID;
}
var faceCD = [];
for (var fi = 0; fi < faces.length; fi++) {
  var fname = faces[fi];
  var fg = col.addGroup('Font face: ' + fname);
  faceCD.push({ f: fname, id: fg.addComboBox('Remap to', ['No change'].concat(faces), 0).controlID });
}
var sizeCD = [];
for (var si2 = 0; si2 < sizes.length; si2++) {
  var sv = sizes[si2];
  var sg = col.addGroup('Font size: ' + sv + 'pt (' + s.ss[sv] + ' occurrences)');
  sizeCD.push({ s: sv, id: sg.addComboBox('Remap to', ['No change'].concat(sizes.map(function (x) { return x + 'pt'; })), 0).controlID });
}
var pathWtCD = [];
for (var pi = 0; pi < pathWeights.length; pi++) {
  var pv = pathWeights[pi];
  var pg = col.addGroup('Path stroke: ' + pv + 'pt (' + s.pathWs[pv] + ' occurrences)');
  pathWtCD.push({ w: pv, id: pg.addComboBox('Remap to', ['No change'].concat(allWeights.map(function (x) { return x + 'pt'; })), 0).controlID });
}
var shapeWtCD = [];
for (var shi = 0; shi < shapeWeights.length; shi++) {
  var shv = shapeWeights[shi];
  var shg = col.addGroup('Shape stroke: ' + shv + 'pt (' + s.shapeWs[shv] + ' occurrences)');
  shapeWtCD.push({ w: shv, id: shg.addComboBox('Remap to', ['No change'].concat(allWeights.map(function (x) { return x + 'pt'; })), 0).controlID });
}

var res = dlg.runModal();

if (res.value !== DialogResult.Ok.value) {
  app.alert('Operation cancelled.', 'Style Consistency Checker');
} else {
  var doDelGb = delID ? dlg.findControl(delID).value : false;
  var fRemap = {};
  for (var fi2 = 0; fi2 < faceCD.length; fi2++) {
    var idx = dlg.findControl(faceCD[fi2].id).selectedIndex;
    if (idx > 0) fRemap[faceCD[fi2].f] = faces[idx - 1];
  }
  var sRemap = {};
  for (var si3 = 0; si3 < sizeCD.length; si3++) {
    var idx2 = dlg.findControl(sizeCD[si3].id).selectedIndex;
    if (idx2 > 0) sRemap[sizeCD[si3].s] = sizes[idx2 - 1];
  }
  var pathWRemap = {};
  for (var pi2 = 0; pi2 < pathWtCD.length; pi2++) {
    var idx3 = dlg.findControl(pathWtCD[pi2].id).selectedIndex;
    if (idx3 > 0) pathWRemap[pathWtCD[pi2].w] = allWeights[idx3 - 1];
  }
  var shapeWRemap = {};
  for (var shi2 = 0; shi2 < shapeWtCD.length; shi2++) {
    var idx4 = dlg.findControl(shapeWtCD[shi2].id).selectedIndex;
    if (idx4 > 0) shapeWRemap[shapeWtCD[shi2].w] = allWeights[idx4 - 1];
  }

  var delCnt = 0, wCnt = 0, sCnt = 0, fCnt = 0, errs = [];

  if (doDelGb) {
    var s2 = scanAll();
    for (var gi = 0; gi < s2.gb.length; gi++) {
      try { s2.gb[gi].delete(); delCnt++; } catch (e) { errs.push('del:' + e.message); }
    }
  }

  var hasW = Object.keys(pathWRemap).length > 0 || Object.keys(shapeWRemap).length > 0;
  var hasS = Object.keys(sRemap).length > 0;
  var hasF = Object.keys(fRemap).length > 0;

  if (hasW || hasS || hasF) {
    for (var spread of doc.spreads) {
      setSpread(spread);
      (function applyWalk(parent) {
        for (var node of parent.children) {
          if (hasW && !isTextNode(node)) {
            try {
              var lsi2 = node.lineStyleInterface;
              if (lsi2) {
                var cw = r2(lsi2.lineWeightPts);
                var remap = node.isPolyCurveNode ? pathWRemap : shapeWRemap;
                if (remap[cw] !== undefined) { lsi2.lineWeightPts = remap[cw]; wCnt++; }
              }
            } catch (e) { errs.push('w:' + e.message); }
          }
          if (hasS || hasF) {
            try {
              var si4 = node.storyInterface;
              if (si4) {
                var story2 = si4.story, rng2 = si4.storyRange;
                if (hasS) {
                  var i2 = rng2.begin;
                  while (i2 < rng2.begin + rng2.length) {
                    try {
                      var h2 = story2.getGlyphAtts(i2).getDoubleValue(GlyphAttDoubleType.Height);
                      var cp = r2(h2 * pxToPt);
                      if (sRemap[cp] !== undefined) {
                        var nh = sRemap[cp] / pxToPt;
                        var j2 = i2 + 1;
                        while (j2 < rng2.begin + rng2.length) {
                          try {
                            if (r2(story2.getGlyphAtts(j2).getDoubleValue(GlyphAttDoubleType.Height) * pxToPt) !== cp) break;
                          } catch (e2) { break; }
                          j2++;
                        }
                        applyTextDelta(node, StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, nh), { begin: i2, length: j2 - i2 });
                        sCnt++; i2 = j2;
                      } else { i2++; }
                    } catch (e) { i2++; }
                  }
                }
                if (hasF) {
                  for (var ff in fRemap) {
                    var toFont = findFont(fRemap[ff]);
                    if (toFont) {
                      try {
                        applyTextDelta(node, StoryDelta.createFont(0x04, toFont), rng2);
                        fCnt++;
                      } catch (e) { errs.push('f:' + e.message); }
                    } else { errs.push('Font not found: ' + fRemap[ff]); }
                  }
                }
              }
            } catch (e) { }
          }
          try { applyWalk(node); } catch (e) { }
        }
      })(spread);  // <-- apply walk also starts from spread
    }
  }

  var msg = [];
  if (doDelGb) msg.push('Garbage deleted: ' + delCnt + ' nodes');
  if (hasW) msg.push('Stroke weight changed: ' + wCnt + ' nodes');
  if (hasS) msg.push('Font size changed: ' + sCnt + ' runs');
  if (hasF) msg.push('Font face changed: ' + fCnt + ' runs');
  if (!doDelGb && !hasW && !hasS && !hasF) msg.push('No changes made.');
  if (errs.length) msg.push('Errors: ' + errs.slice(0, 3).join(', '));
  app.alert(msg.join('\n'), 'Done');
}
