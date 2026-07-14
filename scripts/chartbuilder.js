/**
 * name: Chart Builder
 * description: Build bar, column, and pie diagrams based on the data in the text object directly in affinity.
 * version: 1.3.1
 * author: nodeus (https://github.com/nodeus/affinity-scripts)
 */

"use strict";

const { Document } = require("/document");
const { AddChildNodesCommandBuilder, NodeChildType } = require("/commands");
const { ShapeNodeDefinition, FrameTextNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Shape, ShapeType, ShapeRectangle, ShapeCornerType } = require("/shapes");
const { Rectangle, CurveBuilder, PolyCurve } = require("/geometry");
const { Colour } = require("/colours");
const { FillDescriptor, SolidFill } = require("/fills");
const { ArrowHead, ArrowHeadStyle, LineStyleDescriptor } = require("/linestyle");
const { StoryBuilder } = require("/storybuilder");
const { GlyphAtts } = require("/glyphatts");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { BlendMode } = require("affinity:common");
const { ParagraphAtts } = require("/paragraphatts");

const PAL=[
  {r:66,g:133,b:244},{r:234,g:67,b:53},{r:251,g:188,b:4},{r:52,g:168,b:83},
  {r:171,g:71,b:188},{r:255,g:112,b:67},{r:0,g:172,b:193},{r:124,g:179,b:66},
  {r:136,g:14,b:79},{r:0,g:132,b:107},{r:163,g:107,b:48},{r:88,g:86,b:214},
  {r:218,g:94,b:134},{r:0,g:150,b:250},{r:200,g:150,b:0},{r:100,g:181,b:246},
  {r:229,g:57,b:53},{r:67,g:160,b:71},{r:30,g:136,b:229},{r:255,g:167,b:38},
  {r:142,g:36,b:170},{r:0,g:188,b:212},{r:233,g:30,b:99},{r:139,g:195,b:74},
  {r:255,g:87,b:34},{r:0,g:150,b:136},{r:63,g:81,b:181},{r:255,g:193,b:7},
  {r:121,g:85,b:72},{r:96,g:125,b:139},{r:244,g:67,b:54},{r:76,g:175,b:80}
];

function mkC(r){return Colour.createRGBA8({r:r.r,g:r.g,b:r.b,alpha:255})}
function mkF(r){return FillDescriptor.createSolid(SolidFill.create(mkC(r)),BlendMode.Normal)}
function addRect(b,x,y,w,h,c,radius){if(w<=0||h<=0)return;var sh=ShapeRectangle.create();sh.setAbsoluteSizes(true,w,h);var r=radius||0;if(r>0){sh.topLeft.cornerType=ShapeCornerType.Round;sh.topLeft.setRadius(r,w,h);sh.topRight.cornerType=ShapeCornerType.Round;sh.topRight.setRadius(r,w,h);sh.bottomLeft.cornerType=ShapeCornerType.Round;sh.bottomLeft.setRadius(r,w,h);sh.bottomRight.cornerType=ShapeCornerType.Round;sh.bottomRight.setRadius(r,w,h);}b.addNode(ShapeNodeDefinition.create(sh,new Rectangle(x,y,w,h),c?mkF(c):FillDescriptor.createNone(),null,null,null))}
function addText(b,x,y,w,h,t,sz,c){var ga=GlyphAtts.create();ga.height=sz;ga.brushFill=FillDescriptor.createSolid(SolidFill.create(mkC(c)),BlendMode.Normal);var pa=ParagraphAtts.create();pa.alignXType=1;var sb=StoryBuilder.create();sb.setParagraphAtts(pa);sb.setGlyphAtts(ga);sb.addText(t);b.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(x,y,w,h),sb))}
function getCol(cc,si,di){return(cc&&cc[di!==undefined?di:si])?cc[di!==undefined?di:si]:PAL[si%PAL.length]}

