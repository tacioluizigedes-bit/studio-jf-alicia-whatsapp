import { AppointmentService } from './appointmentService';
import { prisma } from '../lib/prisma';

export type SessionStatus = 'ACTIVE' | 'TIMED_OUT' | 'COMPLETED';

export type AwaitingInputType = 'SERVICE_SELECTION' | 'DATE_TIME' | 'CONFIRMATION' | 'NONE';

export interface BookingContext {
  serviceId?: string;
  serviceName?: string;
  servicePrice?: number;
  durationMinutes?: number;
  dateStr?: string;       // YYYY-MM-DD
  dateFormatted?: string; // dd/MM
  timeStr?: string;       // HH:mm
  dateTimeIso?: string;
  clientName?: string;
}

export interface ChatMessagePart {
  text: string;
}

export interface ChatTurn {
  role: 'user' | 'model';
  parts: ChatMessagePart[];
}

export interface UserSession {
  clientPhone: string;
  clientName?: string;
  lastInteractionAt: Date;
  sessionStatus: SessionStatus;
  conversationHistory: ChatTurn[];
  pendingAppointmentId?: string;
  createdAt: Date;
  awaitingInput?: AwaitingInputType;
  bookingContext?: BookingContext;
}

export interface SessionValidationResult {
  isValid: boolean;
  isTimeout: boolean;
  session: UserSession;
  timeoutMessage?: string;
}

/**
 * Janela de Inatividade (TTL de Sessão): exatamente 10 minutos (600.000 ms)
 */
export const INACTIVITY_TTL_MS = 10 * 60 * 1000; // 600.000 ms

/**
 * Template amigável de reinício após expiração de 10 minutos de inatividade
 */
export function buildSessionTimeoutMessage(clientName?: string): string {
  const nameLabel = clientName ? `, ${clientName}` : '';
  return (
    `Oi${nameLabel}! Como ficamos um tempinho sem nos falar, o nosso atendimento anterior expirou para que outros horários fossem liberados. ✨\n\n` +
    `Mas não tem problema! Vamos começar de novo? Em que posso te ajudar hoje?`
  );
}

export interface CheckSessionActivityInput {
  lastInteractionAt?: Date | string | number;
  lastMessageAt?: Date | string | number;
  lastActivity?: Date | string | number;
  currentTime?: Date | string | number;
  now?: Date | string | number;
  elapsedMinutes?: number;
  elapsedMs?: number;
  customerName?: string;
  clientName?: string;
}

export interface CheckSessionActivityResult {
  isActive: boolean;
  isValid: boolean;
  isExpired: boolean;
  expired: boolean;
  isTimeout: boolean;
  shouldResetContext: boolean;
  action: 'CONTINUE' | 'RESET_AND_GREET';
  status: 'ACTIVE' | 'EXPIRED';
  sessionStatus: SessionStatus;
  timeoutMessage: string | null;
  resetMessage: string | null;
  message: string | null;
}

/**
 * Verifica se a sessão está ativa ou se expirou pela janela de 10 minutos (TTL = 600.000 ms).
 * Aceita objeto de parâmetros, dois timestamps (lastMessageAt, currentTime) ou minutos decorridos.
 */
export function checkSessionActivity(
  inputOrLastTime: CheckSessionActivityInput | Date | string | number,
  currentTimeArg?: Date | string | number
): CheckSessionActivityResult {
  let elapsedMs = 0;
  let customerName: string | undefined;

  if (typeof inputOrLastTime === 'number' && currentTimeArg === undefined && inputOrLastTime < 10000) {
    // Passou minutos diretamente (ex: checkSessionActivity(8) ou checkSessionActivity(12))
    elapsedMs = inputOrLastTime * 60 * 1000;
  } else if (
    inputOrLastTime instanceof Date ||
    typeof inputOrLastTime === 'string' ||
    (typeof inputOrLastTime === 'number' && currentTimeArg !== undefined)
  ) {
    const startMs = new Date(inputOrLastTime).getTime();
    const endMs = currentTimeArg !== undefined ? new Date(currentTimeArg).getTime() : Date.now();
    elapsedMs = endMs - startMs;
  } else if (inputOrLastTime && typeof inputOrLastTime === 'object') {
    const obj = inputOrLastTime as CheckSessionActivityInput;
    customerName = obj.customerName || obj.clientName;
    if (obj.elapsedMs !== undefined) {
      elapsedMs = obj.elapsedMs;
    } else if (obj.elapsedMinutes !== undefined) {
      elapsedMs = obj.elapsedMinutes * 60 * 1000;
    } else {
      const lastRaw = obj.lastMessageAt ?? obj.lastInteractionAt ?? obj.lastActivity;
      const nowRaw = obj.currentTime ?? obj.now ?? Date.now();
      const startMs = lastRaw !== undefined ? new Date(lastRaw).getTime() : Date.now();
      const endMs = new Date(nowRaw).getTime();
      elapsedMs = endMs - startMs;
    }
  }

  const isExpired = elapsedMs > INACTIVITY_TTL_MS;
  const msg = isExpired ? buildSessionTimeoutMessage(customerName) : null;

  return {
    isActive: !isExpired,
    isValid: !isExpired,
    isExpired,
    expired: isExpired,
    isTimeout: isExpired,
    shouldResetContext: isExpired,
    action: isExpired ? 'RESET_AND_GREET' : 'CONTINUE',
    status: isExpired ? 'EXPIRED' : 'ACTIVE',
    sessionStatus: isExpired ? 'TIMED_OUT' : 'ACTIVE',
    timeoutMessage: msg,
    resetMessage: msg,
    message: msg,
  };
}

