/**
 * name: SVG Anim
 * version: 0.4.1
 * description: Animate elements and export them as an animated SVG, in one dialog. Animate mode: up to eight tracks per element (Fade, Move, Rotate, Scale, Skew, Draw stroke, Count number, Clock, Frames) with duration, delay, stagger, easing, direction, repeats and start trigger (load, visible, click, hover), stored in the element metadata and shown again when reselected; animated layers get a name suffix (default __anim). JSON preset import/export reuses the complete track setup; Clear removes all tracks on OK, and arrow buttons reorder tracks. Export mode: the document, current spread or an artboard as SVG with the animation data and an embedded or linked (jsDelivr) player, plus an optional HTML preview page.
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
const VERSION = '0.4.1';
const SCRIPT_TITLE = SCRIPT_NAME + ' v' + VERSION;
const RUNTIME_CDN_URL = "https://cdn.jsdelivr.net/gh/WaveF/affinity-svg-anim@v0.4.1/dist/svg-anim-runtime.min.js";
const RUNTIME_SOURCE = "/*! SVG Anim runtime v0.4.1 | MIT License | (c) WaveF | https://github.com/WaveF/affinity-svg-anim */(function(){\"use strict\";var gt=\"http://www.w3.org/2000/svg\",O=document.currentScript,b=O&&(O.ownerSVGElement||O.closest&&O.closest(\"svg\"))||document.documentElement;if(!b||b.__svgAnim)return;var K=/^(defs|clipPath|mask|title|desc|metadata|style|script|linearGradient|radialGradient|pattern|filter|marker|symbol)$/,Mt=/^(path|line|polyline|polygon|circle|ellipse|rect)$/,S=1.70158,N=S*1.525,Q=S+1;function A(t){var e=7.5625,r=2.75;return t<1/r?e*t*t:t<2/r?e*(t-=1.5/r)*t+.75:t<2.5/r?e*(t-=2.25/r)*t+.9375:e*(t-=2.625/r)*t+.984375}var U={linear:function(t){return t},sineIn:function(t){return 1-Math.cos(t*Math.PI/2)},sineOut:function(t){return Math.sin(t*Math.PI/2)},sineInOut:function(t){return-(Math.cos(Math.PI*t)-1)/2},quadIn:function(t){return t*t},quadOut:function(t){return 1-(1-t)*(1-t)},quadInOut:function(t){return t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2},in:function(t){return t*t*t},out:function(t){return 1-Math.pow(1-t,3)},inOut:function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2},quartIn:function(t){return t*t*t*t},quartOut:function(t){return 1-Math.pow(1-t,4)},quartInOut:function(t){return t<.5?8*t*t*t*t:1-Math.pow(-2*t+2,4)/2},quintIn:function(t){return t*t*t*t*t},quintOut:function(t){return 1-Math.pow(1-t,5)},quintInOut:function(t){return t<.5?16*t*t*t*t*t:1-Math.pow(-2*t+2,5)/2},expoIn:function(t){return t<=0||t>=1?t<=0?0:1:Math.pow(2,10*t-10)},expoOut:function(t){return t<=0||t>=1?t<=0?0:1:1-Math.pow(2,-10*t)},expoInOut:function(t){return t<=0||t>=1?t<=0?0:1:t<.5?Math.pow(2,20*t-10)/2:(2-Math.pow(2,-20*t+10))/2},circIn:function(t){return 1-Math.sqrt(1-t*t)},circOut:function(t){return Math.sqrt(1-Math.pow(t-1,2))},circInOut:function(t){return t<.5?(1-Math.sqrt(1-Math.pow(2*t,2)))/2:(Math.sqrt(1-Math.pow(-2*t+2,2))+1)/2},backIn:function(t){return Q*t*t*t-S*t*t},backOut:function(t){return 1+Q*Math.pow(t-1,3)+S*Math.pow(t-1,2)},backInOut:function(t){return t<.5?Math.pow(2*t,2)*((N+1)*2*t-N)/2:(Math.pow(2*t-2,2)*((N+1)*(t*2-2)+N)+2)/2},elasticIn:function(t){return t<=0||t>=1?t<=0?0:1:-Math.pow(2,10*t-10)*Math.sin((t*10-10.75)*(2*Math.PI)/3)},elasticOut:function(t){return t<=0||t>=1?t<=0?0:1:Math.pow(2,-10*t)*Math.sin((t*10-.75)*(2*Math.PI)/3)+1},elasticInOut:function(t){if(t<=0||t>=1)return t<=0?0:1;var e=Math.sin((20*t-11.125)*(2*Math.PI)/4.5);return t<.5?-Math.pow(2,20*t-10)*e/2:Math.pow(2,-20*t+10)*e/2+1},bounceIn:function(t){return 1-A(1-t)},bounceOut:A,bounceInOut:function(t){return t<.5?(1-A(1-2*t))/2:(1+A(2*t-1))/2}};function l(t,e){return t=Number(t),isFinite(t)?t:e}function E(t){return t<0?0:t>1?1:t}function C(t,e){var r=t*374761393+e*668265263|0;return r=Math.imul(r^r>>>13,1274126177),((r^r>>>16)>>>0)/4294967296}function Z(t){for(var e=[],r=t.firstElementChild;r;r=r.nextElementSibling)K.test(r.localName)||e.push(r);return e}function yt(t,e){for(var r=Z(t),n=0;r.length===1&&r[0].localName===\"g\"&&r.length!==e&&!r[0].hasAttribute(\"data-svganim\")&&n++<8;)r=Z(r[0]);return r}function bt(t){var e=[];Mt.test(t.localName)&&e.push(t);for(var r=t.querySelectorAll(\"path,line,polyline,polygon,circle,ellipse,rect\"),n=0;n<r.length;n++){for(var a=r[n].parentNode,i=!1;a&&a!==t;a=a.parentNode)if(K.test(a.localName)){i=!0;break}i||e.push(r[n])}return e}function wt(t){var e=[];return(function r(n){if((n.localName===\"text\"||n.localName===\"tspan\")&&!n.firstElementChild){e.push(n);return}for(var a=n.firstElementChild;a;a=a.nextElementSibling)r(a)})(t),e}function B(t,e){var r=t.getAttribute(e);r&&/[\\s,]/.test(r.trim())&&t.setAttribute(e,r.trim().split(/[\\s,]+/)[0])}function j(t){for(var e=wt(t),r=null,n=0;n<e.length;n++)if(e[n].textContent.trim()){r=e[n];break}if(r=r||e[0]||null,!r)return{get:function(){return\"\"},set:function(){}};for(var a=0;a<e.length;a++)e[a]!==r&&(e[a].textContent=\"\");B(r,\"x\"),B(r,\"y\"),r.removeAttribute(\"dx\"),r.removeAttribute(\"textLength\");for(var i=r.parentNode;i&&i.localName===\"tspan\";i=i.parentNode)B(i,\"x\"),i.removeAttribute(\"textLength\");var s=r.textContent;return{get:function(){return s},set:function(o){r.textContent!==o&&(r.textContent=o)}}}function tt(t){var e=String(t),r=e.indexOf(\".\");return r<0?0:e.length-r-1}function kt(t){var e=String(t).replace(/,/g,\"\").match(/-?\\d+(\\.\\d+)?/);return e?{value:Number(e[0]),decimals:e[1]?e[1].length-1:0}:null}function xt(t,e,r,n){var a=t<0&&Math.abs(t)>=Math.pow(10,-e)/2,i=Math.abs(t).toFixed(e),s=i.split(\".\"),o=s[0];return r>o.length&&(o=new Array(r-o.length+1).join(\"0\")+o),n&&(o=o.replace(/\\B(?=(\\d{3})+(?!\\d))/g,\",\")),(a?\"-\":\"\")+o+(s[1]?\".\"+s[1]:\"\")}function g(t){return t<10?\"0\"+t:String(t)}function It(t,e){var r=e.getHours();return t.replace(/YYYY|MM|DD|HH|hh|mm|ss|A/g,function(n){switch(n){case\"YYYY\":return String(e.getFullYear());case\"MM\":return g(e.getMonth()+1);case\"DD\":return g(e.getDate());case\"HH\":return g(r);case\"hh\":return g(r%12||12);case\"mm\":return g(e.getMinutes());case\"ss\":return g(e.getSeconds());case\"A\":return r<12?\"AM\":\"PM\"}return n})}var L=[];function Ot(t){if(t.__svgAnimSlot)return t.__svgAnimSlot;var e=document.createElementNS(gt,\"g\");e.setAttribute(\"class\",\"svganim-wrap\"),t.parentNode.insertBefore(e,t),e.appendChild(t);var r={x:0,y:0,width:0,height:0};try{r=e.getBBox()}catch(m){}var n=1,a=0,i=0,s=1;try{var o=b.getScreenCTM().inverse().multiply(e.parentNode.getScreenCTM());n=o.a,a=o.b,i=o.c,s=o.d}catch(m){}var h=n*s-a*i;Math.abs(h)<1e-12&&(n=1,a=0,i=0,s=1,h=1);var f={g:e,bbox:r,inv:[s/h,-a/h,-i/h,n/h],flip:h<0?-1:1,moves:[],rotates:[],scales:[],skews:[],opacity:1,dirty:!1};return t.__svgAnimSlot=f,L.push(f),f}var et={tl:[0,0],tc:[.5,0],tr:[1,0],cl:[0,.5],c:[.5,.5],cr:[1,.5],bl:[0,1],bc:[.5,1],br:[1,1]};function V(t,e){var r=et[e]||et.c,n=t.bbox;return[n.x+n.width*r[0],n.y+n.height*r[1]]}function u(t){return Math.round(t*1e4)/1e4}function St(t){var e=t.moves.concat(t.rotates,t.scales,t.skews);e.length?t.g.setAttribute(\"transform\",e.join(\" \")):t.dirty&&t.g.removeAttribute(\"transform\"),t.opacity!==1?t.g.style.opacity=String(u(t.opacity)):t.dirty&&(t.g.style.opacity=\"\"),t.dirty=e.length>0||t.opacity!==1,t.moves.length=0,t.rotates.length=0,t.scales.length=0,t.skews.length=0,t.opacity=1}var Nt={normal:1,reverse:1,alternate:1,alternateReverse:1};function rt(t){return t.type===\"frames\"||t.target===\"children\"&&t.type!==\"count\"&&t.type!==\"clock\"}function w(t,e,r){this.el=t,this.spec=e,this.type=e.type,this.dur=Math.max(.001,l(e.dur,1)),this.delay=Math.max(0,l(e.delay,0)),this.loops=Math.max(0,Math.floor(l(e.loops,0))),this.loopDelay=Math.max(0,l(e.loopDelay,0)),this.dir=Nt[e.dir]?e.dir:\"normal\",this.ease=U[e.ease]||U.inOut,this.time=0,this.rate=0,this.targets=r;for(var n=r.length,a=rt(e)&&this.type!==\"frames\"?Math.max(0,l(e.stagger,0)):0,i=[],s=0;s<n;s++)i.push(s);for(i.sort(function(P,Y){return C(P,7)-C(Y,7)}),this.offsets=[],s=0;s<n;s++){var o=e.order===\"reverse\"?n-1-s:e.order===\"center\"?Math.abs(s-(n-1)/2):e.order===\"random\"?i.indexOf(s):s;this.offsets.push(o*a)}for(var h=0,f=0;f<n;f++)h=Math.max(h,this.offsets[f]);var m=this.dur+this.loopDelay;this.end=this.loops>0?this.delay+h+this.loops*m-this.loopDelay:1/0,this.period=this.dir===\"alternate\"||this.dir===\"alternateReverse\"?2*m:m,this.setup()}w.prototype.setup=function(){var t=this,e=this.spec;switch(this.type){case\"fade\":case\"move\":case\"rotate\":case\"scale\":case\"skew\":this.slots=this.targets.map(Ot);break;case\"draw\":this.paths=this.targets.map(function(o){return bt(o).map(function(h){var f=0;try{f=h.getTotalLength()}catch(m){}return{el:h,len:f}})});break;case\"count\":this.text=j(this.el);var r=kt(this.text.get())||{value:0,decimals:0},n=e.start!==null&&e.start!==void 0&&e.start!==\"\"&&isFinite(Number(e.start));this.from=n?Number(e.start):r.value,this.to=l(e.end,0);var a=Math.max(n?tt(e.start):r.decimals,tt(this.to));this.dec=e.decimals===null||e.decimals===void 0||e.decimals<0?a:Math.floor(e.decimals),this.padWidth=e.pad?String(Math.floor(Math.max(Math.abs(this.from),Math.abs(this.to)))).length:0,this.seed=Math.floor(Math.random()*1e5);break;case\"clock\":this.text=j(this.el);break;case\"frames\":this.frameIndex=-1;break}var i=e.trigger;if(this.type===\"clock\"&&(i=\"load\"),i===\"click\")this.el.style.cursor=\"pointer\",this.el.addEventListener(\"click\",function(){t.time=0,t.rate=1,p()});else if(i===\"hover\")this.el.addEventListener(\"mouseenter\",function(){t.rate=1,p()}),this.el.addEventListener(\"mouseleave\",function(){t.end===1/0&&t.time>t.delay+t.period&&(t.time=t.delay+(t.time-t.delay)%t.period),t.rate=-1,p()});else if(i===\"view\"&&typeof IntersectionObserver==\"function\"){var s=new IntersectionObserver(function(o){for(var h=0;h<o.length;h++)if(o[h].isIntersecting){t.rate=1,s.disconnect(),p();break}},{threshold:.2});s.observe(this.el)}else this.rate=1,this.autoStart=!0},w.prototype.advance=function(t){return this.rate?(this.time+=t*this.rate,this.time<=0&&this.rate<0?(this.time=0,this.rate=0):this.time>=this.end&&this.rate>0&&(this.time=this.end,this.rate=0),this.rate!==0):!1},w.prototype.progress=function(t){var e=this.time-this.delay-this.offsets[t],r=this.dur+this.loopDelay,n=0,a=0;if(e>0){n=Math.floor(e/r);var i=e-n*r;this.loops>0&&n>=this.loops?(n=this.loops-1,a=1):a=E(i/this.dur)}var s=this.dir===\"reverse\"||this.dir===\"alternate\"&&n%2===1||this.dir===\"alternateReverse\"&&n%2===0;return s&&(a=1-a),{p:a,k:n,e:this.type===\"frames\"?a:this.ease(a)}},w.prototype.apply=function(){var t=this.spec,e=this.targets.length,r,n,a;switch(this.type){case\"fade\":for(r=0;r<e;r++){n=this.progress(r);var i=l(t.from,100)/100,s=l(t.to,0)/100;this.slots[r].opacity*=Math.max(0,Math.min(1,i+(s-i)*n.e))}break;case\"move\":for(r=0;r<e;r++){n=this.progress(r),a=this.slots[r];var o=l(t.x,0)*n.e,h=l(t.y,0)*n.e,f=a.inv,m=f[0]*o+f[2]*h,P=f[1]*o+f[3]*h;(m||P)&&a.moves.push(\"translate(\"+u(m)+\" \"+u(P)+\")\")}break;case\"rotate\":for(r=0;r<e;r++){n=this.progress(r),a=this.slots[r];var Y=l(t.angle,360)*n.e*a.flip,ot=V(a,t.pivot);Y&&a.rotates.push(\"rotate(\"+u(Y)+\" \"+u(ot[0])+\" \"+u(ot[1])+\")\")}break;case\"scale\":for(r=0;r<e;r++){n=this.progress(r),a=this.slots[r];var ut=1+(l(t.sx,100)/100-1)*n.e,ht=1+(l(t.sy,100)/100-1)*n.e,_=V(a,t.pivot);(ut!==1||ht!==1)&&a.scales.push(\"translate(\"+u(_[0])+\" \"+u(_[1])+\") scale(\"+u(ut)+\" \"+u(ht)+\") translate(\"+u(-_[0])+\" \"+u(-_[1])+\")\")}break;case\"skew\":for(r=0;r<e;r++){n=this.progress(r),a=this.slots[r];var lt=l(t.ax,20)*n.e,ft=l(t.ay,0)*n.e,T=V(a,t.pivot);(lt||ft)&&a.skews.push(\"translate(\"+u(T[0])+\" \"+u(T[1])+\") skewX(\"+u(lt)+\") skewY(\"+u(ft)+\") translate(\"+u(-T[0])+\" \"+u(-T[1])+\")\")}break;case\"draw\":var ct=Math.max(.001,Math.min(1,l(t.seg,20)/100));for(r=0;r<e;r++){var y=this.progress(r).e,c,v;switch(t.mode){case\"erase\":c=y,v=1;break;case\"revealErase\":y<.5?(c=0,v=2*y):(c=2*y-1,v=1);break;case\"travel\":v=(1+ct)*y,c=v-ct;break;default:c=0,v=y}c=E(c),v=E(v);for(var vt=this.paths[r],X=0;X<vt.length;X++){var mt=vt[X],H=mt.len,R=mt.el.style;if(H>0){if(v-c<1e-4){R.visibility=\"hidden\";continue}R.visibility=\"\",R.strokeDasharray=u((v-c)*H)+\" \"+u(H+1),R.strokeDashoffset=String(u(-c*H))}}}break;case\"count\":n=this.progress(0);var F;if(t.random){var G=Math.min(this.from,this.to),dt=Math.max(this.from,this.to),pt=n.k===0?this.from:G+(dt-G)*C(this.seed,n.k-1),At=G+(dt-G)*C(this.seed,n.k);F=pt+(At-pt)*this.ease(E((this.time-this.delay-n.k*(this.dur+this.loopDelay))/this.dur)),this.time<=this.delay&&(F=this.from)}else F=this.from+(this.to-this.from)*n.e;this.text.set(xt(F,this.dec,this.padWidth,!!t.group));break;case\"frames\":n=this.progress(0);var z=Math.min(e-1,Math.floor(n.p*e));if(z!==this.frameIndex){for(r=0;r<e;r++)this.targets[r].style.visibility=r===z?\"\":\"hidden\";this.frameIndex=z}break}};for(var d=[],k=[],$=b.querySelectorAll(\"[data-svganim]\"),nt=[],D=0;D<$.length;D++){var x;try{x=JSON.parse($[D].getAttribute(\"data-svganim\"))}catch(t){continue}!x||!x.tracks||!x.tracks.length||nt.push({el:$[D],data:x})}var at=[];nt.forEach(function(t){t.data.tracks.forEach(function(e){!e||!e.type||e.type===\"none\"||at.push({el:t.el,spec:e,targets:rt(e)?yt(t.el,l(t.data.n,-1)):[t.el]})})}),at.forEach(function(t){try{var e=new w(t.el,t.spec,t.targets);e.type===\"clock\"?k.push(e):d.push(e)}catch(r){window.console&&console.warn(\"[svganim] skipped track\",t.spec,r)}});var it=window.requestAnimationFrame||function(t){return setTimeout(function(){t(Date.now())},16)},J=!1,I=null,M=!1;function q(){for(var t=0;t<d.length;t++)d[t].apply();for(var e=0;e<L.length;e++)St(L[e])}function st(t){var e=I===null?0:Math.min(.25,(t-I)/1e3);I=t;var r=!1;if(!M)for(var n=0;n<d.length;n++)d[n].advance(e)&&(r=!0);q(),r&&!M?it(st):(J=!1,I=null)}function p(){J||M||(J=!0,I=null,it(st))}function W(){for(var t=new Date,e=0;e<k.length;e++)k[e].text.set(It(String(k[e].spec.format||\"HH:mm:ss\"),t))}k.length&&(W(),setTimeout(function(){W(),setInterval(W,1e3)},1e3-Date.now()%1e3+5)),q(),p(),b.__svgAnim={version:\"0.4.1\",players:d,play:function(){M=!1,p()},pause:function(){M=!0},restart:function(){M=!1,d.forEach(function(t){t.time=0,t.rate=t.autoStart?1:0}),q(),p()},seek:function(t){d.forEach(function(e){e.time=Math.max(0,Math.min(t,e.end))}),q()}}})();";

// ---------------------------------------------------------------------------
// SVG Anim core: data model, validation, node helpers.
// ---------------------------------------------------------------------------
// Animation data lives in the node's tag dictionary under TAG_KEY as JSON:
//   {"v":1,"tracks":[{ "type":"move", "x":0, "y":-20, "dur":1, ... }],"suffix":"__anim","auto":true}
// "suffix" is the text this script appended to the layer name ("" = none),
// "auto" marks a layer that had no name of its own before the suffix was added.
// Exported SVG elements carry {"v":1,"n":<child count>,"tracks":[…]} in data-svganim.

const TAG_KEY = 'svganim';
const DATA_VERSION = 1;
const MAX_TRACKS = 8;
const DEFAULT_SUFFIX = '__anim';
const MAX_SUFFIX_LENGTH = 32;

const TYPES = ['none', 'fade', 'move', 'rotate', 'scale', 'skew', 'draw', 'count', 'clock', 'frames'];
const TYPE_LABELS = ['None', 'Fade', 'Move', 'Rotate', 'Scale', 'Skew', 'Draw stroke', 'Count number', 'Clock', 'Frames'];
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
const ORDERS = ['forward', 'reverse', 'center', 'random'];
const ORDER_LABELS = ['First to last', 'Last to first', 'From centre', 'Random'];
const TRIGGERS = ['load', 'view', 'click', 'hover'];
const TRIGGER_LABELS = ['On load', 'When visible', 'On click', 'On hover'];
const DRAW_MODES = ['reveal', 'revealErase', 'erase', 'travel'];
const DRAW_LABELS = ['Reveal', 'Reveal then erase', 'Erase', 'Travel'];
const PIVOTS = ['tl', 'tc', 'tr', 'cl', 'c', 'cr', 'bl', 'bc', 'br'];
const DECIMAL_LABELS = ['Auto', '0', '1', '2', '3', '4'];

const COMMON_DEFAULTS = {
    target: 'self', dur: 1, delay: 0, stagger: 0.1, order: 'forward',
    ease: 'inOut', dir: 'alternate', loops: 0, loopDelay: 0, trigger: 'load'
};
// Fields per type; '$' = timing preset applied when a track is first given this type.
const TYPE_DEFAULTS = {
    fade: { from: 100, to: 0 },
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
    c.framesHint = fx.addStaticText(null, 'Shows one child at a time, top child last. Duration is one pass through all children.').setIsFullWidth();
    c.typeHint = fx.addStaticText(null, 'Choose a type to animate this track. Set every track to None to remove the animation.').setIsFullWidth();

    c.effectSpace = fx.addStaticText(null, '').setIsFullWidth();

    const timing = right.addGroup('Timing'); groups.push(timing);
    c.timingHint = timing.addStaticText(null, 'Please set a Track Effect first.').setIsFullWidth();
    c.dur = num(timing, 'Duration (s)', 1, 0.01, null, 2);
    c.delay = num(timing, 'Delay (s)', 0, 0, null, 2);
    c.stagger = num(timing, 'Stagger per child (s)', 0.1, 0, null, 2);
    c.order = timing.addComboBox('Stagger order', ORDER_LABELS, 0);
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
        order: ORDERS[c.order.selectedIndex], ease: EASES[c.ease.selectedIndex], dir: DIRS[c.dir.selectedIndex],
        loops: c.loops.value, loopDelay: c.loopDelay.value, trigger: TRIGGERS[c.trigger.selectedIndex],
        from: c.fadeFrom.value, to: c.fadeTo.value,
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
    c.type.selectedIndex = TYPES.indexOf(type);
    c.target.selectedIndex = TARGETS.indexOf(pre.target);
    c.dur.value = pre.dur; c.delay.value = pre.delay; c.stagger.value = pre.stagger;
    c.order.selectedIndex = ORDERS.indexOf(pre.order);
    c.ease.selectedIndex = EASES.indexOf(pre.ease);
    c.dir.selectedIndex = DIRS.indexOf(pre.dir);
    c.loops.value = pre.loops; c.loopDelay.value = pre.loopDelay;
    c.trigger.selectedIndex = TRIGGERS.indexOf(pre.trigger);
    c.fadeFrom.value = ofType('from', 100); c.fadeTo.value = ofType('to', 0);
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
const TIMING_CONTROLS = ['dur', 'delay', 'stagger', 'order', 'ease', 'dir', 'loops', 'loopDelay', 'trigger'];

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
// a data-svganim attribute.

const RUNTIME_FILE = 'svg-anim-runtime.min.js';
const RUNTIME_MODES = ['embed', 'link'];
const RUNTIME_LABELS = ['Embed', 'Link'];
const TOKEN_PREFIX = 'svganimtok';

function stripExtension(name) { return String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, ''); }
function safeFileName(name) {
    const s = String(name || '').replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
    return s || 'animation';
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

/** Rewrites token ids into real ids + data-svganim. Returns {svg, found:Set of item index}. */
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
        const payload = { v: DATA_VERSION, n: childCount(it.node), tracks: it.data.tracks };
        extra += " data-svganim='" + JSON.stringify(payload).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + "'";
        return '<' + tagName + extra + a + selfClose + '>';
    });
    // Synced instances: tokens that never appeared but share a name with one that did.
    items.forEach((it, i) => { if (it.alias && byToken.has(it.alias) && found.has(byToken.get(it.alias))) found.add(i); });
    return { svg: out, found };
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
        { kind: 'document', label: 'Whole document', fileBase: docName },
        { kind: 'spread', label: 'Current spread', fileBase: docName }
    ];
    const artboards = [];
    if (doc.currentSpread) forEachNode(doc.currentSpread, node => { if (isArtboardNode(node)) artboards.push(node); });
    for (const ab of artboards) {
        const name = displayName(ab) || 'Artboard';
        areas.push({ kind: 'artboard', node: ab, label: 'Artboard: ' + name, fileBase: docName + ' - ' + name });
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
    c.fileHint = out.addStaticText(null, '').setIsFullWidth();
    // Export may be the initial mode (no selection). Reserve the same tall
    // dialog budget before the user switches to Animate.
    c.layoutSpace = out.addStaticText(null, '').setIsFullWidth();
    reserveRows(c.layoutSpace, 11);

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
        baseName: safeFileName(stripExtension(fileText) || area.fileBase),
        runtime: RUNTIME_MODES[c.runtime.selectedIndex] || 'embed',
        url: String(c.url.text || '').trim() || RUNTIME_CDN_URL,
        html: !!c.html.value
    };
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
    c.fileHint.text = 'Writes ' + svgPathOf(o) + (o.html ? ' and .html' : '');
    const n = animatedCount(doc, ctx, o.area);
    c.summary.text = n
        ? n + ' animated element(s) in this area.'
        : 'No animated elements in this area yet. Add animations in Animate mode.';
}

