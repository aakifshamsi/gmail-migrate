"use client";
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light") { document.documentElement.classList.add("light"); setLight(true); }
  }, []);

  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    localStorage.setItem("theme", next ? "light" : "dark");
  };

  return (
    <button onClick={toggle} title="Toggle theme"
      className="px-2.5 py-1.5 rounded-lg border border-gray-700 bg-gray-900 hover:bg-gray-800 text-sm text-gray-400 hover:text-gray-200 transition-colors">
      {light ? "🌙 Dark" : "☀️ Light"}
    </button>
  );
}
