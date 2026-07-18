/**
 * name: Affinity Gradient Smoother
 * description: Smooths gradients with quick presets, perceptual equalization, soft endpoint easing, and adaptive anti-banding.
 * version: 1.6.1
 * author: Caio Sousa Design
 * contributors: Caio
 */

const { Dialog, DialogResult } = require('/dialog');
const { Document } = require('/document');
const { FillDescriptor } = require('/fills');
const { Gradient, Colour } = require('/colours');
const { DocumentCommand } = require('/commands');
const { StoryDelta } = require('/storydelta');

const MAX_TOTAL_STOPS = 96;
const EPSILON = 0.000001;

const PRESET_AUTOMATIC = 0;
const PRESET_NATURAL = 1;
const PRESET_SOFT = 2;
const PRESET_VIBRANT = 3;
const PRESET_NEUTRAL = 4;
const PRESET_ANTI_BANDING = 5;
const PRESET_CUSTOM = 6;

const PRESETS = [
    { name: 'Automatic', automatic: true },
    {
        name: 'Natural', interpolationMode: 'oklch', points: 12,
        midpoint: 75, perceptualEqualization: 72, endpointSoftness: 70,
        centralBalance: 24, chromaReduction: 0,
        antiBanding: 0.06, edgeBandingBoost: 50
    },
    {
        name: 'Soft', interpolationMode: 'oklch', points: 18,
        midpoint: 90, perceptualEqualization: 88, endpointSoftness: 88,
        centralBalance: 34, chromaReduction: 4,
        antiBanding: 0.08, edgeBandingBoost: 65
    },
    {
        name: 'Vibrant', interpolationMode: 'oklch', points: 12,
        midpoint: 65, perceptualEqualization: 58, endpointSoftness: 48,
        centralBalance: 12, chromaReduction: 0,
        antiBanding: 0.04, edgeBandingBoost: 40
    },
    {
        name: 'Neutral', interpolationMode: 'oklab', points: 12,
        midpoint: 75, perceptualEqualization: 76, endpointSoftness: 72,
        centralBalance: 0, chromaReduction: 0,
        antiBanding: 0.06, edgeBandingBoost: 50
    },
    {
        name: 'Anti-banding', interpolationMode: 'oklch', points: 28,
        midpoint: 88, perceptualEqualization: 94, endpointSoftness: 96,
        centralBalance: 30, chromaReduction: 2,
        antiBanding: 0.28, edgeBandingBoost: 90
    },
    { name: 'Custom', custom: true }
];

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function showMessage(title, message) {
    const dialog = Dialog.create(title);
    dialog.initialWidth = 460;
    dialog.addColumn()
        .addGroup('')
        .addStaticText('', message);
    dialog.runModal();
}

function isTextNode(node) {
    const tag = node?.[Symbol.toStringTag] || '';
    return tag === 'ArtTextNode' || tag === 'FrameTextNode';
}

function getMarkedTextRange(doc) {
    if (!doc || doc.selection.length === 0) return null;

    const item = doc.selection.at(0);
    const node = item.node;
    if (!node?.storyInterface) return null;

    let textSelection = null;
    for (const subSelection of item.subSelections) {
        if (subSelection[Symbol.toStringTag] === 'TextSelection') {
            textSelection = subSelection;
            break;
        }
    }

    if (!textSelection || textSelection.rangeCount === 0) return null;

    const startIndex = Math.min(textSelection.caret, textSelection.anchor);
    const endIndex = Math.max(textSelection.caret, textSelection.anchor);

    if (endIndex <= startIndex) return null;

    return {
        node,
        startIndex,
        endIndex
    };
}

function getFillDescriptor(node, useStroke, rangeInfo) {
    if (isTextNode(node)) {
        const story = node.storyInterface?.story;
        if (!story || story.length === 0) return null;

        const glyphIndex = rangeInfo ? rangeInfo.startIndex : 0;
        const attributes = story.getGlyphAtts(glyphIndex);
        return useStroke ? attributes.penFill : attributes.brushFill;
    }

    return useStroke ? node.penFillDescriptor : node.brushFillDescriptor;
}

function applyFillDescriptor(doc, descriptor, useStroke, rangeInfo) {
    if (rangeInfo) {
        const delta = useStroke
            ? StoryDelta.createPenFill(descriptor)
            : StoryDelta.createBrushFill(descriptor);

        doc.formatText(delta, doc.selection, false);
        return;
    }

    const command = useStroke
        ? DocumentCommand.createSetPenFill(doc.selection, descriptor)
        : DocumentCommand.createSetBrushFill(doc.selection, descriptor);

    doc.executeCommand(command);
}

