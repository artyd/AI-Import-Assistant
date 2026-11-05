import { Suspense } from "react";
import { EntryScreen } from "@/components/entry/EntryScreen";

// The site entry (spec 008): Поставки by default, the corner mark opens the
// Штурман PIN gate. `/?to=shturman` (lock screen, expired session) opens on
// the gate. Signed-in Штурман users get a «Продовжити» there.
export default function IndexPage() {
  return (
    <Suspense>
      <EntryScreen />
    </Suspense>
  );
}
