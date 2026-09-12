/**
 * name: swiss_calendar_creator
 * description: Calendar generator for Affinity Designer/Publisher/Photo in the International Typographic Style -- Year / Month / Week / Day views, English or Spanish, strict grid, hairline rules, one accent ink. Draws into the selected artboard, or a rectangle/frame inside one.
 * version: 1.0.0
 * author: Victor Crespo (3dvic.com · github.com/vicc3d)
 * license: MIT
 */
'use strict';

// ============================================================================
//  Swiss Calendar Creator  --  Affinity (Designer / Publisher) 2.5+
//  Victor Crespo -- 3dvic.com -- github.com/vicc3d/swiss-calendar-creator
//  MIT License
// ----------------------------------------------------------------------------
//  Select an ARTBOARD (the calendar fills its surface) or a rectangle / frame
//  inside one (the calendar fills that shape), then run the script. First pick
//  the language (interface + calendar content), then the view (Year / Month /
//  Week / Day) and the settings. With several artboards, each one can carry
//  its own calendar.
//
//  International Typographic Style: strict grid, flush-left sans-serif,
//  hairline rules, generous whitespace, a single accent ink.
//
//  The dialog uses collapsible sections (a header with a ▶/▼ arrow, or a
//  switch if you change SECTION_HEADER). Everything is created inside one
//  container layer.
// ============================================================================

const { Document } = require('/document');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { UnitType } = require('/units');
const { AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition, ShapeNodeDefinition, FrameTextNodeDefinition } = require('/nodes');
const { Selection } = require('/selections');
const { ShapeRectangle } = require('/shapes');
const { Rectangle } = require('/geometry');
const { StoryBuilder } = require('/storybuilder');
const { Font, FontFamily } = require('/fonts');
const { FillDescriptor } = require('/fills');
const { RGB8 } = require('/colours');
const { ParagraphAlignXType } = require('/paragraphatts');

// Header style for the collapsible sections:
//   'arrow'  -> button with a ▶ / ▼ triangle (accordion style)
//   'switch' -> on/off toggle
const SECTION_HEADER = 'arrow';

