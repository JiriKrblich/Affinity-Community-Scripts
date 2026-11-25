'use strict';
// Pure EAN-13 geometry. GS1 26.0, sections 5.2.2–5.2.6; units: mm.
const A=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const C=A.map(s=>Array.from(s,b=>b==='0'?'1':'0').join(''));
const B=C.map(s=>Array.from(s).reverse().join(''));
const PARITY=['AAAAAA','AABABB','AABBAB','AABBBA','ABAABB','ABBAAB','ABBBAA','ABABAB','ABABBA','ABBABA'];
const DEFAULT_X = 0.330;
const DEFAULT_BWR = 0;
function normalize(value) {
    if (typeof value !== 'string' || /[^0-9]/.test(value)) throw Error(messages.invalidGtin);
    if (value.length < 12) throw Error(messages.tooShort.replace('{count}', String(value.length)));
    if (value.length > 13) throw Error(messages.tooLong.replace('{count}', String(value.length)));
    const data=value.slice(0,12);
    const digit=String((10-Array.from(data).reduce((sum,d,i)=>sum+Number(d)*(i%2?3:1),0)%10)%10);
    if(value.length===13&&value[12]!==digit) throw Error(messages.invalidCheckDigit+digit);
    return data+digit;
}
function geometry(value,x=DEFAULT_X,bwr=DEFAULT_BWR) {
    const code=normalize(value);
    if(!Number.isFinite(x)||x<.264||x>.660) throw Error(messages.invalidX);
    if(!Number.isFinite(bwr)||bwr<0||bwr>.2*x) throw Error(messages.invalidBwr);
    const scale=x/DEFAULT_X, height=22.85*scale, padding=1;
    const parts=[['101',null,null,true]];
    for(let i=1;i<=6;i++) {const set=PARITY[Number(code[0])][i-1];parts.push([(set==='A'?A:B)[Number(code[i])],Number(code[i]),set,false]);}
    parts.push(['01010',null,null,true]);
    for(let i=7;i<13;i++) parts.push([C[Number(code[i])],Number(code[i]),'C',false]);
    parts.push(['101',null,null,true]);
    const bars=[];let cursor=padding+11*x;
    for(const [bits,digit,set,guard] of parts) {
        let delta=[1,2,7,8].includes(digit)?.025*scale*([1,2].includes(digit)?-1:1):0;
        if(set!=='A') delta=-delta;
        for(const run of bits.match(/0+|1+/g)) {
            const dark=run[0]==='1', width=run.length*x+(dark?delta:-delta);
            if(dark) bars.push({x:cursor+bwr/2,y:padding,width:width-bwr,height:height+(guard?5*x:0),guard});
            cursor+=width;
        }
    }
    const quietZoneRightEdge = padding + 113 * x;
    const hriBaseline = padding + height + x + 2.75 * scale;
    // GS1 fig. 5-23: the apex sits on the quiet-zone edge in the HRI band.
    // This filled chevron uses nominal mm measured left/up from that edge/baseline.
    const chevron = [[-1.55, 2.28], [-1.33, 2.50], [0, 1.25],
                     [-1.33, 0], [-1.55, 0.22], [-0.45, 1.25]];
    const quietZoneIndicator = chevron.map(([dx, dy]) => [
        quietZoneRightEdge + dx * scale,
        hriBaseline - dy * scale,
    ]);
    return {code, x, bwr, scale, padding, bars, hriBaseline, quietZoneIndicator,
            width: quietZoneRightEdge + padding, height: hriBaseline + padding};
}

const messages = {
    "noDocument": "Open a CMYK document, then run the generator.",
    "requireCmyk": "The generator requires a CMYK/8 document. Change the document colour format in Affinity and try again.",
    "noSpread": "There is no active spread.",
    "unavailableLayer": "The selected layer is locked or hidden. Select a visible, unlocked layer.",
    "codeGroup": "Barcode",
    "gtin": "EAN / GTIN (12 or 13 digits)",
    "whiteBackground": "Add white background with 1 mm margin",
    "advanced": "Use advanced settings",
    "printGroup": "Print settings",
    "x": "X-dimension [mm]",
    "bwr": "BWR [mm] — total per bar",
    "printHelp": "Use the BWR specified by your printer. Keep the barcode in proportion when resizing.",
    "previewGroup": "Preview on the spread",
    "previewEmpty": "Enter an EAN to see the preview.",
    "previewArea": "Barcode area",
    "clearArea": "Use a uniform light background across this entire area.",
    "decimalSeparator": ".",
    "invalidGtin": "Use digits 0–9 only, without spaces or hyphens.",
    "digitsOnlyNotice": "Only digits 0–9 are allowed.",
    "tooShort": "Entered {count} of the 12 digits needed to calculate the check digit.",
    "tooLong": "Entered {count} digits. EAN-13 accepts up to 13 digits.",
    "invalidCheckDigit": "Incorrect check digit. Expected: ",
    "invalidX": "The X-dimension must be between 0.264 and 0.660 mm.",
    "invalidBwr": "BWR must be between 0 and 20% of the X-dimension. Use the value specified by your printer.",
    "invalidDpi": "Invalid document resolution.",
    "tooLarge": "The barcode does not fit on the spread. Increase the document size or reduce the X-dimension.",
    "background": "white background / quiet zones",
    "insertError": "Could not insert the barcode: ",
    "layerError": "Could not create the EAN layer at the selected position.",
    "groupError": "The barcode was inserted on the EAN layer. Check the EAN 13 group in the Layers panel."
};

