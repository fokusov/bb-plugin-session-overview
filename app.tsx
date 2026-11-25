import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ProjectsPage } from "./projects-page.js";
import { AgentsPanel } from "./agents-panel.js";
import { SessionPanel } from "./session-panel.js";
import "./session-panel.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "projects",
    title: "Проекты и сессия",
    icon: "Layers",
    path: "projects",
    component: ProjectsPage,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "session",
    title: "Сессия",
    icon: "Layers",
    component: SessionPanel,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "agents",
    title: "Агенты",
    icon: "Network",
    component: AgentsPanel,
  });
});