// PolyCurve line - stores settings for post-batch application
function addPolyLine(b,x1,y1,x2,y2,sw,c){
  var cb=CurveBuilder.create();cb.begin({x:x1,y:y1});cb.lineTo({x:x2,y:y2});
  var curve=cb.createCurve();
  var pc=PolyCurve.create();pc.addCurve(curve);
  var nd=PolyCurveNodeDefinition.create(
    pc,
    FillDescriptor.createSolid(SolidFill.create(Colour.createRGBA8({r:0,g:0,b:0,alpha:0})),BlendMode.Normal),
    LineStyleDescriptor.createDefault(sw),
    FillDescriptor.createSolid(SolidFill.create(mkC(c)),BlendMode.Normal),
    FillDescriptor.createNone()
  );
  b.addPolyCurveNode(nd);
  if(!b._lineStyles) b._lineStyles=[];
  b._lineStyles.push({weight:sw,cap:1,join:1,type:1,miterLimit:2,strokeAlignment:0});
}

// Apply line styles after batch execute
function applyLineStyles(doc,builder){
  if(!builder._lineStyles||builder._lineStyles.length===0) return;
  var styles=builder._lineStyles;
  var si=0;

  function findPolyCurves(node){
    if(si>=styles.length) return;
    if(node.isPolyCurveNode){
      var s=styles[si];
      node.lineWeightPts=s.weight;
      var lsd=LineStyleDescriptor.createDefault(s.weight);
      lsd.lineStyle.cap=s.cap;lsd.lineStyle.join=s.join;lsd.lineStyle.type=s.type;
      lsd.lineStyle.miterLimit=s.miterLimit||2;
      var front=ArrowHead.create(ArrowHeadStyle.Circle,{scaleX:1.5,scaleY:1.5});
      var back=ArrowHead.create(ArrowHeadStyle.Circle,{scaleX:1.5,scaleY:1.5});
      var lsdWithArrows=lsd.cloneWithNewArrowHeads(front,back);
      node.lineStyleInterface.setCurrentLineStyle(lsdWithArrows.lineStyle);
      si++;
    }
    if(node.children){
      for(var i=0;i<node.children.length;i++){
        findPolyCurves(node.children.at(i));
      }
    }
  }

  // Search through all spreads
  for(var s=0;s<doc.spreads.length;s++){
    var spread=doc.spreads.at(s);
    for(var i=0;i<spread.children.length;i++){
      findPolyCurves(spread.children.at(i));
    }
  }
}

function parseData(text){
  var lines=text.split("\n"),series=[],seriesNames=[],labels=[];
  var nonEmpty=[];
  for(var i=0;i<lines.length;i++){
    var t=lines[i].trim();if(t)nonEmpty.push(t);
  }
  if(nonEmpty.length===0)return{series:series,seriesNames:seriesNames,labels:labels};

  // Find --- separator
  var sepIdx=-1;
  for(var i=0;i<nonEmpty.length;i++){
    if(nonEmpty[i].match(/^---+$/)){sepIdx=i;break;}
  }

  var dataLines=sepIdx>=0?nonEmpty.slice(0,sepIdx):nonEmpty;
  var labelLines=sepIdx>=0?nonEmpty.slice(sepIdx+1):[];

  // Parse data lines
  for(var i=0;i<dataLines.length;i++){
    var t=dataLines[i];
    var m=t.match(/^(.+?):\s*(.+)$/);
    if(m){
      var vals=m[2].split(",").map(function(v){return parseFloat(v.trim());}).filter(function(v){return !isNaN(v);});
      if(vals.length>0){series.push(vals);seriesNames.push(m[1].trim());}
    } else {
      var vals=t.split(",").map(function(v){return parseFloat(v.trim());}).filter(function(v){return !isNaN(v);});
      if(vals.length>0){series.push(vals);seriesNames.push("");}
    }
  }

  // Parse labels
  if(sepIdx>=0 && labelLines.length>0){
    var labelText=labelLines.join(", ");
    labels=labelText.split(",").map(function(v){return v.trim();}).filter(function(v){return v.length>0;});
  } else if(sepIdx<0 && series.length>0){
    var last=nonEmpty[nonEmpty.length-1];
    var lastMatch=last.match(/^(.+?):\s*(.+)$/);
    var lastIsSeries=false;
    if(lastMatch){
      var lastVals=lastMatch[2].split(",").map(function(v){return parseFloat(v.trim());}).filter(function(v){return !isNaN(v);});
      lastIsSeries=lastVals.length>0;
    } else {
      var lastVals=last.split(",").map(function(v){return parseFloat(v.trim());}).filter(function(v){return !isNaN(v);});
      lastIsSeries=lastVals.length>0;
    }
    if(!lastIsSeries){
      var labelPart=last.replace(/^\S+:\s*/,'');
      labels=labelPart.split(",").map(function(v){return v.trim();}).filter(function(v){return v.length>0;});
    }
  }

  return{series:series,seriesNames:seriesNames,labels:labels};
}

