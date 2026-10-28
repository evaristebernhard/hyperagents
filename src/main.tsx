import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceProvider } from "./workspace";
import BackendGate from "./BackendGate";
import SharedThreadPage from "./SharedThreadPage";
import "./styles.css";
import "./menu-fidelity.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname.startsWith("/share/") ? <SharedThreadPage /> : (
      <BackendGate>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </BackendGate>
    )}
  </React.StrictMode>,
);
