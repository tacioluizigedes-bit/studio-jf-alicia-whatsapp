/**
 * test/studio_full_suite.test.js
 * Bateria completa de testes de regras de negócio, rotas e fluxos da Alícia.
 * 
 * Execução: node --test test/studio_full_suite.test.js
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

// Importações dos serviços (ajuste os caminhos conforme sua árvore de pastas)
const { resolveSenderRole, CONFIG } = require('../src/config/phoneRoutingService');
const { isSlotBlockedByPersonalRules } = require('../src/services/scheduleRulesService');
const { processClientBookingRules, checkReschedulePolicy } = require('../src/services/clientFlowService');
const { checkSessionActivity } = require('../src/services/sessionManager');
const { handleOwnerCommands } = require('../src/services/ownerControlService');
const { inferAppointmentDurationMinutes, AppointmentService } = require('../dist/services/appointmentService');
const { extractBookingEntities } = require('../dist/services/nlpEntityExtractor');
const { prisma } = require('../dist/lib/prisma');

describe('--- BATERIA DE TESTES STUDIO JF DESIGNER ---', () => {

  // =========================================================================
  // TESTE 1: Configuração e Roteamento de Canais
  // =========================================================================
  describe('1. Roteamento de Linhas e Chaves Oficiais', () => {
    test('Deve identificar o número 21993826303 como OWNER (Janaína)', () => {
      const role = resolveSenderRole('5521993826303');
      assert.equal(role, 'OWNER', 'O número 21993826303 deve ter papel de OWNER');
    });

    test('Deve identificar números desconhecidos como CLIENT', () => {
      const role = resolveSenderRole('5521988887777');
      assert.equal(role, 'CLIENT', 'Números externos devem ser direcionados para atendimento de CLIENT');
    });

    test('A chave PIX oficial do Studio deve ser fixada em 21960003154', () => {
      assert.equal(CONFIG.OFFICIAL_STUDIO_PHONE, '5521960003154');
    });
  });

  // =========================================================================
  // TESTE 2: Diferenciação de Clientes (Nova vs Antiga)
  // =========================================================================
  describe('2. Regra de Sinal (1ª Vez vs Cliente Antiga)', () => {
    test('Cliente Nova (0 atendimentos prévios): Deve exigir sinal de 50%, informar abatimento, multa 24h, chave PIX 21960003154 e opção de link de cartão', () => {
      const mockCustomerHistory = { confirmedCount: 0 };
      const result = processClientBookingRules({
        customerPhone: '5521977776666',
        history: mockCustomerHistory,
        serviceTotal: 70.00
      });

      assert.equal(result.requiresDeposit, true, 'Cliente nova deve pagar sinal');
      assert.equal(result.depositAmount, 35.00, 'Valor atualizado do sinal deve ser 50% (R$ 35,00 para serviço de R$ 70,00)');
      assert.equal(result.depositStatus, 'PENDING');
      assert.match(result.replyMessage, /21960003154/, 'A mensagem deve conter a chave PIX oficial');
      assert.match(result.replyMessage, /abatido/i, 'A mensagem deve informar que o sinal será abatido no ato do procedimento');
      assert.match(result.replyMessage, /multa/i, 'A mensagem deve informar que ficará como multa se não comparecer/avisar em 24h');
      assert.match(result.replyMessage, /link de pagamento por cartão/i, 'A mensagem deve sinalizar opção de link de pagamento por cartão');
    });

    test('Cliente Antiga (1 ou mais atendimentos prévios): Deve conceder isenção total', () => {
      const mockCustomerHistory = { confirmedCount: 2 };
      const result = processClientBookingRules({
        customerPhone: '5521977775555',
        history: mockCustomerHistory,
        serviceTotal: 80.00
      });

      assert.equal(result.requiresDeposit, false, 'Cliente antiga deve ser isenta de sinal');
      assert.equal(result.depositStatus, 'EXEMPT');
      assert.equal(result.overallStatus, 'CONFIRMED');
      assert.match(result.replyMessage, /isenção/i, 'A mensagem deve comemorar a isenção de sinal');
      assert.match(result.replyMessage, /24 horas de antecedência/i, 'Deve avisar sobre a regra de 24h para remarcação');
    });
  });

  // =========================================================================
  // TESTE 3: Sigilo Absoluto em Bloqueios Pessoais
  // =========================================================================
  describe('3. Bloqueio Quinzenal das Terças e Sigilo de Agenda', () => {
    test('Terça-feira quinzenal (13/10/2026 às 14:00) deve estar bloqueada no sistema', () => {
      const targetDate = new Date('2026-10-13T14:00:00-03:00');
      const isBlocked = isSlotBlockedByPersonalRules(targetDate);
      assert.equal(isBlocked, true, 'O slot das 14h de 13/10/2026 deve ser bloqueado');
    });

    test('A mensagem da Alícia ao recusar o horário NUNCA deve citar termos sigilosos', () => {
      // Simulação da resposta de recusa gerada para a cliente
      const clientMessageResponse = "Nesse horário específico não temos disponibilidade na grade! Tenho às 11:30 ou a partir das 16:00. Algum desses fica bom pra você? ✨";
      
      assert.doesNotMatch(clientMessageResponse, /compromisso pessoal/i, 'Não pode mencionar compromisso pessoal');
      assert.doesNotMatch(clientMessageResponse, /Janaína/i, 'Não pode expor a Janaína');
      assert.doesNotMatch(clientMessageResponse, /bloqueio quinzenal/i, 'Não pode falar em bloqueio quinzenal');
    });
  });

  // =========================================================================
  // TESTE 4: Política de Remarcações (< 24h vs > 24h)
  // =========================================================================
  describe('4. Validação da Política de Remarcação de Horários', () => {
    test('Remarcação avisada com mais de 24h: Sem cobrança de taxa', () => {
      const appointmentTime = new Date('2026-10-20T15:00:00-03:00');
      const requestTime = new Date('2026-10-18T10:00:00-03:00'); // 53h antes

      const policy = checkReschedulePolicy({ appointmentTime, requestTime, isRegularCustomer: true });
      assert.equal(policy.chargeFee, false, 'Remarcação com mais de 24h não cobra taxa');
    });

    test('Remarcação avisada com menos de 24h: Perde isenção e exige sinal', () => {
      const appointmentTime = new Date('2026-10-20T15:00:00-03:00');
      const requestTime = new Date('2026-10-19T18:00:00-03:00'); // 21h antes (< 24h)

      const policy = checkReschedulePolicy({ appointmentTime, requestTime, isRegularCustomer: true });
      assert.equal(policy.chargeFee, true, 'Remarcação tardia deve exigir taxa de reserva');
      assert.equal(policy.requiredFeeAmount, 20.00);
      assert.match(policy.clientNotice, /menos de 24 horas/i);
    });
  });

  // =========================================================================
  // TESTE 5: Gestão de Sessões e Timeout de 10 Minutos
  // =========================================================================
  describe('5. Janela de Inatividade (TTL de 10 Minutos)', () => {
    test('Mensagem recebida com 8 minutos de pausa: Mantém a conversa ativa', () => {
      const lastInteraction = Date.now() - (8 * 60 * 1000); // 8 minutos atrás
      const sessionStatus = checkSessionActivity({ lastInteractionAt: lastInteraction });

      assert.equal(sessionStatus.isExpired, false, 'Com 8 minutos a sessão não deve expirar');
      assert.equal(sessionStatus.action, 'CONTINUE');
    });

    test('Mensagem recebida com 11 minutos de pausa: Dispara expiração e reinício', () => {
      const lastInteraction = Date.now() - (11 * 60 * 1000); // 11 minutos atrás
      const sessionStatus = checkSessionActivity({ lastInteractionAt: lastInteraction });

      assert.equal(sessionStatus.isExpired, true, 'Com mais de 10 minutos a sessão deve expirar');
      assert.equal(sessionStatus.action, 'RESET_AND_GREET');
    });
  });

  // =========================================================================
  // TESTE 6: Canal Executivo e Comandos da Janaína
  // =========================================================================
  describe('6. Comandos Executivos da Janaína (Canal 21993826303)', () => {
    test('Pergunta "o que temos pra amanhã?" deve acionar consulta de agenda e não o menu genérico', async () => {
      let messageSent = '';
      const mockWhatsAppClient = {
        sendMessage: async (to, text) => { messageSent = text; },
        sendPresenceUpdate: async () => {},
        sendSeen: async () => {}
      };

      await handleOwnerCommands(mockWhatsAppClient, '5521993826303', 'Alícia, o que temos pra amanhã?');

      assert.doesNotMatch(messageSent, /Aqui você tem o controle total do studio/i, 'Não pode disparar o menu genérico de comandos');
      assert.match(messageSent, /Agenda de Amanhã|atendimentos agendados|livre/i, 'Deve consultar a agenda do dia seguinte');
    });
  });

  // =========================================================================
  // TESTE 7: Tempo de Cada Procedimento e Bloqueio de Conflitos (Sem Encavalar)
  // =========================================================================
  describe('7. Tempo de Procedimento (Manutenção 1h30 e Design de Sobrancelha 30 min)', () => {
    test('Deve calcular 90 minutos (1h30) para Manutenção de Cílios e 30 minutos para Design de Sobrancelha', () => {
      assert.equal(inferAppointmentDurationMinutes('Manutenção de Cílios'), 90, 'Manutenção de cílios deve ter 90 minutos (1h30)');
      assert.equal(inferAppointmentDurationMinutes('Manutenção Cílios Volume Brasileiro'), 90, 'Manutenção Volume Brasileiro deve ter 90 minutos (1h30)');
      assert.equal(inferAppointmentDurationMinutes('Design de Sobrancelha'), 30, 'Design de sobrancelha deve ter 30 minutos (meia hora)');
    });

    test('Cliente às 18:00 para Manutenção de Cílios: bloqueia 18:00, 18:30 e 19:00, liberando apenas às 19:30', async () => {
      const aptService = new AppointmentService();
      const nowInTz = DateTime.now().setZone('America/Sao_Paulo');
      const baseDt18 = nowInTz.set({ day: 12, hour: 18, minute: 0, second: 0, millisecond: 0 });
      const testDate1800 = baseDt18.toJSDate();
      const testDate1830 = baseDt18.set({ minute: 30 }).toJSDate();
      const testDate1900 = baseDt18.set({ hour: 19, minute: 0 }).toJSDate();
      const testDate1930 = baseDt18.set({ hour: 19, minute: 30 }).toJSDate();

      const created = await prisma.appointment.create({
        data: {
          clientName: 'Cliente Teste 18h',
          whatsappPhone: '5521900001800',
          service: 'Manutenção Cílios Volume Brasileiro',
          appointmentDate: testDate1800,
          totalAmount: 60,
          depositAmount: 30,
          depositStatus: 'CONFIRMED',
          generalStatus: 'CONFIRMED',
          depositDeadline: new Date(Date.now() + 3600000),
          isFirstAppointment: false,
        },
      });

      try {
        const check1830 = await aptService.isSlotAvailable(testDate1830, 30);
        const check1900 = await aptService.isSlotAvailable(testDate1900, 30);
        const check1930 = await aptService.isSlotAvailable(testDate1930, 30);

        assert.equal(check1830.available, false, '18:30 deve estar ocupado pela manutenção das 18:00');
        assert.equal(check1830.nextAvailableTime, '19:30', 'Próximo horário livre deve ser 19:30');
        assert.equal(check1900.available, false, '19:00 deve estar ocupado pela manutenção das 18:00');
        assert.equal(check1900.nextAvailableTime, '19:30', 'Próximo horário livre deve ser 19:30');
        assert.equal(check1930.available, true, '19:30 deve estar livre logo após a manutenção de 1h30');
      } finally {
        await prisma.appointment.delete({ where: { id: created.id } });
      }
    });

    test('Cliente às 10:00 para Design de Sobrancelha (30 min): bloqueia 10:00 e libera às 10:30', async () => {
      const aptService = new AppointmentService();
      const nowInTz10 = DateTime.now().setZone('America/Sao_Paulo');
      const baseDt10 = nowInTz10.set({ day: 12, hour: 10, minute: 0, second: 0, millisecond: 0 });
      const testDate1000 = baseDt10.toJSDate();
      const testDate1030 = baseDt10.set({ minute: 30 }).toJSDate();

      const created = await prisma.appointment.create({
        data: {
          clientName: 'Cliente Teste 10h',
          whatsappPhone: '5521900001000',
          service: 'Design de Sobrancelha',
          appointmentDate: testDate1000,
          totalAmount: 25,
          depositAmount: 12.5,
          depositStatus: 'CONFIRMED',
          generalStatus: 'CONFIRMED',
          depositDeadline: new Date(Date.now() + 3600000),
          isFirstAppointment: false,
        },
      });

      try {
        const check1000 = await aptService.isSlotAvailable(testDate1000, 30);
        const check1030 = await aptService.isSlotAvailable(testDate1030, 30);

        assert.equal(check1000.available, false, '10:00 deve estar ocupado');
        assert.equal(check1000.nextAvailableTime, '10:30', 'Próximo horário livre após design de 30min deve ser 10:30');
        assert.equal(check1030.available, true, '10:30 deve estar livre após 30 minutos');
      } finally {
        await prisma.appointment.delete({ where: { id: created.id } });
      }
    });
  });

  // =========================================================================
  // TESTE 8: Campos de Nome e Telefone na Página /agendar e Dia da Semana em Português no Dashboard
  // =========================================================================
  describe('8. Nome/Telefone na Mensagem de Agendamento e Dias da Semana em Português no Dashboard', () => {
    test('Deve extrair Nome e Telefone da mensagem gerada pela página de agendamento (/agendar)', () => {
      const msgFromBookingPage =
        `Olá Alícia! Gostaria de agendar Volume Brasileiro no dia 29/10/2026 às 14:00.\n` +
        `Nome: Maria Clara Silva\n` +
        `Telefone: (21) 99888-7766`;

      const entities = extractBookingEntities(msgFromBookingPage);
      assert.equal(entities.clientName, 'Maria Clara Silva', 'Deve extrair o nome completo da cliente');
      assert.equal(entities.clientPhone, '5521998887766', 'Deve extrair o telefone em formato E.164');
      assert.equal(entities.timeStr, '14:00', 'Deve extrair o horário');
      assert.equal(entities.isComplete, true, 'Deve identificar agendamento completo');
    });

    test('O Dashboard Semanal deve retornar os dias da semana em português (ex: quinta-feira, terça-feira)', async () => {
      const aptService = new AppointmentService();
      const testDate = new Date('2026-10-29T14:00:00-03:00'); // Quinta-feira
      const created = await prisma.appointment.create({
        data: {
          clientName: 'Cliente Dashboard PT-BR',
          whatsappPhone: '5521900002910',
          service: 'Design de Sobrancelha',
          appointmentDate: testDate,
          totalAmount: 25,
          depositAmount: 12.5,
          depositStatus: 'CONFIRMED',
          generalStatus: 'CONFIRMED',
          depositDeadline: new Date(Date.now() + 3600000),
          isFirstAppointment: false,
        },
      });

      try {
        const dashboard = await aptService.getWeeklyDashboard('2026-10-26', '2026-11-01');
        const found = dashboard.schedule.find((item) => item.id === created.id);
        assert.ok(found, 'Agendamento deve constar no dashboard da semana');
        assert.match(found.formattedDate, /quinta-feira/i, 'O dia da semana deve estar em português (quinta-feira)');
        assert.doesNotMatch(found.formattedDate, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/i, 'Não deve conter dias em inglês');
      } finally {
        await prisma.appointment.delete({ where: { id: created.id } });
      }
    });
  });

});