// -----------------------------------------------------------------------------
// Colour conversion: HSL <-> sRGB <-> OKLab
// Interpolating in OKLab reduces abrupt lightness and saturation changes.
// -----------------------------------------------------------------------------

function hueToRgb(p, q, t) {
    let hue = t;
    if (hue < 0) hue += 1;
    if (hue > 1) hue -= 1;
    if (hue < 1 / 6) return p + (q - p) * 6 * hue;
    if (hue < 1 / 2) return q;
    if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
    return p;
}

function hslToSrgb(hsl) {
    const h = ((hsl.h % 1) + 1) % 1;
    const s = clamp(hsl.s, 0, 1);
    const l = clamp(hsl.l, 0, 1);

    if (s < EPSILON) {
        return { r: l, g: l, b: l };
    }

    const q = l < 0.5
        ? l * (1 + s)
        : l + s - l * s;
    const p = 2 * l - q;

    return {
        r: hueToRgb(p, q, h + 1 / 3),
        g: hueToRgb(p, q, h),
        b: hueToRgb(p, q, h - 1 / 3)
    };
}

function srgbToHsl(rgb) {
    const r = clamp(rgb.r, 0, 1);
    const g = clamp(rgb.g, 0, 1);
    const b = clamp(rgb.b, 0, 1);

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const l = (max + min) / 2;

    if (delta < EPSILON) {
        return { h: 0, s: 0, l };
    }

    const s = l > 0.5
        ? delta / (2 - max - min)
        : delta / (max + min);

    let h;
    if (max === r) {
        h = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
        h = (b - r) / delta + 2;
    } else {
        h = (r - g) / delta + 4;
    }

    h /= 6;
    return { h, s, l };
}

