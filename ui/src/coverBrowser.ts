import React from "react";
import { api } from "./api";

export function coverBrowser(covered: boolean) {
  void api.browser.setCovered(covered).catch(() => undefined);
}

export function useCoverBrowser(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    coverBrowser(true);
    return () => coverBrowser(false);
  }, [active]);
}
