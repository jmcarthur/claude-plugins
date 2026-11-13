export type RunwaySnapshot = { [key: string]: unknown };

declare module "claude-code" {
  interface PluginState {
    runway: { session: RunwaySnapshot };
  }
}