function buildLine(b,data,cfg){
  var m={top:40,right:30,bottom:50,left:80};
  var cW=cfg.W-m.left-m.right,cH=cfg.H-m.top-m.bottom;
  var max=0,min=0;
  for(var s=0;s<data.series.length;s++)for(var j=0;j<data.series[s].length;j++){
    if(data.series[s][j]>max)max=data.series[s][j];
    if(data.series[s][j]<min)min=data.series[s][j];
  }
  if(max===0&&min===0){max=1;}
  var range=max-min;if(range===0)range=Math.abs(max)||1;
  var ax=m.left,ay=m.top+cH;
  var zeroY=min<0?ay-((0-min)/range)*cH:ay;

  addPolyLine(b,ax,m.top,ax,ay,1,{r:120,g:126,b:130});
  if(min<0){
    addPolyLine(b,ax,zeroY,ax+cW,zeroY,1,{r:120,g:126,b:130});
  } else {
    addPolyLine(b,ax,ay,ax+cW,ay,1,{r:120,g:126,b:130});
  }

  var gl=cfg.gridLines||5;
  for(var i=0;i<=gl;i++){
    var val=min+(i/gl)*range;
    var y=ay-((val-min)/range)*cH;
    addPolyLine(b,ax,y,ax+cW,y,0.5,{r:166,g:171,b:174});
    addText(b,ax-55,y-8,50,16,Math.round(val).toString(),10,{r:120,g:120,b:120});
  }

  for(var si=0;si<data.series.length;si++){
    var ser=data.series[si],col=getCol(cfg.customColors,si);
    var xs;
    if(cfg.labelMode===1){
      xs=cW/(ser.length-1||1);
    } else {
      var pc2=0;for(var s=0;s<data.series.length;s++)if(data.series[s].length>pc2)pc2=data.series[s].length;
      xs=cW/pc2;
    }
    for(var k=0;k<ser.length;k++){
      var px=ax+k*xs,py=ay-((ser[k]-min)/range)*cH;
      addText(b,px-20,py-24,40,16,ser[k].toString(),9,col);
      if(k>0){
        var px0=ax+(k-1)*xs,py0=ay-((ser[k-1]-min)/range)*cH;
        addPolyLine(b,px0,py0,px,py,cfg.lineThickness||2,col);
      }
    }
  }

  if(data.labels.length>0){
    if(cfg.labelMode===1){
      var xsl=cW/(data.labels.length-1||1);
      for(var li=0;li<data.labels.length;li++){var lx=ax+li*xsl-25;if(li===data.labels.length-1)lx=ax+cW-25;addText(b,lx,ay+10,50,16,data.labels[li],10,{r:80,g:80,b:80});}
    } else {
      var pc2=0;for(var s=0;s<data.series.length;s++)if(data.series[s].length>pc2)pc2=data.series[s].length;
      var gw2=cW/pc2;
      for(var li=0;li<data.labels.length;li++)addText(b,ax+li*gw2-25,ay+10,50,16,data.labels[li],10,{r:80,g:80,b:80});
    }
  }
}

