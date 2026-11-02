const fs = require('fs');
const path = require('path');
const { PrismaClient, Prisma } = require('@prisma/client');

async function sanitizeDb(dbUrl) {
  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    const all = await prisma.appointment.findMany({
      orderBy: { appointmentDate: 'asc' },
    });

    for (const apt of all) {
      // 1. Remove duplicate placeholder rows where another real appointment exists at the same time
      if (
        (apt.clientName === 'Cliente (Agendada pela Janaína)' || apt.clientName === 'Cliente') &&
        apt.service === 'Procedimento Studio JF'
      ) {
        const sameTimeOthers = all.filter(
          (other) =>
            other.id !== apt.id &&
            other.appointmentDate.getTime() === apt.appointmentDate.getTime()
        );
        if (sameTimeOthers.length > 0) {
          await prisma.appointment.delete({ where: { id: apt.id } });
          console.log(`🧹 [DB CLEANUP] Removido registro duplicado ${apt.id} em ${apt.appointmentDate.toISOString()}`);
          continue;
        }
      }

      let newClientName = (apt.clientName || '').replace(/\s+(?:às|as|para|no|na)$/i, '').trim();
      let newService = apt.service;
      let newTotal = Number(apt.totalAmount);

      const iso = apt.appointmentDate.toISOString();
      if (iso === '2026-11-03T17:00:00.000Z' && (/^cliente/i.test(newClientName) || /studio\s*jf/i.test(newService))) {
        newClientName = 'Fernanda';
        newService = 'Limpeza de Pele Profunda';
        newTotal = 120;
      } else if (iso === '2026-10-27T21:00:00.000Z' && newClientName === 'Renata' && /studio\s*jf/i.test(newService)) {
        newService = 'Manutenção Cílios Volume Brasileiro';
        newTotal = 65;
      } else if (iso === '2026-10-28T17:00:00.000Z' && /^cliente/i.test(newClientName) && /virilha/i.test(newService)) {
        newClientName = 'Amanda';
      } else if (iso === '2026-10-28T19:00:00.000Z' && /^cliente/i.test(newClientName)) {
        newClientName = 'Carla Mendes';
        if (/studio\s*jf/i.test(newService)) {
          newService = 'Colocação Cílios Volume Brasileiro';
          newTotal = 100;
        }
      } else if (iso === '2026-10-30T13:00:00.000Z' && /^cliente/i.test(newClientName)) {
        newClientName = 'Bruna Oliveira';
      } else {
        if (/studio\s*jf|procedimento\s*studio/i.test(newService)) {
          newService = 'Design de Sobrancelha';
          if (newTotal === 60) newTotal = 25;
        }
        if (/^cliente\s*\(agendada pela jana[ií]na\)$/i.test(newClientName) || /^cliente$/i.test(newClientName)) {
          newClientName = 'Fernanda';
        }
      }

      if (
        newClientName !== apt.clientName ||
        newService !== apt.service ||
        newTotal !== Number(apt.totalAmount)
      ) {
        await prisma.appointment.update({
          where: { id: apt.id },
          data: {
            clientName: newClientName,
            service: newService,
            totalAmount: new Prisma.Decimal(newTotal),
          },
        });
        console.log(
          `🧹 [DB CLEANUP] Atualizado ${apt.id} (${iso}): "${apt.clientName}" -> "${newClientName}", "${apt.service}" -> "${newService}"`
        );
      }
    }

    // Garante que os agendamentos da Janaína dos dias 02/11 e 03/11 estejam presentes caso o banco tenha sido inicializado do zero
    const seedAppointments = [
      {
        id: 'd1dc26f5-e047-4996-9bcb-5d05835089bb',
        clientName: 'Larissa',
        whatsappPhone: '5521900000000',
        service: 'Manutenção Cílios Volume Egípcio',
        appointmentDate: new Date('2026-11-02T19:00:00.000Z'),
        totalAmount: new Prisma.Decimal(65),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: new Date('2026-11-02T22:51:57.987Z'),
        confirmedAt: new Date('2026-11-02T20:51:57.987Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: false,
        notes: '[Agendado diretamente pela Janaína]',
      },
      {
        id: 'c40be518-629f-4345-9317-ec092a3aaeca',
        clientName: 'Fernanda',
        whatsappPhone: '5521900000000',
        service: 'Limpeza de Pele Profunda',
        appointmentDate: new Date('2026-11-03T17:00:00.000Z'),
        totalAmount: new Prisma.Decimal(120),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CANCELLED',
        depositDeadline: new Date('2026-11-03T19:00:00.000Z'),
        confirmedAt: new Date('2026-11-01T21:43:23.532Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: true,
        notes: '[Agendado diretamente pela Janaína] | [Cancelado]: Cancelado pelo operador',
      },
      {
        id: '54ae1b5d-33ec-4619-ae59-0c01c4330b89',
        clientName: 'Fernanda',
        whatsappPhone: '5521900000000',
        service: 'Manutenção Cílios Volume Brasileiro',
        appointmentDate: new Date('2026-11-03T17:00:00.000Z'),
        totalAmount: new Prisma.Decimal(60),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: new Date('2026-11-02T22:57:04.435Z'),
        confirmedAt: new Date('2026-11-02T20:57:04.435Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: true,
        notes: '[Agendado diretamente pela Janaína]',
      },
      {
        id: '885d7b63-6610-4274-9f77-e20f3196cdd8',
        clientName: 'Larissa',
        whatsappPhone: '5521900000000',
        service: 'Manutenção Cílios Volume Brasileiro',
        appointmentDate: new Date('2026-11-03T19:00:00.000Z'),
        totalAmount: new Prisma.Decimal(60),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: new Date('2026-11-02T22:52:41.185Z'),
        confirmedAt: new Date('2026-11-02T20:52:41.185Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: true,
        notes: '[Agendado diretamente pela Janaína]',
      },
      {
        id: '5e5fc754-e0b2-4fae-a4c1-9644474ee9d1',
        clientName: 'Sandrinha',
        whatsappPhone: '5521900000000',
        service: 'Manutenção Cílios Volume Brasileiro',
        appointmentDate: new Date('2026-11-03T21:30:00.000Z'),
        totalAmount: new Prisma.Decimal(60),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: new Date('2026-11-02T23:00:05.074Z'),
        confirmedAt: new Date('2026-11-02T21:00:05.074Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: false,
        notes: '[Agendado diretamente pela Janaína]',
      },
      {
        id: '032ffa5a-d1ef-4cc5-8b43-9f2da988aebf',
        clientName: 'Michele',
        whatsappPhone: '5521900000000',
        service: 'Manutenção Cílios Volume Brasileiro',
        appointmentDate: new Date('2026-11-03T23:00:00.000Z'),
        totalAmount: new Prisma.Decimal(60),
        depositAmount: new Prisma.Decimal(0),
        depositStatus: 'EXEMPT',
        generalStatus: 'CONFIRMED',
        depositDeadline: new Date('2026-11-02T23:00:29.336Z'),
        confirmedAt: new Date('2026-11-02T21:00:29.337Z'),
        confirmedBy: 'Janaína (Direto)',
        isFirstAppointment: false,
        reminderSent24h: false,
        notes: '[Agendado diretamente pela Janaína]',
      },
    ];

    for (const item of seedAppointments) {
      const existingById = await prisma.appointment.findUnique({ where: { id: item.id } });
      if (!existingById) {
        await prisma.appointment.create({ data: item });
      } else if (item.id === 'c40be518-629f-4345-9317-ec092a3aaeca' && existingById.generalStatus !== 'CANCELLED') {
        await prisma.appointment.update({
          where: { id: item.id },
          data: {
            service: 'Limpeza de Pele Profunda',
            totalAmount: new Prisma.Decimal(120),
            generalStatus: 'CANCELLED',
            notes: item.notes,
          },
        });
      } else if (item.id === '54ae1b5d-33ec-4619-ae59-0c01c4330b89' && existingById.service !== 'Manutenção Cílios Volume Brasileiro') {
        await prisma.appointment.update({
          where: { id: item.id },
          data: {
            service: 'Manutenção Cílios Volume Brasileiro',
            totalAmount: new Prisma.Decimal(60),
            generalStatus: 'CONFIRMED',
          },
        });
      }
    }

    const blockId = '445942ab-42f5-4e86-a935-25f414071276';
    const existingBlock = await prisma.blockedSlot.findUnique({ where: { id: blockId } });
    if (!existingBlock) {
      await prisma.blockedSlot.create({
        data: {
          id: blockId,
          title: 'Compromisso Pessoal',
          reason: 'INTERNAL_UNAVAILABLE',
          startTime: new Date('2026-11-03T00:30:00.000Z'),
          endTime: new Date('2026-11-03T01:30:00.000Z'),
          isRecurring: false,
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function run() {
  const targets = new Set();
  if (process.env.DATABASE_URL) {
    targets.add(process.env.DATABASE_URL);
  }
  const localDev = path.resolve(__dirname, '..', 'prisma', 'dev.db');
  if (fs.existsSync(localDev)) {
    targets.add('file:./dev.db');
  }
  const seedDb = path.resolve(__dirname, '..', 'prisma', 'seed-agenda.db');
  if (fs.existsSync(seedDb)) {
    targets.add('file:./seed-agenda.db');
  }

  for (const url of targets) {
    try {
      await sanitizeDb(url);
    } catch (err) {
      console.warn(`⚠️ [DB CLEANUP] Aviso em ${url}:`, err.message);
    }
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { sanitizeDb, run };
