/**
 * test/twenty_bookings_flow.test.js
 * Bateria de 20 Testes de Agendamentos Completos End-to-End (Fluxo Alícia + Banco Prisma + Regras de Sinal + Sigilo)
 *
 * Execução: npm run build && node --test test/twenty_bookings_flow.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { prisma } = require('../dist/lib/prisma');
const { CalendarService } = require('../dist/services/calendarService');
const { AppointmentService, sanitizeToE164 } = require('../dist/services/appointmentService');
const { SessionManager } = require('../dist/services/sessionManager');
const { AIService } = require('../dist/services/aiService');
const { checkReschedulePolicy } = require('../dist/services/clientFlowService');
const { handleOwnerCommands } = require('../dist/services/ownerControlService');

// Força modo determinístico local do motor da Alícia durante os testes automatizados
process.env.GEMINI_API_KEY = '';

const calendarService = new CalendarService();
const appointmentService = new AppointmentService();
const sessionManager = new SessionManager();
const aiService = new AIService(calendarService, appointmentService, sessionManager);

// Mock de cliente WhatsApp para inspeção das respostas executivas
const mockWhatsAppClient = {
  sentMessages: [],
  async sendSeen() { return true; },
  async markRead() { return true; },
  async sendPresenceUpdate() { return true; },
  async sendMessage(to, text) {
    this.sentMessages.push({ to, text });
    return true;
  },
};

const TEST_PHONES = Array.from({ length: 25 }, (_, i) => `55219000000${String(i + 1).padStart(2, '0')}`);
const TEST_E164_PHONES = TEST_PHONES.map((p) => sanitizeToE164(p));

async function cleanupTestArtifacts() {
  await prisma.appointment.deleteMany({
    where: {
      OR: [
        { whatsappPhone: { in: TEST_E164_PHONES } },
        {
          appointmentDate: {
            gte: new Date('2026-10-26T00:00:00-03:00'),
            lte: new Date('2026-10-31T23:59:59-03:00'),
          },
        },
      ],
    },
  });
  await prisma.blockedSlot.deleteMany({
    where: {
      startTime: {
        gte: new Date('2026-10-28T00:00:00-03:00'),
        lte: new Date('2026-10-28T23:59:59-03:00'),
      },
    },
  });
}

describe('=== BATERIA DE 20 TESTES DE AGENDAMENTOS COMPLETOS (STUDIO JF DESIGNER) ===', () => {
  before(async () => {
    await cleanupTestArtifacts();
  });

  // Mantemos os agendamentos gerados persistidos no banco para visualização no Dashboard e consultas da Janaína!

  // ---------------------------------------------------------------------------
  // TESTE 01: Slot Filling Direto Completo (Cliente Nova - Tufinhos de Seda Light)
  // ---------------------------------------------------------------------------
  test('01. Agendamento Direto Completo (Serviço + Data + Hora em 1 frase) - Tufinhos de Seda Light (26/10 às 09:00)', async () => {
    const phone = TEST_PHONES[0];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Oi, sou a Mariana Costa, quero agendar cilio tufinho dia 26/10 às 09:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Tufinhos de Seda Light/i);
    assert.match(res.reply, /21960003154/, 'Deve informar a chave PIX oficial 21960003154');
    assert.match(res.reply, /20,00/, 'Sinal deve ser R$ 20,00 (piso mínimo para serviço de R$ 60)');

    const dbRecord = await prisma.appointment.findFirst({
      where: { whatsappPhone: sanitizeToE164(phone) },
    });
    assert.ok(dbRecord, 'Agendamento deve estar salvo no banco SQLite');
    assert.equal(dbRecord.clientName, 'Mariana Costa');
    assert.equal(dbRecord.depositStatus, 'PENDING');
    assert.equal(dbRecord.generalStatus, 'PRE_SCHEDULED');
  });

  // ---------------------------------------------------------------------------
  // TESTE 02: Fluxo em Duas Etapas (Menu Numérico "2" -> Data/Hora) - Fio a Fio Clássico (R$ 90 -> Sinal R$ 27)
  // ---------------------------------------------------------------------------
  test('02. Agendamento em 2 Etapas (Escolha Numérica "2" Fio a Fio Clássico + Data/Hora 26/10 às 11:00)', async () => {
    const phone = TEST_PHONES[1];

    const step1 = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Oi, sou a Juliana Almeida! Quais os valores de cílios?',
      senderRole: 'client',
    });
    assert.match(step1.reply, /Fio a Fio Clássico/i);

    const step2 = await aiService.processMessage({
      clientPhone: phone,
      messageText: '2',
      senderRole: 'client',
    });
    assert.match(step2.reply, /Fio a Fio Clássico/i);
    assert.match(step2.reply, /Para quando você gostaria de agendar/i);

    const step3 = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Juliana Almeida, quero dia 26/10 às 11:00',
      senderRole: 'client',
    });
    assert.match(step3.reply, /21960003154/);
    assert.match(step3.reply, /27,00/, '30% de R$ 90 = R$ 27,00');
  });

  // ---------------------------------------------------------------------------
  // TESTE 03: Fluxo Invertido (Data/Hora Primeiro -> Serviço Depois) - Volume Brasileiro (R$ 100 -> Sinal R$ 30)
  // ---------------------------------------------------------------------------
  test('03. Agendamento Invertido (Informa Data/Hora 26/10 às 14:00 primeiro e depois escolhe Volume Brasileiro)', async () => {
    const phone = TEST_PHONES[2];

    const step1 = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Camila Rocha, quero agendar para dia 26/10 às 14:00',
      senderRole: 'client',
    });
    assert.match(step1.reply, /Qual procedimento você gostaria de realizar/i);

    const step2 = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Volume Brasileiro',
      senderRole: 'client',
    });
    assert.match(step2.reply, /Volume Brasileiro/i);
    assert.match(step2.reply, /30,00/, '30% de R$ 100 = R$ 30,00');
    assert.match(step2.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 04: Prevenção de Conflito (Double-Booking no mesmo horário 26/10 às 14:00)
  // ---------------------------------------------------------------------------
  test('04. Prevenção de Conflito de Horário (Recusa agendamento duplicado em 26/10 às 14:00)', async () => {
    const phone = TEST_PHONES[3];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Quero Volume Brasileiro dia 26/10 às 14:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /não temos disponibilidade na grade/i);
    assert.doesNotMatch(res.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 05: Cliente Recorrente (1+ atendimento confirmado) -> Isenção 100% de Sinal
  // ---------------------------------------------------------------------------
  test('05. Cliente Recorrente (Após confirmação do 1º atendimento) agenda com ISENÇÃO TOTAL de sinal (26/10 às 16:30)', async () => {
    const phone = TEST_PHONES[0]; // Mariana Costa

    // Confirma o 1º agendamento dela no banco
    await prisma.appointment.updateMany({
      where: { whatsappPhone: sanitizeToE164(phone) },
      data: { depositStatus: 'CONFIRMED', generalStatus: 'CONFIRMED' },
    });

    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Mariana Costa, quero agendar Design de Sobrancelha com Henna dia 26/10 às 16:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /100% CONFIRMADO com isenção de sinal/i);

    const dbRecords = await prisma.appointment.findMany({
      where: { whatsappPhone: sanitizeToE164(phone) },
      orderBy: { appointmentDate: 'asc' },
    });
    assert.equal(dbRecords.length, 2);
    assert.equal(dbRecords[1].depositStatus, 'EXEMPT');
    assert.equal(dbRecords[1].generalStatus, 'CONFIRMED');
    assert.equal(Number(dbRecords[1].depositAmount), 0);
  });

  // ---------------------------------------------------------------------------
  // TESTE 06: Agendamento de Volume Egípcio (29/10 às 09:00 - R$ 105 -> Sinal R$ 32)
  // ---------------------------------------------------------------------------
  test('06. Agendamento Completo - Cílios Volume Egípcio (29/10 às 09:00)', async () => {
    const phone = TEST_PHONES[4];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Fernanda Lima, quero marcar Volume Egípcio dia 29/10 às 09:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Volume Egípcio/i);
    assert.match(res.reply, /32,00/, '30% de R$ 105 arredondado = R$ 32,00');
    assert.match(res.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 07: Agendamento de Volume Fox Eyes (29/10 às 11:00 - R$ 100 -> Sinal R$ 30)
  // ---------------------------------------------------------------------------
  test('07. Agendamento Completo - Cílios Fox Eyes (29/10 às 11:00)', async () => {
    const phone = TEST_PHONES[5];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Beatriz Santos, quero agendar Fox Eyes dia 29/10 às 11:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Fox Eyes/i);
    assert.match(res.reply, /30,00/);
    assert.match(res.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 08: Agendamento de Mega Brasileiro (29/10 às 14:00 - R$ 110 -> Sinal R$ 33)
  // ---------------------------------------------------------------------------
  test('08. Agendamento Completo - Mega Brasileiro (29/10 às 14:00)', async () => {
    const phone = TEST_PHONES[6];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Larissa Mendes, quero agendar Mega Brasileiro dia 29/10 às 14:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Mega Brasileiro/i);
    assert.match(res.reply, /33,00/);
    assert.match(res.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 09: Agendamento de Tufinhos Mega (29/10 às 16:30 - R$ 70 -> Sinal R$ 21)
  // ---------------------------------------------------------------------------
  test('09. Agendamento Completo - Tufinhos de Seda Mega (29/10 às 16:30)', async () => {
    const phone = TEST_PHONES[7];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Amanda Oliveira, quero agendar tufinho mega dia 29/10 às 16:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /Tufinhos de Seda Mega/i);
    assert.match(res.reply, /21,00/, '30% de R$ 70 = R$ 21,00');
  });

  // ---------------------------------------------------------------------------
  // TESTE 10: Agendamento de Design de Sobrancelha Simples (30/10 às 09:00 - R$ 25 -> Sinal Mínimo R$ 20)
  // ---------------------------------------------------------------------------
  test('10. Agendamento Completo - Design de Sobrancelha Simples com Piso Mínimo de Sinal R$ 20,00 (30/10 às 09:00)', async () => {
    const phone = TEST_PHONES[8];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Patrícia Souza, quero agendar design de sobrancelha dia 30/10 às 09:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Design de Sobrancelha/i);
    assert.match(res.reply, /20,00/, 'Deve aplicar o piso mínimo de R$ 20,00 mesmo para serviço de R$ 25,00');
  });

  // ---------------------------------------------------------------------------
  // TESTE 11: Agendamento de Combo Depilação Buço + Axila (30/10 às 11:00 - R$ 30 -> Sinal R$ 20)
  // ---------------------------------------------------------------------------
  test('11. Agendamento Completo - Combo Depilação Buço + Axila (30/10 às 11:00)', async () => {
    const phone = TEST_PHONES[9];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Gabriela Martins, quero agendar depilação de buço e axila dia 30/10 às 11:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /Buço \+ Axila/i);
    assert.match(res.reply, /20,00/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 12: Agendamento de Manutenção Volume Brasileiro (30/10 às 13:30 - R$ 60 -> Sinal R$ 20)
  // ---------------------------------------------------------------------------
  test('12. Agendamento Completo - Manutenção Volume Brasileiro (30/10 às 13:30)', async () => {
    const phone = TEST_PHONES[10];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Carolina Ferreira, quero agendar manutenção de volume brasileiro dia 30/10 às 13:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /Manutenção.*Volume Brasileiro/i);
    assert.match(res.reply, /20,00/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 13: Agendamento de Manutenção Fio a Fio Clássico (30/10 às 15:30 - R$ 55 -> Sinal R$ 20)
  // ---------------------------------------------------------------------------
  test('13. Agendamento Completo - Manutenção Fio a Fio Clássico (30/10 às 15:30)', async () => {
    const phone = TEST_PHONES[11];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Letícia Gomes, quero agendar manutenção fio a fio dia 30/10 às 15:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /Manutenção.*Fio a Fio/i);
    assert.match(res.reply, /20,00/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 14: Agendamento de Manutenção Tufinhos para Cliente Recorrente (30/10 às 17:30 -> Isenta)
  // ---------------------------------------------------------------------------
  test('14. Agendamento Completo - Manutenção Tufinhos para Cliente Antiga com Isenção (30/10 às 17:30)', async () => {
    const phone = TEST_PHONES[0]; // Mariana Costa (Cliente recorrente já confirmada)
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Mariana Costa, quero agendar manutenção de tufinho dia 30/10 às 17:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /100% CONFIRMADO com isenção de sinal/i);
  });

  // ---------------------------------------------------------------------------
  // TESTE 15: Bloqueio Quinzenal de Terça-Feira (27/10/2026 às 14:00) com Sigilo Absoluto
  // ---------------------------------------------------------------------------
  test('15. Bloqueio Quinzenal de Terça-feira (27/10/2026 às 14:00) recusa agendamento mantendo Sigilo Absoluto', async () => {
    const phone = TEST_PHONES[12];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Vanessa Ribeiro, quero agendar Volume Brasileiro dia 27/10 às 14:00',
      senderRole: 'client',
    });

    assert.match(res.reply, /não temos disponibilidade na grade/i);
    assert.doesNotMatch(res.reply, /compromisso/i);
    assert.doesNotMatch(res.reply, /Janaína/i);
    assert.doesNotMatch(res.reply, /quinzenal/i);
  });

  // ---------------------------------------------------------------------------
  // TESTE 16: Bloqueio Executivo da Janaína (28/10 das 14:00 às 16:00) + Recusa Sigilosa à Cliente
  // ---------------------------------------------------------------------------
  test('16. Janaína bloqueia 28/10 das 14:00 às 16:00 e cliente tentando 28/10 às 14:30 recebe recusa sigilosa', async () => {
    const ownerRes = await handleOwnerCommands(
      mockWhatsAppClient,
      '5521993826303',
      'Bloquear 28/10 das 14:00 às 16:00'
    );
    assert.equal(ownerRes.action, 'block_slot');

    const phone = TEST_PHONES[13];
    const clientRes = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Bruna Carvalho, quero agendar Fio a Fio Clássico dia 28/10 às 14:30',
      senderRole: 'client',
    });

    assert.match(clientRes.reply, /não temos disponibilidade na grade/i);
    assert.doesNotMatch(clientRes.reply, /Janaína/i);
    assert.doesNotMatch(clientRes.reply, /Compromisso/i);
  });

  // ---------------------------------------------------------------------------
  // TESTE 17: Agendamento no Mesmo Dia do Bloqueio Parcial em Horário Livre (28/10 às 09:30)
  // ---------------------------------------------------------------------------
  test('17. Agendamento em 28/10 às 09:30 (fora da janela bloqueada das 14h-16h) é aprovado normalmente', async () => {
    const phone = TEST_PHONES[14];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Natália Dias, quero agendar Volume Brasileiro dia 28/10 às 09:30',
      senderRole: 'client',
    });

    assert.match(res.reply, /Volume Brasileiro/i);
    assert.match(res.reply, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 18: Remarcação com Mais de 24h de Antecedência (Sem Taxa Adicional)
  // ---------------------------------------------------------------------------
  test('18. Remarcação de Agendamento com > 24h de antecedência (31/10 09:00 -> 31/10 11:00) não cobra nova taxa', async () => {
    const phone = TEST_PHONES[15];
    const created = await appointmentService.createAliciaAppointment({
      clientName: 'Priscila Castro',
      whatsappPhone: phone,
      service: 'Colocação Cílios Volume Brasileiro',
      appointmentDate: '2026-10-31T09:00:00-03:00',
      totalAmount: 100,
      durationMinutes: 60,
    });

    const rescheduled = await appointmentService.requestReschedule(
      created.appointmentId,
      '2026-10-31T11:00:00-03:00',
      60
    );

    assert.equal(rescheduled.success, true);
    assert.equal(rescheduled.penaltyApplied, false);
  });

  // ---------------------------------------------------------------------------
  // TESTE 19: Política de Remarcação com Menos de 24h (Exige Taxa de Reserva R$ 20 no PIX 21960003154)
  // ---------------------------------------------------------------------------
  test('19. Remarcação solicitada com < 24h de antecedência exige taxa de reserva de R$ 20,00 via PIX 21960003154', async () => {
    const policy = checkReschedulePolicy({
      appointmentTime: new Date('2026-10-25T14:00:00-03:00'),
      requestTime: new Date('2026-10-25T09:00:00-03:00'), // Apenas 5h antes
      isRegularCustomer: true,
      customerName: 'Tatiane Barbosa',
      newDateFormatted: '28/10 às 15:00',
    });

    assert.equal(policy.chargeFee, true);
    assert.equal(policy.requiredFeeAmount, 20.00);
    assert.equal(policy.pixKey, '21960003154');
    assert.match(policy.clientNotice, /21960003154/);
  });

  // ---------------------------------------------------------------------------
  // TESTE 20: Agendamento Completo + Consultas Executivas da Janaína ("O que temos para 29/10?", "quais agendamento temos confirmados?", "e nos próximos dias?")
  // ---------------------------------------------------------------------------
  test('20. Agendamento Completo em 29/10 às 18:00 + Relatórios Diário e Panorâmico da Janaína', async () => {
    const phone = TEST_PHONES[16];
    const res = await aiService.processMessage({
      clientPhone: phone,
      messageText: 'Sou a Renata Cardoso, quero agendar Fio a Fio Clássico dia 29/10 às 18:00',
      senderRole: 'client',
    });
    assert.match(res.reply, /21960003154/);

    const dailyReport = await handleOwnerCommands(
      mockWhatsAppClient,
      '5521993826303',
      'O que temos para 29/10?'
    );
    assert.equal(dailyReport.action, 'daily_agenda');
    assert.match(dailyReport.reply, /Fernanda Lima/);
    assert.match(dailyReport.reply, /Renata Cardoso/);

    const upcomingReport1 = await handleOwnerCommands(
      mockWhatsAppClient,
      '5521993826303',
      'quais agendamento temos confirmados?'
    );
    assert.equal(upcomingReport1.action, 'upcoming_agenda');
    assert.match(upcomingReport1.reply, /Panorama da Agenda/i);
    assert.match(upcomingReport1.reply, /Mariana Costa/);

    const upcomingReport2 = await handleOwnerCommands(
      mockWhatsAppClient,
      '5521993826303',
      'e nos próximos dias?'
    );
    assert.equal(upcomingReport2.action, 'upcoming_agenda');
    assert.match(upcomingReport2.reply, /Panorama da Agenda/i);
    assert.match(upcomingReport2.reply, /Resumo Geral:/i);
  });
});
