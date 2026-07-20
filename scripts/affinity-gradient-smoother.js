/**
 * name: Affinity Gradient Smoother
 * description: Creates ultra-smooth natural gradients with Smooth, Perceptual, and Linear interpolation, text-safe geometry handling, clean endpoint spacing, live preview, anti-banding, and two-stop reset.
 * version: 2.5.1
 * author: Caio Sousa Design
 * contributors: Caio
 */

const { Dialog, DialogResult } = require('/dialog');
const { Document } = require('/document');
const { FillDescriptor } = require('/fills');
const { Gradient, Colour } = require('/colours');
const { DocumentCommand } = require('/commands');
const { StoryDelta } = require('/storydelta');
const { Selection } = require('/selections');

const MAX_TOTAL_STOPS = 96;
const EPSILON = 0.000001;

const INTERPOLATION_SMOOTH = 0;
const INTERPOLATION_PERCEPTUAL = 1;
const INTERPOLATION_LINEAR = 2;

const INTERPOLATION_METHODS = [
    'smooth',
    'perceptual',
    'linear'
];

const PRESET_AUTOMATIC = 0;
const PRESET_NATURAL = 1;
const PRESET_ULTRA_SMOOTH = 2;
const PRESET_VIBRANT = 3;
const PRESET_NEUTRAL = 4;
const PRESET_ANTI_BANDING = 5;

const PRESETS = [
    {
        name: 'Automatic',
        automatic: true,
        interpolationMode: 'oklch',
        smoothness: 94,
        naturalSoftness: 68,
        detail: 88,
        antiBanding: 0.08
    },
    {
        name: 'Natural',
        interpolationMode: 'oklch',
        smoothness: 90,
        naturalSoftness: 60,
        detail: 78,
        antiBanding: 0.06
    },
    {
        name: 'Ultra smooth',
        interpolationMode: 'oklch',
        smoothness: 99,
        naturalSoftness: 76,
        detail: 100,
        antiBanding: 0.10
    },
    {
        name: 'Vibrant',
        interpolationMode: 'oklch',
        smoothness: 84,
        naturalSoftness: 28,
        detail: 72,
        antiBanding: 0.04
    },
    {
        name: 'Neutral',
        interpolationMode: 'oklab',
        smoothness: 94,
        naturalSoftness: 100,
        detail: 84,
        antiBanding: 0.06
    },
    {
        name: 'Anti-banding',
        interpolationMode: 'oklch',
        smoothness: 96,
        naturalSoftness: 68,
        detail: 100,
        antiBanding: 0.22
    }
];

function clonePresetSettings(preset) {
    const source = preset || PRESETS[PRESET_AUTOMATIC];

    return {
        interpolationMode: source.interpolationMode,
        smoothness: source.smoothness,
        naturalSoftness: source.naturalSoftness,
        detail: source.detail,
        antiBanding: source.antiBanding
    };
}

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

function isGradientDescriptor(descriptor) {
    return !!(
        descriptor &&
        descriptor.fill &&
        descriptor.fill.fillType.value === 3
    );
}

function getNodeFillDescriptor(
    node,
    useStroke
) {
    // The fill interface is especially useful for text because it reports the
    // current object-level descriptor without depending on text sub-selections.
    try {
        const fillInterface = useStroke
            ? node.penFillInterface
            : node.brushFillInterface;

        if (fillInterface) {
            const descriptor =
                fillInterface
                    .getCurrentDescriptor(
                        false
                    );

            if (descriptor) {
                return {
                    descriptor,
                    source: 'node-fill-interface'
                };
            }
        }
    } catch (_) {}

    try {
        const descriptor = useStroke
            ? node.penFillDescriptor
            : node.brushFillDescriptor;

        if (descriptor) {
            return {
                descriptor,
                source: 'node-descriptor'
            };
        }
    } catch (_) {}

    return {
        descriptor: null,
        source: 'none'
    };
}

function getGlyphFillDescriptor(
    node,
    useStroke,
    rangeInfo
) {
    const story =
        node.storyInterface?.story;

    if (
        !story ||
        story.length === 0
    ) {
        return {
            descriptor: null,
            source: 'none'
        };
    }

    const glyphIndex = rangeInfo
        ? rangeInfo.startIndex
        : 0;

    const attributes =
        story.getGlyphAtts(
            glyphIndex
        );

    return {
        descriptor: useStroke
            ? attributes.penFill
            : attributes.brushFill,
        source: rangeInfo
            ? 'selected-glyph'
            : 'first-glyph'
    };
}

function getFillDescriptorBundle(
    node,
    useStroke,
    rangeInfo
) {
    const nodeResult =
        getNodeFillDescriptor(
            node,
            useStroke
        );

    if (!isTextNode(node)) {
        return {
            colourDescriptor:
                nodeResult.descriptor,
            geometryDescriptor:
                nodeResult.descriptor,
            colourSource:
                nodeResult.source,
            geometrySource:
                nodeResult.source
        };
    }

    const glyphResult =
        getGlyphFillDescriptor(
            node,
            useStroke,
            rangeInfo
        );

    // Text colours and stops are character formatting, so read them from the
    // glyph. Geometry is object-level; keeping it from the text object avoids
    // reapplying artboard/frame coordinate offsets as part of the glyph fill.
    const colourDescriptor =
        isGradientDescriptor(
            glyphResult.descriptor
        )
            ? glyphResult.descriptor
            : nodeResult.descriptor;

    const geometryDescriptor =
        isGradientDescriptor(
            nodeResult.descriptor
        )
            ? nodeResult.descriptor
            : colourDescriptor;

    return {
        colourDescriptor,
        geometryDescriptor,
        colourSource:
            isGradientDescriptor(
                glyphResult.descriptor
            )
                ? glyphResult.source
                : nodeResult.source,
        geometrySource:
            isGradientDescriptor(
                nodeResult.descriptor
            )
                ? nodeResult.source
                : (
                    isGradientDescriptor(
                        glyphResult.descriptor
                    )
                        ? glyphResult.source
                        : 'none'
                )
    };
}