export class SessionManager {
  private sessionsMap = new Map<string, UserSession>();
  private appointmentService: AppointmentService;

  constructor(appointmentService?: AppointmentService) {
    this.appointmentService = appointmentService || new AppointmentService();
  }

  /**
   * Obtém ou inicializa a sessão para um determinado telefone
   */
  public getSession(clientPhone: string): UserSession | undefined {
    return this.sessionsMap.get(clientPhone);
  }

  /**
   * Valida e renova o timestamp da sessão a cada nova mensagem recebida da cliente.
   * Se a diferença for <= 10 minutos (600.000 ms), renova a sessão.
   * Se for > 10 minutos, expira a sessão anterior, cancela pré-agendamento pendente se houver,
   * e cria uma nova sessão zerada.
   */
  public async validateAndTouchSession(clientPhone: string): Promise<SessionValidationResult> {
    const now = new Date();
    const existing = this.sessionsMap.get(clientPhone);

    if (!existing) {
      // Primeira mensagem (Nova Sessão)
      const newSession: UserSession = {
        clientPhone,
        lastInteractionAt: now,
        sessionStatus: 'ACTIVE',
        conversationHistory: [],
        createdAt: now,
      };
      this.sessionsMap.set(clientPhone, newSession);
      return {
        isValid: true,
        isTimeout: false,
        session: newSession,
      };
    }

    const elapsedTime = now.getTime() - existing.lastInteractionAt.getTime();

    if (elapsedTime <= INACTIVITY_TTL_MS) {
      // Sessão VÁLIDA (Inatividade <= 10 minutos)
      existing.lastInteractionAt = now;
      existing.sessionStatus = 'ACTIVE';
      return {
        isValid: true,
        isTimeout: false,
        session: existing,
      };
    }

    // Sessão EXPIRADA por inatividade (> 10 minutos)
    console.log(`⏱️ [SESSION TIMEOUT] Sessão do cliente ${clientPhone} expirada (${Math.round(elapsedTime / 1000)}s de inatividade).`);

    existing.sessionStatus = 'TIMED_OUT';

    // Se havia um pré-agendamento pendente nesta sessão não concluída, libera o slot na grade
    // OBS: Se o agendamento possui prazo de depósito ainda válido (depositDeadline > now), respeita o prazo do Pix!
    if (existing.pendingAppointmentId) {
      try {
        const apt = await prisma.appointment.findUnique({ where: { id: existing.pendingAppointmentId } });
        const hasValidDeadline = apt && apt.depositDeadline && apt.depositDeadline.getTime() > now.getTime();
        if (apt && apt.generalStatus !== 'CANCELLED' && !hasValidDeadline) {
          console.log(`🧹 [SESSION TIMEOUT] Cancelando agendamento pendente ${existing.pendingAppointmentId} devido a timeout de sessão...`);
          await this.appointmentService.cancelAppointment(
            existing.pendingAppointmentId,
            'Expirado por inatividade de sessão (10 minutos de silêncio)'
          );
        }
      } catch (err) {
        console.warn(`⚠️ Não foi possível cancelar agendamento pendente ${existing.pendingAppointmentId}:`, err);
      }
    }

    // Cria nova sessão zerada
    const refreshedSession: UserSession = {
      clientPhone,
      clientName: existing.clientName,
      lastInteractionAt: now,
      sessionStatus: 'ACTIVE',
      conversationHistory: [],
      createdAt: now,
    };

    this.sessionsMap.set(clientPhone, refreshedSession);

    const timeoutMsg = buildSessionTimeoutMessage(existing.clientName);

    return {
      isValid: false,
      isTimeout: true,
      session: refreshedSession,
      timeoutMessage: timeoutMsg,
    };
  }

