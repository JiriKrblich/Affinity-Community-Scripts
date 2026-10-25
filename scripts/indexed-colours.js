
'use strict';
// Indexed Colours v16
// ROOT-CAUSE FIX for incomplete preview rollback in large documents:
//  * Affinity's undo history is limited in depth (measured: roughly 1070-1080 steps).
//    v15 wrote every changed fill/stroke/text as its OWN history step, so a document with
//    > ~1000 changed fills pushed the OLDEST preview steps out of the history — they could
//    not be rolled back and stayed applied ("preview builds on the previous result",
//    "cancel leaves objects changed").
//  * v16 batches ALL vector changes (solid fills, gradient stops, strokes, text fill/outline)
//    into ONE CompoundCommand = one history step, regardless of the object count.
//    (Measured on 547 changes: 1 compound step; 4 preview cycles + cancel restored
//    solids, gradients, hatches and text exactly.) Bitmaps stay separate steps (few, large).
//  * Robust rollback: setting doc.history.position can fail with COMMAND_FAILED when the
//    start position is 0 (document without any history yet, e.g. just opened). v16 falls
//    back to stepping back with history.undo() until the start position is reached, and
//    logs a warning if it still cannot be reached.
// All v15 features retained (selection incl. group children, scope computed once,
// selection restore only via snapshot, bitmap replace via layer.selfSelection, text
// fill/outline, gradients, dithering, ASE export via Buffer, k-means++, adaptive
// sampling, live preview).

const { Document }              = require('/document.js');
const { Selection }             = require('/selections.js');
const { RGBA8, RGBA16, CMYKA8, Colour } = require('/colours.js');
const { Dialog, DialogResult }  = require('/dialog.js');
const { FillType, FillDescriptor } = require('/fills.js');
const { UnitType }              = require('/units.js');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
const { StoryDelta }            = require('/storydelta.js');
const { File }                  = require('/fs.js');
const { Buffer }                = require('/buffer.js');
const { app }                   = require('/application.js');

const FMT_RGBA8  = 0;
const FMT_RGBA16 = 1;
const FMT_CMYKA8 = 4;

// ─── PRNG ─────────────────────────────────────────────────────────────────────
function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ─── Black & white ────────────────────────────────────────────────────────────
function blackAndWhite(fmt) {
    if (fmt === FMT_RGBA16) return [
        { native:{r:65535,g:65535,b:65535,alpha:65535}, hsl:{h:0,s:0,l:1} },
        { native:{r:0,    g:0,    b:0,    alpha:65535}, hsl:{h:0,s:0,l:0} },
    ];
    if (fmt === FMT_CMYKA8) return [
        { native:{c:0,m:0,y:0,k:0,  alpha:255}, hsl:{h:0,s:0,l:1} },
        { native:{c:0,m:0,y:0,k:255,alpha:255}, hsl:{h:0,s:0,l:0} },
    ];
    return [
        { native:{r:255,g:255,b:255,alpha:255}, hsl:{h:0,s:0,l:1} },
        { native:{r:0,  g:0,  b:0,  alpha:255}, hsl:{h:0,s:0,l:0} },
    ];
}

// ─── HSL helpers ──────────────────────────────────────────────────────────────
function hslDist(a, b) {
    const dh = Math.min(Math.abs(a.h-b.h), 1-Math.abs(a.h-b.h)) * 2;
    return Math.sqrt(dh*dh + (a.s-b.s)**2 + (a.l-b.l)**2);
}
function rgbToHsl(r, g, b) {
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    let h=0, s=0; const l=(max+min)/2;
    if (max !== min) {
        const d=max-min; s=l>0.5?d/(2-max-min):d/(max+min);
        if      (max===r) h=((g-b)/d+(g<b?6:0))/6;
        else if (max===g) h=((b-r)/d+2)/6;
        else              h=((r-g)/d+4)/6;
    }
    return {h, s, l};
}

// ─── Key functions ────────────────────────────────────────────────────────────
function exactKey(n, fmt) {
    if (fmt === FMT_RGBA16) return (n.r & 0xFFFF) * 0x100000000 + (n.g & 0xFFFF) * 0x10000 + (n.b & 0xFFFF);
    if (fmt === FMT_CMYKA8) return ((n.c<<24)|(n.m<<16)|(n.y<<8)|n.k) >>> 0;
    return (n.r << 16) | (n.g << 8) | n.b;
}
function bucketKey(n) {
    return ((n.r>>3)<<10) | ((n.g>>3)<<5) | (n.b>>3);
}

