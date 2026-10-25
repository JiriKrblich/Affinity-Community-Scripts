/**
 * name: Gerador de Calendário
 * description: Gera calendários no Estilo Tipográfico
 *   Seis vistas: Ano, Trimestre, Semestre, Mês, Semana e Dia. Interface 100% PT-BR.
 *   Tipografia (fonte, peso, tamanho, caixa, tracking, entrelinha), formatos
 *   (dia 01/1, semana S05/05, ano 26/2026, títulos por modelo), layout (margens,
 *   espaços, alinhamento da célula, fundo, borda), cores por elemento, feriados
 *   nacionais, datas marcadas, presets nomeados, temas e pré-visualização ao vivo.
 * version: 3.0.0
 * author: Victor Crespo (3dvic) - Adaptado e traduzido para PT-BR
 * license: MIT
 */
'use strict';

// ============================================================================
//  Gerador de Calendário Suíço  --  Affinity (Designer / Publisher) 2.5+
//  Selecione uma PRANCHETA (o calendário preencherá sua superfície) ou um
//  retângulo/moldura dentro dela (o calendário preencherá essa forma).
//  Dica: clique em um calendário já existente e execute de novo para
//  SUBSTITUI-lo no lugar com as novas configurações.
// ============================================================================

const { Document } = require('/document');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { UnitType } = require('/units');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
const { ContainerNodeDefinition, ShapeNodeDefinition, FrameTextNodeDefinition } = require('/nodes');
const { Selection } = require('/selections');
const { ShapeRectangle } = require('/shapes');
const { Rectangle } = require('/geometry');
const { StoryBuilder } = require('/storybuilder');
const { Font, FontFamily } = require('/fonts');
const { FillDescriptor } = require('/fills');
const { RGB8 } = require('/colours');
const { ParagraphAlignXType, ParagraphLeadingType } = require('/paragraphatts');

// Módulos opcionais (ausentes em versões antigas do Affinity).
let APP = null;
let FILE_MOD = null;
try { APP = require('/application').app; } catch (e) {}
try { FILE_MOD = require('/fs').File; } catch (e) {}

// Cabeçalho das seções retráteis: 'arrow' (seta ▶/▼) ou 'switch' (interruptor)
const SECTION_HEADER = 'arrow';

// Identificação dos calendários criados (usado para detectar/substituir).
const CAL_RE = /^Calendário · /;
// Etiqueta do preset gravado no documento.
const PRESET_TAG = 'SCC-PRESET:';

// ----------------------------------------------------------------------------
//  Strings de Idioma (Português)
// ----------------------------------------------------------------------------
const L = {
    months: ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
             'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'],
    daysLong: ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira',
               'Sexta-feira', 'Sábado', 'Domingo'],
    daysFour: ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'],
    daysMid: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
    daysShort: ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB', 'DOM'],
    daysMini: ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'],
    week: 'SEMANA',
    weekAbbr: 'SEM',
    notes: 'NOTAS',
    ui: {
        title: 'Gerador de Calendário Suíço',
        secType: 'Tipo de Calendário',
        secDate: 'Data',
        secSequence: 'Sequência (Múltiplas Pranchetas)',
        secDates: 'Feriados e Datas Marcadas',
        secAgenda: 'Agenda (Vista Dia)',
        secPresets: 'Presets e Temas',
        secElements: 'Elementos Visuais',
        secTypo: 'Tipografia e Formatos',
        secColors: 'Cores',
        secLayout: 'Layout',
        secPreview: 'Pré-visualização',

        views: ['Ano', 'Trimestre', 'Semestre', 'Mês', 'Semana', 'Dia'],
        yearGridOpts: ['Automática', '4 × 3', '3 × 4', '6 × 2', '2 × 6', '12 × 1', '1 × 12', 'Personalizada'],
        weekStartOpts: ['Segunda-feira', 'Domingo'],
        weekNumModeOpts: ['ISO 8601', 'A partir de 1'],
        seqOrderOpts: ['Por nome', 'Linhas', 'Colunas'],
        seqModeOpts: ['Pular pranchetas já usadas', 'Atualizar pranchetas já usadas'],
        timeFormatOpts: ['12 h (AM/PM)', '24 h'],
        titleTplOpts: ['{PERIODO} {ANO}', '{ANO} · {PERIODO}', '{PERIODO} — {ANO}', '{PERIODO}'],
        headFmtOpts: ['SEG', 'Seg', 'Segunda', 'Segunda-feira'],
        fmtDayOpts: ['1', '01'],
        fmtWeekOpts: ['5', '05', 'S05', 'SEM 05'],
        fmtYearOpts: ['2026', '26'],
        caseOpts: ['Caixa alta', 'Como escrito'],
        alignHOpts: ['Esquerda', 'Centro', 'Direita'],
        alignVOpts: ['Topo', 'Centro', 'Base'],
        styleOpts: ['Automático', 'Regular', 'Medium', 'Bold', 'Itálico'],
        temaOpts: ['Suíço Clássico', 'Minimal Preto', 'Alto Contraste', 'Noturno', 'Corporativo Azul'],
        slotOpts: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],

        targetPrefix: 'Será desenhado em: ',
        targetDoc: 'o documento (sem pranchetas)',
        targetShapeIn: 'a forma selecionada em ',
        calName: 'Calendário',

        noDoc: 'Abra um documento primeiro.',
        noSel: 'Selecione uma prancheta (o calendário preencherá toda ela) ou um retângulo/moldura dentro dela que defina a área.',
        reSel: 'A seleção faz parte de um calendário já criado e não foi possível localizar a área original.\n\nClique na prancheta — ou em um retângulo/moldura fora do calendário — e execute o script novamente.',
        errPrefix: 'Erro no Gerador de Calendário:\n',
        errContainer: 'Não foi possível criar o contêiner do calendário.',
        prevOn: 'Prévia:',
        prevErr: 'Erro na pré-visualização:',
        prevFail: 'Não foi possível desfazer a pré-visualização.\nUse Desfazer (Ctrl+Z) e execute o script novamente.',

        seqNoArtboards: 'A sequência precisa de pranchetas, mas este documento não tem nenhuma.',
        seqNone: 'Não há nenhuma prancheta livre a partir da selecionada.\n\nTodas as pranchetas seguintes já contêm um calendário.',
        seqReport: 'Sequência concluída: {n} calendário(s) criado(s).',
        seqSkipped: '\n\n{s} prancheta(s) foram ignoradas porque já tinham um calendário.',

        btnTheme: 'Aplicar tema',
        btnSlotSave: 'Salvar',
        btnSlotLoad: 'Carregar',
        btnSlotDel: 'Apagar',
        btnImport: 'Importar preset (.json)…',
        btnExport: 'Exportar preset (.json)…',
        prevSeqSkip: 'Sequência com prancheta já usada: prévia não redesenhada (sem Atualizar).',
        slotLabel: 'Preset (slot)',
        temaLabel: 'Tema',
        stSlotSaved: 'Slot {n} salvo neste documento.',
        stSlotLoaded: 'Slot {n} carregado.',
        stSlotEmpty: 'Slot {n} está vazio.',
        stSlotDeleted: 'Slot {n} apagado.',
        stTheme: 'Tema aplicado. Clique em OK para gerar.',
        stImported: 'Preset importado com sucesso.',
        stImportFail: 'Não foi possível importar: ',

        secTypeTip: 'Escolha a vista e, na vista Ano, como os 12 meses são distribuídos.',
        secDateTip: 'Qual data o calendário representa e como as semanas são contadas.',
        secSeqTip: 'Preenche várias pranchetas de uma vez, gerando um período em cada uma.',
        secDatesTip: 'Feriados nacionais do Brasil (incluindo datas móveis) e suas próprias datas com legenda.',
        secAgendaTip: 'Faixas de horas, linhas de meia-hora, horário atual e notas para a vista Dia.',
        secPresetsTip: 'Temas prontos, 10 slots de preset por documento e importação de preset (.json).',
        secElementsTip: 'O que será desenhado e destacado.',
        secTypoTip: 'Fonte, peso, tamanho, caixa, alinhamento de texto e formato de cada rótulo.',
        secColorsTip: 'Uma cor por função: tinta, destaque, linhas, atenuados, feriados e fundo.',
        secLayoutTip: 'Margens, espaçamento, alinhamento do número na célula, fundo e borda.',
        secPreviewTip: 'Redesenha o calendário alvo a cada mudança, sem aplicar nada até OK.'
    }
};

const U = L.ui;