  /**
   * Atualiza o histórico de conversas e renova o timestamp de interação
   */
  public updateHistory(clientPhone: string, userText: string, modelReply: string, clientName?: string) {
    let session = this.sessionsMap.get(clientPhone);
    const now = new Date();

    if (!session) {
      session = {
        clientPhone,
        clientName,
        lastInteractionAt: now,
        sessionStatus: 'ACTIVE',
        conversationHistory: [],
        createdAt: now,
      };
      this.sessionsMap.set(clientPhone, session);
    }

    if (clientName) {
      session.clientName = clientName;
    }

    session.lastInteractionAt = now;
    session.conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
    session.conversationHistory.push({ role: 'model', parts: [{ text: modelReply }] });

    // Mantém no máximo 20 turnos no histórico da sessão
    if (session.conversationHistory.length > 20) {
      session.conversationHistory.splice(0, session.conversationHistory.length - 20);
    }
  }

  /**
   * Associa um ID de agendamento pendente à sessão para cancelamento em caso de timeout
   */
  public setPendingAppointment(clientPhone: string, appointmentId: string) {
    const session = this.sessionsMap.get(clientPhone);
    if (session) {
      session.pendingAppointmentId = appointmentId;
    }
  }

  /**
   * Remove a pendência quando o agendamento é confirmado ou concluído
   */
  public clearPendingAppointment(clientPhone: string) {
    const session = this.sessionsMap.get(clientPhone);
    if (session) {
      session.pendingAppointmentId = undefined;
    }
  }

  /**
   * Reinicia manualmente a sessão de um cliente
   */
  public resetSession(clientPhone: string) {
    this.sessionsMap.delete(clientPhone);
  }

  /**
   * Método auxiliar para testes: força o timestamp de última interação
   */
  public forceSetLastInteraction(clientPhone: string, date: Date) {
    let session = this.sessionsMap.get(clientPhone);
    if (!session) {
      session = {
        clientPhone,
        lastInteractionAt: date,
        sessionStatus: 'ACTIVE',
        conversationHistory: [],
        createdAt: date,
      };
      this.sessionsMap.set(clientPhone, session);
    } else {
      session.lastInteractionAt = date;
    }
  }

  /**
   * Rotina de limpeza periódica de sessões inativas há mais de 10 minutos
   */
  public async cleanupStaleSessions() {
    const now = new Date();
    for (const [phone, session] of this.sessionsMap.entries()) {
      if (session.sessionStatus === 'ACTIVE') {
        const elapsed = now.getTime() - session.lastInteractionAt.getTime();
        if (elapsed > INACTIVITY_TTL_MS) {
          session.sessionStatus = 'TIMED_OUT';
          if (session.pendingAppointmentId) {
            try {
              const apt = await prisma.appointment.findUnique({ where: { id: session.pendingAppointmentId } });
              const hasValidDeadline = apt && apt.depositDeadline && apt.depositDeadline.getTime() > now.getTime();
              if (apt && apt.generalStatus !== 'CANCELLED' && !hasValidDeadline) {
                await this.appointmentService.cancelAppointment(
                  session.pendingAppointmentId,
                  'Expirado em varredura por inatividade de sessão (10 minutos)'
                );
              }
            } catch (err) {
              console.warn(`⚠️ Erro ao cancelar agendamento em cleanup de sessão para ${phone}:`, err);
            }
          }
          console.log(`🧹 [CLEANUP SESSÃO] Sessão inativa há ${Math.round(elapsed / 1000)}s expirada para ${phone}.`);
        }
      }
    }
  }

  /**
   * Define o passo atual esperado da cliente na máquina de estados
   */
  public setAwaitingInput(clientPhone: string, awaitingInput: AwaitingInputType) {
    const session = this.sessionsMap.get(clientPhone);
    if (session) {
      session.awaitingInput = awaitingInput;
    }
  }

  /**
   * Obtém o passo atual esperado
   */
  public getAwaitingInput(clientPhone: string): AwaitingInputType {
    return this.sessionsMap.get(clientPhone)?.awaitingInput || 'NONE';
  }

  /**
   * Atualiza ou incrementa o contexto de agendamento da cliente (Slot Filling progressivo)
   */
  public updateBookingContext(clientPhone: string, context: Partial<BookingContext>) {
    let session = this.sessionsMap.get(clientPhone);
    if (!session) {
      const now = new Date();
      session = {
        clientPhone,
        lastInteractionAt: now,
        sessionStatus: 'ACTIVE',
        conversationHistory: [],
        createdAt: now,
        bookingContext: {},
      };
      this.sessionsMap.set(clientPhone, session);
    }

    session.bookingContext = {
      ...(session.bookingContext || {}),
      ...context,
    };
  }

  /**
   * Obtém o contexto de agendamento acumulado da sessão
   */
  public getBookingContext(clientPhone: string): BookingContext {
    return this.sessionsMap.get(clientPhone)?.bookingContext || {};
  }

  /**
   * Limpa o contexto de agendamento ao concluir
   */
  public clearBookingContext(clientPhone: string) {
    const session = this.sessionsMap.get(clientPhone);
    if (session) {
      session.bookingContext = undefined;
      session.awaitingInput = 'NONE';
    }
  }
}