// ─── Colour helpers ───────────────────────────────────────────────────────────
function extractColour(colObj, fmt) {
    try {
        const hslaf = colObj.hslaf; if (!hslaf) return null;
        let native;
        if (fmt === FMT_RGBA16)      native = colObj.rgba16;
        else if (fmt === FMT_CMYKA8) native = colObj.cmyka8;
        else                          native = colObj.rgba8;
        if (!native) return null;
        return { native: Object.assign({}, native), hsl:{h:hslaf.h,s:hslaf.s,l:hslaf.l} };
    } catch(e) { return null; }
}
function makeColour(native, fmt) {
    if (fmt === FMT_RGBA16)      return RGBA16(native.r, native.g, native.b, native.alpha);
    else if (fmt === FMT_CMYKA8) return CMYKA8(native.c, native.m, native.y, native.k, native.alpha);
    else                          return RGBA8(native.r, native.g, native.b, native.alpha);
}
function nativeAlpha(colObj, fmt) {
    try {
        if (fmt === FMT_RGBA16) return colObj.rgba16 ? colObj.rgba16.alpha : 65535;
        if (fmt === FMT_CMYKA8) return colObj.cmyka8 ? colObj.cmyka8.alpha : 255;
        return colObj.rgba8 ? colObj.rgba8.alpha : 255;
    } catch(e) { return 255; }
}
function nodeArea(layer) {
    try {
        const bb = layer.baseBoxInterface && layer.baseBoxInterface.baseBox;
        if (bb && bb.width > 0 && bb.height > 0) return bb.width * bb.height;
    } catch(e) {}
    return 1;
}
function layerPass(layer, skipHidden, skipLocked) {
    if (skipHidden && layer.isVisible === false) return false;
    if (skipLocked && layer.isLocked === true)  return false;
    return true;
}

// ─── Text nodes ───────────────────────────────────────────────────────────────
function isTextNode(node) {
    try {
        const tag = node[Symbol.toStringTag];
        return tag === 'ArtTextNode' || tag === 'FrameTextNode';
    } catch(e) { return false; }
}
function getTextRuns(node, usePen) {
    const out = [];
    try {
        const story = node.story;
        for (const run of story.glyphAttRuns) {
            try {
                const ga = story.getGlyphAtts(run.begin);
                const fd = usePen ? ga.penFill : ga.brushFill;
                if (fd) out.push({ begin: run.begin, end: run.end, fd });
            } catch(e) {}
        }
    } catch(e) {}
    return out;
}

// ─── Selection scope ──────────────────────────────────────────────────────────
function snapshotSelectionNodes(doc) {
    try { return doc.selection.nodes.toArray(); } catch(e) { return []; }
}
function buildScopeNodes(doc, selNodes) {
    const out = [];
    if (!selNodes || selNodes.length === 0) return out;
    for (const layer of doc.layers.all) {
        let p = layer, depth = 0, hit = false;
        while (p && depth < 128 && !hit) {
            for (const s of selNodes) {
                try { if (p.isSameNode(s)) { hit = true; break; } } catch(e) {}
            }
            if (hit) break;
            try { p = p.parent; } catch(e) { p = null; }
            depth++;
        }
        if (hit) out.push(layer);
    }
    return out;
}
function selectionMatches(doc, nodes) {
    let cur = [];
    try { cur = doc.selection.nodes.toArray(); } catch(e) { return false; }
    if (cur.length !== nodes.length) return false;
    for (const n of nodes) {
        let found = false;
        for (const c of cur) { try { if (c.isSameNode(n)) { found = true; break; } } catch(e) {} }
        if (!found) return false;
    }
    return true;
}
// Any selection change after an edit is its own history step → restore only if changed.
function restoreSelection(doc, selNodes) {
    try {
        if (selNodes && selNodes.length > 0 && !selectionMatches(doc, selNodes)) {
            doc.selection = Selection.create(doc, selNodes);
        }
    } catch(e) {}
}

// ─── Robust history rollback (v16) ────────────────────────────────────────────
// 1) jump via doc.history.position; 2) if that throws (e.g. COMMAND_FAILED when the
// start position is 0 — a document without history) or does not reach the target,
// step back with history.undo(); 3) warn if the target still is not reached.
function rollbackToPosition(doc, pos) {
    try {
        if (doc.history.position !== pos) doc.history.position = pos;
    } catch(e) {
        console.log('History jump failed (' + e.message + ') – falling back to step-wise undo.');
    }
    let guard = 0;
    while (doc.history.position > pos && doc.history.canUndo && guard < 10000) {
        try { doc.history.undo(); } catch(e) { console.log('Undo error: ' + e.message); break; }
        guard++;
    }
    if (doc.history.position !== pos) {
        console.log('Warning: history rollback incomplete (position ' + doc.history.position + ' instead of ' + pos + ').');
    }
}

// ─── Collect colours ──────────────────────────────────────────────────────────
const BITMAP_SAMPLE_TARGET = 50000;