function buildBar(b,data,cfg){
  var m={top:40,right:30,bottom:50,left:80};
  var cW=cfg.W-m.left-m.right,cH=cfg.H-m.top-m.bottom;
  var max=0,min=0;
  for(var s=0;s<data.series.length;s++)for(var j=0;j<data.series[s].length;j++){
    if(data.series[s][j]>max)max=data.series[s][j];
    if(data.series[s][j]<min)min=data.series[s][j];
  }
  if(max===0&&min===0){max=1;}
  var range=max-min;if(range===0)range=Math.abs(max)||1;
  var ax=m.left,ay=m.top+cH;
  var zeroY=min<0?ay+(min/range)*cH:ay;

  addPolyLine(b,ax,m.top,ax,ay,1,{r:120,g:126,b:130});
  if(min<0){
    addPolyLine(b,ax,zeroY,ax+cW,zeroY,1,{r:120,g:126,b:130});
  } else {
    addPolyLine(b,ax,ay,ax+cW,ay,1,{r:120,g:126,b:130});
  }

  var gl=cfg.gridLines||5;
  for(var i=0;i<=gl;i++){
    var val=min+(i/gl)*range;
    var y=ay-((val-min)/range)*cH;
    addPolyLine(b,ax,y,ax+cW,y,0.5,{r:166,g:171,b:174});
    addText(b,ax-55,y-8,50,16,Math.round(val).toString(),10,{r:120,g:120,b:120});
  }

  var pc=0;for(var s=0;s<data.series.length;s++)if(data.series[s].length>pc)pc=data.series[s].length;
  var gw=cW/pc;
  var padX=cfg.labelMode===1?0:(gw*0.3)/2;
  var sc=data.series.length,bw=(gw*0.7)/sc;
  for(var pi=0;pi<pc;pi++)for(var si=0;si<sc;si++){
    var v=data.series[si][pi];if(v===undefined||isNaN(v))continue;
    var bh=(v/range)*cH;
    var x=ax+pi*gw+padX+si*bw;
    var bc=getCol(cfg.customColors,si);
    var barTop=zeroY-bh;
    if(v>=0){
      addRect(b,x,barTop,bw-2,bh,bc,cfg.barRadius);
      addText(b,x,barTop-18,bw,16,v.toString(),9,bc);
    } else {
      addRect(b,x,zeroY,bw-2,-bh,bc,cfg.barRadius);
      addText(b,x,barTop+2,bw,16,v.toString(),9,bc);
    }
  }

  if(data.labels.length>0){
    if(cfg.labelMode===1){
      var xsl=cW/(data.labels.length-1||1);
      for(var li=0;li<data.labels.length;li++){var lx=ax+li*xsl-25;if(li===data.labels.length-1)lx=ax+cW-25;addText(b,lx,ay+10,50,16,data.labels[li],10,{r:80,g:80,b:80});}
    } else {
      for(var li=0;li<data.labels.length;li++)addText(b,ax+li*gw,ay+10,gw,16,data.labels[li],10,{r:80,g:80,b:80});
    }
  }
}