function srgbChannelToLinear(value) {
    const v = clamp(value, 0, 1);
    return v <= 0.04045
        ? v / 12.92
        : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(value) {
    const v = value;
    const encoded = v <= 0.0031308
        ? 12.92 * v
        : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return clamp(encoded, 0, 1);
}

function srgbToOklab(rgb) {
    const r = srgbChannelToLinear(rgb.r);
    const g = srgbChannelToLinear(rgb.g);
    const b = srgbChannelToLinear(rgb.b);

    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    const lRoot = Math.cbrt(l);
    const mRoot = Math.cbrt(m);
    const sRoot = Math.cbrt(s);

    return {
        L: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
        a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
        b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
    };
}

function normalizeHueRadians(hue) {
    const fullTurn = Math.PI * 2;
    let normalized = hue % fullTurn;
    if (normalized < 0) normalized += fullTurn;
    return normalized;
}

function oklabToOklch(lab) {
    return {
        L: lab.L,
        C: Math.sqrt(lab.a * lab.a + lab.b * lab.b),
        h: normalizeHueRadians(Math.atan2(lab.b, lab.a))
    };
}

function oklchToOklab(lch) {
    return {
        L: lch.L,
        a: lch.C * Math.cos(lch.h),
        b: lch.C * Math.sin(lch.h)
    };
}

function interpolateHueShortest(startHue, endHue, t) {
    const fullTurn = Math.PI * 2;
    let delta = (endHue - startHue) % fullTurn;

    if (delta > Math.PI) delta -= fullTurn;
    if (delta < -Math.PI) delta += fullTurn;

    return normalizeHueRadians(startHue + delta * t);
}

function oklabToLinearSrgb(lab) {
    const lRoot = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
    const mRoot = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
    const sRoot = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;

    const l = lRoot * lRoot * lRoot;
    const m = mRoot * mRoot * mRoot;
    const s = sRoot * sRoot * sRoot;

    return {
        r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    };
}

function isLinearSrgbInGamut(rgb) {
    const tolerance = 0.00001;
    return rgb.r >= -tolerance && rgb.r <= 1 + tolerance &&
        rgb.g >= -tolerance && rgb.g <= 1 + tolerance &&
        rgb.b >= -tolerance && rgb.b <= 1 + tolerance;
}

function gamutMapOklchToOklab(lch) {
    const requestedLab = oklchToOklab(lch);
    if (isLinearSrgbInGamut(oklabToLinearSrgb(requestedLab))) {
        return requestedLab;
    }

    // Preserves lightness and hue while reducing only the chroma required.
    let low = 0;
    let high = Math.max(0, lch.C);

    for (let iteration = 0; iteration < 14; iteration++) {
        const candidateC = (low + high) / 2;
        const candidateLab = oklchToOklab({
            L: lch.L,
            C: candidateC,
            h: lch.h
        });

        if (isLinearSrgbInGamut(oklabToLinearSrgb(candidateLab))) {
            low = candidateC;
        } else {
            high = candidateC;
        }
    }

    return oklchToOklab({
        L: lch.L,
        C: low,
        h: lch.h
    });
}

function oklabToSrgb(lab) {
    const linear = oklabToLinearSrgb(lab);

    return {
        r: linearChannelToSrgb(linear.r),
        g: linearChannelToSrgb(linear.g),
        b: linearChannelToSrgb(linear.b)
    };
}

// -----------------------------------------------------------------------------
// Reading and creating gradient stops
// -----------------------------------------------------------------------------

function readGradientStops(gradient) {
    const stops = [];

    for (let i = 0; i < gradient.stopCount; i++) {
        const sourceStop = gradient.getStop(i);
        const colour = new Colour(sourceStop.colour);
        const hslaf = colour.hslaf;

        const lab = srgbToOklab(hslToSrgb(hslaf));

        stops.push({
            position: sourceStop.position,
            midpoint: sourceStop.midpoint != null ? sourceStop.midpoint : 0.5,
            noise: colour.noise || 0,
            hslaf,
            colourHandle: sourceStop.colour,
            lab,
            lch: oklabToOklch(lab)
        });
    }

    stops.sort((a, b) => a.position - b.position);
    return stops;
}

function mapThroughMidpoint(position, midpoint) {
    const m = clamp(midpoint, 0.02, 0.98);
    const u = clamp(position, 0, 1);

    if (u <= m) {
        return 0.5 * (u / m);
    }

    return 0.5 + 0.5 * ((u - m) / (1 - m));
}

function createGeneratedColour(lab, alpha, noise) {
    const rgb = oklabToSrgb(lab);
    const hsl = srgbToHsl(rgb);

    const colour = Colour.createHSLAf({
        h: hsl.h,
        s: hsl.s,
        l: hsl.l,
        alpha: clamp(alpha, 0, 1)
    });

    colour.noise = clamp(noise, 0, 1);
    return colour;
}

function cloneColourWithAdditionalNoise(stop, additionalNoise) {
    const colour = new Colour(stop.colourHandle);
    colour.noise = clamp(stop.noise + additionalNoise, 0, 1);
    return colour;
}

function getPlanEdgeNoise(plan) {
    if (!plan) return 0;
    // The boost is deliberately moderate. Too much endpoint noise creates
    // visible texture without fixing the abrupt change in the gradient slope.
    return plan.antiBanding * (1 + plan.edgeBandingBoost * 0.45);
}

function getOriginalStopColour(rawStops, plans, stopIndex) {
    let additionalNoise = 0;

    if (stopIndex > 0) {
        additionalNoise = Math.max(
            additionalNoise,
            getPlanEdgeNoise(plans[stopIndex - 1])
        );
    }

    if (stopIndex < plans.length) {
        additionalNoise = Math.max(
            additionalNoise,
            getPlanEdgeNoise(plans[stopIndex])
        );
    }

    return cloneColourWithAdditionalNoise(
        rawStops[stopIndex],
        additionalNoise
    );
}

function distributeStopPosition(pointIndex, pointsPerSegment, edgeStopBias) {
    const uniformT = pointIndex / (pointsPerSegment + 1);
    const cosineT = 0.5 - 0.5 * Math.cos(Math.PI * uniformT);

    return lerp(
        uniformT,
        cosineT,
        clamp(edgeStopBias, 0, 0.75)
    );
}

function shortestHueDistanceRadians(startHue, endHue) {
    const fullTurn = Math.PI * 2;
    let delta = Math.abs(endHue - startHue) % fullTurn;
    if (delta > Math.PI) delta = fullTurn - delta;
    return delta;
}

function analyseSegment(start, end) {
    const deltaL = end.lab.L - start.lab.L;
    const deltaA = end.lab.a - start.lab.a;
    const deltaB = end.lab.b - start.lab.b;
    const labDistance = Math.sqrt(
        deltaL * deltaL + deltaA * deltaA + deltaB * deltaB
    );

    const minimumChroma = Math.min(start.lch.C, end.lch.C);
    const maximumChroma = Math.max(start.lch.C, end.lch.C);
    const hasNeutralEndpoint = minimumChroma < 0.018;
    const hueDistance = hasNeutralEndpoint
        ? 0
        : shortestHueDistanceRadians(start.lch.h, end.lch.h);

    return {
        labDistance,
        lightnessDistance: Math.abs(deltaL),
        hueDegrees: hueDistance * 180 / Math.PI,
        minimumChroma,
        maximumChroma,
        hasNeutralEndpoint
    };
}

function createAutomaticSegmentOptions(start, end) {
    const analysis = analyseSegment(start, end);
    let interpolationMode = 'oklch';
    let centralBalance = 0.16;
    let chromaReduction = 0;

    if (analysis.hasNeutralEndpoint) {
        // Preserves the coloured endpoint hue when entering or leaving white/grey.
        interpolationMode = 'oklch';
        centralBalance = 0.08;
    } else if (analysis.hueDegrees < 32) {
        // Similar hues remain cleaner and more predictable in OKLab.
        interpolationMode = 'oklab';
        centralBalance = 0;
    } else {
        // The more opposite the colours are, the stronger the centre damping.
        interpolationMode = 'oklch';
        centralBalance = clamp(
            0.10 + ((analysis.hueDegrees - 32) / 148) * 0.27,
            0.10,
            0.37
        );

        if (analysis.hueDegrees > 145 && analysis.minimumChroma > 0.08) {
            chromaReduction = 0.02;
        }
    }

    let points = Math.round(
        8 +
        analysis.labDistance * 24 +
        analysis.lightnessDistance * 8 +
        analysis.hueDegrees / 35
    );

    if (analysis.hueDegrees > 115) points += 3;
    if (analysis.maximumChroma > 0.22) points += 2;

    points = clamp(points, 8, 28);

    const midpointNormalization = clamp(
        0.70 + analysis.lightnessDistance * 0.35,
        0.70,
        0.92
    );

    const complexity =
        analysis.labDistance + analysis.hueDegrees / 180;

    // A very small amount of noise already helps in Automatic mode. The
    // endpoint boost also covers the solid-colour area that appears after
    // the gradient handle when the gradient is shortened inside the object.
    const antiBanding = clamp(
        0.00035 +
        analysis.labDistance * 0.00045 +
        analysis.lightnessDistance * 0.00035,
        0.00035,
        0.0015
    );

    const edgeBandingBoost = clamp(
        0.85 +
        analysis.lightnessDistance * 0.75 +
        analysis.hueDegrees / 180 * 0.55,
        0.85,
        1.80
    );

    const edgeStopBias = clamp(
        0.12 + complexity * 0.10,
        0.12,
        0.38
    );

    // Equalizes the perceptual speed of the colour change. This prevents regions
    // where the channels almost stop changing and form broad bands.
    const perceptualEqualization = clamp(
        0.76 + analysis.labDistance * 0.18 + analysis.hueDegrees / 180 * 0.08,
        0.76,
        0.96
    );

    // Makes the curve approach the start and end colours with a slope close to
    // zero. This is especially important when the gradient handle ends inside
    // the object and Affinity extends the final colour as a solid area.
    const endpointSoftness = clamp(
        0.80 + analysis.lightnessDistance * 0.16 + analysis.hueDegrees / 180 * 0.07,
        0.80,
        0.97
    );

    const endpointZone = clamp(
        0.22 + analysis.labDistance * 0.10,
        0.22,
        0.34
    );

    return {
        interpolationMode,
        points,
        midpointNormalization,
        perceptualEqualization,
        endpointSoftness,
        endpointZone,
        centralBalance,
        chromaReduction,
        antiBanding,
        edgeBandingBoost,
        edgeStopBias,
        complexity,
        analysis
    };
}

function createManualSegmentOptions(options) {
    return {
        interpolationMode: options.interpolationMode,
        points: options.pointsPerSegment,
        midpointNormalization: options.midpointNormalization,
        perceptualEqualization: options.perceptualEqualization,
        endpointSoftness: options.endpointSoftness,
        endpointZone: lerp(0.18, 0.34, options.endpointSoftness),
        centralBalance: options.centralBalance,
        chromaReduction: options.chromaReduction,
        antiBanding: options.antiBanding,
        edgeBandingBoost: options.edgeBandingBoost,
        edgeStopBias: clamp(
            0.10 +
            options.antiBanding * 4 +
            options.edgeBandingBoost * 0.04,
            0.10,
            0.42
        ),
        complexity: 1,
        analysis: null
    };
}

function allocateSegmentPoints(plans, originalStopCount) {
    const availableSlots = Math.max(0, MAX_TOTAL_STOPS - originalStopCount);
    const requestedTotal = plans.reduce(
        (total, plan) => total + plan.points,
        0
    );

    if (requestedTotal <= availableSlots) return plans;
    if (availableSlots === 0) {
        for (const plan of plans) plan.points = 0;
        return plans;
    }

    const scale = availableSlots / requestedTotal;
    let allocatedTotal = 0;

    for (const plan of plans) {
        plan.requestedPoints = plan.points;
        plan.scaledPoints = plan.points * scale;
        plan.points = Math.floor(plan.scaledPoints);
        allocatedTotal += plan.points;
    }

    let remaining = availableSlots - allocatedTotal;
    const ranked = plans
        .map((plan, index) => ({
            index,
            fraction: plan.scaledPoints - plan.points,
            complexity: plan.complexity
        }))
        .sort((a, b) =>
            b.fraction - a.fraction || b.complexity - a.complexity
        );

    for (let i = 0; i < ranked.length && remaining > 0; i++) {
        const plan = plans[ranked[i].index];
        if (plan.points < plan.requestedPoints) {
            plan.points += 1;
            remaining -= 1;
        }
    }

    return plans;
}

function createSegmentPlans(rawStops, options) {
    const plans = [];

    for (let i = 0; i < rawStops.length - 1; i++) {
        plans.push(
            options.automatic
                ? createAutomaticSegmentOptions(rawStops[i], rawStops[i + 1])
                : createManualSegmentOptions(options)
        );
    }

    return allocateSegmentPoints(plans, rawStops.length);
}

function computeSegmentLab(start, end, colourT, segmentOptions) {
    const centreWeight = 4 * colourT * (1 - colourT);
    const chromaFactor = 1 -
        segmentOptions.chromaReduction * centreWeight;

    if (segmentOptions.interpolationMode === 'oklch') {
        let startHue = start.lch.h;
        let endHue = end.lch.h;

        if (start.lch.C < 0.0005 && end.lch.C >= 0.0005) {
            startHue = endHue;
        } else if (end.lch.C < 0.0005 && start.lch.C >= 0.0005) {
            endHue = startHue;
        }

        const lch = {
            L: lerp(start.lch.L, end.lch.L, colourT),
            C: lerp(start.lch.C, end.lch.C, colourT) * chromaFactor,
            h: interpolateHueShortest(startHue, endHue, colourT)
        };

        const colourfulLab = gamutMapOklchToOklab(lch);
        const neutralLab = {
            L: lerp(start.lab.L, end.lab.L, colourT),
            a: lerp(start.lab.a, end.lab.a, colourT),
            b: lerp(start.lab.b, end.lab.b, colourT)
        };

        const centralInfluence = Math.pow(centreWeight, 1.25);
        const naturalBlend =
            segmentOptions.centralBalance * centralInfluence;

        return {
            L: colourfulLab.L,
            a: lerp(colourfulLab.a, neutralLab.a, naturalBlend),
            b: lerp(colourfulLab.b, neutralLab.b, naturalBlend)
        };
    }

    return {
        L: lerp(start.lab.L, end.lab.L, colourT),
        a: lerp(start.lab.a, end.lab.a, colourT) * chromaFactor,
        b: lerp(start.lab.b, end.lab.b, colourT) * chromaFactor
    };
}

function getLabDistance(first, second) {
    const dL = second.L - first.L;
    const da = second.a - first.a;
    const db = second.b - first.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

function buildPerceptualLookup(start, end, segmentOptions) {
    const sampleCount = 72;
    const cumulative = [0];
    let total = 0;
    let previous = computeSegmentLab(start, end, 0, segmentOptions);

    for (let i = 1; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const current = computeSegmentLab(start, end, t, segmentOptions);
        total += getLabDistance(previous, current);
        cumulative.push(total);
        previous = current;
    }

    if (total <= EPSILON) {
        return { cumulative, total: 0, sampleCount };
    }

    for (let i = 1; i < cumulative.length; i++) {
        cumulative[i] /= total;
    }

    return { cumulative, total, sampleCount };
}

function invertPerceptualProgress(lookup, progress) {
    const target = clamp(progress, 0, 1);
    if (!lookup || lookup.total <= EPSILON) return target;

    const values = lookup.cumulative;
    let low = 0;
    let high = values.length - 1;

    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle] < target) low = middle;
        else high = middle;
    }

    const startValue = values[low];
    const endValue = values[high];
    const local = endValue - startValue > EPSILON
        ? (target - startValue) / (endValue - startValue)
        : 0;

    return (low + local) / lookup.sampleCount;
}

