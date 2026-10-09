import { Fragment } from "react";
import { t } from "../i18n.js";

/**
 * `t` with one argument that is a React node (a coloured name, say): the
 * message decides where it goes, so a language can put it anywhere.
 */
export function tNode(id: string, args: Record<string, unknown>, key: string, node: React.ReactNode): React.ReactElement {
  const [before = "", after = ""] = t(id, { ...args, [key]: "\u0001" }).split("\u0001");
  return (
    <Fragment>
      {before}
      {node}
      {after}
    </Fragment>
  );
}