function buildSingleDonut(b,vals,ox,oy,ds,ir,showPercent,colors){
  var total=0;for(var j=0;j<vals.length;j++)total+=vals[j];
  if(total===0)return;
  var cx=ds/2,cy=ds/2;

  var pp=Shape.create(ShapeType.Pie);pp.innerRadius=0.67;pp.startAngle=0;pp.sweep=Math.PI*2;pp.closePie();
  b.addNode(ShapeNodeDefinition.create(pp,new Rectangle(ox,oy,ds,ds),mkF({r:255,g:255,b:255}),null,null,null));

  var sa=-Math.PI/2;
  for(var k=0;k<vals.length;k++){
    var sw=(vals[k]/total)*Math.PI*2;
    var cp=Shape.create(ShapeType.Pie);cp.innerRadius=ir;cp.startAngle=sa;cp.endAngle=sa+sw;cp.sweep=sw;
    b.addNode(ShapeNodeDefinition.create(cp,new Rectangle(ox,oy,ds,ds),mkF(getCol(colors,k,k)),null,null,null));
    sa+=sw;
  }

  sa=-Math.PI/2;var lr=ds*0.33;
  for(var k2=0;k2<vals.length;k2++){
    var sw2=(vals[k2]/total)*Math.PI*2,ma=-(sa+sw2/2);
    var txt=vals[k2].toString();
    if(showPercent)txt+="\n("+Math.round(vals[k2]/total*100)+"%)";
    addText(b,ox+cx+Math.cos(ma)*lr-20,oy+cy+Math.sin(ma)*lr-8,40,showPercent?28:16,txt,11,{r:50,g:50,b:50});
    sa+=sw2;
  }

  var ga=GlyphAtts.create();ga.height=Math.max(14,ds*0.1);
  ga.brushFill=FillDescriptor.createSolid(SolidFill.create(mkC({r:50,g:50,b:50})),BlendMode.Normal);
  var pa=ParagraphAtts.create();pa.alignXType=1;
  var sb=StoryBuilder.create();sb.setParagraphAtts(pa);sb.setGlyphAtts(ga);sb.addText(total.toString());
  var ga2=GlyphAtts.create();ga2.height=Math.max(9,ds*0.04);
  ga2.brushFill=FillDescriptor.createSolid(SolidFill.create(mkC({r:120,g:120,b:120})),BlendMode.Normal);
  sb.setGlyphAtts(ga2);sb.addText("\ntotal");
  b.addNode(FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(ox+cx-ds*0.2,oy+cy-ds*0.12,ds*0.4,ds*0.24),sb));
}

function buildDonut(b,data,cfg){
  var sc=data.series.length,gap=40;
  var ds=Math.min(cfg.W,cfg.H,(cfg.W-gap*Math.max(0,sc-1))/Math.max(1,sc));
  for(var si=0;si<sc;si++){
    buildSingleDonut(b,data.series[si],si*(ds+gap),0,ds,0.4,cfg.showPercent,cfg.customColors);
    if(cfg.showLegend){
      var lx=si*(ds+gap)+ds/2-40;
      var ly=ds+10;
      addText(b,lx,ly,100,16,data.seriesNames[si]||("label "+(si+1)),11,{r:80,g:80,b:80});
      ly+=18;
      for(var k=0;k<data.series[si].length;k++){
        addRect(b,lx,ly,10,10,getCol(cfg.customColors,k,k));
        addText(b,lx+14,ly-2,60,16,data.series[si][k].toString(),10,{r:100,g:100,b:100});
        ly+=16;
      }
    }
  }
}

function renderChart(doc,data,cfg){
  var b=AddChildNodesCommandBuilder.create();
  if(cfg.chartType===0)buildLine(b,data,cfg);
  else if(cfg.chartType===1)buildBar(b,data,cfg);
  else buildDonut(b,data,cfg);

  if(cfg.showLegend && cfg.chartType!==2){
    var lx=cfg.W+20;
    var ly=20;
    for(var i=0;i<data.series.length;i++){
      addRect(b,lx,ly,14,14,getCol(cfg.customColors,i));
      addText(b,lx+20,ly-1,100,16,data.seriesNames[i]||("label "+(i+1)),10,{r:60,g:60,b:60});
      ly+=22;
    }
  }

  doc.executeCommand(b.createCommand(true,NodeChildType.Main));
  applyLineStyles(doc,b);
}