// ----------------------------------------------------------------------------
//  Metadados dos campos do diálogo (rótulo + dica) — chave = campo persistido
// ----------------------------------------------------------------------------
const F = {
    view: { label: 'Vista', tip: 'Ano = 12 mini-meses · Trimestre/Semestre = 3 ou 6 meses · Mês = grade do mês · Semana = colunas da semana · Dia = um único dia com agenda.' },
    yearGrid: { label: 'Colunas × linhas (Ano)', tip: 'Como os 12 meses da vista Ano são distribuídos. Automática escolhe a grade que deixa cada mini-mês mais próximo de um quadrado. Personalizada usa as colunas/linhas abaixo.' },
    gridCols: { label: 'Colunas', tip: 'Quantidade de colunas da grade personalizada (1–12).' },
    gridRows: { label: 'Linhas', tip: 'Quantidade de linhas da grade personalizada (1–12).' },
    year: { label: 'Ano', tip: 'Ano do calendário (1900–2200).' },
    month: { label: 'Mês', tip: 'Mês a ser desenhado. Também define o mês de referência para Trimestre, Semestre, Semana e Dia.' },
    day: { label: 'Dia (semana / dia)', tip: 'Dia do mês. Na vista Semana indica qual semana mostrar; na vista Dia, qual dia.' },
    weekStart: { label: 'A semana começa em', tip: 'Primeira coluna da semana: Segunda (Europa/Brasil) ou Domingo (EUA).' },
    weekNumMode: { label: 'Numeração das semanas', tip: 'Como a coluna SEM é numerada. · ISO 8601: padrão internacional. · A partir de 1: a semana 1 é a que contém 1º de janeiro.' },
    workweek: { label: 'Semana de trabalho (seg–sex)', tip: 'Mostra apenas Segunda a Sexta (5 colunas) nas vistas Mês, Semana e mini-meses. A numeração de semanas continua valendo para a semana calendário.' },

    seqOn: { label: 'Gerar um período por prancheta', tip: 'Em vez de um único calendário, desenha um por prancheta avançando o período. Ex.: 12 pranchetas = um ano inteiro.' },
    seqCount: { label: 'Quantidade', tip: 'Quantos períodos gerar (1–60).' },
    seqOrder: { label: 'Ordem das pranchetas', tip: 'Como as pranchetas são ordenadas. · Por nome: ordem natural. · Linhas: de cima para baixo. · Colunas: da esquerda para a direita.' },
    seqMode: { label: 'Pranchetas já usadas', tip: 'Pular: ignora pranchetas que já contêm um calendário. · Atualizar: apaga o calendário antigo da prancheta e redesenha com as configurações atuais.' },

    showHolidays: { label: 'Feriados nacionais (Brasil)', tip: 'Marca feriados fixos e móveis (Carnaval, Sexta-Feira Santa, Corpus Christi calculados pela Páscoa). Na vista Mês/Semana/Dia mostra o nome; nas vistas de mini-meses, um traço.' },
    showMarked: { label: 'Datas marcadas (lista)', tip: 'Mostra as datas da lista ao lado. Formato: dd/mm Legenda (ou dd/mm/aaaa Legenda), separadas por ponto e vírgula. Ex.: 15/10 Aniversário da Ana; 25/12/2026 Reunião de fim de ano.' },
    markedDates: { label: 'Datas marcadas (separadas por ;)', tip: 'Uma data por trecho: dd/mm Texto ou dd/mm/aaaa Texto. Sem ano = todos os anos. Com ano = só aquele ano. Ex.: 07/09 Independência em casa; 12/10/2026 Aniversário.' },

    agenda: { label: 'Mostrar faixas de horário', tip: 'Na vista Dia, adiciona faixas horárias. Em área paisagem, a data vai à esquerda e as horas à direita.' },
    agendaFrom: { label: 'Das (h)', tip: 'Hora de início da agenda (0–23).' },
    agendaTo: { label: 'Até (h)', tip: 'Hora de fim da agenda (1–24).' },
    timeFormat: { label: 'Formato de hora', tip: 'Como as horas são rotuladas: 12 h (8 AM) ou 24 h (08:00).' },
    agendaHalf: { label: 'Linha de meia-hora', tip: 'Desenha uma linha fina no meio de cada hora.' },
    agendaNow: { label: 'Linha do horário atual', tip: 'Se a data for hoje, marca a hora atual com uma linha na cor de destaque.' },
    notesLines: { label: 'Linhas de anotação', tip: 'Quantidade de linhas em branco para observações na vista Dia (0 = nenhuma).' },

    showTitle: { label: 'Título', tip: 'Desenha o título da vista. Se desativado, o título e sua barra de destaque desaparecem, dando mais espaço ao calendário.' },
    header: { label: 'Cabeçalho dos dias', tip: 'Linha com as abreviações dos dias (SEG, TER…) acima da grade. O formato é o da seção Tipografia.' },
    grid: { label: 'Linhas de grade (Mês)', tip: 'Linhas horizontais finas separando as semanas (vista Mês).' },
    verticals: { label: 'Linhas verticais', tip: 'Adiciona linhas verticais entre as colunas dos dias.' },
    accentBar: { label: 'Barra de destaque no título', tip: 'Linha curta e grossa na cor de destaque sob o título (detalhe do design suíço).' },
    showBg: { label: 'Fundo', tip: 'Preenche a área do calendário com a cor de fundo (desenhado atrás de tudo).' },
    showBorder: { label: 'Borda', tip: 'Desenha uma moldura fina na cor da tinta ao redor do calendário.' },
    adjacent: { label: 'Dias de meses adjacentes (Mês)', tip: 'Preenche as lacunas do início e fim com os dias do mês anterior e seguinte (atenuados).' },
    weekNumbers: { label: 'Números das semanas (Mês)', tip: 'Coluna "SEM" à esquerda com o número da semana de cada linha.' },
    boldWeekend: { label: 'Fins de semana em negrito', tip: 'Coloca os números de sábado e domingo em negrito.' },
    markToday: { label: 'Marcar o dia de hoje', tip: 'Destaca a data de hoje: cor de destaque, negrito e uma barra embaixo (ou acima, na alinhamento Base).' },

    font: { label: 'Família principal', tip: 'Família de fontes usada por todos os elementos que não tiverem família própria.' },
    fontTitle: { label: 'Fonte do título', tip: 'Fonte específica para títulos. Vazio = família principal.' },
    fontDays: { label: 'Fonte dos números', tip: 'Fonte específica para os números dos dias e semanas. Vazio = família principal.' },
    fontLabels: { label: 'Fonte dos rótulos', tip: 'Fonte específica para cabeçalhos, horas e legendas. Vazio = família principal.' },
    styleTitle: { label: 'Estilo do título', tip: 'Peso/itálico do título. Automático = Bold.' },
    styleDays: { label: 'Estilo dos números', tip: 'Peso/itálico dos números. Automático = Regular (com Bold nos fins de semana quando marcado).' },
    styleLabels: { label: 'Estilo dos rótulos', tip: 'Peso/itálico de cabeçalhos e legendas. Automático = Medium.' },

    sizeTitle: { label: 'Título', tip: 'Tamanho do título em pontos. 0 = automático (calculado pela área).' },
    sizeMonth: { label: 'Mês (mini-meses)', tip: 'Tamanho do nome do mês nas vistas Ano/Trimestre/Semestre. 0 = automático.' },
    sizeDay: { label: 'Nº dos dias', tip: 'Tamanho dos números dos dias em pontos. 0 = automático.' },
    sizeHead: { label: 'Cabeçalho', tip: 'Tamanho das abreviações dos dias em pontos. 0 = automático.' },
    sizeWeek: { label: 'Nº da semana', tip: 'Tamanho dos números da coluna SEM. 0 = automático.' },
    sizeHour: { label: 'Horas', tip: 'Tamanho dos rótulos de hora da agenda. 0 = automático.' },
    sizeBig: { label: 'Data gigante (Dia)', tip: 'Tamanho do número grande da vista Dia. 0 = automático.' },

    titleTpl: { label: 'Modelo do título', tip: 'Formato do título de Mês/Trimestre/Semestre. Tokens: {PERIODO} {ANO} {MES} {MES_NUM}.' },
    titleText: { label: 'Título personalizado', tip: 'Substitui o modelo por um texto livre (mesmos tokens aceitos). Vazio = usar o modelo.' },
    headFmt: { label: 'Cabeçalho dos dias', tip: 'Formato dos nomes das colunas: SEG, Seg, Segunda ou Segunda-feira.' },
    fmtDay: { label: 'Número do dia', tip: 'Formato dos números: 1 ou 01 (com zero à esquerda).' },
    fmtWeek: { label: 'Número da semana', tip: 'Formato do número da semana: 5, 05, S05 ou SEM 05.' },
    fmtYear: { label: 'Ano', tip: 'Formato do ano: 2026 ou 26.' },
    titleCase: { label: 'Caixa dos títulos', tip: 'Caixa alta (JANEIRO) ou como escrito (Janeiro).' },
    tracking: { label: 'Entreletras (tracking)', tip: 'Espaço entre letras em pontos (pode ser negativo). 0 = padrão da fonte.' },
    leading: { label: 'Entrelinha (%)', tip: 'Altura de linha em % da fonte (ex.: 120 = 1,2×). 0 = padrão. Afeta textos que quebram em várias linhas.' },

    alignH: { label: 'Número na célula: horizontal', tip: 'Alinhamento horizontal do número do dia dentro da célula (vistas Mês, Ano, Trimestre, Semestre, Semana).' },
    alignV: { label: 'Número na célula: vertical', tip: 'Posição vertical do número na célula: no topo (padrão), centralizado ou na base.' },

    ink: { label: 'Tinta principal', tip: 'Cor principal do texto e linhas fortes (também da borda).' },
    accent: { label: 'Cor de destaque', tip: 'Fins de semana, hoje, barra do título e cabeçalho de fins de semana.' },
    rule: { label: 'Cor das linhas', tip: 'Cor das linhas finas da grade e da agenda.' },
    muted: { label: 'Dias atenuados', tip: 'Cor dos dias de meses adjacentes e dos números da coluna SEM.' },
    flag: { label: 'Feriados e marcadas', tip: 'Cor dos feriados e datas marcadas.' },
    bg: { label: 'Cor de fundo', tip: 'Cor do fundo (use com a opção Fundo ligada na seção Elementos).' },

    margin: { label: 'Margem', tip: 'Margem interna em pontos. 0 = automática (proporcional à área).' },
    gutter: { label: 'Espaço entre meses', tip: 'Espaço horizontal/vertical entre os mini-meses (vistas Ano/Trimestre/Semestre), em pontos. 0 = automático.' }
};

// ----------------------------------------------------------------------------
//  Utilitários gerais
// ----------------------------------------------------------------------------
function clampInt(v, min, max) {
    v = Math.round(Number(v));
    if (!isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}

function msgOf(e) {
    return (e && e.message) ? e.message : String(e);
}

// ----------------------------------------------------------------------------
//  Utilitários de Data
// ----------------------------------------------------------------------------
function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
}

function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round((d - firstThursday) / 604800000);
}

// Colunas visíveis: [1..5] = seg..sex (semana de trabalho) ou semana completa
// começando em segunda ou domingo.
function weekDaysFor(weekStartsMonday, workweek) {
    if (workweek) return [1, 2, 3, 4, 5];
    return weekStartsMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
}

// Data do primeiro dia da semana (coluna 0) que contém `date`.
function rowStartOf(date, w0) {
    return addDays(date, -((date.getDay() - w0 + 7) % 7));
}

// Gera as células do mês na grade definida por W (colunas visíveis).
// Cada célula: { date, muted, col, row }.
function buildMonthCells(year, month, W) {
    const w0 = W[0];
    const dim = daysInMonth(year, month);
    const first = new Date(year, month, 1);
    // Último dia do mês que realmente aparece na grade (a semana de trabalho
    // oculta sábados e domingos, então o último dia visível pode ser anterior).
    let lastShown = dim;
    while (lastShown > 1) {
        if (W.indexOf(new Date(year, month, lastShown).getDay()) >= 0) break;
        lastShown--;
    }
    const lastT = new Date(year, month, lastShown).getTime();
    let rs = rowStartOf(first, w0);
    const cells = [];
    let placedLast = false;
    let guard = 0;
    while (!placedLast && guard++ < 12) {
        const row = cells.length / W.length;
        for (let i = 0; i < W.length; i++) {
            const off = (W[i] - w0 + 7) % 7;
            const d = addDays(rs, off);
            cells.push({ date: d, muted: d.getMonth() !== month, col: i, row: row });
            if (d.getTime() >= lastT) placedLast = true;
        }
        rs = addDays(rs, 7);
    }
    return cells;
}

// Algoritmo de Meeus/Jones/Butcher — domingo de Páscoa.
function easterDate(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

// Feriados nacionais do Brasil para um ano. Retorna { 'mes-dia': legenda }.
function brHolidays(year) {
    const out = {
        '0-1': 'Confraternização',
        '4-1': 'Dia do Trabalho',
        '8-7': 'Independência',
        '9-12': 'N. S. Aparecida',
        '10-2': 'Finados',
        '10-15': 'Proclamação',
        '10-20': 'Consciência Negra',
        '11-25': 'Natal'
    };
    try {
        const e = easterDate(year);
        const set = (offset, label) => { const d = addDays(e, offset); out[d.getMonth() + '-' + d.getDate()] = label; };
        set(-47, 'Carnaval');
        set(-2, 'Sexta-Feira Santa');
        set(60, 'Corpus Christi');
    } catch (err) {}
    return out;
}

// Converte a lista de datas marcadas em entradas { d, m, y, label }.
function parseMarkedDates(str) {
    const out = [];
    if (!str) return out;
    const parts = String(str).split(/[;\n\r|]+/);
    for (const raw of parts) {
        const s = raw.trim();
        if (!s) continue;
        const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{4}))?\s+(.+)$/);
        if (!m) continue;
        const d = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12)) continue;
        out.push({ d: d, m: mo - 1, y: m[3] ? parseInt(m[3], 10) : null, label: m[4].trim() });
    }
    return out;
}

// Mapa final 'ano-mes-dia' -> legenda (datas marcadas têm prioridade).
function buildFlags(year, showHolidays, showMarked, markedStr) {
    const flags = {};
    const years = [year - 1, year, year + 1];
    if (showHolidays) {
        for (const y of years) {
            const hol = brHolidays(y);
            for (const k in hol) flags[y + '-' + k] = hol[k];
        }
    }
    if (showMarked) {
        for (const e of parseMarkedDates(markedStr)) {
            const ys = e.y ? [e.y] : years;
            for (const y of ys) flags[y + '-' + e.m + '-' + e.d] = e.label;
        }
    }
    return flags;
}

// ----------------------------------------------------------------------------
//  Formatos
// ----------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDayNum(n, mode) { return mode === 1 ? pad2(n) : String(n); }

function fmtWeekNum(n, mode) {
    if (mode === 1) return pad2(n);
    if (mode === 2) return 'S' + pad2(n);
    if (mode === 3) return 'SEM ' + pad2(n);
    return String(n);
}

function fmtYearNum(y, mode) {
    return mode === 1 ? String(y).slice(2) : String(y);
}

function headerLabel(jsDay, mode) {
    const i = (jsDay + 6) % 7;
    if (mode === 1) return L.daysMid[i];
    if (mode === 2) return L.daysFour[i];
    if (mode === 3) return L.daysLong[i];
    return L.daysShort[i];
}

function titleCase(s, mode) { return mode === 0 ? String(s).toUpperCase() : String(s); }

function renderTemplate(tpl, ctx) {
    return String(tpl).replace(/\{(\w+)\}/g, (m, k) =>
        (ctx[k] !== undefined && ctx[k] !== null) ? String(ctx[k]) : m);
}

function quarterLabel(month) {
    return ['1.º Trimestre', '2.º Trimestre', '3.º Trimestre', '4.º Trimestre'][Math.floor(month / 3)];
}

function semesterLabel(month) {
    return (month < 6 ? '1.º' : '2.º') + ' Semestre';
}

// ----------------------------------------------------------------------------
//  Tipografia
// ----------------------------------------------------------------------------
function findFamilyByName(name) {
    if (!name) return null;
    const wanted = String(name);
    const all = FontFamily.all;
    let family = all.find(f => f.name.toLowerCase() === wanted.toLowerCase());
    if (family) return family;
    const isText = f => !/math|symbol|dingbat|wing ?ding|web ?ding|emoji|icon|ornament|mono|slab/i.test(f.name);
    return all.find(f => isText(f) && f.name.toLowerCase().includes(wanted.toLowerCase())) || null;
}

// Escolhe uma face por estilo: 1 Regular, 2 Medium, 3 Bold, 4 Itálico.
function pickFaceByStyle(family, styleIdx) {
    if (!family || !family.fonts || !family.fonts.length) return null;
    const faces = family.fonts;
    if (styleIdx === 4) {
        let pool = faces.filter(f => f.isItalic && !f.isCondensed && !f.isExpanded);
        if (!pool.length) pool = faces.filter(f => f.isItalic);
        if (pool.length) {
            return pool.slice().sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
        }
        // Sem itálico disponível: cai para Regular.
        styleIdx = 1;
    }
    let pool = faces.filter(f => !f.isItalic && !f.isCondensed && !f.isExpanded);
    if (!pool.length) pool = faces.filter(f => !f.isItalic);
    if (!pool.length) pool = faces;
    const target = styleIdx === 3 ? 700 : styleIdx === 2 ? 500 : 400;
    return pool.slice().sort((a, b) => Math.abs(a.weight - target) - Math.abs(b.weight - target))[0] || pool[0];
}

// Família principal + faces automáticas (Regular/Medium/Bold) e família de fallback.
function resolveMainFamily(nameOrFamily) {
    let family = null;
    if (nameOrFamily && nameOrFamily.fonts) {
        family = nameOrFamily;
    } else if (nameOrFamily) {
        family = findFamilyByName(nameOrFamily);
    } else {
        const wanted = ['Helvetica Neue', 'Helvetica', 'Neue Haas Grotesk', 'Aktiv Grotesk',
                        'Univers', 'Inter', 'Arial', 'Roboto'];
        for (const w of wanted) { family = findFamilyByName(w); if (family) break; }
    }
    if (!family) {
        const def = Font.createDefault();
        return { fam: null, def: def, regular: def, medium: def, bold: def, familyName: def.familyName };
    }
    return {
        fam: family,
        def: null,
        regular: pickFaceByStyle(family, 1) || family.fonts[0],
        medium: pickFaceByStyle(family, 2) || family.fonts[0],
        bold: pickFaceByStyle(family, 3) || family.fonts[0],
        familyName: family.name
    };
}