/* Digit outlines derived from Liberation Sans 2.1.5.

Digitized data copyright (c) 2010 Google Corporation
	with Reserved Font Arimo, Tinos and Cousine.
Copyright (c) 2012 Red Hat, Inc.
	with Reserved Font Name Liberation.

This Font Software is licensed under the SIL Open Font License,
Version 1.1.

This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE The goals of the Open Font License (OFL) are to stimulate
worldwide development of collaborative font projects, to support the font
creation efforts of academic and linguistic communities, and to provide
a free and open framework in which fonts may be shared and improved in
partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves.
The fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works.  The fonts and derivatives,
however, cannot be released under any other type of license.  The
requirement for fonts to remain under this license does not apply to
any document created using the fonts or their derivatives.



DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such.
This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components
as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting ? in part or in whole ?
any of the components of the Original Version, by changing formats or
by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer
or other person who contributed to the Font Software.


PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,in
   Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
   redistributed and/or sold with any software, provided that each copy
   contains the above copyright notice and this license. These can be
   included either as stand-alone text files, human-readable headers or
   in the appropriate machine-readable metadata fields within text or
   binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
   Name(s) unless explicit written permission is granted by the
   corresponding Copyright Holder. This restriction only applies to the
   primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
   Software shall not be used to promote, endorse or advertise any
   Modified Version, except to acknowledge the contribution(s) of the
   Copyright Holder(s) and the Author(s) or with their explicit written
   permission.

5) The Font Software, modified or unmodified, in part or in whole, must
   be distributed entirely under this license, and must not be distributed
   under any other license. The requirement for fonts to remain under
   this license does not apply to any document created using the Font
   Software.



TERMINATION
This license becomes null and void if any of the above conditions are not met.



DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT.  IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
*/
const DIGITS = {"0":[["M",0.928362069,1.375],["C",0.928362069,0.928678161,0.849655172,0.587931034,0.692241379,0.352758621],["C",0.534827586,0.117586207,0.3025,0.0,-0.004741379,0.0],["C",-0.311982759,0.0,-0.542729885,0.116954023,-0.696982759,0.350862069],["C",-0.851235632,0.584770115,-0.928362069,0.926149425,-0.928362069,1.375],["C",-0.928362069,1.833965517,-0.853448276,2.177873563,-0.70362069,2.406724138],["C",-0.553793103,2.635574713,-0.31704023,2.75,0.006637931,2.75],["C",0.321465517,2.75,0.553793103,2.634310345,0.70362069,2.402931034],["C",0.853448276,2.171551724,0.928362069,1.828908046,0.928362069,1.375],["Z"],["M",0.581293103,1.375],["C",0.581293103,1.760632184,0.536724138,2.040057471,0.447586207,2.213275862],["C",0.358448276,2.386494253,0.211465517,2.473103448,0.006637931,2.473103448],["C",-0.203247126,2.473103448,-0.354022989,2.387758621,-0.445689655,2.217068966],["C",-0.537356322,2.04637931,-0.583189655,1.765689655,-0.583189655,1.375],["C",-0.583189655,0.995689655,-0.536724138,0.71816092,-0.443793103,0.542413793],["C",-0.350862069,0.366666667,-0.203247126,0.278793103,-0.000948276,0.278793103],["C",0.200086207,0.278793103,0.347385057,0.368563218,0.440948276,0.548103448],["C",0.534511494,0.727643678,0.581293103,1.003275862,0.581293103,1.375],["Z"]],"1":[["M",-0.837327586,0.037931034],["L",-0.837327586,0.328103448],["L",-0.156465517,0.328103448],["L",-0.156465517,2.383965517],["L",-0.759568966,1.953448276],["L",-0.759568966,2.275862069],["L",-0.128017241,2.710172414],["L",0.186810345,2.710172414],["L",0.186810345,0.328103448],["L",0.837327586,0.328103448],["L",0.837327586,0.037931034],["Z"]],"2":[["M",-0.884741379,0.037931034],["L",-0.884741379,0.278793103],["C",-0.820258621,0.426724138,-0.741551724,0.557270115,-0.64862069,0.670431034],["C",-0.555689655,0.783591954,-0.458017241,0.886005747,-0.355603448,0.977672414],["C",-0.253189655,1.06933908,-0.151724138,1.154367816,-0.051206897,1.232758621],["C",0.049310345,1.311149425,0.140028736,1.38954023,0.220948276,1.467931034],["C",0.301867816,1.546321839,0.367298851,1.628505747,0.417241379,1.714482759],["C",0.467183908,1.80045977,0.492155172,1.897816092,0.492155172,2.006551724],["C",0.492155172,2.153218391,0.449166667,2.267011494,0.363189655,2.347931034],["C",0.277212644,2.428850575,0.157729885,2.469310345,0.004741379,2.469310345],["C",-0.14066092,2.469310345,-0.26045977,2.429798851,-0.354655172,2.350775862],["C",-0.448850575,2.271752874,-0.504166667,2.160804598,-0.520603448,2.017931034],["L",-0.869568966,2.050172414],["C",-0.844281609,2.263850575,-0.753563218,2.433908046,-0.597413793,2.560344828],["C",-0.441264368,2.686781609,-0.240545977,2.75,0.004741379,2.75],["C",0.274051724,2.75,0.481091954,2.686465517,0.625862069,2.559396552],["C",0.770632184,2.432327586,0.843017241,2.25183908,0.843017241,2.017931034],["C",0.843017241,1.914252874,0.819310345,1.811206897,0.771896552,1.708793103],["C",0.724482759,1.60637931,0.653994253,1.503965517,0.560431034,1.401551724],["C",0.466867816,1.299137931,0.28795977,1.14045977,0.023706897,0.925517241],["C",-0.121695402,0.806666667,-0.237385057,0.699511494,-0.323362069,0.604051724],["C",-0.40933908,0.508591954,-0.471293103,0.416609195,-0.509224138,0.328103448],["L",0.884741379,0.328103448],["L",0.884741379,0.037931034],["Z"]],"3":[["M",0.920775862,0.775689655],["C",0.920775862,0.529137931,0.842385057,0.338218391,0.685603448,0.202931034],["C",0.528821839,0.067643678,0.305028736,0.0,0.014224138,0.0],["C",-0.256350575,0.0,-0.472241379,0.061005747,-0.633448276,0.183017241],["C",-0.794655172,0.305028736,-0.890431034,0.485517241,-0.920775862,0.724482759],["L",-0.568017241,0.756724138],["C",-0.5225,0.440632184,-0.32841954,0.282586207,0.014224138,0.282586207],["C",0.186178161,0.282586207,0.321149425,0.324942529,0.419137931,0.409655172],["C",0.517126437,0.494367816,0.56612069,0.620172414,0.56612069,0.787068966],["C",0.56612069,0.932471264,0.510172414,1.045948276,0.398275862,1.1275],["C",0.28637931,1.209051724,0.124856322,1.249827586,-0.086293103,1.249827586],["L",-0.279741379,1.249827586],["L",-0.279741379,1.545689655],["L",-0.09387931,1.545689655],["C",0.093247126,1.545689655,0.238333333,1.586465517,0.34137931,1.668017241],["C",0.444425287,1.749568966,0.495948276,1.862413793,0.495948276,2.006551724],["C",0.495948276,2.149425287,0.453908046,2.262270115,0.369827586,2.345086207],["C",0.285747126,2.427902299,0.160890805,2.469310345,-0.004741379,2.469310345],["C",-0.155201149,2.469310345,-0.276896552,2.430747126,-0.369827586,2.35362069],["C",-0.462758621,2.276494253,-0.516810345,2.167758621,-0.531982759,2.027413793],["L",-0.875258621,2.053965517],["C",-0.849971264,2.272701149,-0.759252874,2.443390805,-0.603103448,2.566034483],["C",-0.446954023,2.688678161,-0.246235632,2.75,-0.000948276,2.75],["C",0.267097701,2.75,0.475402299,2.687729885,0.623965517,2.563189655],["C",0.772528736,2.438649425,0.846810345,2.265114943,0.846810345,2.042586207],["C",0.846810345,1.871896552,0.79908046,1.733132184,0.70362069,1.626293103],["C",0.60816092,1.519454023,0.469396552,1.447068966,0.287327586,1.409137931],["L",0.287327586,1.401551724],["C",0.487097701,1.380057471,0.642614943,1.313045977,0.75387931,1.200517241],["C",0.865143678,1.087988506,0.920775862,0.94637931,0.920775862,0.775689655],["Z"]],"4":[["M",0.603103448,0.642931034],["L",0.603103448,0.037931034],["L",0.280689655,0.037931034],["L",0.280689655,0.642931034],["L",-0.97862069,0.642931034],["L",-0.97862069,0.908448276],["L",0.244655172,2.710172414],["L",0.603103448,2.710172414],["L",0.603103448,0.912241379],["L",0.97862069,0.912241379],["L",0.97862069,0.642931034],["Z"],["M",0.280689655,2.325172414],["C",0.27816092,2.317586207,0.26045977,2.28408046,0.227586207,2.224655172],["C",0.194712644,2.165229885,0.170057471,2.123505747,0.15362069,2.099482759],["L",-0.531034483,1.090517241],["L",-0.633448276,0.950172414],["L",-0.663793103,0.912241379],["L",0.280689655,0.912241379],["Z"]],"5":[["M",0.920775862,0.908448276],["C",0.920775862,0.626494253,0.837011494,0.404597701,0.669482759,0.242758621],["C",0.501954023,0.08091954,0.269626437,0.0,-0.0275,0.0],["C",-0.27658046,0.0,-0.477614943,0.054367816,-0.630603448,0.163103448],["C",-0.783591954,0.27183908,-0.880316092,0.429252874,-0.920775862,0.635344828],["L",-0.575603448,0.675172414],["C",-0.503534483,0.41091954,-0.318304598,0.278793103,-0.019913793,0.278793103],["C",0.16341954,0.278793103,0.306925287,0.334109195,0.410603448,0.444741379],["C",0.514281609,0.555373563,0.56612069,0.707413793,0.56612069,0.900862069],["C",0.56612069,1.069022989,0.513965517,1.204942529,0.409655172,1.30862069],["C",0.305344828,1.412298851,0.164683908,1.464137931,-0.012327586,1.464137931],["C",-0.104626437,1.464137931,-0.190603448,1.449597701,-0.270258621,1.420517241],["C",-0.349913793,1.391436782,-0.429568966,1.342126437,-0.509224138,1.272586207],["L",-0.843017241,1.272586207],["L",-0.75387931,2.710172414],["L",0.765258621,2.710172414],["L",0.765258621,2.42],["L",-0.442844828,2.42],["L",-0.494051724,1.572241379],["C",-0.34612069,1.686034483,-0.162155172,1.742931034,0.057844828,1.742931034],["C",0.320833333,1.742931034,0.530402299,1.665804598,0.686551724,1.511551724],["C",0.842701149,1.357298851,0.920775862,1.156264368,0.920775862,0.908448276],["Z"]],"6":[["M",0.89612069,0.912241379],["C",0.89612069,0.630287356,0.819626437,0.407758621,0.666637931,0.244655172],["C",0.513649425,0.081551724,0.3025,0.0,0.033189655,0.0],["C",-0.267729885,0.0,-0.497844828,0.111896552,-0.657155172,0.335689655],["C",-0.816465517,0.559482759,-0.89612069,0.885057471,-0.89612069,1.312413793],["C",-0.89612069,1.775172414,-0.813304598,2.13045977,-0.647672414,2.378275862],["C",-0.48204023,2.626091954,-0.246235632,2.75,0.059741379,2.75],["C",0.463074713,2.75,0.717212644,2.568563218,0.822155172,2.205689655],["L",0.495948276,2.146896552],["C",0.428936782,2.364367816,0.282270115,2.473103448,0.055948276,2.473103448],["C",-0.138764368,2.473103448,-0.28954023,2.382385057,-0.39637931,2.200948276],["C",-0.503218391,2.019511494,-0.556637931,1.75683908,-0.556637931,1.412931034],["C",-0.494683908,1.527988506,-0.407442529,1.615545977,-0.294913793,1.675603448],["C",-0.182385057,1.73566092,-0.05341954,1.765689655,0.091982759,1.765689655],["C",0.338534483,1.765689655,0.534195402,1.688563218,0.678965517,1.534310345],["C",0.823735632,1.380057471,0.89612069,1.172701149,0.89612069,0.912241379],["Z"],["M",0.549051724,0.897068966],["C",0.549051724,1.090517241,0.501637931,1.239712644,0.406810345,1.344655172],["C",0.311982759,1.449597701,0.179856322,1.502068966,0.010431034,1.502068966],["C",-0.14887931,1.502068966,-0.277528736,1.455603448,-0.375517241,1.362672414],["C",-0.473505747,1.269741379,-0.5225,1.141724138,-0.5225,0.97862069],["C",-0.5225,0.772528736,-0.471609195,0.603735632,-0.369827586,0.472241379],["C",-0.268045977,0.340747126,-0.1375,0.275,0.021810345,0.275],["C",0.186178161,0.275,0.315143678,0.330316092,0.408706897,0.440948276],["C",0.502270115,0.55158046,0.549051724,0.70362069,0.549051724,0.897068966],["Z"]],"7":[["M",0.882844828,2.433275862],["C",0.609741379,2.016034483,0.416925287,1.689195402,0.304396552,1.452758621],["C",0.191867816,1.216321839,0.107471264,0.983045977,0.051206897,0.752931034],["C",-0.005057471,0.522816092,-0.033189655,0.284482759,-0.033189655,0.037931034],["L",-0.389741379,0.037931034],["C",-0.389741379,0.379310345,-0.317356322,0.738706897,-0.172586207,1.11612069],["C",-0.027816092,1.493534483,0.213994253,1.92816092,0.552844828,2.42],["L",-0.882844828,2.42],["L",-0.882844828,2.710172414],["L",0.882844828,2.710172414],["Z"]],"8":[["M",0.911293103,0.783275862],["C",0.911293103,0.536724138,0.832902299,0.34454023,0.67612069,0.206724138],["C",0.51933908,0.068908046,0.294281609,0.0,0.000948276,0.0],["C",-0.284798851,0.0,-0.508275862,0.067643678,-0.669482759,0.202931034],["C",-0.830689655,0.338218391,-0.911293103,0.530402299,-0.911293103,0.779482759],["C",-0.911293103,0.953965517,-0.861350575,1.100632184,-0.761465517,1.219482759],["C",-0.66158046,1.338333333,-0.53387931,1.410402299,-0.378362069,1.435689655],["L",-0.378362069,1.443275862],["C",-0.523764368,1.477413793,-0.638505747,1.55137931,-0.722586207,1.665172414],["C",-0.806666667,1.778965517,-0.848706897,1.912356322,-0.848706897,2.065344828],["C",-0.848706897,2.268908046,-0.772528736,2.433908046,-0.620172414,2.560344828],["C",-0.467816092,2.686781609,-0.263304598,2.75,-0.006637931,2.75],["C",0.256350575,2.75,0.464022989,2.688045977,0.61637931,2.564137931],["C",0.768735632,2.440229885,0.844913793,2.272701149,0.844913793,2.061551724],["C",0.844913793,1.908563218,0.802557471,1.775172414,0.717844828,1.66137931],["C",0.633132184,1.547586207,0.517442529,1.476149425,0.370775862,1.447068966],["L",0.370775862,1.439482759],["C",0.541465517,1.411666667,0.674224138,1.339281609,0.769051724,1.222327586],["C",0.86387931,1.105373563,0.911293103,0.959022989,0.911293103,0.783275862],["Z"],["M",0.490258621,2.042586207],["C",0.490258621,2.344770115,0.324626437,2.495862069,-0.006637931,2.495862069],["C",-0.167212644,2.495862069,-0.28954023,2.457931034,-0.37362069,2.382068966],["C",-0.457701149,2.306206897,-0.499741379,2.193045977,-0.499741379,2.042586207],["C",-0.499741379,1.889597701,-0.456436782,1.77295977,-0.369827586,1.692672414],["C",-0.283218391,1.612385057,-0.160890805,1.572241379,-0.002844828,1.572241379],["C",0.157729885,1.572241379,0.280057471,1.609224138,0.364137931,1.683189655],["C",0.448218391,1.757155172,0.490258621,1.876954023,0.490258621,2.042586207],["Z"],["M",0.556637931,0.815517241],["C",0.556637931,0.981149425,0.507327586,1.106005747,0.408706897,1.190086207],["C",0.310086207,1.274166667,0.171637931,1.316206897,-0.006637931,1.316206897],["C",-0.179856322,1.316206897,-0.315143678,1.271005747,-0.4125,1.180603448],["C",-0.509856322,1.090201149,-0.558534483,0.965977011,-0.558534483,0.807931034],["C",-0.558534483,0.44,-0.370775862,0.256034483,0.004741379,0.256034483],["C",0.190603448,0.256034483,0.329051724,0.300603448,0.420086207,0.389741379],["C",0.51112069,0.47887931,0.556637931,0.620804598,0.556637931,0.815517241],["Z"]],"9":[["M",0.897068966,1.428103448],["C",0.897068966,0.969137931,0.813304598,0.61637931,0.645775862,0.369827586],["C",0.478247126,0.123275862,0.239597701,0.0,-0.070172414,0.0],["C",-0.278793103,0.0,-0.446005747,0.043936782,-0.571810345,0.131810345],["C",-0.697614943,0.219683908,-0.787701149,0.361609195,-0.842068966,0.557586207],["L",-0.515862069,0.608793103],["C",-0.447586207,0.386264368,-0.297126437,0.275,-0.064482759,0.275],["C",0.131494253,0.275,0.283218391,0.366034483,0.390689655,0.548103448],["C",0.49816092,0.730172414,0.554425287,0.99,0.559482759,1.327586207],["C",0.508908046,1.213793103,0.422298851,1.122442529,0.299655172,1.053534483],["C",0.177011494,0.984626437,0.042356322,0.950172414,-0.104310345,0.950172414],["C",-0.34454023,0.950172414,-0.536724138,1.032356322,-0.680862069,1.196724138],["C",-0.825,1.361091954,-0.897068966,1.579195402,-0.897068966,1.851034483],["C",-0.897068966,2.13045977,-0.818678161,2.350143678,-0.661896552,2.510086207],["C",-0.505114943,2.670028736,-0.287011494,2.75,-0.007586207,2.75],["C",0.28954023,2.75,0.514597701,2.64,0.667586207,2.42],["C",0.820574713,2.2,0.897068966,1.869367816,0.897068966,1.428103448],["Z"],["M",0.525344828,1.758103448],["C",0.525344828,1.973045977,0.476034483,2.145948276,0.377413793,2.276810345],["C",0.278793103,2.407672414,0.146666667,2.473103448,-0.018965517,2.473103448],["C",-0.183333333,2.473103448,-0.312931034,2.417155172,-0.407758621,2.305258621],["C",-0.502586207,2.193362069,-0.55,2.041954023,-0.55,1.851034483],["C",-0.55,1.656321839,-0.502586207,1.502385057,-0.407758621,1.389224138],["C",-0.312931034,1.276063218,-0.184597701,1.219482759,-0.022758621,1.219482759],["C",0.075862069,1.219482759,0.167528736,1.241925287,0.252241379,1.286810345],["C",0.336954023,1.331695402,0.403649425,1.395229885,0.452327586,1.477413793],["C",0.501005747,1.559597701,0.525344828,1.65316092,0.525344828,1.758103448],["Z"]]};

