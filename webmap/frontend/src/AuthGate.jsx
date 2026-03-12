import { useEffect, useState } from "react";
import { checkAuth, redirectToLogin } from "./authCheck";

/**
 * Wraps the application and ensures the user is authenticated
 * before rendering children. Redirects to login on failure.
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState("checking"); // "checking" | "ok" | "redirecting"

  useEffect(() => {
    let cancelled = false;

    checkAuth().then((user) => {
      if (cancelled) return;
      if (user) {
        setState("ok");
      } else {
        setState("redirecting");
        redirectToLogin();
      }
    });

    return () => { cancelled = true; };
  }, []);

  if (state === "ok") return children;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        color: "#555",
        fontSize: "0.95rem",
      }}
    >
      {state === "checking" ? "Checking authentication\u2026" : "Redirecting to login\u2026"}
    </div>
  );
}