function collectVectorColours(layers, fmt, weightMode, skipHidden, skipLocked) {
    const freq = new Map();

    function record(colObj, area) {
        const ex = extractColour(colObj, fmt);
        if (!ex) return;
        if ((ex.native.alpha != null ? ex.native.alpha : 255) < 10) return;
        const k = exactKey(ex.native, fmt);
        const w = weightMode === 'area' ? area : weightMode === 'count' ? 1 : Math.sqrt(area);
        if (freq.has(k)) freq.get(k).weight += w;
        else freq.set(k, { native: ex.native, hsl: ex.hsl, weight: w });
    }
    function recordGradient(fd, area) {
        try {
            const g = fd.fill.gradient;
            for (let i = 0; i < g.stopCount; i++) {
                const s = g.getStop(i);
                record(new Colour(s.colour), area / g.stopCount);
            }
        } catch(e) {}
    }

    for (const layer of layers) {
        if (!layerPass(layer, skipHidden, skipLocked)) continue;
        const area = nodeArea(layer);

        if (isTextNode(layer)) {
            try {
                for (const run of getTextRuns(layer, false)) {
                    const ft = run.fd.fill.fillType.value;
                    if (ft === FillType.Solid.value && run.fd.fill.colour) record(run.fd.fill.colour, area);
                    else if (ft === 3) recordGradient(run.fd, area);
                }
            } catch(e) {}
            try {
                for (const run of getTextRuns(layer, true)) {
                    const ft = run.fd.fill.fillType.value;
                    if (ft === FillType.Solid.value && run.fd.fill.colour) record(run.fd.fill.colour, area * 0.25);
                    else if (ft === 3) recordGradient(run.fd, area * 0.25);
                }
            } catch(e) {}
            continue;
        }

        try {
            const bfd = layer.brushFillDescriptor;
            if (bfd && bfd.fill) {
                const ft = bfd.fill.fillType.value;
                if (ft === FillType.Solid.value && bfd.fill.colour) record(bfd.fill.colour, area);
                else if (ft === 3) recordGradient(bfd, area);
            }
        } catch(e) {}
        try {
            const pfd = layer.penFillDescriptor;
            if (pfd && pfd.fill) {
                const ft = pfd.fill.fillType.value;
                if (ft === FillType.Solid.value && pfd.fill.colour) record(pfd.fill.colour, area * 0.25);
                else if (ft === 3) recordGradient(pfd, area * 0.25);
            }
        } catch(e) {}
    }
    return freq;
}

function collectBitmapColours(layers, weightMode, skipHidden, skipLocked) {
    const freq = new Map();
    for (const layer of layers) {
        if (!layerPass(layer, skipHidden, skipLocked)) continue;
        try {
            const ri = layer.rasterInterface;
            if (!ri) continue;
            const W = layer.rasterWidth, H = layer.rasterHeight;
            if (!W || !H) continue;
            const rfmt = layer.rasterFormat ? layer.rasterFormat.value : 0;
            const buf  = ri.createCompatibleBuffer(true);
            const area = nodeArea(layer);
            const rawStep = Math.max(1, Math.ceil(Math.sqrt(W * H / BITMAP_SAMPLE_TARGET)));
            const sampleStep = Math.min(rawStep, Math.max(1, Math.min(W, H) >> 1));

            let getPixel;
            if (rfmt === 1) {
                const arr = new Uint16Array(buf.buffer);
                getPixel = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<6554)return null; return{r:Math.round(arr[i]/257),g:Math.round(arr[i+1]/257),b:Math.round(arr[i+2]/257)}; };
            } else if (rfmt === 9) {
                const arr = new Float32Array(buf.buffer);
                const gc = v => Math.round(Math.pow(Math.max(0,Math.min(1,v)),1/2.2)*255);
                getPixel = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<0.1)return null; return{r:gc(arr[i]),g:gc(arr[i+1]),b:gc(arr[i+2])}; };
            } else {
                const arr = new Uint8Array(buf.buffer);
                getPixel = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<25)return null; return{r:arr[i],g:arr[i+1],b:arr[i+2]}; };
            }

            const w = weightMode === 'area'  ? area / (sampleStep*sampleStep)
                    : weightMode === 'count' ? 1
                    : Math.sqrt(area) / sampleStep;

            for (let y=0; y<H; y+=sampleStep) {
                for (let x=0; x<W; x+=sampleStep) {
                    const px = getPixel(x, y);
                    if (!px) continue;
                    const k = bucketKey(px);
                    const hsl = rgbToHsl(px.r/255, px.g/255, px.b/255);
                    if (freq.has(k)) freq.get(k).weight += w;
                    else freq.set(k, { native:{r:px.r,g:px.g,b:px.b,alpha:255}, hsl, weight:w });
                }
            }
        } catch(e) {}
    }
    return freq;
}