// Uses the shipped Affinity 3.3 JSLib, not a browser or external process.
function main() {
    const {Document}=require('/document.js');
    const {Dialog,DialogResult}=require('/dialog.js');
    const {RasterFormat}=require('/rasterobject.js');
    const {UnitType}=require('/units.js');
    const {CMYKf}=require('/colours.js');
    const {FillDescriptor}=require('/fills.js');
    const {PolyCurve,Curve,CurveBuilder,Rectangle}=require('/geometry.js');
    const {ContainerNodeDefinition,NodeChildType,PolyCurveNodeDefinition}=require('/nodes.js');
    const {AddChildNodesCommandBuilder,DocumentCommand,InsertionMode,NodeMoveType}=require('/commands.js');
    const {Selection}=require('/selections.js');
    const doc=Document.current;
    if(!doc) {alert(messages.noDocument);return;}
    const enumValue=v=>v?.value??v;
    if(enumValue(doc.format)!==enumValue(RasterFormat.CMYKA8)) {
        alert(messages.requireCmyk);return;
    }
    const spread=doc.currentSpread;
    if(!spread) {alert(messages.noSpread);return;}

    // Capture the destination before any preview or insertion changes the selection.
    const selected = doc.selection.nodes.toArray();
    let workingLayer = null;
    let layerParent = spread;
    if (selected.length === 1) {
        let directChild = null;
        for (let node = selected[0]; node && !node.isSpreadNode; node = node.parent) {
            if (node.isContainerNode) {
                workingLayer = node;
                layerParent = node.parent ?? spread;
                break;
            }
            if (node.isArtboardEnabled) {
                layerParent = node;
                break;
            }
            directChild = node;
        }
        // A standalone object or group can also act as a layer in the panel.
        workingLayer ??= directChild;
    }
    let artboardBounds;
    for (let node = layerParent; node && !node.isSpreadNode; node = node.parent) {
        if (node.isLocked || node.isVisible === false) {
            alert(messages.unavailableLayer);
            return;
        }
        if (!artboardBounds && node.isArtboardEnabled) artboardBounds = node.artboardSpreadBaseBox;
    }

    const dlg=Dialog.create('EAN-13 • Prepress');
    const col=dlg.addColumn(), input=col.addGroup(messages.codeGroup);
    input.addStaticText(null, messages.gtin).setIsFullWidth();
    const gtin = input.addTextBox(null, '').setIsFullWidth();
    const digitNotice = input.addStaticText(null, messages.digitsOnlyNotice).setIsFullWidth();
    digitNotice.isVisible = false;
    const whiteBackground = input.addCheckBox(messages.whiteBackground, true).setIsFullWidth();
    const advanced = input.addCheckBox(messages.advanced, false).setIsFullWidth();
    const print = col.addGroup(messages.printGroup);
    const x=print.addUnitValueEditor(messages.x,UnitType.Number,UnitType.Number,DEFAULT_X,.264,.660).setPrecision(4);
    const bwr=print.addUnitValueEditor(messages.bwr,UnitType.Number,UnitType.Number,DEFAULT_BWR,0,.132).setPrecision(4);
    print.addStaticText(null, messages.printHelp).setIsFullWidth();
    print.isVisible = false;
    const previewStatus = col.addGroup(messages.previewGroup)
        .addStaticText(null, messages.previewEmpty).setIsFullWidth();

    function readGeometry() {
        return geometry(gtin.text, advanced.value ? x.value : DEFAULT_X,
                        advanced.value ? bwr.value : DEFAULT_BWR);
    }

    function buildBarcodeNodes(g, includeBackground) {
        const unit=doc.dpi/25.4;
        if(!Number.isFinite(unit)||unit<=0) throw Error(messages.invalidDpi);
        const bounds=artboardBounds ?? spread.getSpreadExtents({includeSpread:true,includeBleed:false,includeChildren:false});
        if(bounds.width<g.width*unit||bounds.height<g.height*unit) throw Error(messages.tooLarge);
        const ox=bounds.x+(bounds.width-g.width*unit)/2;
        const oy=bounds.y+(bounds.height-g.height*unit)/2;
        const rect=(a,b,w,h)=>new Rectangle(ox+a*unit,oy+b*unit,w*unit,h*unit);
        const ink=PolyCurve.create();
        for(const b of g.bars) ink.addCurve(Curve.createRectangle(rect(b.x,b.y,b.width,b.height)));
        const centers=[5.5,...Array.from({length:6},(_,i)=>17.5+7*i),...Array.from({length:6},(_,i)=>64.5+7*i)];
        for(let i=0;i<13;i++) {
            let path=null;
            for(const [op,...coords] of DIGITS[g.code[i]]) {
                const v=coords.map((n,j)=>j%2===0 ? ox+(g.padding+centers[i]*g.x+n*g.scale)*unit : oy+(g.hriBaseline-n*g.scale)*unit);
                if(op==='M') {path=CurveBuilder.create();path.beginXY(...v);}
                else if(op==='L') path.lineToXY(...v);
                else if(op==='C') path.addBezierXY(...v);
                else if(op==='Z') {path.close();ink.addCurve(path.createCurve());path=null;}
            }
        }
        const indicator = CurveBuilder.create();
        const [[startX, startY], ...corners] = g.quietZoneIndicator;
        indicator.beginXY(ox + startX * unit, oy + startY * unit);
        for (const [cornerX, cornerY] of corners) {
            indicator.lineToXY(ox + cornerX * unit, oy + cornerY * unit);
        }
        indicator.close();
        ink.addCurve(indicator.createCurve());
        function definition(curves,k,name) {
            const def=PolyCurveNodeDefinition.createDefault();
            def.curves=curves;
            while(def.brushFillDescriptorCount) def.removeBrushFillDescriptor(0);
            while(def.lineDescriptorsCount) def.removeLineDescriptors(0);
            const colour=CMYKf(0,0,0,k);colour.overprint=false;
            def.addBrushFillDescriptor(FillDescriptor.createSolid(colour));
            def.userDescription=name;
            return def;
        }
        const nodes = [];
        if (includeBackground) {
            const paper = PolyCurve.create();
            paper.addCurve(Curve.createRectangle(rect(0,0,g.width,g.height)));
            nodes.push(definition(paper,0,'EAN '+g.code+' • '+messages.background));
        }
        nodes.push(definition(ink,1,'EAN '+g.code+' • K100 • X='+g.x+' mm • BWR='+g.bwr+' mm'));
        return nodes;
    }

    function addBuilder(target, select) {
        const builder = AddChildNodesCommandBuilder.create();
        builder.forcePixelAlignment = false;
        builder.clearCurrentSelection = select;
        builder.setInsertionTarget(target);
        builder.setInsertionMode(InsertionMode.Inside_AtFront);
        return builder;
    }

    function addBarcodeCommand(nodes, target, select) {
        const builder = addBuilder(target, select);
        for (const node of nodes) builder.addNode(node);
        return builder.createCommand(select);
    }

    function groupBarcode(added, layer) {
        const groupCommand = DocumentCommand.createGroupNodes(Selection.create(doc, added));
        doc.executeCommand(groupCommand, false);
        const belongsToLayer = node => node.isGroupNode && node.parent?.isSameNode(layer);
        const group = groupCommand.newNodes.find(belongsToLayer)
            ?? doc.selection.nodes.toArray().find(belongsToLayer);
        if (!group) throw Error(messages.groupError);
        group.userDescription = 'EAN 13';
    }

    function insertBarcode(g, includeBackground) {
        const nodes = buildBarcodeNodes(g, includeBackground);
        const builder = addBuilder(layerParent, false);
        builder.autoName = false;
        builder.addContainerNode(ContainerNodeDefinition.create('EAN'));
        const addLayer = builder.createCommand(false);
        let layer;
        let added;
        try {
            doc.executeCommand(addLayer, false);
            layer = addLayer.newNodes.find(node => node.isContainerNode);
            if (!layer) throw Error(messages.layerError);
            // Siblings are ordered back to front, so After puts EAN directly above the working layer.
            if (workingLayer && !layer.previousSibling?.isSameNode(workingLayer)) {
                const selection = Selection.create(doc, layer);
                const move = DocumentCommand.createMoveNodes(selection, workingLayer, NodeMoveType.After, NodeChildType.Main);
                doc.executeCommand(move, false);
                if (!layer.previousSibling?.isSameNode(workingLayer)) throw Error(messages.layerError);
            }
            const addBarcode = addBarcodeCommand(nodes, layer, true);
            doc.executeCommand(addBarcode, false);
            added = addBarcode.newNodes;
            if (added.length !== nodes.length) throw Error(messages.layerError);
        } catch (error) {
            const created = layer ?? addLayer.newNodes.find(node => node.isContainerNode);
            if (created) {
                const selection = Selection.create(doc, created);
                doc.executeCommand(DocumentCommand.createDeleteSelection(selection, true), false);
            }
            throw error;
        }
        try {
            groupBarcode(added, layer);
        } catch (error) {
            alert(messages.groupError);
            console.warn(error.message);
        }
    }

    let hasPreview = false;
    function clearPreview() {
        if (hasPreview) {
            doc.clearPreviews();
            hasPreview = false;
        }
    }

    function updatePreview() {
        if (!gtin.text) {
            clearPreview();
            previewStatus.text = messages.previewEmpty;
            return;
        }
        try {
            const g = readGeometry();
            const nodes = buildBarcodeNodes(g, whiteBackground.value);
            const command = addBarcodeCommand(nodes, layerParent, false);
            hasPreview = true;
            doc.executeCommand(command, true);
            const mm = value => value.toFixed(2).replace('.', messages.decimalSeparator);
            const summary = `${g.code} · ${messages.previewArea} ${mm(g.width)} × ${mm(g.height)} mm`;
            previewStatus.text = whiteBackground.value ? summary : summary + '\n' + messages.clearArea;
        } catch (error) {
            clearPreview();
            previewStatus.text = error.message;
        }
    }

    advanced.onValueChangedHandler = () => {
        print.isVisible = advanced.value;
        updatePreview();
    };
    let filteringGtin = false;
    let previousDigits = '';
    gtin.onValueChangedHandler = () => {
        if (filteringGtin) return;
        const entered = gtin.text;
        const digits = entered.replace(/[^0-9]/g, '');
        if (digits !== entered) {
            digitNotice.isVisible = true;
            previousDigits = digits;
            filteringGtin = true;
            try {
                gtin.text = digits;
            } finally {
                filteringGtin = false;
            }
        } else if (digits !== previousDigits) {
            digitNotice.isVisible = false;
            previousDigits = digits;
        }
        updatePreview();
    };
    whiteBackground.onValueChangedHandler = updatePreview;
    x.onValueChangedHandler = updatePreview;
    bwr.onValueChangedHandler = updatePreview;

    try {
        while (enumValue(dlg.runModal()) === enumValue(DialogResult.Ok)) {
            clearPreview();
            let g;
            try {
                g = readGeometry();
            } catch (error) {
                alert(error.message);
                continue;
            }
            try {
                insertBarcode(g, whiteBackground.value);
            } catch (error) {
                alert(messages.insertError + error.message);
            }
            return;
        }
    } finally {
        clearPreview();
    }
}
main();
