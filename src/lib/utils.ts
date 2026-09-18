import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists, resolving conflicting utilities last-wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