// Resolve as faces por papel. autoStyle: 1 Regular, 2 Medium, 3 Bold.
function faceFor(main, overrideName, chosenStyle, autoStyle) {
    let fam = main.fam;
    if (overrideName) {
        const f = findFamilyByName(overrideName);
        if (f) fam = f;
    }
    const style = chosenStyle > 0 ? chosenStyle : autoStyle;
    if (!fam) {
        if (style === 3) return main.bold;
        if (style === 2) return main.medium;
        if (style === 4 && main.def) return main.def;
        return main.regular;
    }
    return pickFaceByStyle(fam, style) || main.regular;
}

function resolveFonts(p) {
    const main = resolveMainFamily(p.main);
    return {
        title: faceFor(main, p.title, p.styleTitle, 3),
        day: faceFor(main, p.days, p.styleDays, 1),
        dayBold: faceFor(main, p.days, p.styleDays, 3),
        head: faceFor(main, p.labels, p.styleLabels, 2),
        hour: faceFor(main, p.labels, p.styleLabels, 1),
        familyName: main.familyName
    };
}

// ----------------------------------------------------------------------------
//  Construtores de Nós
// ----------------------------------------------------------------------------
function makeBuilders(doc, cfg) {
    const pxPerPt = doc.dpi / 72;
    const fmt = doc.format;
    const trackPx = (cfg && cfg.tracking) ? cfg.tracking * pxPerPt : 0;
    const leading = (cfg && cfg.leading) ? cfg.leading : 0;

    function rect(builder, x, y, w, h, colour) {
        if (w <= 0 || h <= 0) return;
        const def = ShapeNodeDefinition.create(ShapeRectangle.create(), new Rectangle(x, y, w, h), colour);
        builder.addShapeNode(def);
    }
    function rule(builder, x, y, w, thickness, colour) {
        rect(builder, x, y - thickness / 2, w, thickness, colour);
    }
    function vrule(builder, x, y, h, thickness, colour) {
        rect(builder, x - thickness / 2, y, thickness, h, colour);
    }
    function applyPara(sb, align) {
        const pa = sb.paragraphAtts;
        pa.alignXType = align || ParagraphAlignXType.Left;
        if (leading > 0 && ParagraphLeadingType) {
            try {
                pa.leadingType = ParagraphLeadingType.RelativeToHeight;
                pa.relativeLeading = leading;
            } catch (e) {}
        }
        sb.setParagraphAtts(pa);
    }
    function applyGlyph(sb, ga) {
        try { sb.setGlyphAtts(ga); return; } catch (e) {}
        // Recua removendo o tracking, caso a versão do Affinity não o aceite.
        if (trackPx) {
            try { delete ga.characterSpacing; } catch (e2) {}
            try { sb.setGlyphAtts(ga); } catch (e3) {}
        }
    }
    function text(builder, x, y, w, h, str, face, sizePx, colour, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        const ga = sb.glyphAtts;
        ga.height = sizePx;
        if (face) ga.font = face;
        ga.brushFill = FillDescriptor.createSolid(colour);
        if (trackPx) { try { ga.characterSpacing = trackPx; } catch (e) {} }
        applyGlyph(sb, ga);
        applyPara(sb, align);
        sb.addText(String(str));
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }
    function richText(builder, x, y, w, h, runs, sizePx, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        applyPara(sb, align);
        for (const r of runs) {
            const ga = sb.glyphAtts;
            ga.height = r.size || sizePx;
            if (r.face) ga.font = r.face;
            ga.brushFill = FillDescriptor.createSolid(r.colour);
            if (trackPx) { try { ga.characterSpacing = trackPx; } catch (e) {} }
            applyGlyph(sb, ga);
            sb.addText(String(r.text));
        }
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }
    return { rect, rule, vrule, text, richText, applyPara, pxPerPt };
}

// ----------------------------------------------------------------------------
//  Utilitários de célula (alinhamento)
// ----------------------------------------------------------------------------
function hAlignOf(cfg) {
    if (cfg.alignH === 1) return ParagraphAlignXType.Centre;
    if (cfg.alignH === 2) return ParagraphAlignXType.Right;
    return ParagraphAlignXType.Left;
}

// Posição vertical do bloco do número dentro da célula.
function cellNumY(cy, ch, padTop, blockH, vAlign) {
    if (vAlign === 1) return cy + Math.max((ch - blockH) / 2, 0);
    if (vAlign === 2) return cy + ch - blockH - padTop;
    return cy + padTop;
}

// ----------------------------------------------------------------------------
//  Moldura comum (fundo, vista, borda)
// ----------------------------------------------------------------------------
function drawCalendar(B, area, cfg, drawView) {
    if (cfg.showBg) B.rect(B.b, area.x, area.y, area.w, area.h, C_bg(cfg));
    drawView(B, area, cfg);
    if (cfg.showBorder) {
        const t = Math.max(Math.min(area.w, area.h) * 0.002, 1.5);
        B.rect(B.b, area.x, area.y, area.w, t, cfg.C.ink);
        B.rect(B.b, area.x, area.y + area.h - t, area.w, t, cfg.C.ink);
        B.rect(B.b, area.x, area.y, t, area.h, cfg.C.ink);
        B.rect(B.b, area.x + area.w - t, area.y, t, area.h, cfg.C.ink);
    }
}
function C_bg(cfg) { return cfg.C.bg; }

// ----------------------------------------------------------------------------
//  Legenda de feriado/data marcada
// ----------------------------------------------------------------------------
function flagOf(cfg, date) {
    return cfg.flags[date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate()] || null;
}

// ----------------------------------------------------------------------------
//  Vista: MÊS
// ----------------------------------------------------------------------------
function drawMonth(B, area, cfg) {
    const { rect, rule, vrule, text, pxPerPt } = B;
    const W = cfg.weekDays;
    const { showGrid, showVerticals, showHeader, boldWeekend, showAdjacent,
            showWeekNumbers, showTitle, today, C } = cfg;

    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);
    const margin = cfg.margin > 0 ? cfg.margin * pxPerPt : Math.min(area.w, area.h) * 0.055;
    const gx = area.x + margin;
    const gy0 = area.y + margin;
    const gw = area.w - margin * 2;
    const titleSize = S(cfg.sizes.title, area.w * 0.052);
    const titleH = titleSize * 1.25;
    const hAlign = hAlignOf(cfg);
    const vAlign = cfg.alignV;

    if (showTitle) {
        const str = cfg.periodTitle;
        text(B.b, gx, gy0, gw * 0.8, titleH * 1.6, str, cfg.fonts.title, titleSize, C.ink);
        text(B.b, gx, gy0 + titleH * 0.02, gw, titleH * 1.6,
             fmtYearNum(cfg.year, cfg.fmtYear), cfg.fonts.day, titleSize, C.ink, ParagraphAlignXType.Right);
        if (cfg.showAccentBar) {
            rect(B.b, gx, gy0 + titleH * 1.45, titleSize * 1.5,
                 Math.max(area.w * 0.006, 3), C.accent);
        }
    }

    const wkColW = showWeekNumbers ? Math.max(margin, gw * 0.05) : 0;
    const wkGap = showWeekNumbers ? gw * 0.018 : 0;
    const gridX = gx + wkColW + wkGap;
    const gridW = gw - wkColW - wkGap;
    const colW = gridW / W.length;

    const cells = buildMonthCells(cfg.year, cfg.month, W);
    const numWeeks = Math.ceil(cells.length / W.length);
    const gridTop = gy0 + (showTitle ? titleH * 2.0 : 0);
    const gridBottom = area.y + area.h - margin;
    const hair = Math.max(area.w * 0.0012, 1);
    const hairStrong = hair * 2;
    const inset = colW * 0.08;
    const headSize = S(cfg.sizes.head, Math.max(colW * 0.185, area.w * 0.013));
    const headerH = showHeader ? headSize * 2.3 : 0;
    const bodyTop = gridTop + headerH;
    const rowH = (gridBottom - bodyTop) / numWeeks;
    const daySize = S(cfg.sizes.day, Math.min(rowH * 0.24, colW * 0.34));
    const wkSize = S(cfg.sizes.week, daySize * 0.72);
    const labSize = Math.max(daySize * 0.42, 5);
    const cellPadTop = rowH * 0.16;
    const numBlockH = daySize * 1.25;

    if (showHeader) {
        const headY = gridTop + (headerH - headSize) * 0.34;
        for (let c = 0; c < W.length; c++) {
            const jsDay = W[c];
            const isWknd = (jsDay === 0 || jsDay === 6);
            text(B.b, gridX + c * colW + inset, headY, colW - inset * 2, headerH,
                 headerLabel(jsDay, cfg.headFmt),
                 cfg.fonts.head, headSize, isWknd ? C.accent : C.ink, hAlign);
        }
        if (showWeekNumbers) {
            text(B.b, gx, headY, wkColW * 2, headerH,
                 L.weekAbbr, cfg.fonts.head, headSize, C.muted, ParagraphAlignXType.Right);
        }
    }

    if (showGrid) {
        for (let r = 0; r <= numWeeks; r++) {
            const yy = bodyTop + r * rowH;
            const strong = r === 0;
            const x0 = strong && showWeekNumbers ? gx : gridX;
            const w0 = strong && showWeekNumbers ? gw : gridW;
            rule(B.b, x0, yy, w0, strong ? hairStrong : hair, strong ? C.ink : C.rule);
        }
        if (showVerticals) {
            for (let c = 0; c <= W.length; c++) {
                vrule(B.b, gridX + c * colW, bodyTop, rowH * numWeeks, hair, C.rule);
            }
        }
    }

    const drawCell = (dObj, col, row, muted) => {
        if (muted && !showAdjacent) return;
        const cx = gridX + col * colW;
        const cy = bodyTop + row * rowH;
        const jsDay = dObj.getDay();
        const isWknd = (jsDay === 0 || jsDay === 6);
        const isToday = today && sameDay(dObj, today);
        let colour = muted ? C.muted : (isWknd ? C.accent : C.ink);
        let face = cfg.fonts.day;
        if (!muted && isWknd && boldWeekend) face = cfg.fonts.dayBold;
        if (isToday) { colour = C.accent; face = cfg.fonts.dayBold; }

        const numY = cellNumY(cy, rowH, cellPadTop, numBlockH, vAlign);
        text(B.b, cx + inset, numY, colW - inset * 2, numBlockH,
             fmtDayNum(dObj.getDate(), cfg.fmtDay), face, daySize, colour, hAlign);

        let belowEnd = numY + numBlockH;
        let aboveStart = numY;
        if (isToday) {
            const barY = vAlign === 2 ? numY - hairStrong * 2.5 : numY + daySize * 1.15;
            rect(B.b, cx + inset, barY, daySize * 1.1, hairStrong * 1.5, C.accent);
            if (vAlign === 2) aboveStart = barY;
            else belowEnd = Math.max(belowEnd, barY + hairStrong * 1.5);
        }

        const label = muted ? null : flagOf(cfg, dObj);
        if (label) {
            const ly = vAlign === 2 ? aboveStart - labSize * 1.4 : belowEnd + rowH * 0.012;
            const avail = vAlign === 2 ? (ly - (cy + cellPadTop * 0.3))
                                       : (cy + rowH - labSize * 1.1 - ly);
            if (avail >= labSize * 0.75) {
                text(B.b, cx + inset, ly, colW - inset * 2, labSize * 1.4,
                     label, cfg.fonts.head, labSize, C.flag, hAlign);
            }
        }
    };

    for (const cell of cells) {
        drawCell(cell.date, cell.col, cell.row, cell.muted);
    }

    if (showWeekNumbers) {
        let week1RowStart = null;
        if (!cfg.weekNumberIso) {
            week1RowStart = rowStartOf(new Date(cfg.year, 0, 1), W[0]);
        }
        for (let r = 0; r < numWeeks; r++) {
            const rowStart = cells[r * W.length].date;
            let wn;
            if (cfg.weekNumberIso) {
                wn = isoWeek(W[0] === 0 ? addDays(rowStart, 1) : rowStart);
            } else {
                wn = Math.round((rowStart - week1RowStart) / 604800000) + 1;
            }
            text(B.b, gx, bodyTop + r * rowH + cellPadTop, wkColW, rowH * 0.5,
                 fmtWeekNum(wn, cfg.fmtWeek), cfg.fonts.day, wkSize, C.muted, ParagraphAlignXType.Right);
        }
    }
}

// ----------------------------------------------------------------------------
//  Vista: ANO / TRIMESTRE / SEMESTRE (mini-meses em grade)
// ----------------------------------------------------------------------------
const YEAR_GRIDS = [[4, 3], [3, 4], [6, 2], [2, 6], [12, 1], [1, 12]];

function pickGrid(candidates, w, h) {
    const IDEAL = 1.05;
    let best = candidates[0], bestErr = Infinity;
    for (const [c, r] of candidates) {
        const err = Math.abs(Math.log((w / c) / (h / r) / IDEAL));
        if (err < bestErr) { bestErr = err; best = [c, r]; }
    }
    return best;
}