// ----------------------------------------------------------------------------
//  Languages  --  calendar content + interface strings
// ----------------------------------------------------------------------------
const STR = {
    es: {
        // --- calendar content ---
        months: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
                 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
        daysLong:  ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'],
        daysShort: ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'],
        daysMini:  ['L', 'M', 'M', 'J', 'V', 'S', 'D'],
        week: 'SEMANA',
        weekAbbr: 'SEM',
        // --- interface ---
        ui: {
            title: 'Swiss Calendar Creator',
            secType: 'Tipo de calendario',
            view: 'Vista',
            views: ['Año', 'Mes', 'Semana', 'Día'],
            secDate: 'Fecha',
            year: 'Año',
            month: 'Mes',
            day: 'Día (semana / día)',
            weekStart: 'La semana empieza en',
            weekStartOpts: ['Lunes', 'Domingo'],
            weekNumMode: 'Numeración de semanas',
            weekNumModeOpts: ['ISO 8601', 'Desde 1'],
            secElements: 'Elementos',
            header: 'Encabezado de días',
            grid: 'Filetes de retícula (Mes)',
            verticals: 'Líneas verticales',
            adjacent: 'Días de meses contiguos (Mes)',
            weekNumbers: 'Números de semana (Mes)',
            boldWeekend: 'Fines de semana en negrita',
            markToday: 'Marcar el día de hoy',
            accentBar: 'Barra de acento en el título',
            secAgenda: 'Agenda (vista Día)',
            agendaShow: 'Mostrar franjas horarias',
            agendaFrom: 'Desde (h)',
            agendaTo: 'Hasta (h)',
            timeFormat: 'Formato de hora',
            timeFormatOpts: ['12 h', '24 h'],
            secStyle: 'Estilo',
            font: 'Tipografía',
            ink: 'Tinta principal',
            accent: 'Acento',
            ruleColour: 'Filetes',
            muted: 'Días atenuados',
            noDoc: 'Abre un documento primero.',
            noSel: 'Selecciona un artboard (el calendario llenará su superficie) o un rectángulo/marco dentro de él que defina el área.',
            reSel: 'La selección forma parte de un calendario ya creado.\n\nHaz clic en el artboard —o en un rectángulo/marco dentro de él— donde quieras el nuevo calendario, y vuelve a ejecutar el script.',
            errPrefix: 'Error en Swiss Calendar Creator:\n',
            calName: 'Calendario',
            targetPrefix: 'Se dibujará en:  ',
            targetDoc: 'el documento (sin artboards)',
            targetShapeIn: 'la forma seleccionada en ',
            tips: {
                view: 'Año = 12 mini-meses · Mes = cuadrícula del mes · Semana = 7 columnas · Día = una jornada.',
                secDate: 'Qué fecha representa el calendario.',
                year: 'Año del calendario.',
                month: 'Mes a dibujar. También fija el mes de referencia para las vistas Semana y Día.',
                day: 'Día del mes. En la vista Semana indica qué semana mostrar; en la vista Día, qué día.',
                weekStart: 'Primera columna de la semana: lunes (Europa/ISO) o domingo (EE. UU.).',
                weekNumMode: 'Cómo se numera la columna SEM.  ·  ISO 8601 (norma internacional): semanas de lunes a domingo; la semana 1 es la que contiene el primer jueves del año, así que la fila parcial de principios de enero suele ser la semana 52 o 53 del año anterior. Ejemplo: en 2027 la primera fila es la semana 53 de 2026 y el lunes 4 de enero empieza la semana 1. Es lo que usan la mayoría de calendarios europeos y el software de oficina.  ·  Desde 1 (agendas y calendarios comerciales): la semana 1 es simplemente la que contiene el 1 de enero, y a partir de ahí se cuenta 1, 2, 3… hasta fin de año; nunca aparece un 52/53 al principio. Los días de diciembre que comparten fila con enero también cuentan como semana 1.',
                secElements: 'Qué se dibuja y qué se resalta.',
                header: 'Fila con las abreviaturas de los días (LUN, MAR…) sobre la cuadrícula.',
                grid: 'Líneas horizontales finas que separan las semanas (solo vista Mes).',
                verticals: 'Añade también líneas verticales entre las columnas de días.',
                adjacent: 'Rellena los huecos del principio y el final con los días del mes anterior y siguiente, atenuados.',
                weekNumbers: 'Columna "SEM" a la izquierda con el número de semana de cada fila (según "Numeración de semanas").',
                boldWeekend: 'Pone en negrita los números de sábado y domingo (además del color de acento).',
                markToday: 'Resalta la fecha de hoy: color de acento, negrita y una barra debajo.',
                accentBar: 'Línea corta y gruesa en color de acento bajo el título (detalle de diseño suizo).',
                secAgenda: 'Franjas de horas para la vista Día.',
                agendaShow: 'En la vista Día, añade franjas horarias con filetes y etiquetas de hora. En un área apaisada, la fecha va a la izquierda y las horas ocupan la columna derecha.',
                agendaFrom: 'Hora de inicio de la agenda (0–23).',
                agendaTo: 'Hora de fin de la agenda (1–24).',
                timeFormat: 'Cómo se rotulan las horas de la agenda: 12 h (8 AM, 1 PM…) o 24 h (08:00, 13:00…).',
                secStyle: 'Tipografía y paleta del calendario. Por defecto, estética suiza: negro y una única tinta de acento.',
                font: 'Familia tipográfica del calendario. Se eligen solos los pesos Regular, Medium y Bold. Por defecto una de palo seco (Helvetica/Inter/Arial…).',
                ink: 'Color principal del texto y de los filetes fuertes.',
                accent: 'Tinta única de acento: fines de semana, hoy, barra del título y cabecera de números de semana.',
                ruleColour: 'Color de los filetes finos de la cuadrícula.',
                muted: 'Color de los días atenuados (meses contiguos, números de semana).'
            }
        }
    },
    en: {
        months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                 'August', 'September', 'October', 'November', 'December'],
        daysLong:  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        daysShort: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
        daysMini:  ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
        week: 'WEEK',
        weekAbbr: 'WK',
        ui: {
            title: 'Swiss Calendar Creator',
            secType: 'Calendar type',
            view: 'View',
            views: ['Year', 'Month', 'Week', 'Day'],
            secDate: 'Date',
            year: 'Year',
            month: 'Month',
            day: 'Day (week / day)',
            weekStart: 'Week starts on',
            weekStartOpts: ['Monday', 'Sunday'],
            weekNumMode: 'Week numbering',
            weekNumModeOpts: ['ISO 8601', 'From 1'],
            secElements: 'Elements',
            header: 'Weekday header',
            grid: 'Grid rules (Month)',
            verticals: 'Vertical lines',
            adjacent: 'Adjacent-month days (Month)',
            weekNumbers: 'Week numbers (Month)',
            boldWeekend: 'Bold weekends',
            markToday: 'Mark today',
            accentBar: 'Accent bar under title',
            secAgenda: 'Agenda (Day view)',
            agendaShow: 'Show hour slots',
            agendaFrom: 'From (h)',
            agendaTo: 'To (h)',
            timeFormat: 'Time format',
            timeFormatOpts: ['12 h', '24 h'],
            secStyle: 'Style',
            font: 'Typeface',
            ink: 'Primary ink',
            accent: 'Accent',
            ruleColour: 'Rules',
            muted: 'Dimmed days',
            noDoc: 'Open a document first.',
            noSel: 'Select an artboard (the calendar fills it) or a rectangle/frame inside it that defines the area.',
            reSel: 'The selection is part of a calendar you already created.\n\nClick the artboard — or a rectangle/frame inside it — where you want the new calendar, then run the script again.',
            errPrefix: 'Swiss Calendar Creator error:\n',
            calName: 'Calendar',
            targetPrefix: 'Will be drawn on:  ',
            targetDoc: 'the document (no artboards)',
            targetShapeIn: 'the selected shape in ',
            tips: {
                view: 'Year = 12 mini-months · Month = month grid · Week = 7 columns · Day = a single day.',
                secDate: 'Which date the calendar represents.',
                year: 'Calendar year.',
                month: 'Month to draw. Also sets the reference month for the Week and Day views.',
                day: 'Day of the month. In the Week view it picks which week to show; in the Day view, which day.',
                weekStart: 'First column of the week: Monday (Europe/ISO) or Sunday (US).',
                weekNumMode: 'How the WK column is numbered.  ·  ISO 8601 (international standard): Monday-to-Sunday weeks; week 1 is the one containing the year\'s first Thursday, so the partial row at the start of January is usually week 52 or 53 of the previous year. Example: for 2027 the first row is week 53 of 2026, and week 1 begins on Monday 4 January. This is what most European calendars and office software use.  ·  From 1 (commercial planners and calendars): week 1 is simply the one containing January 1, then it counts 1, 2, 3… to year end; you never get a 52/53 at the start. December days sharing a row with January are also counted as week 1.',
                secElements: 'What gets drawn and what gets emphasised.',
                header: 'Row of weekday abbreviations (MON, TUE…) above the grid.',
                grid: 'Thin horizontal rules separating the weeks (Month view only).',
                verticals: 'Also add vertical rules between the day columns.',
                adjacent: 'Fill the leading and trailing gaps with the previous/next month days, dimmed.',
                weekNumbers: '"WK" column on the left with the week number of each row (per "Week numbering").',
                boldWeekend: 'Set Saturday and Sunday numbers in bold (on top of the accent colour).',
                markToday: "Highlight today's date: accent colour, bold and a bar underneath.",
                accentBar: 'Short thick accent-coloured rule under the title (Swiss design detail).',
                secAgenda: 'Hour slots for the Day view.',
                agendaShow: 'In the Day view, add hour slots with rules and time labels. On a landscape area the date sits on the left and the hours fill the right column.',
                agendaFrom: 'Agenda start hour (0–23).',
                agendaTo: 'Agenda end hour (1–24).',
                timeFormat: 'How agenda hours are labelled: 12 h (8 AM, 1 PM…) or 24 h (08:00, 13:00…).',
                secStyle: 'Calendar typeface and palette. Default look: black plus a single accent ink.',
                font: 'Calendar typeface. Regular, Medium and Bold weights are chosen automatically. Defaults to a sans-serif (Helvetica/Inter/Arial…).',
                ink: 'Main colour for text and the strong rules.',
                accent: 'Single accent ink: weekends, today, title bar and the week-number header.',
                ruleColour: 'Colour of the thin grid rules.',
                muted: 'Colour of the dimmed days (adjacent months, week numbers).'
            }
        }
    }
};

