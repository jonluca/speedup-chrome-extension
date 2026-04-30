import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

const extensionIcons = {
  16: "icons/16.png",
  24: "icons/24.png",
  32: "icons/32.png",
  48: "icons/48.png",
  96: "icons/96.png",
  128: "icons/128.png",
};

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "Speed Up Pages",
    description: "Speed up webpage timers and animation frames.",
    icons: extensionIcons,
    action: {
      default_icon: extensionIcons,
    },
    permissions: ["activeTab", "storage"],
    web_accessible_resources: [
      {
        resources: ["speed-page.js"],
        matches: ["<all_urls>"],
      },
    ],
  },
});
