"use client";

// Карта / Логістичний хаб. Leaflet needs `window`, so the real map
// (components/hub/HubCanvas) is loaded through a dynamic import with ssr:false —
// this wrapper is the only thing the workspace page imports, keeping Leaflet out
// of the server bundle.

import dynamic from "next/dynamic";
import { IconSpinner } from "@/components/icons";

function Loading() {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: "var(--chat)" }}>
      <IconSpinner size={26} />
    </div>
  );
}

const HubCanvas = dynamic(() => import("./hub/HubCanvas").then((m) => m.HubCanvas), {
  ssr: false,
  loading: () => <Loading />,
});

export function MapView({ workspaceId }: { workspaceId?: string }) {
  return <HubCanvas workspaceId={workspaceId} />;
}
