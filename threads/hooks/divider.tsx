import type { ClientModule } from "claude-code";

// The row between the docked pane's list of threads and the thread's view below it. Dragged, it
// posts the rows the list would take with the divider under the pointer: the pointer's row in this
// region, counted from the list's rows as drawn with it.
type Props = { listRows: number; columns: number; label: string };

const Divider: ClientModule<Props> = (p, surface) => {
  const { Text } = surface.elements;
  surface.onPointer((e) => {
    if (e.button !== "left" || (e.type !== "move" && e.type !== "up")) return;
    surface.post({ listRows: p.listRows + e.y });
  });
  const width = Math.max(4, surface.columns || p.columns);
  // A double rule in the text's own color, the label in it.
  const text = `══${p.label}`.padEnd(width, "═").slice(0, width);
  return <Text>{text}</Text>;
};

export default Divider;