function gridForMonths(count, cfg, w, h) {
    if (count === 12) {
        if (cfg.yearGrid === 7) {
            const c = clampInt(cfg.gridCols, 1, 12);
            // Garante células suficientes para os 12 meses (não transbordar).
            const r = Math.max(clampInt(cfg.gridRows, 1, 12), Math.ceil(12 / c));
            return [c, r];
        }
        if (cfg.yearGrid >= 1 && cfg.yearGrid <= YEAR_GRIDS.length) return YEAR_GRIDS[cfg.yearGrid - 1];
        return pickGrid(YEAR_GRIDS, w, h);
    }
    if (count === 3) return pickGrid([[3, 1], [1, 3]], w, h);
    if (count === 6) return pickGrid([[3, 2], [2, 3], [6, 1], [1, 6]], w, h);
    return pickGrid([[count, 1], [1, count]], w, h);
}

function drawMonthsGrid(B, area, cfg, entries) {
    const { text, rect, pxPerPt } = B;
    const W = cfg.weekDays;
    const { showHeader, boldWeekend, showTitle, today, C } = cfg;

    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);
    const margin = cfg.margin > 0 ? cfg.margin * pxPerPt : Math.min(area.w, area.h) * 0.05;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;
    const titleSize = S(cfg.sizes.title, area.w * 0.032);
    const titleH = titleSize * 1.6;
    const hAlign = hAlignOf(cfg);

    if (showTitle) {
        text(B.b, gx, gy, gw, titleH * 1.4, cfg.periodTitle, cfg.fonts.title, titleSize, C.ink);
        if (cfg.showAccentBar) {
            rect(B.b, gx, gy + titleH * 1.05, titleSize * 1.4, Math.max(area.w * 0.004, 3), C.accent);
        }
    }

    const areaTop = gy + (showTitle ? titleH * 1.6 : 0);
    const availH = gh - (areaTop - gy);
    const [cols, rows] = gridForMonths(entries.length, cfg, gw, availH);
    const gutterX = cfg.gutter > 0 ? cfg.gutter * pxPerPt
        : (cols > 1 ? Math.min(gw * 0.035, gw * 0.105 / (cols - 1)) : 0);
    const gutterY = cfg.gutter > 0 ? cfg.gutter * pxPerPt
        : (rows > 1 ? Math.min(gh * 0.05, gh * 0.10 / (rows - 1)) : 0);
    const cellW = (gw - gutterX * (cols - 1)) / cols;
    const cellH = (availH - gutterY * (rows - 1)) / rows;
    const sideTitle = cellW > cellH * 2;
    const mTitleSize = S(cfg.sizes.month,
        sideTitle ? Math.min(cellH * 0.16, cellW * 0.05) : Math.min(cellW * 0.11, cellH * 0.11));
    const titleColW = sideTitle ? mTitleSize * 7.5 : 0;
    const titleRowH = sideTitle ? 0 : mTitleSize * 1.9;
    const rawColW = (cellW - titleColW) / W.length;
    const rawRowH = (cellH - titleRowH) / 7;
    const colW = Math.min(rawColW, rawRowH * 1.8);
    const rowH = Math.min(rawRowH, colW * 1.15);
    const numSize = S(cfg.sizes.day, Math.min(colW * 0.58, rowH * 0.62));
    const headSize = S(cfg.sizes.head, Math.min(colW * 0.5, rowH * 0.54));
    const numBlockH = numSize * 1.15;
    const hair = Math.max(area.w * 0.001, 1);

    for (let k = 0; k < entries.length; k++) {
        const { year, month } = entries[k];
        const cx = gx + (k % cols) * (cellW + gutterX);
        const cy = areaTop + Math.floor(k / cols) * (cellH + gutterY);
        text(B.b, cx, cy, sideTitle ? titleColW : cellW, mTitleSize * 1.4,
             titleCase(L.months[month], cfg.titleCase), cfg.fonts.title, mTitleSize, C.ink);
        const gridX = cx + titleColW;
        const gridTop = cy + titleRowH;
        if (showHeader) {
            for (let c = 0; c < W.length; c++) {
                const jsDay = W[c];
                const isWknd = (jsDay === 0 || jsDay === 6);
                text(B.b, gridX + c * colW, gridTop, colW, rowH,
                     L.daysMini[jsDay === 0 ? 6 : jsDay - 1],
                     cfg.fonts.head, headSize, isWknd ? C.accent : C.muted, hAlign);
            }
        }
        const bodyTop = gridTop + (showHeader ? rowH : 0);
        for (const cell of buildMonthCells(year, month, W)) {
            if (cell.muted) continue; // mini-meses não mostram meses adjacentes
            const d = cell.date;
            const isWknd = (d.getDay() === 0 || d.getDay() === 6);
            const isToday = today && sameDay(d, today);
            let colour = isWknd ? C.accent : C.ink;
            let face = (isWknd && boldWeekend) ? cfg.fonts.dayBold : cfg.fonts.day;
            if (isToday) { colour = C.accent; face = cfg.fonts.dayBold; }
            const cellY = bodyTop + cell.row * rowH;
            const numY = cellNumY(cellY, rowH, 0, numBlockH, cfg.alignV);
            text(B.b, gridX + cell.col * colW + colW * 0.06, numY, colW * 0.88, numBlockH,
                 fmtDayNum(d.getDate(), cfg.fmtDay), face, numSize, colour, hAlign);
            const label = flagOf(cfg, d);
            if (label) {
                const fy = cfg.alignV === 2 ? numY - Math.max(hair * 2, numSize * 0.1)
                                            : numY + numBlockH + Math.max(hair, numSize * 0.06);
                rect(B.b, gridX + cell.col * colW + colW * 0.06, fy,
                     Math.max(numSize * 0.7, colW * 0.3), Math.max(hair * 1.5, numSize * 0.1), C.flag);
            }
        }
    }
}

// ----------------------------------------------------------------------------
//  Vista: SEMANA
// ----------------------------------------------------------------------------
function drawWeek(B, area, cfg) {
    const { text, rule, vrule, rect, pxPerPt } = B;
    const W = cfg.weekDays;
    const { showVerticals, showTitle, today, C } = cfg;

    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);
    const margin = cfg.margin > 0 ? cfg.margin * pxPerPt : Math.min(area.w, area.h) * 0.06;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;
    const ref = new Date(cfg.year, cfg.month, cfg.day);
    const rs = rowStartOf(ref, W[0]);
    const lastShown = addDays(rs, (W[W.length - 1] - W[0] + 7) % 7);
    const titleSize = S(cfg.sizes.title, area.w * 0.030);
    const titleH = titleSize * 1.6;
    const hAlign = hAlignOf(cfg);

    const range = (rs.getMonth() === lastShown.getMonth())
        ? `${L.months[rs.getMonth()]} ${fmtYearNum(rs.getFullYear(), cfg.fmtYear)}`
        : `${L.months[rs.getMonth()]} – ${L.months[lastShown.getMonth()]} ${fmtYearNum(lastShown.getFullYear(), cfg.fmtYear)}`;

    if (showTitle) {
        text(B.b, gx, gy, gw * 0.7, titleH * 1.4, titleCase(range, cfg.titleCase),
             cfg.fonts.title, titleSize, C.ink);
        text(B.b, gx, gy, gw, titleH * 1.4,
             `${L.weekAbbr} ${fmtWeekNum(isoWeek(rs), cfg.fmtWeek)}`,
             cfg.fonts.title, titleSize, C.accent, ParagraphAlignXType.Right);
        if (cfg.showAccentBar) {
            rect(B.b, gx, gy + titleH * 1.4, titleSize * 1.5, Math.max(area.w * 0.005, 3), C.accent);
        }
    }

    const gridTop = gy + (showTitle ? titleH * 2.0 : 0);
    const gridH = (gy + gh) - gridTop;
    const colW = gw / W.length;
    const hair = Math.max(area.w * 0.0012, 1);
    const inset = colW * 0.06;
    const headSize = S(cfg.sizes.head, Math.max(colW * 0.11, area.w * 0.011));
    const numSize = S(cfg.sizes.day, colW * 0.42 * 0.92);
    const labSize = Math.max(numSize * 0.34, 5);

    rule(B.b, gx, gridTop, gw, hair * 2, C.ink);
    for (let c = 0; c < W.length; c++) {
        const d = addDays(rs, (W[c] - W[0] + 7) % 7);
        const jsDay = d.getDay();
        const isWknd = (jsDay === 0 || jsDay === 6);
        const isToday = today && sameDay(d, today);
        const cx = gx + c * colW;
        const colour = isWknd ? C.accent : C.ink;
        text(B.b, cx + inset, gridTop + inset, colW - inset * 2, headSize * 1.6,
             headerLabel(jsDay, cfg.headFmt), cfg.fonts.head, headSize, colour, hAlign);
        text(B.b, cx + inset, gridTop + headSize * 2.0, colW - inset * 2, numSize * 1.52,
             fmtDayNum(d.getDate(), cfg.fmtDay),
             isToday ? cfg.fonts.dayBold : cfg.fonts.day, numSize, isToday ? C.accent : colour, hAlign);
        const ruleY = gridTop + headSize * 2.2 + numSize * 1.467;
        rule(B.b, cx + inset, ruleY, colW - inset * 2, hair, C.rule);
        const label = flagOf(cfg, d);
        if (label) {
            text(B.b, cx + inset, ruleY + labSize * 0.7, colW - inset * 2, labSize * 1.5,
                 label, cfg.fonts.head, labSize, C.flag, hAlign);
        }
    }
    if (showVerticals) {
        for (let c = 1; c < W.length; c++) vrule(B.b, gx + c * colW, gridTop, gridH, hair, C.rule);
    }
    rule(B.b, gx, gy + gh, gw, hair, C.rule);
}

// ----------------------------------------------------------------------------
//  Vista: DIA
// ----------------------------------------------------------------------------
function drawDay(B, area, cfg) {
    const { text, richText, rule, vrule, rect, pxPerPt } = B;
    const { showAgenda, agendaStart, agendaEnd, showTitle, today, C } = cfg;

    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);
    const hourLabel = (h) => {
        if (cfg.agenda24h) return pad2(h) + ':00';
        const ap = h < 12 ? 'AM' : 'PM';
        let hh = h % 12; if (hh === 0) hh = 12;
        return hh + ' ' + ap;
    };

    const margin = cfg.margin > 0 ? cfg.margin * pxPerPt : Math.min(area.w, area.h) * 0.08;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;
    const d = new Date(cfg.year, cfg.month, cfg.day);
    const isToday = today && sameDay(d, today);
    const weekdayName = L.daysLong[(d.getDay() + 6) % 7];
    const hair = Math.max(Math.min(area.w, area.h) * 0.0014, 1);
    const wide = (showAgenda || cfg.notesLines > 0) && gw > gh * 1.2;
    const dateW = wide ? gw * 0.40 : gw;
    const u = Math.min(dateW, gh);
    const wSize = S(cfg.sizes.title, Math.min(u * 0.11, gh * 0.10));
    const subSize = Math.min(u * 0.055, gh * 0.05);
    const numSize = S(cfg.sizes.big, wide ? Math.min(dateW * 0.82, gh * 0.52) : Math.min(gw * 0.32, gh * 0.42));
    const hAlign = hAlignOf(cfg);

    let cy = gy;
    if (showTitle) {
        text(B.b, gx, cy, dateW, wSize * 1.4, titleCase(weekdayName, cfg.titleCase),
             cfg.fonts.title, wSize, isToday ? C.accent : C.ink, hAlign);
        if (cfg.showAccentBar) {
            rect(B.b, gx, cy + wSize * 1.25, wSize * 1.5, Math.max(u * 0.012, 3), C.accent);
        }
        cy += wSize * 1.95;
    }
    text(B.b, gx, cy, dateW, numSize * 1.15, fmtDayNum(cfg.day, cfg.fmtDay),
         cfg.fonts.title, numSize, C.ink, hAlign);
    cy += numSize * 1.08;
    if (showTitle) {
        richText(B.b, gx, cy, wide ? dateW : gw, subSize * 1.7, [
            { text: `${L.months[cfg.month]} ${fmtYearNum(cfg.year, cfg.fmtYear)}`, face: cfg.fonts.title, colour: C.ink },
            { text: `  ·  ${L.weekAbbr} ${fmtWeekNum(isoWeek(d), cfg.fmtWeek)}`, face: cfg.fonts.day, colour: C.muted }
        ], subSize, hAlign);
        cy += subSize * 2.6;
    }

    // Feriados / datas marcadas do dia
    const labels = [];
    const fl = flagOf(cfg, d);
    if (fl) labels.push(fl);
    if (labels.length) {
        const labSize = Math.max(subSize * 0.8, 5);
        for (const lb of labels) {
            text(B.b, gx, cy, wide ? dateW : gw, labSize * 1.5, lb,
                 cfg.fonts.head, labSize, C.flag, hAlign);
            cy += labSize * 1.7;
        }
        cy += subSize * 0.4;
    }

    // Linhas de anotação
    const notesLines = clampInt(cfg.notesLines, 0, 40);
    const noteStep = Math.max(subSize * 1.6, 6 * pxPerPt);
    const drawNotes = (x, top, bottom, w) => {
        if (notesLines <= 0) return;
        const n = Math.max(0, Math.min(notesLines, Math.floor((bottom - top) / noteStep)));
        for (let i = 1; i <= n; i++) {
            rule(B.b, x, top + i * noteStep, w, hair, C.rule);
        }
    };

    if (!showAgenda) {
        drawNotes(gx, cy + noteStep * 0.5, gy + gh, gw);
        return;
    }

    const agX = wide ? gx + gw * 0.46 : gx;
    const agW = wide ? gw - gw * 0.46 : gw;
    let top = wide ? gy : cy;
    const fullBottom = gy + gh;
    let bottom = fullBottom;
    if (notesLines > 0 && !wide) {
        bottom = Math.max(top + noteStep, fullBottom - notesLines * noteStep - noteStep * 0.5);
    }
    const availH = bottom - top;
    if (availH < subSize * 2) return;

    let hours = Math.max(1, Math.round(agendaEnd - agendaStart));
    const step = availH / hours;
    const gutterW = agW * 0.13;
    const labSize = S(cfg.sizes.hour, Math.max(Math.min(subSize * 0.78, step * 0.5), 9));

    for (let i = 0; i <= hours; i++) {
        const yy = top + i * step;
        rule(B.b, agX, yy, agW, i === 0 ? hair * 2 : hair, i === 0 ? C.ink : C.rule);
        if (i < hours) {
            text(B.b, agX, yy + step * 0.24, gutterW, step,
                 hourLabel(agendaStart + i), cfg.fonts.hour, labSize, C.muted);
            if (cfg.agendaHalf && i < hours) {
                rule(B.b, agX + gutterW, yy + step / 2, agW - gutterW, hair, C.rule);
            }
        }
    }
    vrule(B.b, agX + gutterW, top, step * hours, hair, C.rule);

    // Linha do horário atual (apenas se a data for hoje)
    if (cfg.agendaNow && today && isToday) {
        const nowH = today.getHours() + today.getMinutes() / 60;
        const frac = (nowH - agendaStart) / Math.max(1, hours);
        if (frac >= 0 && frac <= 1) {
            const yy = top + frac * step * hours;
            rule(B.b, agX, yy, agW, hair * 2, C.accent);
            text(B.b, agX, yy + step * 0.1, gutterW, step,
                 hourLabel(today.getHours()), cfg.fonts.hour, labSize, C.accent);
        }
    }

    if (wide) drawNotes(gx, cy + noteStep * 0.5, fullBottom, dateW);
    else if (notesLines > 0) drawNotes(gx, bottom + noteStep * 0.5, fullBottom, gw);
}

