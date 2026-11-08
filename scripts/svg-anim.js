/**
 * name: SVG Anim
 * version: 0.6.2
 * description: Animate elements and export them as an animated SVG, in one dialog. Animate mode: up to eight tracks per element (Fade, Blur, Move, Rotate, Scale, Skew, Draw stroke, Count number, Clock, Frames; Each child animates the first-level children in Layers panel order, optionally reversed) with duration, delay, stagger, easing, direction, repeats and start trigger (load, visible, click, hover), stored in the element metadata and shown again when reselected; animated layers get a name suffix (default __anim). JSON preset import/export reuses the complete track setup; Clear removes all tracks on OK, and arrow buttons reorder tracks. Export mode: the document, current spread or an artboard as SVG with the animation data and an embedded or linked (jsDelivr) player, clipped to the artboard bounds, plus an optional HTML preview page.
 * author: WaveF
 * email: wavef@live.com
 * website: https://minicg.com
 * source: https://github.com/WaveF/affinity-svg-anim
 * license: MIT
 */
'use strict';

const { app } = require('/application');
const { Document, FileExportOptions, FileExportArea } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Selection } = require('/selections');
const { Dialog, DialogResult, UnitType, SpatialAnchor } = require('/dialog');
const { File } = require('/fs');
const fsApi = require('/fs');

