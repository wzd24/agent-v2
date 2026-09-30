import React from "react";

function readAppTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Follows the app `html[data-theme]` attribute (absent means dark). */
export function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = React.useState<"light" | "dark">(readAppTheme);
  React.useEffect(() => {
    const sync = () => setTheme(readAppTheme());
    sync();
    const watcher = new MutationObserver(sync);
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watcher.disconnect();
  }, []);
  return theme;
}
