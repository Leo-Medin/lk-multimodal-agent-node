export type TenantKB = {
  tenantId: string;
  version: string;
  general: GeneralInfo;
  hours: HoursEntry[];
  services: Service[];
  brandGroups: BrandGroup[]; // groups of brands for price applicability
  prices: PriceEntry[];
  faq: FaqEntry[];
};

export type GeneralInfo = {
  companyName: string;
  address: string;
  phone: string[];
  email: string;
  website?: string;
  locationUrl?: string;
  description?: string;
};

export type HoursEntry = {
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  open: string | null; // "HH:MM" or null = closed
  close: string | null;
  note?: string;
};

export type Service = {
  id: string;
  name: string;
  category: string;
  description?: string;
  active: boolean;
};

export type BrandGroup = {
  id: string;
  name: string;
  description?: string;
  brands?: string[];
};

export type PriceApplicability = {
  brandGroupId?: string;
};

export type PriceEntry = {
  serviceId: string;
  label?: string;
  price: number;
  currency: string;
  unit?: string;
  notes?: string;
  appliesTo?: PriceApplicability;
};

export type FaqEntry = {
  id: string;
  question: string;
  answer: string;
  language: 'en' | 'el' | 'ru';
  tags?: string[];
};
