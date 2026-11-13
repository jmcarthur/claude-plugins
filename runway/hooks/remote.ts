import { MINUTE } from "./limits";

const RESTORE_WINDOW = 10 * MINUTE;

export type RemoteControlWatch = {
  account: number;
  isOn: boolean;
  restoreUntil?: number;
};

// A switch drops Remote Control, but the session may show it as on until the
// connection fails. Running the command while it shows on would offer to
// disconnect instead, so the restore waits until it shows off.
export function watchRemoteControl(
  prev: RemoteControlWatch | undefined,
  account: number,
  isOn: boolean,
  now: number,
): { watch: RemoteControlWatch; action?: "restore" | "give-up" } {
  const restoreUntil =
    prev && prev.account !== account && prev.isOn
      ? now + RESTORE_WINDOW
      : prev?.restoreUntil;
  if (restoreUntil === undefined) return { watch: { account, isOn } };
  if (!isOn) return { watch: { account, isOn: true }, action: "restore" };
  if (now > restoreUntil)
    return { watch: { account, isOn }, action: "give-up" };
  return { watch: { account, isOn, restoreUntil } };
}
