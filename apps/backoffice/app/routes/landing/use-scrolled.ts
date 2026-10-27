import { useEffect, useState } from "react";

/** Whether the page has scrolled away from its top. */
export function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    function updateScrolled() {
      setScrolled(window.scrollY > 0);
    }
    updateScrolled();
    window.addEventListener("scroll", updateScrolled, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateScrolled);
    };
  }, []);
  return scrolled;
}