function createCleanNodeSelection(
    doc,
    node
) {
    try {
        return Selection.create(
            doc,
            node
        );
    } catch (_) {
        return doc.selection;
    }
}

function applyFillDescriptor(
    doc,
    node,
    descriptor,
    useStroke,
    rangeInfo
) {
    if (rangeInfo) {
        const delta = useStroke
            ? StoryDelta.createPenFill(
                descriptor
            )
            : StoryDelta.createBrushFill(
                descriptor
            );

        doc.formatText(
            delta,
            doc.selection,
            false
        );

        return;
    }

    const targetSelection =
        createCleanNodeSelection(
            doc,
            node
        );

    const command = useStroke
        ? DocumentCommand.createSetPenFill(
            targetSelection,
            descriptor
        )
        : DocumentCommand.createSetBrushFill(
            targetSelection,
            descriptor
        );

    doc.executeCommand(command);
}

function clearDocumentPreviews(doc) {
    try {
        doc.executeCommand(
            DocumentCommand
                .createClearPreviews()
        );
    } catch (_) {}
}

// -----------------------------------------------------------------------------
// Colour conversion: HSL <-> sRGB <-> OKLab
// Oklab interpolation reduces abrupt lightness and saturation changes.
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

    // Preserves lightness and hue while reducing only the required chroma.
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
            rgb: hslToSrgb(hslaf),
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