function mergeMaps(a, b) {
    const m = new Map(a);
    for (const [k,v] of b) { if (m.has(k)) m.get(k).weight += v.weight; else m.set(k, v); }
    return m;
}

// ─── k-means++ ────────────────────────────────────────────────────────────────
function kMeansPP(entries, k, maxIter, seed) {
    if (entries.length <= k) return entries.slice();
    const rng = mulberry32(seed);
    const centroids = [];
    centroids.push({ ...entries[Math.floor(rng() * entries.length)].hsl });
    for (let ci = 1; ci < k; ci++) {
        const d2 = entries.map(e => {
            let best = Infinity;
            for (const c of centroids) { const d = hslDist(e.hsl, c); if (d < best) best = d; }
            return best * best * e.weight;
        });
        const sum = d2.reduce((a,b) => a+b, 0);
        let r = rng() * sum, cumul = 0, chosen = entries.length - 1;
        for (let i = 0; i < d2.length; i++) { cumul += d2[i]; if (cumul >= r) { chosen = i; break; } }
        centroids.push({ ...entries[chosen].hsl });
    }
    const asgn = new Array(entries.length).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;
        for (let i = 0; i < entries.length; i++) {
            let best=0, bestD=Infinity;
            for (let j=0; j<k; j++) { const d=hslDist(entries[i].hsl,centroids[j]); if(d<bestD){bestD=d;best=j;} }
            if (asgn[i]!==best) { asgn[i]=best; changed=true; }
        }
        if (!changed) break;
        const acc = Array.from({length:k}, ()=>({h:0,s:0,l:0,w:0}));
        for (let i=0; i<entries.length; i++) {
            const a=acc[asgn[i]], w=entries[i].weight;
            a.h+=entries[i].hsl.h*w; a.s+=entries[i].hsl.s*w; a.l+=entries[i].hsl.l*w; a.w+=w;
        }
        for (let j=0; j<k; j++) if(acc[j].w>0) {
            centroids[j].h=acc[j].h/acc[j].w; centroids[j].s=acc[j].s/acc[j].w; centroids[j].l=acc[j].l/acc[j].w;
        }
    }
    const rep=new Array(k).fill(null), repW=new Array(k).fill(0);
    for (let i=0; i<entries.length; i++) {
        const j=asgn[i]; if(entries[i].weight>repW[j]){repW[j]=entries[i].weight;rep[j]=entries[i];}
    }
    return rep.filter(Boolean);
}

function weightTop(entries, k) {
    return [...entries].sort((a,b) => b.weight-a.weight).slice(0, k);
}

// ─── Nearest & palette ────────────────────────────────────────────────────────
function nearest(hsl, palette) {
    let best=palette[0], bestD=Infinity;
    for (const p of palette) { const d=hslDist(hsl,p.hsl); if(d===0)return p; if(d<bestD){bestD=d;best=p;} }
    return best;
}

function buildFinalPalette(computed, fmt) {
    const bw = blackAndWhite(fmt);
    const result = [];
    const hasWhite = computed.some(e => e.hsl.l>0.95 && e.hsl.s<0.05);
    const hasBlack = computed.some(e => e.hsl.l<0.05 && e.hsl.s<0.05);
    if (!hasWhite) result.push(bw[0]);
    if (!hasBlack) result.push(bw[1]);
    for (const e of computed) {
        if (!hasWhite && e.hsl.l>0.95 && e.hsl.s<0.05) continue;
        if (!hasBlack && e.hsl.l<0.05 && e.hsl.s<0.05) continue;
        result.push(e);
    }
    return result;
}

// ─── Batch helpers (v16): add commands to ONE compound ────────────────────────
// Gradient: map each stop to the palette; returns a new FillDescriptor or null if unchanged.
function remapGradientFD(fd, palette) {
    const g = fd.fill.gradient;
    const newStops = []; let anyChange = false;
    for (let i = 0; i < g.stopCount; i++) {
        const s = g.getStop(i);
        const col = new Colour(s.colour); const hslaf = col.hslaf;
        const p = nearest({h:hslaf.h,s:hslaf.s,l:hslaf.l}, palette);
        if (hslDist({h:hslaf.h,s:hslaf.s,l:hslaf.l}, p.hsl) > 0.001) anyChange = true;
        newStops.push({ colour: Colour.createHSLAf({h:p.hsl.h,s:p.hsl.s,l:p.hsl.l,alpha:hslaf.alpha}), position:s.position, midpoint:s.midpoint });
    }
    if (!anyChange) return null;
    const newGF = fd.fill.constructor.create(g.constructor.create(newStops), fd.fill.gradientFillType);
    return FillDescriptor.create(newGF, fd.isScaleWithObject, fd.transform, fd.blendMode, fd.isAnchoredToSpread);
}