// ----------------------------------------------------------------------------
//  Título do período
// ----------------------------------------------------------------------------
function periodTitle(cfg) {
    if (cfg.view === 0) {
        return cfg.titleText ? titleCase(renderTemplate(cfg.titleText, periodCtx(cfg)), cfg.titleCase)
                             : fmtYearNum(cfg.year, cfg.fmtYear);
    }
    const ctx = periodCtx(cfg);
    const tpl = cfg.titleText ? cfg.titleText : U.titleTplOpts[clampInt(cfg.titleTpl, 0, 3)];
    return titleCase(renderTemplate(tpl, ctx), cfg.titleCase);
}

function periodCtx(cfg) {
    let periodo = '';
    if (cfg.view === 1) periodo = quarterLabel(cfg.month);
    else if (cfg.view === 2) periodo = semesterLabel(cfg.month);
    else if (cfg.view === 3) periodo = L.months[cfg.month];
    return {
        MES: L.months[cfg.month],
        MES_NUM: pad2(cfg.month + 1),
        ANO: fmtYearNum(cfg.year, cfg.fmtYear),
        PERIODO: periodo,
        SEMESTRE: semesterLabel(cfg.month),
        TRIMESTRE: quarterLabel(cfg.month)
    };
}

// ----------------------------------------------------------------------------
//  Presets e Utilitários de Pranchetas
// ----------------------------------------------------------------------------
function findPresetNode(doc) {
    try {
        for (const ch of doc.spreads.first.children) {
            if ((ch.userDescription || '').indexOf(PRESET_TAG) === 0) return ch;
        }
    } catch (e) {}
    return null;
}

function readPreset(node) {
    if (!node) return null;
    try {
        const p = JSON.parse((node.userDescription || '').slice(PRESET_TAG.length));
        return (p && typeof p === 'object') ? p : null;
    } catch (e) { return null; }
}

function writePreset(doc, node, obj) {
    try {
        const s = PRESET_TAG + JSON.stringify(obj);
        if (node) { node.userDescription = s; return; }
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(doc.spreads.first);
        b.addContainerNode(ContainerNodeDefinition.create(s));
        doc.executeCommand(b.createCommand(true));
    } catch (e) {}
}

// Migra presets antigos (v2: vistas 0..3) para a v3.
function migratePreset(p) {
    if (!p || typeof p !== 'object') return {};
    const out = Object.assign({}, p);
    if (out.v === 2 || (out.v === undefined && out.view !== undefined)) {
        const map = [0, 3, 4, 5]; // Ano, Mês, Semana, Dia
        if (typeof out.view === 'number' && map[out.view] !== undefined) out.view = map[out.view];
    }
    delete out.v;
    delete out.slots;
    return out;
}

function rgbOf(colour) {
    try { const v = colour.rgba8; return { r: v.r, g: v.g, b: v.b }; }
    catch (e) { return null; }
}

function colourFrom(v, r, g, b) {
    if (v && typeof v.r === 'number') return RGB8(v.r, v.g, v.b);
    return RGB8(r, g, b);
}

function naturalCmp(a, b) {
    const ax = String(a).match(/\d+|\D+/g) || [];
    const bx = String(b).match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
        const A = ax[i], B = bx[i];
        if (A === undefined) return -1;
        if (B === undefined) return 1;
        if (/^\d/.test(A) && /^\d/.test(B)) {
            const d = parseInt(A, 10) - parseInt(B, 10);
            if (d) return d;
        } else {
            const la = A.toLowerCase(), lb = B.toLowerCase();
            if (la < lb) return -1;
            if (la > lb) return 1;
        }
    }
    return 0;
}

function sortArtboards(list, mode) {
    const box = n => { try { return n.artboardSpreadBaseBox; } catch (e) { return { x: 0, y: 0 }; } };
    const nm = n => { try { return n.userDescription || n.name || ''; } catch (e) { return ''; } };
    const TOL = 2;
    if (mode === 1) {
        list.sort((a, b) => { const A = box(a), B = box(b); return Math.abs(A.y - B.y) > TOL ? A.y - B.y : A.x - B.x; });
    } else if (mode === 2) {
        list.sort((a, b) => { const A = box(a), B = box(b); return Math.abs(A.x - B.x) > TOL ? A.x - B.x : A.y - B.y; });
    } else {
        list.sort((a, b) => naturalCmp(nm(a), nm(b)));
    }
    return list;
}

function sameArtboard(a, b) {
    try {
        const A = a.artboardSpreadBaseBox, B = b.artboardSpreadBaseBox;
        return Math.abs(A.x - B.x) < 0.5 && Math.abs(A.y - B.y) < 0.5;
    } catch (e) { return false; }
}

// Avança o período conforme a vista: 0 Ano, 1 Trimestre, 2 Semestre,
// 3 Mês, 4 Semana, 5 Dia.
function periodStart(typeIdx, y, m, d, i) {
    if (i === 0) return { year: y, month: m, day: d };
    if (typeIdx === 0) return { year: y + i, month: m, day: d };
    if (typeIdx === 1 || typeIdx === 2 || typeIdx === 3) {
        const step = typeIdx === 1 ? 3 : typeIdx === 2 ? 6 : 1;
        const t = new Date(y, m + step * i, 1);
        return { year: t.getFullYear(), month: t.getMonth(), day: d };
    }
    const t = new Date(y, m, d + (typeIdx === 4 ? 7 : 1) * i);
    return { year: t.getFullYear(), month: t.getMonth(), day: t.getDate() };
}

// ----------------------------------------------------------------------------
//  Localização / substituição de calendários existentes
// ----------------------------------------------------------------------------
function isCalendarNode(n) {
    try { return CAL_RE.test(n.userDescription || ''); } catch (e) { return false; }
}

function childrenOf(node) {
    try { return node && node.children ? Array.from(node.children) : []; }
    catch (e) { return []; }
}

// Busca recursiva por calendários sob um nó.
function findCalendars(root) {
    const out = [];
    const walk = (n) => {
        for (const ch of childrenOf(n)) {
            if (isCalendarNode(ch)) { out.push(ch); continue; }
            walk(ch);
        }
    };
    try { walk(root); } catch (e) {}
    return out;
}

function inList(arr, n) {
    for (const x of arr) {
        try { if (x.isSameNode ? x.isSameNode(n) : x === n) return true; } catch (e) {}
    }
    return false;
}

function findNewContainer(target, before) {
    for (const ch of childrenOf(target)) {
        if (isCalendarNode(ch) && !inList(before, ch)) return ch;
    }
    return null;
}

function findInNodes(cmd) {
    try {
        const nn = cmd.newNodes;
        if (nn) for (const n of nn) if (isCalendarNode(n)) return n;
    } catch (e) {}
    return null;
}

function deleteNodes(doc, list) {
    if (!list || !list.length) return;
    doc.deleteSelection(Selection.create(doc, list));
}

function drawInto(builder, doc, area, cfg) {
    const B = makeBuilders(doc, cfg);
    B.b = builder;
    drawCalendar(B, area, cfg, viewDrawer(cfg.view));
}

function viewDrawer(view) {
    if (view === 0 || view === 1 || view === 2) return drawMonthsGridFor;
    if (view === 3) return drawMonth;
    if (view === 4) return drawWeek;
    return drawDay;
}

function drawMonthsGridFor(B, area, cfg) {
    drawMonthsGrid(B, area, cfg, cfg.entries);
}

// Insere um calendário. Tenta primeiro um único comando (undo de 1 passo);
// se o host não aninhar os nós no contêiner, desfaz e usa a fase dupla comprovada.
// scopeNodes: lista de calendários antigos a remover antes de desenhar.
function insertCalendar(doc, target, area, cfg, scopeNodes) {
    const title = `${U.calName} · ${U.views[cfg.view]} ${cfg.year}` +
        (cfg.view >= 1 && cfg.view <= 3 ? ` · ${L.months[cfg.month]}` : '');

    if (scopeNodes && scopeNodes.length) deleteNodes(doc, scopeNodes);
    const hp = doc.history.position;

    // ---- Tentativa A: comando único (contêiner + filhos) --------------------
    if (target) {
        try {
            const before = childrenOf(target);
            const b = AddChildNodesCommandBuilder.create();
            b.setInsertionTarget(target);
            b.addContainerNode(ContainerNodeDefinition.create(title));
            drawInto(b, doc, area, cfg);
            const cmd = b.createCommand(true);
            doc.executeCommand(cmd);
            const cont = findNewContainer(target, before) || findInNodes(cmd);
            if (cont && childrenOf(cont).length > 0) return cont; // aninhou: 1 undo
            doc.history.position = hp; // não aninhou: desfaz a tentativa
        } catch (e) {
            try { doc.history.position = hp; } catch (_) { throw e; }
        }
    }

    // ---- Fase B: contêiner e depois filhos (comprovado) ---------------------
    const before = childrenOf(target);
    const cb = AddChildNodesCommandBuilder.create();
    if (target) cb.setInsertionTarget(target);
    cb.addContainerNode(ContainerNodeDefinition.create(title));
    const ccmd = cb.createCommand(true);
    doc.executeCommand(ccmd);
    let cont = findInNodes(ccmd) || (target && findNewContainer(target, before));
    if (!cont) {
        try { const s = doc.selection.nodes.first; if (isCalendarNode(s)) cont = s; } catch (e) {}
    }
    if (!cont) throw new Error(U.errContainer);
    try {
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(cont);
        drawInto(b, doc, area, cfg);
        doc.executeCommand(b.createCommand(true));
    } catch (e) {
        try { doc.deleteSelection(Selection.create(doc, cont)); } catch (_) {}
        throw e;
    }
    return cont;
}

// Executa vários comandos em um único passo de histórico quando possível.
function executeBatch(doc, cmds) {
    if (!cmds.length) return;
    if (cmds.length === 1) { doc.executeCommand(cmds[0]); return; }
    if (typeof CompoundCommandBuilder !== 'undefined' && CompoundCommandBuilder) {
        const hp = doc.history.position;
        try {
            const cb = CompoundCommandBuilder.create();
            for (const c of cmds) cb.addCommand(c);
            doc.executeCommand(cb.createCommand());
            return;
        } catch (e) {
            try {
                if (doc.history.position !== hp) doc.history.position = hp;
            } catch (_) { throw e; }
        }
    }
    for (const c of cmds) doc.executeCommand(c);
}

