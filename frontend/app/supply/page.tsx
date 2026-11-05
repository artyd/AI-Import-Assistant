import { SupplyApp } from "@/components/supply/SupplyApp";

// Поставки (spec 008): a separate app on the same site. Open to read; editing
// needs the Штурман PIN. Nothing here links into Штурман.
export default function SupplyPage() {
  return <SupplyApp />;
}