function addVectorCommands(builder, doc, layer, palette, fmt) {
    let n = 0;

    if (isTextNode(layer)) {
        for (const usePen of [false, true]) {
            try {
                for (const run of getTextRuns(layer, usePen)) {
                    const ft = run.fd.fill.fillType.value;
                    let newFD = null;
                    if (ft === FillType.Solid.value && run.fd.fill.colour) {
                        const hslaf = run.fd.fill.colour.hslaf;
                        if (!hslaf) continue;
                        const p = nearest({h:hslaf.h,s:hslaf.s,l:hslaf.l}, palette);
                        const orig = extractColour(run.fd.fill.colour, fmt);
                        if (orig && exactKey(orig.native,fmt) !== exactKey(p.native,fmt)) {
                            const alpha = nativeAlpha(run.fd.fill.colour, fmt);
                            newFD = FillDescriptor.createSolid(makeColour({...p.native, alpha}, fmt));
                        }
                    } else if (ft === 3) {
                        newFD = remapGradientFD(run.fd, palette);
                    }
                    if (newFD) {
                        const delta = usePen ? StoryDelta.createPenFill(newFD) : StoryDelta.createBrushFill(newFD);
                        builder.addCommand(DocumentCommand.createFormatText(layer.selfSelection, delta));
                        n++;
                    }
                }
            } catch(e) {}
        }
        return n;
    }

    // Brush fill
    try {
        const bfd = layer.brushFillDescriptor;
        if (bfd && bfd.fill) {
            const ft = bfd.fill.fillType.value;
            if (ft === FillType.Solid.value && bfd.fill.colour) {
                const hslaf = bfd.fill.colour.hslaf;
                if (hslaf) {
                    const p = nearest({h:hslaf.h,s:hslaf.s,l:hslaf.l}, palette);
                    const orig = extractColour(bfd.fill.colour, fmt);
                    if (orig && exactKey(orig.native,fmt) !== exactKey(p.native,fmt)) {
                        const nfd = FillDescriptor.createSolid(makeColour({...p.native, alpha:nativeAlpha(bfd.fill.colour,fmt)}, fmt));
                        builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, [layer]), nfd));
                        n++;
                    }
                }
            } else if (ft === 3) {
                const nfd = remapGradientFD(bfd, palette);
                if (nfd) { builder.addCommand(DocumentCommand.createSetBrushFill(Selection.create(doc, [layer]), nfd)); n++; }
            }
        }
    } catch(e) {}

    // Pen fill
    try {
        const pfd = layer.penFillDescriptor;
        if (pfd && pfd.fill) {
            const ft = pfd.fill.fillType.value;
            if (ft === FillType.Solid.value && pfd.fill.colour) {
                const hslaf = pfd.fill.colour.hslaf;
                if (hslaf) {
                    const p = nearest({h:hslaf.h,s:hslaf.s,l:hslaf.l}, palette);
                    const orig = extractColour(pfd.fill.colour, fmt);
                    if (orig && exactKey(orig.native,fmt) !== exactKey(p.native,fmt)) {
                        const nfd = FillDescriptor.createSolid(makeColour({...p.native, alpha:nativeAlpha(pfd.fill.colour,fmt)}, fmt));
                        builder.addCommand(DocumentCommand.createSetPenFill(Selection.create(doc, [layer]), nfd));
                        n++;
                    }
                }
            } else if (ft === 3) {
                const nfd = remapGradientFD(pfd, palette);
                if (nfd) { builder.addCommand(DocumentCommand.createSetPenFill(Selection.create(doc, [layer]), nfd)); n++; }
            }
        }
    } catch(e) {}

    return n;
}

// ALL vector changes in ONE compound command = ONE history step.
function applyToVectors(doc, layers, palette, fmt, skipHidden, skipLocked) {
    const builder = CompoundCommandBuilder.create();
    let n = 0;
    for (const layer of layers) {
        if (!layerPass(layer, skipHidden, skipLocked)) continue;
        n += addVectorCommands(builder, doc, layer, palette, fmt);
    }
    if (n > 0) doc.executeCommand(builder.createCommand());
    return n;
}

