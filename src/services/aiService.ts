import { GoogleGenerativeAI, SchemaType, FunctionDeclaration } from '@google/generative-ai';
import { SYSTEM_PROMPT } from '../prompts/systemPrompt';
import { SALON_CONFIG } from '../config/salonConfig';
import { CalendarService } from './calendarService';
import { AppointmentService, inferAppointmentDurationMinutes } from './appointmentService';
import { SessionManager } from './sessionManager';
import { OwnerAgendaSetupService } from './ownerAgendaSetupService';
import { extractBookingEntities } from './nlpEntityExtractor';
import { getDepositRequestMessage, calculateDeposit50Percent } from './notificationService';
import { DateTime } from 'luxon';

// Declaração de ferramentas (Function Calling)
const checkAvailabilityTool: FunctionDeclaration = {
  name: 'check_availability',
  description: 'Consulta horários livres na agenda do salão para uma data específica e duração do serviço, respeitando a abertura mensal e a grade do salão.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      date: {
        type: SchemaType.STRING,
        description: 'Data desejada no formato YYYY-MM-DD (ex: 2026-10-15)'
      },
      durationMinutes: {
        type: SchemaType.NUMBER,
        description: 'Duração total estimada do serviço ou combo em minutos (ex: 45, 60, 90)'
      }
    },
    required: ['date', 'durationMinutes']
  }
};

const createAppointmentTool: FunctionDeclaration = {
  name: 'create_appointment',
  description: 'Efetiva o agendamento na agenda oficial do salão. Aplica isenção de sinal para clientes recorrentes ou exige Pix para clientes de primeira vez.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      clientName: {
        type: SchemaType.STRING,
        description: 'Nome completo da cliente'
      },
      clientPhone: {
        type: SchemaType.STRING,
        description: 'Número de telefone WhatsApp da cliente'
      },
      serviceName: {
        type: SchemaType.STRING,
        description: 'Nome exato do serviço ou combo escolhido'
      },
      startTimeIso: {
        type: SchemaType.STRING,
        description: 'Data e Hora de início no formato ISO (ex: 2026-10-15T14:00:00-03:00)'
      },
      durationMinutes: {
        type: SchemaType.NUMBER,
        description: 'Duração do serviço em minutos'
      },
      notes: {
        type: SchemaType.STRING,
        description: 'Observações adicionais'
      }
    },
    required: ['clientName', 'clientPhone', 'serviceName', 'startTimeIso', 'durationMinutes']
  }
};

const handoverToHumanTool: FunctionDeclaration = {
  name: 'handover_to_human',
  description: 'Encaminha o atendimento para a proprietária humana do salão.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      reason: {
        type: SchemaType.STRING,
        description: 'Motivo detalhado do transbordo humano'
      },
      clientPhone: {
        type: SchemaType.STRING,
        description: 'Número de telefone da cliente'
      }
    },
    required: ['reason', 'clientPhone']
  }
};

export interface ProcessMessageParams {
  clientPhone: string;
  messageText: string;
  senderRole?: 'client' | 'owner' | 'admin';
  conversationHistory?: any[];
}

export interface ProcessMessageResult {
  reply: string;
  isHandoverTriggered: boolean;
  handoverReason?: string;
  mode: 'gemini' | 'simulated';
}

export class AIService {
  private genAI: GoogleGenerativeAI;
  private calendarService: CalendarService;
  private appointmentService: AppointmentService;
  private sessionManager?: SessionManager;
  private ownerAgendaSetupService: OwnerAgendaSetupService;

  constructor(
    calendarService: CalendarService,
    appointmentService?: AppointmentService,
    sessionManager?: SessionManager,
    ownerAgendaSetupService?: OwnerAgendaSetupService
  ) {
    const apiKey = process.env.GEMINI_API_KEY || 'MOCK_KEY';
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.calendarService = calendarService;
    this.appointmentService = appointmentService || new AppointmentService();
    this.sessionManager = sessionManager;
    this.ownerAgendaSetupService = ownerAgendaSetupService || new OwnerAgendaSetupService();
  }

