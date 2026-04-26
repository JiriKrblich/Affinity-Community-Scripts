
'use strict';

// ═══════════════════════════════════════════════════════════════
//  OKLCH Color Editor v2
//  - Seeds sliders from selected object's fill colour
//  - Preview ↺  : live preview on the object itself
//  - Copy CSS   : shows oklch() string in a simple alert popup
//  - Apply ✓    : commits colour permanently
//  - Cancel     : undoes all preview, restores original colour
//  Math: CSS Color Level 4 correct matrices (fixed b-row)
// ═══════════════════════════════════════════════════════════════

const { Dialog, DialogResult }  = require('/dialog');
const { RGBA8 }                 = require('/colours');
const { DocumentCommand }       = require('/commands');
const { Document }              = require('/document');
const { FillDescriptor }        = require('/fills');
const { UnitType }              = require('/units');
const { Selection }             = require('/selections');
const { app }                   = require('/application');

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

const doc   = Document.current;
const nodes = doc.selection.nodes.toArray().filter(Boolean);
function undoN(n){for(let i=0;i<n;i++)doc.undo();}

function applyToSelection(L,C,H,alpha){
    const {r,g,b,a}=oklchToRgb(L,C,H,alpha);
    const fd=FillDescriptor.createSolid(RGBA8(r,g,b,a));
    let n=0;
    for(const node of nodes){
        const sel=Selection.create(doc,node);
        doc.executeCommand(DocumentCommand.createSetBrushFill(sel,fd)); n++;
    }
    return n;
}

if(nodes.length===0){
    app.alert('OKLCH Editor: please select at least one object first.');
} else {
    let curL=0.60,curC=0.15,curH=250.0,curA=1.0;
    try{
        const colour=nodes[0].brushFillInterface?.fillDescriptor?.fill?.colour;
        if(colour){
            const rgba=colour.rgba8, oc=rgbToOklch(rgba.r,rgba.g,rgba.b);
            curL=oc.L; curC=oc.C; curH=oc.H; curA=rgba.alpha/255;
        }
    }catch(e){}

    const dlg=Dialog.create('OKLCH Color Editor'); dlg.initialWidth=380;
    const col=dlg.addColumn();

    const gS=col.addGroup('OKLCH  —  L: 0–100  ·  C: 0–40  ·  H: 0–360°');
    const slL=gS.addUnitValueEditor('L  Lightness',UnitType.Number,UnitType.Number,
        Math.round(curL*1000)/10,0,100); slL.precision=1; slL.showPopupSlider=true;
    const slC=gS.addUnitValueEditor('C  Chroma',UnitType.Number,UnitType.Number,
        Math.round(curC*10000)/100,0,40); slC.precision=2; slC.showPopupSlider=true;
    const slH=gS.addUnitValueEditor('H  Hue',UnitType.Degree,UnitType.Degree,
        Math.round(curH*10)/10,0,360); slH.precision=1; slH.showPopupSlider=true;
    const slA=gS.addUnitValueEditor('Alpha',UnitType.Percentage,UnitType.Percentage,
        Math.round(curA*100),0,100); slA.precision=0; slA.showPopupSlider=true;

    const gB=col.addGroup(''); gB.enableSeparator=true;
    const btns=gB.addButtonSet('',['Preview ↺','Copy CSS','Apply ✓'],0);

    let previewSteps=applyToSelection(curL,curC,curH,curA);
    let running=true;

    while(running){
        btns.selectedIndex=0;
        const res=dlg.show();
        const L=slL.value/100, C=slC.value/100, H=slH.value, alpha=slA.value/100;
        const mode=btns.selectedIndex;

        if(res.value===DialogResult.Ok.value){
            undoN(previewSteps);

            if(mode===2){
                applyToSelection(L,C,H,alpha);
                console.log(`OKLCH ✓  ${toCss(L,C,H,alpha)}`);
                running=false;

            } else if(mode===1){
                previewSteps=applyToSelection(L,C,H,alpha);
                curL=L; curC=C; curH=H; curA=alpha;
                app.alert(toCss(L,C,H,alpha)); // simple popup, no input field

            } else {
                previewSteps=applyToSelection(L,C,H,alpha);
                curL=L; curC=C; curH=H; curA=alpha;
            }

        } else {
            undoN(previewSteps);
            console.log('OKLCH: cancelled.');
            running=false;
        }
    }
}