// ─── Apply to bitmaps (optional Floyd-Steinberg dithering) ────────────────────
function applyToBitmaps(doc, layers, palette, dither, skipHidden, skipLocked) {
    for (const layer of layers) {
        if (!layerPass(layer, skipHidden, skipLocked)) continue;
        try {
            const ri = layer.rasterInterface;
            if (!ri) continue;
            const W = layer.rasterWidth, H = layer.rasterHeight;
            if (!W || !H) continue;
            const rfmt = layer.rasterFormat ? layer.rasterFormat.value : 0;
            const buf  = ri.createCompatibleBuffer(true);
            let changed = false;

            let getF, setF;
            if (rfmt === 1) {
                const arr = new Uint16Array(buf.buffer);
                getF = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<6554)return null; return[arr[i]/65535,arr[i+1]/65535,arr[i+2]/65535]; };
                setF = (x,y,r,g,b) => { const i=(y*W+x)*4; const nr=Math.round(r*65535),ng=Math.round(g*65535),nb=Math.round(b*65535); if(arr[i]!==nr||arr[i+1]!==ng||arr[i+2]!==nb){arr[i]=nr;arr[i+1]=ng;arr[i+2]=nb;changed=true;} };
            } else if (rfmt === 9) {
                const arr = new Float32Array(buf.buffer);
                const gam = v => Math.pow(Math.max(0,Math.min(1,v)),1/2.2);
                const lin = v => Math.pow(Math.max(0,Math.min(1,v)),2.2);
                getF = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<0.1)return null; return[gam(arr[i]),gam(arr[i+1]),gam(arr[i+2])]; };
                setF = (x,y,r,g,b) => { const i=(y*W+x)*4; const nr=lin(r),ng=lin(g),nb=lin(b); if(Math.abs(arr[i]-nr)>0.001||Math.abs(arr[i+1]-ng)>0.001||Math.abs(arr[i+2]-nb)>0.001){arr[i]=nr;arr[i+1]=ng;arr[i+2]=nb;changed=true;} };
            } else {
                const arr = new Uint8Array(buf.buffer);
                getF = (x,y) => { const i=(y*W+x)*4; if(arr[i+3]<25)return null; return[arr[i]/255,arr[i+1]/255,arr[i+2]/255]; };
                setF = (x,y,r,g,b) => { const i=(y*W+x)*4; const nr=Math.round(r*255),ng=Math.round(g*255),nb=Math.round(b*255); if(arr[i]!==nr||arr[i+1]!==ng||arr[i+2]!==nb){arr[i]=nr;arr[i+1]=ng;arr[i+2]=nb;changed=true;} };
            }

            if (dither) {
                const err = new Float32Array(W * H * 3);
                for (let y=0; y<H; y++) {
                    for (let x=0; x<W; x++) {
                        const px = getF(x, y); if (!px) continue;
                        const ei = (y*W+x)*3;
                        const cr=Math.max(0,Math.min(1,px[0]+err[ei]));
                        const cg=Math.max(0,Math.min(1,px[1]+err[ei+1]));
                        const cb=Math.max(0,Math.min(1,px[2]+err[ei+2]));
                        const p = nearest(rgbToHsl(cr,cg,cb), palette);
                        const pr=p.native.r/255, pg=p.native.g/255, pb=p.native.b/255;
                        setF(x,y,pr,pg,pb);
                        const er=cr-pr, eg=cg-pg, eb=cb-pb;
                        const addErr = (nx,ny,f) => {
                            if(nx<0||nx>=W||ny<0||ny>=H)return;
                            const ni=(ny*W+nx)*3; err[ni]+=er*f; err[ni+1]+=eg*f; err[ni+2]+=eb*f;
                        };
                        addErr(x+1,y,7/16); addErr(x-1,y+1,3/16);
                        addErr(x,y+1,5/16); addErr(x+1,y+1,1/16);
                    }
                }
            } else {
                for (let y=0; y<H; y++) {
                    for (let x=0; x<W; x++) {
                        const px = getF(x,y); if (!px) continue;
                        const p = nearest(rgbToHsl(px[0],px[1],px[2]), palette);
                        setF(x,y,p.native.r/255,p.native.g/255,p.native.b/255);
                    }
                }
            }

            if (changed) {
                const bm = ri.createCompatibleBitmap(false);
                buf.copyTo(bm, {x:0,y:0,width:W,height:H}, 0, 0);
                doc.executeCommand(DocumentCommand.createReplaceBitmap(layer.selfSelection, bm));
                console.log('Bitmap updated: '+(layer.userDescription||layer.defaultDescription||'?'));
            } else {
                console.log('Bitmap unchanged: '+(layer.userDescription||layer.defaultDescription||'?'));
            }
        } catch(e) { console.log('Bitmap error: '+e.message); }
    }
}