const SCRIPT_NAME = 'SVG Anim';
const VERSION = '0.6.2';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;
const RUNTIME_CDN_URL = "https://cdn.jsdelivr.net/gh/WaveF/affinity-svg-anim@v0.6.2/dist/svg-anim-runtime.min.js";
const RUNTIME_SOURCE = "/*! SVG Anim runtime v0.6.2 | MIT License | (c) WaveF | https://github.com/WaveF/affinity-svg-anim */(function(){\"use strict\";var E=\"http://www.w3.org/2000/svg\",C=document.currentScript,m=C&&(C.ownerSVGElement||C.closest&&C.closest(\"svg\"))||document.documentElement;if(!m||m.__svgAnim)return;var et=/^(defs|clipPath|mask|title|desc|metadata|style|script|linearGradient|radialGradient|pattern|filter|marker|symbol)$/,It=/^(path|line|polyline|polygon|circle|ellipse|rect)$/,_=1.70158,q=_*1.525,rt=_+1;function D(t){var e=7.5625,r=2.75;return t<1/r?e*t*t:t<2/r?e*(t-=1.5/r)*t+.75:t<2.5/r?e*(t-=2.25/r)*t+.9375:e*(t-=2.625/r)*t+.984375}var at={linear:function(t){return t},sineIn:function(t){return 1-Math.cos(t*Math.PI/2)},sineOut:function(t){return Math.sin(t*Math.PI/2)},sineInOut:function(t){return-(Math.cos(Math.PI*t)-1)/2},quadIn:function(t){return t*t},quadOut:function(t){return 1-(1-t)*(1-t)},quadInOut:function(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2},in:function(t){return t*t*t},out:function(t){return 1-Math.pow(1-t,3)},inOut:function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2},quartIn:function(t){return t*t*t*t},quartOut:function(t){return 1-Math.pow(1-t,4)},quartInOut:function(t){return t<.5?8*t*t*t*t:1-Math.pow(-2*t+2,4)/2},quintIn:function(t){return t*t*t*t*t},quintOut:function(t){return 1-Math.pow(1-t,5)},quintInOut:function(t){return t<.5?16*t*t*t*t*t:1-Math.pow(-2*t+2,5)/2},expoIn:function(t){return t<=0||t>=1?t<=0?0:1:Math.pow(2,10*t-10)},expoOut:function(t){return t<=0||t>=1?t<=0?0:1:1-Math.pow(2,-10*t)},expoInOut:function(t){return t<=0||t>=1?t<=0?0:1:t<.5?Math.pow(2,20*t-10)/2:(2-Math.pow(2,-20*t+10))/2},circIn:function(t){return 1-Math.sqrt(1-t*t)},circOut:function(t){return Math.sqrt(1-Math.pow(t-1,2))},circInOut:function(t){return t<.5?(1-Math.sqrt(1-Math.pow(2*t,2)))/2:(Math.sqrt(1-Math.pow(-2*t+2,2))+1)/2},backIn:function(t){return rt*t*t*t-_*t*t},backOut:function(t){return 1+rt*Math.pow(t-1,3)+_*Math.pow(t-1,2)},backInOut:function(t){return t<.5?Math.pow(2*t,2)*((q+1)*2*t-q)/2:(Math.pow(2*t-2,2)*((q+1)*(t*2-2)+q)+2)/2},elasticIn:function(t){return t<=0||t>=1?t<=0?0:1:-Math.pow(2,10*t-10)*Math.sin((t*10-10.75)*(2*Math.PI)/3)},elasticOut:function(t){return t<=0||t>=1?t<=0?0:1:Math.pow(2,-10*t)*Math.sin((t*10-.75)*(2*Math.PI)/3)+1},elasticInOut:function(t){if(t<=0||t>=1)return t<=0?0:1;var e=Math.sin((20*t-11.125)*(2*Math.PI)/4.5);return t<.5?-Math.pow(2,20*t-10)*e/2:Math.pow(2,-20*t+10)*e/2+1},bounceIn:function(t){return 1-D(1-t)},bounceOut:D,bounceInOut:function(t){return t<.5?(1-D(1-2*t))/2:(1+D(2*t-1))/2}};function h(t,e){return t=Number(t),isFinite(t)?t:e}function P(t){return t<0?0:t>1?1:t}function T(t,e){var r=t*374761393+e*668265263|0;return r=Math.imul(r^r>>>13,1274126177),((r^r>>>16)>>>0)/4294967296}function nt(t){for(var e=[],r=t.firstElementChild;r;r=r.nextElementSibling)et.test(r.localName)||e.push(r);return e}function Ot(t,e){for(var r=nt(t),a=0;r.length===1&&r[0].localName===\"g\"&&r.length!==e&&!r[0].hasAttribute(\"data-svganim\")&&a++<8;)r=nt(r[0]);return r}function St(t){var e=[];It.test(t.localName)&&e.push(t);for(var r=t.querySelectorAll(\"path,line,polyline,polygon,circle,ellipse,rect\"),a=0;a<r.length;a++){for(var n=r[a].parentNode,i=!1;n&&n!==t;n=n.parentNode)if(et.test(n.localName)){i=!0;break}i||e.push(r[a])}return e}function Nt(t){var e=[];return(function r(a){if((a.localName===\"text\"||a.localName===\"tspan\")&&!a.firstElementChild){e.push(a);return}for(var n=a.firstElementChild;n;n=n.nextElementSibling)r(n)})(t),e}function $(t,e){var r=t.getAttribute(e);r&&/[\\s,]/.test(r.trim())&&t.setAttribute(e,r.trim().split(/[\\s,]+/)[0])}function it(t){for(var e=Nt(t),r=null,a=0;a<e.length;a++)if(e[a].textContent.trim()){r=e[a];break}if(r=r||e[0]||null,!r)return{get:function(){return\"\"},set:function(){}};for(var n=0;n<e.length;n++)e[n]!==r&&(e[n].textContent=\"\");$(r,\"x\"),$(r,\"y\"),r.removeAttribute(\"dx\"),r.removeAttribute(\"textLength\");for(var i=r.parentNode;i&&i.localName===\"tspan\";i=i.parentNode)$(i,\"x\"),i.removeAttribute(\"textLength\");var s=r.textContent;return{get:function(){return s},set:function(u){r.textContent!==u&&(r.textContent=u)}}}function st(t){var e=String(t),r=e.indexOf(\".\");return r<0?0:e.length-r-1}function Et(t){var e=String(t).replace(/,/g,\"\").match(/-?\\d+(\\.\\d+)?/);return e?{value:Number(e[0]),decimals:e[1]?e[1].length-1:0}:null}function Ct(t,e,r,a){var n=t<0&&Math.abs(t)>=Math.pow(10,-e)/2,i=Math.abs(t).toFixed(e),s=i.split(\".\"),u=s[0];return r>u.length&&(u=new Array(r-u.length+1).join(\"0\")+u),a&&(u=u.replace(/\\B(?=(\\d{3})+(?!\\d))/g,\",\")),(n?\"-\":\"\")+u+(s[1]?\".\"+s[1]:\"\")}function y(t){return t<10?\"0\"+t:String(t)}function _t(t,e){var r=e.getHours();return t.replace(/YYYY|MM|DD|HH|hh|mm|ss|A/g,function(a){switch(a){case\"YYYY\":return String(e.getFullYear());case\"MM\":return y(e.getMonth()+1);case\"DD\":return y(e.getDate());case\"HH\":return y(r);case\"hh\":return y(r%12||12);case\"mm\":return y(e.getMinutes());case\"ss\":return y(e.getSeconds());case\"A\":return r<12?\"AM\":\"PM\"}return a})}var J=[];function qt(t){if(t.__svgAnimSlot)return t.__svgAnimSlot;var e=document.createElementNS(E,\"g\");e.setAttribute(\"class\",\"svganim-wrap\"),t.parentNode.insertBefore(e,t),e.appendChild(t);var r={x:0,y:0,width:0,height:0};try{r=e.getBBox()}catch(d){}var a=1,n=0,i=0,s=1;try{var u=m.getScreenCTM().inverse().multiply(e.parentNode.getScreenCTM());a=u.a,n=u.b,i=u.c,s=u.d}catch(d){}var l=a*s-n*i;Math.abs(l)<1e-12&&(a=1,n=0,i=0,s=1,l=1);var f={g:e,bbox:r,inv:[s/l,-n/l,-i/l,a/l],flip:l<0?-1:1,unit:1/Math.sqrt(Math.abs(l)),moves:[],rotates:[],scales:[],skews:[],opacity:1,dirty:!1,blur:0,filter:null,blurred:!1};return t.__svgAnimSlot=f,J.push(f),f}var ot={tl:[0,0],tc:[.5,0],tr:[1,0],cl:[0,.5],c:[.5,.5],cr:[1,.5],bl:[0,1],bc:[.5,1],br:[1,1]};function W(t,e){var r=ot[e]||ot.c,a=t.bbox;return[a.x+a.width*r[0],a.y+a.height*r[1]]}function o(t){return Math.round(t*1e4)/1e4}var x=null,Dt=0;function Pt(t){if(t.filter)return t.filter;x||(x=document.createElementNS(E,\"defs\"),x.setAttribute(\"class\",\"svganim-defs\"),m.appendChild(x));var e;do e=\"svganim-blur-\"+ ++Dt;while(document.getElementById(e));var r=document.createElementNS(E,\"filter\");r.setAttribute(\"id\",e),r.setAttribute(\"filterUnits\",\"userSpaceOnUse\"),r.setAttribute(\"color-interpolation-filters\",\"sRGB\");var a=document.createElementNS(E,\"feGaussianBlur\");return r.appendChild(a),x.appendChild(r),t.filter={el:r,fe:a,url:\"url(#\"+e+\")\"},t.filter}function Tt(t){var e=Math.sqrt(t.blur)*t.unit;if(t.blur=0,!(e>.01)){t.blurred&&(t.g.removeAttribute(\"filter\"),t.blurred=!1);return}var r=Pt(t),a=t.bbox,n=3*e+.1*Math.max(a.width,a.height)+2;r.el.setAttribute(\"x\",o(a.x-n)),r.el.setAttribute(\"y\",o(a.y-n)),r.el.setAttribute(\"width\",o(a.width+2*n)),r.el.setAttribute(\"height\",o(a.height+2*n)),r.fe.setAttribute(\"stdDeviation\",o(e)),t.blurred||(t.g.setAttribute(\"filter\",r.url),t.blurred=!0)}function Yt(t){var e=t.moves.concat(t.rotates,t.scales,t.skews);e.length?t.g.setAttribute(\"transform\",e.join(\" \")):t.dirty&&t.g.removeAttribute(\"transform\"),t.opacity!==1?t.g.style.opacity=String(o(t.opacity)):t.dirty&&(t.g.style.opacity=\"\"),t.dirty=e.length>0||t.opacity!==1,t.moves.length=0,t.rotates.length=0,t.scales.length=0,t.skews.length=0,t.opacity=1,Tt(t)}var Bt={normal:1,reverse:1,alternate:1,alternateReverse:1};function ut(t){return t.type===\"frames\"||t.target===\"children\"&&t.type!==\"count\"&&t.type!==\"clock\"}function A(t,e,r){this.el=t,this.spec=e,this.type=e.type,this.dur=Math.max(.001,h(e.dur,1)),this.delay=Math.max(0,h(e.delay,0)),this.loops=Math.max(0,Math.floor(h(e.loops,0))),this.loopDelay=Math.max(0,h(e.loopDelay,0)),this.dir=Bt[e.dir]?e.dir:\"normal\",this.ease=at[e.ease]||at.inOut,this.time=0,this.rate=0,this.targets=r;for(var a=r.length,n=ut(e)&&this.type!==\"frames\"?Math.max(0,h(e.stagger,0)):0,i=[],s=0;s<a;s++)i.push(s);for(i.sort(function(R,w){return T(R,7)-T(w,7)}),this.offsets=[],s=0;s<a;s++){var u=e.order===\"reverse\"?a-1-s:e.order===\"center\"?Math.abs(s-(a-1)/2):e.order===\"random\"?i.indexOf(s):s;this.offsets.push(u*n)}for(var l=0,f=0;f<a;f++)l=Math.max(l,this.offsets[f]);var d=this.dur+this.loopDelay;this.end=this.loops>0?this.delay+l+this.loops*d-this.loopDelay:1/0,this.period=this.dir===\"alternate\"||this.dir===\"alternateReverse\"?2*d:d,this.setup()}A.prototype.setup=function(){var t=this,e=this.spec;switch(this.type){case\"fade\":case\"blur\":case\"move\":case\"rotate\":case\"scale\":case\"skew\":this.slots=this.targets.map(qt);break;case\"draw\":this.paths=this.targets.map(function(u){return St(u).map(function(l){var f=0;try{f=l.getTotalLength()}catch(d){}return{el:l,len:f}})});break;case\"count\":this.text=it(this.el);var r=Et(this.text.get())||{value:0,decimals:0},a=e.start!==null&&e.start!==void 0&&e.start!==\"\"&&isFinite(Number(e.start));this.from=a?Number(e.start):r.value,this.to=h(e.end,0);var n=Math.max(a?st(e.start):r.decimals,st(this.to));this.dec=e.decimals===null||e.decimals===void 0||e.decimals<0?n:Math.floor(e.decimals),this.padWidth=e.pad?String(Math.floor(Math.max(Math.abs(this.from),Math.abs(this.to)))).length:0,this.seed=Math.floor(Math.random()*1e5);break;case\"clock\":this.text=it(this.el);break;case\"frames\":this.frameIndex=-1;break}var i=e.trigger;if(this.type===\"clock\"&&(i=\"load\"),i===\"click\")this.el.style.cursor=\"pointer\",this.el.addEventListener(\"click\",function(){t.time=0,t.rate=1,b()});else if(i===\"hover\")this.el.addEventListener(\"mouseenter\",function(){t.rate=1,b()}),this.el.addEventListener(\"mouseleave\",function(){t.end===1/0&&t.time>t.delay+t.period&&(t.time=t.delay+(t.time-t.delay)%t.period),t.rate=-1,b()});else if(i===\"view\"&&typeof IntersectionObserver==\"function\"){var s=new IntersectionObserver(function(u){for(var l=0;l<u.length;l++)if(u[l].isIntersecting){t.rate=1,s.disconnect(),b();break}},{threshold:.2});s.observe(this.el)}else this.rate=1,this.autoStart=!0},A.prototype.advance=function(t){return this.rate?(this.time+=t*this.rate,this.time<=0&&this.rate<0?(this.time=0,this.rate=0):this.time>=this.end&&this.rate>0&&(this.time=this.end,this.rate=0),this.rate!==0):!1},A.prototype.progress=function(t){var e=this.time-this.delay-this.offsets[t],r=this.dur+this.loopDelay,a=0,n=0;if(e>0){a=Math.floor(e/r);var i=e-a*r;this.loops>0&&a>=this.loops?(a=this.loops-1,n=1):n=P(i/this.dur)}var s=this.dir===\"reverse\"||this.dir===\"alternate\"&&a%2===1||this.dir===\"alternateReverse\"&&a%2===0;return s&&(n=1-n),{p:n,k:a,e:this.type===\"frames\"?n:this.ease(n)}},A.prototype.apply=function(){var t=this.spec,e=this.targets.length,r,a,n;switch(this.type){case\"fade\":for(r=0;r<e;r++){a=this.progress(r);var i=h(t.from,100)/100,s=h(t.to,0)/100;this.slots[r].opacity*=Math.max(0,Math.min(1,i+(s-i)*a.e))}break;case\"blur\":var u=Math.max(0,h(t.from,0)),l=Math.max(0,h(t.to,0));for(r=0;r<e;r++){a=this.progress(r);var f=Math.max(0,u+(l-u)*a.e);this.slots[r].blur+=f*f}break;case\"move\":for(r=0;r<e;r++){a=this.progress(r),n=this.slots[r];var d=h(t.x,0)*a.e,R=h(t.y,0)*a.e,w=n.inv,ct=w[0]*d+w[2]*R,vt=w[1]*d+w[3]*R;(ct||vt)&&n.moves.push(\"translate(\"+o(ct)+\" \"+o(vt)+\")\")}break;case\"rotate\":for(r=0;r<e;r++){a=this.progress(r),n=this.slots[r];var dt=h(t.angle,360)*a.e*n.flip,mt=W(n,t.pivot);dt&&n.rotates.push(\"rotate(\"+o(dt)+\" \"+o(mt[0])+\" \"+o(mt[1])+\")\")}break;case\"scale\":for(r=0;r<e;r++){a=this.progress(r),n=this.slots[r];var pt=1+(h(t.sx,100)/100-1)*a.e,gt=1+(h(t.sy,100)/100-1)*a.e,F=W(n,t.pivot);(pt!==1||gt!==1)&&n.scales.push(\"translate(\"+o(F[0])+\" \"+o(F[1])+\") scale(\"+o(pt)+\" \"+o(gt)+\") translate(\"+o(-F[0])+\" \"+o(-F[1])+\")\")}break;case\"skew\":for(r=0;r<e;r++){a=this.progress(r),n=this.slots[r];var bt=h(t.ax,20)*a.e,yt=h(t.ay,0)*a.e,H=W(n,t.pivot);(bt||yt)&&n.skews.push(\"translate(\"+o(H[0])+\" \"+o(H[1])+\") skewX(\"+o(bt)+\") skewY(\"+o(yt)+\") translate(\"+o(-H[0])+\" \"+o(-H[1])+\")\")}break;case\"draw\":var Mt=Math.max(.001,Math.min(1,h(t.seg,20)/100));for(r=0;r<e;r++){var k=this.progress(r).e,c,v;switch(t.mode){case\"erase\":c=k,v=1;break;case\"revealErase\":k<.5?(c=0,v=2*k):(c=2*k-1,v=1);break;case\"travel\":v=(1+Mt)*k,c=v-Mt;break;default:c=0,v=k}c=P(c),v=P(v);for(var wt=this.paths[r],j=0;j<wt.length;j++){var kt=wt[j],K=kt.len,L=kt.el.style;if(K>0){if(v-c<1e-4){L.visibility=\"hidden\";continue}L.visibility=\"\",L.strokeDasharray=o((v-c)*K)+\" \"+o(K+1),L.strokeDashoffset=String(o(-c*K))}}}break;case\"count\":a=this.progress(0);var V;if(t.random){var U=Math.min(this.from,this.to),xt=Math.max(this.from,this.to),At=a.k===0?this.from:U+(xt-U)*T(this.seed,a.k-1),Rt=U+(xt-U)*T(this.seed,a.k);V=At+(Rt-At)*this.ease(P((this.time-this.delay-a.k*(this.dur+this.loopDelay))/this.dur)),this.time<=this.delay&&(V=this.from)}else V=this.from+(this.to-this.from)*a.e;this.text.set(Ct(V,this.dec,this.padWidth,!!t.group));break;case\"frames\":a=this.progress(0);var tt=Math.min(e-1,Math.floor(a.p*e));if(tt!==this.frameIndex){for(r=0;r<e;r++)this.targets[r].style.visibility=r===tt?\"\":\"hidden\";this.frameIndex=tt}break}};for(var p=[],I=[],X=m.querySelectorAll(\"[data-svganim]\"),z=[],Y=0;Y<X.length;Y++){var O;try{O=JSON.parse(X[Y].getAttribute(\"data-svganim\"))}catch(t){continue}!O||!O.tracks||!O.tracks.length||z.push({el:X[Y],data:O})}z.forEach(function(t){t.data.c&&(t.el.__svgAnimKids=[])});for(var B=m.querySelectorAll(\"[data-svganim-c]\"),S=0;S<B.length;S++)for(var g=B[S].parentNode;g&&g.nodeType===1;g=g.parentNode){if(g.__svgAnimKids){g.__svgAnimKids.push({el:B[S],layer:h(B[S].getAttribute(\"data-svganim-c\"),0)});break}if(g===m)break}function Gt(t,e){var r=e.type===\"frames\"?-1:1;return t.__svgAnimKids.slice().sort(function(a,n){return r*(a.layer-n.layer)}).map(function(a){return a.el})}var lt=[];z.forEach(function(t){t.data.tracks.forEach(function(e){if(!(!e||!e.type||e.type===\"none\")){var r=[t.el];ut(e)&&(r=t.el.__svgAnimKids?Gt(t.el,e):Ot(t.el,h(t.data.n,-1)),e.rev===!0&&(r=r.slice().reverse())),lt.push({el:t.el,spec:e,targets:r})}})}),lt.forEach(function(t){try{var e=new A(t.el,t.spec,t.targets);e.type===\"clock\"?I.push(e):p.push(e)}catch(r){window.console&&console.warn(\"[svganim] skipped track\",t.spec,r)}});var ht=window.requestAnimationFrame||function(t){return setTimeout(function(){t(Date.now())},16)},Q=!1,N=null,M=!1;function G(){for(var t=0;t<p.length;t++)p[t].apply();for(var e=0;e<J.length;e++)Yt(J[e])}function ft(t){var e=N===null?0:Math.min(.25,(t-N)/1e3);N=t;var r=!1;if(!M)for(var a=0;a<p.length;a++)p[a].advance(e)&&(r=!0);G(),r&&!M?ht(ft):(Q=!1,N=null)}function b(){Q||M||(Q=!0,N=null,ht(ft))}function Z(){for(var t=new Date,e=0;e<I.length;e++)I[e].text.set(_t(String(I[e].spec.format||\"HH:mm:ss\"),t))}I.length&&(Z(),setTimeout(function(){Z(),setInterval(Z,1e3)},1e3-Date.now()%1e3+5)),G(),b(),m.__svgAnim={version:\"0.6.2\",players:p,play:function(){M=!1,b()},pause:function(){M=!0},restart:function(){M=!1,p.forEach(function(t){t.time=0,t.rate=t.autoStart?1:0}),G(),b()},seek:function(t){p.forEach(function(e){e.time=Math.max(0,Math.min(t,e.end))}),G()}}})();";