// ----------------------------------------------------------------------------
//  Date utilities
// ----------------------------------------------------------------------------
function daysInMonth(year, month /*0-11*/) {
    return new Date(year, month + 1, 0).getDate();
}

function columnOf(jsDay, weekStartsMonday) {
    return weekStartsMonday ? (jsDay + 6) % 7 : jsDay;
}

// ISO-8601 week number
function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round((d - firstThursday) / 604800000);
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
}

// ----------------------------------------------------------------------------
//  Typography  --  resolves a sans-serif family and its weights
// ----------------------------------------------------------------------------
function pickFace(family, wantBold, wantMedium) {
    const faces = family.fonts.filter(f => !f.isItalic);
    const upright = faces.filter(f => !f.isCondensed && !f.isExpanded);
    const pool = upright.length ? upright : faces;
    const byDist = (target) => pool.slice().sort((a, b) =>
        Math.abs(a.weight - target) - Math.abs(b.weight - target))[0];
    if (wantBold)   return byDist(700) || pool[0];
    if (wantMedium) return byDist(500) || pool[0];
    return byDist(400) || pool[0];
}

function resolveFonts(preferredNameOrFamily) {
    let family = null;
    if (preferredNameOrFamily && preferredNameOrFamily.fonts) {
        family = preferredNameOrFamily;
    } else {
        const wanted = preferredNameOrFamily
            ? [String(preferredNameOrFamily)]
            : ['Helvetica Neue', 'Helvetica', 'Neue Haas Grotesk', 'Aktiv Grotesk',
               'Univers', 'Inter', 'Arial', 'Roboto'];
        // Keep symbol/dingbat/mono families out of the fuzzy match
        // (e.g. "Univers" must not capture "UniversalMath1 BT").
        const isText = f => !/math|symbol|dingbat|wing ?ding|web ?ding|emoji|icon|ornament|mono|slab/i.test(f.name);
        const all = FontFamily.all;
        for (const w of wanted) {
            family = all.find(f => f.name.toLowerCase() === w.toLowerCase());
            if (family) break;
        }
        if (!family) for (const w of wanted) {
            family = all.find(f => isText(f) && f.name.toLowerCase().includes(w.toLowerCase()));
            if (family) break;
        }
    }
    if (!family) {
        const def = Font.createDefault();
        return { regular: def, medium: def, bold: def, familyName: def.familyName };
    }
    return {
        regular: pickFace(family, false, false),
        medium:  pickFace(family, false, true),
        bold:    pickFace(family, true,  false),
        familyName: family.name
    };
}

// ----------------------------------------------------------------------------
//  Node builders
// ----------------------------------------------------------------------------
function makeBuilders(doc) {
    const pxPerPt = doc.dpi / 72;
    const fmt = doc.format;

    function rect(builder, x, y, w, h, colour) {
        if (w <= 0 || h <= 0) return;
        const def = ShapeNodeDefinition.create(
            ShapeRectangle.create(), new Rectangle(x, y, w, h), colour);
        builder.addShapeNode(def);
    }

    function rule(builder, x, y, w, thickness, colour) {
        rect(builder, x, y - thickness / 2, w, thickness, colour);
    }
    function vrule(builder, x, y, h, thickness, colour) {
        rect(builder, x - thickness / 2, y, thickness, h, colour);
    }

    // Frame text (font + size + colour + alignment already baked in)
    function text(builder, x, y, w, h, str, face, sizePx, colour, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        const ga = sb.glyphAtts;
        ga.height = sizePx;
        if (face) ga.font = face;
        ga.brushFill = FillDescriptor.createSolid(colour);
        sb.setGlyphAtts(ga);
        const pa = sb.paragraphAtts;
        pa.alignXType = align || ParagraphAlignXType.Left;
        sb.setParagraphAtts(pa);
        sb.addText(String(str));
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }

    // Multi-style text on a single line (e.g. month/year in bold followed by
    // the week number in dimmed regular). `runs` is a list of
    // { text, face, colour, size? }.
    function richText(builder, x, y, w, h, runs, sizePx, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        const pa = sb.paragraphAtts;
        pa.alignXType = align || ParagraphAlignXType.Left;
        sb.setParagraphAtts(pa);
        for (const r of runs) {
            const ga = sb.glyphAtts;
            ga.height = r.size || sizePx;
            if (r.face) ga.font = r.face;
            ga.brushFill = FillDescriptor.createSolid(r.colour);
            sb.setGlyphAtts(ga);
            sb.addText(String(r.text));
        }
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }

    return { rect, rule, vrule, text, richText, pxPerPt };
}

