import { google, calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import { SALON_CONFIG } from '../config/salonConfig';

export interface AvailableSlot {
  start: string;
  end: string;
  formattedTime: string;
}

export interface CreateAppointmentParams {
  clientName: string;
  clientPhone: string;
  serviceName: string;
  startTimeIso: string;
  durationMinutes: number;
  notes?: string;
}

export interface AppointmentResult {
  success: boolean;
  eventId?: string | null;
  summary: string;
  isPendingApproval: boolean;
}

export class CalendarService {
  private calendar: calendar_v3.Calendar | null;
  private calendarId: string;

  constructor() {
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    // Autenticação com Service Account do Google
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (clientEmail && privateKey) {
      const auth = new google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      this.calendar = google.calendar({ version: 'v3', auth });
    } else {
      console.warn('⚠️ Google Calendar credentials missing. Running in mock mode.');
      this.calendar = null;
    }
  }

  /**
   * Consulta horários disponíveis para uma data e duração específicas.
   */
  async checkAvailability(dateStr: string, durationMinutes: number): Promise<AvailableSlot[]> {
    const tz = SALON_CONFIG.timezone;
    const requestedDate = DateTime.fromISO(dateStr, { zone: tz });

    if (!requestedDate.isValid) {
      throw new Error('Data inválida fornecida para consulta.');
    }

    const dayOfWeek = requestedDate.weekday % 7; // Luxon: 1=Mon...7=Sun -> 0=Sun, 1=Mon
    const businessDay = SALON_CONFIG.businessHours.find(b => b.dayOfWeek === dayOfWeek);

    if (!businessDay || !businessDay.isOpen) {
      return []; // Salão fechado neste dia
    }

    // Define início e fim do expediente para a data
    const [openHour, openMin] = businessDay.open.split(':').map(Number);
    const [closeHour, closeMin] = businessDay.close.split(':').map(Number);

    const openTime = requestedDate.set({ hour: openHour, minute: openMin, second: 0, millisecond: 0 });
    const closeTime = requestedDate.set({ hour: closeHour, minute: closeMin, second: 0, millisecond: 0 });

    if (!this.calendar) {
      return this.generateMockSlots(openTime, closeTime, durationMinutes);
    }

    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: openTime.toISO()!,
        timeMax: closeTime.toISO()!,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const existingEvents = response.data.items || [];
      const busyIntervals = existingEvents.map((evt: any) => ({
        start: DateTime.fromISO(evt.start?.dateTime || evt.start?.date || '', { zone: tz }),
        end: DateTime.fromISO(evt.end?.dateTime || evt.end?.date || '', { zone: tz })
      }));

      const availableSlots: AvailableSlot[] = [];
      let cursor = openTime;
      const slotStepMinutes = 30;

      while (cursor.plus({ minutes: durationMinutes }) <= closeTime) {
        const slotEnd = cursor.plus({ minutes: durationMinutes });
        const hasConflict = busyIntervals.some((busy: any) => {
          return (cursor < busy.end && slotEnd > busy.start);
        });

        const isPast = cursor < DateTime.now().setZone(tz);

        if (!hasConflict && !isPast) {
          availableSlots.push({
            start: cursor.toISO() || '',
            end: slotEnd.toISO() || '',
            formattedTime: cursor.toFormat('HH:mm')
          });
        }

        cursor = cursor.plus({ minutes: slotStepMinutes });
      }

      return availableSlots;
    } catch (error) {
      console.error('Erro ao consultar Google Calendar:', error);
      return this.generateMockSlots(openTime, closeTime, durationMinutes);
    }
  }

  /**
   * Cria um pré-agendamento (Pendência de aprovação manual pela Janaína)
   */
  async createAppointment(params: CreateAppointmentParams): Promise<AppointmentResult> {
    const tz = SALON_CONFIG.timezone;
    const startDt = DateTime.fromISO(params.startTimeIso, { zone: tz });
    const endDt = startDt.plus({ minutes: params.durationMinutes });

    const summary = `⏳ [PRÉ-AGENDADO / PENDENTE] ${params.serviceName} - ${params.clientName}`;
    const description = 
      `STATUS: PRÉ-AGENDADO (Aguardando Validação Manual da ${SALON_CONFIG.ownerName})\n` +
      `Cliente: ${params.clientName}\n` +
      `Telefone: ${params.clientPhone}\n` +
      `Serviço: ${params.serviceName}\n` +
      `Duração Estimada: ${params.durationMinutes} min\n` +
      `Observações: ${params.notes || 'Nenhuma'}\n` +
      `Agendado via Agente WhatsApp IA.`;

    if (!this.calendar) {
      console.log('📌 [MOCK CALENDAR] Pré-Agendamento Criado:', { summary, start: startDt.toFormat('dd/MM/yyyy HH:mm'), end: endDt.toFormat('HH:mm') });
      return {
        success: true,
        eventId: `mock_evt_${Date.now()}`,
        summary,
        isPendingApproval: true
      };
    }

    try {
      const eventResponse = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary,
          description,
          start: { dateTime: startDt.toISO()!, timeZone: tz },
          end: { dateTime: endDt.toISO()!, timeZone: tz },
          colorId: '5', // Amarelo no Google Calendar indicando "Pendente"
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 30 },
            ],
          },
        },
      });

      return {
        success: true,
        eventId: eventResponse.data.id,
        summary,
        isPendingApproval: true
      };
    } catch (error) {
      console.error('Erro ao criar evento no Google Calendar:', error);
      throw new Error('Não foi possível registrar o pré-agendamento no sistema de agenda.');
    }
  }

  private generateMockSlots(openTime: DateTime, closeTime: DateTime, durationMinutes: number): AvailableSlot[] {
    const slots: AvailableSlot[] = [];
    let cursor = openTime.set({ hour: 10, minute: 0 });

    while (cursor.plus({ minutes: durationMinutes }) <= closeTime.set({ hour: 18, minute: 0 })) {
      slots.push({
        start: cursor.toISO() || '',
        end: cursor.plus({ minutes: durationMinutes }).toISO() || '',
        formattedTime: cursor.toFormat('HH:mm')
      });
      cursor = cursor.plus({ minutes: 90 });
    }

    return slots;
  }
}