function softenStartProgress(progress, amount, zone) {
    if (progress >= zone || zone <= EPSILON) return progress;

    const x = clamp(progress / zone, 0, 1);
    // Hermite: zero derivative at the start endpoint and derivative one when leaving the zone.
    const local = -x * x * x + 2 * x * x;
    const eased = zone * local;
    return lerp(progress, eased, amount);
}

function softenEndProgress(progress, amount, zone) {
    const start = 1 - zone;
    if (progress <= start || zone <= EPSILON) return progress;

    const x = clamp((progress - start) / zone, 0, 1);
    // Hermite: preserves the derivative when entering the zone and reaches zero derivative at the endpoint.
    const local = -x * x * x + x * x + x;
    const eased = start + zone * local;
    return lerp(progress, eased, amount);
}

function softenGlobalEndpointProgress(
    progress,
    segmentIndex,
    segmentCount,
    segmentOptions
) {
    let result = progress;
    const amount = clamp(segmentOptions.endpointSoftness, 0, 1);
    const zone = clamp(segmentOptions.endpointZone, 0.08, 0.42);

    if (segmentIndex === 0) {
        result = softenStartProgress(result, amount, zone);
    }

    if (segmentIndex === segmentCount - 1) {
        result = softenEndProgress(result, amount, zone);
    }

    return clamp(result, 0, 1);
}