// ---------------------------------------------------------------------------
// SVG Anim core: data model, validation, node helpers.
// ---------------------------------------------------------------------------
// Animation data lives in the node's tag dictionary under TAG_KEY as JSON:
//   {"v":1,"tracks":[{ "type":"move", "x":0, "y":-20, "dur":1, ... }],"suffix":"__anim","auto":true}
// "suffix" is the text this script appended to the layer name ("" = none),
// "auto" marks a layer that had no name of its own before the suffix was added.
// Exported SVG elements carry {"v":1,"n":<child count>,"tracks":[…]} in data-svganim.
// With Each child tracks the payload also has "c":1, and every first-level child
// carries data-svganim-c="<Layers panel position>" (0 = top layer).

const TAG_KEY = 'svganim';
const DATA_VERSION = 1;
const MAX_TRACKS = 8;
const DEFAULT_SUFFIX = '__anim';
const MAX_SUFFIX_LENGTH = 32;

const TYPES = ['none', 'fade', 'blur', 'move', 'rotate', 'scale', 'skew', 'draw', 'count', 'clock', 'frames'];
const TYPE_LABELS = ['None', 'Fade', 'Blur', 'Move', 'Rotate', 'Scale', 'Skew', 'Draw stroke', 'Count number', 'Clock', 'Frames'];
const TARGETS = ['self', 'children'];
const TARGET_LABELS = ['Element', 'Each child'];
// Cubic keeps the original in/out/inOut IDs so saved animations stay compatible.
const EASES = [
    'linear',
    'sineIn', 'sineOut', 'sineInOut',
    'quadIn', 'quadOut', 'quadInOut',
    'in', 'out', 'inOut',
    'quartIn', 'quartOut', 'quartInOut',
    'quintIn', 'quintOut', 'quintInOut',
    'expoIn', 'expoOut', 'expoInOut',
    'circIn', 'circOut', 'circInOut',
    'backIn', 'backOut', 'backInOut',
    'elasticIn', 'elasticOut', 'elasticInOut',
    'bounceIn', 'bounceOut', 'bounceInOut'
];
const EASE_LABELS = [
    'Linear',
    'Sine in', 'Sine out', 'Sine in-out',
    'Quad in', 'Quad out', 'Quad in-out',
    'Cubic in', 'Cubic out', 'Cubic in-out',
    'Quart in', 'Quart out', 'Quart in-out',
    'Quint in', 'Quint out', 'Quint in-out',
    'Expo in', 'Expo out', 'Expo in-out',
    'Circ in', 'Circ out', 'Circ in-out',
    'Back in', 'Back out', 'Back in-out',
    'Elastic in', 'Elastic out', 'Elastic in-out',
    'Bounce in', 'Bounce out', 'Bounce in-out'
];
const DIRS = ['normal', 'reverse', 'alternate', 'alternateReverse'];
const DIR_LABELS = ['Normal', 'Reverse', 'Alternate', 'Alternate reverse'];
// Each child follows the Layers panel: 'forward' starts with the top layer; the
// separate rev flag reverses the layer order. Saved 'reverse' orders become rev.
const ORDERS = ['forward', 'center', 'random'];
const ORDER_LABELS = ['Top to bottom layer', 'From centre', 'Random'];
const TRIGGERS = ['load', 'view', 'click', 'hover'];
const TRIGGER_LABELS = ['On load', 'When visible', 'On click', 'On hover'];
const DRAW_MODES = ['reveal', 'revealErase', 'erase', 'travel'];
const DRAW_LABELS = ['Reveal', 'Reveal then erase', 'Erase', 'Travel'];
const PIVOTS = ['tl', 'tc', 'tr', 'cl', 'c', 'cr', 'bl', 'bc', 'br'];
const DECIMAL_LABELS = ['Auto', '0', '1', '2', '3', '4'];

const COMMON_DEFAULTS = {
    target: 'self', dur: 1, delay: 0, stagger: 0.1, order: 'forward', rev: false,
    ease: 'inOut', dir: 'alternate', loops: 0, loopDelay: 0, trigger: 'load'
};
// Fields per type; '$' = timing preset applied when a track is first given this type.
const TYPE_DEFAULTS = {
    fade: { from: 100, to: 0 },
    blur: { from: 0, to: 10 },
    move: { x: 0, y: -20 },
    rotate: { angle: 360, pivot: 'c', $: { ease: 'linear', dir: 'normal', dur: 2 } },
    scale: { sx: 120, sy: 120, pivot: 'c' },
    skew: { ax: 20, ay: 0, pivot: 'c' },
    draw: { mode: 'reveal', seg: 20, $: { dir: 'normal', dur: 2, loopDelay: 0.5 } },
    count: { start: null, end: 100, decimals: null, pad: false, group: false, random: false, $: { dir: 'normal', ease: 'out', dur: 2, loops: 1 } },
    clock: { format: 'HH:mm:ss' },
    frames: { $: { target: 'children', ease: 'linear', dir: 'normal' } }
};

function finiteOr(v, d) {
    const n = Number(v);
    return v !== null && v !== '' && Number.isFinite(n) ? n : d;
}
function pick(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }

/** Returns a fully populated, validated track (common + type fields), or null. */
function normalizeTrack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = pick(TYPES, raw.type, null);
    if (!type || type === 'none') return null;
    const def = TYPE_DEFAULTS[type];
    const t = { type };
    t.target = pick(TARGETS, raw.target, COMMON_DEFAULTS.target);
    if (type === 'frames') t.target = 'children';
    if (type === 'count' || type === 'clock') t.target = 'self';
    t.dur = Math.max(0.01, finiteOr(raw.dur, COMMON_DEFAULTS.dur));
    t.delay = Math.max(0, finiteOr(raw.delay, 0));
    t.stagger = Math.max(0, finiteOr(raw.stagger, COMMON_DEFAULTS.stagger));
    t.order = pick(ORDERS, raw.order, 'forward');
    t.rev = raw.rev === true || raw.order === 'reverse';
    t.ease = pick(EASES, raw.ease, COMMON_DEFAULTS.ease);
    t.dir = pick(DIRS, raw.dir, COMMON_DEFAULTS.dir);
    t.loops = Math.max(0, Math.floor(finiteOr(raw.loops, 0)));
    t.loopDelay = Math.max(0, finiteOr(raw.loopDelay, 0));
    t.trigger = pick(TRIGGERS, raw.trigger, 'load');
    switch (type) {
        case 'fade':
            t.from = Math.min(100, Math.max(0, finiteOr(raw.from, def.from)));
            t.to = Math.min(100, Math.max(0, finiteOr(raw.to, def.to)));
            break;
        case 'blur':
            t.from = Math.max(0, finiteOr(raw.from, def.from));
            t.to = Math.max(0, finiteOr(raw.to, def.to));
            break;
        case 'move':
            t.x = finiteOr(raw.x, def.x);
            t.y = finiteOr(raw.y, def.y);
            break;
        case 'rotate':
            t.angle = finiteOr(raw.angle, def.angle);
            t.pivot = pick(PIVOTS, raw.pivot, 'c');
            break;
        case 'scale':
            t.sx = finiteOr(raw.sx, def.sx);
            t.sy = finiteOr(raw.sy, def.sy);
            t.pivot = pick(PIVOTS, raw.pivot, 'c');
            break;
        case 'skew':
            t.ax = finiteOr(raw.ax, def.ax);
            t.ay = finiteOr(raw.ay, def.ay);
            t.pivot = pick(PIVOTS, raw.pivot, 'c');
            break;
        case 'draw':
            t.mode = pick(DRAW_MODES, raw.mode, 'reveal');
            t.seg = Math.min(100, Math.max(1, finiteOr(raw.seg, def.seg)));
            break;
        case 'count':
            t.start = finiteOr(raw.start, null);
            t.end = finiteOr(raw.end, def.end);
            t.decimals = raw.decimals === null || raw.decimals === undefined ? null : Math.min(4, Math.max(0, Math.floor(finiteOr(raw.decimals, 0))));
            t.pad = !!raw.pad;
            t.group = !!raw.group;
            t.random = !!raw.random;
            break;
        case 'clock':
            t.format = typeof raw.format === 'string' && raw.format.length ? raw.format.slice(0, 64) : def.format;
            break;
    }
    return t;
}

/** Older track data in the current form, for strict comparisons. */
function migrateTrack(raw) {
    if (!raw || raw.order !== 'reverse') return raw;
    return Object.assign({}, raw, { order: 'forward', rev: true });
}

/** A brand-new track of the given type with its timing preset. */
function newTrack(type, base) {
    const def = TYPE_DEFAULTS[type] || {};
    const raw = Object.assign({}, COMMON_DEFAULTS, base || {}, def.$ || {}, { type });
    for (const k of Object.keys(def)) if (k !== '$') raw[k] = def[k];
    return normalizeTrack(raw);
}

function cleanSuffix(s) {
    s = typeof s === 'string' ? s.slice(0, MAX_SUFFIX_LENGTH) : '';
    return s.trim() ? s : '';
}

