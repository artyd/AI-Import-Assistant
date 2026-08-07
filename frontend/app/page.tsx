"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { IconSpinner } from "@/components/icons";

export default function IndexPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/workspaces" : "/login");
  }, [user, loading, router]);

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        color: "var(--muted)",
      }}
    >
      <IconSpinner size={26} />
    </div>
  );
}
