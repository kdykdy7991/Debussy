import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/index.css";
import "./demo-theme.css";
import "./demo.css";
import { DemoApp } from "./demo-app";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<DemoApp />
	</StrictMode>
);
