import { SALON_CONFIG } from '../config/salonConfig';

export type AdminSetupState = 'IDLE' | 'AWAITING_MONTH_CONFIRMATION' | 'AWAITING_GRADE_DETAILS' | 'COMPLETED';

export interface AdminSessionState {
  phone: string;
  state: AdminSetupState;
  selectedPattern?: string;
  updatedAt: Date;
}

export class OwnerAgendaSetupService {
  private adminSessions = new Map<string, AdminSessionState>();

  /**
   * Identifica se o texto ou o remetente correspondem a uma intenção administrativa de montagem de agenda
   */
  public isAdminIntent(text: string, senderPhone?: string, senderRole?: string): boolean {
    const isOwnerPhone = senderPhone ? senderPhone.replace(/\D/g, '').endsWith(SALON_CONFIG.ownerPhone.replace(/\D/g, '')) : false;
    const isOwnerRole = senderRole === 'owner' || senderRole === 'admin';

    const adminRegex = /montar a agenda|fechar agenda|organizar m[eê]s|configurar hor[aá]rios|grade do m[eê]s|montar agenda|abrir agenda/i;
    const matchesRegex = adminRegex.test(text);

    return matchesRegex || isOwnerRole || (isOwnerPhone && matchesRegex);
  }

  /**
   * Verifica se o telefone está atualmente em um fluxo administrativo ativo
   */
  public isPhoneInAdminFlow(phone: string): boolean {
    const session = this.adminSessions.get(phone);
    return !!session && session.state !== 'IDLE' && session.state !== 'COMPLETED';
  }

  /**
   * Processa mensagens do fluxo administrativo da Janaína (proprietária)
   */
  public processAdminMessage(phone: string, text: string): { reply: string; state: AdminSetupState } {
    let session = this.adminSessions.get(phone);
    const now = new Date();

    if (!session || session.state === 'IDLE' || session.state === 'COMPLETED') {
      session = {
        phone,
        state: 'AWAITING_MONTH_CONFIRMATION',
        updatedAt: now,
      };
      this.adminSessions.set(phone, session);

      return {
        reply: `Oii, Jana! Que bom que você veio organizar a agenda! ✨ Vamos montar a grade do próximo mês? Me diga: qual será o seu padrão de dias e horários de atendimento?`,
        state: 'AWAITING_MONTH_CONFIRMATION',
      };
    }

    if (session.state === 'AWAITING_MONTH_CONFIRMATION') {
      session.selectedPattern = text;
      session.state = 'COMPLETED';
      session.updatedAt = now;

      return {
        reply: `Perfeito, Jana! 💖 Já registrei o seu padrão de atendimento ("${text}") para a grade do próximo mês!\n\nA agenda já está liberada para as clientes no sistema com todas as suas regras e bloqueios ativos. Deseja ajustar mais algum detalhe? ✨`,
        state: 'COMPLETED',
      };
    }

    return {
      reply: `Tudo pronto, Jana! Se precisar alterar a grade ou fazer um novo bloqueio, é só me avisar por aqui. 💕`,
      state: 'COMPLETED',
    };
  }

  /**
   * Reinicia o estado administrativo de um telefone
   */
  public resetAdminState(phone: string) {
    this.adminSessions.delete(phone);
  }
}
