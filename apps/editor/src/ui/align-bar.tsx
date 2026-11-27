/**
 * Align and distribute, for a selection of more than one node (EB2).
 *
 * Three buttons an axis for "line these up" (the lowest value, the middle
 * of the spread, the highest) and one for "space these evenly". The
 * arithmetic is in `scene-align.ts`; this is only the controls, and it
 * shows nothing at all until there is a set to act on, so a single
 * selection keeps the Details pane it always had.
 */

import * as React from "react";
import type { AlignMode, Axis } from "../scene-align.js";
import { AXIS_NAME } from "../scene-align.js";
import { Button, SectionTitle } from "./components.js";

export interface AlignBarProps {
  /** How many nodes are selected: fewer than two draws nothing. */
  count: number;
  onAlign(axis: Axis, mode: AlignMode): void;
  onDistribute(axis: Axis): void;
}

const AXES: Axis[] = [0, 1, 2];
const MODES: Array<[AlignMode, string, string]> = [
  ["min", "Min", "to the lowest"],
  ["centre", "Mid", "to the middle of the spread"],
  ["max", "Max", "to the highest"],
];

export function AlignBar(props: AlignBarProps): React.JSX.Element | null {
  if (props.count < 2) return null;
  return (
    <div className="mb-2 flex flex-col gap-1" data-testid="align-bar">
      <SectionTitle>Align</SectionTitle>
      {AXES.map((axis) => (
        <div key={axis} className="flex items-center gap-1">
          <span className="w-4 text-xs uppercase" style={{ color: "var(--m3-on-surface-variant)" }}>
            {AXIS_NAME[axis]}
          </span>
          {MODES.map(([mode, label, why]) => (
            <Button
              key={mode}
              size="sm"
              variant="outline"
              title={`Align ${AXIS_NAME[axis]} ${why}`}
              data-testid={`align-${AXIS_NAME[axis]}-${mode}`}
              onClick={() => props.onAlign(axis, mode)}
            >
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={props.count < 3}
            title={
              props.count < 3
                ? "Three or more nodes to space evenly"
                : `Space them evenly along ${AXIS_NAME[axis]}, keeping the outermost two`
            }
            data-testid={`distribute-${AXIS_NAME[axis]}`}
            onClick={() => props.onDistribute(axis)}
          >
            Space
          </Button>
        </div>
      ))}
    </div>
  );
}
