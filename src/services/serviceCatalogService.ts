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
    if (Array.isArray(SALON_CONFIG.services) && SALON_CONFIG.services.length > 0) {
      return SALON_CONFIG.services as any;
    }
    const data = this.readRawData();
    return (data.services || []) as ServiceItem[];
  }

  public findService(query: string): ServiceItem | undefined {
    const services = this.getAllServices();
    const norm = normalizeText(query);
    if (!norm) return undefined;

    // 1. Match exato por id
    const exactId = services.find(s => s.id.toLowerCase() === norm);
    if (exactId) return exactId;

    // 2. Match exato por nome normalizado
    const exactName = services.find(s => normalizeText(s.name) === norm);
    if (exactName) return exactName;

    // 3. Match com remoção de prefixos comuns como "colocacao", "manutencao", "cilios", etc.
    const cleanNorm = norm
      .replace(/^(colocacao|manutencao|aplicacao|extensao|procedimento)\s*(de\s*)?/i, '')
      .trim();

    // Prioriza busca pelo nome limpo
    const nameMatch = services.find(s => {
      const sNorm = normalizeText(s.name);
      return sNorm.includes(cleanNorm) || sNorm.includes(norm);
    });
    if (nameMatch) return nameMatch;

    // 4. Match por palavras-chave relevantes
    const keywords = cleanNorm.split(/\s+/).filter(w => w.length > 2);
    if (keywords.length > 0) {
      const keywordMatch = services.find(s => {
        const sNorm = normalizeText(s.name);
        return keywords.every(k => sNorm.includes(k));
      });
      if (keywordMatch) return keywordMatch;
    }

    return undefined;
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

    // Grava no disco
    this.writeRawData(rawData);

    // Sincroniza em memória no SALON_CONFIG
    SALON_CONFIG.services = services as any;

    return {
      success: true,
      service: targetService,
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
  }): { success: boolean; service?: ServiceItem; message?: string } {
    const rawData = this.readRawData();
    const services = (rawData.services || []) as ServiceItem[];

    const trimmedName = params.name.trim();
    const norm = normalizeText(trimmedName);

    // Evita duplicatas
    const existing = services.find(s => normalizeText(s.name) === norm);
    if (existing) {
      return {
        success: false,
        message: `Já existe um procedimento cadastrado com o nome "${existing.name}". Você pode atualizar o valor com "alterar valor ${existing.name} para ${params.price}".`,
      };
    }

    const duration = params.durationMinutes && params.durationMinutes > 0
      ? params.durationMinutes
      : inferAppointmentDurationMinutes(trimmedName);

    let category = params.category ? params.category.trim() : '';
    if (!category) {
      if (/cilio|lash|volume|fio\s*a\s*fio|tufinho/i.test(norm)) {
        category = 'colocacao_cilios';
      } else if (/sobrancelha|henna|brow/i.test(norm)) {
        category = 'sobrancelhas';
      } else if (/depila|cera|buco|virilha|axila|perna/i.test(norm)) {
        category = 'depilacao_cera_avulso';
      } else if (/combo/i.test(norm)) {
        category = 'combos_especiais';
      } else {
        category = 'estetica_geral';
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
      } else if (s.category === 'estetica_geral' || s.category === 'outros') {
        cat = 'outros';
        catLabel = 'Outros Procedimentos';
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