function buildNaturalStops(rawStops, options) {
    if (rawStops.length < 2) {
        return { stops: rawStops, plans: [] };
    }

    const plans = createSegmentPlans(rawStops, options);
    const result = [];
    const segmentCount = rawStops.length - 1;

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
        const start = rawStops[segmentIndex];
        const end = rawStops[segmentIndex + 1];
        const segmentOptions = plans[segmentIndex];
        const pointsPerSegment = segmentOptions.points;
        const perceptualLookup = buildPerceptualLookup(
            start,
            end,
            segmentOptions
        );

        if (segmentIndex === 0) {
            result.push({
                colour: getOriginalStopColour(rawStops, plans, 0),
                position: start.position,
                midpoint: 0.5
            });
        }

        const span = end.position - start.position;
        if (span > EPSILON) {
            const softenedMidpoint = lerp(
                clamp(start.midpoint, 0.02, 0.98),
                0.5,
                segmentOptions.midpointNormalization
            );

            for (let pointIndex = 1; pointIndex <= pointsPerSegment; pointIndex++) {
                const spatialT = distributeStopPosition(
                    pointIndex,
                    pointsPerSegment,
                    segmentOptions.edgeStopBias
                );

                let progressT = mapThroughMidpoint(
                    spatialT,
                    softenedMidpoint
                );

                progressT = softenGlobalEndpointProgress(
                    progressT,
                    segmentIndex,
                    segmentCount,
                    segmentOptions
                );

                const equalizedT = invertPerceptualProgress(
                    perceptualLookup,
                    progressT
                );

                const colourT = lerp(
                    progressT,
                    equalizedT,
                    clamp(segmentOptions.perceptualEqualization, 0, 1)
                );

                const lab = computeSegmentLab(
                    start,
                    end,
                    colourT,
                    segmentOptions
                );

                const alpha = lerp(start.hslaf.alpha, end.hslaf.alpha, colourT);
                const inheritedNoise = lerp(start.noise, end.noise, colourT);

                // Uniform noise addresses quantization; the soft endpoint easing above
                // addresses the broad band created when the slope stops abruptly.
                const edgeWeight = Math.pow(
                    Math.abs(2 * spatialT - 1),
                    1.65
                );
                const antiBandingNoise = segmentOptions.antiBanding *
                    (1 + segmentOptions.edgeBandingBoost * 0.45 * edgeWeight);

                result.push({
                    colour: createGeneratedColour(
                        lab,
                        alpha,
                        inheritedNoise + antiBandingNoise
                    ),
                    position: lerp(start.position, end.position, spatialT),
                    midpoint: 0.5
                });
            }
        }

        result.push({
            colour: getOriginalStopColour(
                rawStops,
                plans,
                segmentIndex + 1
            ),
            position: end.position,
            midpoint: 0.5
        });
    }

    return { stops: result, plans };
}