function showError(msg){
  var e=Dialog.create("Error");e.initialWidth=250;
  e.addColumn().addGroup("").addStaticText("",msg);
  e.runModal();
}

var doc=Document.current;
if(!doc){showError("No document");return;}
var textNode=null;
for(var i=0;i<doc.selection.nodes.length;i++){if(doc.selection.nodes.at(i).isFrameTextNode){textNode=doc.selection.nodes.at(i);break;}}
if(!textNode){showError("Select a text frame");return;}

var text=textNode.storyInterface.story.getText(0,textNode.storyInterface.story.length);
var data=parseData(text);
if(data.series.length===0){showError("No data");return;}

var dlg=Dialog.create("Chart Builder");dlg.initialWidth=350;
var col=dlg.addColumn();
var gt=col.addGroup("Type");var tl=gt.addComboBox("",["Line","Bar","Donut"],0);
var gs=col.addGroup("Size");var we=gs.addUnitValueEditor("W:",UnitType.Pixel,UnitType.Pixel);we.value=500;var he=gs.addUnitValueEditor("H:",UnitType.Pixel,UnitType.Pixel);he.value=400;
var gl=col.addGroup("Line");var lte=gl.addUnitValueEditor("Thick:",UnitType.Pixel,UnitType.Pixel);lte.value=2;
var gridVals=[];for(var i=2;i<=20;i++)gridVals.push(i);var ggrid=col.addGroup("");var gle=ggrid.addComboBox("Grid:",gridVals.map(String),3);
var gbar=col.addGroup("Bar");var rve=gbar.addUnitValueEditor("Radius:",UnitType.Pixel,UnitType.Pixel,0,0,50);
var gclr=col.addGroup("Colors");
var colorPickers=[];
for(var ci=0;ci<data.series.length;ci++){
  var def=PAL[ci%PAL.length];
  var cp=gclr.addColourPicker("Series "+(ci+1)+":",Colour.createRGBA8({r:def.r,g:def.g,b:def.b,alpha:255}));
  colorPickers.push(cp);
}
var glbl=col.addGroup("Labels");var lme=glbl.addComboBox("Mode:",["Sequential","Spread"],0);
var gleg=col.addGroup("");var sle=gleg.addCheckBox("Legend",true);
var gd=col.addGroup("Donut");var spe=gd.addCheckBox("Show %",false);

function updateVisibility(){
  var ti=tl.selectedIndex;
  var show=[],hide=[];
  if(ti===1)show.push(gbar.itemID);else hide.push(gbar.itemID);
  if(ti!==2)show.push(ggrid.itemID);else hide.push(ggrid.itemID);
  dlg.setItemsVisibility(show,hide);
}
tl.setOnValueChangedHandler(updateVisibility);
updateVisibility();

var result=dlg.runModal();
if(result!==DialogResult.Ok){console.log("Cancelled");return;}

var w=we.value;if(w<=0)w=500;
var h=he.value;if(h<=0)h=400;

var customColors=[];
for(var ci=0;ci<colorPickers.length;ci++){
  var cv=colorPickers[ci].value;
  if(cv)customColors.push({r:cv.rgba8.r,g:cv.rgba8.g,b:cv.rgba8.b});
  else customColors.push(PAL[ci%PAL.length]);
}

// Check for negative values in pie chart
if(tl.selectedIndex===2){
  for(var s=0;s<data.series.length;s++){
    for(var j=0;j<data.series[s].length;j++){
      if(data.series[s][j]<0){showError("Pie chart does not support negative values");return;}
    }
  }
}

renderChart(doc,data,{W:w,H:h,lineThickness:lte.value||2,chartType:tl.selectedIndex,showLegend:sle.value,showPercent:spe.value,gridLines:gridVals[gle.selectedIndex]||5,barRadius:rve.value,customColors:customColors,labelMode:lme.selectedIndex});

console.log(["Line","Bar","Donut"][tl.selectedIndex]+" "+w+"x"+h);
