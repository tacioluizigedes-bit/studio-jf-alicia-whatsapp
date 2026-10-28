/**
 * scheduleRulesService.ts
 * Regras de bloqueios pessoais (como o bloqueio quinzenal de terça-feira das 13:00 às 15:30)
 * e garantia de sigilo absoluto nas respostas para clientes finais.
 */

import { isBiweeklyTuesdayBlocked } from './appointmentService';
import { SALON_CONFIG } from '../config/salonConfig';

/**
 * Verifica se um horário pretendido esbarra nas regras de bloqueio pessoal (ex: Terça Quinzenal 13:00 às 15:30)
 */
export function isSlotBlockedByPersonalRules(
  targetDate: Date | string,
  durationMinutes: number = 60,
  tz: string = SALON_CONFIG.timezone
): boolean {
  const dateObj = targetDate instanceof Date ? targetDate : new Date(targetDate);
  if (isNaN(dateObj.getTime())) return false;
  return isBiweeklyTuesdayBlocked(dateObj, durationMinutes, tz);
}

/**
 * Gera a resposta discreta e acolhedora da Alícia para clientes em horários indisponíveis,
 * NUNCA citando compromissos pessoais, Janaína ou bloqueio quinzenal.
 */
export function getDiscreetUnavailabilityReply(suggestedSlots: string[] = ['11:30', 'a partir das 16:00']): string {
  return `Nesse horário específico não temos disponibilidade na grade! Tenho às ${suggestedSlots[0] || '11:30'} ou ${suggestedSlots[1] || 'a partir das 16:00'}. Algum desses fica bom pra você? ✨`;
}

export default {
  isSlotBlockedByPersonalRules,
  getDiscreetUnavailabilityReply,
};
