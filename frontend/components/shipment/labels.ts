"use client";
import type { PartyRole, WorkspaceStatus, Risk, ChecklistItem } from "@/lib/types";

// Three fixed party slots, in the deal's own terms:
//   Хто (виробник) → Через кого (посередник, напр. Prime UK) → Кому (одержувач).
// "Через кого" exists only in a trilateral deal.
export const PARTY_SLOTS: { role: PartyRole; label: string; hint: string; optional?: boolean }[] = [
  { role: "sender", label: "Хто (виробник)", hint: "Виробник / первинний постачальник" },
  { role: "intermediary", label: "Через кого", hint: "Посередник / трейдер (напр. Prime UK)", optional: true },
  { role: "recipient", label: "Кому", hint: "Кінцевий одержувач / імпортер" },
];

export const STATUS_OPTIONS: { value: WorkspaceStatus; label: string }[] = [
  { value: "draft", label: "Чернетка" },
  { value: "active", label: "Активна" },
  { value: "docs_in_progress", label: "Документи в роботі" },
  { value: "docs_complete", label: "Документи повні" },
  { value: "customs_ready", label: "Готово до митниці" },
  { value: "done", label: "Готово" },
];

export const RISK_CLS: Record<Risk["severity"], string> = {
  error: "var(--err)",
  warning: "var(--warn)",
  info: "var(--muted)",
};

export const CHECK_LABEL: Record<ChecklistItem["status"], string> = {
  verified: "підтверджено",
  received: "отримано",
  missing: "бракує",
};
export const CHECK_CLS: Record<ChecklistItem["status"], string> = {
  verified: "var(--ok)",
  received: "var(--warn)",
  missing: "var(--err)",
};

export const CONTRACT_TYPE_LABEL: Record<"bilateral" | "trilateral", string> = {
  bilateral: "двосторонній",
  trilateral: "тристоронній",
};

// Bucket any legacy/free-text role label into one of the three fixed slots
// (mirrors the backend canonicalRole). Unrecognised → recipient as a safe default.
export const ROLE_SYNONYMS: Record<PartyRole, string[]> = {
  sender: ["sender", "від кого", "постачальник", "поставщик", "продавець", "продавец", "supplier", "seller", "shipper", "вантажовідправник", "експортер", "exporter"],
  intermediary: ["intermediary", "через кого", "посередник", "посредник", "агент", "agent", "trader", "брокер"],
  recipient: ["recipient", "кому", "покупець", "покупатель", "buyer", "вантажоодержувач", "consignee", "отримувач", "імпортер", "importer", "our_company", "наша компанія"],
};

// Friendly labels for common checklist requirement keys (fallback: the raw key).
export const REQ_LABEL: Record<string, string> = {
  contract: "Контракт",
  invoice: "Інвойс",
  proforma: "Проформа-інвойс",
  packing_list: "Пакувальний лист",
  cmr: "CMR / транспортна",
  certificate_of_origin: "Сертифікат походження",
  quality_certificate: "Сертифікат якості",
  customs_declaration: "Митна декларація",
  payment: "Платіжні документи",
  specification: "Специфікація",
  transport: "Транспортні документи",
  intermediary_agreement: "Договір з посередником",
};

// Reconciliation field keys → what the user reads (mirrors backend fieldLabel).
export const FIELD_LABEL: Record<string, string> = {
  net_weight_kg: "Вага нетто",
  gross_weight_kg: "Вага брутто",
  total_weight_kg: "Загальна вага",
  packages_count: "Кількість місць",
  line_items: "Кількість позицій",
  line_quantity: "Кількість товару",
  line_amount: "Сума по позиції",
  line_hs_code: "Код УКТ ЗЕД по позиції",
  hs_code: "Код УКТ ЗЕД",
  incoterm: "Умови поставки (Incoterms)",
  currency: "Валюта",
  total_value: "Сума",
  country_of_origin: "Країна походження",
  manufacturer: "Виробник",
  registration_number: "Реєстраційний номер",
  markup: "Націнка посередника",
  intermediary: "Посередник",
  seller: "Продавець",
  buyer: "Покупець",
  documents: "Документи",
  instruction: "Виконання інструкції постачальнику",
  // Збірник (FCL), spec 006.
  container_numbers: "Номер контейнера",
  hbl_sum_gross_weight_kg: "Сума ваги брутто HBL проти MBL",
  hbl_sum_packages_count: "Сума місць HBL проти MBL",
  transit_gross_weight_kg: "Вага брутто T1 проти MBL",
  lot_gross_weight_kg: "Вага брутто партії (PL проти HBL)",
  manifest_qty: "Кількість у маніфесті",
  manifest_price: "Ціна в маніфесті",
  manifest_line: "Позиція маніфесту без інвойсу",
  manifest_extra: "Товар поза маніфестом",
};