// ─── ASE export (Affinity Buffer + explicit length) ───────────────────────────
function saveAse(palette, fmt) {
    try {
        function toRGBf(n,f) {
            if(f===FMT_RGBA16) return{r:n.r/65535,g:n.g/65535,b:n.b/65535};
            if(f===FMT_CMYKA8){const k=n.k/255;return{r:(1-n.c/255)*(1-k),g:(1-n.m/255)*(1-k),b:(1-n.y/255)*(1-k)};}
            return{r:n.r/255,g:n.g/255,b:n.b/255};
        }
        const blocks=palette.map((p,i)=>{
            const name=i===0?'White':i===1?'Black':'Colour '+(i-1);
            const rgb=toRGBf(p.native,fmt);
            const nu16=[...name].map(c=>c.charCodeAt(0)); nu16.push(0);
            return{nu16,rgb,dataSize:2+nu16.length*2+4+12+2};
        });
        const total=12+blocks.reduce((s,b)=>s+6+b.dataSize,0);
        const arrBuf=new ArrayBuffer(total); const dv=new DataView(arrBuf); let off=0;
        [0x41,0x53,0x45,0x46].forEach(b=>dv.setUint8(off++,b));
        dv.setUint32(off,0x00010000,false); off+=4;
        dv.setUint32(off,blocks.length,false); off+=4;
        for(const b of blocks){
            dv.setUint16(off,0x0001,false); off+=2;
            dv.setUint32(off,b.dataSize,false); off+=4;
            dv.setUint16(off,b.nu16.length,false); off+=2;
            b.nu16.forEach(c=>{dv.setUint16(off,c,false);off+=2;});
            [0x52,0x47,0x42,0x20].forEach(c=>dv.setUint8(off++,c));
            dv.setFloat32(off,b.rgb.r,false); off+=4;
            dv.setFloat32(off,b.rgb.g,false); off+=4;
            dv.setFloat32(off,b.rgb.b,false); off+=4;
            dv.setUint16(off,0x0000,false); off+=2;
        }
        const rawBytes = new Uint8Array(arrBuf);
        const abuf = Buffer.create(rawBytes.length);
        new Uint8Array(abuf.buffer).set(rawBytes);
        const path = app.userDesktopPath + '/IndexedColours.ase';
        const f = new File(path, 'wb');
        const written = f.write(abuf, abuf.length);
        f.close();
        if (written !== rawBytes.length) console.log('ASE export warning: wrote ' + written + ' of ' + rawBytes.length + ' bytes.');
        else {
            console.log('ASE saved: ' + path + ' (' + written + ' bytes, ' + palette.length + ' colours)');
            console.log('Import: Swatches panel > ☰ > Import Palette > As Document Palette');
        }
    } catch(e) { console.log('ASE export failed: '+e.message); }
}

// ─── Core ─────────────────────────────────────────────────────────────────────
function buildPalette(layers, fmt, userCount, useKMeans, weightMode, skipHidden, skipLocked) {
    const vectorMap = collectVectorColours(layers, fmt, weightMode, skipHidden, skipLocked);
    const bitmapMap = collectBitmapColours(layers, weightMode, skipHidden, skipLocked);
    const merged    = mergeMaps(vectorMap, bitmapMap);
    const totalUnique = merged.size;
    const totalTarget = userCount + 2;
    if (merged.size === 0) return { palette:null, totalUnique, totalTarget };
    if (totalUnique <= totalTarget) return { palette:null, totalUnique, totalTarget };
    const entries = Array.from(merged.values()).filter(e =>
        !(e.hsl.l>0.95 && e.hsl.s<0.05) && !(e.hsl.l<0.05 && e.hsl.s<0.05)
    );
    let computed = [];
    if (userCount > 0 && entries.length > 0) {
        computed = useKMeans
            ? kMeansPP(entries, userCount, 30, Date.now() & 0xFFFFFF)
            : weightTop(entries, userCount);
    }
    return { palette: buildFinalPalette(computed, fmt), totalUnique, totalTarget };
}

