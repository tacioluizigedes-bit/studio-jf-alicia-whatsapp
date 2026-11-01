import fs from 'fs';
import path from 'path';
import { SALON_CONFIG } from '../config/salonConfig';
import { inferAppointmentDurationMinutes, formatDurationLabel } from './appointmentService';

export interface ServiceItem {
  id: string;
  name: string;
  category: string;
  price: number;
  durationMinutes: number;
  description: string;
  originalPrice?: number;
  isPromotional?: boolean;
  promotionalNote?: string;
  badge?: string;
}

export interface PublicBookingServiceItem {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  price: number;
  priceDisplay: string;
  originalPrice?: number;
  originalPriceDisplay?: string;
  isPromotional?: boolean;
  durationMinutes: number;
  durationLabel: string;
  badge?: string;
  description?: string;
}

function resolveServicesJsonPath(): string {
  const cwdPath = path.resolve(process.cwd(), 'services.json');
  if (fs.existsSync(cwdPath)) return cwdPath;
  const distPath = path.resolve(__dirname, '../../services.json');
  if (fs.existsSync(distPath)) return distPath;
  return cwdPath;
}

export function normalizeText(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export class ServiceCatalogService {
  private filePath: string;

  constructor() {
    this.filePath = resolveServicesJsonPath();
  }

  private readRawData(): any {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('Erro ao ler services.json:', e);
    }
    return { services: SALON_CONFIG.services || [] };
  }

  private writeRawData(data: any): boolean {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('Erro ao gravar services.json:', e);
      return false;
    }
  }

  public getAllServices(): ServiceItem[] {
    const data = this.readRawData();
    if (Array.isArray(data.services) && data.services.length > 0) {
      SALON_CONFIG.services = data.services as any;
      return data.services as ServiceItem[];
    }
    return (SALON_CONFIG.services || []) as any;
  }

  public findService(query: string): ServiceItem | undefined {
    const services = this.getAllServices();
    return this.findServiceInList(services, query);
  }

  public updateServicePrice(
    query: string,
    newPrice: number,
    isPromo: boolean = false,
    promoNote?: string
  ): { success: boolean; service?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];
    const targetService = this.findServiceInList(services, query);

    if (!targetService) {
      return {
        success: false,
        message: `Não encontrei nenhum procedimento com o termo "${query}". Verifique o nome e tente novamente.`,
      };
    }

    const previousPrice = targetService.price;

    if (isPromo) {
      if (!targetService.originalPrice || targetService.originalPrice <= 0) {
        targetService.originalPrice = previousPrice;
      }
      targetService.price = Number(newPrice);
      targetService.isPromotional = true;
      targetService.badge = '🔥 Promoção';
      targetService.promotionalNote = promoNote || 'Preço promocional especial Studio JF';
    } else {
      targetService.price = Number(newPrice);
      delete targetService.originalPrice;
      delete targetService.isPromotional;
      delete targetService.promotionalNote;
      if (targetService.badge === '🔥 Promoção') {
        delete targetService.badge;
      }
    }

    this.writeRawData(rawData);
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      service: targetService,
    };
  }

  /**
   * Atualização completa de qualquer procedimento pelo Dashboard (nome, valor, tempo de execução, categoria, promoção, descrição)
   */
  public updateServiceFull(
    idOrQuery: string,
    updates: {
      name?: string;
      price?: number;
      durationMinutes?: number;
      category?: string;
      description?: string;
      isPromotional?: boolean;
      originalPrice?: number;
      badge?: string;
    }
  ): { success: boolean; service?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];
    const targetService = this.findServiceInList(services, idOrQuery);

    if (!targetService) {
      return {
        success: false,
        message: `Procedimento "${idOrQuery}" não encontrado no catálogo.`,
      };
    }

    if (typeof updates.name === 'string' && updates.name.trim()) {
      targetService.name = updates.name.trim();
    }

    if (typeof updates.category === 'string' && updates.category.trim()) {
      targetService.category = updates.category.trim();
    }

    if (updates.durationMinutes !== undefined && !isNaN(Number(updates.durationMinutes)) && Number(updates.durationMinutes) > 0) {
      targetService.durationMinutes = Math.round(Number(updates.durationMinutes));
    }

    if (typeof updates.description === 'string') {
      targetService.description = updates.description.trim();
    }

    const previousPrice = targetService.price;
    if (updates.price !== undefined && !isNaN(Number(updates.price)) && Number(updates.price) >= 0) {
      targetService.price = Number(updates.price);
    }

    if (updates.isPromotional === true) {
      const orig =
        updates.originalPrice !== undefined && Number(updates.originalPrice) > 0
          ? Number(updates.originalPrice)
          : targetService.originalPrice && targetService.originalPrice > targetService.price
          ? targetService.originalPrice
          : previousPrice > targetService.price
          ? previousPrice
          : Number((targetService.price * 1.2).toFixed(2));

      targetService.originalPrice = orig;
      targetService.isPromotional = true;
      targetService.badge = updates.badge?.trim() || '🔥 Promoção';
    } else if (updates.isPromotional === false) {
      delete targetService.originalPrice;
      delete targetService.isPromotional;
      delete targetService.promotionalNote;
      if (updates.badge !== undefined) {
        if (updates.badge.trim()) {
          targetService.badge = updates.badge.trim();
        } else {
          delete targetService.badge;
        }
      } else if (targetService.badge === '🔥 Promoção') {
        delete targetService.badge;
      }
    } else if (updates.badge !== undefined) {
      if (updates.badge.trim()) {
        targetService.badge = updates.badge.trim();
      } else {
        delete targetService.badge;
      }
    }

    this.writeRawData(rawData);
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      service: targetService,
    };
  }

  public deleteService(idOrQuery: string): { success: boolean; deletedService?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];
    const idx = services.findIndex(s => s.id === idOrQuery || normalizeText(s.name) === normalizeText(idOrQuery));

    if (idx === -1) {
      return {
        success: false,
        message: `Procedimento "${idOrQuery}" não encontrado para exclusão.`,
      };
    }

    const [deletedService] = services.splice(idx, 1);
    rawData.services = services;
    this.writeRawData(rawData);
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      deletedService,
    };
  }

  public removePromotion(query: string): { success: boolean; service?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];
    const targetService = this.findServiceInList(services, query);

    if (!targetService) {
      return {
        success: false,
        message: `Não encontrei nenhum procedimento com o termo "${query}".`,
      };
    }

    if (targetService.originalPrice && targetService.originalPrice > 0) {
      targetService.price = targetService.originalPrice;
    }
    delete targetService.originalPrice;
    delete targetService.isPromotional;
    delete targetService.promotionalNote;
    if (targetService.badge === '🔥 Promoção') {
      delete targetService.badge;
    }

    this.writeRawData(rawData);
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      service: targetService,
    };
  }

  public addCustomService(params: {
    name: string;
    price: number;
    durationMinutes?: number;
    category?: string;
    description?: string;
    badge?: string;
    isPromotional?: boolean;
    originalPrice?: number;
  }): { success: boolean; service?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];

    const trimmedName = (params.name || '').trim();
    if (!trimmedName) {
      return {
        success: false,
        message: 'O nome do procedimento é obrigatório.',
      };
    }
    const norm = normalizeText(trimmedName);

    const existing = services.find(s => normalizeText(s.name) === norm);
    if (existing) {
      return {
        success: false,
        message: `Já existe um procedimento cadastrado com o nome "${existing.name}". Você pode atualizar o valor com "alterar valor ${existing.name} para ${params.price}".`,
      };
    }

    const duration = params.durationMinutes && Number(params.durationMinutes) > 0
      ? Math.round(Number(params.durationMinutes))
      : inferAppointmentDurationMinutes(trimmedName);

    let category = params.category ? params.category.trim() : '';
    if (!category) {
      if (/manut/i.test(norm)) {
        category = 'manutencao_cilios';
      } else if (/cilio|lash|volume|fio\s*a\s*fio|tufinho/i.test(norm)) {
        category = 'colocacao_cilios';
      } else if (/sobrancelha|henna|brow/i.test(norm)) {
        category = 'sobrancelhas';
      } else if (/depila|cera|buco|virilha|axila|perna/i.test(norm)) {
        category = 'depilacao_unitaria';
      } else if (/combo/i.test(norm)) {
        category = 'combos_depilacao';
      } else {
        category = 'estetica_facial';
      }
    }

    const baseSlug = norm.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 32);
    const uniqueId = `srv_${baseSlug}_${Date.now().toString().slice(-4)}`;

    const newService: ServiceItem = {
      id: uniqueId,
      name: trimmedName,
      category,
      price: Number(params.price),
      durationMinutes: duration,
      description: params.description || `${trimmedName} realizado com excelência no Studio JF Designer (${formatDurationLabel(duration)}).`,
      badge: params.badge,
    };

    if (params.isPromotional) {
      newService.isPromotional = true;
      newService.originalPrice = params.originalPrice && Number(params.originalPrice) > Number(params.price)
        ? Number(params.originalPrice)
        : Number((Number(params.price) * 1.2).toFixed(2));
      newService.badge = params.badge || '🔥 Promoção';
    }

    services.push(newService);

    this.writeRawData(rawData);
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      service: newService,
    };
  }

  public getActivePromotions(): ServiceItem[] {
    const services = this.getAllServices();
    return services.filter(s => s.isPromotional === true);
  }

  public getPublicBookingServices(): PublicBookingServiceItem[] {
    const services = this.getAllServices();
    const result: PublicBookingServiceItem[] = [];

    for (const s of services) {
      let cat = 'cilios';
      let catLabel = 'Extensão de Cílios';

      if (s.category === 'sobrancelhas' || s.category === 'manutencao_cilios') {
        cat = 'sobrancelhas';
        catLabel = 'Sobrancelhas & Manutenções';
      } else if (s.category.includes('depilacao')) {
        cat = 'depilacao';
        catLabel = 'Depilação a Cera';
      } else if (s.category === 'combos_especiais') {
        cat = 'combos';
        catLabel = 'Combos Especiais';
      } else if (s.category.includes('estetica') || s.category === 'outros') {
        cat = 'outros';
        catLabel = 'Estética & Outros';
      }

      const formattedPrice = `R$ ${Number(s.price).toFixed(2).replace('.', ',')}`;
      let origPriceStr: string | undefined = undefined;
      let badge = s.badge;

      if (s.isPromotional && s.originalPrice && s.originalPrice > s.price) {
        origPriceStr = `R$ ${Number(s.originalPrice).toFixed(2).replace('.', ',')}`;
        badge = '🔥 Promoção';
      }

      result.push({
        id: s.id,
        name: s.name,
        category: cat,
        categoryLabel: catLabel,
        price: Number(s.price),
        priceDisplay: formattedPrice,
        originalPrice: s.originalPrice,
        originalPriceDisplay: origPriceStr,
        isPromotional: !!s.isPromotional,
        durationMinutes: s.durationMinutes || 60,
        durationLabel: formatDurationLabel(s.durationMinutes || 60),
        badge,
        description: s.description,
      });
    }

    return result;
  }

  private findServiceInList(services: ServiceItem[], query: string): ServiceItem | undefined {
    const norm = normalizeText(query);
    if (!norm) return undefined;

    const exactId = services.find(s => s.id.toLowerCase() === norm);
    if (exactId) return exactId;

    const exactName = services.find(s => normalizeText(s.name) === norm);
    if (exactName) return exactName;

    const cleanNorm = norm
      .replace(/^(colocacao|manutencao|aplicacao|extensao|procedimento)\s*(de\s*)?/i, '')
      .trim();

    const nameMatch = services.find(s => {
      const sNorm = normalizeText(s.name);
      return sNorm.includes(cleanNorm) || sNorm.includes(norm);
    });
    if (nameMatch) return nameMatch;

    const keywords = cleanNorm.split(/\s+/).filter(w => w.length > 2);
    if (keywords.length > 0) {
      return services.find(s => {
        const sNorm = normalizeText(s.name);
        return keywords.every(k => sNorm.includes(k));
      });
    }

    return undefined;
  }
}

export const serviceCatalogService = new ServiceCatalogService();