function buildFillDescriptor(newStops, originalDescriptor, originalFill) {
    const gradient = Gradient.create(newStops);
    const fillWithNewGradient = originalFill.cloneWithNewGradient(gradient);

    return FillDescriptor.create(
        fillWithNewGradient,
        originalDescriptor.isScaleWithObject,
        originalDescriptor.transform,
        originalDescriptor.blendMode,
        originalDescriptor.isAnchoredToSpread
    );
}

// -----------------------------------------------------------------------------
// Interface and execution
// -----------------------------------------------------------------------------

function main() {
    const doc = Document.current;

    if (!doc) {
        showMessage(
            'Affinity Gradient Smoother',
            'No document is open.'
        );
        return;
    }

    if (doc.selection.length === 0) {
        showMessage(
            'Affinity Gradient Smoother',
            'Select an object or a text range that has a gradient.'
        );
        return;
    }

    if (doc.selection.length > 1) {
        showMessage(
            'Affinity Gradient Smoother',
            'Select only one object at a time. This prevents different gradients from being replaced with the same settings.'
        );
        return;
    }

    const rangeInfo = getMarkedTextRange(doc);
    const node = rangeInfo ? rangeInfo.node : doc.selection.at(0).node;
    const textNode = isTextNode(node);

    const dialog = Dialog.create('Affinity Gradient Smoother');
    dialog.initialWidth = 900;
    dialog.setIsResizable(true);

    // Three columns keep presets and controls visible without increasing the window height.
    const leftColumn = dialog.addColumn();
    const middleColumn = dialog.addColumn();
    const rightColumn = dialog.addColumn();

    const sourceGroup = leftColumn.addGroup(
        rangeInfo
            ? 'Gradient — text selection'
            : textNode
                ? 'Gradient — text'
                : 'Gradient'
    );

    const sourceRadio = sourceGroup.addRadioGroup(
        '',
        ['Fill', 'Stroke'],
        0
    );

    const presetGroup = leftColumn.addGroup('Quick preset');
    const presetRadio = presetGroup.addRadioGroup(
        '',
        PRESETS.map(preset => preset.name),
        PRESET_AUTOMATIC
    );

    const modeGroup = middleColumn.addGroup('Colour mixing');
    const interpolationModeRadio = modeGroup.addRadioGroup(
        '',
        [
            'OKLCH — preserve colours',
            'OKLab — neutral blend'
        ],
        0
    );

    const qualityGroup = middleColumn.addGroup('Transition');
    const pointsEditor = qualityGroup.addUnitValueEditor(
        'Extra stops',
        'none',
        'none',
        12,
        1,
        32
    );
    pointsEditor.value = 12;

    const midpointEditor = qualityGroup.addUnitValueEditor(
        'Midpoint correction (%)',
        'none',
        'none',
        75,
        0,
        100
    );
    midpointEditor.value = 75;

    const perceptualEditor = qualityGroup.addUnitValueEditor(
        'Perceptual equalization (%)',
        'none',
        'none',
        72,
        0,
        100
    );
    perceptualEditor.value = 72;

    const endpointEditor = qualityGroup.addUnitValueEditor(
        'Endpoint softness (%)',
        'none',
        'none',
        70,
        0,
        100
    );
    endpointEditor.value = 70;

    const colourGroup = rightColumn.addGroup('Natural look');
    const centralBalanceEditor = colourGroup.addUnitValueEditor(
        'Centre balance (%)',
        'none',
        'none',
        24,
        0,
        60
    );
    centralBalanceEditor.value = 24;

    const chromaEditor = colourGroup.addUnitValueEditor(
        'Saturation reduction (%)',
        'none',
        'none',
        0,
        0,
        35
    );
    chromaEditor.value = 0;

    const antiBandingEditor = colourGroup.addUnitValueEditor(
        'Anti-banding (%)',
        'none',
        'none',
        0,
        0,
        8
    );
    antiBandingEditor.value = 0;

    const edgeBandingEditor = colourGroup.addUnitValueEditor(
        'Edge boost (%)',
        'none',
        'none',
        100,
        0,
        300
    );
    edgeBandingEditor.value = 100;

    const actionGroup = rightColumn.addGroup('');
    const actionButtons = actionGroup.addButtonSet(
        '',
        ['Preview', 'Apply'],
        0
    );

    let applyingPreset = false;
    let lastPresetIndex = PRESET_AUTOMATIC;
    let lastControlSnapshot = '';

    function getControlSnapshot() {
        return [
            interpolationModeRadio.selectedIndex,
            pointsEditor.value,
            midpointEditor.value,
            perceptualEditor.value,
            endpointEditor.value,
            centralBalanceEditor.value,
            chromaEditor.value,
            antiBandingEditor.value,
            edgeBandingEditor.value
        ].join('|');
    }

    function updateControlState() {
        const isAutomatic =
            presetRadio.selectedIndex === PRESET_AUTOMATIC;
        const usesOklch = interpolationModeRadio.selectedIndex === 0;

        interpolationModeRadio.isEnabled = !isAutomatic;
        pointsEditor.isEnabled = !isAutomatic;
        midpointEditor.isEnabled = !isAutomatic;
        perceptualEditor.isEnabled = !isAutomatic;
        endpointEditor.isEnabled = !isAutomatic;
        centralBalanceEditor.isEnabled = !isAutomatic && usesOklch;
        chromaEditor.isEnabled = !isAutomatic;
        antiBandingEditor.isEnabled = !isAutomatic;
        edgeBandingEditor.isEnabled = !isAutomatic;
    }

    function applyPreset(presetIndex) {
        applyingPreset = true;
        const preset = PRESETS[presetIndex];

        if (preset && !preset.automatic && !preset.custom) {
            interpolationModeRadio.selectedIndex =
                preset.interpolationMode === 'oklch' ? 0 : 1;
            pointsEditor.value = preset.points;
            midpointEditor.value = preset.midpoint;
            perceptualEditor.value = preset.perceptualEqualization;
            endpointEditor.value = preset.endpointSoftness;
            centralBalanceEditor.value = preset.centralBalance;
            chromaEditor.value = preset.chromaReduction;
            antiBandingEditor.value = preset.antiBanding;
            edgeBandingEditor.value = preset.edgeBandingBoost;
        }

        lastPresetIndex = presetIndex;
        updateControlState();
        lastControlSnapshot = getControlSnapshot();
        applyingPreset = false;
    }

    function handleControlChanged() {
        if (applyingPreset) return;

        const currentPresetIndex = presetRadio.selectedIndex;
        if (currentPresetIndex !== lastPresetIndex) {
            applyPreset(currentPresetIndex);
            return;
        }

        const currentSnapshot = getControlSnapshot();
        if (
            currentSnapshot !== lastControlSnapshot &&
            currentPresetIndex !== PRESET_AUTOMATIC &&
            currentPresetIndex !== PRESET_CUSTOM
        ) {
            applyingPreset = true;
            presetRadio.selectedIndex = PRESET_CUSTOM;
            lastPresetIndex = PRESET_CUSTOM;
            applyingPreset = false;
        }

        updateControlState();
        lastControlSnapshot = getControlSnapshot();
    }

    dialog.setOnControlValueChangedHandler(handleControlChanged);
    applyPreset(PRESET_AUTOMATIC);

    let previewUndoCount = 0;

    while (true) {
        const result = dialog.runModal();

        if (!result || result.value !== DialogResult.Ok.value) {
            for (let i = 0; i < previewUndoCount; i++) {
                doc.undo();
            }
            break;
        }

        const useStroke = sourceRadio.selectedIndex === 1;
        const action = actionButtons.selectedIndex;

        let descriptor = getFillDescriptor(node, useStroke, rangeInfo);

        if (!descriptor || !descriptor.fill || descriptor.fill.fillType.value !== 3) {
            showMessage(
                'Affinity Gradient Smoother',
                useStroke
                    ? 'The selected stroke does not have a compatible gradient.'
                    : 'The selected fill does not have a compatible gradient.'
            );
            continue;
        }

        // Removes the previous preview before calculating a new version.
        for (let i = 0; i < previewUndoCount; i++) {
            doc.undo();
        }
        previewUndoCount = 0;

        descriptor = getFillDescriptor(node, useStroke, rangeInfo);
        const originalFill = descriptor.fill;
        const rawStops = readGradientStops(originalFill.gradient);

        if (rawStops.length < 2) {
            showMessage(
                'Affinity Gradient Smoother',
                'The gradient must have at least two colour stops.'
            );
            continue;
        }

        const selectedPresetIndex = presetRadio.selectedIndex;
        const options = {
            automatic: selectedPresetIndex === PRESET_AUTOMATIC,
            presetName: PRESETS[selectedPresetIndex]?.name || 'Custom',
            interpolationMode: interpolationModeRadio.selectedIndex === 0
                ? 'oklch'
                : 'oklab',
            pointsPerSegment: Math.round(clamp(pointsEditor.value, 1, 32)),
            midpointNormalization: clamp(midpointEditor.value / 100, 0, 1),
            perceptualEqualization: clamp(perceptualEditor.value / 100, 0, 1),
            endpointSoftness: clamp(endpointEditor.value / 100, 0, 1),
            centralBalance: clamp(centralBalanceEditor.value / 100, 0, 0.60),
            chromaReduction: clamp(chromaEditor.value / 100, 0, 0.35),
            antiBanding: clamp(antiBandingEditor.value / 100, 0, 0.08),
            edgeBandingBoost: clamp(
                edgeBandingEditor.value / 100,
                0,
                3
            )
        };

        const buildResult = buildNaturalStops(rawStops, options);
        const newStops = buildResult.stops;
        const newDescriptor = buildFillDescriptor(
            newStops,
            descriptor,
            originalFill
        );

        applyFillDescriptor(doc, newDescriptor, useStroke, rangeInfo);

        if (action === 0) {
            previewUndoCount = 1;
        } else {
            const oklchSegments = buildResult.plans.filter(
                plan => plan.interpolationMode === 'oklch'
            ).length;
            const oklabSegments = buildResult.plans.length - oklchSegments;
            const addedPoints = buildResult.plans.reduce(
                (total, plan) => total + plan.points,
                0
            );

            console.log(
                'Gradient smoothed | preset:',
                options.presetName,
                '| stops:',
                rawStops.length,
                '->',
                newStops.length,
                '| stops added:',
                addedPoints,
                '| OKLCH segments:',
                oklchSegments,
                '| OKLab segments:',
                oklabSegments
            );
            break;
        }
    }
}

try {
    main();
} catch (error) {
    console.log('Affinity Gradient Smoother error:', error);
    showMessage(
        'Affinity Gradient Smoother — error',
        String(error?.message || error)
    );
}