// ----------------------------------------------------------------------------
//  Temas prontos (subconjunto de campos)
// ----------------------------------------------------------------------------
const THEMES = [
    { // Suíço Clássico
        ink: { r: 17, g: 17, b: 17 }, accent: { r: 227, g: 6, b: 19 },
        rule: { r: 150, g: 150, b: 150 }, muted: { r: 176, g: 176, b: 176 },
        flag: { r: 227, g: 6, b: 19 }, showBg: false, showBorder: false,
        grid: true, verticals: false, boldWeekend: false, accentBar: true,
        titleCase: 0, alignH: 0, alignV: 0, adjacent: true, weekNumbers: false
    },
    { // Minimal Preto
        ink: { r: 0, g: 0, b: 0 }, accent: { r: 0, g: 0, b: 0 },
        rule: { r: 130, g: 130, b: 130 }, muted: { r: 150, g: 150, b: 150 },
        flag: { r: 0, g: 0, b: 0 }, showBg: false, showBorder: false,
        grid: false, verticals: false, boldWeekend: true, accentBar: false,
        titleCase: 0, alignH: 0, alignV: 0, adjacent: false, weekNumbers: false
    },
    { // Alto Contraste
        ink: { r: 0, g: 0, b: 0 }, accent: { r: 230, g: 0, b: 0 },
        rule: { r: 0, g: 0, b: 0 }, muted: { r: 70, g: 70, b: 70 },
        flag: { r: 230, g: 0, b: 0 }, showBg: false, showBorder: true,
        grid: true, verticals: true, boldWeekend: true, accentBar: true,
        titleCase: 0, alignH: 0, alignV: 0, adjacent: true, weekNumbers: true
    },
    { // Noturno
        ink: { r: 240, g: 240, b: 240 }, accent: { r: 255, g: 59, b: 48 },
        rule: { r: 90, g: 90, b: 95 }, muted: { r: 140, g: 140, b: 150 },
        flag: { r: 255, g: 205, b: 0 }, bg: { r: 17, g: 17, b: 20 },
        showBg: true, showBorder: true,
        grid: true, verticals: false, boldWeekend: false, accentBar: true,
        titleCase: 0, alignH: 0, alignV: 0, adjacent: true, weekNumbers: false
    },
    { // Corporativo Azul
        ink: { r: 20, g: 30, b: 60 }, accent: { r: 0, g: 90, b: 200 },
        rule: { r: 170, g: 180, b: 200 }, muted: { r: 150, g: 160, b: 180 },
        flag: { r: 0, g: 90, b: 200 }, showBg: false, showBorder: false,
        grid: true, verticals: false, boldWeekend: false, accentBar: true,
        titleCase: 0, alignH: 1, alignV: 0, adjacent: true, weekNumbers: true
    }
];

// ----------------------------------------------------------------------------
//  Valores padrão e leitura/gravação dos campos
// ----------------------------------------------------------------------------
function makeDefaults(now) {
    return {
        view: 3, yearGrid: 0, gridCols: 4, gridRows: 3,
        year: now.getFullYear(), month: now.getMonth(), day: now.getDate(),
        weekStart: 0, weekNumMode: 0, workweek: false,
        seqOn: false, seqCount: 12, seqOrder: 0, seqMode: 0,
        showHolidays: true, showMarked: true, markedDates: '',
        agenda: true, agendaFrom: 8, agendaTo: 20, timeFormat: 1,
        agendaHalf: false, agendaNow: true, notesLines: 0,
        showTitle: true, header: true, grid: true, verticals: false, accentBar: true,
        showBg: false, showBorder: false, adjacent: true, weekNumbers: false,
        boldWeekend: false, markToday: true,
        font: null, fontTitle: null, fontDays: null, fontLabels: null,
        styleTitle: 0, styleDays: 0, styleLabels: 0,
        sizeTitle: 0, sizeMonth: 0, sizeDay: 0, sizeHead: 0, sizeWeek: 0, sizeHour: 0, sizeBig: 0,
        titleTpl: 0, titleText: '', headFmt: 0, fmtDay: 0, fmtWeek: 0, fmtYear: 0, titleCase: 0,
        alignH: 0, alignV: 0, tracking: 0, leading: 0,
        margin: 0, gutter: 0,
        ink: { r: 17, g: 17, b: 17 }, accent: { r: 227, g: 6, b: 19 },
        rule: { r: 150, g: 150, b: 150 }, muted: { r: 176, g: 176, b: 176 },
        flag: { r: 227, g: 6, b: 19 }, bg: { r: 255, g: 255, b: 255 }
    };
}

function readAll(dlg, prev) {
    const out = {};
    const ctl = dlg.__ctl || {};
    for (const k in ctl) {
        const e = ctl[k];
        try {
            if (e.kind === 'combo') out[k] = e.ctl.selectedIndex;
            else if (e.kind === 'check') out[k] = e.ctl.value;
            else if (e.kind === 'num') out[k] = e.ctl.value;
            else if (e.kind === 'colour') out[k] = rgbOf(e.ctl.value);
            else if (e.kind === 'font') out[k] = e.ctl.font ? e.ctl.font.familyName : null;
            else if (e.kind === 'text') out[k] = e.ctl.text;
        } catch (err) {
            if (prev && prev[k] !== undefined) out[k] = prev[k];
        }
    }
    // Campos sem controle equivalente (ex.: addTextBox indisponível) preservam o valor.
    if (prev) {
        for (const k in prev) {
            if (!(k in out) && !(k in ctl)) out[k] = prev[k];
        }
    }
    return out;
}

function applyValues(dlg, obj) {
    if (!obj) return;
    const ctl = dlg.__ctl || {};
    for (const k in ctl) {
        if (obj[k] === undefined || obj[k] === null) continue;
        const e = ctl[k];
        try {
            if (e.kind === 'combo') e.ctl.selectedIndex = clampInt(obj[k], 0, 99);
            else if (e.kind === 'check') e.ctl.value = !!obj[k];
            else if (e.kind === 'num') e.ctl.value = Number(obj[k]);
            else if (e.kind === 'colour') {
                const c = obj[k];
                e.ctl.value = RGB8(c.r, c.g, c.b);
            } else if (e.kind === 'font') {
                const fam = FontFamily.all.find(f => f.name === obj[k]);
                if (fam) e.ctl.fontFamily = fam;
            } else if (e.kind === 'text') e.ctl.text = String(obj[k]);
        } catch (err) {}
    }
}

// ----------------------------------------------------------------------------
//  Montagem do cfg de desenho a partir dos valores lidos
// ----------------------------------------------------------------------------
function buildCfg(v, now) {
    const year = clampInt(v.year, 1900, 2200);
    const month = clampInt(v.month, 0, 11);
    const day = clampInt(v.day, 1, daysInMonth(year, month));
    const weekStartsMonday = v.weekStart !== 1;
    const workweek = !!v.workweek;
    const view = clampInt(v.view, 0, 5);

    const fonts = resolveFonts({
        main: v.font || null,
        title: v.fontTitle || null,
        days: v.fontDays || null,
        labels: v.fontLabels || null,
        styleTitle: clampInt(v.styleTitle, 0, 4),
        styleDays: clampInt(v.styleDays, 0, 4),
        styleLabels: clampInt(v.styleLabels, 0, 4)
    });

    const C = {
        ink: colourFrom(v.ink, 17, 17, 17),
        accent: colourFrom(v.accent, 227, 6, 19),
        rule: colourFrom(v.rule, 150, 150, 150),
        muted: colourFrom(v.muted, 176, 176, 176),
        flag: colourFrom(v.flag, 227, 6, 19),
        bg: colourFrom(v.bg, 255, 255, 255)
    };

    const agendaStart = clampInt(v.agendaFrom, 0, 23);
    let agendaEnd = clampInt(v.agendaTo, 1, 24);
    if (agendaEnd <= agendaStart) agendaEnd = Math.min(24, agendaStart + 1);

    const entries = [];
    if (view === 0) {
        for (let m = 0; m < 12; m++) entries.push({ year: year, month: m });
    } else if (view === 1 || view === 2) {
        const n = view === 1 ? 3 : 6;
        for (let k = 0; k < n; k++) {
            const t = new Date(year, month + k, 1);
            entries.push({ year: t.getFullYear(), month: t.getMonth() });
        }
    }

    const cfg = {
        view: view,
        year: year, month: month, day: day,
        weekStartsMonday: weekStartsMonday,
        weekNumberIso: v.weekNumMode !== 1,
        workweek: workweek,
        weekDays: weekDaysFor(weekStartsMonday, workweek),
        showHeader: !!v.header,
        showGrid: !!v.grid,
        showVerticals: !!v.verticals,
        showAdjacent: !!v.adjacent,
        showWeekNumbers: !!v.weekNumbers,
        boldWeekend: !!v.boldWeekend,
        showTitle: !!v.showTitle,
        showAccentBar: !!v.accentBar,
        showBg: !!v.showBg,
        showBorder: !!v.showBorder,
        markToday: !!v.markToday,
        showAgenda: !!v.agenda,
        agendaStart: agendaStart, agendaEnd: agendaEnd,
        agenda24h: v.timeFormat === 1,
        agendaHalf: !!v.agendaHalf,
        agendaNow: !!v.agendaNow,
        notesLines: clampInt(v.notesLines, 0, 40),
        yearGrid: clampInt(v.yearGrid, 0, 7),
        gridCols: clampInt(v.gridCols, 1, 12),
        gridRows: clampInt(v.gridRows, 1, 12),
        sizes: {
            title: Math.max(0, Number(v.sizeTitle) || 0),
            month: Math.max(0, Number(v.sizeMonth) || 0),
            day: Math.max(0, Number(v.sizeDay) || 0),
            head: Math.max(0, Number(v.sizeHead) || 0),
            week: Math.max(0, Number(v.sizeWeek) || 0),
            hour: Math.max(0, Number(v.sizeHour) || 0),
            big: Math.max(0, Number(v.sizeBig) || 0)
        },
        today: v.markToday ? now : null,
        fonts: fonts,
        C: C,
        titleTpl: clampInt(v.titleTpl, 0, 3),
        titleText: (v.titleText || '').trim(),
        titleCase: clampInt(v.titleCase, 0, 1),
        headFmt: clampInt(v.headFmt, 0, 3),
        fmtDay: clampInt(v.fmtDay, 0, 1),
        fmtWeek: clampInt(v.fmtWeek, 0, 3),
        fmtYear: clampInt(v.fmtYear, 0, 1),
        alignH: clampInt(v.alignH, 0, 2),
        alignV: clampInt(v.alignV, 0, 2),
        tracking: Number(v.tracking) || 0,
        leading: clampInt(v.leading, 0, 400),
        margin: Math.max(0, Number(v.margin) || 0),
        gutter: Math.max(0, Number(v.gutter) || 0),
        entries: entries,
        flags: buildFlags(year, !!v.showHolidays, !!v.showMarked, v.markedDates)
    };
    cfg.periodTitle = periodTitle(cfg);
    return cfg;
}

function cfgSummary(cfg) {
    if (cfg.view === 0) return `Ano ${fmtYearNum(cfg.year, cfg.fmtYear)}`;
    if (cfg.view === 1) return `${quarterLabel(cfg.month)} ${fmtYearNum(cfg.year, cfg.fmtYear)}`;
    if (cfg.view === 2) return `${semesterLabel(cfg.month)} ${fmtYearNum(cfg.year, cfg.fmtYear)}`;
    if (cfg.view === 3) return `${L.months[cfg.month]} ${fmtYearNum(cfg.year, cfg.fmtYear)}`;
    if (cfg.view === 4) return `${L.weekAbbr} ${fmtWeekNum(isoWeek(new Date(cfg.year, cfg.month, cfg.day)), cfg.fmtWeek)}`;
    return `${fmtDayNum(cfg.day, cfg.fmtDay)} de ${L.months[cfg.month]}`;
}

