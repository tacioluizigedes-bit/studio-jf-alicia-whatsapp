/**
 * nlpEntityExtractor.ts
 * Processador de Linguagem Natural e Extração Inteligente de Entidades (Slot Filling):
 * - Procedimento/Serviço (ex: "cilio tufinho", "tufinho de seda", "volume brasileiro", "1")
 * - Data (ex: "quarta-feira 14/10", "14/10", "amanhã", "terça")
 * - Horário (ex: "09:00", "às 9h", "14:30", "de manhã")
 */

import { DateTime } from 'luxon';
import { SALON_CONFIG } from '../config/salonConfig';

export interface ExtractedSubService {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
  category?: string;
}

export interface ExtractedService {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
  category: string;
  isCombo?: boolean;
  subServices?: ExtractedSubService[];
}

export interface ExtractedBookingEntities {
  service?: ExtractedService;
  dateStr?: string;       // YYYY-MM-DD
  dateFormatted?: string; // dd/MM
  weekdayName?: string;   // Quarta-feira
  timeStr?: string;       // HH:mm
  periodOfDay?: 'morning' | 'afternoon';
  clientName?: string;
  clientPhone?: string;
  isComplete: boolean;    // service && dateStr && timeStr
  confidence: number;
}

/**
 * Remove acentuação e converte para minúsculas
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Mapeia opções numéricas do menu de cílios quando aplicável
 */
const NUMERIC_LASH_MAP: Record<string, string> = {
  '1': 'cilios_tufinhos_light',
  '2': 'cilios_fio_a_fio_classico',
  '3': 'cilios_volume_brasileiro',
  '4': 'cilios_volume_egipcio',
  '5': 'cilios_mega_brasileiro',
};

/**
 * 1. Extração de Todos os Procedimentos Individuais (Multi-Serviços / Combos)
 */