function normalizeData(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) return null;
    const tracks = raw.tracks.map(normalizeTrack).filter(Boolean).slice(0, MAX_TRACKS);
    if (!tracks.length) return null;
    const data = { v: DATA_VERSION, tracks };
    if (typeof raw.suffix === 'string') data.suffix = cleanSuffix(raw.suffix);
    if (raw.auto === true) data.auto = true;
    return data;
}

function serializeData(data) {
    const norm = normalizeData(data);
    return norm ? JSON.stringify(norm) : '';
}

/** Reads animation data from a node's tag. {data, error} — data null when absent/empty. */
function readNodeData(node) {
    let ti = null;
    try { ti = node.tagInterface; } catch (_) { return { data: null }; }
    if (!ti || !ti.hasKey(TAG_KEY)) return { data: null };
    const raw = ti.getValueForKey(TAG_KEY);
    if (!raw) return { data: null };
    try {
        const data = normalizeData(JSON.parse(raw));
        return data ? { data, raw } : { data: null, raw, error: 'no valid tracks' };
    } catch (e) {
        return { data: null, raw, error: 'invalid JSON' };
    }
}

// ------------------------------------------------------------------- names
function userName(node) {
    try { return node.descriptionInterface.userDescription || ''; } catch (_) { return ''; }
}
function displayName(node) {
    try { return node.descriptionInterface.description || ''; } catch (_) { return ''; }
}
function defaultName(node) {
    try { return node.descriptionInterface.defaultDescription || ''; } catch (_) { return ''; }
}
/** The layer name without the suffix this script added. */
function baseName(node, data) {
    const name = userName(node);
    const sfx = data && data.suffix;
    return sfx && name.length > sfx.length && name.endsWith(sfx) ? name.slice(0, -sfx.length) : name;
}
/** True when the base name is only the default name the script filled in. */
function isAutoName(node, data) {
    const name = userName(node);
    if (!name) return true;
    return !!(data && data.auto) && baseName(node, data) === defaultName(node);
}
/** Name used for the SVG id: base name, or '' when the layer has no name of its own. */
function exportName(node, data) {
    return isAutoName(node, data) ? '' : baseName(node, data);
}

// ------------------------------------------------------------- descriptions
function describeTrack(t) {
    if (!t) return '–';
    const s = (v) => String(round6(v));
    switch (t.type) {
        case 'fade': return 'Fade ' + s(t.from) + '→' + s(t.to) + '%';
        case 'blur': return 'Blur ' + s(t.from) + '→' + s(t.to) + 'px';
        case 'move': return 'Move ' + s(t.x) + ',' + s(t.y);
        case 'rotate': return 'Rotate ' + s(t.angle) + '°';
        case 'scale': return 'Scale ' + s(t.sx) + (t.sx === t.sy ? '' : '×' + s(t.sy)) + '%';
        case 'skew': return 'Skew ' + s(t.ax) + ',' + s(t.ay) + '°';
        case 'draw': return 'Draw ' + ['reveal', 'reveal+erase', 'erase', 'travel'][DRAW_MODES.indexOf(t.mode)];
        case 'count': return 'Count →' + s(t.end);
        case 'clock': return 'Clock ' + t.format;
        case 'frames': return 'Frames';
    }
    return t.type;
}
function describeData(data) {
    if (!data || !data.tracks.length) return 'No animation';
    return data.tracks.map(describeTrack).join(' + ');
}

// ---------------------------------------------------------------- node tree
function forEachNode(node, fn) {
    fn(node);
    let kids = null;
    try { kids = node.children; } catch (_) { kids = null; }
    if (!kids) return;
    for (const c of kids) forEachNode(c, fn);
}
function childCount(node) {
    let n = 0;
    try { for (const _ of node.children) n++; } catch (_) { n = 0; }
    return n;
}
/** First-level children, bottom layer first (SVG paint order). */
function childNodes(node) {
    try { return Array.from(node.children); } catch (_) { return []; }
}
/** Tracks that animate the first-level children instead of the element itself. */
function usesChildTargets(t) {
    return t.type === 'frames' || (t.target === 'children' && t.type !== 'count' && t.type !== 'clock');
}
function compactError(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Animate panel: edit the animation tracks stored on the selected elements.
// ---------------------------------------------------------------------------

function selectedNodes(doc) {
    const nodes = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node) nodes.push(node);
    }
    return nodes;
}

const ANCHOR_NAMES = { tl: 'TopLeft', tc: 'TopCentre', tr: 'TopRight', cl: 'CentreLeft', c: 'Centre', cr: 'CentreRight', bl: 'BottomLeft', bc: 'BottomCentre', br: 'BottomRight' };
function anchorValue(key) { return SpatialAnchor[ANCHOR_NAMES[key] || 'Centre'].value; }
function anchorKey(value) {
    // The native control returns the SpatialAnchor enum object, not its number.
    if (value && typeof value === 'object') value = value.value;
    for (const k of PIVOTS) if (SpatialAnchor[ANCHOR_NAMES[k]].value === value) return k;
    return 'c';
}

/** What the panel starts from: stored tracks, differences, the suffix to show. */
function loadSelectionState(nodes) {
    const items = nodes.map(node => {
        const tag = readNodeData(node);
        return { node, data: tag.data, tagError: tag.error || null };
    });
    const first = items.find(it => it.data) || null;
    const signatures = new Set(items.map(it => it.data ? JSON.stringify(it.data.tracks) : ''));
    // Show the suffix the animated elements already use, when they agree.
    const suffixes = new Set(items.filter(it => it.data && typeof it.data.suffix === 'string').map(it => it.data.suffix));
    return {
        items,
        tracks: first ? first.data.tracks.slice() : [],
        differ: signatures.size > 1,
        suffix: suffixes.size === 1 ? Array.from(suffixes)[0] : DEFAULT_SUFFIX,
        animatedCount: items.filter(it => it.data).length,
        errors: items.filter(it => it.tagError)
    };
}

function selectionInfo(state) {
    const n = state.items.length;
    if (!n) return 'Nothing is selected. Select the elements to animate, then run the script again.';
    const lines = [];
    if (n === 1) {
        const it = state.items[0];
        const name = baseName(it.node, it.data) || displayName(it.node);
        lines.push('"' + name + '": ' + (it.data ? describeData(it.data) : 'no animation yet'));
    } else {
        lines.push(n + ' elements selected (' + state.animatedCount + ' animated). OK applies these tracks to all of them.');
        if (state.differ) lines.push('Their animations differ; the first animated one is shown.');
    }
    if (state.errors.length) lines.push('Unreadable animation data was found and will be replaced.');
    return lines.join('\n');
}

// ------------------------------------------------------------------- panel
function buildAnimatePanel(doc, left, right, state) {
    const num = (group, label, value, min, max, precision) => {
        const ctl = group.addUnitValueEditor(label, UnitType.Number, UnitType.Number, value, min, max);
        if (precision !== undefined) ctl.precision = precision;
        return ctl;
    };
    const pct = (group, label, value, min, max) => group.addUnitValueEditor(label, UnitType.Percentage, UnitType.Percentage, value, min, max);
    const c = {};
    const groups = [];

    const sel = left.addGroup('Selection'); groups.push(sel);
    c.info = sel.addStaticText(null, selectionInfo(state)).setIsFullWidth();

    const track = left.addGroup('Tracks'); groups.push(track);
    c.track = track.addButtonSet('Track', ['1', '2', '3', '4', '5', '6', '7', '8'], 0);
    c.summary = track.addStaticText(null, '').setIsFullWidth();
    const orderButtons = track.addColumnStack();
    c.moveLeft = orderButtons.addColumn().addGroup(null).setEnableSeparator(false).addButton('←').setIsFullWidth();
    c.moveRight = orderButtons.addColumn().addGroup(null).setEnableSeparator(false).addButton('→').setIsFullWidth();
    c.moveLeft.description = 'Swap the selected track with the previous track.';
    c.moveRight.description = 'Swap the selected track with the next track.';

    const fx = left.addGroup('Effect'); groups.push(fx);
    c.type = fx.addComboBox('Type', TYPE_LABELS, 0);
    c.target = fx.addButtonSet('Apply to', TARGET_LABELS, 0);
    c.fadeFrom = pct(fx, 'From opacity', 100, 0, 100);
    c.fadeTo = pct(fx, 'To opacity', 0, 0, 100);
    c.blurFrom = fx.addUnitValueEditor('From blur radius', UnitType.Pixel, doc.units, 0, 0, null);
    c.blurTo = fx.addUnitValueEditor('To blur radius', UnitType.Pixel, doc.units, 10, 0, null);
    c.moveX = fx.addUnitValueEditor('Move X', UnitType.Pixel, doc.units, 0);
    c.moveY = fx.addUnitValueEditor('Move Y', UnitType.Pixel, doc.units, -20);
    c.angle = fx.addUnitValueEditor('Angle (clockwise)', UnitType.Degree, UnitType.Degree, 360);
    c.sx = pct(fx, 'Scale X', 120);
    c.sy = pct(fx, 'Scale Y', 120);
    c.skewX = fx.addUnitValueEditor('Skew X', UnitType.Degree, UnitType.Degree, 20);
    c.skewY = fx.addUnitValueEditor('Skew Y', UnitType.Degree, UnitType.Degree, 0);
    c.pivot = fx.addSpatialAnchor('Pivot', SpatialAnchor.Centre);
    c.drawMode = fx.addComboBox('Draw', DRAW_LABELS, 0);
    c.drawSeg = pct(fx, 'Segment length', 20, 1, 100);
    c.countStart = fx.addTextBox('Start (blank = current text)', '');
    c.countEnd = num(fx, 'End', 100, null, null, 3);
    c.countDec = fx.addComboBox('Decimals', DECIMAL_LABELS, 0);
    c.countPad = fx.addSwitch('Pad with leading zeros', false);
    c.countGroup = fx.addSwitch('Thousands separator', false);
    c.countRandom = fx.addSwitch('Random value each repeat', false);
    c.clockFormat = fx.addTextBox('Format', 'HH:mm:ss');
    c.clockHint = fx.addStaticText(null, 'Tokens: YYYY MM DD HH hh mm ss A. Shows the viewer\'s local time; timing settings are ignored.').setIsFullWidth();
    c.framesHint = fx.addStaticText(null, 'Shows one first-level child at a time, bottom layer first and top layer last (Reverse order: top first). Duration is one pass through all children.').setIsFullWidth();
    c.typeHint = fx.addStaticText(null, 'Choose a type to animate this track. Set every track to None to remove the animation.').setIsFullWidth();

    c.effectSpace = fx.addStaticText(null, '').setIsFullWidth();

    const timing = right.addGroup('Timing'); groups.push(timing);
    c.timingHint = timing.addStaticText(null, 'Please set a Track Effect first.').setIsFullWidth();
    c.dur = num(timing, 'Duration (s)', 1, 0.01, null, 2);
    c.delay = num(timing, 'Delay (s)', 0, 0, null, 2);
    c.stagger = num(timing, 'Stagger per child (s)', 0.1, 0, null, 2);
    c.order = timing.addComboBox('Stagger order', ORDER_LABELS, 0);
    c.rev = timing.addSwitch('Reverse order', false);
    c.ease = timing.addComboBox('Easing', EASE_LABELS, EASES.indexOf(COMMON_DEFAULTS.ease));
    c.dir = timing.addComboBox('Direction', DIR_LABELS, 2);
    c.loops = num(timing, 'Play count (0 = forever)', 0, 0, null, 0);
    c.loopDelay = num(timing, 'Pause between plays (s)', 0, 0, null, 2);
    c.trigger = timing.addComboBox('Start', TRIGGER_LABELS, 0);

    c.timingSpace = timing.addStaticText(null, '').setIsFullWidth();

    const layer = right.addGroup('Layer name'); groups.push(layer);
    c.suffix = layer.addTextBox('Suffix', state.suffix);
    c.suffixHint = layer.addStaticText(null, 'Added to the names of animated layers so you can spot them in the Layers panel; removed again when the animation is cleared. Leave blank for none. Not used in the SVG ids.').setIsFullWidth();
    c.exportAfter = layer.addSwitch('Export after applying (uses the Export settings)', false);

    return { c, groups };
}