  public setApiKey(newKey: string) {
    process.env.GEMINI_API_KEY = newKey;
    this.genAI = new GoogleGenerativeAI(newKey);
    console.log('🔑 Nova chave GEMINI_API_KEY configurada no AIService com sucesso.');
  }

  public hasRealApiKey(): boolean {
    return !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '' && process.env.GEMINI_API_KEY !== 'MOCK_KEY';
  }

  async processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
    const historyLength = params.conversationHistory?.length || 0;

    // 0. Interceptor de Intenção Administrativa (Janaína / Montar Agenda do Mês)
    if (
      this.ownerAgendaSetupService.isAdminIntent(params.messageText, params.clientPhone, params.senderRole) ||
      this.ownerAgendaSetupService.isPhoneInAdminFlow(params.clientPhone)
    ) {
      console.log(`👑 [ADMIN INTERCEPTOR] Intenção de montagem de agenda detectada para ${params.clientPhone}`);
      const adminResult = this.ownerAgendaSetupService.processAdminMessage(params.clientPhone, params.messageText);
      return {
        reply: adminResult.reply,
        isHandoverTriggered: false,
        mode: 'simulated',
      };
    }

    const nowIso = DateTime.now().setZone(SALON_CONFIG.timezone).toFormat('yyyy-MM-dd HH:mm (EEEE)');
    const fullSystemInstruction = `${SYSTEM_PROMPT}\n\n[CONTEXTO DE SISTEMA TEMPO REAL]\nData e Hora Atual: ${nowIso}\nTimezone: ${SALON_CONFIG.timezone}\nTelefone da Cliente em Atendimento: ${params.clientPhone}`;

    if (!this.hasRealApiKey()) {
      const mockResult = await this.handleMockAIResponse(params.messageText, params.clientPhone, historyLength);
      return {
        ...mockResult,
        mode: 'simulated',
      };
    }