// ----------------------------------------------------------------------------
//  View: MONTH
// ----------------------------------------------------------------------------
function drawMonth(B, area, cfg, L) {
    const { rect, rule, vrule, text } = B;
    const { year, month, weekStartsMonday, showGrid, showVerticals, showHeader,
            boldWeekend, showAdjacent, showWeekNumbers, weekNumberIso, showAccentBar,
            today, C } = cfg;

    const margin = Math.min(area.w, area.h) * 0.055;
    const gx = area.x + margin;
    const gy0 = area.y + margin;
    const gw = area.w - margin * 2;

    const titleSize = area.w * 0.052;
    const titleH = titleSize * 1.25;
    text(B.b, gx, gy0, gw * 0.8, titleH * 1.6,
         L.months[month].toUpperCase(), cfg.fonts.bold, titleSize, C.ink);
    text(B.b, gx, gy0 + titleH * 0.02, gw, titleH * 1.6,
         String(year), cfg.fonts.regular, titleSize, C.ink, ParagraphAlignXType.Right);
    if (showAccentBar) {
        rect(B.b, gx, gy0 + titleH * 1.45, titleSize * 1.5,
             Math.max(area.w * 0.006, 3), C.accent);
    }

    const wkColW = showWeekNumbers ? Math.max(margin, gw * 0.05) : 0;
    const wkGap  = showWeekNumbers ? gw * 0.018 : 0;
    const gridX = gx + wkColW + wkGap;
    const gridW = gw - wkColW - wkGap;
    const colW = gridW / 7;

    const first = new Date(year, month, 1);
    const startCol = columnOf(first.getDay(), weekStartsMonday);
    const dim = daysInMonth(year, month);
    const numWeeks = Math.ceil((startCol + dim) / 7);

    const gridTop = gy0 + titleH * 2.0;
    const gridBottom = area.y + area.h - margin;

    const hair = Math.max(area.w * 0.0012, 1);
    const hairStrong = hair * 2;
    const inset = colW * 0.08;
    // Weekday header: size tied to the body text, with enough air above the
    // strong top rule of the grid.
    const headSize = Math.max(colW * 0.185, area.w * 0.013);
    const headerH = showHeader ? headSize * 2.3 : 0;
    const bodyTop = gridTop + headerH;
    const rowH = (gridBottom - bodyTop) / numWeeks;
    const daySize = Math.min(rowH * 0.24, colW * 0.34);
    const cellPadTop = rowH * 0.16;   // gap between the rule and the day number

    if (showHeader) {
        const headY = gridTop + (headerH - headSize) * 0.34;
        for (let c = 0; c < 7; c++) {
            const isWknd = weekStartsMonday ? (c >= 5) : (c === 0 || c === 6);
            text(B.b, gridX + c * colW + inset, headY,
                 colW - inset * 2, headerH,
                 L.daysShort[weekStartsMonday ? c : (c + 6) % 7],
                 cfg.fonts.medium, headSize, isWknd ? C.accent : C.ink);
        }
        if (showWeekNumbers) {
            // "WK" header, same size and style as the day numbers. It gets a
            // wide right-aligned frame (right edge at gx+wkColW) so the word
            // never wraps onto two lines.
            text(B.b, gx - wkColW, headY, wkColW * 2, headerH,
                 L.weekAbbr, cfg.fonts.medium, headSize, C.muted,
                 ParagraphAlignXType.Right);
        }
    }

    if (showGrid) {
        for (let r = 0; r <= numWeeks; r++) {
            const yy = bodyTop + r * rowH;
            const strong = r === 0;
            // The top rule (under the header) also spans the week-number
            // column, for one continuous header.
            const x0 = strong && showWeekNumbers ? gx : gridX;
            const w0 = strong && showWeekNumbers ? gw : gridW;
            rule(B.b, x0, yy, w0, strong ? hairStrong : hair, strong ? C.ink : C.rule);
        }
        if (showVerticals) {
            for (let c = 0; c <= 7; c++) {
                vrule(B.b, gridX + c * colW, bodyTop, rowH * numWeeks, hair, C.rule);
            }
        }
    }

    const drawCell = (dObj, col, row, muted) => {
        const cx = gridX + col * colW;
        const cy = bodyTop + row * rowH;
        const isWknd = weekStartsMonday ? (col >= 5) : (col === 0 || col === 6);
        const isToday = today && sameDay(dObj, today);
        let colour = muted ? C.muted : (isWknd ? C.accent : C.ink);
        let face = cfg.fonts.regular;
        if (!muted && isWknd && boldWeekend) face = cfg.fonts.bold;
        if (isToday) { colour = C.accent; face = cfg.fonts.bold; }
        text(B.b, cx + inset, cy + cellPadTop, colW - inset, rowH * 0.5,
             dObj.getDate(), face, daySize, colour);
        if (isToday) {
            rect(B.b, cx + inset, cy + cellPadTop + daySize * 1.15,
                 daySize * 1.1, hairStrong * 1.5, C.accent);
        }
    };

    const prevDim = daysInMonth(month === 0 ? year - 1 : year, (month + 11) % 12);
    for (let c = 0; c < startCol; c++) {
        if (!showAdjacent) break;
        const d = prevDim - startCol + 1 + c;
        drawCell(new Date(year, month - 1, d), c, 0, true);
    }
    for (let day = 1; day <= dim; day++) {
        const cell = startCol + day - 1;
        drawCell(new Date(year, month, day), cell % 7, Math.floor(cell / 7), false);
    }
    if (showAdjacent) {
        const used = startCol + dim;
        const total = numWeeks * 7;
        for (let i = 0; i < total - used; i++) {
            drawCell(new Date(year, month + 1, i + 1),
                     (used + i) % 7, Math.floor((used + i) / 7), true);
        }
    }

    if (showWeekNumbers) {
        // "From 1": week 1 is the one containing January 1 (per the chosen
        // week-start day); from there it counts forward.
        let week1Start = null;
        if (!weekNumberIso) {
            const jan1 = new Date(year, 0, 1);
            const off = weekStartsMonday ? ((jan1.getDay() + 6) % 7) : jan1.getDay();
            week1Start = new Date(year, 0, 1 - off);
        }
        for (let r = 0; r < numWeeks; r++) {
            const firstCellDay = 1 + r * 7 - startCol;   // first cell of the row (may be <= 0)
            let wn;
            if (weekNumberIso) {
                // ISO 8601 is Monday-first: number by the Monday of that week.
                const mondayShift = weekStartsMonday ? 0 : 1;
                wn = isoWeek(new Date(year, month, firstCellDay + mondayShift));
            } else {
                const rowStart = new Date(year, month, firstCellDay);
                wn = Math.round((rowStart - week1Start) / 604800000) + 1;
            }
            text(B.b, gx, bodyTop + r * rowH + cellPadTop, wkColW,
                 rowH * 0.5, wn, cfg.fonts.regular, daySize * 0.72,
                 C.muted, ParagraphAlignXType.Right);
        }
    }
}