// ----------------------------------------------------------------------------
//  Diálogo Principal
// ----------------------------------------------------------------------------
function buildDialog(defaults, targetLabel) {
    const dlg = Dialog.create(U.title);
    dlg.initialWidth = 700;
    try { dlg.isResizable = true; } catch (e) {}
    dlg.__ctl = {};
    dlg.afterChange = function () {}; // ligado pelo main (pré-visualização)

    const reg = (key, kind, ctl) => { dlg.__ctl[key] = { kind: kind, ctl: ctl }; return ctl; };
    const T = k => (F[k] && F[k].tip) ? F[k].tip : '';
    const LB = k => (F[k] && F[k].label) ? F[k].label : k;
    const UNT = (u) => (u === 'point' ? UnitType.Point : UnitType.Number);

    const combo = (p, key, opts, def) =>
        reg(key, 'combo', p.addComboBox(LB(key), opts, def === undefined ? 0 : def).setDescription(T(key)));
    const check = (p, key, def) =>
        reg(key, 'check', p.addCheckBox(LB(key), !!def).setIsFullWidth().setDescription(T(key)));
    const num = (p, key, def, min, max, unit, prec) =>
        reg(key, 'num', p.addUnitValueEditor(LB(key), UNT(unit), UNT(unit), def, min, max)
            .setPrecision(prec === undefined ? 0 : prec).setDescription(T(key)));
    const colour = (p, key, c) => {
        const rgb = (c && c.r !== undefined) ? [c.r, c.g, c.b] : c;
        return reg(key, 'colour', p.addColourPicker(LB(key), RGB8(rgb[0], rgb[1], rgb[2])).setDescription(T(key)));
    };
    const fontp = (p, key) => {
        const ctl = reg(key, 'font', p.addFontPicker(LB(key)).setDescription(T(key)));
        const want = defaults[key];
        if (want) {
            try { const fam = FontFamily.all.find(f => f.name === want); if (fam) ctl.fontFamily = fam; } catch (e) {}
        }
        return ctl;
    };
    const textin = (p, key, def) => {
        if (typeof p.addTextBox !== 'function') return null;
        return reg(key, 'text', p.addTextBox(LB(key), def === undefined ? '' : def).setDescription(T(key)));
    };

    // A API de diálogo não permite grupos aninhados: DialogGroup não possui
    // addGroup (só DialogColumn tem). Um "subgrupo" é simulado com uma pilha
    // de colunas de largura única contendo um grupo.
    const sub = (parent, name) => parent.addColumnStack().addColumn().addGroup(name);

    const colL = dlg.addColumn();
    const colR = dlg.addColumn();
    try { colL.widthProportion = 1.15; } catch (e) {}
    try { colR.widthProportion = 1.35; } catch (e) {}

    colL.addGroup().addStaticText(null, U.targetPrefix + targetLabel).setIsFullWidth();

    const sections = {};
    function section(col, key, title, expanded, tip) {
        let s, body;
        if (SECTION_HEADER === 'arrow') {
            const head = col.addGroup();
            const openBtn = head.addButton('▼  ' + title).setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            const shutBtn = head.addButton('▶  ' + title).setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            body = col.addGroup();
            body.enableSeparator = true;
            const st = { open: expanded };
            const sync = () => { openBtn.isVisible = st.open; shutBtn.isVisible = !st.open; body.isVisible = st.open; };
            openBtn.onClickHandler = () => { st.open = false; sync(); };
            shutBtn.onClickHandler = () => { st.open = true; sync(); };
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
    dlg.expandSection = (key, on = true) => { if (sections[key]) sections[key].set(on !== false); };

    // ============================ COLUNA ESQUERDA ===========================

    // --- Tipo ---
    const gType = colL.addGroup(U.secType);
    const gridWrap = sub(gType);
    dlg.view = combo(gType, 'view', U.views, defaults.view);
    dlg.yearGrid = combo(gridWrap, 'yearGrid', U.yearGridOpts, defaults.yearGrid);
    const customWrap = sub(gridWrap);
    dlg.gridCols = num(customWrap, 'gridCols', defaults.gridCols, 1, 12, 'number');
    dlg.gridRows = num(customWrap, 'gridRows', defaults.gridRows, 1, 12, 'number');

    // --- Data ---
    const gDate = section(colL, 'date', U.secDate, true, U.secDateTip);
    dlg.year = num(gDate, 'year', defaults.year, 1900, 2200, 'number');
    dlg.month = combo(gDate, 'month', L.months, defaults.month);
    dlg.day = num(gDate, 'day', defaults.day, 1, 31, 'number');
    dlg.weekStart = combo(gDate, 'weekStart', U.weekStartOpts, defaults.weekStart);
    dlg.weekNumMode = combo(gDate, 'weekNumMode', U.weekNumModeOpts, defaults.weekNumMode);
    dlg.workweek = check(gDate, 'workweek', defaults.workweek);

    // --- Sequência ---
    const gSeq = section(colL, 'sequence', U.secSequence, false, U.secSeqTip);
    dlg.seqOn = check(gSeq, 'seqOn', defaults.seqOn);
    const seqWrap = sub(gSeq);
    dlg.seqCount = num(seqWrap, 'seqCount', defaults.seqCount, 1, 60, 'number');
    dlg.seqOrder = combo(seqWrap, 'seqOrder', U.seqOrderOpts, defaults.seqOrder);
    dlg.seqMode = combo(seqWrap, 'seqMode', U.seqModeOpts, defaults.seqMode);

    // --- Feriados e datas marcadas ---
    const gDates = section(colL, 'dates', U.secDates, false, U.secDatesTip);
    dlg.showHolidays = check(gDates, 'showHolidays', defaults.showHolidays);
    dlg.showMarked = check(gDates, 'showMarked', defaults.showMarked);
    textin(gDates, 'markedDates', defaults.markedDates || '');

    // --- Agenda ---
    const gAgenda = section(colL, 'agenda', U.secAgenda, false, U.secAgendaTip);
    dlg.agenda = check(gAgenda, 'agenda', defaults.agenda);
    dlg.agendaFrom = num(gAgenda, 'agendaFrom', defaults.agendaFrom, 0, 23, 'number');
    dlg.agendaTo = num(gAgenda, 'agendaTo', defaults.agendaTo, 1, 24, 'number');
    dlg.timeFormat = combo(gAgenda, 'timeFormat', U.timeFormatOpts, defaults.timeFormat);
    dlg.agendaHalf = check(gAgenda, 'agendaHalf', defaults.agendaHalf);
    dlg.agendaNow = check(gAgenda, 'agendaNow', defaults.agendaNow);
    dlg.notesLines = num(gAgenda, 'notesLines', defaults.notesLines, 0, 40, 'number');

    // --- Presets e temas ---
    const gPre = section(colL, 'presets', U.secPresets, false, U.secPresetsTip);
    const temaRow = sub(gPre);
    dlg.tema = temaRow.addComboBox(U.temaLabel, U.temaOpts, 0).setDescription('Temas prontos de cor e layout. Não alteram fontes nem tamanhos.');
    const temaBtn = temaRow.addButton(U.btnTheme).setIsFullWidth().setDescription('Aplica o tema escolhido aos campos abaixo.');
    const slotRow = sub(gPre);
    dlg.slot = slotRow.addComboBox(U.slotLabel, U.slotOpts, 0).setDescription('10 slots de preset por documento.');
    const slotBtnRow = sub(gPre);
    const bSave = slotBtnRow.addButton(U.btnSlotSave).setDescription('Grava os campos atuais no slot escolhido (neste documento).');
    const bLoad = slotBtnRow.addButton(U.btnSlotLoad).setDescription('Carrega os campos do slot escolhido.');
    const bDel = slotBtnRow.addButton(U.btnSlotDel).setDescription('Apaga o slot escolhido.');
    dlg.preStatus = gPre.addStaticText(null, '').setIsFullWidth();
    const canImport = !!(APP && typeof APP.chooseFile === 'function' && FILE_MOD && FILE_MOD.readAll);
    if (canImport) {
        const bImp = gPre.addButton(U.btnImport).setIsFullWidth()
            .setDescription('Importa um preset .json exportado anteriormente e aplica aos campos.');
        bImp.onClickHandler = () => { doImport(); };
    }

    // --- Pré-visualização ---
    const gPrev = colL.addGroup(U.secPreview);
    dlg.previewOn = gPrev.addCheckBox('Pré-visualização ao vivo', true)
        .setIsFullWidth().setDescription(U.secPreviewTip);
    dlg.previewStatus = gPrev.addStaticText(null, '').setIsFullWidth();

    // ============================ COLUNA DIREITA ============================

    // --- Elementos ---
    const gShow = section(colR, 'elements', U.secElements, true, U.secElementsTip);
    const showStack = gShow.addColumnStack();
    const showL = showStack.addColumn().addGroup();
    const showR = showStack.addColumn().addGroup();

    dlg.showTitle = check(showL, 'showTitle', defaults.showTitle);
    dlg.header = check(showL, 'header', defaults.header);
    dlg.grid = check(showL, 'grid', defaults.grid);
    dlg.verticals = check(showL, 'verticals', defaults.verticals);
    dlg.accentBar = check(showL, 'accentBar', defaults.accentBar);
    dlg.showBg = check(showL, 'showBg', defaults.showBg);
    dlg.showBorder = check(showL, 'showBorder', defaults.showBorder);

    dlg.adjacent = check(showR, 'adjacent', defaults.adjacent);
    dlg.weekNumbers = check(showR, 'weekNumbers', defaults.weekNumbers);
    dlg.boldWeekend = check(showR, 'boldWeekend', defaults.boldWeekend);
    dlg.markToday = check(showR, 'markToday', defaults.markToday);

    // --- Tipografia ---
    const gTypo = section(colR, 'typo', U.secTypo, false, U.secTypoTip);

    const gFonts = sub(gTypo, 'Fontes (por elemento)');
    fontp(gFonts, 'font');
    const fontStack = gFonts.addColumnStack();
    const fontL = fontStack.addColumn().addGroup();
    const fontR = fontStack.addColumn().addGroup();
    fontp(fontL, 'fontTitle');
    fontp(fontL, 'fontDays');
    fontp(fontR, 'fontLabels');
    const styleStack = gFonts.addColumnStack();
    const styleL = styleStack.addColumn().addGroup();
    const styleR = styleStack.addColumn().addGroup();
    combo(styleL, 'styleTitle', U.styleOpts, defaults.styleTitle);
    combo(styleL, 'styleDays', U.styleOpts, defaults.styleDays);
    combo(styleR, 'styleLabels', U.styleOpts, defaults.styleLabels);

    const gSizes = sub(gTypo, 'Tamanhos (pt · 0 = automático)');
    const sizeStack = gSizes.addColumnStack();
    const sizeL = sizeStack.addColumn().addGroup();
    const sizeR = sizeStack.addColumn().addGroup();
    num(sizeL, 'sizeTitle', defaults.sizeTitle, 0, 400, 'point', 1);
    num(sizeL, 'sizeDay', defaults.sizeDay, 0, 400, 'point', 1);
    num(sizeL, 'sizeHead', defaults.sizeHead, 0, 400, 'point', 1);
    num(sizeL, 'sizeWeek', defaults.sizeWeek, 0, 400, 'point', 1);
    num(sizeR, 'sizeMonth', defaults.sizeMonth, 0, 400, 'point', 1);
    num(sizeR, 'sizeBig', defaults.sizeBig, 0, 400, 'point', 1);
    num(sizeR, 'sizeHour', defaults.sizeHour, 0, 400, 'point', 1);

    const gFmt = sub(gTypo, 'Formato dos textos');
    dlg.titleTpl = combo(gFmt, 'titleTpl', U.titleTplOpts, defaults.titleTpl);
    textin(gFmt, 'titleText', defaults.titleText || '');
    dlg.headFmt = combo(gFmt, 'headFmt', U.headFmtOpts, defaults.headFmt);
    dlg.fmtDay = combo(gFmt, 'fmtDay', U.fmtDayOpts, defaults.fmtDay);
    dlg.fmtWeek = combo(gFmt, 'fmtWeek', U.fmtWeekOpts, defaults.fmtWeek);
    dlg.fmtYear = combo(gFmt, 'fmtYear', U.fmtYearOpts, defaults.fmtYear);
    dlg.titleCase = combo(gFmt, 'titleCase', U.caseOpts, defaults.titleCase);

    const gAdjust = sub(gTypo, 'Ajustes finos');
    dlg.tracking = num(gAdjust, 'tracking', defaults.tracking, -20, 40, 'point', 1);
    dlg.leading = num(gAdjust, 'leading', defaults.leading, 0, 400, 'number', 0);

    // --- Cores ---
    const gCol = section(colR, 'colors', U.secColors, true, U.secColorsTip);
    const colStack = gCol.addColumnStack();
    const colA = colStack.addColumn().addGroup();
    const colB = colStack.addColumn().addGroup();
    colour(colA, 'ink', defaults.ink);
    colour(colA, 'accent', defaults.accent);
    colour(colA, 'flag', defaults.flag);
    colour(colB, 'rule', defaults.rule);
    colour(colB, 'muted', defaults.muted);
    colour(colB, 'bg', defaults.bg);

    // --- Layout ---
    const gLayout = section(colR, 'layout', U.secLayout, false, U.secLayoutTip);
    dlg.margin = num(gLayout, 'margin', defaults.margin, 0, 600, 'point', 1);
    dlg.gutter = num(gLayout, 'gutter', defaults.gutter, 0, 600, 'point', 1);
    dlg.alignH = combo(gLayout, 'alignH', U.alignHOpts, defaults.alignH);
    dlg.alignV = combo(gLayout, 'alignV', U.alignVOpts, defaults.alignV);

    // ------------------------------------------------------------------------

    function setStatus(s) {
        try { dlg.previewStatus.text = s; } catch (e) {}
    }
    function setPreStatus(s) {
        try { dlg.preStatus.text = s; } catch (e) {}
    }

    function doImport() {
        try {
            const path = APP.chooseFile();
            if (!path) return;
            const buf = FILE_MOD.readAll(path);
            if (!buf) throw new Error('arquivo vazio');
            const obj = JSON.parse(String(buf.toString()));
            if (!obj || typeof obj !== 'object') throw new Error('conteúdo inválido');
            const slots = obj.slots;
            applyValues(dlg, obj);
            if (slots && typeof slots === 'object' && dlg.__onImportSlots) dlg.__onImportSlots(slots);
            setPreStatus(U.stImported);
            if (dlg.afterChange) dlg.afterChange();
        } catch (e) {
            setPreStatus(U.stImportFail + msgOf(e));
        }
    }

    function doExport() {
        const obj = Object.assign({}, readAll(dlg, defaults),
            { v: 3, slots: (dlg.__getSlots ? dlg.__getSlots() : {}) });
        const json = JSON.stringify(obj);
        try {
            if (APP && typeof APP.chooseSaveFile === 'function' &&
                FILE_MOD && typeof FILE_MOD.writeAll === 'function') {
                const p = APP.chooseSaveFile();
                if (!p) return;
                FILE_MOD.writeAll(p, json);
                setPreStatus('Preset exportado.');
                return;
            }
        } catch (e) {}
        alert('A exportação de arquivo não está disponível nesta versão do Affinity.\n\n' +
              'Copie o preset abaixo e guarde-o como arquivo .json para Importar em outro documento:\n\n' + json);
    }

    const bExp = gPre.addButton(U.btnExport).setIsFullWidth()
        .setDescription('Gera o JSON do preset (cores, formatos, fontes e slots) para usar em outro documento.');
    bExp.onClickHandler = () => { doExport(); };

    temaBtn.onClickHandler = () => {
        const th = THEMES[clampInt(dlg.tema.selectedIndex, 0, THEMES.length - 1)];
        applyValues(dlg, th);
        setPreStatus(U.stTheme);
        if (dlg.afterChange) dlg.afterChange();
    };
    const slotIdx = () => clampInt(dlg.slot.selectedIndex, 0, 9);
    bSave.onClickHandler = () => {
        if (dlg.__onSlotSave) dlg.__onSlotSave(slotIdx(), readAll(dlg, defaults));
        setPreStatus(U.stSlotSaved.replace('{n}', slotIdx() + 1));
    };
    bLoad.onClickHandler = () => {
        const obj = dlg.__onSlotLoad ? dlg.__onSlotLoad(slotIdx()) : null;
        if (obj) {
            applyValues(dlg, obj);
            setPreStatus(U.stSlotLoaded.replace('{n}', slotIdx() + 1));
        } else {
            setPreStatus(U.stSlotEmpty.replace('{n}', slotIdx() + 1));
        }
        if (dlg.afterChange) dlg.afterChange();
    };
    bDel.onClickHandler = () => {
        if (dlg.__onSlotDel) dlg.__onSlotDel(slotIdx());
        setPreStatus(U.stSlotDeleted.replace('{n}', slotIdx() + 1));
    };

    // Sincroniza visibilidade dos campos condicionais.
    let agendaOpened = false;
    dlg.syncVis = () => {
        try {
            const v = dlg.view.selectedIndex;
            gridWrap.isVisible = (v === 0);
            customWrap.isVisible = (v === 0 && dlg.yearGrid.selectedIndex === 7);
            seqWrap.isVisible = !!dlg.seqOn.value;
            if (v === 5 && !agendaOpened) { agendaOpened = true; dlg.expandSection('agenda', true); }
        } catch (e) {}
    };

    return dlg;
}

// ----------------------------------------------------------------------------
//  Execução Principal
// ----------------------------------------------------------------------------
function main() {
    const doc = Document.current;
    if (!doc) { alert(U.noDoc); return; }

    const presetNode = findPresetNode(doc);
    const presetRaw = readPreset(presetNode) || {};
    const store = {
        slots: (presetRaw.slots && typeof presetRaw.slots === 'object') ? presetRaw.slots : {}
    };

    if (!doc.selection || doc.selection.length === 0) { alert(U.noSel); return; }

    // ---- Contexto da seleção -----------------------------------------------
    function context(node) {
        let n = node, artboard = null, calNode = null;
        while (n) {
            try { if (!artboard && n.artboardInterface && n.artboardInterface.isArtboardEnabled) artboard = n; } catch (e) {}
            try { if (!calNode && CAL_RE.test(n.userDescription || '')) calNode = n; } catch (e) {}
            n = n.parent;
        }
        return { artboard: artboard, calNode: calNode };
    }

    const selNodes = doc.selection.nodes.toArray();
    let baseNode = selNodes.find(n => !context(n).calNode) || selNodes[0];
    if (!baseNode) { alert(U.noSel); return; }

    const ctx0 = context(baseNode);
    const insideCalendar = !!ctx0.calNode;
    const selIsArtboard = (() => {
        try { return !!baseNode.artboardInterface.isArtboardEnabled; } catch (e) { return false; }
    })();
    const targetArtboard = ctx0.artboard;

    // ---- Alvo e área --------------------------------------------------------
    let insertTarget, area;

    if (insideCalendar) {
        // Clicou num calendário existente: recria no lugar, preservando a área.
        const cal = ctx0.calNode;
        if (targetArtboard) insertTarget = targetArtboard;
        else insertTarget = cal.parent;
        try {
            const sb = cal.getSpreadBaseBox();
            if (sb && isFinite(sb.width) && sb.width > 0 && sb.height > 0) {
                area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
            }
        } catch (e) {}
        if (!area && targetArtboard) {
            const sb = targetArtboard.artboardSpreadBaseBox;
            area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
        }
        if (!area || !isFinite(area.w) || area.w <= 0 || area.h <= 0) { alert(U.reSel); return; }
    } else if (selIsArtboard) {
        insertTarget = baseNode;
        const sb = baseNode.artboardSpreadBaseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else if (targetArtboard) {
        insertTarget = targetArtboard;
        const sb = baseNode.spreadBaseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else {
        insertTarget = baseNode.parent;
        const sb = baseNode.spreadBaseBox || baseNode.baseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
        // Documento sem pranchetas: não dá para saber qual calendário substituir.
        if (findCalendars(insertTarget).length) { alert(U.reSel); return; }
    }

    if (!area || !isFinite(area.w) || area.w <= 0 || area.h <= 0) { alert(U.noSel); return; }

    // Escopo de substituição: 'under' = todos sob o nó; 'nodes' = lista fixa; 'none'.
    let scope;
    if (insideCalendar) {
        scope = targetArtboard
            ? { type: 'under', node: targetArtboard }
            : { type: 'nodes', nodes: [ctx0.calNode] };
    } else if (selIsArtboard) {
        scope = { type: 'under', node: baseNode };
    } else if (targetArtboard) {
        scope = { type: 'under', node: targetArtboard };
    } else {
        scope = { type: 'none' };
    }
    const resolveScope = () => {
        if (scope.type === 'under') return findCalendars(scope.node);
        if (scope.type === 'nodes') return scope.nodes.slice();
        return [];
    };

    let targetLabel;
    if (insideCalendar) {
        targetLabel = U.targetShapeIn + '«' + (insertTarget.userDescription || insertTarget.name || '?') + '»';
    } else if (selIsArtboard) {
        targetLabel = (baseNode.userDescription || baseNode.name || '?');
    } else if (targetArtboard) {
        targetLabel = U.targetShapeIn + '«' + (targetArtboard.userDescription || targetArtboard.name || '?') + '»';
    } else {
        targetLabel = U.targetDoc;
    }

    // ---- Diálogo ------------------------------------------------------------
    const now = new Date();
    const defaults = makeDefaults(now);
    Object.assign(defaults, migratePreset(presetRaw));

    const hp0 = doc.history.position;
    const dlg = buildDialog(defaults, targetLabel);

    // Slots de preset (memória do documento)
    dlg.__onSlotSave = (i, obj) => { store.slots['s' + i] = obj; };
    dlg.__onSlotLoad = (i) => store.slots['s' + i] || null;
    dlg.__onSlotDel = (i) => { delete store.slots['s' + i]; };
    dlg.__onImportSlots = (slots) => {
        for (const k in slots) store.slots[k] = slots[k];
    };
    dlg.__getSlots = () => store.slots;

    // ---- Pré-visualização ao vivo -------------------------------------------
    let busy = false;
    const preview = { drew: false };

    function rollbackPreview(wasOk) {
        try {
            if (doc.history.position !== hp0) doc.history.position = hp0;
            preview.drew = false;
            return true;
        } catch (e) {
            if (wasOk) { alert(U.prevFail); return false; }
            preview.drew = false;
            return true;
        }
    }

    function refreshPreview() {
        if (!dlg.previewOn.value) return;
        try {
            if (doc.history.position !== hp0) doc.history.position = hp0;
            preview.drew = false;
            const v = readAll(dlg, defaults);
            if (v.seqOn && clampInt(v.seqMode, 0, 1) === 0 && findCalendars(insertTarget).length) {
                setStatus2(U.prevOn + ' ' + U.prevSeqSkip);
                return;
            }
            const cfg = buildCfg(v, now);
            insertCalendar(doc, insertTarget, area, cfg, resolveScope());
            preview.drew = doc.history.position !== hp0;
            setStatus2(U.prevOn + ' ' + cfgSummary(cfg));
        } catch (e) {
            try {
                if (doc.history.position !== hp0) doc.history.position = hp0;
                preview.drew = false;
            } catch (e2) {}
            setStatus2(U.prevErr + ' ' + msgOf(e));
        }
    }
    function setStatus2(s) { try { dlg.previewStatus.text = s; } catch (e) {} }

    function afterChange() {
        if (busy) return;
        busy = true;
        try {
            dlg.syncVis();
            refreshPreview();
        } finally { busy = false; }
    }

    dlg.afterChange = afterChange;
    dlg.onControlValueChangedHandler = afterChange;
    afterChange();

    const ok = runDialogEx(doc, dlg, rollbackPreview);
    if (!ok) return;

    const v = readAll(dlg, defaults);
    const cfg = buildCfg(v, now);
    const typeIdx = cfg.view;
    const savePreset = () => writePreset(doc, presetNode, Object.assign({}, v, { v: 3, slots: store.slots }));

    try {
        if (!v.seqOn) {
            insertCalendar(doc, insertTarget, area, cfg, resolveScope());
            savePreset();
            return;
        }

        // ---- Sequência em pranchetas ----------------------------------------
        const hasArtboards = (() => {
            try {
                for (const n of doc.spreads.first.children) {
                    try { if (n.artboardInterface && n.artboardInterface.isArtboardEnabled) return true; } catch (e) {}
                }
            } catch (e) {}
            return false;
        })();
        if (!hasArtboards) { alert(U.seqNoArtboards); return; }

        const boards = [];
        try {
            for (const n of doc.spreads.first.children) {
                try { if (n.artboardInterface && n.artboardInterface.isArtboardEnabled) boards.push(n); }
                catch (e) {}
            }
        } catch (e) {}
        if (!boards.length) { alert(U.seqNoArtboards); return; }

        sortArtboards(boards, clampInt(v.seqOrder, 0, 2));
        const startAb = selIsArtboard ? baseNode : (targetArtboard || (insideCalendar ? ctx0.artboard : null));
        let startIdx = 0;
        if (startAb) {
            const k = boards.findIndex(n => sameArtboard(n, startAb));
            if (k >= 0) startIdx = k;
        }

        let rel = null;
        if (!selIsArtboard && targetArtboard) {
            try {
                const r = targetArtboard.artboardSpreadBaseBox;
                rel = { dx: area.x - r.x, dy: area.y - r.y, w: area.w, h: area.h };
            } catch (e) {}
        }

        const count = clampInt(v.seqCount, 1, 60);
        const updateMode = clampInt(v.seqMode, 0, 1) === 1;
        const plan = [];
        let skipped = 0;
        let i = startIdx;
        while (plan.length < count && i < boards.length) {
            const ab = boards[i++];
            const existing = findCalendars(ab);
            if (existing.length && !updateMode) { skipped++; continue; }
            let a;
            try {
                const r = ab.artboardSpreadBaseBox;
                a = rel ? { x: r.x + rel.dx, y: r.y + rel.dy, w: rel.w, h: rel.h }
                        : { x: r.x, y: r.y, w: r.width, h: r.height };
            } catch (e) { continue; }
            if (!a || !isFinite(a.w) || a.w <= 0 || a.h <= 0) continue;
            const p = periodStart(typeIdx, cfg.year, cfg.month, cfg.day, plan.length);
            const pvals = Object.assign({}, v, { year: p.year, month: p.month, day: p.day });
            const pcfg = buildCfg(pvals, now);
            plan.push({ ab: ab, area: a, cfg: pcfg, existing: existing });
        }

        if (!plan.length) { alert(U.seqNone); return; }
        const made = runSequence(doc, plan);
        savePreset();

        let msg = U.seqReport.replace('{n}', made);
        if (skipped) msg += U.seqSkipped.replace('{s}', skipped);
        alert(msg);
    } catch (e) {
        try { doc.history.position = hp0; } catch (_) {}
        throw e;
    }
}

// ----------------------------------------------------------------------------
//  Sequência: contêineres em lote e filhos em lote (poucos passos de undo)
// ----------------------------------------------------------------------------
function runSequence(doc, plan) {
    // 1) Remove calendários antigos das pranchetas em modo "Atualizar".
    const del = [];
    for (const p of plan) if (p.existing && p.existing.length) del.push(...p.existing);
    if (del.length) doc.deleteSelection(Selection.create(doc, del));

    // 2) Fotografa os filhos de cada prancheta para localizar os contêineres novos.
    const snaps = plan.map(p => childrenOf(p.ab));

    // 3) Cria todos os contêineres em um único comando agrupado.
    const ccmds = plan.map(p => {
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(p.ab);
        b.addContainerNode(ContainerNodeDefinition.create(
            `${U.calName} · ${U.views[p.cfg.view]} ${p.cfg.year}` +
            (p.cfg.view >= 1 && p.cfg.view <= 3 ? ` · ${L.months[p.cfg.month]}` : '')));
        return b.createCommand(true);
    });
    executeBatch(doc, ccmds);

    // 4) Localiza os contêineres criados.
    const containers = plan.map((p, idx) =>
        findNewContainer(p.ab, snaps[idx]) || findInNodes(ccmds[idx]));
    for (const c of containers) if (!c) throw new Error(U.errContainer);

    // 5) Desenha todos os calendários em um único comando agrupado.
    const dcmds = plan.map((p, idx) => {
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(containers[idx]);
        drawInto(b, doc, p.area, p.cfg);
        return b.createCommand(true);
    });
    executeBatch(doc, dcmds);
    return plan.length;
}

// ----------------------------------------------------------------------------
//  Execução do diálogo (com rollback da pré-visualização)
// ----------------------------------------------------------------------------
function runDialogEx(doc, dlg, rollbackPreview) {
    const t0 = Date.now();
    try {
        const r = dlg.runModal();
        const ok = r === DialogResult.Ok || (r && r.value === DialogResult.Ok.value);
        if (!rollbackPreview(ok)) return false;
        return ok;
    } catch (e) {
        if (Date.now() - t0 < 500) throw e;
        rollbackPreview(false);
        return false;
    }
}

try {
    main();
} catch (e) {
    alert(U.errPrefix + msgOf(e) + (e && e.stack ? '\n\n' + e.stack : ''));
}
