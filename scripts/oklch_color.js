'use strict';

// ═══════════════════════════════════════════════════════════════
//  OKLCH Color Editor v5 — Fill · Stroke · Gradient (per-stop)
//  - Detects the primary object's editable colour targets:
//      Fill (solid) · Fill · Stop N (gradient) · Stroke (solid)
//  - "Target" dropdown picks which colour to edit.
//  - Live OKLCH sliders, seeded from the chosen target's colour.
//  - Solid Fill / Stroke changes apply to ALL selected objects;
//    a gradient stop is rebuilt per object that has that stop.
//  - OK keeps · Cancel restores (single undo step, no clearPreviews).
//  Math: CSS Color Level 4 correct matrices (fixed b-row).
// ═══════════════════════════════════════════════════════════════

const { Dialog, DialogResult }                    = require('/dialog');
const { Colour, RGBA8, Gradient }                 = require('/colours');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Document }                                = require('/document');
const { FillDescriptor, FillType }                = require('/fills');
const { UnitType }                                = require('/units');
const { Selection }                               = require('/selections');
const { app }                                     = require('/application');

// ── OKLCH math ─────────────────────────────────────────────────
function toLinear(x){return x<=0.04045?x/12.92:Math.pow((x+0.055)/1.055,2.4);}
function toSrgb(x){return x<=0?0:x>=1?1:x<=0.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-0.055;}

function rgbToOklch(r8,g8,b8){
    const r=toLinear(r8/255),g=toLinear(g8/255),b=toLinear(b8/255);
    const l=Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b);
    const m=Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b);
    const s=Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
    const L =0.2104542553*l+0.7936177850*m-0.0040720468*s;
    const av=1.9779984951*l-2.4285922050*m+0.4505937099*s;
    const bv=0.0259040371*l+0.7827717662*m-0.8086757660*s;
    let H=Math.atan2(bv,av)*180/Math.PI; if(H<0)H+=360;
    return {L,C:Math.sqrt(av*av+bv*bv),H};
}

function oklchToRgb(L,C,H,alpha){
    const h=H*Math.PI/180,a=C*Math.cos(h),b=C*Math.sin(h);
    const l_=L+0.3963377774*a+0.2158037573*b;
    const m_=L-0.1055613458*a-0.0638541728*b;
    const s_=L-0.0894841775*a-1.2914855480*b;
    const l=l_*l_*l_,m=m_*m_*m_,s=s_*s_*s_;
    const cl=v=>Math.min(1,Math.max(0,v));
    return {
        r:Math.round(cl(toSrgb( 4.0767416621*l-3.3077115913*m+0.2309699292*s))*255),
        g:Math.round(cl(toSrgb(-1.2684380046*l+2.6097574011*m-0.3413193965*s))*255),
        b:Math.round(cl(toSrgb(-0.0041960863*l-0.7034186147*m+1.7076147010*s))*255),
        a:Math.round(cl(alpha)*255)
    };
}

function toCss(L,C,H,alpha){
    const lp=(L*100).toFixed(1)+'%', cv=C.toFixed(4), hv=H.toFixed(1);
    return alpha>=0.9999
        ? `oklch(${lp} ${cv} ${hv})`
        : `oklch(${lp} ${cv} ${hv} / ${(alpha*100).toFixed(0)}%)`;
}

// ── Setup ──────────────────────────────────────────────────────
const doc   = Document.current;
const nodes = doc ? doc.selection.nodes.toArray().filter(Boolean) : [];
const primary = nodes[0] || null;
function undoN(n){for(let i=0;i<n;i++)doc.undo();}

function colourToRgba8(c){
    if(!c) return null;
    try { if(typeof c.rgba8 !== 'undefined') return c.rgba8; } catch(e){}
    try { return new Colour(c).rgba8; } catch(e){ return null; }
}

// Enumerate editable colour targets from the primary node.
function detectTargets(node){
    const out = [];
    if(!node) return out;
    // Fill
    try {
        const fd = node.brushFillInterface && node.brushFillInterface.fillDescriptor;
        if(fd){
            const ft = fd.fill.fillType.value;
            if(ft === FillType.Solid.value){
                out.push({ kind:'fill', label:'Fill' });
            } else if(ft === FillType.Gradient.value){
                const n = fd.fill.gradient.stopCount;
                for(let i=0;i<n;i++) out.push({ kind:'gstop', stopIndex:i, label:`Fill · Stop ${i+1}` });
            }
        }
    } catch(e){}
    // Stroke (solid only)
    try {
        const ls = node.lineStyleInterface;
        if(ls && !ls.isNoFill){
            const sfd = ls.penFillDescriptor;
            if(sfd && sfd.fill.fillType.value === FillType.Solid.value){
                out.push({ kind:'stroke', label:'Stroke' });
            }
        }
    } catch(e){}
    return out;
}

// Read the original colour of a target from the primary node.
function readSeed(t){
    let rgba = { r:128, g:128, b:128, alpha:255 };
    try {
        if(t.kind === 'fill'){
            rgba = primary.brushFillInterface.fillDescriptor.fill.colour.rgba8;
        } else if(t.kind === 'stroke'){
            rgba = primary.lineStyleInterface.penFillDescriptor.fill.colour.rgba8;
        } else if(t.kind === 'gstop'){
            const stop = primary.brushFillInterface.fillDescriptor.fill.gradient.stops[t.stopIndex];
            rgba = colourToRgba8(stop.colour) || rgba;
        }
    } catch(e){}
    const oc = rgbToOklch(rgba.r, rgba.g, rgba.b);
    return { L:oc.L, C:oc.C, H:oc.H, alpha:(rgba.alpha!=null?rgba.alpha:255)/255 };
}