/** Reads the visible form into a normalized track (or null for None). */
function readForm(c) {
    const type = TYPES[c.type.selectedIndex] || 'none';
    if (type === 'none') return null;
    const dec = c.countDec.selectedIndex;
    const startText = String(c.countStart.text || '').trim();
    return normalizeTrack({
        type,
        target: TARGETS[c.target.selectedIndex],
        dur: c.dur.value, delay: c.delay.value, stagger: c.stagger.value,
        order: ORDERS[c.order.selectedIndex], rev: !!c.rev.value, ease: EASES[c.ease.selectedIndex], dir: DIRS[c.dir.selectedIndex],
        loops: c.loops.value, loopDelay: c.loopDelay.value, trigger: TRIGGERS[c.trigger.selectedIndex],
        from: type === 'blur' ? round6(c.blurFrom.value) : c.fadeFrom.value,
        to: type === 'blur' ? round6(c.blurTo.value) : c.fadeTo.value,
        x: round6(c.moveX.value), y: round6(c.moveY.value),
        angle: c.angle.value,
        sx: c.sx.value, sy: c.sy.value,
        ax: c.skewX.value, ay: c.skewY.value,
        pivot: anchorKey(c.pivot.value),
        mode: DRAW_MODES[c.drawMode.selectedIndex], seg: c.drawSeg.value,
        start: startText === '' ? null : startText, end: c.countEnd.value,
        decimals: dec <= 0 ? null : dec - 1,
        pad: !!c.countPad.value, group: !!c.countGroup.value, random: !!c.countRandom.value,
        format: String(c.clockFormat.text || '')
    });
}

/** Writes a track into the form. Fields the track does not use keep their defaults. */
function loadForm(c, track) {
    const t = track || null;
    const type = t ? t.type : 'none';
    const pre = t || newTrack('fade');
    const ofType = (k, d) => (t && t[k] !== undefined && t[k] !== null) ? t[k] : d;
    // Fade and Blur both store from/to; keep each form pair to its own type.
    const ofKind = (kind, k, d) => t && t.type === kind ? ofType(k, d) : d;
    c.type.selectedIndex = TYPES.indexOf(type);
    c.target.selectedIndex = TARGETS.indexOf(pre.target);
    c.dur.value = pre.dur; c.delay.value = pre.delay; c.stagger.value = pre.stagger;
    c.order.selectedIndex = ORDERS.indexOf(pre.order);
    c.rev.value = !!pre.rev;
    c.ease.selectedIndex = EASES.indexOf(pre.ease);
    c.dir.selectedIndex = DIRS.indexOf(pre.dir);
    c.loops.value = pre.loops; c.loopDelay.value = pre.loopDelay;
    c.trigger.selectedIndex = TRIGGERS.indexOf(pre.trigger);
    c.fadeFrom.value = ofKind('fade', 'from', 100); c.fadeTo.value = ofKind('fade', 'to', 0);
    c.blurFrom.value = ofKind('blur', 'from', 0); c.blurTo.value = ofKind('blur', 'to', 10);
    c.moveX.value = ofType('x', 0); c.moveY.value = ofType('y', -20);
    c.angle.value = ofType('angle', 360);
    c.sx.value = ofType('sx', 120); c.sy.value = ofType('sy', 120);
    c.skewX.value = ofType('ax', 20); c.skewY.value = ofType('ay', 0);
    c.pivot.value = anchorValue(ofType('pivot', 'c'));
    c.drawMode.selectedIndex = Math.max(0, DRAW_MODES.indexOf(ofType('mode', 'reveal')));
    c.drawSeg.value = ofType('seg', 20);
    const start = t && t.type === 'count' ? t.start : null;
    c.countStart.text = start === null || start === undefined ? '' : String(start);
    c.countEnd.value = ofType('end', 100);
    const dec = t && t.type === 'count' ? t.decimals : null;
    c.countDec.selectedIndex = dec === null || dec === undefined ? 0 : dec + 1;
    c.countPad.value = !!ofType('pad', false);
    c.countGroup.value = !!ofType('group', false);
    c.countRandom.value = !!ofType('random', false);
    c.clockFormat.text = ofType('format', 'HH:mm:ss');
}

const TYPE_CONTROLS = {
    fade: ['fadeFrom', 'fadeTo'],
    blur: ['blurFrom', 'blurTo'],
    move: ['moveX', 'moveY'],
    rotate: ['angle', 'pivot'],
    scale: ['sx', 'sy', 'pivot'],
    skew: ['skewX', 'skewY', 'pivot'],
    draw: ['drawMode', 'drawSeg'],
    count: ['countStart', 'countEnd', 'countDec', 'countPad', 'countGroup', 'countRandom'],
    clock: ['clockFormat', 'clockHint'],
    frames: ['framesHint'],
    none: ['typeHint']
};
const ALL_TYPE_CONTROLS = Array.from(new Set([].concat(...Object.values(TYPE_CONTROLS))));
const TIMING_CONTROLS = ['dur', 'delay', 'stagger', 'order', 'rev', 'ease', 'dir', 'loops', 'loopDelay', 'trigger'];

function setVisible(item, visible) {
    if (item.isVisible !== visible) item.isVisible = visible;
}

// Keep the initial native dialog tall enough for every type. A two-line blank
// static text approximates one editor row; the nine-point pivot uses three rows.
function reserveRows(control, rows) {
    control.text = Array(Math.max(1, rows * 2)).fill('\u00a0').join('\n');
    setVisible(control, rows > 0);
}

/** Two lines: tracks 1–4 and 5–8; ▸ marks the track being edited. */
function trackSummary(tracks, current) {
    const cell = i => (i + 1) + (i === current ? '▸' : ' ') + describeTrack(tracks[i]);
    const line = from => [0, 1, 2, 3].map(k => cell(from + k)).join('   ');
    return line(0) + '\n' + line(4);
}

function updateAnimateControls(c, tracks, current) {
    const type = TYPES[c.type.selectedIndex] || 'none';
    const shown = new Set(TYPE_CONTROLS[type] || []);
    for (const k of ALL_TYPE_CONTROLS) setVisible(c[k], shown.has(k));
    setVisible(c.timingHint, type === 'none');
    const animated = type !== 'none' && type !== 'clock';
    const childCapable = type !== 'none' && type !== 'count' && type !== 'clock' && type !== 'frames';
    setVisible(c.target, childCapable);
    const children = childCapable && c.target.selectedIndex === 1;
    for (const k of TIMING_CONTROLS) setVisible(c[k], animated);
    setVisible(c.stagger, animated && children);
    setVisible(c.order, animated && children);
    setVisible(c.rev, animated && (children || type === 'frames'));
    setVisible(c.ease, animated && type !== 'frames');
    setVisible(c.drawSeg, type === 'draw' && c.drawMode.selectedIndex === DRAW_MODES.indexOf('travel'));
    c.loopDelay.isEnabled = c.loops.value !== 1;
    c.summary.text = trackSummary(tracks, current);
    c.moveLeft.isEnabled = current > 0;
    c.moveRight.isEnabled = current < MAX_TRACKS - 1;
    let effectRows = (childCapable ? 1 : 0);
    for (const k of shown) {
        if (!c[k].isVisible) continue;
        effectRows += k === 'pivot' ? 3 : /Hint$/.test(k) ? 2 : 1;
    }
    reserveRows(c.effectSpace, Math.max(0, 6 - effectRows));
    const timingRows = TIMING_CONTROLS.filter(k => c[k].isVisible).length;
    reserveRows(c.timingSpace, TIMING_CONTROLS.length - timingRows);
}

/** Wires the panel: switching tracks saves/loads the form; a new type gets its presets. */
function attachAnimate(panel, state) {
    const c = panel.c;
    const tracks = [];
    for (let i = 0; i < MAX_TRACKS; i++) tracks.push(state.tracks[i] || null);
    let current = 0;
    let lastType = tracks[0] ? tracks[0].type : 'none';
    loadForm(c, tracks[0]);
    updateAnimateControls(c, tracks, current);

    const onChange = () => {
        const idx = c.track.selectedIndex;
        if (idx !== current) {
            tracks[current] = readForm(c);
            current = idx;
            loadForm(c, tracks[current]);
            lastType = tracks[current] ? tracks[current].type : 'none';
        } else {
            const type = TYPES[c.type.selectedIndex] || 'none';
            if (type !== lastType) {
                const base = lastType === 'none' ? null : readForm(c);
                let next = null;
                if (type !== 'none') {
                    if (!base) next = newTrack(type);
                    else {
                        // Keep timing, take the new type's own fields from its defaults.
                        const keep = {};
                        for (const k of Object.keys(COMMON_DEFAULTS)) keep[k] = base[k];
                        next = normalizeTrack(Object.assign({}, TYPE_DEFAULTS[type], keep, { type }));
                    }
                }
                tracks[current] = next;
                loadForm(c, next);
                lastType = type;
            } else {
                tracks[current] = readForm(c);
            }
        }
        updateAnimateControls(c, tracks, current);
    };
    const collect = () => {
        tracks[current] = readForm(c);
        return tracks.filter(Boolean);
    };
    // Tracks as they would be saved, without disturbing the form.
    const peek = () => tracks.map((t, i) => i === current ? readForm(c) : t).filter(Boolean);
    // Presets replace all tracks atomically; never write the selected nodes here.
    const replace = incoming => {
        for (let i = 0; i < MAX_TRACKS; i++) tracks[i] = incoming[i] || null;
        current = 0;
        c.track.selectedIndex = 0;
        lastType = tracks[0] ? tracks[0].type : 'none';
        loadForm(c, tracks[0]);
        updateAnimateControls(c, tracks, current);
    };
    const slots = () => tracks.map((t, i) => i === current ? readForm(c) : t);
    const move = delta => {
        onChange(); // Flush current form edits before swapping, including a type change.
        const next = current + delta;
        if ((delta !== -1 && delta !== 1) || next < 0 || next >= MAX_TRACKS) return false;
        const other = tracks[next];
        tracks[next] = tracks[current];
        tracks[current] = other;
        current = next;
        c.track.selectedIndex = current;
        lastType = tracks[current] ? tracks[current].type : 'none';
        loadForm(c, tracks[current]);
        updateAnimateControls(c, tracks, current);
        return true;
    };
    return { onChange, collect, peek, replace, slots, move };
}

