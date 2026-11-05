import type { Metadata } from "next";
import "./supply.css";

export const metadata: Metadata = {
  title: "Поставки",
  description: "Реєстр поставок: етапи, планові й фактичні дати, наступна дія.",
};

export default function SupplyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
