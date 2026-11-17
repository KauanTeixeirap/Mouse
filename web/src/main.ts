import "./styles.css";
import { startApp } from "./app";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // ignore SW registration failure in unsupported contexts
    });
  });
}

const root = document.getElementById("app");
if (root) {
  startApp(root);
}