// ------------------------------------------------------------------- apply
/** New layer name and tag value for one element. */
function planNode(node, oldData, tracks, suffix) {
    const name = userName(node);
    const base = baseName(node, oldData);
    const auto = isAutoName(node, oldData);
    if (!tracks.length) {
        return { name: auto ? '' : base, tag: '' };
    }
    let newName;
    if (suffix) {
        const stem = base || defaultName(node);
        newName = stem.endsWith(suffix) ? stem : stem + suffix;
    } else {
        newName = auto ? '' : base;
    }
    const data = { tracks, suffix };
    if (auto) data.auto = true;
    return { name: newName, tag: serializeData(data), changedName: newName !== name };
}

function buildApplyCommand(doc, state, tracks, suffix) {
    const builder = CompoundCommandBuilder.create();
    let renamed = 0;
    for (const it of state.items) {
        const plan = planNode(it.node, it.data, tracks, suffix);
        const one = Selection.create(doc, [it.node]);
        builder.addCommand(DocumentCommand.createSetTagValueForKey(one, TAG_KEY, plan.tag));
        if (plan.name !== userName(it.node)) {
            builder.addCommand(DocumentCommand.createSetDescription(one, plan.name));
            renamed++;
        }
    }
    return { command: builder.createCommand(), renamed };
}

// ---------------------------------------------------------------------------
// Export panel: export an SVG with animation data and the playback runtime.
// ---------------------------------------------------------------------------
// Affinity's SVG export does not include tags, so animated elements are briefly
// renamed to unique tokens (one command), exported, and the rename is undone.
// The tokens are then located in the SVG text and replaced by the real ids plus
// a data-svganim attribute. First-level children of elements with Each child
// tracks get tokens too, so the player animates exactly those children (never
// deeper levels, whatever wrappers the SVG preset adds) in Layers panel order.
// Single-child ancestors of animated elements are tokenized as carriers: Affinity
// bakes a masked image and its group into one <use> that keeps only the group's
// id, so the image's animation is moved onto that element.

const RUNTIME_FILE = 'svg-anim-runtime.min.js';
const RUNTIME_MODES = ['embed', 'link'];
const RUNTIME_LABELS = ['Embed', 'Link'];
const TOKEN_PREFIX = 'svganimtok';

function stripExtension(name) { return String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, ''); }
// File names avoid spaces: whitespace inside a design name (document, artboard,
// typed file name) becomes '-'; the parts the script joins are separated by '_'.
function fileNamePart(name) {
    return String(name || '').trim().replace(/[\s\/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+|\.+$/g, '');
}
function safeFileName(...names) {
    const parts = names.map(fileNamePart).filter(Boolean);
    return parts.length ? parts.join('_') : 'animation';
}
function joinPath(dir, file) { return String(dir).replace(/\/+$/, '') + '/' + file; }
function xmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function homePath() {
    return String(app.userDesktopPath).replace(/\/+$/, '').replace(/\/Desktop$/, '');
}
function defaultFolder() {
    return joinPath(homePath(), 'Downloads/SVG Anim');
}

function isArtboardNode(node) {
    try { return node.isArtboardEnabled === true; } catch (_) { return false; }
}

/** Animated nodes under the given roots: [{node, data}] */
function collectAnimated(roots) {
    const out = [];
    for (const r of roots) {
        forEachNode(r, node => {
            const data = readNodeData(node).data;
            if (data) out.push({ node, data });
        });
    }
    return out;
}

function areaRoots(doc, area) {
    if (area.kind === 'artboard') return [area.node];
    if (area.kind === 'spread') return [doc.currentSpread];
    return Array.from(doc.spreads);
}

function exportArea(area) {
    if (area.kind === 'artboard') return FileExportArea.createForArtboard(area.node.artboardInterface);
    if (area.kind === 'spread') return FileExportArea.createForCurrentSpread();
    return null;
}

function svgPresetNames() {
    return FileExportOptions.allPresetNames.filter(n => /svg/i.test(n));
}

function isSpreadNode(node) {
    try { return node.isSpreadNode === true; } catch (_) { return false; }
}
/** Ancestors that hold only this chain, up to the first one with siblings (exclusive). */
function singleChildAncestors(node) {
    const out = [];
    for (let p = node.parent; p && !isSpreadNode(p) && !isArtboardNode(p) && childCount(p) === 1; p = p.parent) out.push(p);
    return out;
}

/** Nodes to tokenize: the animated items first (same indices), then marked children and carriers. */
function tokenEntries(items) {
    const entries = items.map(it => ({ node: it.node, item: it, exportName: it.exportName }));
    const entryOf = node => {
        let e = entries.find(en => en.node.isSameNode(node));
        if (!e) { e = { node, exportName: userName(node) }; entries.push(e); }
        return e;
    };
    for (const it of items) {
        if (!it.data.tracks.some(usesChildTargets)) continue;
        it.layered = true;
        const kids = childNodes(it.node);
        kids.forEach((kid, i) => { entryOf(kid).layer = kids.length - 1 - i; }); // 0 = top of the Layers panel
    }
    for (const it of items) for (const p of singleChildAncestors(it.node)) entryOf(p);
    return entries;
}

function runExportWithTokens(doc, items, path, presetName, area) {
    const builder = CompoundCommandBuilder.create();
    items.forEach((it, i) => {
        it.token = TOKEN_PREFIX + i + 'x';
        it.originalName = userName(it.node);
        builder.addCommand(DocumentCommand.createSetDescription(Selection.create(doc, [it.node]), it.token));
    });
    doc.executeCommand(builder.createCommand(), false);
    let records = null;
    try {
        // Synced instances share their name: only the last token written survives.
        for (const it of items) it.alias = userName(it.node) !== it.token ? userName(it.node) : null;
        records = doc.export(path, FileExportOptions.createWithPresetName(presetName), exportArea(area), null);
    } finally {
        doc.undo();
    }
    const restored = items.every(it => userName(it.node) === it.originalName);
    let error = null;
    if (records) {
        records.enumerate(rec => {
            const msg = rec.errorMessage;
            if (msg) error = msg;
            return 0;
        });
    }
    return { restored, error };
}

function jsonAttr(value) {
    return "'" + JSON.stringify(value).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + "'";
}

/**
 * Rewrites token ids into real ids + data-svganim / data-svganim-c.
 * Returns {svg, found:Set of entry index, merged:Set of entry index}; merged entries
 * lost their own element and play on the nearest single-child ancestor's element.
 */
function injectData(svg, items) {
    const used = new Set();
    svg.replace(/\sid="([^"]*)"/g, (m, id) => { used.add(id); return m; });
    const uniqueId = (name) => {
        let base = String(name).trim().replace(/[^\p{L}\p{N}_\-.]+/gu, '-').replace(/^-+|-+$/g, '');
        if (!base) return null;
        if (!/^[\p{L}_]/u.test(base)) base = '_' + base;
        let id = base, k = 1;
        while (used.has(id)) id = base + (k++);
        used.add(id);
        return id;
    };
    const byToken = new Map(items.map((it, i) => [it.token, i]));
    const present = new Set();
    svg.replace(new RegExp('\\sid="' + TOKEN_PREFIX + '(\\d+)x\\d*"', 'g'), (m, idx) => { present.add(Number(idx)); return m; });
    // Animated entries without an element of their own ride on a merged ancestor.
    const riders = new Map(), merged = new Set();
    items.forEach((it, i) => {
        if (!it.item || present.has(i)) return;
        for (const p of singleChildAncestors(it.node)) {
            const k = items.findIndex(en => en.node.isSameNode(p));
            if (k >= 0 && present.has(k)) {
                if (!riders.has(k)) riders.set(k, []);
                riders.get(k).push(it.item);
                merged.add(i);
                break;
            }
        }
    });
    const found = new Set();
    const tagRe = new RegExp('<([A-Za-z][\\w:.-]*)(\\s[^>]*?\\bid="' + TOKEN_PREFIX + '(\\d+)x\\d*"[^>]*?)(/?)>', 'g');
    const out = svg.replace(tagRe, (m, tagName, attrs, idx, selfClose) => {
        const i = Number(idx);
        if (!byToken.has(TOKEN_PREFIX + i + 'x')) return m;
        const it = items[i];
        found.add(i);
        const a = attrs
            .replace(new RegExp('\\s(?:affinity|serif):id="' + TOKEN_PREFIX + '\\d+x\\d*"', 'g'), '')
            .replace(new RegExp('\\sid="' + TOKEN_PREFIX + '\\d+x\\d*"'), '');
        const name = it.exportName;
        const id = name ? uniqueId(name) : null;
        let extra = '';
        if (id) extra += ' id="' + xmlAttr(id) + '"';
        if (name && id !== name) extra += ' affinity:id="' + xmlAttr(name) + '"';
        const anim = (it.item ? [it.item] : []).concat(riders.get(i) || []);
        if (anim.length) {
            const payload = { v: DATA_VERSION, n: childCount(it.node) };
            if (anim.some(a => a.layered)) payload.c = 1;
            payload.tracks = [].concat(...anim.map(a => a.data.tracks));
            extra += ' data-svganim=' + jsonAttr(payload);
        }
        if (it.layer !== undefined) extra += ' data-svganim-c="' + it.layer + '"';
        return '<' + tagName + extra + a + selfClose + '>';
    });
    // Synced instances: tokens that never appeared but share a name with one that did.
    items.forEach((it, i) => { if (it.alias && byToken.has(it.alias) && found.has(byToken.get(it.alias))) found.add(i); });
    for (const i of merged) found.add(i);
    return { svg: out, found, merged };
}

// ------------------------------------------------------- artboard clipping
/** Artboards whose bounds clip the export; [] when the area has none (canvas only). */
function areaArtboards(doc, area) {
    if (area.kind === 'artboard') return [area.node];
    const spreads = area.kind === 'spread' ? [doc.currentSpread] : Array.from(doc.spreads);
    const perSpread = spreads.map(s => {
        const list = [];
        forEachNode(s, n => { if (isArtboardNode(n)) list.push(n); });
        return list;
    }).filter(list => list.length);
    // Spread coordinates of different spreads cannot be mapped into one SVG.
    return perSpread.length === 1 ? perSpread[0] : [];
}