export function extractAllServices(text: string, currentStep?: string): ExtractedService[] {
  const norm = normalizeText(text);
  const foundServices: ExtractedService[] = [];

  const getFromConfig = (id: string): ExtractedService | undefined => {
    const s = SALON_CONFIG.services.find((item: any) => item.id === id);
    if (!s) return undefined;
    return {
      id: s.id,
      name: s.name,
      price: s.price,
      durationMinutes: s.durationMinutes,
      category: s.category,
    };
  };

  // 1.1 Seleção numérica direta no menu de cílios
  const singleNumberMatch = norm.match(/\b([1-5])\b/);
  if (singleNumberMatch && (currentStep === 'SERVICE_SELECTION' || norm.includes('opcao') || norm.length <= 3)) {
    const serviceId = NUMERIC_LASH_MAP[singleNumberMatch[1]];
    if (serviceId) {
      const s = getFromConfig(serviceId);
      if (s) foundServices.push(s);
    }
  }

  // 1.2 Procedimento de Cílios (Colocação ou Manutenção)
  const hasLashKeyword =
    norm.includes('cilios') ||
    norm.includes('cilio') ||
    norm.includes('extensao') ||
    norm.includes('alongamento') ||
    norm.includes('tufinho') ||
    norm.includes('tufinhos') ||
    norm.includes('volume') ||
    norm.includes('fio a fio') ||
    norm.includes('egipcio') ||
    norm.includes('fox') ||
    norm.includes('mega') ||
    norm.includes('brasileiro') ||
    norm.includes('brasileirinho');

  if (hasLashKeyword && foundServices.length === 0) {
    const isManut = norm.includes('manut') || norm.includes('manutencao');

    if (isManut) {
      if (norm.includes('mega') && norm.includes('brasileiro')) {
        const s = getFromConfig('manut_cilios_mega_brasileiro');
        if (s) foundServices.push(s);
      } else if (norm.includes('brasileiro') || norm.includes('brasileirinho')) {
        const s = getFromConfig('manut_cilios_volume_brasileiro');
        if (s) foundServices.push(s);
      } else if (norm.includes('fio a fio') || norm.includes('classico')) {
        const s = getFromConfig('manut_cilios_fio_a_fio_classico');
        if (s) foundServices.push(s);
      } else if (norm.includes('egipcio')) {
        const s = getFromConfig('manut_cilios_volume_egipcio');
        if (s) foundServices.push(s);
      } else if (norm.includes('fox')) {
        const s = getFromConfig('manut_cilios_volume_fox_eyes');
        if (s) foundServices.push(s);
      } else if (norm.includes('mega') && norm.includes('tufinho')) {
        const s = getFromConfig('manut_cilios_tufinhos_mega');
        if (s) foundServices.push(s);
      } else if (norm.includes('tufinho')) {
        const s = getFromConfig('manut_cilios_tufinhos_light');
        if (s) foundServices.push(s);
      } else {
        const s = getFromConfig('manut_cilios_volume_brasileiro') || getFromConfig('manut_cilios_tufinhos_light');
        if (s) foundServices.push(s);
      }
    } else {
      if (norm.includes('mega') && norm.includes('brasileiro')) {
        const s = getFromConfig('cilios_mega_brasileiro');
        if (s) foundServices.push(s);
      } else if (norm.includes('mega') && norm.includes('tufinho')) {
        const s = getFromConfig('cilios_tufinhos_mega');
        if (s) foundServices.push(s);
      } else if (norm.includes('tufinho') || norm.includes('tufinhos')) {
        const s = getFromConfig('cilios_tufinhos_light');
        if (s) foundServices.push(s);
      } else if (norm.includes('volume brasileiro') || norm.includes('brasileiro') || norm.includes('brasileirinho')) {
        const s = getFromConfig('cilios_volume_brasileiro');
        if (s) foundServices.push(s);
      } else if (norm.includes('fio a fio') || norm.includes('classico')) {
        const s = getFromConfig('cilios_fio_a_fio_classico');
        if (s) foundServices.push(s);
      } else if (norm.includes('egipcio')) {
        const s = getFromConfig('cilios_volume_egipcio');
        if (s) foundServices.push(s);
      } else if (norm.includes('fox')) {
        const s = getFromConfig('cilios_volume_fox_eyes');
        if (s) foundServices.push(s);
      } else {
        const s = getFromConfig('cilios_volume_brasileiro') || getFromConfig('cilios_tufinhos_light');
        if (s) foundServices.push(s);
      }
    }
  }

  // 1.3 Sobrancelhas (Design com Henna ou Design Simples)
  if (norm.includes('henna')) {
    const s = getFromConfig('design_sobrancelha_henna');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  } else if (norm.includes('sobrancelha') || norm.includes('sobrancelhas') || norm.includes('design')) {
    const s = getFromConfig('design_sobrancelha_simples');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // 1.4 Estética Facial (Limpeza de Pele)
  if (norm.includes('limpeza de pele') || norm.includes('limpeza facial') || norm.includes('limpeza') || norm.includes('pele profunda')) {
    const s = getFromConfig('limpeza_de_pele') || {
      id: 'limpeza_de_pele',
      name: 'Limpeza de Pele Profunda',
      price: 120,
      durationMinutes: 120,
      category: 'estetica_facial',
    };
    if (!foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // 1.5 Depilação (Detecção precisa de cada região solicitada)
  // Axila
  if (norm.includes('axila') || norm.includes('axilas')) {
    const s = getFromConfig('dep_axila');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // Virilha
  if (norm.includes('virilha') || norm.includes('virilia')) {
    if (norm.includes('total') || norm.includes('completa')) {
      const s = getFromConfig('dep_virilha_total');
      if (s && !foundServices.some(item => item.id === s.id)) {
        foundServices.push(s);
      }
    } else {
      const s = getFromConfig('dep_virilha_simples');
      if (s && !foundServices.some(item => item.id === s.id)) {
        foundServices.push(s);
      }
    }
  }

  // Buço
  if (norm.includes('buco') || norm.includes('buço')) {
    const s = getFromConfig('dep_buco');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // Meia Perna
  if (norm.includes('meia perna') || norm.includes('1/2 perna')) {
    const s = getFromConfig('dep_meia_perna');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  } else if (norm.includes('perna inteira') || norm.includes('perna completa') || (norm.includes('perna') && !norm.includes('meia'))) {
    const s = getFromConfig('dep_perna_inteira');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // Faixa do umbigo
  if (norm.includes('umbigo')) {
    const s = getFromConfig('dep_faixa_umbigo');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // Mento / Queixo
  if (norm.includes('mento') || norm.includes('queixo')) {
    const s = getFromConfig('dep_mento');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  // Rosto Completo
  if (norm.includes('rosto completo') || (norm.includes('rosto') && !norm.includes('sobrancelha') && !norm.includes('pele'))) {
    const s = getFromConfig('dep_rosto_completo');
    if (s && !foundServices.some(item => item.id === s.id)) {
      foundServices.push(s);
    }
  }

  return foundServices;
}

/**
 * Extração de Serviço / Procedimento:
 * - Se for 1 procedimento: retorna o serviço individual.
 * - Se for 2 ou mais procedimentos: soma preços e horários, identifica cada procedimento e monta o Combo!
 */
export function extractService(text: string, currentStep?: string): ExtractedService | undefined {
  const services = extractAllServices(text, currentStep);

  if (services.length === 0) {
    return undefined;
  }

  if (services.length === 1) {
    return services[0];
  }

  // Múltiplos procedimentos identificados: verifica se há combo pré-cadastrado no catálogo
  const ids = services.map(s => s.id);

  // 1. Depilação: Axila + Virilha (Simples ou Total)
  if (ids.includes('dep_axila') && (ids.includes('dep_virilha_simples') || ids.includes('dep_virilha_total')) && services.length === 2) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_dep_axila_virilha');
    return {
      id: catalogCombo?.id || 'combo_dep_axila_virilha',
      name: catalogCombo?.name || 'Combo Depilação: Axila + Virilha',
      price: catalogCombo?.price ?? 65.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 60,
      category: 'combos_depilacao',
      isCombo: true,
      subServices: services,
    };
  }

  // 2. Depilação: Buço + Axila
  if (ids.includes('dep_buco') && ids.includes('dep_axila') && services.length === 2) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_dep_buco_axila');
    return {
      id: catalogCombo?.id || 'combo_dep_buco_axila',
      name: catalogCombo?.name || 'Combo Depilação: Buço + Axila',
      price: catalogCombo?.price ?? 30.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 45,
      category: 'combos_depilacao',
      isCombo: true,
      subServices: services,
    };
  }

  // 3. Depilação: Buço + Axila + Meia Perna
  if (ids.includes('dep_buco') && ids.includes('dep_axila') && ids.includes('dep_meia_perna') && services.length === 3) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_dep_buco_axila_meia_perna');
    return {
      id: catalogCombo?.id || 'combo_dep_buco_axila_meia_perna',
      name: catalogCombo?.name || 'Combo Depilação: Buço + Axila + Meia Perna',
      price: catalogCombo?.price ?? 55.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 75,
      category: 'combos_depilacao',
      isCombo: true,
      subServices: services,
    };
  }

  // 4. Depilação: Buço + Axila + Perna Completa
  if (ids.includes('dep_buco') && ids.includes('dep_axila') && ids.includes('dep_perna_inteira') && services.length === 3) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_dep_buco_axila_perna_completa');
    return {
      id: catalogCombo?.id || 'combo_dep_buco_axila_perna_completa',
      name: catalogCombo?.name || 'Combo Depilação: Buço + Axila + Perna Completa',
      price: catalogCombo?.price ?? 60.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 90,
      category: 'combos_depilacao',
      isCombo: true,
      subServices: services,
    };
  }

  // 5. Depilação: Buço + Axila + Virilha Total
  if (ids.includes('dep_buco') && ids.includes('dep_axila') && ids.includes('dep_virilha_total') && services.length === 3) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_dep_buco_axila_virilha_total');
    return {
      id: catalogCombo?.id || 'combo_dep_buco_axila_virilha_total',
      name: catalogCombo?.name || 'Combo Depilação: Buço + Axila + Virilha Total',
      price: catalogCombo?.price ?? 70.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 90,
      category: 'combos_depilacao',
      isCombo: true,
      subServices: services,
    };
  }

  // 6. Manutenção de Cílios + Henna
  if (services.some(s => s.id.startsWith('manut_cilios')) && ids.includes('design_sobrancelha_henna') && services.length === 2) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_henna_manut_cilios');
    return {
      id: catalogCombo?.id || 'combo_henna_manut_cilios',
      name: catalogCombo?.name || 'Combo Henna + Manutenção de Cílios',
      price: catalogCombo?.price ?? 95.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 120,
      category: 'sobrancelhas',
      isCombo: true,
      subServices: services,
    };
  }

  // 7. Manutenção de Cílios + Design Simples
  if (services.some(s => s.id.startsWith('manut_cilios')) && ids.includes('design_sobrancelha_simples') && services.length === 2) {
    const catalogCombo = SALON_CONFIG.services.find((s: any) => s.id === 'combo_manut_cilios_design_sobrancelha');
    return {
      id: catalogCombo?.id || 'combo_manut_cilios_design_sobrancelha',
      name: catalogCombo?.name || 'Combo Manutenção de Cílios + Design de Sobrancelha',
      price: catalogCombo?.price ?? 85.0,
      durationMinutes: catalogCombo?.durationMinutes ?? 120,
      category: 'sobrancelhas',
      isCombo: true,
      subServices: services,
    };
  }

  // 8. Combo Dinâmico Universal para qualquer outra combinação de múltiplos procedimentos
  const totalPrice = services.reduce((acc, curr) => acc + curr.price, 0);
  const totalDuration = services.reduce((acc, curr) => acc + curr.durationMinutes, 0);
  const comboName = `Combo: ${services.map(s => s.name).join(' + ')}`;
  const comboId = `combo_${services.map(s => s.id).join('_')}`;

  return {
    id: comboId,
    name: comboName,
    price: totalPrice,
    durationMinutes: totalDuration,
    category: 'combos_personalizados',
    isCombo: true,
    subServices: services,
  };
}

/**
 * 2. Extração de Data
 */
export function extractDate(text: string, referenceDate?: DateTime): { dateStr: string; dateFormatted: string; weekdayName: string } | undefined {
  const tz = SALON_CONFIG.timezone;
  const now = referenceDate || DateTime.now().setZone(tz);
  const norm = normalizeText(text);

  // 1. Data Numérica explícita: "14/10", "14/10/2026", "14-10"
  const dateMatch = norm.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    let year = now.year;
    if (dateMatch[3]) {
      year = parseInt(dateMatch[3], 10);
      if (year < 100) year += 2000;
    }

    const dt = DateTime.fromObject({ year, month, day }, { zone: tz });
    if (dt.isValid) {
      return {
        dateStr: dt.toISODate() || '',
        dateFormatted: dt.toFormat('dd/MM'),
        weekdayName: dt.setLocale('pt-BR').toFormat('cccc'),
      };
    }
  }

  // 2. Termos Relativos: "hoje", "amanhã"
  if (norm.includes('amanha')) {
    const dt = now.plus({ days: 1 });
    return {
      dateStr: dt.toISODate() || '',
      dateFormatted: dt.toFormat('dd/MM'),
      weekdayName: dt.setLocale('pt-BR').toFormat('cccc'),
    };
  }

  if (norm.includes('hoje')) {
    return {
      dateStr: now.toISODate() || '',
      dateFormatted: now.toFormat('dd/MM'),
      weekdayName: now.setLocale('pt-BR').toFormat('cccc'),
    };
  }

  // 3. Dias da Semana em Português
  const weekdays: Record<string, number> = {
    segunda: 1,
    terca: 2,
    quarta: 3,
    quinta: 4,
    sexta: 5,
    sabado: 6,
    domingo: 7,
  };

  for (const [dayKey, targetWeekday] of Object.entries(weekdays)) {
    if (norm.includes(dayKey)) {
      let diff = targetWeekday - now.weekday;
      if (diff <= 0) diff += 7; // Próximo dia da semana
      const dt = now.plus({ days: diff });
      return {
        dateStr: dt.toISODate() || '',
        dateFormatted: dt.toFormat('dd/MM'),
        weekdayName: dt.setLocale('pt-BR').toFormat('cccc'),
      };
    }
  }

  return undefined;
}

/**
 * 3. Extração de Horário
 */
export function extractTime(text: string): { timeStr?: string; periodOfDay?: 'morning' | 'afternoon' } | undefined {
  const norm = normalizeText(text);

  // Remove datas no formato DD/MM para não confundir dia/mês com hora
  const cleanedForTime = norm.replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, ' ');

  // Prioriza horários explícitos com sufixo (14hs, 14h, 14h30, 14:00, às 14)
  const explicitTimeRegex =
    /(?:as|às|para as|para|de)?\s*\b(\d{1,2})(?:[:h](\d{2}))?\s*(?:hs|hrs|hr|h|horas|min)\b|(?:as|às|para as)\s+\b(\d{1,2})(?::(\d{2}))?\b|\b(\d{1,2}):(\d{2})\b/i;

  const match = cleanedForTime.match(explicitTimeRegex);

  if (match) {
    const rawHour = match[1] || match[3] || match[5];
    const rawMin = match[2] || match[4] || match[6];
    if (rawHour) {
      const hour = parseInt(rawHour, 10);
      const minute = rawMin ? parseInt(rawMin, 10) : 0;

      if (hour >= 7 && hour <= 20 && minute >= 0 && minute <= 59) {
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        return {
          timeStr,
          periodOfDay: hour < 12 ? 'morning' : 'afternoon',
        };
      }
    }
  }

  // Fallback para número simples no intervalo comercial (8h às 19h)
  const fallbackMatch = cleanedForTime.match(/(?:as|de|para)?\s*\b(\d{1,2})(?::(\d{2}))?\b/);
  if (fallbackMatch && fallbackMatch[1]) {
    const hour = parseInt(fallbackMatch[1], 10);
    const minute = fallbackMatch[2] ? parseInt(fallbackMatch[2], 10) : 0;
    if (hour >= 8 && hour <= 19 && minute >= 0 && minute <= 59) {
      const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      return {
        timeStr,
        periodOfDay: hour < 12 ? 'morning' : 'afternoon',
      };
    }
  }

  // Períodos gerais
  if (norm.includes('manha')) {
    return { periodOfDay: 'morning' };
  }
  if (norm.includes('tarde')) {
    return { periodOfDay: 'afternoon' };
  }

  return undefined;
}

