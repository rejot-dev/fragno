"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type LevelContextValue = {
  currentLevel: number;
  setCurrentLevel: (level: number) => void;
};

const LevelContext = createContext<LevelContextValue | null>(null);

export function LevelProvider({ children }: { children: ReactNode }) {
  const [currentLevel, setCurrentLevel] = useState(1);

  return (
    <LevelContext.Provider value={{ currentLevel, setCurrentLevel }}>
      {children}
    </LevelContext.Provider>
  );
}

export function useLevelContext() {
  const context = useContext(LevelContext);
  if (!context) {
    throw new Error("useLevelContext must be used within a LevelProvider");
  }
  return context;
}