function artboardBoxes(artboards) {
    return artboards.map(ab => ab.getSpreadBaseBox(false)).filter(b => b && b.width > 0 && b.height > 0);
}

/**
 * Clips everything to the artboard rectangles, so animated content that moves past
 * an artboard edge stays hidden. Affinity writes the union of the exported artboards
 * as the viewBox, so spread coordinates map linearly onto it (presets may scale).
 */
function clipToArtboards(svg, boxes) {
    if (!boxes.length) return svg;
    const open = /<svg\b[^>]*>/.exec(svg);
    const close = svg.lastIndexOf('</svg>');
    if (!open || close < 0) return svg;
    const vb = /\sviewBox="([^"]+)"/.exec(open[0]);
    const v = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [];
    if (v.length !== 4 || !v.every(Number.isFinite) || !(v[2] > 0 && v[3] > 0)) return svg;
    const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
    const x1 = Math.max(...boxes.map(b => b.x + b.width)), y1 = Math.max(...boxes.map(b => b.y + b.height));
    const sx = v[2] / (x1 - x0), sy = v[3] / (y1 - y0);
    const id = 'svganim-artboards-' + Date.now().toString(36);
    const rects = boxes.map(b => '<rect x="' + round6(v[0] + (b.x - x0) * sx) + '" y="' + round6(v[1] + (b.y - y0) * sy) +
        '" width="' + round6(b.width * sx) + '" height="' + round6(b.height * sy) + '"/>').join('');
    const at = open.index + open[0].length;
    return svg.slice(0, at) + '\n<clipPath id="' + id + '">' + rects + '</clipPath>\n<g clip-path="url(#' + id + ')">' +
        svg.slice(at, close) + '</g>\n' + svg.slice(close);
}

function insertRuntime(svg, mode, url) {
    const at = svg.lastIndexOf('</svg>');
    if (at < 0) throw new Error('The exported file is not a valid SVG (no closing </svg> tag).');
    let tag;
    if (mode === 'embed') {
        if (RUNTIME_SOURCE.indexOf(']]>') >= 0) throw new Error('Runtime source cannot be embedded in CDATA.');
        tag = '<script type="text/javascript"><![CDATA[\n' + RUNTIME_SOURCE + '\n]]></script>\n';
    } else {
        tag = '<script type="text/javascript" href="' + xmlAttr(url) + '" xlink:href="' + xmlAttr(url) + '"></script>\n';
    }
    return svg.slice(0, at) + tag + svg.slice(at);
}