function createGeneratedColourFromRgb(rgb, alpha, noise) {
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

function smoothstep01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

function smootherstep01(value) {
    const t = clamp(value, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothRange(value, start, end) {
    if (Math.abs(end - start) < EPSILON) {
        return value >= end ? 1 : 0;
    }

    return smoothstep01(
        (value - start) / (end - start)
    );
}

function cloneStopColourWithoutNoise(stop) {
    const colour = new Colour(stop.colourHandle);
    colour.noise = 0;
    return colour;
}

function buildTwoStopReset(rawStops) {
    if (rawStops.length < 2) return rawStops;

    const first = rawStops[0];
    const last = rawStops[rawStops.length - 1];

    return [
        {
            colour: cloneStopColourWithoutNoise(first),
            position: first.position,
            midpoint: 0.5
        },
        {
            colour: cloneStopColourWithoutNoise(last),
            position: last.position,
            midpoint: 0.5
        }
    ];
}

function shortestHueDistanceRadians(startHue, endHue) {
    const fullTurn = Math.PI * 2;
    let delta = Math.abs(endHue - startHue) % fullTurn;

    if (delta > Math.PI) {
        delta = fullTurn - delta;
    }

    return delta;
}

function analyseSegment(start, end) {
    const deltaL = end.lab.L - start.lab.L;
    const deltaA = end.lab.a - start.lab.a;
    const deltaB = end.lab.b - start.lab.b;

    const labDistance = Math.sqrt(
        deltaL * deltaL +
        deltaA * deltaA +
        deltaB * deltaB
    );

    const minimumChroma = Math.min(
        start.lch.C,
        end.lch.C
    );

    const maximumChroma = Math.max(
        start.lch.C,
        end.lch.C
    );

    const hasNeutralEndpoint =
        minimumChroma < 0.018;

    const hueDistance = hasNeutralEndpoint
        ? 0
        : shortestHueDistanceRadians(
            start.lch.h,
            end.lch.h
        );

    return {
        labDistance,
        lightnessDistance: Math.abs(deltaL),
        hueDegrees: hueDistance * 180 / Math.PI,
        minimumChroma,
        maximumChroma,
        hasNeutralEndpoint
    };
}

function interpolatePremultipliedScalar(
    startValue,
    startAlpha,
    endValue,
    endAlpha,
    t,
    alpha
) {
    if (alpha <= EPSILON) {
        return lerp(startValue, endValue, t);
    }

    return lerp(
        startValue * startAlpha,
        endValue * endAlpha,
        t
    ) / alpha;
}

function interpolateLinearLightRgb(
    start,
    end,
    t,
    alpha
) {
    const startAlpha = start.hslaf.alpha;
    const endAlpha = end.hslaf.alpha;

    const startLinear = {
        r: srgbChannelToLinear(start.rgb.r),
        g: srgbChannelToLinear(start.rgb.g),
        b: srgbChannelToLinear(start.rgb.b)
    };

    const endLinear = {
        r: srgbChannelToLinear(end.rgb.r),
        g: srgbChannelToLinear(end.rgb.g),
        b: srgbChannelToLinear(end.rgb.b)
    };

    const linearRgb = {
        r: interpolatePremultipliedScalar(
            startLinear.r,
            startAlpha,
            endLinear.r,
            endAlpha,
            t,
            alpha
        ),
        g: interpolatePremultipliedScalar(
            startLinear.g,
            startAlpha,
            endLinear.g,
            endAlpha,
            t,
            alpha
        ),
        b: interpolatePremultipliedScalar(
            startLinear.b,
            startAlpha,
            endLinear.b,
            endAlpha,
            t,
            alpha
        )
    };

    return {
        r: linearChannelToSrgb(linearRgb.r),
        g: linearChannelToSrgb(linearRgb.g),
        b: linearChannelToSrgb(linearRgb.b)
    };
}

function interpolateNeutralLab(
    start,
    end,
    t,
    alpha
) {
    const startAlpha = start.hslaf.alpha;
    const endAlpha = end.hslaf.alpha;

    return {
        L: interpolatePremultipliedScalar(
            start.lab.L,
            startAlpha,
            end.lab.L,
            endAlpha,
            t,
            alpha
        ),
        a: interpolatePremultipliedScalar(
            start.lab.a,
            startAlpha,
            end.lab.a,
            endAlpha,
            t,
            alpha
        ),
        b: interpolatePremultipliedScalar(
            start.lab.b,
            startAlpha,
            end.lab.b,
            endAlpha,
            t,
            alpha
        )
    };
}

function interpolateColourfulLab(
    start,
    end,
    t,
    alpha
) {
    const startAlpha = start.hslaf.alpha;
    const endAlpha = end.hslaf.alpha;

    let startHue = start.lch.h;
    let endHue = end.lch.h;

    if (
        start.lch.C < 0.0005 &&
        end.lch.C >= 0.0005
    ) {
        startHue = endHue;
    } else if (
        end.lch.C < 0.0005 &&
        start.lch.C >= 0.0005
    ) {
        endHue = startHue;
    }

    const lch = {
        L: interpolatePremultipliedScalar(
            start.lch.L,
            startAlpha,
            end.lch.L,
            endAlpha,
            t,
            alpha
        ),
        C: interpolatePremultipliedScalar(
            start.lch.C,
            startAlpha,
            end.lch.C,
            endAlpha,
            t,
            alpha
        ),
        h: interpolateHueShortest(
            startHue,
            endHue,
            t
        )
    };

    return {
        lch,
        lab: gamutMapOklchToOklab(lch)
    };
}

function applyEndpointColourProtection(
    rgb,
    start,
    end,
    colourT,
    segmentIndex,
    segmentCount,
    amount
) {
    const strength = clamp(amount, 0, 1);

    if (strength <= EPSILON) {
        return rgb;
    }

    let result = {
        r: rgb.r,
        g: rgb.g,
        b: rgb.b
    };

    // Keep this correction extremely local. Earlier versions pulled too many
    // generated colours toward the endpoint, creating a visible blue/orange
    // plateau. Stop spacing now performs most of the endpoint protection.
    const zone = 0.045;
    const maximumInfluence = 0.26;

    if (
        segmentIndex === 0 &&
        colourT < zone
    ) {
        const local =
            1 - colourT / zone;

        const weight =
            Math.pow(local, 3.1) *
            strength *
            maximumInfluence;

        result = {
            r: lerp(result.r, start.rgb.r, weight),
            g: lerp(result.g, start.rgb.g, weight),
            b: lerp(result.b, start.rgb.b, weight)
        };
    }

    if (
        segmentIndex === segmentCount - 1 &&
        colourT > 1 - zone
    ) {
        const local =
            (colourT - (1 - zone)) / zone;

        const weight =
            Math.pow(local, 3.1) *
            strength *
            maximumInfluence;

        result = {
            r: lerp(result.r, end.rgb.r, weight),
            g: lerp(result.g, end.rgb.g, weight),
            b: lerp(result.b, end.rgb.b, weight)
        };
    }

    return result;
}

function createAutomaticSegmentOptions(
    start,
    end,
    options
) {
    const analysis = analyseSegment(start, end);

    const smoothness = clamp(
        options.smoothnessStrength,
        0,
        1
    );

    const naturalSoftness = clamp(
        options.naturalSoftnessStrength,
        0,
        1
    );

    const detail = clamp(
        options.detailStrength,
        0,
        1
    );

    let interpolationMode = 'oklch';

    if (
        analysis.hueDegrees < 24 &&
        !analysis.hasNeutralEndpoint
    ) {
        interpolationMode = 'oklab';
    }

    const quality =
        smoothness * 0.58 +
        detail * 0.42;

    const opposition = smoothRange(
        analysis.hueDegrees,
        24,
        170
    );

    const requestedPoints = clamp(
        Math.round(
            lerp(9, 21, detail) +
            analysis.labDistance * 5 +
            opposition * 1.5
        ),
        9,
        24
    );

    const minimumPoints = clamp(
        Math.round(
            lerp(6, 10, detail) +
            analysis.labDistance
        ),
        6,
        11
    );

    return {
        interpolationMethod:
            options.interpolationMethod,
        interpolationMode,
        requestedPoints,
        minimumPoints,
        midpointNormalization: clamp(
            0.72 +
            smoothness * 0.18 +
            analysis.lightnessDistance * 0.08,
            0.72,
            0.96
        ),
        naturalSoftness,
        hueOpposition: opposition,
        hasNeutralEndpoint:
            analysis.hasNeutralEndpoint,
        curveTolerance: lerp(
            0.0095,
            0.0015,
            Math.pow(quality, 1.55)
        ),
        maximumPerceptualStep: lerp(
            0.074,
            0.020,
            Math.pow(quality, 1.28)
        ),
        perceptualDistribution: clamp(
            0.20 +
            detail * 0.14 +
            opposition * 0.04,
            0.20,
            0.38
        ),
        antiBanding: options.antiBanding,
        endpointProtection:
            options.protectShortenedEndpoints
                ? clamp(
                    0.70 + smoothness * 0.28,
                    0.76,
                    0.98
                )
                : 0,
        protectShortenedEndpoints:
            options.protectShortenedEndpoints,
        complexity:
            analysis.labDistance +
            opposition +
            analysis.lightnessDistance,
        analysis
    };
}

function createManualSegmentOptions(
    start,
    end,
    options
) {
    const analysis = analyseSegment(start, end);

    const smoothness = clamp(
        options.smoothnessStrength,
        0,
        1
    );

    const detail = clamp(
        options.detailStrength,
        0,
        1
    );

    const quality =
        smoothness * 0.58 +
        detail * 0.42;

    const opposition = smoothRange(
        analysis.hueDegrees,
        24,
        170
    );

    return {
        interpolationMethod:
            options.interpolationMethod,
        interpolationMode:
            options.interpolationMode,
        requestedPoints: clamp(
            Math.round(
                lerp(9, 21, detail) +
                analysis.labDistance * 4
            ),
            9,
            24
        ),
        minimumPoints: clamp(
            Math.round(
                lerp(6, 10, detail)
            ),
            6,
            11
        ),
        midpointNormalization: clamp(
            0.72 +
            smoothness * 0.19 +
            analysis.lightnessDistance * 0.07,
            0.72,
            0.96
        ),
        naturalSoftness: clamp(
            options.naturalSoftnessStrength,
            0,
            1
        ),
        hueOpposition: opposition,
        hasNeutralEndpoint:
            analysis.hasNeutralEndpoint,
        curveTolerance: lerp(
            0.0095,
            0.00145,
            Math.pow(quality, 1.58)
        ),
        maximumPerceptualStep: lerp(
            0.074,
            0.019,
            Math.pow(quality, 1.30)
        ),
        perceptualDistribution: clamp(
            0.20 +
            detail * 0.16 +
            opposition * 0.03,
            0.20,
            0.39
        ),
        antiBanding: options.antiBanding,
        endpointProtection:
            options.protectShortenedEndpoints
                ? clamp(
                    0.70 + smoothness * 0.28,
                    0.76,
                    0.98
                )
                : 0,
        protectShortenedEndpoints:
            options.protectShortenedEndpoints,
        complexity:
            analysis.labDistance +
            opposition +
            analysis.lightnessDistance,
        analysis
    };
}

function allocateSegmentPoints(
    plans,
    originalStopCount,
    protectShortenedEndpoints
) {
    // Balanced spacing protects the endpoints without inserting clusters.
    const endpointReserve = 0;

    const availableSlots = Math.max(
        0,
        MAX_TOTAL_STOPS -
        originalStopCount -
        endpointReserve
    );

    const requestedTotal = plans.reduce(
        (total, plan) =>
            total + plan.requestedPoints,
        0
    );

    if (requestedTotal <= availableSlots) {
        for (const plan of plans) {
            plan.points = plan.requestedPoints;
        }

        return plans;
    }

    if (availableSlots === 0) {
        for (const plan of plans) {
            plan.points = 0;
            plan.minimumPoints = 0;
        }

        return plans;
    }

    const scale =
        availableSlots / requestedTotal;

    let allocatedTotal = 0;

    for (const plan of plans) {
        plan.scaledPoints =
            plan.requestedPoints * scale;

        plan.points = Math.floor(
            plan.scaledPoints
        );

        plan.minimumPoints = Math.min(
            plan.minimumPoints,
            plan.points
        );

        allocatedTotal += plan.points;
    }

    let remaining =
        availableSlots - allocatedTotal;

    const ranked = plans
        .map((plan, index) => ({
            index,
            fraction:
                plan.scaledPoints - plan.points,
            complexity: plan.complexity
        }))
        .sort((a, b) =>
            b.fraction - a.fraction ||
            b.complexity - a.complexity
        );

    for (
        let i = 0;
        i < ranked.length && remaining > 0;
        i++
    ) {
        const plan =
            plans[ranked[i].index];

        if (
            plan.points <
            plan.requestedPoints
        ) {
            plan.points += 1;
            remaining -= 1;
        }
    }

    return plans;
}

function createSegmentPlans(
    rawStops,
    options
) {
    const plans = [];

    for (
        let i = 0;
        i < rawStops.length - 1;
        i++
    ) {
        plans.push(
            options.automatic
                ? createAutomaticSegmentOptions(
                    rawStops[i],
                    rawStops[i + 1],
                    options
                )
                : createManualSegmentOptions(
                    rawStops[i],
                    rawStops[i + 1],
                    options
                )
        );
    }

    return allocateSegmentPoints(
        plans,
        rawStops.length,
        options.protectShortenedEndpoints
    );
}

function deltaEOk(first, second) {
    const deltaL = first.L - second.L;
    const deltaA = first.a - second.a;
    const deltaB = first.b - second.b;

    return Math.sqrt(
        deltaL * deltaL +
        deltaA * deltaA +
        deltaB * deltaB
    );
}

function computeTargetSample(
    start,
    end,
    colourT,
    segmentIndex,
    segmentCount,
    segmentOptions
) {
    if (colourT <= EPSILON) {
        return {
            rgb: {
                r: start.rgb.r,
                g: start.rgb.g,
                b: start.rgb.b
            },
            lab: {
                L: start.lab.L,
                a: start.lab.a,
                b: start.lab.b
            },
            alpha: start.hslaf.alpha
        };
    }

    if (colourT >= 1 - EPSILON) {
        return {
            rgb: {
                r: end.rgb.r,
                g: end.rgb.g,
                b: end.rgb.b
            },
            lab: {
                L: end.lab.L,
                a: end.lab.a,
                b: end.lab.b
            },
            alpha: end.hslaf.alpha
        };
    }

    const alpha = lerp(
        start.hslaf.alpha,
        end.hslaf.alpha,
        colourT
    );

    const neutralLab =
        interpolateNeutralLab(
            start,
            end,
            colourT,
            alpha
        );

    if (
        segmentOptions.interpolationMethod ===
        'linear'
    ) {
        let rgb = interpolateLinearLightRgb(
            start,
            end,
            colourT,
            alpha
        );

        rgb = applyEndpointColourProtection(
            rgb,
            start,
            end,
            colourT,
            segmentIndex,
            segmentCount,
            segmentOptions.endpointProtection
        );

        return {
            rgb,
            lab: srgbToOklab(rgb),
            alpha
        };
    }

    if (
        segmentOptions.interpolationMethod ===
        'perceptual'
    ) {
        let rgb = oklabToSrgb(
            neutralLab
        );

        rgb = applyEndpointColourProtection(
            rgb,
            start,
            end,
            colourT,
            segmentIndex,
            segmentCount,
            segmentOptions.endpointProtection
        );

        return {
            rgb,
            lab: srgbToOklab(rgb),
            alpha
        };
    }

    // Smooth preserves the exact hybrid colour path used by version 2.4:
    // adaptive OKLCH with controlled OKLab influence around the centre.
    let lab = neutralLab;

    if (
        segmentOptions.interpolationMode ===
        'oklch'
    ) {
        const colourful =
            interpolateColourfulLab(
                start,
                end,
                colourT,
                alpha
            );

        const centreWeight = Math.pow(
            Math.max(
                0,
                4 * colourT * (1 - colourT)
            ),
            1.16
        );

        // Continuous Oklab fallback. Lower path chroma receives more Cartesian
        // influence; strongly opposed hues also receive a softer centre.
        const sigma = lerp(
            0.06,
            0.24,
            segmentOptions.naturalSoftness
        );

        const chromaFallback =
            sigma /
            (colourful.lch.C + sigma);

        const userBlend = lerp(
            0.05,
            0.46,
            segmentOptions.naturalSoftness
        );

        let naturalBlend =
            centreWeight *
            clamp(
                userBlend *
                (
                    0.30 +
                    0.70 *
                    segmentOptions.hueOpposition
                ) +
                chromaFallback * 0.20,
                0,
                0.58
            );

        if (
            segmentOptions.hasNeutralEndpoint
        ) {
            naturalBlend = Math.max(
                naturalBlend,
                centreWeight *
                chromaFallback *
                0.46
            );
        }

        lab = {
            L: colourful.lab.L,
            a: lerp(
                colourful.lab.a,
                neutralLab.a,
                naturalBlend
            ),
            b: lerp(
                colourful.lab.b,
                neutralLab.b,
                naturalBlend
            )
        };

        const chromaCompression =
            1 -
            centreWeight *
            segmentOptions.hueOpposition *
            segmentOptions.naturalSoftness *
            0.024;

        lab.a *= chromaCompression;
        lab.b *= chromaCompression;
    }

    let rgb = oklabToSrgb(lab);

    rgb = applyEndpointColourProtection(
        rgb,
        start,
        end,
        colourT,
        segmentIndex,
        segmentCount,
        segmentOptions.endpointProtection
    );

    return {
        rgb,
        lab: srgbToOklab(rgb),
        alpha
    };
}

function findPositionAtCumulative(
    cumulative,
    target
) {
    if (target <= 0) return 0;
    if (target >= 1) return 1;

    let low = 0;
    let high = cumulative.length - 1;

    while (low + 1 < high) {
        const middle = Math.floor(
            (low + high) / 2
        );

        if (
            cumulative[middle] <
            target
        ) {
            low = middle;
        } else {
            high = middle;
        }
    }

    const startValue =
        cumulative[low];

    const endValue =
        cumulative[high];

    const amount =
        endValue - startValue >
        EPSILON
            ? (
                target -
                startValue
            ) /
            (
                endValue -
                startValue
            )
            : 0;

    return (
        low + amount
    ) /
    (
        cumulative.length - 1
    );
}

function enforceBalancedSpacing(
    positions,
    protectShortenedEndpoints
) {
    const count = positions.length;

    if (count === 0) {
        return positions;
    }

    const uniformGap =
        1 / (count + 1);

    // Keep the first and last generated stops far enough from the exact
    // endpoint colours. This avoids a dense block of visually identical stops.
    const edgeGap =
        uniformGap *
        (
            protectShortenedEndpoints
                ? 0.82
                : 0.68
        );

    const minimumGap =
        uniformGap * 0.56;

    const result =
        positions.slice();

    for (
        let index = 0;
        index < count;
        index++
    ) {
        const lowerBound =
            edgeGap +
            index *
            minimumGap;

        const upperBound =
            1 -
            edgeGap -
            (
                count -
                index -
                1
            ) *
            minimumGap;

        result[index] = clamp(
            result[index],
            lowerBound,
            upperBound
        );

        if (index > 0) {
            result[index] = Math.max(
                result[index],
                result[index - 1] +
                minimumGap
            );
        }
    }

    for (
        let index = count - 2;
        index >= 0;
        index--
    ) {
        result[index] = Math.min(
            result[index],
            result[index + 1] -
                minimumGap
        );
    }

    return result;
}

function trimOuterGeneratedStops(
    positions,
    segmentIndex,
    segmentCount,
    protectShortenedEndpoints
) {
    const result =
        positions.slice();

    if (
        !protectShortenedEndpoints ||
        result.length < 6
    ) {
        return result;
    }

    // The native endpoint stop already supplies the exact colour. Removing the
    // nearest generated stop avoids the visible colour plateau confirmed in
    // manual testing.
    if (
        segmentIndex === 0 &&
        result.length > 0
    ) {
        result.shift();
    }

    if (
        segmentIndex ===
            segmentCount - 1 &&
        result.length > 0
    ) {
        result.pop();
    }

    return result;
}

function buildBalancedSpatialPositions(
    sampleAtSpatial,
    segmentOptions,
    segmentIndex,
    segmentCount
) {
    const pointCount =
        Math.max(
            0,
            segmentOptions.points
        );

    if (pointCount === 0) {
        return [];
    }

    const resolution = Math.max(
        192,
        pointCount * 16
    );

    const samples = [];

    for (
        let index = 0;
        index <= resolution;
        index++
    ) {
        samples.push(
            sampleAtSpatial(
                index / resolution
            )
        );
    }

    const cumulative = [0];
    let totalDistance = 0;

    for (
        let index = 1;
        index < samples.length;
        index++
    ) {
        totalDistance += deltaEOk(
            samples[index - 1].lab,
            samples[index].lab
        );

        cumulative.push(
            totalDistance
        );
    }

    if (totalDistance <= EPSILON) {
        return Array.from(
            {
                length: pointCount
            },
            (_, index) =>
                (
                    index + 1
                ) /
                (
                    pointCount + 1
                )
        );
    }

    for (
        let index = 0;
        index < cumulative.length;
        index++
    ) {
        cumulative[index] /=
            totalDistance;
    }

    const perceptualAmount = clamp(
        segmentOptions
            .perceptualDistribution,
        0,
        0.42
    );

    const positions = [];

    for (
        let index = 1;
        index <= pointCount;
        index++
    ) {
        const progress =
            index /
            (
                pointCount + 1
            );

        const uniformPosition =
            progress;

        const perceptualPosition =
            findPositionAtCumulative(
                cumulative,
                progress
            );

        // Mostly uniform spacing, with only a controlled amount of perceptual
        // redistribution. This retains natural colour speed without clustering.
        positions.push(
            lerp(
                uniformPosition,
                perceptualPosition,
                perceptualAmount
            )
        );
    }

    const balanced =
        enforceBalancedSpacing(
            positions,
            segmentOptions
                .protectShortenedEndpoints
        );

    return trimOuterGeneratedStops(
        balanced,
        segmentIndex,
        segmentCount,
        segmentOptions
            .protectShortenedEndpoints
    );
}

function buildNaturalStops(
    rawStops,
    options
) {
    if (rawStops.length < 2) {
        return {
            stops: rawStops,
            plans: []
        };
    }

    const plans =
        createSegmentPlans(
            rawStops,
            options
        );

    const result = [];
    const segmentCount =
        rawStops.length - 1;

    for (
        let segmentIndex = 0;
        segmentIndex < segmentCount;
        segmentIndex++
    ) {
        const start =
            rawStops[segmentIndex];

        const end =
            rawStops[segmentIndex + 1];

        const segmentOptions =
            plans[segmentIndex];

        if (segmentIndex === 0) {
            result.push({
                colour:
                    new Colour(
                        start.colourHandle
                    ),
                position: start.position,
                midpoint: 0.5
            });
        }

        const span =
            end.position - start.position;

        if (span > EPSILON) {
            const softenedMidpoint = lerp(
                clamp(
                    start.midpoint,
                    0.02,
                    0.98
                ),
                0.5,
                segmentOptions
                    .midpointNormalization
            );

            const sampleAtSpatial =
                spatialT => {
                    const colourT =
                        mapThroughMidpoint(
                            spatialT,
                            softenedMidpoint
                        );

                    return computeTargetSample(
                        start,
                        end,
                        colourT,
                        segmentIndex,
                        segmentCount,
                        segmentOptions
                    );
                };

            const spatialPositions =
                buildBalancedSpatialPositions(
                    sampleAtSpatial,
                    segmentOptions,
                    segmentIndex,
                    segmentCount
                );

            for (
                let sampleIndex = 0;
                sampleIndex <
                    spatialPositions.length;
                sampleIndex++
            ) {
                const spatialT =
                    spatialPositions[
                        sampleIndex
                    ];

                const colourT =
                    mapThroughMidpoint(
                        spatialT,
                        softenedMidpoint
                    );

                const sample =
                    computeTargetSample(
                        start,
                        end,
                        colourT,
                        segmentIndex,
                        segmentCount,
                        segmentOptions
                    );

                const inheritedNoise = lerp(
                    start.noise,
                    end.noise,
                    colourT
                );

                // Anti-banding remains subtle and fades to zero at both exact
                // endpoint colours. A tiny deterministic variation prevents
                // the generated stops from carrying an identical noise level.
                const ditherWindow = Math.pow(
                    Math.max(
                        0,
                        Math.sin(
                            Math.PI * colourT
                        )
                    ),
                    0.56
                );

                const noiseVariation =
                    0.92 +
                    0.08 *
                    Math.sin(
                        (
                            segmentIndex +
                            spatialT
                        ) *
                        Math.PI *
                        7.0
                    );

                const antiBandingNoise =
                    segmentOptions.antiBanding *
                    ditherWindow *
                    noiseVariation;

                result.push({
                    colour:
                        createGeneratedColourFromRgb(
                            sample.rgb,
                            sample.alpha,
                            inheritedNoise +
                                antiBandingNoise
                        ),
                    position: lerp(
                        start.position,
                        end.position,
                        spatialT
                    ),
                    midpoint: 0.5
                });
            }
        }

        result.push({
            colour:
                new Colour(
                    end.colourHandle
                ),
            position: end.position,
            midpoint: 0.5
        });
    }

    return {
        stops: result,
        plans
    };
}

function buildFillDescriptor(
    newStops,
    originalFill,
    geometryDescriptor
) {
    const gradient =
        Gradient.create(
            newStops
        );

    const fillWithNewGradient =
        originalFill
            .cloneWithNewGradient(
                gradient
            );

    return FillDescriptor.create(
        fillWithNewGradient,
        geometryDescriptor
            .isScaleWithObject,
        geometryDescriptor.transform,
        geometryDescriptor.blendMode,
        geometryDescriptor
            .isAnchoredToSpread
    );
}

// -----------------------------------------------------------------------------
// Interface and execution
// -----------------------------------------------------------------------------

function captureGradientState(
    node,
    useStroke,
    rangeInfo
) {
    const bundle =
        getFillDescriptorBundle(
            node,
            useStroke,
            rangeInfo
        );

    const colourDescriptor =
        bundle.colourDescriptor;

    const geometryDescriptor =
        bundle.geometryDescriptor;

    if (
        !isGradientDescriptor(
            colourDescriptor
        ) ||
        !geometryDescriptor
    ) {
        return null;
    }

    return {
        colourDescriptor,
        geometryDescriptor,
        fill:
            colourDescriptor.fill,
        rawStops:
            readGradientStops(
                colourDescriptor
                    .fill
                    .gradient
            ),
        useStroke,
        colourSource:
            bundle.colourSource,
        geometrySource:
            bundle.geometrySource
    };
}

function setPreviewDescriptor(
    doc,
    node,
    descriptor,
    useStroke,
    rangeInfo
) {
    if (rangeInfo) {
        const delta = useStroke
            ? StoryDelta.createPenFill(
                descriptor
            )
            : StoryDelta.createBrushFill(
                descriptor
            );

        doc.formatText(
            delta,
            doc.selection,
            true
        );

        return;
    }

    const targetSelection =
        createCleanNodeSelection(
            doc,
            node
        );

    const command = useStroke
        ? DocumentCommand.createSetPenFill(
            targetSelection,
            descriptor
        )
        : DocumentCommand.createSetBrushFill(
            targetSelection,
            descriptor
        );

    doc.executeCommand(
        command,
        true
    );
}

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
            'Select one object or a text range with a gradient.'
        );
        return;
    }

    if (doc.selection.length > 1) {
        showMessage(
            'Affinity Gradient Smoother',
            'Select only one object at a time.'
        );
        return;
    }

    const rangeInfo =
        getMarkedTextRange(doc);

    const node = rangeInfo
        ? rangeInfo.node
        : doc.selection.at(0).node;

    const textNode =
        isTextNode(node);

    const fillState =
        captureGradientState(
            node,
            false,
            rangeInfo
        );

    const strokeState =
        captureGradientState(
            node,
            true,
            rangeInfo
        );

    if (!fillState && !strokeState) {
        showMessage(
            'Affinity Gradient Smoother',
            'The selected object has no compatible gradient fill or stroke.'
        );
        return;
    }

    const dialog = Dialog.create(
        'Affinity Gradient Smoother 2.5.1'
    );

    dialog.initialWidth = 760;
    dialog.setIsResizable(true);

    const leftColumn =
        dialog.addColumn();

    const rightColumn =
        dialog.addColumn();

    const targetGroup =
        leftColumn.addGroup(
            rangeInfo
                ? 'Gradient — text selection'
                : textNode
                    ? 'Gradient — text'
                    : 'Gradient'
        );

    const sourceRadio =
        targetGroup.addRadioGroup(
            '',
            ['Fill', 'Stroke'],
            fillState ? 0 : 1
        );

    sourceRadio.isEnabled =
        !!fillState && !!strokeState;

    const actionGroup =
        leftColumn.addGroup('Action');

    const actionRadio =
        actionGroup.addRadioGroup(
            '',
            [
                'Smooth gradient',
                'Reset to two endpoint colours'
            ],
            0
        );

    const presetGroup =
        leftColumn.addGroup('Style');

    const presetRadio =
        presetGroup.addRadioGroup(
            '',
            PRESETS.map(
                preset => preset.name
            ),
            PRESET_AUTOMATIC
        );

    const interpolationGroup =
        leftColumn.addGroup(
            'Interpolation'
        );

    const interpolationRadio =
        interpolationGroup.addRadioGroup(
            '',
            [
                'Smooth — Recommended',
                'Perceptual — OKLab',
                'Linear — light'
            ],
            INTERPOLATION_SMOOTH
        );

    const tuningGroup =
        rightColumn.addGroup(
            'Fine tuning'
        );

    const smoothnessEditor =
        tuningGroup.addUnitValueEditor(
            'Smoothness (%)',
            'none',
            'none',
            PRESETS[
                PRESET_AUTOMATIC
            ].smoothness,
            50,
            100
        );

    const naturalSoftnessEditor =
        tuningGroup.addUnitValueEditor(
            'Colour softness (%)',
            'none',
            'none',
            PRESETS[
                PRESET_AUTOMATIC
            ].naturalSoftness,
            0,
            100
        );

    const detailEditor =
        tuningGroup.addUnitValueEditor(
            'Transition detail (%)',
            'none',
            'none',
            PRESETS[
                PRESET_AUTOMATIC
            ].detail,
            40,
            100
        );

    const antiBandingEditor =
        tuningGroup.addUnitValueEditor(
            'Anti-banding (%)',
            'none',
            'none',
            PRESETS[
                PRESET_AUTOMATIC
            ].antiBanding,
            0,
            3
        );

    const shortenedCheck =
        rightColumn
            .addGroup('Options')
            .addCheckBox(
                'Protect shortened gradient endpoints',
                true
            );

    const livePreviewCheck =
        rightColumn
            .addGroup('')
            .addCheckBox(
                'Live preview',
                true
            );

    const noteGroup =
        rightColumn.addGroup('');

    noteGroup.addStaticText(
        '',
        'Smooth keeps the current result; Perceptual and Linear are optional.'
    );

    noteGroup.addStaticText(
        '',
        'Use 0.05–0.30% normally; values up to 3% are available for difficult cases.'
    );

    let selectedSettings =
        clonePresetSettings(
            PRESETS[
                PRESET_AUTOMATIC
            ]
        );

    let previousPresetIndex =
        PRESET_AUTOMATIC;

    let suppressHandler = false;
    let refreshingPreview = false;

    function getSelectedState() {
        return (
            sourceRadio.selectedIndex === 1
                ? strokeState
                : fillState
        );
    }

    function restoreOriginalDescriptors() {
        clearDocumentPreviews(
            doc
        );
    }

    function updateControlState() {
        const state =
            getSelectedState();

        const resetMode =
            actionRadio.selectedIndex === 1;

        const resetAvailable =
            !!state &&
            state.rawStops.length > 2;

        if (
            resetMode &&
            !resetAvailable
        ) {
            suppressHandler = true;
            actionRadio.selectedIndex = 0;
            suppressHandler = false;
        }

        presetRadio.isEnabled =
            !resetMode;

        smoothnessEditor.isEnabled =
            !resetMode;

        interpolationRadio.isEnabled =
            !resetMode;

        naturalSoftnessEditor.isEnabled =
            !resetMode &&
            interpolationRadio.selectedIndex ===
                INTERPOLATION_SMOOTH;

        detailEditor.isEnabled =
            !resetMode;

        antiBandingEditor.isEnabled =
            !resetMode;

        shortenedCheck.isEnabled =
            !resetMode;
    }

    function applyPresetDefaults(index) {
        const preset = PRESETS[index];

        selectedSettings =
            clonePresetSettings(preset);

        suppressHandler = true;

        smoothnessEditor.value =
            preset.smoothness;

        naturalSoftnessEditor.value =
            preset.naturalSoftness;

        detailEditor.value =
            preset.detail;

        antiBandingEditor.value =
            preset.antiBanding;

        previousPresetIndex = index;

        suppressHandler = false;
    }

    function buildCurrentDescriptor() {
        const state =
            getSelectedState();

        if (!state) return null;

        if (
            actionRadio.selectedIndex === 1
        ) {
            const resetStops =
                buildTwoStopReset(
                    state.rawStops
                );

            return {
                state,
                descriptor:
                    buildFillDescriptor(
                        resetStops,
                        state.fill,
                        state.geometryDescriptor
                    )
            };
        }

        const presetIndex =
            presetRadio.selectedIndex;

        const options = {
            automatic:
                presetIndex ===
                PRESET_AUTOMATIC,
            interpolationMethod:
                INTERPOLATION_METHODS[
                    interpolationRadio
                        .selectedIndex
                ],
            interpolationMode:
                selectedSettings
                    .interpolationMode,
            smoothnessStrength:
                smoothnessEditor.value /
                100,
            naturalSoftnessStrength:
                naturalSoftnessEditor
                    .value /
                100,
            detailStrength:
                detailEditor.value /
                100,
            antiBanding:
                antiBandingEditor.value /
                100,
            protectShortenedEndpoints:
                !!shortenedCheck.value
        };

        const buildResult =
            buildNaturalStops(
                state.rawStops,
                options
            );

        return {
            state,
            buildResult,
            descriptor:
                buildFillDescriptor(
                    buildResult.stops,
                    state.fill,
                    state.geometryDescriptor
                )
        };
    }

    function refreshLivePreview(force) {
        if (refreshingPreview) {
            return;
        }

        if (
            !force &&
            !livePreviewCheck.value
        ) {
            restoreOriginalDescriptors();
            return;
        }

        const built =
            buildCurrentDescriptor();

        if (!built) {
            restoreOriginalDescriptors();
            return;
        }

        refreshingPreview = true;

        try {
            restoreOriginalDescriptors();

            setPreviewDescriptor(
                doc,
                node,
                built.descriptor,
                built.state.useStroke,
                rangeInfo
            );
        } finally {
            refreshingPreview = false;
        }
    }

    function handleControlChanged() {
        if (suppressHandler) {
            return;
        }

        const currentPresetIndex =
            presetRadio.selectedIndex;

        if (
            currentPresetIndex !==
            previousPresetIndex
        ) {
            applyPresetDefaults(
                currentPresetIndex
            );
        }

        updateControlState();

        if (livePreviewCheck.value) {
            refreshLivePreview(false);
        } else {
            restoreOriginalDescriptors();
        }
    }

    dialog.setOnControlValueChangedHandler(
        handleControlChanged
    );

    applyPresetDefaults(
        PRESET_AUTOMATIC
    );

    updateControlState();
    refreshLivePreview(true);

    const result =
        dialog.runModal();

    if (
        !result ||
        result.value !==
            DialogResult.Ok.value
    ) {
        restoreOriginalDescriptors();
        return;
    }

    const built =
        buildCurrentDescriptor();

    if (!built) {
        restoreOriginalDescriptors();

        showMessage(
            'Affinity Gradient Smoother',
            'The selected target does not have a compatible gradient.'
        );

        return;
    }

    restoreOriginalDescriptors();

    applyFillDescriptor(
        doc,
        node,
        built.descriptor,
        built.state.useStroke,
        rangeInfo
    );

    if (
        actionRadio.selectedIndex === 1
    ) {
        console.log(
            'Gradient reset to the current endpoint colours.'
        );
    } else {
        const generatedStops =
            built.buildResult.stops.length;

        console.log(
            'Gradient smoothed | style:',
            PRESETS[
                presetRadio.selectedIndex
            ].name,
            '| interpolation:',
            INTERPOLATION_METHODS[
                interpolationRadio
                    .selectedIndex
            ],
            '| total stops:',
            generatedStops,
            '| colour source:',
            built.state.colourSource,
            '| geometry source:',
            built.state.geometrySource,
            '| target:',
            rangeInfo
                ? 'marked-text-range'
                : textNode
                    ? 'whole-text-node'
                    : 'object'
        );
    }
}

try {
    main();
} catch (error) {
    console.log(
        'Affinity Gradient Smoother error:',
        error
    );

    showMessage(
        'Affinity Gradient Smoother — error',
        String(
            error?.message || error
        )
    );
}