function applyAll(doc, layers, palette, fmt, dither, skipHidden, skipLocked) {
    applyToBitmaps(doc, layers, palette, dither, skipHidden, skipLocked);
    applyToVectors(doc, layers, palette, fmt, skipHidden, skipLocked);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const doc = Document.current;
if (!doc) {
    console.log('No document open.');
} else {
    const docFmt  = doc.format ? doc.format.value : FMT_RGBA8;
    const fmtName = docFmt===FMT_RGBA16?'RGBA16':docFmt===FMT_CMYKA8?'CMYK8':'RGBA8';

    // Snapshot selection + scope ONCE, before any edit / preview.
    const originalSelNodes = snapshotSelectionNodes(doc);
    const scopeNodes       = buildScopeNodes(doc, originalSelNodes);

    function getTargetLayers(selectionOnly) {
        return selectionOnly ? scopeNodes : Array.from(doc.layers.all);
    }

    const dlg = Dialog.create('Indexed Colours');
    dlg.initialWidth = 560;
    dlg.isResizable  = true;

    const col1 = dlg.addColumn();
    col1.widthProportion = 1.2;

    const grpInfo = col1.addGroup('Document');
    grpInfo.addStaticText('Format', fmtName);

    const grpSet = col1.addGroup('Settings');
    const edCount = grpSet.addUnitValueEditor('Colours', UnitType.Number, UnitType.Number, 5, 1, null);
    edCount.precision = 0; edCount.noMaxValue = true; edCount.value = 5;

    const cbMethod = grpSet.addComboBox('Method',
        ['k-means++ (HSL)', 'Highest weight (top N)'], 0);
    const cbWeight = grpSet.addComboBox('Weighting',
        ['Area (bounding box)', 'Area + frequency', 'Frequency only'], 0);
    const cbScope  = grpSet.addComboBox('Apply to',
        ['All objects', 'Selection only (incl. group children)'], 0);

    const col2 = dlg.addColumn();
    col2.widthProportion = 1.0;

    const grpOpt = col2.addGroup('Options');
    const chkHidden = grpOpt.addCheckBox('Skip hidden layers', true);
    const chkLocked = grpOpt.addCheckBox('Skip locked layers', true);
    const chkDither = grpOpt.addCheckBox('Dithering (bitmaps)', false);
    const chkAse    = grpOpt.addCheckBox('Export ASE palette', false);

    const grpInfo2 = col2.addGroup('Text support');
    grpInfo2.addStaticText('', 'Text fill + outline included');

    const grpStatus = col2.addGroup('Preview');
    const txStatus  = grpStatus.addStaticText('', 'Ready');

    // Captured BEFORE the handler is attached (handler fires on dialog open).
    const posBeforePreview = doc.history.position;
    let isRunning  = false;

    function getCurrentSettings() {
        return {
            userCount:  Math.max(1, Math.round(edCount.value)),
            useKMeans:  cbMethod.selectedIndex === 0,
            weightMode: cbWeight.selectedIndex===0?'area':cbWeight.selectedIndex===1?'combined':'count',
            selectionOnly: cbScope.selectedIndex === 1,
            skipHidden: chkHidden.value,
            skipLocked: chkLocked.value,
            dither:     chkDither.value,
        };
    }

    // Roll the document back to its original state AND original selection.
    function rollbackPreview() {
        rollbackToPosition(doc, posBeforePreview);
        restoreSelection(doc, originalSelNodes);
    }

    function runPreview() {
        if (isRunning) return;
        isRunning = true;
        try {
            rollbackPreview();   // always start from the untouched original

            const s = getCurrentSettings();
            if (s.selectionOnly && scopeNodes.length === 0) {
                txStatus.setText('Nothing selected.');
                return;
            }
            const layers = getTargetLayers(s.selectionOnly);

            const { palette, totalUnique, totalTarget } = buildPalette(
                layers, docFmt, s.userCount, s.useKMeans, s.weightMode, s.skipHidden, s.skipLocked);

            if (!palette) {
                if (totalUnique === 0) txStatus.setText('No colours found.');
                else txStatus.setText('Already ≤ '+totalTarget+' colours ('+totalUnique+').');
                return;
            }

            txStatus.setText('Applying '+palette.length+' colours…');
            applyAll(doc, layers, palette, docFmt, s.dither, s.skipHidden, s.skipLocked);
            restoreSelection(doc, originalSelNodes);
            txStatus.setText('Preview: '+palette.length+' colours ('+totalUnique+'→'+totalTarget+')');
        } catch(e) {
            rollbackPreview();
            txStatus.setText('Error: '+e.message);
            console.log('Preview error: '+e.message);
        } finally {
            isRunning = false;
        }
    }

    dlg.setOnControlValueChangedHandler(runPreview);

    const result = dlg.runModal();
    const ok = result && result.value === DialogResult.Ok.value;

    if (!ok) {
        rollbackPreview();
        console.log('Cancelled – no changes made.');
    } else {
        const s = getCurrentSettings();
        const doAse = chkAse.value;
        rollbackPreview();   // clean base → final apply is one clean block

        if (s.selectionOnly && scopeNodes.length === 0) {
            console.log('Nothing selected – no changes made.');
        } else {
            try {
                const layers = getTargetLayers(s.selectionOnly);
                const { palette, totalUnique, totalTarget } = buildPalette(
                    layers, docFmt, s.userCount, s.useKMeans, s.weightMode, s.skipHidden, s.skipLocked);

                if (!palette) {
                    if (totalUnique === 0) console.log('No colours found.');
                    else console.log('Already '+totalUnique+' colours ≤ target '+totalTarget+'. Nothing to do.');
                } else {
                    applyAll(doc, layers, palette, docFmt, s.dither, s.skipHidden, s.skipLocked);
                    restoreSelection(doc, originalSelNodes);
                    if (doAse) saveAse(palette, docFmt);
                    console.log('Done. Palette: '+palette.length+' colours'+
                                (s.selectionOnly ? ' ('+layers.length+' nodes in selection scope).' : '.'));
                }
            } catch(e) {
                rollbackPreview();
                console.log('Apply failed – document restored. ' + e.message);
            }
        }
    }
}