function exportAnimated(doc, o) {
    const items = collectAnimated(areaRoots(doc, o.area));
    if (!items.length) throw new Error('No animated elements found in the chosen area.');
    for (const it of items) it.exportName = exportName(it.node, it.data);
    const denied = () => new Error('Affinity does not allow scripts to write to "' + o.folder + '". Allow this folder in Affinity\'s Scripting settings, or choose a folder on the Desktop.');
    try { fsApi.createDirectories(o.folder); } catch (e) {
        if (/PERMISSION/i.test(compactError(e))) throw denied();
        throw new Error('Cannot create folder "' + o.folder + '": ' + compactError(e));
    }
    const svgPath = svgPathOf(o);
    let res;
    try {
        res = runExportWithTokens(doc, items, svgPath, o.preset, o.area);
    } catch (e) {
        if (/PERMISSION/i.test(compactError(e))) throw denied();
        throw e;
    }
    if (res.error) throw new Error('Affinity export failed: ' + res.error);
    const injected = injectData(readText(svgPath), items);
    const finalSvg = insertRuntime(injected.svg, o.runtime, o.url);
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
    const missing = items.filter((_, i) => !injected.found.has(i)).map(it => it.exportName || displayName(it.node));
    return { items, written, missing, restored: res.restored };
}

function exportReport(r) {
    const lines = ['Exported ' + (r.items.length - r.missing.length) + ' animated element(s).', '', ...r.written];
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
        for (const key of Object.keys(normalized)) {
            if (track[key] !== undefined && track[key] !== normalized[key]) {
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