// ----------------------------------------------------------------------------
//  View: YEAR  (12 mini-months in a 4 x 3 grid)
// ----------------------------------------------------------------------------
function drawYear(B, area, cfg, L) {
    const { text, rect } = B;
    const { year, weekStartsMonday, showHeader, boldWeekend, showAccentBar, today, C } = cfg;

    const margin = Math.min(area.w, area.h) * 0.05;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const titleSize = area.w * 0.032;
    const titleH = titleSize * 1.6;
    text(B.b, gx, gy, gw, titleH * 1.4, String(year), cfg.fonts.bold, titleSize, C.ink);
    if (showAccentBar) {
        rect(B.b, gx, gy + titleH * 1.05, titleSize * 1.4,
             Math.max(area.w * 0.004, 3), C.accent);
    }

    const cols = 4, rows = 3;
    const gutterX = gw * 0.035, gutterY = gh * 0.05;
    const areaTop = gy + titleH * 1.6;
    const cellW = (gw - gutterX * (cols - 1)) / cols;
    const cellH = (gh - (areaTop - gy) - gutterY * (rows - 1)) / rows;

    const mTitleSize = cellW * 0.11;
    const numSize = cellW * 0.083;
    const headSize = cellW * 0.072;

    for (let m = 0; m < 12; m++) {
        const cx = gx + (m % cols) * (cellW + gutterX);
        const cy = areaTop + Math.floor(m / cols) * (cellH + gutterY);

        text(B.b, cx, cy, cellW, mTitleSize * 1.4,
             L.months[m].toUpperCase(), cfg.fonts.bold, mTitleSize, C.ink);

        const gridTop = cy + mTitleSize * 1.9;
        const colW = cellW / 7;
        const rowH = (cellH - (gridTop - cy)) / 7;

        if (showHeader) {
            for (let c = 0; c < 7; c++) {
                const isWknd = weekStartsMonday ? (c >= 5) : (c === 0 || c === 6);
                text(B.b, cx + c * colW, gridTop, colW, rowH,
                     L.daysMini[weekStartsMonday ? c : (c + 6) % 7],
                     cfg.fonts.medium, headSize, isWknd ? C.accent : C.muted,
                     ParagraphAlignXType.Centre);
            }
        }
        const bodyTop = gridTop + (showHeader ? rowH : 0);

        const first = new Date(year, m, 1);
        const startCol = columnOf(first.getDay(), weekStartsMonday);
        const dim = daysInMonth(year, m);
        for (let day = 1; day <= dim; day++) {
            const cell = startCol + day - 1;
            const col = cell % 7, row = Math.floor(cell / 7);
            const isWknd = weekStartsMonday ? (col >= 5) : (col === 0 || col === 6);
            const isToday = today && sameDay(new Date(year, m, day), today);
            let colour = isWknd ? C.accent : C.ink;
            let face = (isWknd && boldWeekend) ? cfg.fonts.bold : cfg.fonts.regular;
            if (isToday) { colour = C.accent; face = cfg.fonts.bold; }
            text(B.b, cx + col * colW, bodyTop + row * rowH, colW, rowH,
                 day, face, numSize, colour, ParagraphAlignXType.Centre);
        }
    }
}

// ----------------------------------------------------------------------------
//  View: WEEK  (7 columns)
// ----------------------------------------------------------------------------
function drawWeek(B, area, cfg, L) {
    const { text, rule, vrule, rect } = B;
    const { year, month, day, weekStartsMonday, showVerticals, showAccentBar, today, C } = cfg;

    const margin = Math.min(area.w, area.h) * 0.06;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const ref = new Date(year, month, day);
    const refCol = columnOf(ref.getDay(), weekStartsMonday);
    const monday = new Date(year, month, day - refCol);

    const titleSize = area.w * 0.030;
    const titleH = titleSize * 1.6;
    const endOfWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const range = (monday.getMonth() === endOfWeek.getMonth())
        ? `${L.months[monday.getMonth()]} ${monday.getFullYear()}`
        : `${L.months[monday.getMonth()]} – ${L.months[endOfWeek.getMonth()]} ${endOfWeek.getFullYear()}`;
    text(B.b, gx, gy, gw * 0.7, titleH * 1.4, range.toUpperCase(),
         cfg.fonts.bold, titleSize, C.ink);
    text(B.b, gx, gy, gw, titleH * 1.4,
         `${L.week} ${isoWeek(monday)}`, cfg.fonts.regular, titleSize,
         C.accent, ParagraphAlignXType.Right);
    if (showAccentBar) {
        rect(B.b, gx, gy + titleH * 1.4, titleSize * 1.5,
             Math.max(area.w * 0.005, 3), C.accent);
    }

    const gridTop = gy + titleH * 2.0;
    const gridH = (gy + gh) - gridTop;
    const colW = gw / 7;
    const hair = Math.max(area.w * 0.0012, 1);
    const inset = colW * 0.06;
    const headSize = Math.max(colW * 0.11, area.w * 0.011);
    const numSize = colW * 0.42;

    rule(B.b, gx, gridTop, gw, hair * 2, C.ink);
    for (let c = 0; c < 7; c++) {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + c);
        const isWknd = (d.getDay() === 0 || d.getDay() === 6);
        const isToday = today && sameDay(d, today);
        const cx = gx + c * colW;
        const colour = isWknd ? C.accent : C.ink;
        text(B.b, cx + inset, gridTop + inset, colW - inset, headSize * 1.6,
             L.daysShort[(d.getDay() + 6) % 7],
             cfg.fonts.medium, headSize, colour);
        text(B.b, cx + inset, gridTop + headSize * 2.0, colW, numSize * 1.4,
             d.getDate(), isToday ? cfg.fonts.bold : cfg.fonts.regular,
             numSize * 0.92, isToday ? C.accent : colour);
        rule(B.b, cx + inset, gridTop + headSize * 2.2 + numSize * 1.35,
             colW - inset * 2, hair, C.rule);
    }
    if (showVerticals) {
        for (let c = 1; c < 7; c++) vrule(B.b, gx + c * colW, gridTop, gridH, hair, C.rule);
    }
    rule(B.b, gx, gy + gh, gw, hair, C.rule);
}

