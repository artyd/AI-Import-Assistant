"use client";

// Hugeicons for Поставки: what a shipment is (category) and how it travels
// (transport), readable from the list without opening the card.

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Airplane01Icon,
  CargoShipIcon,
  ContainerTruck01Icon,
  DeliveryBox01Icon,
  DeliveryTruck01Icon,
  Folder01Icon,
  Globe02Icon,
  Location01Icon,
  StarIcon,
  Tag01Icon,
  TestTube01Icon,
  TrainIcon,
} from "@hugeicons/core-free-icons";
import type { CategoryIconKey } from "@/lib/supply/logic";
import type { SupplyMode } from "@/lib/supply/types";

type Icon = typeof StarIcon;

const CATEGORY: Record<CategoryIconKey, Icon> = {
  globe: Globe02Icon,
  ukraine: Location01Icon,
  sample: TestTube01Icon,
  box: DeliveryBox01Icon,
  truck: ContainerTruck01Icon,
  plane: Airplane01Icon,
  ship: CargoShipIcon,
  train: TrainIcon,
  flask: TestTube01Icon,
  tag: Tag01Icon,
};

const MODE: Record<Exclude<SupplyMode, "">, Icon> = {
  sea: CargoShipIcon,
  air: Airplane01Icon,
  rail: TrainIcon,
  road: ContainerTruck01Icon,
  courier: DeliveryTruck01Icon,
};

export const CATEGORY_ICON_LABEL: Record<CategoryIconKey, string> = {
  globe: "Світ",
  ukraine: "Україна",
  sample: "Зразок",
  box: "Коробка",
  truck: "Вантажівка",
  plane: "Літак",
  ship: "Судно",
  train: "Потяг",
  flask: "Колба",
  tag: "Мітка",
};

export function CategoryIcon({ icon, size = 18 }: { icon: CategoryIconKey; size?: number }) {
  return <HugeiconsIcon icon={CATEGORY[icon]} size={size} strokeWidth={1.8} aria-hidden="true" />;
}

export function ModeIcon({ mode, size = 15 }: { mode: Exclude<SupplyMode, "">; size?: number }) {
  return <HugeiconsIcon icon={MODE[mode]} size={size} strokeWidth={1.8} aria-hidden="true" />;
}

/** A star: outlined, or filled when `on`. */
export function StarMark({ on, size = 17 }: { on: boolean; size?: number }) {
  return <HugeiconsIcon icon={StarIcon} size={size} strokeWidth={1.8} className={on ? "star-on" : undefined} aria-hidden="true" />;
}

export function GroupIcon({ size = 14 }: { size?: number }) {
  return <HugeiconsIcon icon={Folder01Icon} size={size} strokeWidth={1.8} aria-hidden="true" />;
}
