import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceProvider } from "./workspace";
import "./styles.css";
import "./menu-fidelity.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkspaceProvider>
      <App />
    </WorkspaceProvider>
  </React.StrictMode>,
);