// ----------------------------------------------------------------------------
//  View: DAY
// ----------------------------------------------------------------------------
function drawDay(B, area, cfg, L) {
    const { text, richText, rule, vrule, rect } = B;
    const { year, month, day, showAgenda, agendaStart, agendaEnd, agenda24h,
            showAccentBar, today, C } = cfg;

    const hourLabel = (h) => {
        if (agenda24h) return String(h).padStart(2, '0') + ':00';
        const ap = h < 12 ? 'AM' : 'PM';
        let hh = h % 12; if (hh === 0) hh = 12;
        return hh + ' ' + ap;
    };

    const margin = Math.min(area.w, area.h) * 0.08;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const d = new Date(year, month, day);
    const isToday = today && sameDay(d, today);
    const weekdayName = L.daysLong[(d.getDay() + 6) % 7];
    const hair = Math.max(Math.min(area.w, area.h) * 0.0014, 1);

    // With an agenda on a landscape area, the date block goes on the left and
    // the hours fill the right column (Swiss daily planner). On a portrait
    // area (or with no agenda) everything stacks. Sizes are tied to the
    // smaller dimension so it works at any proportion.
    const wide = showAgenda && gw > gh * 1.2;
    const dateW = wide ? gw * 0.40 : gw;
    const u = Math.min(dateW, gh);

    const wSize   = Math.min(u * 0.11, gh * 0.10);
    const subSize = Math.min(u * 0.055, gh * 0.05);
    const numSize = wide
        ? Math.min(dateW * 0.82, gh * 0.52)
        : Math.min(gw * 0.32, gh * 0.42);

    let cy = gy;
    text(B.b, gx, cy, dateW, wSize * 1.4, weekdayName.toUpperCase(),
         cfg.fonts.bold, wSize, isToday ? C.accent : C.ink);
    if (showAccentBar) {
        rect(B.b, gx, cy + wSize * 1.25, wSize * 1.5,
             Math.max(u * 0.012, 3), C.accent);
    }
    cy += wSize * 1.95;
    text(B.b, gx, cy, dateW, numSize * 1.15, String(day),
         cfg.fonts.bold, numSize, C.ink);
    cy += numSize * 1.08;
    // Month/year in bold; "  ·  WEEK nn" in dimmed regular (Swiss hierarchy).
    richText(B.b, gx, cy, wide ? dateW : gw, subSize * 1.7, [
        { text: `${L.months[month]} ${year}`, face: cfg.fonts.bold, colour: C.ink },
        { text: `  ·  ${L.week} ${isoWeek(d)}`, face: cfg.fonts.regular, colour: C.muted }
    ], subSize);
    cy += subSize * 2.6;

    if (!showAgenda) return;

    const agX = wide ? gx + gw * 0.46 : gx;
    const agW = wide ? gw - gw * 0.46 : gw;
    const top = wide ? gy : cy;
    const bottom = gy + gh;
    const availH = bottom - top;
    if (availH < subSize * 2) return;

    let hours = Math.max(1, Math.round(agendaEnd - agendaStart));
    const step = availH / hours;
    const gutterW = agW * 0.13;
    const labSize = Math.max(Math.min(subSize * 0.78, step * 0.5), 9);

    for (let i = 0; i <= hours; i++) {
        const yy = top + i * step;
        rule(B.b, agX, yy, agW, i === 0 ? hair * 2 : hair, i === 0 ? C.ink : C.rule);
        if (i < hours) {
            text(B.b, agX, yy + step * 0.24, gutterW, step, hourLabel(agendaStart + i),
                 cfg.fonts.regular, labSize, C.muted);
        }
    }
    // Vertical rule separating the hours column from the writing area.
    vrule(B.b, agX + gutterW, top, step * hours, hair, C.rule);
}

// ----------------------------------------------------------------------------
//  Language dialog. Control labels are fixed when the control is created, so
//  the language is chosen before the main dialog is built.
// ----------------------------------------------------------------------------
function askLanguage() {
    const dlg = Dialog.create('Idioma · Language');
    const g = dlg.addColumn().addGroup();
    const bs = g.addButtonSet('Idioma · Language', ['Español', 'English'], 0).setIsFullWidth();
    const r = dlg.runModal();
    if (r !== DialogResult.Ok && r !== DialogResult.Ok.value) return null;
    return bs.selectedIndex === 1 ? 'en' : 'es';
}

