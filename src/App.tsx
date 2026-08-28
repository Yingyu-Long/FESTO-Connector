import "@festo-ui/icon-font/icons.css";
import "./App.css";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import dashboardIcon from "./assets/dashboards-icon.png";
import Dashboard from "./app/Dashboard/dashboard";
import Add from "./app/Add/Add";
import Siemens from "./app/Add/Siemens";
import Rockwell from "./app/Add/Rockwell";
import Opcua from "./app/Add/Opcua";
import Beckhoff from "./app/Add/Beckhoff";
import Mqtt from "./app/Add/Mqtt";

export default function App() {
  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = dashboardIcon;
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/status" element={<Dashboard />} />
        <Route path="/import" element={<Dashboard />} />
        <Route path="/downloads" element={<Dashboard />} />
        <Route path="/add" element={<Add />} />
        <Route path="/add/siemens" element={<Siemens />} />
        <Route path="/add/rockwell" element={<Rockwell />} />
        <Route path="/add/opcua" element={<Opcua />} />
        <Route path="/add/beckhoff" element={<Beckhoff />} />
        <Route path="/mqtt" element={<Mqtt />} />
        <Route path="/siemens" element={<Siemens />} />
        <Route path="/rockwell" element={<Rockwell />} />
        <Route path="/opcua" element={<Opcua />} />
        <Route path="/beckhoff" element={<Beckhoff />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