function htmlPreview(svg, title) {
    const body = svg.replace(/^\s*<\?xml[^>]*\?>\s*/, '').replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '');
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<title>' + xmlAttr(title) + '</title>\n<style>html,body{margin:0;height:100%;background:#f3f3f3}body>svg{display:block;width:100%;height:100%}</style>\n' +
        '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

function writeText(path, text) {
    const f = File.create(path, 'wb');
    try { f.writeString(text); } finally { f.close(); }
}
function readText(path) {
    return File.readAll(path).toString();
}
function isRelativeUrl(url) {
    return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/');
}

// ------------------------------------------------------------------- panel
function buildExportContext(doc) {
    const presets = svgPresetNames();
    if (!presets.length) throw new Error('No SVG export presets were found.');
    const docName = stripExtension(doc.title || 'animation');
    const areas = [
        { kind: 'document', label: 'Whole document', fileBase: safeFileName(docName) },
        { kind: 'spread', label: 'Current spread', fileBase: safeFileName(docName) }
    ];
    const artboards = [];
    if (doc.currentSpread) forEachNode(doc.currentSpread, node => { if (isArtboardNode(node)) artboards.push(node); });
    for (const ab of artboards) {
        const name = displayName(ab) || 'Artboard';
        areas.push({ kind: 'artboard', node: ab, label: 'Artboard: ' + name, fileBase: safeFileName(docName, name) });
    }
    // Default to the artboard containing the selection, if any.
    let defaultArea = 0;
    if (doc.selection.length && artboards.length) {
        for (let p = doc.selection.at(0).node; p; p = p.parent) {
            const k = artboards.findIndex(ab => ab.isSameNode(p));
            if (k >= 0) { defaultArea = 2 + k; break; }
        }
    }
    return { areas, presets, folder: defaultFolder(), defaultArea, countCache: new Map() };
}

function buildExportPanel(left, right, ctx) {
    const c = {};
    const groups = [];
    const out = left.addGroup('Output'); groups.push(out);
    c.area = out.addComboBox('Export', ctx.areas.map(a => a.label), ctx.defaultArea);
    c.preset = out.addComboBox('SVG preset', ctx.presets, 0);
    c.folder = out.addTextBox('Folder', ctx.folder);
    c.file = out.addTextBox('File name (blank = automatic)', '');
    c.html = out.addSwitch('Also write an HTML preview page', true);
    c.clip = out.addSwitch('Clip to artboard bounds', true);
    c.fileHint = out.addStaticText(null, '').setIsFullWidth();
    // Export may be the initial mode (no selection). Reserve the same tall
    // dialog budget before the user switches to Animate.
    c.layoutSpace = out.addStaticText(null, '').setIsFullWidth();
    reserveRows(c.layoutSpace, 10);

    const rt = right.addGroup('Player'); groups.push(rt);
    c.runtime = rt.addButtonSet('Player', RUNTIME_LABELS, 0);
    c.url = rt.addTextBox('Script URL', RUNTIME_CDN_URL);
    c.rtHint = rt.addStaticText(null, '').setIsFullWidth();

    const sum = right.addGroup('Content'); groups.push(sum);
    c.summary = sum.addStaticText(null, '').setIsFullWidth();
    return { c, groups };
}

function readExportOptions(c, ctx) {
    const area = ctx.areas[c.area.selectedIndex] || ctx.areas[0];
    const fileText = String(c.file.text || '').trim();
    return {
        area,
        preset: ctx.presets[c.preset.selectedIndex] || ctx.presets[0],
        folder: String(c.folder.text || '').trim() || ctx.folder,
        baseName: fileText ? safeFileName(stripExtension(fileText)) : area.fileBase,
        runtime: RUNTIME_MODES[c.runtime.selectedIndex] || 'embed',
        url: String(c.url.text || '').trim() || RUNTIME_CDN_URL,
        html: !!c.html.value,
        clip: !!c.clip.value
    };
}

function artboardCount(doc, ctx, area) {
    const key = 'artboards:' + area.label;
    if (!ctx.countCache.has(key)) ctx.countCache.set(key, areaArtboards(doc, area).length);
    return ctx.countCache.get(key);
}

function animatedCount(doc, ctx, area) {
    if (!ctx.countCache.has(area.label)) ctx.countCache.set(area.label, collectAnimated(areaRoots(doc, area)).length);
    return ctx.countCache.get(area.label);
}

function svgPathOf(o) { return joinPath(o.folder, o.baseName + '.svg'); }

function updateExportControls(doc, c, ctx) {
    const o = readExportOptions(c, ctx);
    setVisible(c.url, o.runtime === 'link');
    c.rtHint.text = o.runtime === 'embed'
        ? 'The player (about ' + Math.round(RUNTIME_SOURCE.length / 1024) + ' KB) is embedded in the SVG, so it plays offline as a single file.'
        : 'The SVG loads the player from this URL (needs internet; cached across SVGs). A file name without a folder also writes the player next to the SVG.';
    const boards = artboardCount(doc, ctx, o.area);
    c.clip.isEnabled = boards > 0;
    c.fileHint.text = 'Writes ' + svgPathOf(o) + (o.html ? ' and .html' : '') + '. ' + (boards
        ? (o.clip ? 'Animation outside the artboard' + (boards > 1 ? 's' : '') + ' is hidden.' : 'Animation may show outside the artboards.')
        : 'No artboards: the whole canvas is exported without clipping.');
    const n = animatedCount(doc, ctx, o.area);
    c.summary.text = n
        ? n + ' animated element(s) in this area.'
        : 'No animated elements in this area yet. Add animations in Animate mode.';
}

function exportAnimated(doc, o) {
    const items = collectAnimated(areaRoots(doc, o.area));
    if (!items.length) throw new Error('No animated elements found in the chosen area.');
    for (const it of items) it.exportName = exportName(it.node, it.data);
    const entries = tokenEntries(items);
    const denied = () => new Error('Affinity does not allow scripts to write to "' + o.folder + '". Allow this folder in Affinity\'s Scripting settings, or choose a folder on the Desktop.');
    try { fsApi.createDirectories(o.folder); } catch (e) {
        if (/PERMISSION/i.test(compactError(e))) throw denied();
        throw new Error('Cannot create folder "' + o.folder + '": ' + compactError(e));
    }
    const svgPath = svgPathOf(o);
    let res;
    try {
        res = runExportWithTokens(doc, entries, svgPath, o.preset, o.area);
    } catch (e) {
        if (/PERMISSION/i.test(compactError(e))) throw denied();
        throw e;
    }
    if (res.error) throw new Error('Affinity export failed: ' + res.error);
    const injected = injectData(readText(svgPath), entries);
    const clipped = o.clip === false ? injected.svg : clipToArtboards(injected.svg, artboardBoxes(areaArtboards(doc, o.area)));
    const finalSvg = insertRuntime(clipped, o.runtime, o.url);
    writeText(svgPath, finalSvg);
    const written = [svgPath];
    if (o.runtime === 'link' && isRelativeUrl(o.url) && !o.url.includes('/')) {
        const p = joinPath(o.folder, o.url);
        writeText(p, RUNTIME_SOURCE + '\n');
        written.push(p);
    }
    if (o.html) {
        const p = joinPath(o.folder, o.baseName + '.html');
        writeText(p, htmlPreview(finalSvg, o.baseName));
        written.push(p);
    }
    const label = it => it.exportName || displayName(it.node);
    const missing = items.filter((_, i) => !injected.found.has(i)).map(label);
    const merged = items.filter((_, i) => injected.merged.has(i)).map(label);
    return { items, written, missing, merged, restored: res.restored };
}

function exportReport(r) {
    const lines = ['Exported ' + (r.items.length - r.missing.length) + ' animated element(s).'];
    // All files go to one folder: show it once, then the file names.
    const dirOf = p => String(p).replace(/\/[^\/]*$/, '');
    const folders = Array.from(new Set(r.written.map(dirOf)));
    if (folders.length === 1) {
        lines.push('', 'Location:', folders[0], '', 'Files:', ...r.written.map(p => '- ' + String(p).slice(folders[0].length + 1)));
    } else if (r.written.length) {
        lines.push('', 'Files:', ...r.written.map(p => '- ' + p));
    }
    if (r.missing.length) {
        lines.push('', 'Not found in the SVG (hidden, outside the area, or merged by the preset):');
        lines.push(...r.missing.slice(0, 12).map(n => '• ' + n));
        if (r.missing.length > 12) lines.push('• … ' + (r.missing.length - 12) + ' more');
    }
    if (!r.restored) lines.push('', 'Warning: some layer names may not have been restored. Check the History panel.');
    return lines.join('\n');
}

// Reusable presets contain the panel's eight track slots, not document identities
// or SVG output settings. Null slots preserve the user's track numbering.
const CONFIG_FORMAT = 'svg-anim-preset';
const CONFIG_VERSION = 1;

function parseConfig(text) {
    let raw;
    try { raw = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (_) { throw new Error('The configuration file is not valid JSON.'); }
    if (!raw || Array.isArray(raw) || raw.format !== CONFIG_FORMAT) {
        throw new Error('Choose an SVG Anim preset JSON file.');
    }
    if (raw.schemaVersion !== CONFIG_VERSION) throw new Error('Unsupported configuration version: ' + raw.schemaVersion + '.');
    if (!Array.isArray(raw.tracks) || raw.tracks.length > MAX_TRACKS) throw new Error('A preset must contain at most ' + MAX_TRACKS + ' track slots.');
    const tracks = raw.tracks.map((track, i) => {
        if (track === null) return null;
        if (!track || Array.isArray(track) || typeof track !== 'object') throw new Error('Track ' + (i + 1) + ' is invalid.');
        const normalized = normalizeTrack(track);
        if (!normalized) throw new Error('Track ' + (i + 1) + ' has an unsupported type: ' + track.type + '.');
        // Missing fields receive defaults. Explicit invalid values must not be
        // silently clamped, dropped or replaced by a different enum value.
        const source = migrateTrack(track);
        for (const key of Object.keys(normalized)) {
            if (source[key] !== undefined && source[key] !== normalized[key]) {
                throw new Error('Track ' + (i + 1) + ': invalid ' + key + '.');
            }
        }
        return normalized;
    });
    const result = { tracks };
    if (raw.suffix !== undefined) {
        if (typeof raw.suffix !== 'string' || raw.suffix !== cleanSuffix(raw.suffix)) throw new Error('Invalid layer name suffix.');
        result.suffix = raw.suffix;
    }
    return result;
}

function configText(anim, suffix) {
    return JSON.stringify({
        format: CONFIG_FORMAT, schemaVersion: CONFIG_VERSION,
        createdWith: SCRIPT_NAME + ' v' + VERSION,
        tracks: anim.slots(), suffix: cleanSuffix(suffix)
    }, null, 2) + '\n';
}

function importConfigText(text, ui, anim) {
    const config = parseConfig(text); // Validate the entire file before touching the panel.
    anim.replace(config.tracks);
    if (config.suffix !== undefined) ui.animate.c.suffix.text = config.suffix;
    ui.mode.selectedIndex = MODES.indexOf('animate');
    // Loading a preset never starts an SVG export implicitly.
    ui.animate.c.exportAfter.value = false;
    return config;
}

function exportConfigFile(path, text) {
    path = String(path || '').trim();
    if (!path) return null;
    if (!/\.json$/i.test(path)) path += '.json';
    if (path.startsWith('~/')) path = homePath() + path.slice(1);
    if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw new Error('Enter a full path for the JSON file.');
    const parent = path.replace(/[\\/][^\\/]*$/, '');
    if (parent && !fsApi.exists(parent)) fsApi.createDirectory(parent);
    writeText(path, text);
    return path;
}

function attachConfig(ui, anim, ctx, refresh) {
    let busy = false;
    let lastPath = joinPath(ctx.folder, 'animation-preset.json');
    const setBusy = value => {
        busy = value;
        ui.config.importButton.isEnabled = !value;
        ui.config.exportButton.isEnabled = !value;
        ui.config.clearButton.isEnabled = !value;
    };
    const act = action => {
        if (busy) return;
        setBusy(true);
        try {
            // Use synchronous native dialogs: async callbacks are deferred while
            // the parent runModal() is running in the Affinity JS engine.
            if (action === 0) {
                const path = app.chooseFile();
                if (!path) return;
                const config = importConfigText(readText(String(path)), ui, anim);
                lastPath = String(path);
                refresh();
                const count = config.tracks.filter(Boolean).length;
                app.alert('Loaded ' + count + ' track(s). OK applies this preset to the selection; Cancel keeps the original animation.', SCRIPT_TITLE);
            } else {
                const text = configText(anim, String(ui.animate.c.suffix.text || ''));
                const path = app.prompt('Save animation preset as JSON (full file path):', SCRIPT_TITLE, lastPath);
                if (!path || !String(path).trim()) return;
                let output = String(path).trim();
                if (!/\.json$/i.test(output)) output += '.json';
                if (output.startsWith('~/')) output = homePath() + output.slice(1);
                if (fsApi.exists(output) && !app.confirm('Replace the existing file?\n' + output, SCRIPT_TITLE)) return;
                lastPath = exportConfigFile(output, text);
                app.alert('Saved animation preset:\n' + lastPath, SCRIPT_TITLE);
            }
        } catch (error) {
            app.alert(compactError(error) + '\nFor file access errors, choose a folder allowed in Affinity Scripting settings (for example, the Desktop).', SCRIPT_TITLE);
        } finally {
            setBusy(false);
        }
    };
    ui.config.importButton.onClickHandler = () => act(0);
    ui.config.exportButton.onClickHandler = () => act(1);
    const clear = () => {
        if (busy) return;
        anim.replace([]);
        ui.mode.selectedIndex = MODES.indexOf('animate');
        ui.animate.c.exportAfter.value = false;
        refresh();
    };
    ui.config.clearButton.onClickHandler = clear;
    return { clear };
}

// ---------------------------------------------------------------------------
// Dialog: mode switch on top, two shared columns, a line saying what OK does.
// ---------------------------------------------------------------------------

const MODES = ['animate', 'export'];
const MODE_LABELS = ['Animate', 'Export'];

function buildDialog(doc, state, ctx) {
    const dialog = Dialog.create(SCRIPT_TITLE);
    dialog.initialWidth = 760;
    const main = dialog.addColumn();
    const header = main.addGroup(null).addColumnStack();
    const modeGroup = header.addColumn().addGroup('Mode');
    const mode = modeGroup.addButtonSet(null, MODE_LABELS, state.items.length ? 0 : 1).setIsFullWidth();
    const configGroup = header.addColumn().addGroup('Config');
    const actions = configGroup.addColumnStack();
    const config = {
        actions,
        hint: configGroup.addStaticText(null, 'Only available in Animate mode').setIsFullWidth(),
        importButton: actions.addColumn().addGroup(null).setEnableSeparator(false).addButton('Import').setIsFullWidth(),
        exportButton: actions.addColumn().addGroup(null).setEnableSeparator(false).addButton('Export').setIsFullWidth(),
        clearButton: actions.addColumn().addGroup(null).setEnableSeparator(false).addButton('Clear').setIsFullWidth()
    };
    const stack = main.addGroup(null).addColumnStack();
    const left = stack.addColumn();
    const right = stack.addColumn();
    const animate = buildAnimatePanel(doc, left, right, state);
    const exporter = buildExportPanel(left, right, ctx);
    const okLine = main.addGroup(null).addStaticText(null, '').setIsFullWidth();
    return { dialog, mode, config, animate, exporter, okLine };
}

function currentMode(ui) { return MODES[ui.mode.selectedIndex] || 'animate'; }

function okText(doc, ui, state, ctx, peekTracks) {
    const o = readExportOptions(ui.exporter.c, ctx);
    const target = svgPathOf(o);
    if (currentMode(ui) === 'export') {
        const n = animatedCount(doc, ctx, o.area);
        return n ? 'OK exports ' + n + ' animated element(s) to ' + target + '.' : 'Nothing to export: OK closes the dialog.';
    }
    const n = state.items.length;
    if (!n) return 'Nothing is selected: OK closes the dialog.';
    const tracks = peekTracks();
    const what = tracks.length
        ? 'OK writes ' + tracks.length + ' track(s) to ' + n + ' element(s)'
        : 'OK removes the animation from ' + n + ' element(s)';
    return what + (ui.animate.c.exportAfter.value ? ', then exports to ' + target + '.' : '.');
}

function updateDialog(doc, ui, state, ctx, peekTracks) {
    const animateMode = currentMode(ui) === 'animate';
    setVisible(ui.config.actions, animateMode);
    for (const key of ['importButton', 'exportButton', 'clearButton']) setVisible(ui.config[key], animateMode);
    setVisible(ui.config.hint, !animateMode);
    for (const g of ui.animate.groups) setVisible(g, animateMode);
    for (const g of ui.exporter.groups) setVisible(g, !animateMode);
    updateExportControls(doc, ui.exporter.c, ctx);
    ui.okLine.text = okText(doc, ui, state, ctx, peekTracks);
}

/** Builds and wires the whole dialog (no runModal), so tests can drive it. */
function setupDialog(doc) {
    const state = loadSelectionState(selectedNodes(doc)); // also satisfies runModal's selection access
    const ctx = buildExportContext(doc);
    const ui = buildDialog(doc, state, ctx);
    const anim = attachAnimate(ui.animate, state);
    const refresh = () => updateDialog(doc, ui, state, ctx, anim.peek);
    const onChange = () => {
        if (currentMode(ui) === 'animate') anim.onChange();
        refresh();
    };
    refresh();
    ui.dialog.onControlValueChangedHandler = onChange;
    const config = attachConfig(ui, anim, ctx, refresh);
    ui.animate.c.moveLeft.onClickHandler = () => { anim.move(-1); refresh(); };
    ui.animate.c.moveRight.onClickHandler = () => { anim.move(1); refresh(); };
    return { state, ctx, ui, anim, config, onChange };
}

/** Carries out the OK action. Returns a message for the user, or null. */
function performOk(doc, s) {
    const { state, ctx, ui, anim } = s;
    if (currentMode(ui) === 'export') {
        const o = readExportOptions(ui.exporter.c, ctx);
        if (!animatedCount(doc, ctx, o.area)) return null;
        return exportReport(exportAnimated(doc, o));
    }
    if (!state.items.length) return null;
    const tracks = anim.collect();
    const suffix = cleanSuffix(String(ui.animate.c.suffix.text || ''));
    doc.executeCommand(buildApplyCommand(doc, state, tracks, suffix).command, false);
    if (!ui.animate.c.exportAfter.value) return null;
    return exportReport(exportAnimated(doc, readExportOptions(ui.exporter.c, ctx)));
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('Please open a document first.', SCRIPT_TITLE); return; }
    try {
        const s = setupDialog(doc);
        const result = s.ui.dialog.runModal();
        if ((result?.value ?? result) !== DialogResult.Ok.value) return;
        const message = performOk(doc, s);
        if (message) app.alert(message, SCRIPT_TITLE);
    } catch (error) {
        app.alert(compactError(error), SCRIPT_TITLE);
    }
}

main();