// ----------------------------------------------------------------------------
//  Main dialog.
//
//  Two columns -- the SDK has no scroll and sizes the dialog to its content,
//  so a single tall column pushes OK/Cancel off screen once every section is
//  open. Left column: target + view + date + agenda. Right column: elements +
//  style. Collapsible sections are emulated (Affinity has no native ones):
//  per SECTION_HEADER the header is a ▶/▼ arrow button (two buttons that swap)
//  or a switch; both show/hide the section's control group.
// ----------------------------------------------------------------------------
function buildDialog(U, months, defaults, targetLabel) {
    const T = U.tips;
    const dlg = Dialog.create(U.title);
    dlg.initialWidth = 660;
    try { dlg.isResizable = true; } catch (e) {}
    const colL = dlg.addColumn();
    const colR = dlg.addColumn();
    try { colL.widthProportion = 1;    } catch (e) {}
    try { colR.widthProportion = 1.25; } catch (e) {}

    // Shows which artboard / shape the calendar will land on, so a wrong
    // selection is caught at a glance before pressing OK.
    colL.addGroup().addStaticText(null, U.targetPrefix + targetLabel).setIsFullWidth();

    const sections = {};
    function section(col, key, title, expanded, tip) {
        let s;
        let body;

        if (SECTION_HEADER === 'arrow') {
            // Two buttons that swap: the arrow "changes" as it folds/unfolds.
            const head = col.addGroup();
            const openBtn = head.addButton('▼  ' + title)
                .setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            const shutBtn = head.addButton('▶  ' + title)
                .setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            body = col.addGroup();
            body.enableSeparator = true;
            const st = { open: expanded };
            const sync = () => {
                openBtn.isVisible = st.open;
                shutBtn.isVisible = !st.open;
                body.isVisible = st.open;
            };
            openBtn.onClickHandler = () => { st.open = false; sync(); };
            shutBtn.onClickHandler = () => { st.open = true;  sync(); };
            sync();
            s = { set: (on) => { st.open = on; sync(); } };
        } else {
            const sw = col.addGroup().addSwitch(title, expanded).setDescription(tip || '');
            body = col.addGroup();
            body.enableSeparator = true;
            body.isVisible = expanded;
            sw.onValueChangedHandler = () => { body.isVisible = sw.value; };
            s = { set: (on) => { sw.value = on; body.isVisible = on; } };
        }

        sections[key] = s;
        return body;
    }
    dlg.expandSection = (key, on = true) => {
        if (sections[key]) sections[key].set(on);
    };

    // --- Left column ---------------------------------------------------------
    const gType = colL.addGroup(U.secType);
    dlg.type = gType.addButtonSet(U.view, U.views, 1).setIsFullWidth().setDescription(T.view);

    const gDate = section(colL, 'date', U.secDate, true, T.secDate);
    dlg.year  = gDate.addUnitValueEditor(U.year, UnitType.Number, UnitType.Number, defaults.year, 1900, 2200).setPrecision(0).setDescription(T.year);
    dlg.month = gDate.addComboBox(U.month, months, defaults.month).setDescription(T.month);
    dlg.day   = gDate.addUnitValueEditor(U.day, UnitType.Number, UnitType.Number, defaults.day, 1, 31).setPrecision(0).setDescription(T.day);
    dlg.weekStart = gDate.addButtonSet(U.weekStart, U.weekStartOpts, 0).setDescription(T.weekStart);
    dlg.weekNumMode = gDate.addButtonSet(U.weekNumMode, U.weekNumModeOpts, 1).setDescription(T.weekNumMode);

    const gAgenda = section(colL, 'agenda', U.secAgenda, false, T.secAgenda);
    dlg.agenda    = gAgenda.addCheckBox(U.agendaShow, true).setIsFullWidth().setDescription(T.agendaShow);
    dlg.agendaFrom = gAgenda.addUnitValueEditor(U.agendaFrom, UnitType.Number, UnitType.Number, 8, 0, 23).setPrecision(0).setDescription(T.agendaFrom);
    dlg.agendaTo   = gAgenda.addUnitValueEditor(U.agendaTo, UnitType.Number, UnitType.Number, 20, 1, 24).setPrecision(0).setDescription(T.agendaTo);
    dlg.timeFormat = gAgenda.addButtonSet(U.timeFormat, U.timeFormatOpts, 1).setDescription(T.timeFormat);

    // --- Right column -------------------------------------------------------
    const gShow = section(colR, 'elements', U.secElements, true, T.secElements);
    const showStack = gShow.addColumnStack();
    const showL = showStack.addColumn().addGroup();
    const showR = showStack.addColumn().addGroup();
    dlg.header      = showL.addCheckBox(U.header, true).setIsFullWidth().setDescription(T.header);
    dlg.grid        = showL.addCheckBox(U.grid, true).setIsFullWidth().setDescription(T.grid);
    dlg.verticals   = showL.addCheckBox(U.verticals, false).setIsFullWidth().setDescription(T.verticals);
    dlg.accentBar   = showL.addCheckBox(U.accentBar, true).setIsFullWidth().setDescription(T.accentBar);
    dlg.adjacent    = showR.addCheckBox(U.adjacent, true).setIsFullWidth().setDescription(T.adjacent);
    dlg.weekNumbers = showR.addCheckBox(U.weekNumbers, false).setIsFullWidth().setDescription(T.weekNumbers);
    dlg.boldWeekend = showR.addCheckBox(U.boldWeekend, false).setIsFullWidth().setDescription(T.boldWeekend);
    dlg.markToday   = showR.addCheckBox(U.markToday, true).setIsFullWidth().setDescription(T.markToday);

    const gStyle = section(colR, 'style', U.secStyle, false, T.secStyle);
    dlg.font   = gStyle.addFontPicker(U.font).setDescription(T.font);
    dlg.ink    = gStyle.addColourPicker(U.ink, RGB8(17, 17, 17)).setDescription(T.ink);
    dlg.accent = gStyle.addColourPicker(U.accent, RGB8(227, 6, 19)).setDescription(T.accent);
    dlg.rule   = gStyle.addColourPicker(U.ruleColour, RGB8(150, 150, 150)).setDescription(T.ruleColour);
    dlg.muted  = gStyle.addColourPicker(U.muted, RGB8(176, 176, 176)).setDescription(T.muted);

    if (defaults.fontFamily) {
        const fam = FontFamily.all.find(f => f.name === defaults.fontFamily);
        if (fam) dlg.font.fontFamily = fam;
    }

    // Choosing the "Day" view opens the Agenda section.
    dlg.type.onValueChangedHandler = () => {
        if (dlg.type.selectedIndex === 3) dlg.expandSection('agenda', true);
    };
    return dlg;
}