// Apply the OKLCH colour to a target across all selected nodes; 1 undo step.
function applyTarget(t, L, C, H, alpha){
    const { r, g, b, a } = oklchToRgb(L, C, H, alpha);
    const newColour = RGBA8(r, g, b, a);
    const compound = CompoundCommandBuilder.create();
    let count = 0;

    for(const node of nodes){
        const sel = Selection.create(doc, node);
        try {
            if(t.kind === 'fill'){
                compound.addCommand(DocumentCommand.createSetBrushFill(sel, FillDescriptor.createSolid(newColour)));
                count++;
            } else if(t.kind === 'stroke'){
                const ls = node.lineStyleInterface;
                if(ls && !ls.isNoFill){
                    compound.addCommand(DocumentCommand.createSetPenFill(sel, FillDescriptor.createSolid(newColour)));
                    count++;
                }
            } else if(t.kind === 'gstop'){
                const fd = node.brushFillInterface && node.brushFillInterface.fillDescriptor;
                if(fd && fd.fill.fillType.value === FillType.Gradient.value){
                    const stops = fd.fill.gradient.stops;
                    if(t.stopIndex < stops.length){
                        const newStops = stops.map((s, idx) => ({
                            colour: idx === t.stopIndex ? newColour : s.colour,
                            position: s.position,
                            midpoint: s.midpoint,
                            smoothness: s.smoothness
                        }));
                        const newGrad = Gradient.create(newStops);
                        const newFill = fd.fill.cloneWithNewGradient(newGrad);
                        const newFd = fd.cloneWithNewFill(newFill);
                        compound.addCommand(DocumentCommand.createSetBrushFill(sel, newFd));
                        count++;
                    }
                }
            }
        } catch(e){}
    }

    if(count === 0) return 0;
    doc.executeCommand(compound.createCommand());
    return 1;
}

// ── Main ───────────────────────────────────────────────────────
const targets = detectTargets(primary);

if(!doc || nodes.length === 0){
    app.alert('OKLCH Editor: please select at least one object first.');
} else if(targets.length === 0){
    app.alert('OKLCH Editor: the selected object has no editable solid fill, gradient, or stroke.');
} else {
    const dlg = Dialog.create('OKLCH Color Editor'); dlg.initialWidth = 380;
    const col = dlg.addColumn();

    const gT = col.addGroup('Target');
    const targetCombo = gT.addComboBox('Edit', targets.map(t => t.label), 0);
    targetCombo.isFullWidth = true;

    const gS = col.addGroup('OKLCH  —  L: 0–100  ·  C: 0–40  ·  H: 0–360°');
    const slL = gS.addUnitValueEditor('L  Lightness', UnitType.Number, UnitType.Number, 60, 0, 100); slL.precision = 1; slL.showPopupSlider = true;
    const slC = gS.addUnitValueEditor('C  Chroma', UnitType.Number, UnitType.Number, 15, 0, 40);  slC.precision = 2; slC.showPopupSlider = true;
    const slH = gS.addUnitValueEditor('H  Hue', UnitType.Degree, UnitType.Degree, 250, 0, 360);   slH.precision = 1; slH.showPopupSlider = true;
    const slA = gS.addUnitValueEditor('Alpha', UnitType.Percentage, UnitType.Percentage, 100, 0, 100); slA.precision = 0; slA.showPopupSlider = true;

    const gO = col.addGroup(''); gO.enableSeparator = true;
    const cssTxt = gO.addStaticText('CSS', ''); cssTxt.isFullWidth = true;
    gO.addStaticText('', 'Drag to preview live · OK keeps · Cancel restores').isFullWidth = true;

    let previewSteps = 0;   // 0 or 1
    let suppress = false;

    function currentTarget(){ return targets[targetCombo.selectedIndex] || targets[0]; }

    function seedSliders(t){
        suppress = true;
        const s = readSeed(t);
        slL.value = Math.round(s.L * 1000) / 10;
        slC.value = Math.round(s.C * 10000) / 100;
        slH.value = Math.round(s.H * 10) / 10;
        slA.value = Math.round(s.alpha * 100);
        suppress = false;
    }

    function preview(){
        if(suppress) return;
        if(previewSteps){ undoN(previewSteps); previewSteps = 0; }
        const L = slL.value / 100, C = slC.value / 100, H = slH.value, alpha = slA.value / 100;
        previewSteps = applyTarget(currentTarget(), L, C, H, alpha);
        cssTxt.text = `${currentTarget().label}:  ${toCss(L, C, H, alpha)}`;
    }

    // Live sliders.
    [slL, slC, slH, slA].forEach(s => s.setOnValueChangedHandler(preview));

    // Switching target: restore original, re-seed from the new target, preview.
    targetCombo.setOnValueChangedHandler(() => {
        if(previewSteps){ undoN(previewSteps); previewSteps = 0; }
        seedSliders(currentTarget());
        preview();
    });

    // Init.
    seedSliders(currentTarget());
    preview();

    // runModal() throws ABORTED on Cancel; treat as "not OK".
    let apply = false;
    try { apply = dlg.runModal().value === DialogResult.Ok.value; } catch(e){ apply = false; }

    if(apply){
        console.log(`OKLCH ✓  ${cssTxt.text}`);
    } else {
        if(previewSteps) undoN(previewSteps);
        console.log('OKLCH: cancelled.');
    }
}