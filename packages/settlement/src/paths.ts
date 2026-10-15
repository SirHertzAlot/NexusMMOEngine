import { resolve } from "node:path";

/** A path the user typed: relative to where they ran npm (INIT_CWD), not the package folder npm runs the script in. */
export const fromUser = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);