// ----------------------------------------------------------------------------
//  Main
// ----------------------------------------------------------------------------
function main() {
    const doc = Document.current;

    const langKey = askLanguage();
    if (!langKey) return;
    const L = STR[langKey];
    const U = L.ui;

    if (!doc) { alert(U.noDoc); return; }
    if (!doc.selection || doc.selection.length === 0) { alert(U.noSel); return; }

    // Walk the parent chain: is there an artboard? are we inside a calendar
    // this script already created?
    const CAL_RE = /^(Calendario|Calendar) · /;
    function context(node) {
        let n = node, artboard = null, insideCalendar = false;
        while (n) {
            try { if (!artboard && n.artboardInterface && n.artboardInterface.isArtboardEnabled) artboard = n; } catch (e) {}
            try { if (CAL_RE.test(n.userDescription || '')) insideCalendar = true; } catch (e) {}
            n = n.parent;
        }
        return { artboard, insideCalendar };
    }

    // With several selected nodes, prefer one that is NOT part of a calendar
    // already created (e.g. the rectangle the user just drew).
    const selNodes = doc.selection.nodes.toArray();
    let baseNode = selNodes.find(n => !context(n).insideCalendar) || selNodes[0];
    if (!baseNode) { alert(U.noSel); return; }
    if (context(baseNode).insideCalendar) { alert(U.reSel); return; }

    // Is the selection an artboard, or a shape inside one / a loose shape?
    const selIsArtboard = (() => {
        try { return !!baseNode.artboardInterface.isArtboardEnabled; }
        catch (e) { return false; }
    })();
    const targetArtboard = context(baseNode).artboard;

    // insertTarget: where the calendar's group goes.
    // area: the rectangle to fill, ALWAYS in SPREAD coordinates.
    //
    // The artboard gotcha: when a node is inserted inside an artboard,
    // Affinity adds a transform that cancels the artboard's own, so the
    // children's coordinates are read in spread space (not local to the
    // artboard). That's why `area` comes from `spreadBaseBox` /
    // `artboardSpreadBaseBox`, which give the real position in the spread, so
    // the calendar lands inside the right artboard even with several of them
    // offset from each other.
    let insertTarget, area;
    if (selIsArtboard) {
        // The artboard is selected -> the calendar fills its whole surface.
        insertTarget = baseNode;
        const sb = baseNode.artboardSpreadBaseBox;   // the artboard's real rect in the spread
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else if (targetArtboard) {
        // Shape inside an artboard -> the calendar fills its box. Insert into
        // the artboard (its transform cancels out) and use spread coordinates.
        insertTarget = targetArtboard;
        const sb = baseNode.spreadBaseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else {
        // Loose shape in a document with no artboards.
        insertTarget = baseNode.parent;
        const sb = baseNode.spreadBaseBox || baseNode.baseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    }
    if (!area || !isFinite(area.w) || area.w <= 0 || area.h <= 0) { alert(U.noSel); return; }
    let targetLabel;
    if (selIsArtboard) {
        targetLabel = (baseNode.userDescription || baseNode.name || '?');
    } else if (targetArtboard) {
        targetLabel = U.targetShapeIn + '«' + (targetArtboard.userDescription || targetArtboard.name || '?') + '»';
    } else {
        targetLabel = U.targetDoc;
    }

    const now = new Date();
    const base = resolveFonts(null);
    const dlg = buildDialog(U, L.months, {
        year: now.getFullYear(),
        month: now.getMonth(),
        day: now.getDate(),
        fontFamily: base.familyName
    }, targetLabel);

    const res = dlg.runModal();
    if (res !== DialogResult.Ok && res !== DialogResult.Ok.value) return;

    const pickedFont = dlg.font.font;
    const fonts = resolveFonts(pickedFont ? pickedFont.familyName : base.familyName);

    const C = {
        ink:    dlg.ink.value    || RGB8(17, 17, 17),
        accent: dlg.accent.value || RGB8(227, 6, 19),
        rule:   dlg.rule.value   || RGB8(150, 150, 150),
        muted:  dlg.muted.value  || RGB8(176, 176, 176)
    };

    let agendaStart = Math.round(dlg.agendaFrom.value);
    let agendaEnd = Math.round(dlg.agendaTo.value);
    if (agendaEnd <= agendaStart) agendaEnd = agendaStart + 1;

    const cfg = {
        year: Math.round(dlg.year.value),
        month: dlg.month.selectedIndex,
        day: Math.min(Math.round(dlg.day.value),
                      daysInMonth(Math.round(dlg.year.value), dlg.month.selectedIndex)),
        weekStartsMonday: dlg.weekStart.selectedIndex === 0,
        weekNumberIso: dlg.weekNumMode.selectedIndex === 0,
        showHeader: dlg.header.value,
        showGrid: dlg.grid.value,
        showVerticals: dlg.verticals.value,
        showAdjacent: dlg.adjacent.value,
        showWeekNumbers: dlg.weekNumbers.value,
        boldWeekend: dlg.boldWeekend.value,
        showAccentBar: dlg.accentBar.value,
        showAgenda: dlg.agenda.value,
        agendaStart, agendaEnd,
        agenda24h: dlg.timeFormat.selectedIndex === 1,
        today: dlg.markToday.value ? now : null,
        fonts, C
    };

    const typeIdx = dlg.type.selectedIndex;      // 0 Year, 1 Month, 2 Week, 3 Day
    const typeName = U.views[typeIdx];

    const contDef = ContainerNodeDefinition.create(
        `${U.calName} · ${typeName} ${cfg.year}` +
        (typeIdx === 1 ? ` · ${L.months[cfg.month]}` : ''));
    const cb = AddChildNodesCommandBuilder.create();
    if (insertTarget) cb.setInsertionTarget(insertTarget);
    cb.addContainerNode(contDef);
    doc.executeCommand(cb.createCommand(true));
    const container = doc.selection.nodes.first;

    const b = AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(container);
    const B = makeBuilders(doc);
    B.b = b;

    try {
        if (typeIdx === 0)      drawYear(B, area, cfg, L);
        else if (typeIdx === 1) drawMonth(B, area, cfg, L);
        else if (typeIdx === 2) drawWeek(B, area, cfg, L);
        else                    drawDay(B, area, cfg, L);
        doc.executeCommand(b.createCommand(true));
    } catch (e) {
        // If drawing fails, don't leave an empty container in the document.
        try { doc.deleteSelection(Selection.create(doc, container)); } catch (_) {}
        throw e;
    }
}

try {
    main();
} catch (e) {
    alert('Swiss Calendar Creator:\n' + (e && e.message ? e.message : e) +
          (e && e.stack ? '\n\n' + e.stack : ''));
}
