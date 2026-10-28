// LayoutProvider – React context wrapper for layoutStore (EA1)
import * as React from "react";
import { layoutStore, setLayout } from "./layout-store.js";

const LayoutContext = React.createContext<{ layout: any; setLayout: (l:any)=>void } | null>(null);

export const LayoutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const layout = React.useSyncExternalStore(layoutStore.subscribe, layoutStore.get);
  return (
    <LayoutContext.Provider value={{ layout, setLayout }}>
      {children}
    </LayoutContext.Provider>
  );
};

export const useLayout = () => {
  const ctx = React.useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within LayoutProvider");
  return ctx;
};