    try {
      let isHandoverTriggered = false;
      let handoverReason: string | undefined;

      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const model = this.genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: fullSystemInstruction,
        tools: [
          {
            functionDeclarations: [checkAvailabilityTool, createAppointmentTool, handoverToHumanTool],
          },
        ],
      });

      const chat = model.startChat({
        history: params.conversationHistory || [],
      });

      const result = await chat.sendMessage(params.messageText);
      const response = result.response;
      const functionCalls = response.functionCalls();

      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        console.log(`🤖 IA acionou Function Call: ${call.name}`, call.args);

        if (call.name === 'check_availability') {
          const { date, durationMinutes } = call.args as { date: string; durationMinutes: number };
          const slots = await this.calendarService.checkAvailability(date, durationMinutes);

          const formattedSlots =
            slots.length > 0
              ? slots.map((s) => s.formattedTime).join(', ')
              : 'Nenhum horário livre encontrado nesta data.';

          const followUp = await chat.sendMessage([
            {
              functionResponse: {
                name: 'check_availability',
                response: { availableSlots: formattedSlots, totalSlots: slots.length, slotsDetail: slots },
              },
            },
          ]);

          return { reply: followUp.response.text(), isHandoverTriggered: false, mode: 'gemini' };
        }

        if (call.name === 'create_appointment') {
          const args = call.args as any;
          const matchedService = SALON_CONFIG.services.find(
            (s) => s.name.toLowerCase() === (args.serviceName || '').toLowerCase()
          );
          const totalAmount = matchedService?.price || 80.0;

          let aliciaRecord;
          try {
            aliciaRecord = await this.appointmentService.createAliciaAppointment({
              clientName: args.clientName,
              whatsappPhone: args.clientPhone || params.clientPhone,
              service: args.serviceName,
              appointmentDate: args.startTimeIso,
              totalAmount,
              durationMinutes: args.durationMinutes || 60,
              notes: args.notes,
            });

            if (aliciaRecord && aliciaRecord.depositStatus === 'PENDING') {
              this.sessionManager?.setPendingAppointment(params.clientPhone, aliciaRecord.appointmentId);
            }
          } catch (dbErr: any) {
            return {
              reply: `Poxa, linda! ${dbErr?.message || 'Não consegui agendar nesse horário.'} Deseja escolher outro horário? 💕`,
              isHandoverTriggered: false,
              mode: 'gemini',
            };
          }

          const followUp = await chat.sendMessage([
            {
              functionResponse: {
                name: 'create_appointment',
                response: {
                  success: true,
                  depositStatus: aliciaRecord.depositStatus,
                  isFirstAppointment: aliciaRecord.isFirstAppointment,
                  depositAmount: aliciaRecord.depositAmount,
                  depositDeadline: aliciaRecord.depositDeadlineFormatted,
                  pixKey: aliciaRecord.pixKey,
                  officialTemplateMessage: getDepositRequestMessage({
                    customerName: args.clientName || 'linda',
                    serviceName: args.serviceName,
                    appointmentDateFormatted: DateTime.fromISO(args.startTimeIso, { zone: SALON_CONFIG.timezone }).setLocale('pt-BR').toFormat("dd/MM/yyyy (cccc) 'às' HH:mm"),
                    totalAmount,
                    depositAmount: aliciaRecord.depositAmount,
                    depositDeadlineFormatted: aliciaRecord.depositDeadlineFormatted,
                  }),
                  instructions:
                    aliciaRecord.depositStatus === 'EXEMPT'
                      ? `Confirme o agendamento imediatamente explicando que ela é ISENTA de sinal por ser cliente recorrente do studio!`
                      : `Informe à cliente o pré-agendamento utilizando a Chave PIX Oficial do Studio \`21960003154\` e solicite o sinal Pix de R$ ${Number(aliciaRecord.depositAmount).toFixed(2).replace('.', ',')} até ${aliciaRecord.depositDeadlineFormatted}.`,
                },
              },
            },
          ]);

          return { reply: followUp.response.text(), isHandoverTriggered: false, mode: 'gemini' };
        }

        if (call.name === 'handover_to_human') {
          const args = call.args as any;
          isHandoverTriggered = true;
          handoverReason = args.reason;

          return {
            reply: `Entendi perfeitamente! Para te dar a melhor atenção nesse caso, estou transferindo a sua conversa para a *${SALON_CONFIG.ownerName}*, proprietária do salão. Ela já foi notificada e vai te responder aqui mesmo em instantes! 💕`,
            isHandoverTriggered: true,
            handoverReason,
            mode: 'gemini',
          };
        }
      }

      return {
        reply: response.text(),
        isHandoverTriggered: false,
        mode: 'gemini',
      };
    } catch (error: any) {
      console.error('Erro na integração com Gemini AI:', error?.message || error);
      const mockResult = await this.handleMockAIResponse(params.messageText, params.clientPhone, historyLength);
      return {
        reply: `${mockResult.reply}\n\n_(Nota: Resposta gerada via inteligência local do salão)_`,
        isHandoverTriggered: mockResult.isHandoverTriggered,
        handoverReason: mockResult.handoverReason,
        mode: 'simulated',
      };
    }
  }

  private async handleMockAIResponse(
    userMessage: string,
    clientPhone: string,
    historyLength: number = 0
  ): Promise<{ reply: string; isHandoverTriggered: boolean; handoverReason?: string }> {
    const text = userMessage.toLowerCase().trim();

    // 1. Transbordo Humano
    if (text.includes('jana') || text.includes('dona') || text.includes('humano') || text.includes('falar com pessoa')) {
      return {
        reply: `Com certeza, linda! Vou pedir para a própria ${SALON_CONFIG.ownerName} falar diretamente com você aqui no WhatsApp. Ela já te responde por aqui em instantes, combinado? 💕`,
        isHandoverTriggered: true,
        handoverReason: 'Solicitação de atendimento com a proprietária',
      };
    }

    // 2. Política de Remarcação e Falta (24h + Multa + Novo Sinal 50%)
    if (text.includes('remarcar') || text.includes('alterar data') || text.includes('mudar horário') || text.includes('mudar horario')) {
      return {
        reply: `Sem problemas! Nossas regras de agendamento e remarcação são super transparentes:\n\n✨ *Avisos com no mínimo 24 horas de antecedência:* A alteração é feita sem nenhum custo adicional!\n\n⚠️ *Avisos com menos de 24 horas ou falta no dia:* O valor do sinal (50%, que é abatido no ato do procedimento) **não será devolvido e ficará retido como multa**. E para agendar um novo atendimento, será cobrado um **novo sinal de 50%** (via PIX ou link de pagamento por cartão).\n\nQual o novo dia e horário que fica melhor para você? 🗓️`,
        isHandoverTriggered: false,
      };
    }

    // 2.5. Pagamento do Sinal por Cartão (Quando não for em PIX)
    if (
      text.includes('cartao') ||
      text.includes('cartão') ||
      text.includes('credito') ||
      text.includes('crédito') ||
      text.includes('debito') ||
      text.includes('débito') ||
      text.includes('link de pagamento') ||
      text.includes('nao tenho pix') ||
      text.includes('não tenho pix') ||
      text.includes('sem pix')
    ) {
      return {
        reply: `Claro, linda! 💳 Quando o pagamento do sinal (50% do valor do procedimento) não for feito via PIX, ele **pode ser feito através do link de pagamento por cartão**!\n\nLembrando que:\n✅ O valor do sinal será **abatido integralmente no ato do procedimento**.\n⚠️ Caso não compareça no dia e não informe dentro do prazo de **24 horas antes do atendimento**, o valor não será devolvido e ficará como multa, sendo cobrado um novo sinal para um novo agendamento.\n\nJá vou solicitar o seu link de pagamento por cartão com a Janaína para te enviar aqui mesmo! 💕`,
        isHandoverTriggered: false,
      };
    }

    const currentAwaiting = this.sessionManager?.getAwaitingInput(clientPhone) || 'NONE';
    const existingContext = this.sessionManager?.getBookingContext(clientPhone) || {};
    const entities = extractBookingEntities(userMessage, currentAwaiting);
    const hasBookingScheduleIntent = !!(entities.dateStr || entities.timeStr || text.includes('agendar') || text.includes('marcar'));

    // 3. Manutenção de Cílios e Regras (apenas se for dúvida e não pedido direto de agendamento com data/hora)
    if (!hasBookingScheduleIntent && (text.includes('manuten') || text.includes('15 dias') || text.includes('20 dias') || text.includes('taxa'))) {
      return {
        reply: `Para manter seu olhar sempre impecável e os cílios bem preenchidos, o prazo recomendado de manutenção é de 15 a 20 dias, tá bom? 🥰\n\nSe passar de 20 dias, tem um acréscimo de *R$ 5,00* no valor da manutenção.\n\nNossos valores de manutenção:\n• *Tufinhos de Seda:* R$ 40 a R$ 45\n• *Fio a Fio Clássico:* R$ 55\n• *Volume Brasileiro:* R$ 60\n• *Volume Egípcio / Fox Eyes / Mega:* R$ 65\n\nHá quantos dias você colocou os seus? 💕`,
        isHandoverTriggered: false,
      };
    }

    // 4. Regra de Sinal (50%) / Valores / Multa 24h / Link de Cartão
    if (!hasBookingScheduleIntent && (text.includes('sinal') || text.includes('pix') || text.includes('taxa de reserva') || text.includes('multa'))) {
      return {
        reply: `Como funciona a reserva no studio:\n\n✨ *Valor do Sinal (50%):* Solicitamos um sinal de **50% do valor do procedimento** para garantir a vaga na agenda, e **esse valor será abatido no ato do procedimento**!\n\n🔑 *Formas de Pagamento do Sinal:*\n• Via **PIX** (Chave Oficial: \`21960003154\`)\n• Ou através do **link de pagamento por cartão**, caso não vá fazer em PIX!\n\n⚠️ *Regra de Comparecimento e Prazo de 24h:*\nCaso a cliente não compareça no dia e não informe dentro do prazo de **24 horas antes do atendimento**, o valor do sinal **não será devolvido e ficará como multa**. E para agendar um novo atendimento, será cobrado um **novo sinal**.\n\n💖 *Clientes Recorrentes / Antigas:* Têm isenção de sinal (respeitando o aviso prévio de 24h).\n\nQuer que eu já veja um horário especial para você? 🥰`,
        isHandoverTriggered: false,
      };
    }

    // 5. Endereço e Instagram
    if (text.includes('onde') || text.includes('endereço') || text.includes('endereco') || text.includes('instagram')) {
      return {
        reply: `Nosso studio fica em um espaço lindo e acolhedor:\n\n📍 *${SALON_CONFIG.name}*\n🏡 *Endereço:* ${SALON_CONFIG.address}\n📸 *Instagram:* ${SALON_CONFIG.instagram}\n👤 *Proprietária:* ${SALON_CONFIG.ownerName}\n\nEspero você com todo carinho! 💕`,
        isHandoverTriggered: false,
      };
    }

    // ============================================================
    // 6. PROCESSAMENTO DE SLOT FILLING & MÁQUINA DE ESTADOS (NLP)
    // ============================================================

    // Merge de contexto (novas entidades + contexto cumulativo existente)
    const mergedService = entities.service || (existingContext.serviceName ? {
      id: existingContext.serviceId || 'servico',
      name: existingContext.serviceName,
      price: existingContext.servicePrice || 60,
      durationMinutes: existingContext.durationMinutes || 60,
      category: 'cilios',
    } : undefined);

    const mergedDateStr = entities.dateStr || existingContext.dateStr;
    const mergedDateFormatted = entities.dateFormatted || existingContext.dateFormatted;
    const mergedWeekday = entities.weekdayName || 'Data';
    const mergedTimeStr = entities.timeStr || existingContext.timeStr;

    if (entities.clientName) {
      this.sessionManager?.updateBookingContext(clientPhone, {
        clientName: entities.clientName,
      });
    }
    const mergedClientName = entities.clientName || existingContext.clientName || 'Cliente';
    if (entities.service) {
      this.sessionManager?.updateBookingContext(clientPhone, {
        serviceId: entities.service.id,
        serviceName: entities.service.name,
        servicePrice: entities.service.price,
        durationMinutes: entities.service.durationMinutes,
      });
    }
    if (entities.dateStr) {
      this.sessionManager?.updateBookingContext(clientPhone, {
        dateStr: entities.dateStr,
        dateFormatted: entities.dateFormatted,
      });
    }
    if (entities.timeStr) {
      this.sessionManager?.updateBookingContext(clientPhone, {
        timeStr: entities.timeStr,
      });
    }

    // ------------------------------------------------------------
    // CASO A: Slot Filling Completo (Serviço + Data + Horário)
    // Exemplo: "quarta-feira 14/10 às 09:00, cilio tufinho"
    // Pula etapas de preços e avança DIRETO para validação e sinal
    // ------------------------------------------------------------
    if (mergedService && mergedDateStr && mergedTimeStr) {
      const tz = SALON_CONFIG.timezone;
      const targetDt = DateTime.fromISO(`${mergedDateStr}T${mergedTimeStr}:00`, { zone: tz });
      const duration = mergedService.durationMinutes || inferAppointmentDurationMinutes(mergedService.name);

      // Validação de disponibilidade na agenda respeitando o tempo de cada procedimento + Regra de Sigilo Absoluto
      const availability = await this.appointmentService.isSlotAvailable(targetDt.toJSDate(), duration);

      if (!availability.available) {
        this.sessionManager?.updateBookingContext(clientPhone, { timeStr: undefined });

        if (availability.conflictType === 'APPOINTMENT_CONFLICT' && availability.nextAvailableTime) {
          const extraSlots = (availability.suggestedSlots || []).filter((s) => s !== availability.nextAvailableTime);
          const extraText = extraSlots.length > 0 ? ` (ou às ${extraSlots.join(', ')})` : '';
          return {
            reply:
              `Nesse horário das *${mergedTimeStr}* já temos um atendimento em andamento! ` +
              `Como cada procedimento tem o seu tempo certinho para você não precisar ficar esperando, ` +
              `o próximo horário livre logo em seguida é às *${availability.nextAvailableTime}*${extraText}. ` +
              `Fica bom pra você agendar às *${availability.nextAvailableTime}*? ✨`,
            isHandoverTriggered: false,
          };
        }

        // REGRA DE SIGILO ABSOLUTO para bloqueios pessoais:
        // NUNCA cita "compromisso pessoal" ou "Janaína" para clientes.
        const suggestions =
          availability.suggestedSlots && availability.suggestedSlots.length >= 2
            ? `às ${availability.suggestedSlots[0]} ou às ${availability.suggestedSlots[1]}`
            : availability.nextAvailableTime
            ? `a partir das ${availability.nextAvailableTime}`
            : 'às 11:30 ou a partir das 16:00';

        return {
          reply: `Nesse horário específico não temos disponibilidade na grade! Tenho ${suggestions}. Algum desses fica bom pra você? ✨`,
          isHandoverTriggered: false,
        };
      }

      // Horário livre! Registra agendamento aplicando regra de sinal de 50%
      const effectiveClientPhone = entities.clientPhone || clientPhone;
      const isExistingClient = (await this.appointmentService.getClientConfirmedCount(effectiveClientPhone)) > 0;
      const totalAmount = mergedService.price || 60.0;
      const calculatedDeposit = isExistingClient ? 0 : calculateDeposit50Percent(totalAmount);

      let aliciaRecord;
      try {
        aliciaRecord = await this.appointmentService.createAliciaAppointment({
          clientName: mergedClientName,
          whatsappPhone: effectiveClientPhone,
          service: mergedService.name,
          appointmentDate: targetDt.toISO()!,
          totalAmount,
          depositAmount: calculatedDeposit,
          durationMinutes: duration,
        });

        if (aliciaRecord && aliciaRecord.depositStatus === 'PENDING') {
          this.sessionManager?.setPendingAppointment(clientPhone, aliciaRecord.appointmentId);
        }
      } catch (err: any) {
        return {
          reply: `Nesse horário específico não temos disponibilidade na grade! Tenho às 11:30 ou a partir das 16:00. Algum desses fica bom pra você? ✨`,
          isHandoverTriggered: false,
        };
      }

      this.sessionManager?.setAwaitingInput(clientPhone, 'CONFIRMATION');
      this.sessionManager?.clearBookingContext(clientPhone);

      const weekdayLabel = targetDt.setLocale('pt-BR').toFormat('cccc');
      const formattedDate = targetDt.toFormat('dd/MM');
      const capitalizedWeekday = weekdayLabel.charAt(0).toUpperCase() + weekdayLabel.slice(1);

      if (isExistingClient) {
        // Cliente Antiga (Isenta de Sinal)
        return {
          reply: `Perfeito, linda! Já verifiquei aqui e temos sim vaga para ${capitalizedWeekday}, ${formattedDate} às ${mergedTimeStr} para ${mergedService.name}! ✨\n\nComo você já é nossa cliente especial do studio, o seu agendamento já está **100% CONFIRMADO com isenção de sinal**! 💖 Já reservei esse momento com todo carinho pra você. Te espero aqui no studio! 🌸`,
          isHandoverTriggered: false,
        };
      } else {
        // Cliente Nova (Exige Sinal) - Template Oficial com Chave PIX 21960003154
        return {
          reply: getDepositRequestMessage({
            customerName: mergedClientName !== 'Cliente' ? mergedClientName : 'linda',
            serviceName: mergedService.name,
            appointmentDateFormatted: `${capitalizedWeekday}, ${formattedDate} às ${mergedTimeStr}`,
            totalAmount,
            depositAmount: calculatedDeposit,
            depositDeadlineFormatted: aliciaRecord.depositDeadlineFormatted,
          }),
          isHandoverTriggered: false,
        };
      }
    }

    // ------------------------------------------------------------
    // CASO B: Apenas o Serviço foi informado (ou cliente respondeu "1", "tufinho", etc.)
    // Guarda o serviço na sessão, avança estado e NÃO repete a lista de preços!
    // ------------------------------------------------------------
    if (mergedService && (!mergedDateStr || !mergedTimeStr)) {
      this.sessionManager?.setAwaitingInput(clientPhone, 'DATE_TIME');
      return {
        reply: `Excelente escolha, linda! Os *${mergedService.name}* ficam maravilhosos e super naturais! ✨\n\nPara quando você gostaria de agendar? Me diga o dia e o horário que fica melhor pra você (por exemplo: "quarta-feira 14/10 às 09:00" ou "amanhã às 14h") 💕`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO C: Apenas Data/Horário foi informado (Falta Serviço)
    // ------------------------------------------------------------
    if (entities.dateStr || entities.timeStr) {
      this.sessionManager?.setAwaitingInput(clientPhone, 'SERVICE_SELECTION');
      const datePart = entities.dateFormatted ? `para ${entities.weekdayName || ''} (${entities.dateFormatted})` : '';
      const timePart = entities.timeStr ? `às ${entities.timeStr}` : '';
      return {
        reply: `Perfeito, já anotei sua preferência ${datePart} ${timePart}! ✨\n\nQual procedimento você gostaria de realizar? Nossas opções mais amadas:\n1. *Tufinhos de Seda Light* (R$ 60)\n2. *Fio a Fio Clássico* (R$ 75)\n3. *Volume Brasileiro* (R$ 80)\n4. *Design de Sobrancelha* (R$ 25)\n\nQual desses você prefere? Me responda com o nome ou o número da opção! 🥰`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO D: Pergunta sobre opções de cílios
    // ------------------------------------------------------------
    if (text.includes('cilios') || text.includes('cílios') || text.includes('valores') || text.includes('tabela')) {
      this.sessionManager?.setAwaitingInput(clientPhone, 'SERVICE_SELECTION');
      return {
        reply: `Ah, colocar cílios transforma o olhar! ✨ Nossas opções:\n\n1. *Tufinhos de Seda Light:* R$ 60\n2. *Fio a Fio Clássico:* R$ 75\n3. *Volume Brasileiro:* R$ 80\n4. *Volume Egípcio ou Fox Eyes:* R$ 90\n5. *Mega Brasileiro:* R$ 90\n\nQual desses estilos você mais gosta? Você pode me responder com o nome ou o número da opção! 🥰`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO E: Pergunta sobre Sobrancelhas
    // ------------------------------------------------------------
    if (text.includes('sobrancelha') || text.includes('design') || text.includes('henna')) {
      this.sessionManager?.setAwaitingInput(clientPhone, 'SERVICE_SELECTION');
      return {
        reply: `Um bom design renova a expressão! ✨ Nossas opções:\n\n• *Limpeza:* R$ 15\n• *Design Personalizado:* R$ 25\n• *Design com Henna:* R$ 35\n\nQual você prefere agendar? 💕`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO F: Pergunta sobre horários de funcionamento (SIGILO ABSOLUTO)
    // ------------------------------------------------------------
    if (text.includes('horário') || text.includes('horario') || text.includes('dias') || text.includes('atendimento')) {
      return {
        reply: `Nosso atendimento é de *segunda a sexta das 09:00 às 19:00* e aos *sábados das 08:00 às 18:00*. ✨\n\nQual dia e período (manhã ou tarde) você prefere para o seu atendimento? 💕`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO G: Quebra do loop de boas-vindas
    // ------------------------------------------------------------
    if (historyLength > 0) {
      return {
        reply: `Entendi, linda! 💕 Como posso te ajudar com o seu momento de beleza? Quer ver nossos valores de cílios, sobrancelhas ou já escolhermos um horário pra você?`,
        isHandoverTriggered: false,
      };
    }

    // ------------------------------------------------------------
    // CASO H: Boas-vindas para primeira mensagem
    // ------------------------------------------------------------
    return {
      reply: `Oi, linda! Tudo bem? Seja muito bem-vinda ao *${SALON_CONFIG.name}*! ✨\n\nEu sou a ${SALON_CONFIG.assistantName}, da equipe da ${SALON_CONFIG.ownerName}. Como posso cuidar de você hoje? Fique à vontade para perguntar sobre cílios, sobrancelhas ou escolhermos um horário perfeito pra você! 💖`,
      isHandoverTriggered: false,
    };
  }
}
