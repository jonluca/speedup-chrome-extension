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
  manifestVersion: 3,
  targetBrowsers: ["chrome", "edge", "firefox", "safari"],
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => ({
    name: "Speed Up Pages",
    description: "Speed up webpage timers and animation frames.",
    version: "0.2.0",
    icons: extensionIcons,
    action: {
      default_icon: extensionIcons,
    },
    permissions: ["activeTab", "storage"],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "speed-up-pages@jonlu.ca",
              strict_min_version: "140.0",
              data_collection_permissions: { required: ["none"] },
            },
            gecko_android: {
              strict_min_version: "142.0",
            },
          },
        }
      : {}),
  }),
});