/**
 * 3.5 Extração do Nome da Cliente (ex: "Sou a Mariana Costa", "Nome dela: Renata", "cliente Renata")
 */
export function extractClientName(text: string): string | undefined {
  // Padrão 1: "Nome: Maria Clara Silva", "Nome dela: Renata", "Cliente: Renata"
  const ownerPattern = text.match(
    /(?:nome\s+dela|nome\s+da\s+cliente|meu\s+nome|nome|cliente)\s*[:=-]\s*([A-ZÀ-Úa-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+){0,4})/i
  );
  if (ownerPattern && ownerPattern[1]) {
    const cleaned = ownerPattern[1]
      .replace(/\b(amanha|amanhã|hoje|para|as|às|dia|extensao|extensão|cilios|cílios|manutencao|manutenção|sobrancelha|telefone|tel|celular|whatsapp)\b.*/i, '')
      .trim();
    if (cleaned.length >= 2) return cleaned;
  }

  // Padrão 2: "marcar cliente Renata", "agendar cliente Renata", "marcar a Renata"
  const directClientMatch = text.match(
    /(?:marcar|agendar|encaixar)\s+(?:a\s+cliente|uma\s+cliente\s+chamada|cliente|a)\s+([A-ZÀ-Úa-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+){0,2})/i
  );
  if (directClientMatch && directClientMatch[1]) {
    const cleaned = directClientMatch[1]
      .replace(/\b(amanha|amanhã|hoje|para|as|às|dia|na|no|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|telefone|tel)\b.*/i, '')
      .trim();
    if (cleaned.length >= 2 && !/^(uma|cliente)$/i.test(cleaned)) return cleaned;
  }

  // Padrão 3: "Sou a Mariana Costa", "Meu nome é Juliana"
  const match = text.match(/(?:sou a|sou o|meu nome [eé]|me chamo|aqui [eé] a|nome dela [eé])\s+([A-ZÀ-Úa-zà-ú]+(?:\s+[A-ZÀ-Úa-zà-ú]+){0,3})/i);
  if (match && match[1]) {
    const raw = match[1]
      .replace(/\b(quero|gostaria|preciso|para|dia|agendar|marcar|amanha|amanhã|hoje|telefone|tel|meu)\b.*/i, '')
      .trim();
    if (raw.length >= 2) {
      return raw;
    }
  }
    // Padrão 4: Nome no final da mensagem após ponto, quebra de linha ou vírgula (ex: "... axila e virilha. Amanda" ou "virilha, Amanda")
  const trailingNameMatch = text.match(/(?:[.\n,]\s*|\b(?:para|cliente|nome)\s+)([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+){0,2})\s*$/);
  if (trailingNameMatch && trailingNameMatch[1]) {
    const candidate = trailingNameMatch[1].trim();
    const invalidWords = /^(hoje|amanha|amanhã|ontem|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo|depilacao|depilação|cilios|cílios|sobrancelha|tufinho|axila|virilha|buco|buço|rosto|perna|henna|agendar|marcar|confirmar|combo|pele|limpeza)$/i;
    if (candidate.length >= 2 && !invalidWords.test(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * 3.6 Extração do Telefone da Cliente (ex: "Telefone: (21) 99999-8888")
 */
export function extractClientPhone(text: string): string | undefined {
  const labeledPhone = text.match(/(?:telefone|tel|celular|whatsapp|contato)\s*[:=-]?\s*(\+?55\s*)?\(?(\d{2})\)?\s*(9?\d{4})[-\s]?(\d{4})/i);
  if (labeledPhone) {
    return `55${labeledPhone[2]}${labeledPhone[3]}${labeledPhone[4]}`;
  }
  return undefined;
}

/**
 * 4. Extrator Principal Combinado (Slot Filling)
 */
export function extractBookingEntities(
  text: string,
  currentStep?: string,
  referenceDate?: DateTime
): ExtractedBookingEntities {
  const service = extractService(text, currentStep);
  const dateInfo = extractDate(text, referenceDate);
  const timeInfo = extractTime(text);
  const clientName = extractClientName(text);
  const clientPhone = extractClientPhone(text);

  const isComplete = !!(service && dateInfo?.dateStr && timeInfo?.timeStr);

  let confidence = 0;
  if (service) confidence += 0.35;
  if (dateInfo?.dateStr) confidence += 0.35;
  if (timeInfo?.timeStr) confidence += 0.3;

  return {
    service,
    dateStr: dateInfo?.dateStr,
    dateFormatted: dateInfo?.dateFormatted,
    weekdayName: dateInfo?.weekdayName,
    timeStr: timeInfo?.timeStr,
    periodOfDay: timeInfo?.periodOfDay,
    clientName,
    clientPhone,
    isComplete,
    confidence,
  };
}

export default {
  extractBookingEntities,
  extractService,
  extractAllServices,
  extractDate,
  extractTime,
  extractClientName,
  extractClientPhone,
};
